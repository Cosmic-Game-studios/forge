// The agent loop: model turn -> tool calls -> results -> next turn.
//
// Invariants this file protects (they are what keeps model quality and cache
// hit rate high on current Claude models):
//  - The history is append-only. Nothing already sent is edited or removed.
//  - Assistant content is appended verbatim (thinking and compaction blocks included).
//  - All results of one tool round go back in a single user message.
//  - The system prompt and the tool set never change within a session.

import { cheapModel, COMPACT_SYSTEM, compactPrompt, renderTranscript, stripThinking, SUMMARY_MARK, tailStart } from "./compact.ts";
import { getKey, saveConfig, type Config, type Effort, type PermissionMode } from "./config.ts";
import { loadMcpConfig, McpManager, serverFingerprint, type McpServerConfig } from "./mcp.ts";
import { formatModelRef, modelInfo, parseModelRef, type ModelRef } from "./models.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { loadNotes } from "./notes.ts";
import { getProvider } from "./providers/index.ts";
import { changeStats, type FileChange, parseVerdict, renderChanges, REVIEW_MIN_LINES, REVIEW_SYSTEM, reviewFeedback, reviewPrompt } from "./review.ts";
import {
  addUsage,
  ProviderError,
  ZERO_USAGE,
  type ContentBlock,
  type Message,
  type ToolCall,
  type ToolResultBlock,
  type ToolSpec,
  type Usage,
} from "./providers/types.ts";
import { newSessionId, saveSession, type SessionData } from "./session.ts";
import { contextBlock, KIND_LABEL, listFiles, locateMentions, parseTriage, projectSnapshot, TRIAGE_SYSTEM, type Triage } from "./situate.ts";
import { loadSkills, type Skill } from "./skills.ts";
import { detectChecks } from "./tools/check.ts";
import { buildTools, validateInput, type Tool, type ToolContext, type ToolOutput } from "./tools/index.ts";
import { commandPrefix, isReadOnlyCommand } from "./tools/shell.ts";
import { displayPath, resolvePath } from "./tools/types.ts";
import fs from "node:fs";

export interface PermissionRequest {
  tool: string;
  title: string;
  detail: string[];
  /** What "always" would allow, e.g. "npm test commands". */
  alwaysLabel: string;
}

export type PermissionAnswer = { allow: true; always?: boolean } | { allow: false; feedback?: string };

export interface Stats {
  total: Usage;
  /** Estimated cost in USD, when the model's price is known. */
  cost: number | null;
  /** Tokens in the context window as of the last model turn. */
  contextTokens: number;
  contextLimit: number;
}

/** What one request did, for the summary shown when it ends. */
export interface RunSummary {
  files: FileChange[];
  checks: "passed" | "failed" | null;
  review: string | null;
  cost: number | null;
  requests: number;
  ms: number;
}

export interface AgentUI {
  onText(delta: string): void;
  onThinking(delta: string): void;
  /** The model's output for one request is complete. */
  onAssistantEnd(): void;
  onToolPending(name: string): void;
  onToolProgress(chars: number): void;
  onToolStart(call: ToolCall, summary: string, depth: number): void;
  onToolLive(callId: string, text: string): void;
  onToolEnd(call: ToolCall, output: ToolOutput, ms: number, depth: number): void;
  onServerTool(name: string, detail: string): void;
  onNotice(msg: string, level?: "info" | "warn" | "error"): void;
  onStats(stats: Stats): void;
  askPermission(req: PermissionRequest): Promise<PermissionAnswer>;
}

interface LoopState {
  model: ModelRef;
  system: string;
  messages: Message[];
  tools: Map<string, Tool>;
  ctx: ToolContext;
  depth: number;
  effort: Effort;
}

const BASELINE = process.env.FORGE_BASELINE === "1";
const MAX_CONTINUATIONS = 3;
const MAX_RETRIES = 2;
/** The watcher looks once this many lines have changed since its last look. */
const WATCH_MIN_LINES = 15;
const WATCH_SYSTEM = `You watch a coding agent while it works. You are shown the task and the agent's most recent edits - a part of unfinished work, not the whole. The agent sees your reply attached to its next step.

Reply with exactly OK unless you are confident that the shown code has a concrete defect:
- a bug: name the input or situation in which it gives a wrong result or crashes
- something the task explicitly asks for that this code contradicts
- code that cannot run as written (wrong name, wrong argument order, unbalanced structure)
- a security problem: outside input reaching the file system, a shell, eval, or the host's objects unchecked

Do not report: style, naming, missing tests or features (the work is still in progress), anything about code you cannot see, or anything you are not sure of. A wrong alarm costs the agent time, so when in doubt reply OK.

If there is a defect, list at most three, one line each:
path:line - what is wrong - the case in which it fails`;
const MAX_AUTO_CHECKS = 2;
/** Shell commands that verify the work: after one passes, the automatic check is not needed. */
const VERIFY_COMMAND = /\b(test|tests|pytest|jest|vitest|mocha|tsc|typecheck|lint|eslint|build|cargo\s+(test|check|build|clippy)|go\s+(test|build|vet)|node\s+--test)\b/;
const NO_HANDLERS = { onText() {}, onThinking() {}, onToolPending() {}, onToolProgress() {}, onServerTool() {}, onNotice() {}, onCompaction() {} };
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class Agent {
  cfg: Config;
  ui: AgentUI;
  model: ModelRef;
  effort: Effort;
  permissionMode: PermissionMode;
  session: SessionData;
  stats: Stats;
  /** Messages the user typed while the agent was working; delivered at the next tool boundary. */
  steering: string[] = [];
  busy = false;

  private tools = buildTools({ subagent: false });
  private ctx: ToolContext;
  private allowRules = new Set<string>();
  private permissionQueue: Promise<unknown> = Promise.resolve();
  private abort: AbortController | null = null;
  private budgetWarned = false;
  /** Files were changed since the last successful verification. */
  private dirty = false;
  /** Identical tool calls with identical results, to notice a model going in circles. */
  private repeats = new Map<string, { result: string; count: number }>();
  /** Content of every file this request changed, as it was before (null = did not exist). */
  private before = new Map<string, string | null>();
  /** The watcher: file contents at its last look, the look in flight, and findings not yet delivered. */
  private watchBase = new Map<string, string | null>();
  private watchRun: Promise<void> | null = null;
  private watchFindings: string | null = null;
  private request = "";
  private checkOutcome: RunSummary["checks"] = null;
  private reviewOutcome: string | null = null;
  /** Summary of the request that finished last. */
  lastRun: RunSummary | null = null;
  /** One entry per request that changed files: what they contained before it. Newest last. */
  private checkpoints: { label: string; files: Map<string, string | null> }[] = [];
  /** Something the model must be told with the next request (for example, that the user undid its changes). */
  private pendingNote = "";
  /** Forge's read of the current request (kind, size); steers effort and review. */
  private triage: Triage | null = null;
  skills: Skill[];
  mcp = new McpManager();

  constructor(opts: { cfg: Config; cwd: string; ui: AgentUI; model: ModelRef; resume?: SessionData | null }) {
    this.cfg = opts.cfg;
    this.ui = opts.ui;
    this.model = opts.model;
    this.effort = opts.cfg.effort;
    this.permissionMode = opts.cfg.permissionMode;
    this.skills = BASELINE ? [] : loadSkills(opts.cwd);
    const now = new Date().toISOString();
    this.session = opts.resume ?? {
      id: newSessionId(),
      cwd: opts.cwd,
      model: formatModelRef(opts.model),
      system: buildSystemPrompt(opts.cwd, { skills: this.skills, notes: BASELINE ? "" : loadNotes(opts.cwd) }),
      messages: [],
      created: now,
      updated: now,
      title: "",
    };
    this.ctx = this.makeContext(opts.cwd, new AbortController().signal);
    this.stats = { total: { ...ZERO_USAGE }, cost: 0, contextTokens: 0, contextLimit: modelInfo(this.model).context };
  }

  get cwd(): string {
    return this.ctx.cwd;
  }
  get todos() {
    return this.ctx.todos;
  }
  get messages(): Message[] {
    return this.session.messages;
  }

  setModel(ref: ModelRef) {
    this.model = ref;
    this.session.model = formatModelRef(ref);
    this.stats.contextLimit = modelInfo(ref).context;
  }

  /**
   * Connect the configured MCP servers and add their tools. Call once, before
   * the first request: the tool set must not change within a session.
   * `approve` is asked about servers a project defines; without it they stay off.
   */
  async init(approve?: (s: McpServerConfig) => Promise<boolean>): Promise<void> {
    const servers = loadMcpConfig(this.cwd);
    if (!servers.length) return;
    const trusted = new Set(this.cfg.trustedMcp ?? []);
    const tools = await this.mcp.start(this.cwd, servers, async (s) => {
      const fp = serverFingerprint(this.cwd, s);
      if (trusted.has(fp)) return true;
      if (!approve || !(await approve(s))) return false;
      this.cfg.trustedMcp = [...trusted.add(fp)];
      saveConfig(this.cfg);
      return true;
    });
    for (const t of tools) this.tools.set(t.spec.name, t);
    for (const s of this.mcp.status) {
      if (s.state === "failed") this.ui.onNotice(`MCP server "${s.name}" did not start: ${s.detail}`, "warn");
      else if (s.state === "not approved") this.ui.onNotice(`MCP server "${s.name}" from this project's .mcp.json is not approved and was not started.`, "warn");
    }
  }

  close() {
    this.mcp.close();
  }

  /** Start a fresh conversation in the same project. */
  reset() {
    const now = new Date().toISOString();
    this.session = {
      id: newSessionId(),
      cwd: this.ctx.cwd,
      model: formatModelRef(this.model),
      system: buildSystemPrompt(this.ctx.cwd, { skills: this.skills, notes: BASELINE ? "" : loadNotes(this.ctx.cwd) }),
      messages: [],
      created: now,
      updated: now,
      title: "",
    };
    this.ctx.todos.length = 0;
    this.ctx.fileState.clear();
    this.ctx.readSeen.clear();
    this.budgetWarned = false;
    this.dirty = false;
    this.repeats.clear();
    this.checkpoints = [];
    this.pendingNote = "";
    this.ctx.changed?.clear();
    this.ctx.diag = { known: null, off: false };
    this.stats = { total: { ...ZERO_USAGE }, cost: 0, contextTokens: 0, contextLimit: modelInfo(this.model).context };
  }

  interrupt() {
    this.abort?.abort();
  }

  private makeContext(cwd: string, signal: AbortSignal): ToolContext {
    return {
      cwd,
      signal,
      fileState: new Map(),
      readSeen: new Map(),
      changed: new Set(),
      diag: { known: null, off: false },
      todos: [],
      runSubagent: async () => "",
      progress: () => {},
    };
  }

  /** Stop before a model request once the session's spending limit is reached. */
  private checkBudget() {
    const budget = this.cfg.budget;
    if (!budget || this.stats.cost === null) return;
    if (this.stats.cost >= budget) {
      throw new Error(
        `Session budget of $${budget.toFixed(2)} reached (spent about $${this.stats.cost.toFixed(2)}). Raise it with /budget <amount>, or remove it with /budget off, then continue.`,
      );
    }
    if (!this.budgetWarned && this.stats.cost >= budget * 0.8) {
      this.budgetWarned = true;
      this.ui.onNotice(`About 80% of the session budget is used ($${this.stats.cost.toFixed(2)} of $${budget.toFixed(2)}).`, "warn");
    }
  }

  private toolSpecs(tools: Map<string, Tool>): ToolSpec[] {
    return [...tools.values()].map((t) => t.spec);
  }

  /** Run one user request to completion. */
  async run(input: string): Promise<void> {
    if (this.busy) throw new Error("Agent is already running");
    this.busy = true;
    this.abort = new AbortController();
    this.ctx.signal = this.abort.signal;
    if (!this.session.title) this.session.title = input.replace(/\s+/g, " ").slice(0, 80);
    const context = [this.pendingNote, await this.prepare(input).catch(() => "")].filter(Boolean).join("\n\n");
    this.pendingNote = "";
    this.session.messages.push({ role: "user", content: context ? `${input}\n\n${context}` : input });
    this.repeats.clear();
    this.before.clear();
    this.watchBase.clear();
    this.watchFindings = null;
    this.request = input;
    this.checkOutcome = null;
    this.reviewOutcome = null;
    const startedAt = Date.now();
    const costBefore = this.stats.cost;
    const requestsBefore = this.requests;
    const signal = this.abort.signal;
    const state: LoopState = { model: this.model, system: this.session.system, messages: this.session.messages, tools: this.tools, ctx: this.ctx, depth: 0, effort: this.effort };
    // A question needs an answer, not the deepest thinking the session allows.
    if (this.triage?.kind === "question" && ["high", "xhigh", "max"].includes(state.effort)) state.effort = "medium";
    try {
      await this.loop(state);
      // The watcher may still be reading the last edits; what it found is settled before "done".
      if (this.watchRun) {
        const waited = new AbortController();
        await Promise.race([this.watchRun, sleep(15_000, AbortSignal.any([signal, waited.signal]))]);
        waited.abort(); // clears the timer, which would otherwise hold the process open
      }
      if (this.watchFindings && !signal.aborted) {
        this.session.messages.push({ role: "user", content: this.takeWatchNote() });
        await this.loop(state);
      }
      await this.verify(state);
      // "Done" is the author's opinion. A reviewer with a fresh context gets one round of say.
      const findings = signal.aborted ? null : await this.review(state, input);
      if (findings && !signal.aborted) {
        this.session.messages.push({ role: "user", content: reviewFeedback(findings) });
        await this.loop(state);
        await this.verify(state);
      }
      if (!signal.aborted) await this.maybeAutoCompact();
    } finally {
      this.busy = false;
      this.abort = null;
      this.lastRun = {
        files: changeStats(this.before, this.ctx.cwd),
        checks: this.checkOutcome,
        review: this.reviewOutcome,
        cost: this.stats.cost !== null && costBefore !== null ? this.stats.cost - costBefore : null,
        requests: this.requests - requestsBefore,
        ms: Date.now() - startedAt,
      };
      if (this.before.size) {
        this.checkpoints.push({ label: input.replace(/\s+/g, " ").slice(0, 60), files: new Map(this.before) });
        if (this.checkpoints.length > 30) this.checkpoints.shift();
      }
      this.persist();
    }
  }

  /** How many requests can be undone. */
  get undoable(): number {
    return this.checkpoints.length;
  }

  /**
   * Put every file the last file-changing request touched back to what it was
   * before that request. Covers changes made with the file tools, not what
   * shell commands did. The model is told with the next request.
   */
  undo(): { label: string; files: string[] } | null {
    const point = this.checkpoints.pop();
    if (!point) return null;
    const restored: string[] = [];
    for (const [file, old] of point.files) {
      try {
        if (old === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, old);
        restored.push(displayPath(this.ctx, file));
      } catch (err) {
        this.ui.onNotice(`Could not restore ${file}: ${(err as Error).message}`, "warn");
      }
      this.ctx.fileState.delete(file);
      for (const key of this.ctx.readSeen.keys()) if (key.startsWith(file + "|")) this.ctx.readSeen.delete(key);
    }
    this.dirty = false;
    this.pendingNote = `[Forge: the user undid the file changes of the request "${point.label}". These files are back to what they contained before it: ${restored.join(", ")}. Read them again before relying on what you remember of them.]`;
    return { label: point.label, files: restored };
  }

  private takeWatchNote(): string {
    const findings = this.watchFindings ?? "";
    this.watchFindings = null;
    this.ui.onNotice("The watcher flagged something in the recent edits; passing it to the model.");
    return `[Forge watcher - an automatic quick read of your recent edits by a smaller model, not a message from the user. It can be wrong: check each point against the code, fix what is real, and ignore the rest without comment.]\n${findings}`;
  }

  /**
   * After a burst of edits, let the cheapest model read them while the work
   * goes on. It never blocks the main model; what it finds is attached to the
   * next tool results.
   */
  private maybeWatch(st: LoopState) {
    if (BASELINE || this.cfg.watch === false || this.watchRun || !this.watchBase.size) return;
    const cheap = cheapModel(this.cfg, this.model);
    const price = modelInfo(cheap).price;
    if (!price || price.in > 1) return;
    const changes = renderChanges(this.watchBase, st.ctx.cwd);
    if (changes.lines < WATCH_MIN_LINES) return;
    this.watchBase.clear();
    const signal = st.ctx.signal;
    this.watchRun = getProvider(this.cfg, cheap.provider)
      .runTurn(
        {
          model: cheap.id,
          system: WATCH_SYSTEM,
          messages: [{ role: "user", content: `## The task the agent is working on\n\n${this.request.slice(0, 4000)}\n\n## Its latest edits ("-" removed, "+" added with line numbers)\n\n${changes.text.slice(0, 30_000)}` }],
          tools: [],
          effort: "low",
          maxTokens: 700,
          webTools: false,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        },
        NO_HANDLERS,
      )
      .then((result) => {
        this.track(cheap, result.usage, false);
        const text = result.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
        if (text && !/^OK\b/i.test(text) && !signal.aborted) this.watchFindings = text.slice(0, 2500);
      })
      .catch(() => {}) // the watcher is a bonus; its failures are nobody's problem
      .finally(() => (this.watchRun = null));
  }

  /**
   * Gather what the model would otherwise spend turns finding out, and read
   * what kind of task this is (see situate.ts). The user's words stay as they are.
   */
  private async prepare(input: string): Promise<string> {
    this.triage = null;
    if (BASELINE || this.cfg.prepare === false) return "";
    const signal = this.abort!.signal;
    const first = this.session.messages.length === 0;
    const files = await listFiles(this.cwd, signal);
    const [triage] = await Promise.all([this.readTask(input, signal)]);
    if (signal.aborted) return "";
    this.triage = triage;
    const mentions = locateMentions(input, this.cwd, files);
    if (triage && triage.kind !== "other") {
      this.ui.onNotice(`Read as: ${KIND_LABEL[triage.kind]}, ${triage.size}${mentions.length ? ` · located ${mentions.length} thing${mentions.length === 1 ? "" : "s"} you mentioned` : ""}`);
    }
    return contextBlock({ snapshot: first ? projectSnapshot(this.cwd, files) : undefined, mentions, triage });
  }

  /** Ask the cheapest model what kind of task this is. Skipped when no cheap model is connected. */
  private async readTask(input: string, signal: AbortSignal): Promise<Triage | null> {
    const cheap = cheapModel(this.cfg, this.model);
    const price = modelInfo(cheap).price;
    if (!price || price.in > 1) return null; // not worth a request on an expensive model
    const last = this.session.messages.at(-1);
    const before = last?.role === "assistant" && Array.isArray(last.content) ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("").slice(-600) : "";
    try {
      const result = await getProvider(this.cfg, cheap.provider).runTurn(
        {
          model: cheap.id,
          system: TRIAGE_SYSTEM,
          messages: [{ role: "user", content: `${before ? `The agent's previous reply ended with:\n${before}\n\n` : ""}The user's request:\n${input.slice(0, 3000)}` }],
          tools: [],
          effort: "low",
          maxTokens: 400,
          webTools: false,
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        },
        NO_HANDLERS,
      );
      this.track(cheap, result.usage, false);
      return parseTriage(result.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
    } catch {
      return null; // triage is a convenience; the request goes ahead without it
    }
  }

  /**
   * The harness verifies the work itself: a passing check costs no model
   * tokens, a failing one goes back to the model before the user sees "done".
   */
  private async verify(st: LoopState) {
    for (let round = 0; round < MAX_AUTO_CHECKS && this.dirty && !st.ctx.signal.aborted; round++) {
      const failures = await this.autoCheck(st);
      if (failures === null) break;
      st.messages.push({
        role: "user",
        content: `[Automatic check by Forge - not a message from the user]\nThe project's checks fail after your changes:\n\n${failures}\n\nFix what your changes broke and stop when the checks pass. If a failure existed before your changes or is unrelated to them, leave it and say so.`,
      });
      await this.loop(st);
    }
  }

  /** Let an independent reviewer read this request's changes. Returns its findings, or null. */
  private async review(st: LoopState, request: string): Promise<string | null> {
    if (BASELINE || this.cfg.review === false || !this.before.size) return null;
    const changes = renderChanges(this.before, st.ctx.cwd);
    // A small task gets a review only when the change turned out larger than the task sounded.
    if (this.triage?.kind === "question" || changes.lines < (this.triage?.size === "small" ? 40 : REVIEW_MIN_LINES)) return null;
    const call: ToolCall = { id: `review_${Date.now()}`, name: "review", input: {} };
    this.ui.onToolStart(call, `independent review of ${changes.files} changed file${changes.files === 1 ? "" : "s"}`, 0);
    const started = Date.now();
    // Read-only tools, plus the shell for running code and tests (it asks like any other command).
    const tools = new Map([...buildTools({ subagent: true })].filter(([name, t]) => t.kind === "read" || name === "bash"));
    let findings: string | null = null;
    let out: ToolOutput;
    try {
      const report = await this.loop({
        model: st.model,
        system: `${REVIEW_SYSTEM}\n\nPlatform: ${process.platform}. Date: ${new Date().toISOString().slice(0, 10)}.`,
        messages: [{ role: "user", content: reviewPrompt(request, changes, st.ctx.cwd) }],
        tools,
        ctx: this.makeContext(st.ctx.cwd, st.ctx.signal),
        depth: 1,
        effort: st.effort === "low" ? "medium" : st.effort,
      });
      findings = parseVerdict(report);
      const count = (findings ?? "").split("\n").filter((l) => /^\d+\./.test(l.trim())).length;
      this.reviewOutcome = findings ? `${count || "some"} finding${count === 1 ? "" : "s"}, handed back to the model` : "no findings";
      const titles = (findings ?? "").split("\n").filter((l) => /^\d+\./.test(l.trim()));
      out = { content: findings ?? "pass", display: findings ? titles.slice(0, 6).map((l) => l.trim().slice(0, 110)) : ["no findings"] };
    } catch (err) {
      // A failed review must never cost the user their finished work.
      out = { content: `review skipped: ${(err as Error).message}`, isError: true };
    }
    this.ui.onToolEnd(call, out, Date.now() - started, 0);
    return st.ctx.signal.aborted ? null : findings;
  }

  private persist() {
    this.session.updated = new Date().toISOString();
    try {
      saveSession(this.session);
    } catch (err) {
      this.ui.onNotice(`Could not save the session: ${(err as Error).message}`, "warn");
    }
  }

  /** Model requests made in this process (all models, sub-agents included). */
  requests = 0;

  private track(model: ModelRef, usage: Usage, main: boolean) {
    this.requests++;
    this.stats.total = addUsage(this.stats.total, usage);
    const price = modelInfo(model).price;
    if (!price) this.stats.cost = null;
    else if (this.stats.cost !== null) {
      this.stats.cost +=
        (usage.input * price.in + usage.output * price.out + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.in * 1.25) / 1e6;
    }
    if (main) this.stats.contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    this.ui.onStats(this.stats);
  }

  private async loop(st: LoopState): Promise<string> {
    const signal = st.ctx.signal;
    const provider = getProvider(this.cfg, st.model.provider);
    const info = modelInfo(st.model);
    const main = st.depth === 0;
    let continuations = 0;
    let finalText = "";

    for (;;) {
      if (signal.aborted) return finalText;
      this.checkBudget();
      let result;
      let attempt = 0;
      for (;;) try {
        result = await provider.runTurn(
          {
            model: st.model.id,
            system: st.system,
            messages: st.messages,
            tools: this.toolSpecs(st.tools),
            effort: st.effort,
            maxTokens: info.adaptive ? 64_000 : 32_000,
            webTools: this.cfg.webTools,
            signal,
          },
          {
            onText: (d) => main && this.ui.onText(d),
            onThinking: (d) => main && this.ui.onThinking(d),
            onToolPending: (n) => main && this.ui.onToolPending(n),
            onToolProgress: (n) => main && this.ui.onToolProgress(n),
            onServerTool: (n, d) => this.ui.onServerTool(n, d),
            onNotice: (m) => this.ui.onNotice(m, "warn"),
            // Earlier reads are gone from the model's view: allow them to be sent again.
            onCompaction: () => st.ctx.readSeen.clear(),
          },
        );
        break;
      } catch (err) {
        if (main) this.ui.onAssistantEnd();
        if (signal.aborted) return finalText; // partial output is discarded; history stays valid
        // Overload and network errors pass; the history is unchanged, so the same request can go again.
        if (!(err instanceof ProviderError && err.retryable) || attempt >= MAX_RETRIES) throw err;
        const wait = 3000 * 3 ** attempt++;
        this.ui.onNotice(`${err.message} - trying again in ${wait / 1000}s (${attempt}/${MAX_RETRIES}).`, "warn");
        await sleep(wait, signal);
        if (signal.aborted) return finalText;
      }
      if (main) this.ui.onAssistantEnd();
      this.track(st.model, result.usage, main);

      if (result.stop === "refusal") {
        this.ui.onNotice(
          `The model declined this request${result.stopDetail ? ` (${result.stopDetail})` : ""}. Nothing was added to the conversation; rephrase or pick another model with /model.`,
          "warn",
        );
        // Drop the unanswered prompt so the next request starts clean (a trailing removal, not an edit).
        const last = st.messages[st.messages.length - 1];
        if (last?.role === "user" && typeof last.content === "string") st.messages.pop();
        return finalText;
      }

      if (result.content.length > 0) st.messages.push({ role: "assistant", content: result.content });
      const text = result.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) finalText = text;

      if (result.stop === "pause_turn") continue; // server-side tool loop paused; re-send to resume

      if (result.toolCalls.length === 0) {
        if (result.stop === "max_tokens" && continuations++ < MAX_CONTINUATIONS && result.content.length > 0) {
          st.messages.push({ role: "user", content: "Your reply hit the output limit. Continue exactly where you stopped." });
          continue;
        }
        if (result.stop === "other" && result.stopDetail) this.ui.onNotice(`The model stopped: ${result.stopDetail}`, "warn");
        return finalText;
      }

      // A tool input cut off by the output limit can still parse as a valid
      // partial object, so never execute tools from a max_tokens turn.
      const truncated = result.stop === "max_tokens";
      const results = truncated
        ? result.toolCalls.map<ToolResultBlock>((call) => ({
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content:
              "This tool call was cut off by the output limit before its input was complete, so it was not run. Retry with a smaller input: write large files in several steps, or use edit for partial changes.",
          }))
        : await this.runTools(st, result.toolCalls);

      const content: ContentBlock[] = [...results];
      if (main) {
        if (this.watchFindings) content.push({ type: "text", text: this.takeWatchNote() });
        this.maybeWatch(st);
      }
      if (main && this.steering.length) {
        for (const msg of this.steering.splice(0)) {
          content.push({ type: "text", text: `[The user sent this message while you were working]\n${msg}` });
        }
      }
      st.messages.push({ role: "user", content });
      if (main) {
        this.persist();
        await this.maybeAutoCompact(true);
      }
    }
  }

  /** Run the project's checks after a turn that changed files. Returns the failures, or null when there is nothing to fix. */
  private async autoCheck(st: LoopState): Promise<string | null> {
    const tool = st.tools.get("check");
    if (this.cfg.autoCheck === false || !tool || !detectChecks(st.ctx.cwd).length) return null;
    const call: ToolCall = { id: `auto_check_${Date.now()}`, name: "check", input: {} };
    const summary = "automatic check after changes";
    if ((await this.checkPermission(st, tool, call, summary)) !== null) return null;
    this.ui.onToolStart(call, summary, 0);
    const started = Date.now();
    const ctx: ToolContext = Object.create(st.ctx, { progress: { value: (t: string) => this.ui.onToolLive(call.id, t) } });
    let out: ToolOutput;
    try {
      out = await tool.run(call.input, ctx);
    } catch (err) {
      out = { content: (err as Error).message, isError: true };
    }
    this.ui.onToolEnd(call, out, Date.now() - started, 0);
    if (st.ctx.signal.aborted) return null;
    if (!out.isError) this.dirty = false;
    this.checkOutcome = out.isError ? "failed" : "passed";
    return out.isError ? String(out.content) : null;
  }

  /** Execute one round of tool calls. Read-only calls run in parallel; the rest run in order. */
  private async runTools(st: LoopState, calls: ToolCall[]): Promise<ToolResultBlock[]> {
    const results = new Map<string, ToolResultBlock>();
    const interrupted = (call: ToolCall): ToolResultBlock => ({
      type: "tool_result",
      tool_use_id: call.id,
      is_error: true,
      content: "Interrupted by the user before this tool ran.",
    });

    let i = 0;
    while (i < calls.length) {
      if (st.ctx.signal.aborted) {
        results.set(calls[i].id, interrupted(calls[i]));
        i++;
        continue;
      }
      const isParallel = (c: ToolCall) => st.tools.get(c.name)?.kind === "read";
      if (isParallel(calls[i])) {
        const batch: ToolCall[] = [];
        while (i < calls.length && isParallel(calls[i])) batch.push(calls[i++]);
        const outs = await Promise.all(batch.map((c) => this.runOne(st, c)));
        batch.forEach((c, k) => results.set(c.id, outs[k]));
      } else {
        results.set(calls[i].id, await this.runOne(st, calls[i]));
        i++;
      }
    }
    return calls.map((c) => results.get(c.id)!);
  }

  private async runOne(st: LoopState, call: ToolCall): Promise<ToolResultBlock> {
    const fail = (msg: string): ToolResultBlock => ({ type: "tool_result", tool_use_id: call.id, is_error: true, content: msg });
    const tool = st.tools.get(call.name);
    if (!tool) return fail(`Unknown tool \`${call.name}\`. Available tools: ${[...st.tools.keys()].join(", ")}.`);
    if (call.invalidJson !== undefined) return fail(JSON.stringify({ INVALID_JSON: call.invalidJson.slice(0, 2000) }));
    const invalid = tool.external ? null : validateInput(tool, call.input);
    if (invalid) return fail(`Invalid input for \`${call.name}\`: ${invalid}`);

    let summary: string;
    try {
      summary = tool.summarize(call.input, st.ctx);
    } catch {
      summary = "";
    }

    const denied = await this.checkPermission(st, tool, call, summary);
    if (denied !== null) {
      this.ui.onToolStart(call, summary, st.depth);
      const out: ToolOutput = { content: denied, isError: true, display: ["declined"] };
      this.ui.onToolEnd(call, out, 0, st.depth);
      return fail(denied);
    }

    if (tool.kind === "edit") {
      const edits: Record<string, unknown>[] = Array.isArray(call.input.edits) ? call.input.edits : [];
      for (const p of [call.input.path, ...edits.map((e) => e?.path)]) {
        if (typeof p !== "string" || !p) continue;
        const file = resolvePath(st.ctx, p);
        if (this.before.has(file) && this.watchBase.has(file)) continue;
        let old: string | null = null;
        try {
          old = fs.readFileSync(file, "utf8");
        } catch {
          /* a new file */
        }
        if (!this.before.has(file)) this.before.set(file, old);
        if (!this.watchBase.has(file)) this.watchBase.set(file, old);
      }
    }
    this.ui.onToolStart(call, summary, st.depth);
    const started = Date.now();
    // Each call gets its own view of the context so progress lines and
    // sub-agents are attributed to the right call.
    const ctx: ToolContext = Object.create(st.ctx, {
      progress: { value: (t: string) => this.ui.onToolLive(call.id, t) },
      runSubagent: { value: (prompt: string, desc: string) => this.runSubagent(st, call, prompt, desc) },
    });
    let out: ToolOutput;
    try {
      out = await tool.run(call.input, ctx);
      if (ctx.cwd !== st.ctx.cwd && Object.hasOwn(ctx, "cwd")) st.ctx.cwd = ctx.cwd;
    } catch (err) {
      out = { content: `Tool \`${call.name}\` failed: ${(err as Error).message}`, isError: true };
    }
    this.ui.onToolEnd(call, out, Date.now() - started, st.depth);
    if (!out.isError) {
      if (tool.kind === "edit") this.dirty = true;
      else if (call.name === "check" || (call.name === "bash" && VERIFY_COMMAND.test(String(call.input.command ?? "")))) {
        this.dirty = false;
        if (st.depth === 0) this.checkOutcome = "passed";
      }
    } else if (call.name === "check" && st.depth === 0) this.checkOutcome = "failed";
    let content =
      typeof out.content === "string" ? out.content || "(no output)" : (out.content as ToolResultBlock["content"]);
    if (typeof content === "string" && st.depth === 0) {
      const key = call.name + JSON.stringify(call.input);
      const seen = this.repeats.get(key);
      const count = seen && seen.result === content ? seen.count + 1 : 1;
      this.repeats.set(key, { result: content, count });
      if (count >= 3) content += `\n\n[Forge: you have made this exact \`${call.name}\` call ${count} times and got the same result each time. Repeating it will not change anything - try a different approach, or tell the user what is blocking you.]`;
    }
    return { type: "tool_result", tool_use_id: call.id, content, ...(out.isError ? { is_error: true } : {}) };
  }

  /** Returns null when allowed, or the message to hand back to the model when declined. */
  private async checkPermission(st: LoopState, tool: Tool, call: ToolCall, summary: string): Promise<string | null> {
    if (tool.kind === "read" || tool.kind === "meta") return null;
    if (this.permissionMode === "yolo") return null;

    let rule: string;
    let alwaysLabel: string;
    const detail: string[] = [];
    if (tool.kind === "edit") {
      if (this.permissionMode === "auto-edit") return null;
      rule = "edit:*";
      alwaysLabel = "all file edits in this session";
      const p = displayPath(st.ctx, String(call.input.path ?? ""));
      const showEdit = (e: Record<string, unknown>, max: number) => {
        for (const l of String(e.old_string ?? "").split("\n").slice(0, max)) detail.push("- " + l);
        for (const l of String(e.new_string ?? "").split("\n").slice(0, max)) detail.push("+ " + l);
      };
      if (call.name === "edit") showEdit(call.input, 8);
      else if (call.name === "multi_edit") {
        const edits: Record<string, unknown>[] = Array.isArray(call.input.edits) ? call.input.edits : [];
        for (const e of edits.slice(0, 6)) {
          detail.push(`# ${displayPath(st.ctx, String(e.path ?? ""))}`);
          showEdit(e, 4);
        }
        if (edits.length > 6) detail.push(`  … ${edits.length - 6} more edits`);
      } else {
        const lines = String(call.input.content ?? "").replace(/\n$/, "").split("\n");
        for (const l of lines.slice(0, 10)) detail.push("+ " + l);
        if (lines.length > 10) detail.push(`  … ${lines.length - 10} more lines`);
      }
      if (call.name !== "multi_edit") summary = p;
    } else if (call.name === "check") {
      rule = "check:*";
      alwaysLabel = "the project's checks in this session";
      if (this.allowRules.has(rule)) return null;
      for (const ch of detectChecks(st.ctx.cwd)) detail.push(ch.command);
    } else if (call.name === "screenshot" || call.name === "scene3d") {
      rule = "screenshot:*";
      alwaysLabel = "screenshots in this session";
      if (this.allowRules.has(rule)) return null;
      detail.push(`Open in a headless browser: ${call.input.target}`);
    } else if (tool.external) {
      rule = `mcp:${call.name}`;
      alwaysLabel = `\`${call.name.replace(/^mcp__/, "").replace("__", " › ")}\` in this session`;
      if (this.allowRules.has(rule)) return null;
      detail.push(...JSON.stringify(call.input, null, 2).split("\n").slice(0, 14));
    } else {
      const command = String(call.input.command ?? "");
      if (isReadOnlyCommand(command)) return null;
      const prefix = commandPrefix(command);
      rule = `bash:${prefix}`;
      alwaysLabel = `\`${prefix}\` commands in this session`;
      const chained = /[;&|`\n]|\$\(/.test(command);
      // A remembered prefix only covers simple commands; chained ones are always shown.
      if (!chained && this.allowRules.has(rule)) return null;
      for (const l of command.split("\n").slice(0, 12)) detail.push(l);
      if (call.input.description) detail.push(`# ${call.input.description}`);
    }
    if (tool.kind === "edit" && this.allowRules.has(rule)) return null;

    // One prompt at a time, even when several calls (or sub-agents) ask at once.
    const ask = this.permissionQueue.then(() =>
      st.ctx.signal.aborted
        ? ({ allow: false } as PermissionAnswer)
        : this.ui.askPermission({ tool: call.name, title: summary, detail, alwaysLabel }),
    );
    this.permissionQueue = ask.catch(() => {});
    const answer = await ask;
    if (answer.allow) {
      if (answer.always) this.allowRules.add(rule);
      return null;
    }
    return answer.feedback
      ? `The user declined this tool call and said: ${answer.feedback}`
      : "The user declined this tool call. Do not retry it unchanged; adjust your approach, or ask the user what they want instead.";
  }

  /**
   * Which model runs sub-agents. Unless the user chose one, Anthropic sessions
   * use the cheapest current model: sub-agent work is mostly reading and
   * searching, and it is a large share of a session's cost.
   */
  subagentModel(main: ModelRef = this.model): ModelRef {
    const choice = this.cfg.subagentModel;
    if (choice === "same") return main;
    const chosen = choice ? parseModelRef(choice) : null;
    if (chosen && getKey(this.cfg, chosen.provider)) return chosen;
    if (main.provider === "anthropic") return { provider: "anthropic", id: "claude-haiku-5-5" };
    return main;
  }

  private async runSubagent(parent: LoopState, call: ToolCall, prompt: string, description: string): Promise<string> {
    const model = this.subagentModel(parent.model);
    const ctx = this.makeContext(parent.ctx.cwd, parent.ctx.signal);
    const messages: Message[] = [{ role: "user", content: prompt }];
    this.ui.onToolLive(call.id, `${description}: starting`);
    const report = await this.loop({
      model,
      system: buildSystemPrompt(parent.ctx.cwd, { subagent: true }),
      messages,
      tools: buildTools({ subagent: true }),
      ctx,
      depth: parent.depth + 1,
      // Sub-agents search and read; they do not need the main agent's thinking depth.
      effort: this.effort === "low" ? "low" : "medium",
    });
    return report;
  }

  /**
   * Graded compaction (see compact.ts): the older part of the conversation is
   * replaced by a summary written by the cheapest connected model; the newest
   * messages stay word for word. Safe between tool rounds, because the kept
   * tail always starts at an assistant message.
   */
  async compact(reason: "manual" | "auto"): Promise<boolean> {
    const all = this.session.messages;
    const start = tailStart(all, reason === "manual" ? 8_000 : 24_000);
    const old = all.slice(0, start);
    if (old.length < 2) {
      if (reason === "manual") this.ui.onNotice("The conversation is still short; there is nothing to compact.");
      return false;
    }
    const tail = stripThinking(all.slice(start));
    const midTask = all[all.length - 1]?.role === "user";
    const ownAbort = this.abort ? null : (this.abort = new AbortController());
    const signal = this.abort!.signal;
    const cheap = cheapModel(this.cfg, this.model);
    const summarize = async (model: ModelRef) => {
      const transcript = renderTranscript(old, Math.min(600_000, modelInfo(model).context * 2));
      const result = await getProvider(this.cfg, model.provider).runTurn(
        {
          model: model.id,
          system: COMPACT_SYSTEM,
          messages: [{ role: "user", content: compactPrompt(transcript, { tailKept: tail.length > 0, midTask }) }],
          tools: [],
          effort: "low",
          maxTokens: 12_000,
          webTools: false,
          signal,
        },
        NO_HANDLERS,
      );
      this.track(model, result.usage, false);
      return result.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    };
    try {
      let summary = "";
      try {
        summary = await summarize(cheap);
      } catch (err) {
        if (signal.aborted || formatModelRef(cheap) === formatModelRef(this.model)) throw err;
        summary = await summarize(this.model); // the cheap model is not reachable with this key
      }
      if (!summary) {
        this.ui.onNotice("Compaction produced no summary; the conversation is unchanged.", "warn");
        return false;
      }
      const before = this.stats.contextTokens;
      const head: Message = {
        role: "user",
        content: `${SUMMARY_MARK}\nThe earlier part of this session was compressed into the summary below; recent work is recorded more precisely than old work. ${tail.length ? "The messages after it are the latest ones, word for word." : "Continue the task from it."} If you need a detail that is not here, look it up again (read the file, rerun the command) instead of guessing.\n\n${summary}`,
      };
      // In place: the running loop holds a reference to this array.
      all.splice(0, all.length, head, ...tail);
      this.ctx.readSeen.clear(); // earlier reads are gone from the model's view: allow them to be sent again
      this.stats.contextTokens = Math.round((head.content.length + tail.reduce((n, m) => n + JSON.stringify(m.content).length, 0)) / 3.5);
      this.ui.onStats(this.stats);
      const saved = before > this.stats.contextTokens ? ` (about ${Math.round(before / 1000)}k → ${Math.round(this.stats.contextTokens / 1000)}k tokens)` : "";
      this.ui.onNotice(`${reason === "auto" ? "Context was getting large; older" : "Older"} messages were compressed into a summary by ${modelInfo(cheap).name}${saved}.`);
      this.persist();
      return true;
    } catch (err) {
      if (!signal.aborted) this.ui.onNotice(`Compaction failed: ${(err as Error).message}`, "warn");
      return false;
    } finally {
      if (ownAbort) this.abort = null;
    }
  }

  /** Compress once the context passes the configured size - long before the window is full, because every later request pays for it. */
  private async maybeAutoCompact(midTask = false) {
    const limit = Math.min(this.cfg.compactAt ?? 120_000, modelInfo(this.model).context * 0.7);
    // Mid-task the bar is higher, so a compaction rarely interrupts a run that is about to finish.
    if (this.stats.contextTokens > limit * (midTask ? 1.15 : 1)) await this.compact("auto");
  }
}

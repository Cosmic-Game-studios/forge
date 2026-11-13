// Interactive terminal app: wires the agent to the screen and the keyboard.

import os from "node:os";
import { Agent, type AgentUI, type PermissionAnswer, type PermissionRequest, type Stats } from "../agent.ts";
import {
  EFFORTS,
  PERMISSION_MODES,
  PROVIDERS,
  envVarName,
  getKey,
  keySource,
  maskKey,
  saveConfig,
  type Config,
  type Effort,
  type PermissionMode,
  type ProviderId,
} from "../config.ts";
import { ANTHROPIC_MODELS, DEFAULT_MODEL, formatModelRef, modelInfo, parseModelRef, type ModelRef } from "../models.ts";
import { getProvider } from "../providers/index.ts";
import type { ToolCall } from "../providers/types.ts";
import { jobAge, type Job } from "../jobs.ts";
import type { TeamMessage } from "../team.ts";
import { listSessions, loadSession, type SessionData } from "../session.ts";
import type { ToolOutput } from "../tools/index.ts";
import type { TodoItem } from "../tools/types.ts";
import { Editor, KeyDecoder, type Key } from "./input.ts";
import { MarkdownStream } from "./markdown.ts";
import { Screen, type LiveFrame } from "./screen.ts";
import { c, formatDuration, formatTokens, stripAnsi, termWidth, truncate, width, wrap } from "./term.ts";

import { forgeHome } from "../config.ts";
import { loadNotes } from "../notes.ts";
import { STAGE, VERSION } from "../version.ts";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const TOOL_LABEL: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Run",
  glob: "Find",
  grep: "Search",
  todo: "Plan",
  task: "Agent",
  outline: "Outline",
  multi_edit: "Edit",
  check: "Check",
  deps: "Graph",
  review: "Review",
  remember: "Note",
  screenshot: "Screenshot",
  scene3d: "3D scene",
  web_search: "Web search",
  web_fetch: "Fetch",
  advisor: "Advisor",
  message: "Message",
  jobs: "Jobs",
};

/** What the model is doing while a tool call's input is still streaming in. */
const PENDING_LABEL: Record<string, string> = {
  write: "Writing a file",
  edit: "Writing an edit",
  multi_edit: "Writing edits",
  todo: "Writing the plan",
  bash: "Composing a command",
  task: "Briefing a sub-agent",
  remember: "Writing a note",
};

/** The status line while one tool runs. */
const RUNNING_LABEL: Record<string, string> = {
  bash: "Running a command",
  read: "Reading",
  glob: "Finding files",
  grep: "Searching",
  check: "Running the checks",
  task: "A sub-agent is working",
  screenshot: "Taking a screenshot",
  scene3d: "Inspecting the 3D scene",
  web_search: "Searching the web",
  web_fetch: "Fetching a page",
  review: "Reviewing",
  advisor: "Asking the advisor",
};

/** MCP tools are shown as "server › tool". */
function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name.replace(/^mcp__(.+?)__/, "$1 › ");
}

// Ember, the Forge mascot: a small flame with a face.
const MASCOT = [
  c.yellow("    ▄    "),
  c.yellow("   ▟█▙   "),
  c.orange("  ▟███▙  "),
  c.orange(" ▟█████▙ "),
  c.orange(" █") + c.bold(" ● ● ") + c.orange("█ "),
  c.orange(" ▜█▄▄▄█▛ "),
  c.red("  ▀▘ ▝▀  "),
];

const PROVIDER_LABEL: Record<ProviderId, string> = { anthropic: "Anthropic", openrouter: "OpenRouter", openai: "OpenAI" };

const MODE_HELP: Record<PermissionMode, string> = {
  ask: "asks before edits and commands",
  "auto-edit": "edits freely, asks before commands",
  yolo: "never asks",
};

interface SelectItem<T> {
  label: string;
  hint?: string;
  value: T;
}

type Mode =
  | { kind: "input" }
  | { kind: "permission"; req: PermissionRequest; resolve: (a: PermissionAnswer) => void }
  | { kind: "feedback"; resolve: (a: PermissionAnswer) => void }
  | { kind: "select"; title: string; items: SelectItem<unknown>[]; index: number; filter: string; resolve: (v: unknown) => void }
  | { kind: "secret"; title: string; resolve: (v: string | null) => void };

interface ActiveTool {
  name: string;
  summary: string;
  started: number;
  live: string;
}

interface Command {
  name: string;
  args?: string;
  help: string;
  group: "Conversation" | "Model" | "Settings" | "Other";
}

const COMMANDS: Command[] = [
  { name: "/new", help: "start a new conversation", group: "Conversation" },
  { name: "/resume", help: "continue an earlier conversation in this folder", group: "Conversation" },
  { name: "/compact", help: "shrink the conversation into a summary", group: "Conversation" },
  { name: "/history", help: "show earlier requests in full", group: "Conversation" },
  { name: "/undo", help: "take back the file changes of the last request", group: "Conversation" },
  { name: "/init", help: "let Forge study the project and write FORGE.md", group: "Conversation" },
  { name: "/model", args: "[provider:id]", help: "choose the model", group: "Model" },
  { name: "/effort", args: "[low|medium|high|xhigh|max]", help: "how hard the model thinks", group: "Model" },
  { name: "/advisor", args: "[off|provider:id]", help: "a stronger model to ask on hard problems (off · very expensive)", group: "Model" },
  { name: "/pair", args: "[off|provider:id]", help: "two different models work on every request together (off · expensive)", group: "Model" },
  { name: "/subagent", args: "[auto|same|provider:id]", help: "model used for sub-agents", group: "Model" },
  { name: "/budget", args: "[amount|off]", help: "spending limit per session in USD", group: "Settings" },
  { name: "/keys", help: "add or replace API keys", group: "Settings" },
  { name: "/mode", args: "[ask|auto-edit|yolo]", help: "permission mode (shift+tab cycles)", group: "Settings" },
  { name: "/view", args: "[number|all]", help: "how many requests stay on screen", group: "Settings" },
  { name: "/thinking", help: "show full thinking summaries on/off", group: "Settings" },
  { name: "/web", help: "web search and fetch tools on/off", group: "Settings" },
  { name: "/autocheck", help: "run the project's checks after changes on/off", group: "Settings" },
  { name: "/review", help: "independent review of larger changes on/off", group: "Settings" },
  { name: "/watch", help: "a small model reads edits while Forge works on/off", group: "Settings" },
  { name: "/prepare", help: "project snapshot and task triage before each request on/off", group: "Settings" },
  { name: "/jobs", args: "[stop <id>]", help: "background commands and sub-agents", group: "Other" },
  { name: "/notes", help: "what Forge remembers about this project", group: "Other" },
  { name: "/skills", help: "skills Forge can load for special kinds of work", group: "Other" },
  { name: "/mcp", help: "connected MCP servers and their tools", group: "Other" },
  { name: "/status", help: "model, provider, effort, keys, usage at a glance", group: "Other" },
  { name: "/cost", help: "token usage and estimated cost", group: "Other" },
  { name: "/help", help: "commands and keyboard shortcuts", group: "Other" },
  { name: "/exit", help: "quit Forge", group: "Other" },
];

const ALIASES: Record<string, string> = { "/quit": "/exit", "/clear": "/new", "/q": "/exit", "/?": "/help" };

export function pickInitialModel(cfg: Config): ModelRef {
  const saved = cfg.model ? parseModelRef(cfg.model) : null;
  if (saved && getKey(cfg, saved.provider)) return saved;
  for (const p of PROVIDERS) {
    if (getKey(cfg, p) && DEFAULT_MODEL[p]) return { provider: p, id: DEFAULT_MODEL[p] };
  }
  return saved ?? { provider: "anthropic", id: DEFAULT_MODEL.anthropic };
}

/** "~\very\long\path\project" -> "~\…\path\project" when it does not fit. */
function shortPath(p: string, max: number): string {
  const s = p.replace(os.homedir(), "~");
  if (width(s) <= max) return s;
  const sep = s.includes("\\") ? "\\" : "/";
  const parts = s.split(sep);
  let tail = parts[parts.length - 1];
  for (let i = parts.length - 2; i > 0; i--) {
    const next = parts[i] + sep + tail;
    if (width(next) + 4 > max) break;
    tail = next;
  }
  return truncate(`${parts[0] === "~" ? "~" + sep : ""}…${sep}${tail}`, max);
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - width(s)));
}

/** A rounded box with an optional title in the top border. */
function box(lines: string[], w: number, color: (s: string) => string = c.dim, title = ""): string[] {
  const inner = Math.max(4, w - 4);
  const t = title ? `─ ${title} ` : "";
  const top = color("╭") + (title ? color("─ ") + c.bold(title) + " " : "") + color("─".repeat(Math.max(0, w - 2 - width(t))) + "╮");
  const out = [top];
  for (const l of lines) out.push(`${color("│")} ${pad(truncate(l, inner), inner)} ${color("│")}`);
  out.push(color("╰" + "─".repeat(w - 2) + "╯"));
  return out;
}

const HEADING_RE = /^[ \t]*\*\*([^*\n]{2,80})\*\*[ \t]*$/;

/** The short titles a model gives its thinking ("**Planning the edit**"), else its first sentence. */
export function thinkingHeadlines(text: string): string[] {
  const heads = text.split("\n").map((l) => l.match(HEADING_RE)?.[1].trim()).filter((h): h is string => !!h);
  if (heads.length) return heads;
  const first = (text.trim().split(/\n\s*\n/)[0] ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  const sentence = first.match(/^.{8,}?[.!?:](?=\s|$)/)?.[0] ?? first;
  return sentence ? [sentence] : [];
}

/** One request as it appeared on screen, kept so older requests can be redrawn in short form. */
export interface Turn {
  /** The request bar. */
  user: string[];
  /** Everything that was printed, in order. */
  full: string[];
  /** The model's last text block: its answer. */
  answer: string[];
  /** The closing card or footer, and warnings and errors. */
  tail: string[];
  thoughts: number;
  tools: number;
  plan: number;
  /** A slash command rather than a request to the model. */
  cmd: boolean;
}

export function newTurn(cmd = false): Turn {
  return { user: [], full: [], answer: [], tail: [], thoughts: 0, tools: 0, plan: 0, cmd };
}

const ANSWER_LINES = 12;

/** An earlier request in short form: the request, one line of activity, the answer and the closing card. */
/** Without empty lines at the start and end. */
export function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !stripAnsi(lines[a]).trim()) a++;
  while (b > a && !stripAnsi(lines[b - 1]).trim()) b--;
  return lines.slice(a, b);
}

export function compactTurn(t: Turn): string[] {
  if (t.cmd) {
    const full = trimBlank(t.full);
    return full.length <= 14 ? full : [...t.user, c.dim("  ⋯ output hidden · /history shows it")];
  }
  const out = [...t.user];
  const bits: string[] = [];
  if (t.thoughts) bits.push(`thought ${t.thoughts === 1 ? "once" : `${t.thoughts} times`}`);
  if (t.plan) bits.push(`${t.plan}-step plan`);
  if (t.tools) bits.push(`${t.tools} tool call${t.tools === 1 ? "" : "s"}`);
  if (bits.length) out.push(c.dim(`  ⋯ ${bits.join(" · ")}`));
  const answer = trimBlank(t.answer);
  if (answer.length) {
    out.push("", ...answer.slice(0, ANSWER_LINES));
    if (answer.length > ANSWER_LINES) out.push(c.dim(`  ⋯ ${answer.length - ANSWER_LINES} more lines · /history shows them`));
  }
  const tail = trimBlank(t.tail);
  if (tail.length) out.push("", ...tail);
  return out;
}

/** One plan item: done, current or open. */
function planRow(t: TodoItem): string {
  if (t.status === "completed") return `${c.green("✔")} ${c.dim(t.content)}`;
  if (t.status === "in_progress") return `${c.orange("◼")} ${c.bold(t.content)}`;
  return c.dim(`◻ ${t.content}`);
}

class App implements AgentUI {
  private cfg: Config;
  private screen = new Screen();
  private editor = new Editor();
  private decoder = new KeyDecoder();
  private agent: Agent;
  private mode: Mode = { kind: "input" };

  private md: MarkdownStream | null = null;
  private mdStarted = false;
  private thinking = "";
  private thinkingStart = 0;
  private verboseThinking = false;
  private tools = new Map<string, ActiveTool>();
  private pendingTool: { name: string; chars: number; since: number } | null = null;
  private subActivity = "";
  /** The last few things a sub-agent did, and how many tool calls it made. */
  private subTrail: string[] = [];
  private subCount = 0;
  /** Characters the model has streamed this request: text, thinking and tool input. */
  private outChars = 0;
  /** The plan as last shown, to tell a new plan from a step moving on. */
  private lastPlan: TodoItem[] = [];
  private busySince = 0;
  private lastKind = "";
  /** Requests as shown, so older ones can be redrawn in short form. */
  private turns: Turn[] = [];
  private cur: Turn | null = null;
  private turnCount = 0;
  private stats: Stats;
  private ticker: NodeJS.Timeout | null = null;
  private lastCtrlC = 0;
  private menuIndex = 0;
  private done!: () => void;
  private finished = new Promise<void>((r) => (this.done = r));

  constructor(cfg: Config, cwd: string, resume: SessionData | null) {
    this.cfg = cfg;
    const model = (resume && parseModelRef(resume.model)) || pickInitialModel(cfg);
    this.agent = new Agent({ cfg, cwd, ui: this, model, resume });
    this.stats = this.agent.stats;
    this.screen.setFrameSource(() => this.frame());
    // Running background jobs show their age; keep it current between requests too.
    setInterval(() => {
      if (!this.agent.busy && this.agent.jobs.running().some((j) => j.background)) this.screen.schedule();
    }, 1000).unref();
  }

  // ---------- output helpers ----------

  private out(kind: string, ...lines: string[]) {
    if (this.lastKind && (kind !== this.lastKind || kind === "user" || kind === "assistant")) this.emit("sep", [""]);
    this.lastKind = kind;
    this.emit(kind, lines);
  }

  /** Print finished lines and remember them with the current request. */
  private emit(kind: string, lines: string[]) {
    const t = this.cur;
    if (t) {
      t.full.push(...lines);
      if (kind === "user") t.user.push(...lines);
      else if (kind === "assistant") t.answer.push(...lines);
      else if (kind === "card" || kind === "alert") t.tail.push(...lines);
    }
    this.screen.commit(...lines);
  }

  /** A new request: earlier ones shrink, and only the last few stay on screen. */
  private beginTurn(cmd: boolean) {
    this.cur = newTurn(cmd);
    this.turns.push(this.cur);
    this.turnCount++;
    if (this.turns.length > 50) this.turns.shift();
  }

  private tidy() {
    const keep = this.cfg.visibleRequests ?? 5;
    const earlier = this.turns.slice(0, -1);
    if (keep <= 0 || !earlier.length || !this.cur) return;
    const shown = keep > 1 ? earlier.slice(-(keep - 1)) : [];
    const hidden = this.turnCount - 1 - shown.length;
    const lines = [this.headerLine(), ""];
    if (hidden > 0) lines.push(c.dim(`  ⋯ ${hidden} earlier request${hidden === 1 ? "" : "s"} cleared away · /history shows them`), "");
    for (const t of shown) lines.push(...compactTurn(t), "");
    lines.push(...trimBlank(this.cur.full));
    this.screen.reset(lines);
    this.lastKind = "user";
  }

  /** One line in place of the banner once the screen has been tidied. */
  private headerLine(): string {
    const info = modelInfo(this.agent.model);
    const stage = STAGE ? " " + c.yellow(STAGE) : "";
    return truncate(`${c.bold(c.orange("Forge"))} ${c.dim("v" + VERSION)}${stage}${c.dim(" · ")}${info.name}${c.dim(" · " + shortPath(this.agent.cwd, 40))}`, termWidth() - 1);
  }

  private note(msg: string, level: "info" | "warn" | "error" | "success" = "info") {
    const [icon, color] =
      level === "error" ? ["✗", c.red] : level === "warn" ? ["!", c.yellow] : level === "success" ? ["✓", c.green] : ["·", c.dim];
    const lines = msg.split("\n").flatMap((l) => wrap(l, termWidth() - 4, ""));
    this.out(level === "warn" || level === "error" ? "alert" : "notice", ...lines.map((l, i) => (i === 0 ? color(icon) + " " : "  ") + (level === "info" ? c.dim(l) : l)));
  }

  private userLine(text: string, dim = false) {
    // A full-width bar: each request starts a visible new section of the transcript.
    const w = termWidth() - 1;
    const rows = text.split("\n").flatMap((l) => wrap(l, w - 5));
    this.beginTurn(dim);
    this.out(
      "user",
      ...rows.map((r, i) => c.bgGray(pad(` ${i === 0 ? c.orange("❯") : " "} ${dim ? c.dim(r) : c.bold(r)}`, w))),
    );
    this.tidy();
  }

  private endThinking() {
    if (!this.thinking && !this.thinkingStart) return;
    const secs = Math.max(1, Math.round((Date.now() - this.thinkingStart) / 1000));
    const cols = termWidth();
    const heads = thinkingHeadlines(this.thinking);
    let head = `${c.violet("✻")} ${c.dim(`Thought for ${secs}s`)}`;
    // Collapsed, the line still says what the model was thinking about.
    if (heads.length && !this.verboseThinking) head += c.dim(" · " + c.italic(heads.slice(-3).join(" → ")));
    const lines = [truncate(head, cols - 1)];
    if (this.verboseThinking && this.thinking.trim()) {
      for (const l of this.thinking.trim().split("\n")) {
        const heading = l.match(HEADING_RE)?.[1];
        for (const r of wrap(heading ?? l.replace(/\*\*/g, ""), cols - 5)) lines.push(c.violet("  │ ") + (heading ? c.bold(r) : c.dim(r)));
      }
    }
    if (this.cur) this.cur.thoughts++;
    this.out("thinking", ...lines);
    this.thinking = "";
    this.thinkingStart = 0;
  }

  /** The first visible line of an assistant block carries the ◆ marker. */
  private mark(line: string, commit: boolean): string {
    if (this.mdStarted || !stripAnsi(line).trim()) return line;
    if (commit) this.mdStarted = true;
    return c.orange("◆") + line.slice(1);
  }

  // ---------- AgentUI ----------

  onText(delta: string) {
    this.outChars += delta.length;
    if (!this.md) {
      this.endThinking();
      this.md = new MarkdownStream(() => termWidth() - 1, "  ");
      this.mdStarted = false;
      if (this.cur) this.cur.answer = [];
      if (this.lastKind) this.emit("sep", [""]);
      this.lastKind = "assistant-open";
    }
    const lines = this.md.push(delta);
    if (lines.length) this.emit("assistant", lines.map((l) => this.mark(l, true)));
    else this.screen.schedule();
  }

  onThinking(delta: string) {
    if (!this.thinkingStart) this.thinkingStart = Date.now();
    this.thinking += delta;
    this.outChars += delta.length;
    this.screen.schedule();
  }

  onAssistantEnd() {
    this.endThinking();
    if (this.md) {
      const rest = this.md.end();
      if (rest.length) this.emit("assistant", rest.map((l) => this.mark(l, true)));
      this.md = null;
      this.lastKind = "assistant";
    }
    this.pendingTool = null;
    this.screen.schedule();
  }

  onToolPending(name: string) {
    this.pendingTool = { name, chars: 0, since: Date.now() };
    this.screen.schedule();
  }

  onToolProgress(chars: number) {
    if (this.pendingTool) {
      this.outChars += Math.max(0, chars - this.pendingTool.chars);
      this.pendingTool.chars = chars;
    }
    this.screen.schedule();
  }

  onToolStart(call: ToolCall, summary: string, depth: number) {
    if (depth > 0) {
      this.subActivity = `${toolLabel(call.name)} ${stripAnsi(summary)}`;
      this.subCount++;
      this.subTrail.push(this.subActivity);
      if (this.subTrail.length > 3) this.subTrail.shift();
    } else {
      this.tools.set(call.id, { name: call.name, summary, started: Date.now(), live: "" });
    }
    this.screen.schedule();
  }

  onToolLive(callId: string, text: string) {
    const t = this.tools.get(callId);
    if (t) t.live = text;
    this.screen.schedule();
  }

  onToolEnd(call: ToolCall, output: ToolOutput, ms: number, depth: number) {
    if (depth > 0) return; // sub-agent work is summarised by its parent `task` call
    if (this.cur && call.name !== "todo") this.cur.tools++;
    const summary = this.tools.get(call.id)?.summary ?? "";
    this.tools.delete(call.id);
    if (call.name === "todo" && !output.isError) return this.planUpdate();
    let extra = "";
    if (call.name === "task") {
      if (this.subCount) extra = c.dim(` · ${this.subCount} tool call${this.subCount === 1 ? "" : "s"}`);
      this.subActivity = "";
      this.subTrail = [];
      this.subCount = 0;
    }
    const dot = output.isError ? c.red("●") : c.green("●");
    const time = ms >= 1000 ? c.dim(`  ${formatDuration(ms)}`) : "";
    const head = `${dot} ${c.bold(toolLabel(call.name))} ${summary}`.trimEnd() + extra;
    let detail = output.display;
    // For failures, show the message the model received (the shell tool already includes it).
    if (output.isError && !detail && typeof output.content === "string") {
      detail = output.content.split("\n").slice(0, 4).map((l) => c.red(l));
    }
    // A one-line result ("120 lines", "created, 2 lines") stays on the tool's own line.
    if (detail?.length === 1 && !output.isError && width(detail[0]) <= 48 && width(head) + width(detail[0]) + 12 < termWidth()) {
      return this.out("tool", `${head}${c.dim(" · ")}${detail[0]}${time}`);
    }
    const lines = [head + time];
    (detail ?? []).slice(0, 30).forEach((l, i) => lines.push(c.dim(i === 0 ? "  ⎿ " : "    ") + l));
    this.out("tool", ...lines);
  }

  /**
   * A new plan is shown as a checklist; when only its progress changes, the
   * transcript gets the finished steps and a heading for the step that starts.
   */
  private planUpdate() {
    const list = this.agent.todos.map((t) => ({ ...t }));
    const prev = this.lastPlan;
    this.lastPlan = list;
    const n = list.length;
    const cols = termWidth() - 1;
    if (!n) return this.out("plan", `${c.dim("●")} ${c.bold("Plan")} ${c.dim("cleared")}`);
    if (this.cur) this.cur.plan = n;
    const sameItems = prev.length === n && prev.every((p, i) => p.content === list[i].content);
    if (sameItems) {
      const lines: string[] = [];
      list.forEach((t, i) => {
        if (t.status === "completed" && prev[i].status !== "completed") lines.push(`${c.green("✔")} ${c.dim(t.content)}`);
      });
      const cur = list.findIndex((t) => t.status === "in_progress");
      if (cur >= 0 && prev[cur].status !== "in_progress") {
        lines.push(`${c.orange("▸")} ${c.bold(c.orange(`Step ${cur + 1}/${n}`))} ${c.bold(list[cur].content)}`);
      } else if (list.every((t) => t.status === "completed") && !prev.every((t) => t.status === "completed")) {
        lines.push(`${c.green("✔")} ${c.bold(`All ${n} steps done`)}`);
      }
      if (lines.length) this.out("plan", ...lines.map((l) => truncate(l, cols)));
      return;
    }
    const done = list.filter((t) => t.status === "completed").length;
    const lines = [`${c.orange("●")} ${c.bold("Plan")} ${c.dim(`· ${n} step${n === 1 ? "" : "s"}${done ? ` · ${done} done` : ""}`)}`];
    for (const t of list) lines.push(truncate("  " + planRow(t), cols));
    this.out("plan", ...lines);
  }

  onServerTool(name: string, detail: string) {
    if (this.cur) this.cur.tools++;
    this.out("tool", `${c.blue("●")} ${c.bold(toolLabel(name))} ${detail}`);
  }

  onNotice(msg: string, level: "info" | "warn" | "error" = "info") {
    this.note(msg, level);
  }

  onJobs() {
    this.screen.schedule();
  }

  /** Pair mode: a statement in the discussion, with its first lines. */
  onPairTurn(who: string, phase: "proposal" | "critique" | "plan", text: string) {
    const label = phase === "proposal" ? "proposes" : phase === "critique" ? "answers" : "writes the agreed plan";
    const cols = termWidth();
    const lines = text.split("\n").filter((l) => l.trim()).flatMap((l) => wrap(l.replace(/\*\*/g, ""), cols - 6));
    const max = phase === "plan" ? 16 : 5;
    const rows = lines.slice(0, max).map((l) => (phase === "plan" ? "  " + l : c.dim("  " + l)));
    if (lines.length > max) rows.push(c.dim(`  … ${lines.length - max} more lines`));
    this.out("pair", `${c.violet("⇄")} ${c.bold(who)} ${c.dim(label)}`, ...rows);
  }

  /** Pair mode: one step of the partner, tagged with its name. */
  onPartnerTool(job: Job, call: ToolCall, summary: string, out: ToolOutput, ms: number) {
    const dot = out.isError ? c.red("●") : c.green("●");
    const time = ms >= 1000 ? c.dim(`  ${formatDuration(ms)}`) : "";
    const tag = c.violet(`◇ ${(job.partner ?? job.id).replace(/^Claude /, "")}`);
    const detail = out.display?.length === 1 && !out.isError && width(out.display[0]) <= 40 ? c.dim(" · ") + out.display[0] : "";
    this.out("partner", truncate(`${tag} ${dot} ${c.bold(toolLabel(call.name))} ${summary}${detail}${time}`, termWidth() - 1));
  }

  /** A message between agents: who to whom, and what (shortened). */
  onMessage(m: TeamMessage) {
    const text = m.text.replace(/\s+/g, " ").trim();
    const name = (id: string) => this.agent.jobs.get(id)?.partner?.replace(/^Claude /, "") ?? (id === "main" ? (this.agent.pairModel() ? modelInfo(this.agent.model).name.replace(/^Claude /, "") : "main") : id);
    const head = `${c.violet("✉")} ${c.bold(name(m.from))} ${c.dim("→")} ${c.bold(m.to === "all" ? "all" : name(m.to))}`;
    const rows = wrap(text, termWidth() - 6).slice(0, 2);
    if (wrap(text, termWidth() - 6).length > 2) rows[1] = truncate(rows[1], termWidth() - 8) + c.dim(" …");
    this.out("message", head, ...rows.map((r) => c.dim("  " + r)));
  }

  onStats(stats: Stats) {
    this.stats = stats;
    this.screen.schedule();
  }

  askPermission(req: PermissionRequest): Promise<PermissionAnswer> {
    return new Promise((resolve) => {
      this.mode = { kind: "permission", req, resolve };
      process.stdout.write("\x07"); // terminal bell: the agent is waiting for the user
      this.screen.schedule();
    });
  }

  // ---------- header ----------

  private banner(): string[] {
    const w = Math.min(termWidth() - 1, 78);
    const info = modelInfo(this.agent.model);
    const hasKey = !!getKey(this.cfg, this.agent.model.provider);
    const kv = (k: string, v: string) => `${c.dim(k.padEnd(10))}${v}`;
    const mode = this.agent.permissionMode;
    const stage = STAGE ? " " + c.yellow(STAGE) : "";
    const mcpTools = this.agent.mcp.status.reduce((n, s) => n + s.tools, 0);
    const info2 = [
      `${c.bold(c.orange("Forge"))} ${c.bold("Coding Agent")} ${c.dim("v" + VERSION)}${stage}`,
      "",
      hasKey
        ? kv("Model", `${c.bold(info.name)} ${c.dim(this.agent.model.id)}`)
        : kv("Model", c.yellow("not set yet — type /keys to add an API key")),
      kv("Provider", hasKey ? PROVIDER_LABEL[this.agent.model.provider] : c.dim("—")),
      kv("Effort", info.adaptive ? `${c.cyan(this.agent.effort)} ${c.dim("(/effort to change)")}` : c.dim("not adjustable for this model")),
      kv("Mode", `${this.modeText(mode)} ${c.dim("— " + MODE_HELP[mode])}`),
      kv("Folder", shortPath(this.agent.cwd, w - 28)),
      kv("Extras", c.dim(`${this.agent.skills.length} skill${this.agent.skills.length === 1 ? "" : "s"} · ${mcpTools} MCP tool${mcpTools === 1 ? "" : "s"}`)),
    ];
    // The mascot stands left of the facts; it steps aside in a narrow window.
    const rows = w >= 62 ? info2.map((r, i) => `${MASCOT[i - 1] ?? " ".repeat(9)}  ${r}`) : info2;
    return [
      ...box(rows, w, c.orange),
      truncate(c.dim("  / commands · shift+tab mode · alt+enter new line · esc interrupt"), termWidth() - 1),
    ];
  }

  private modeText(mode: PermissionMode): string {
    return mode === "yolo" ? c.red("yolo") : mode === "auto-edit" ? c.yellow("auto-edit") : c.green("ask");
  }

  // ---------- live frame ----------

  private frame(): LiveFrame {
    const cols = termWidth();
    const lines: string[] = [];
    const spin = SPINNER[Math.floor(Date.now() / 80) % SPINNER.length];
    const busy = this.agent.busy;

    if (this.thinking && this.cfg.showThinking) {
      // What the model is thinking about, then its latest lines of thought behind a gutter.
      if (this.lastKind) lines.push("");
      const title = thinkingHeadlines(this.thinking).at(-1) ?? "Thinking";
      lines.push(truncate(`${c.violet("✻")} ${c.violet(c.italic(title))}`, cols - 1));
      const rows = this.thinking
        .trim()
        .split("\n")
        .filter((l) => l.trim() && !HEADING_RE.test(l))
        .flatMap((l) => wrap(l.replace(/\*\*/g, ""), cols - 6));
      for (const r of rows.slice(-3)) lines.push(c.violet("  │ ") + c.dim(c.italic(r)));
    }
    if (this.md) {
      const partial = this.md.partial();
      if (partial) {
        const rows = wrap(partial, cols - 1, "  ").slice(-4);
        rows[0] = this.mark(rows[0], false);
        for (const r of rows) lines.push(r);
      }
    }
    if (this.tools.size && lines.length === 0 && this.lastKind) lines.push("");
    for (const t of this.tools.values()) {
      lines.push(`${c.cyan(spin)} ${c.bold(toolLabel(t.name))} ${t.summary} ${c.dim(formatDuration(Date.now() - t.started))}`);
      if (t.name === "task" && this.subTrail.length) {
        // A sub-agent's last few steps, so its work is visible rather than one frozen line.
        this.subTrail.forEach((s, i) => lines.push(truncate(c.dim((i === 0 ? "  ⎿ " : "    ") + s.replace(/\s+/g, " ")), cols - 1)));
        if (this.subCount > this.subTrail.length) lines.push(c.dim(`    ${this.subCount} tool calls so far`));
      } else if (t.live) lines.push(truncate(c.dim("  ⎿ " + t.live.replace(/\s+/g, " ")), cols - 1));
    }
    if (busy && this.mode.kind === "input") {
      let label = "Working";
      let about = "";
      let tint = c.orange;
      if (this.pendingTool) {
        // Say what is being written and how far it is: a long silent wait reads as a hang.
        const p = this.pendingTool;
        const waited = Date.now() - p.since;
        label = `${PENDING_LABEL[p.name] ?? `Preparing ${toolLabel(p.name)}`}${p.chars > 200 ? ` · ${formatTokens(p.chars)} chars so far` : ""}${waited > 5000 ? ` · ${formatDuration(waited)}` : ""}`;
      } else if (this.thinking) {
        label = "Thinking";
        tint = c.violet;
        // With the thinking preview off, the status line carries its title.
        if (!this.cfg.showThinking) about = thinkingHeadlines(this.thinking).at(-1) ?? "";
      } else if (this.md) label = "Writing";
      else if (this.tools.size) {
        tint = c.cyan;
        const only = this.tools.size === 1 ? [...this.tools.values()][0].name : "";
        label = only ? (RUNNING_LABEL[only] ?? `Running ${toolLabel(only)}`) : `Running ${this.tools.size} tools`;
      }
      const meta = [formatDuration(Date.now() - this.busySince)];
      if (this.outChars > 400) meta.push(`↓ ~${formatTokens(Math.round(this.outChars / 4))} tokens`);
      meta.push("esc to interrupt");
      if (lines.length) lines.push("");
      const status = `${tint(spin)} ${c.bold(label + "…")}${about ? " " + tint(c.italic(about)) + c.dim(" ·") : ""} ${c.dim(meta.join(" · "))}`;
      lines.push(truncate(status, cols - 1));
      const todos = this.agent.todos;
      if (todos.length > 1 && todos.some((t) => t.status !== "completed")) {
        // The plan stays in view while the model works through it.
        const max = 6;
        const cur = Math.max(0, todos.findIndex((t) => t.status === "in_progress"));
        const first = Math.min(Math.max(0, cur - 2), Math.max(0, todos.length - max));
        const shown = todos.slice(first, first + max);
        if (first > 0) lines.push(c.dim(`    … ${first} earlier step${first === 1 ? "" : "s"}`));
        for (const t of shown) lines.push(truncate("  " + c.dim("│ ") + planRow(t), cols - 1));
        const rest = todos.length - first - shown.length;
        if (rest > 0) lines.push(c.dim(`    … ${rest} more`));
      }
      for (const q of this.agent.steering) lines.push(c.dim(`  ↳ queued: ${q.replace(/\s+/g, " ")}`));
    }

    let cursor: LiveFrame["cursor"] = null;
    const m = this.mode;
    const w = cols - 1;
    if (m.kind === "permission") {
      const label = toolLabel(m.req.tool);
      const body = [`${c.bold(label)} ${m.req.title}`];
      for (const d of m.req.detail) {
        body.push("  " + (d.startsWith("+ ") ? c.green(d) : d.startsWith("- ") ? c.red(d) : d.startsWith("# ") ? c.dim(d) : d));
      }
      body.push("");
      body.push(`${c.bold(c.green("y"))} Yes    ${c.bold(c.red("n"))} No    ${c.bold(c.cyan("t"))} Tell Forge what to do instead`);
      body.push(`${c.bold(c.yellow("a"))} Always allow ${m.req.alwaysLabel}`);
      lines.push("");
      for (const l of box(body, w, c.yellow, "Permission needed")) lines.push(l);
    } else if (m.kind === "select") {
      const items = this.filtered(m);
      const body: string[] = [];
      const windowSize = 12;
      const first = Math.min(Math.max(0, m.index - windowSize + 1), Math.max(0, items.length - windowSize));
      const labelW = Math.min(34, Math.max(0, ...items.map((it) => width(it.label))));
      items.slice(first, first + windowSize).forEach((it, k) => {
        const selected = first + k === m.index;
        const text = `${pad(it.label, labelW)}${it.hint ? "  " + c.dim(it.hint) : ""}`;
        body.push(selected ? c.orange("❯ ") + c.bold(text) : "  " + text);
      });
      if (items.length === 0) body.push(c.dim("  no matches"));
      body.push("");
      body.push(
        c.dim(
          (m.filter ? `filter: ${m.filter} · ` : "type to filter · ") +
            `↑↓ move · enter select · esc cancel${items.length > windowSize ? ` · ${m.index + 1}/${items.length}` : ""}`,
        ),
      );
      lines.push("");
      for (const l of box(body, w, c.orange, m.title)) lines.push(l);
    } else {
      // input, feedback, secret: all use the editor inside a box
      const mode = this.agent.permissionMode;
      const border = m.kind !== "input" ? c.yellow : mode === "yolo" ? c.red : mode === "auto-edit" ? c.yellow : c.dim;
      const title = m.kind === "secret" ? "API key" : m.kind === "feedback" ? "What should Forge do instead?" : "";
      this.editor.mask = m.kind === "secret";
      const inner = w - 4;
      const lay = this.editor.layout(inner - 2, 10);
      let rows = lay.rows.map((r, i) => (i === 0 ? c.orange("❯ ") : "  ") + r);
      if (!this.editor.value) {
        const hint =
          m.kind === "secret"
            ? "paste the key and press enter (hidden) · esc cancels"
            : m.kind === "feedback"
              ? "enter to send · esc to just decline"
              : busy
                ? "type to send a message to the agent while it works…"
                : "Ask Forge anything, or type / for commands";
        rows = [c.orange("❯ ") + c.dim(hint)];
      }
      const running = this.agent.jobs.running().filter((j) => j.background);
      if (running.length && m.kind === "input") {
        if (lines.length || this.lastKind) lines.push("");
        for (const j of running.slice(0, 4)) lines.push(truncate(this.jobLine(j), cols - 1));
        if (running.length > 4) lines.push(c.dim(`    … ${running.length - 4} more · /jobs`));
      }
      if (lines.length || this.lastKind) lines.push("");
      const base = lines.length;
      for (const l of box(rows, w, border, title)) lines.push(l);
      if (m.kind === "secret") lines.push(c.dim("  " + m.title));
      cursor = { row: base + 1 + lay.cursorRow, col: 4 + lay.cursorCol };
      if (m.kind === "input") {
        for (const h of this.commandMenu()) lines.push(h);
        lines.push(this.statusBar(cols));
      }
    }
    return { lines, cursor };
  }

  /** One running background job: what it is, how long it runs, what it did last. */
  private jobLine(j: Job): string {
    // The label is cut so the running time and the latest output stay visible.
    const label = truncate(j.label.replace(/\s+/g, " "), 42);
    const what = j.kind === "agent" ? `${c.violet("◇")} ${c.bold(j.id)} ${label}` : `${c.cyan("↻")} ${c.bold(j.id)} ${label}`;
    const facts = [formatDuration(jobAge(j))];
    if (j.kind === "agent") facts.push(`${j.calls} tool call${j.calls === 1 ? "" : "s"}`);
    if (j.activity) facts.push(j.activity.replace(/\s+/g, " "));
    return `  ${what} ${c.dim("· " + facts.join(" · "))}`;
  }

  /** Commands matching what is typed after "/". */
  private commandMatches(): Command[] {
    const v = this.editor.value;
    if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) return [];
    return COMMANDS.filter((cmd) => cmd.name.startsWith(v));
  }

  private commandMenu(): string[] {
    const matches = this.commandMatches();
    if (!matches.length) return [];
    this.menuIndex = Math.min(this.menuIndex, matches.length - 1);
    const windowSize = 8;
    const first = Math.min(Math.max(0, this.menuIndex - windowSize + 1), Math.max(0, matches.length - windowSize));
    const rows = matches.slice(first, first + windowSize).map((cmd, k) => {
      const selected = first + k === this.menuIndex;
      const name = pad(cmd.name, 11);
      return selected
        ? `  ${c.orange("❯")} ${c.bold(c.cyan(name))} ${cmd.help}${cmd.args ? c.dim("  " + cmd.args) : ""}`
        : `    ${c.cyan(name)} ${c.dim(cmd.help)}`;
    });
    rows.push(c.dim(`    ↑↓ choose · tab complete · enter run${matches.length > windowSize ? ` · ${matches.length} commands` : ""}`));
    return rows;
  }

  private statusBar(cols: number): string {
    const info = modelInfo(this.agent.model);
    const hasKey = !!getKey(this.cfg, this.agent.model.provider);
    const sep = c.dim(" │ ");
    const parts: string[] = [];
    parts.push(hasKey ? `${c.orange("◆")} ${c.bold(info.name)}` : c.yellow("◇ no API key · /keys"));
    if (hasKey) parts.push(PROVIDER_LABEL[this.agent.model.provider]);
    if (info.adaptive) parts.push(`${c.dim("effort")} ${c.cyan(this.agent.effort)}`);
    parts.push(`${c.dim("mode")} ${this.modeText(this.agent.permissionMode)}`);
    const pair = this.agent.pairModel();
    if (pair) parts.push(`${c.dim("pair")} ${c.violet(modelInfo(pair).name.replace(/^Claude /, ""))}`);
    const advisor = this.agent.advisorModel();
    if (advisor) parts.push(`${c.dim("advisor")} ${c.yellow(modelInfo(advisor).name.replace(/^Claude /, ""))}`);
    const jobs = this.agent.jobs.running().filter((j) => j.background).length;
    if (jobs) parts.push(c.cyan(`${jobs} in background`));
    if (this.stats.contextTokens > 0) {
      const frac = Math.min(1, this.stats.contextTokens / this.stats.contextLimit);
      const cells = 8;
      const filled = Math.max(frac > 0 ? 1 : 0, Math.round(frac * cells));
      const color = frac > 0.8 ? c.red : frac > 0.5 ? c.yellow : c.green;
      parts.push(`${color("█".repeat(filled))}${c.dim("░".repeat(cells - filled))} ${Math.round(frac * 100)}% ${c.dim(formatTokens(this.stats.contextTokens))}`);
    }
    const budget = this.cfg.budget;
    if (this.stats.cost !== null && (this.stats.cost > 0 || budget)) {
      const spent = `$${this.stats.cost.toFixed(this.stats.cost < 1 ? 3 : 2)}`;
      const over = budget && this.stats.cost >= budget * 0.8;
      parts.push(budget ? (over ? c.yellow : (s: string) => s)(`${spent} ${c.dim("of")} $${budget.toFixed(2)}`) : spent);
    }
    const used = width(parts.join(" │ ")) + 5;
    const room = cols - 1 - used;
    if (room > 12) parts.push(c.dim(shortPath(this.agent.cwd, Math.min(room, 40))));
    return truncate("  " + parts.join(sep), cols - 1);
  }

  private filtered(m: Extract<Mode, { kind: "select" }>): SelectItem<unknown>[] {
    if (!m.filter) return m.items;
    const f = m.filter.toLowerCase();
    return m.items.filter((it) => (it.label + " " + (it.hint ?? "")).toLowerCase().includes(f));
  }

  // ---------- prompts ----------

  private select<T>(title: string, items: SelectItem<T>[], initial = 0): Promise<T | null> {
    return new Promise((resolve) => {
      this.mode = { kind: "select", title, items, index: Math.max(0, initial), filter: "", resolve: resolve as (v: unknown) => void };
      this.screen.schedule();
    });
  }

  private secret(title: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.editor.clear();
      this.mode = { kind: "secret", title, resolve };
      this.screen.schedule();
    });
  }

  // ---------- keyboard ----------

  private onKey(key: Key) {
    const m = this.mode;

    if (key.type === "ctrl-c") {
      if (m.kind === "select") return this.finishSelect(m, null);
      if (m.kind === "secret") return this.finishSecret(m, null);
      if (m.kind === "permission" || m.kind === "feedback") {
        this.mode = { kind: "input" };
        m.resolve({ allow: false });
        this.agent.interrupt();
        return;
      }
      if (this.agent.busy) return this.interrupt();
      if (this.editor.value) return this.editor.clear();
      if (Date.now() - this.lastCtrlC < 2000) return this.exit();
      this.lastCtrlC = Date.now();
      this.note("Press ctrl+c again to quit.");
      return;
    }

    switch (m.kind) {
      case "permission": {
        const ch = key.type === "text" ? key.text.toLowerCase() : key.type === "enter" ? "y" : key.type === "escape" ? "n" : "";
        if (ch === "y" || ch === "a" || ch === "n") {
          this.mode = { kind: "input" };
          m.resolve(ch === "n" ? { allow: false } : { allow: true, always: ch === "a" });
        } else if (ch === "t") {
          this.editor.clear();
          this.mode = { kind: "feedback", resolve: m.resolve };
        }
        return;
      }
      case "feedback": {
        if (key.type === "enter" || key.type === "escape") {
          const feedback = key.type === "enter" ? this.editor.value.trim() : "";
          this.editor.clear();
          this.mode = { kind: "input" };
          m.resolve({ allow: false, feedback: feedback || undefined });
        } else this.editor.handle(key);
        return;
      }
      case "secret": {
        if (key.type === "enter") return this.finishSecret(m, this.editor.value.trim() || null);
        if (key.type === "escape") return this.finishSecret(m, null);
        this.editor.handle(key);
        return;
      }
      case "select": {
        const items = this.filtered(m);
        if (key.type === "up") m.index = m.index > 0 ? m.index - 1 : Math.max(0, items.length - 1);
        else if (key.type === "down") m.index = m.index < items.length - 1 ? m.index + 1 : 0;
        else if (key.type === "enter") return this.finishSelect(m, items[m.index]?.value ?? null);
        else if (key.type === "escape") return this.finishSelect(m, null);
        else if (key.type === "backspace") {
          m.filter = m.filter.slice(0, -1);
          m.index = 0;
        } else if (key.type === "text") {
          m.filter += key.text;
          m.index = 0;
        }
        return;
      }
      case "input": {
        const menu = this.commandMatches();
        if (menu.length && (key.type === "up" || key.type === "down")) {
          const n = menu.length;
          this.menuIndex = (this.menuIndex + (key.type === "up" ? n - 1 : 1)) % n;
          return;
        }
        if (key.type === "enter") {
          // "\" + enter is a line continuation, for terminals without alt+enter.
          if (this.editor.value.endsWith("\\") && this.editor.cursor === this.editor.value.length) {
            this.editor.handle({ type: "backspace" });
            this.editor.insert("\n");
            return;
          }
          let text = this.editor.value.trim();
          if (!text) return;
          // A partly typed command runs the highlighted menu entry.
          if (menu.length && !menu.some((cmd) => cmd.name === text) && !ALIASES[text]) text = menu[this.menuIndex].name;
          this.editor.remember(text);
          this.editor.clear();
          this.menuIndex = 0;
          void this.submit(text);
          return;
        }
        if (key.type === "escape") {
          if (menu.length) this.editor.clear();
          else if (this.agent.busy) this.interrupt();
          return;
        }
        if (key.type === "ctrl-d") {
          if (!this.editor.value) this.exit();
          return;
        }
        if (key.type === "shift-tab") {
          const next = PERMISSION_MODES[(PERMISSION_MODES.indexOf(this.agent.permissionMode) + 1) % PERMISSION_MODES.length];
          this.setMode(next);
          return;
        }
        if (key.type === "tab") {
          if (menu.length) this.editor.set(menu[this.menuIndex].name + " ");
          return;
        }
        if (this.editor.handle(key)) this.menuIndex = 0;
        return;
      }
    }
  }

  private finishSelect(m: Extract<Mode, { kind: "select" }>, value: unknown) {
    this.mode = { kind: "input" };
    m.resolve(value);
  }

  private finishSecret(m: Extract<Mode, { kind: "secret" }>, value: string | null) {
    this.editor.clear();
    this.mode = { kind: "input" };
    m.resolve(value);
  }

  private interrupt() {
    this.agent.interrupt();
    this.note("Interrupted.", "warn");
  }

  // ---------- running the agent ----------

  private async submit(text: string) {
    if (text.startsWith("/")) {
      await this.command(text).catch((err) => this.note(`Command failed: ${(err as Error).message}`, "error"));
      this.screen.schedule();
      return;
    }
    if (this.agent.busy) {
      // Delivered to the model at the next tool boundary; run as a new turn otherwise.
      this.agent.steering.push(text);
      return;
    }
    await this.runTurns(text);
  }

  private async runTurns(text: string, shown = text) {
    let next: string | undefined = text;
    let label: string | undefined = shown;
    while (next !== undefined) {
      await this.runTurn(next, label ?? next);
      label = undefined;
      next = this.agent.steering.length ? this.agent.steering.splice(0).join("\n\n") : undefined;
    }
  }

  private async runTurn(text: string, shown: string) {
    this.userLine(shown);
    if (!getKey(this.cfg, this.agent.model.provider)) {
      this.note(`No API key for ${PROVIDER_LABEL[this.agent.model.provider]} yet. Type /keys to add one.`, "warn");
      return;
    }
    this.busySince = Date.now();
    this.outChars = 0;
    this.ticker = setInterval(() => this.screen.schedule(), 80);
    try {
      await this.ready; // the tool set must be complete before the first request
      await this.agent.run(text);
    } catch (err) {
      this.onAssistantEnd();
      this.note((err as Error).message, "error");
    } finally {
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      this.tools.clear();
      this.subActivity = "";
      this.subTrail = [];
      this.subCount = 0;
      this.pendingTool = null;
      this.onAssistantEnd();
      const took = Date.now() - this.busySince;
      if (took > 30_000) process.stdout.write("\x07");
      this.summaryCard(took);
      this.screen.schedule();
    }
  }

  /** After a request that changed files or took a while: what happened, at a glance. */
  private summaryCard(took: number) {
    const run = this.agent.lastRun;
    if (!run) return;
    if (!run.files.length && took < 30_000) {
      // A short request that still took several steps gets a quiet footer instead of the card.
      if (run.requests >= 2) {
        const cost = run.cost !== null ? ` · $${run.cost.toFixed(run.cost < 0.1 ? 4 : 2)}` : "";
        this.out("card", c.dim(`── ${formatDuration(took)} · ${run.requests} model requests${cost}`));
      }
      return;
    }
    const kv = (k: string, v: string) => `${c.dim(k.padEnd(9))}${v}`;
    const rows: string[] = [];
    const files = run.files.map((f) => `${f.path} ${f.kind === "deleted" ? c.red("deleted") : `${c.green("+" + f.added)}${f.removed ? " " + c.red("−" + f.removed) : ""}${f.kind === "new" ? c.dim(" new") : ""}`}`);
    files.slice(0, 8).forEach((f, i) => rows.push(kv(i === 0 ? "Changed" : "", f)));
    if (files.length > 8) rows.push(kv("", c.dim(`… ${files.length - 8} more files`)));
    const verdicts: string[] = [];
    if (run.checks) verdicts.push(run.checks === "passed" ? c.green("✓ checks passed") : c.red("✗ checks failing"));
    else if (run.files.length) verdicts.push(c.yellow("checks not run"));
    if (run.review) verdicts.push(run.review === "no findings" ? c.green("✓ review: no findings") : c.yellow(`review: ${run.review}`));
    if (verdicts.length) rows.push(kv("Verified", verdicts.join(c.dim(" · "))));
    rows.push(kv("Took", `${formatDuration(took)}${c.dim(" · ")}${run.requests} model request${run.requests === 1 ? "" : "s"}${run.cost !== null ? `${c.dim(" · ")}$${run.cost.toFixed(run.cost < 0.1 ? 4 : 2)}` : ""}`));
    if (run.files.length) rows.push(kv("", c.dim("/undo takes these changes back")));
    this.out("card", ...box(rows, Math.min(termWidth() - 1, 96), c.dim, "Done"));
  }

  // ---------- commands ----------

  private setMode(mode: PermissionMode) {
    this.agent.permissionMode = mode;
    this.cfg.permissionMode = mode;
    saveConfig(this.cfg);
    this.screen.schedule();
  }

  private async command(line: string) {
    const [rawName, ...rest] = line.split(/\s+/);
    const name = ALIASES[rawName] ?? rawName;
    const arg = rest.join(" ").trim();
    this.userLine(line, true);
    switch (name) {
      case "/help":
        return this.helpCommand();
      case "/exit":
        return this.exit();
      case "/status":
        return this.statusCommand();
      case "/new":
        if (this.agent.busy) return this.note("Wait for the current turn to finish, or press esc.", "warn");
        this.agent.reset();
        this.lastPlan = [];
        this.stats = this.agent.stats;
        this.turns = [];
        this.cur = null;
        this.turnCount = 0;
        this.screen.reset(this.banner());
        this.lastKind = "banner";
        return this.note("Started a new conversation.", "success");
      case "/init":
        if (this.agent.busy) return this.note("Wait for the current turn to finish first.", "warn");
        return this.runTurns(
          "Study this project (structure, languages, build/test/lint commands, conventions) and write a concise FORGE.md in the working directory: what the project is, how to build, test and run it, the layout of the important directories, and the coding conventions to follow. Only state what you verified in the files. If a FORGE.md already exists, improve it instead of replacing it.",
          "Study this project and write FORGE.md",
        );
      case "/cost": {
        const u = this.stats.total;
        const total = u.cacheRead + u.cacheWrite + u.input;
        const kv = (k: string, v: string) => `${c.dim(k.padEnd(14))}${v}`;
        const rows = [
          kv("Input", formatTokens(u.input)),
          kv("Cache read", `${formatTokens(u.cacheRead)}${total > 0 ? c.dim(`  (${Math.round((u.cacheRead / total) * 100)}% of input served from cache)`) : ""}`),
          kv("Cache write", formatTokens(u.cacheWrite)),
          kv("Output", formatTokens(u.output)),
          kv("Est. cost", this.stats.cost !== null ? c.bold(`$${this.stats.cost.toFixed(4)}`) : c.dim("unknown for this model")),
        ];
        return this.out("notice", ...box(rows, Math.min(termWidth() - 1, 70), c.dim, "Usage this session"));
      }
      case "/jobs": {
        const [sub, id] = arg.split(/\s+/);
        if (sub === "stop") {
          const job = id ? this.agent.jobs.get(id) : undefined;
          if (!job) return this.note(`No job "${id ?? ""}". /jobs lists them.`, "warn");
          if (job.status === "running") {
            job.status = "stopped";
            job.stop();
          }
          return this.note(`Stopped ${job.id} (${job.label}).`, "success");
        }
        const all = this.agent.jobs.list();
        if (!all.length) return this.note("No background jobs. Forge starts them for servers, watchers and sub-agents that work alongside it.");
        const rows = all.map((j) => {
          const state = j.status === "running" ? c.cyan("running") : j.status === "done" ? c.green("done") : j.status === "failed" ? c.red("failed") : c.dim("stopped");
          return `${c.bold(pad(j.id, 5))}${pad(state, 9)} ${c.dim(pad(formatDuration(jobAge(j)), 8))}${j.kind === "agent" ? "sub-agent  " : "command    "}${j.label}`;
        });
        rows.push("", c.dim("/jobs stop <id> ends one. Commands still running are stopped when Forge exits."));
        return this.out("notice", ...box(rows, termWidth() - 1, c.dim, "Background jobs"));
      }
      case "/history": {
        const earlier = this.turns.slice(0, -1);
        if (!earlier.length) return this.note("Nothing earlier in this conversation yet.");
        const rows = earlier.flatMap((t) => [...trimBlank(t.full), ""]);
        return this.out("notice", c.dim(`── ${earlier.length} earlier request${earlier.length === 1 ? "" : "s"} in full ──`), "", ...rows, c.dim("── end; the next request tidies the screen again ──"));
      }
      case "/view": {
        if (!arg) return this.note(`${this.cfg.visibleRequests === 0 ? "Every request stays on screen" : `The last ${this.cfg.visibleRequests ?? 5} requests stay on screen`}. Change with /view <number> or /view all.`);
        const n = arg === "all" ? 0 : Number(arg);
        if (!Number.isInteger(n) || n < 0) return this.note("Use /view <number>, e.g. /view 5, or /view all.", "warn");
        this.cfg.visibleRequests = n;
        saveConfig(this.cfg);
        return this.note(n ? `The last ${n} request${n === 1 ? "" : "s"} stay on screen; older ones shrink and then clear away.` : "Every request stays on screen.", "success");
      }
      case "/thinking":
        this.verboseThinking = !this.verboseThinking;
        return this.note(`Full thinking summaries ${this.verboseThinking ? "on" : "off"}.`, "success");
      case "/undo": {
        if (this.agent.busy) return this.note("Wait for the current turn to finish, or press esc.", "warn");
        const undone = this.agent.undo();
        if (!undone) return this.note("Nothing to undo: no request in this session has changed files.", "warn");
        return this.note(`Undid "${undone.label}": restored ${undone.files.join(", ")}. ${this.agent.undoable ? `${this.agent.undoable} earlier request${this.agent.undoable === 1 ? "" : "s"} can still be undone.` : ""} Changes made by shell commands are not covered.`, "success");
      }
      case "/watch":
        this.cfg.watch = this.cfg.watch === false;
        saveConfig(this.cfg);
        return this.note(`Watcher ${this.cfg.watch ? "on" : "off"}.`, "success");
      case "/prepare":
        this.cfg.prepare = this.cfg.prepare === false;
        saveConfig(this.cfg);
        return this.note(`Request preparation ${this.cfg.prepare ? "on" : "off"}.`, "success");
      case "/review":
        this.cfg.review = this.cfg.review === false;
        saveConfig(this.cfg);
        return this.note(`Independent review of larger changes ${this.cfg.review ? "on" : "off"}.`, "success");
      case "/notes": {
        const notes = loadNotes(this.agent.cwd);
        const rows = notes ? notes.split("\n").filter((l) => l.startsWith("- ")).flatMap((l) => wrap(l, termWidth() - 6)) : ["Nothing yet. Forge saves facts worth keeping here as it works."];
        rows.push("", c.dim("Stored in .forge/notes.md in this project - edit or delete it freely. Loaded when a session starts."));
        return this.out("notice", ...box(rows, termWidth() - 1, c.dim, "Project notes"));
      }
      case "/autocheck":
        this.cfg.autoCheck = this.cfg.autoCheck === false;
        saveConfig(this.cfg);
        return this.note(`Automatic checks after changes ${this.cfg.autoCheck ? "on" : "off"}.`, "success");
      case "/skills": {
        const rows = this.agent.skills.map((s) => `${c.bold(s.name)} ${c.dim("(" + s.source + ")")}  ${s.description}`);
        rows.push("", c.dim(`Add your own: ${shortPath(forgeHome(), 40)}/skills/<name>/SKILL.md, or .forge/skills in a project.`));
        return this.out("notice", ...box(rows, termWidth() - 1, c.dim, "Skills"));
      }
      case "/mcp": {
        const st = this.agent.mcp.status;
        const rows = st.map((s) => `${s.state === "connected" ? c.green("●") : c.red("●")} ${c.bold(s.name)} ${c.dim(`(${s.source})`)}  ${s.state === "connected" ? `${s.tools} tools` : s.state}${s.detail ? c.dim(" — " + s.detail) : ""}`);
        if (!st.length) rows.push("No MCP servers configured.");
        rows.push("", c.dim(`Configure servers in ${shortPath(forgeHome(), 40)}/mcp.json or a project's .mcp.json:`), c.dim(`{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "some-mcp-server"] } } }`), c.dim("Servers start with Forge; restart Forge after changing the file."));
        return this.out("notice", ...box(rows, termWidth() - 1, c.dim, "MCP servers"));
      }
      case "/web":
        this.cfg.webTools = !this.cfg.webTools;
        saveConfig(this.cfg);
        return this.note(`Web tools ${this.cfg.webTools ? "on" : "off"}. Applies from the next conversation (/new) so the current one keeps its cache.`, "success");
      case "/effort": {
        const level = (arg ||
          (await this.select(
            "Thinking effort",
            EFFORTS.map((e) => ({
              label: e,
              value: e,
              hint: { low: "fast, simple tasks", medium: "everyday work", high: "recommended for coding", xhigh: "hardest tasks, many more tokens", max: "slow and expensive" }[e],
            })),
            EFFORTS.indexOf(this.agent.effort),
          ))) as Effort | null;
        if (!level) return;
        if (!EFFORTS.includes(level)) return this.note(`Unknown effort "${level}". Use one of: ${EFFORTS.join(", ")}.`, "warn");
        this.agent.effort = level;
        this.cfg.effort = level;
        saveConfig(this.cfg);
        return this.note(`Effort set to ${level}.`, "success");
      }
      case "/mode": {
        const mode = (arg ||
          (await this.select(
            "Permission mode",
            PERMISSION_MODES.map((p) => ({ label: p, hint: MODE_HELP[p] + (p === "yolo" ? " — only in a sandbox or throwaway checkout" : ""), value: p })),
            PERMISSION_MODES.indexOf(this.agent.permissionMode),
          ))) as PermissionMode | null;
        if (!mode) return;
        if (!PERMISSION_MODES.includes(mode)) return this.note(`Unknown mode "${mode}". Use one of: ${PERMISSION_MODES.join(", ")}.`, "warn");
        this.setMode(mode);
        return this.note(`Permission mode: ${mode} (${MODE_HELP[mode]}).`, "success");
      }
      case "/compact":
        if (this.agent.busy) return this.note("Wait for the current turn to finish first.", "warn");
        this.note("Summarizing the conversation…");
        await this.agent.compact("manual");
        return;
      case "/keys":
        return this.keysCommand();
      case "/model":
        return this.modelCommand(arg);
      case "/advisor":
        return this.advisorCommand(arg);
      case "/pair":
        return this.pairCommand(arg);
      case "/subagent": {
        const choice =
          arg ||
          (await this.select<string>("Model for sub-agents", [
            { label: "auto", hint: "cheapest current model of the provider (Claude Haiku 5.5 on Anthropic)", value: "auto" },
            { label: "same", hint: "same model as the main agent - best quality, highest cost", value: "same" },
            ...ANTHROPIC_MODELS.filter(() => !!getKey(this.cfg, "anthropic")).map((m) => ({ label: m.name, hint: m.price ? `$${m.price.in}/$${m.price.out} per MTok` : "", value: `anthropic:${m.id}` })),
          ]));
        if (!choice) return;
        if (choice === "auto") this.cfg.subagentModel = undefined;
        else if (choice === "same" || parseModelRef(choice)) this.cfg.subagentModel = choice;
        else return this.note("Use auto, same, or provider:model-id (e.g. anthropic:claude-sonnet-5-5).", "warn");
        saveConfig(this.cfg);
        return this.note(`Sub-agents now run on ${modelInfo(this.agent.subagentModel()).name}.`, "success");
      }
      case "/budget": {
        if (!arg) {
          return this.note(
            this.cfg.budget
              ? `Session budget: $${this.cfg.budget.toFixed(2)} (spent about $${(this.stats.cost ?? 0).toFixed(2)}). Change with /budget <amount>, remove with /budget off.`
              : "No session budget set. Set one with /budget <amount in USD>, e.g. /budget 2.",
          );
        }
        if (arg === "off" || arg === "0") {
          this.cfg.budget = undefined;
          saveConfig(this.cfg);
          return this.note("Session budget removed.", "success");
        }
        const amount = Number(arg.replace(/^\$/, "").replace(",", "."));
        if (!Number.isFinite(amount) || amount <= 0) return this.note("Give an amount in USD, e.g. /budget 2.50, or /budget off.", "warn");
        this.cfg.budget = amount;
        saveConfig(this.cfg);
        return this.note(`Session budget set to $${amount.toFixed(2)}. Forge warns at 80% and stops when it is reached.`, "success");
      }
      case "/resume": {
        if (this.agent.busy) return this.note("Wait for the current turn to finish first.", "warn");
        const sessions = listSessions(this.agent.cwd).filter((s) => s.id !== this.agent.session.id);
        if (!sessions.length) return this.note("No earlier conversations in this folder.");
        const id = await this.select(
          "Resume a conversation",
          sessions.slice(0, 50).map((s) => ({ label: truncate(s.title || "(untitled)", 34), hint: `${s.updated.slice(0, 16).replace("T", " ")} · ${s.turns} messages`, value: s.id })),
        );
        if (!id) return;
        const data = loadSession(this.agent.cwd, id);
        if (!data) return this.note("Could not load that conversation.", "error");
        const model = parseModelRef(data.model) ?? this.agent.model;
        this.agent.close();
        this.agent = new Agent({ cfg: this.cfg, cwd: this.agent.cwd, ui: this, model, resume: data });
        this.ready = this.connect();
        this.lastPlan = [];
        this.stats = this.agent.stats;
        return this.note(`Resumed "${data.title}" (${data.messages.length} messages) on ${modelInfo(model).name}.`, "success");
      }
      default: {
        const near = COMMANDS.filter((cmd) => cmd.name.startsWith(rawName.slice(0, 3))).map((cmd) => cmd.name);
        return this.note(`Unknown command ${rawName}.${near.length ? ` Did you mean ${near.join(" or ")}?` : ""} Type /help for the list.`, "warn");
      }
    }
  }

  private helpCommand() {
    const w = Math.min(termWidth() - 1, 86);
    const rows: string[] = [];
    for (const group of ["Conversation", "Model", "Settings", "Other"] as const) {
      if (rows.length) rows.push("");
      rows.push(c.bold(c.orange(group)));
      for (const cmd of COMMANDS.filter((x) => x.group === group)) {
        rows.push(`  ${c.cyan(pad(cmd.name, 11))} ${cmd.help}${cmd.args ? c.dim("  " + cmd.args) : ""}`);
      }
    }
    rows.push("");
    rows.push(c.bold(c.orange("Keys")));
    const keys: [string, string][] = [
      ["enter", "send"],
      ["alt+enter", "new line (or end the line with \\ and press enter)"],
      ["↑ ↓", "previous messages"],
      ["esc", "interrupt the agent"],
      ["shift+tab", "switch permission mode"],
      ["ctrl+c", "clear input · twice to quit"],
    ];
    for (const [k, v] of keys) rows.push(`  ${c.cyan(pad(k, 11))} ${v}`);
    rows.push("");
    rows.push(c.dim("While Forge works you can keep typing: your message reaches it at its next step."));
    rows.push("");
    rows.push(c.bold(c.orange("Advisor or pair?")));
    for (const l of [
      `${c.cyan("/advisor")}  The working model stays in charge and may ask a stronger model for advice on a hard problem: one answer, no tools, at most a few times per request. Costs only when it is asked.`,
      `${c.cyan("/pair")}     Two different models (any two, also across providers) work on every request together the whole time: they discuss and agree on the best approach, split the work, code at the same time and keep talking until it is done. Costs both models' work on every request.`,
    ]) for (const r of wrap(l, w - 6, "           ")) rows.push(r);
    this.out("notice", ...box(rows, w, c.dim, "Help"));
  }

  private statusCommand() {
    const w = Math.min(termWidth() - 1, 78);
    const info = modelInfo(this.agent.model);
    const kv = (k: string, v: string) => `${c.dim(k.padEnd(12))}${v}`;
    const pct = this.stats.contextLimit ? Math.round((this.stats.contextTokens / this.stats.contextLimit) * 100) : 0;
    const rows = [
      kv("Model", `${c.bold(info.name)} ${c.dim(this.agent.model.id)}`),
      kv("Provider", PROVIDER_LABEL[this.agent.model.provider]),
      kv("Effort", info.adaptive ? c.cyan(this.agent.effort) : c.dim("not adjustable for this model")),
      kv("Mode", `${this.modeText(this.agent.permissionMode)} ${c.dim("— " + MODE_HELP[this.agent.permissionMode])}`),
      kv("Sub-agents", `${modelInfo(this.agent.subagentModel()).name} ${c.dim(this.cfg.subagentModel ? "" : "(auto: cheapest)")}`),
      kv("Pair", this.cfg.pair ? `${c.violet(modelInfo(parseModelRef(this.cfg.pair) ?? this.agent.model).name)} ${c.dim(`works with ${modelInfo(this.agent.model).name} on every request · expensive${this.agent.pairModel() ? "" : " · inactive (same as the main model or no key)"}`)}` : c.dim("off (/pair to switch on - expensive)")),
      kv("Advisor", this.cfg.advisor ? `${c.yellow(modelInfo(parseModelRef(this.cfg.advisor) ?? this.agent.model).name)} ${c.dim(`very expensive · up to ${this.cfg.advisorLimit ?? 3} calls per request${this.agent.advisorModel() ? "" : " · inactive (same as the working model or no key)"}`)}` : c.dim("off (/advisor to switch on - very expensive)")),
      kv("Budget", this.cfg.budget ? `$${this.cfg.budget.toFixed(2)} per session` : c.dim("none (/budget to set)")),
      kv("Web tools", this.cfg.webTools ? "on" : "off"),
      kv("Context", `${formatTokens(this.stats.contextTokens)} of ${formatTokens(this.stats.contextLimit)} (${pct}%)`),
      kv("Cost", this.stats.cost !== null ? `$${this.stats.cost.toFixed(4)}` : c.dim("unknown for this model")),
      kv("Messages", String(this.agent.messages.length)),
      kv("Folder", shortPath(this.agent.cwd, w - 18)),
      "",
      c.bold("API keys"),
      ...PROVIDERS.map((p) => {
        const key = getKey(this.cfg, p);
        return kv("  " + PROVIDER_LABEL[p], key ? `${c.green("✓")} ${maskKey(key)} ${c.dim(keySource(this.cfg, p) === "env" ? "from " + envVarName(p) : "saved")}` : c.dim("— not set"));
      }),
    ];
    this.out("notice", ...box(rows, w, c.dim, "Status"));
  }

  /** Switch the advisor on or off. Off by default: every call is a request to an expensive model. */
  private async advisorCommand(arg: string) {
    let choice = arg;
    if (!choice) {
      const working = modelInfo(this.agent.model);
      const items: SelectItem<string>[] = [{ label: "off", hint: "default - the working model handles everything itself", value: "off" }];
      if (getKey(this.cfg, "anthropic")) {
        for (const m of ANTHROPIC_MODELS) {
          if (m.id === this.agent.model.id || !m.price || (working.price && m.price.out <= working.price.out)) continue;
          const factor = working.price && working.price.out ? Math.round(m.price.out / working.price.out) : 0;
          items.push({ label: m.name, hint: `VERY EXPENSIVE · $${m.price.in}/$${m.price.out} per MTok${factor > 1 ? ` · ${factor}× ${working.name}` : ""}`, value: `anthropic:${m.id}` });
        }
      }
      const current = this.cfg.advisor ? Math.max(0, items.findIndex((it) => it.value === this.cfg.advisor)) : 0;
      const picked = await this.select("Advisor - a stronger model the working model may ask on hard problems", items, current);
      if (!picked) return;
      choice = picked;
    }
    if (choice === "off") {
      this.cfg.advisor = undefined;
      saveConfig(this.cfg);
      return this.note("Advisor off.", "success");
    }
    const ref = parseModelRef(choice) ?? (ANTHROPIC_MODELS.some((m) => m.id === choice) ? { provider: "anthropic" as const, id: choice } : null);
    if (!ref) return this.note("Use /advisor off, or /advisor provider:model-id (e.g. anthropic:claude-fable-5-2).", "warn");
    if (!getKey(this.cfg, ref.provider)) return this.note(`No API key for ${PROVIDER_LABEL[ref.provider]}. Add one with /keys.`, "warn");
    this.cfg.advisor = formatModelRef(ref);
    saveConfig(this.cfg);
    const info = modelInfo(ref);
    const limit = this.cfg.advisorLimit ?? 3;
    this.note(`Advisor on: ${info.name}${info.price ? ` ($${info.price.in}/$${info.price.out} per MTok)` : ""}. The working model may ask it up to ${limit} times per request, only on hard problems. Each call sends a condensed record of the conversation and is expensive. /advisor off switches it off.`, "warn");
    if (formatModelRef(ref) === formatModelRef(this.agent.model)) this.note("That is the model already working, so the advisor stays inactive until you switch to a cheaper model.", "warn");
  }

  private async keysCommand() {
    const provider = await this.select<ProviderId>(
      "API keys — choose a provider",
      PROVIDERS.map((p) => {
        const src = keySource(this.cfg, p);
        const key = getKey(this.cfg, p);
        return {
          label: PROVIDER_LABEL[p],
          hint: key ? `✓ ${maskKey(key)} (${src === "env" ? "from " + envVarName(p) : "saved"})` : "not set",
          value: p,
        };
      }),
    );
    if (!provider) return;
    const value = await this.secret(`${PROVIDER_LABEL[provider]} key · stored in ~/.forge/config.json`);
    if (value === null) return this.note("No change.");
    this.cfg.keys[provider] = value;
    saveConfig(this.cfg);
    this.note(`Saved the ${PROVIDER_LABEL[provider]} key (${maskKey(value)}).`, "success");
    if (keySource(this.cfg, provider) === "env") this.note(`${envVarName(provider)} is set in the environment and takes precedence.`, "warn");
    // First key: move to that provider's models if the current one has no key.
    if (!getKey(this.cfg, this.agent.model.provider)) await this.modelCommand("");
  }

  private async modelCommand(arg: string) {
    let ref: ModelRef | null = null;
    if (arg) {
      ref = parseModelRef(arg) ?? (ANTHROPIC_MODELS.some((m) => m.id === arg) ? { provider: "anthropic", id: arg } : null);
      if (!ref) return this.note("Use the form provider:model-id, e.g. anthropic:claude-fable-5-2 or openrouter:anthropic/claude-opus-5.5.", "warn");
    } else {
      const items = await this.modelItems();
      if (!items.length) return this.note("No API key yet. Add one with /keys first.", "warn");
      const current = items.findIndex((it) => it.value.provider === this.agent.model.provider && it.value.id === this.agent.model.id);
      ref = await this.select("Choose a model", items, current);
      if (!ref) return;
    }
    if (!getKey(this.cfg, ref.provider)) return this.note(`No API key for ${PROVIDER_LABEL[ref.provider]}. Add one with /keys.`, "warn");
    const hadHistory = this.agent.messages.length > 0;
    this.agent.setModel(ref);
    this.cfg.model = formatModelRef(ref);
    saveConfig(this.cfg);
    this.note(`Now using ${modelInfo(ref).name} via ${PROVIDER_LABEL[ref.provider]}.`, "success");
    if (hadHistory) this.note("The conversation continues; the new model starts without a prompt cache and without the previous model's thinking.");
    if (this.cfg.pair && this.cfg.pair === formatModelRef(ref)) this.note("Your pair partner is now the same model, so pair mode pauses until one of them changes (/pair).", "warn");
  }

  /** Every model the saved keys give access to. */
  private async modelItems(): Promise<SelectItem<ModelRef>[]> {
    {
      const items: SelectItem<ModelRef>[] = [];
      if (getKey(this.cfg, "anthropic")) {
        for (const m of ANTHROPIC_MODELS) {
          items.push({
            label: m.name,
            hint: ["Anthropic", m.price ? `$${m.price.in}/$${m.price.out} per MTok` : "", m.note].filter(Boolean).join(" · "),
            value: { provider: "anthropic", id: m.id },
          });
        }
      }
      for (const p of ["openrouter", "openai"] as const) {
        if (!getKey(this.cfg, p)) continue;
        try {
          const list = await getProvider(this.cfg, p).listModels();
          const wanted = p === "openrouter" ? list.filter((m) => /claude/i.test(m.id)) : list.filter((m) => /^(gpt|o\d|chatgpt)/i.test(m.id));
          for (const m of wanted.slice(0, 60)) items.push({ label: truncate(m.name, 34), hint: `${PROVIDER_LABEL[p]} · ${m.id}`, value: { provider: p, id: m.id } });
        } catch (err) {
          this.note(`Could not load the ${PROVIDER_LABEL[p]} model list: ${(err as Error).message}`, "warn");
        }
      }
      return items;
    }
  }

  /**
   * Pair mode: a second, different model works on every request with the main
   * model. Off by default; it costs both models' work on every request.
   */
  private async pairCommand(arg: string): Promise<void> {
    let ref: ModelRef | null = null;
    if (arg === "off") {
      this.cfg.pair = undefined;
      saveConfig(this.cfg);
      return this.note("Pair mode off.", "success");
    }
    if (arg) {
      ref = parseModelRef(arg) ?? (ANTHROPIC_MODELS.some((m) => m.id === arg) ? { provider: "anthropic", id: arg } : null);
      if (!ref) return this.note("Use /pair off, or /pair provider:model-id (e.g. openai:gpt-5 or anthropic:claude-haiku-5-5).", "warn");
    } else {
      const lead = modelInfo(this.agent.model).name;
      const items = (await this.modelItems()).filter((it) => formatModelRef(it.value) !== formatModelRef(this.agent.model));
      const all: SelectItem<ModelRef | "off">[] = [{ label: "off", hint: "default - one model works, as usual", value: "off" }, ...items.map((it) => ({ ...it, hint: `EXPENSIVE · ${it.hint ?? ""}` }))];
      const current = this.cfg.pair ? Math.max(0, all.findIndex((it) => it.value !== "off" && formatModelRef(it.value) === this.cfg.pair)) : 0;
      const picked = await this.select(`Pair partner for ${lead} - both work on every request together`, all, current);
      if (!picked) return;
      if (picked === "off") return this.pairCommand("off");
      ref = picked;
    }
    if (formatModelRef(ref) === formatModelRef(this.agent.model)) return this.note("A pair needs two different models. Choose another partner, or switch the main model with /model.", "warn");
    if (!getKey(this.cfg, ref.provider)) return this.note(`No API key for ${PROVIDER_LABEL[ref.provider]}. Add one with /keys.`, "warn");
    this.cfg.pair = formatModelRef(ref);
    saveConfig(this.cfg);
    const a = modelInfo(this.agent.model);
    const b = modelInfo(ref);
    const price = (m: typeof a) => (m.price ? ` ($${m.price.in}/$${m.price.out} per MTok)` : "");
    this.note(
      `Pair mode on: ${a.name}${price(a)} leads, ${b.name}${price(b)} is its partner. On every request they first discuss the approach, critique each other and agree on a plan that splits the work, then both code at the same time on their parts and talk all the way through. This costs both models' work on every request - how much depends on the two models. /pair off switches it off.`,
      "warn",
    );
  }

  // ---------- lifecycle ----------

  /** Start MCP servers; a project's own servers need the user's yes once. */
  private ready: Promise<void> = Promise.resolve();
  private connect(): Promise<void> {
    return this.agent
      .init(async (s) => (await this.select(`This project wants to start the MCP server "${s.name}": ${truncate(`${s.command} ${s.args.join(" ")}`, 60)}`, [
        { label: "Start it", hint: "and remember for this project", value: true },
        { label: "Do not start", value: false },
      ], 1)) === true)
      .catch((err) => this.note(`MCP: ${(err as Error).message}`, "warn"));
  }

  private exit() {
    this.agent.interrupt();
    this.agent.close();
    if (this.ticker) clearInterval(this.ticker);
    this.screen.close();
    process.stdout.write("\x1b[?2004l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (this.agent.messages.length) {
      process.stdout.write(c.dim("Conversation saved. Continue it with: forge --continue") + "\r\n");
    }
    this.done();
  }

  async start(initialPrompt?: string) {
    process.stdout.write("\x1b]0;Forge\x07"); // window title
    this.screen.commit(...this.banner());
    this.lastKind = "banner";
    if (this.agent.messages.length) this.note(`Resumed "${this.agent.session.title}" (${this.agent.messages.length} messages).`, "success");

    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdout.write("\x1b[?2004h"); // bracketed paste
    process.stdin.on("data", (chunk: string) => {
      for (const key of this.decoder.decode(chunk)) {
        try {
          this.onKey(key);
        } catch (err) {
          this.note(`Internal error: ${(err as Error).message}`, "error");
        }
      }
      this.screen.schedule();
    });
    process.on("exit", () => {
      process.stdout.write("\x1b[?2004l\x1b[?25h");
    });

    this.ready = this.connect();
    if (initialPrompt) void this.submit(initialPrompt);
    await this.finished;
  }
}

export async function runInteractive(opts: { cfg: Config; cwd: string; resume: SessionData | null; initialPrompt?: string }) {
  const app = new App(opts.cfg, opts.cwd, opts.resume);
  await app.start(opts.initialPrompt);
}

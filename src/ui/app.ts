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
import { listSessions, loadSession, type SessionData } from "../session.ts";
import type { ToolOutput } from "../tools/index.ts";
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
  { name: "/undo", help: "take back the file changes of the last request", group: "Conversation" },
  { name: "/init", help: "let Forge study the project and write FORGE.md", group: "Conversation" },
  { name: "/model", args: "[provider:id]", help: "choose the model", group: "Model" },
  { name: "/effort", args: "[low|medium|high|xhigh|max]", help: "how hard the model thinks", group: "Model" },
  { name: "/subagent", args: "[auto|same|provider:id]", help: "model used for sub-agents", group: "Model" },
  { name: "/budget", args: "[amount|off]", help: "spending limit per session in USD", group: "Settings" },
  { name: "/keys", help: "add or replace API keys", group: "Settings" },
  { name: "/mode", args: "[ask|auto-edit|yolo]", help: "permission mode (shift+tab cycles)", group: "Settings" },
  { name: "/thinking", help: "show full thinking summaries on/off", group: "Settings" },
  { name: "/web", help: "web search and fetch tools on/off", group: "Settings" },
  { name: "/autocheck", help: "run the project's checks after changes on/off", group: "Settings" },
  { name: "/review", help: "independent review of larger changes on/off", group: "Settings" },
  { name: "/watch", help: "a small model reads edits while Forge works on/off", group: "Settings" },
  { name: "/prepare", help: "project snapshot and task triage before each request on/off", group: "Settings" },
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
  private busySince = 0;
  private lastKind = "";
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
  }

  // ---------- output helpers ----------

  private out(kind: string, ...lines: string[]) {
    if (this.lastKind && (kind !== this.lastKind || kind === "user" || kind === "assistant")) this.screen.commit("");
    this.lastKind = kind;
    this.screen.commit(...lines);
  }

  private note(msg: string, level: "info" | "warn" | "error" | "success" = "info") {
    const [icon, color] =
      level === "error" ? ["✗", c.red] : level === "warn" ? ["!", c.yellow] : level === "success" ? ["✓", c.green] : ["·", c.dim];
    const lines = msg.split("\n").flatMap((l) => wrap(l, termWidth() - 4, ""));
    this.out("notice", ...lines.map((l, i) => (i === 0 ? color(icon) + " " : "  ") + (level === "info" ? c.dim(l) : l)));
  }

  private userLine(text: string, dim = false) {
    const rows = text.split("\n").flatMap((l) => wrap(l, termWidth() - 6));
    this.out(
      "user",
      ...rows.map((r, i) => c.bgGray(` ${i === 0 ? c.orange("❯") : " "} ${dim ? c.dim(r) : c.bold(r)} `)),
    );
  }

  private endThinking() {
    if (!this.thinking && !this.thinkingStart) return;
    const secs = Math.max(1, Math.round((Date.now() - this.thinkingStart) / 1000));
    const lines = [c.dim(`✻ ${c.italic(`Thought for ${secs}s`)}`)];
    if (this.verboseThinking && this.thinking.trim()) {
      for (const l of this.thinking.trim().split("\n")) for (const r of wrap(l, termWidth() - 4)) lines.push(c.dim("  " + r));
    }
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
    if (!this.md) {
      this.endThinking();
      this.md = new MarkdownStream(() => termWidth() - 1, "  ");
      this.mdStarted = false;
      if (this.lastKind) this.screen.commit("");
      this.lastKind = "assistant-open";
    }
    const lines = this.md.push(delta);
    if (lines.length) this.screen.commit(...lines.map((l) => this.mark(l, true)));
    else this.screen.schedule();
  }

  onThinking(delta: string) {
    if (!this.thinkingStart) this.thinkingStart = Date.now();
    this.thinking += delta;
    this.screen.schedule();
  }

  onAssistantEnd() {
    this.endThinking();
    if (this.md) {
      const rest = this.md.end();
      if (rest.length) this.screen.commit(...rest.map((l) => this.mark(l, true)));
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
    if (this.pendingTool) this.pendingTool.chars = chars;
    this.screen.schedule();
  }

  onToolStart(call: ToolCall, summary: string, depth: number) {
    if (depth > 0) {
      this.subActivity = `${toolLabel(call.name)} ${stripAnsi(summary)}`;
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
    const summary = this.tools.get(call.id)?.summary ?? "";
    this.tools.delete(call.id);
    if (call.name === "task") this.subActivity = "";
    const dot = output.isError ? c.red("●") : c.green("●");
    const time = ms >= 1000 ? c.dim(`  ${formatDuration(ms)}`) : "";
    const lines = [`${dot} ${c.bold(toolLabel(call.name))} ${summary}${time}`];
    let detail = output.display;
    // For failures, show the message the model received (the shell tool already includes it).
    if (output.isError && !detail && typeof output.content === "string") {
      detail = output.content.split("\n").slice(0, 4).map((l) => c.red(l));
    }
    (detail ?? []).slice(0, 30).forEach((l, i) => lines.push(c.dim(i === 0 ? "  ⎿ " : "    ") + l));
    this.out("tool", ...lines);
  }

  onServerTool(name: string, detail: string) {
    this.out("tool", `${c.blue("●")} ${c.bold(toolLabel(name))} ${detail}`);
  }

  onNotice(msg: string, level: "info" | "warn" | "error" = "info") {
    this.note(msg, level);
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
      const rows = this.thinking.trim().split("\n").flatMap((l) => wrap(l, cols - 6));
      for (const r of rows.slice(-3)) lines.push(c.dim(c.italic("  " + r)));
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
      lines.push(`${c.orange(spin)} ${c.bold(toolLabel(t.name))} ${t.summary} ${c.dim(formatDuration(Date.now() - t.started))}`);
      const live = t.name === "task" && this.subActivity ? this.subActivity : t.live;
      if (live) lines.push(c.dim("  ⎿ " + live.replace(/\s+/g, " ")));
    }
    if (busy && this.mode.kind === "input") {
      let label = "Working";
      if (this.pendingTool) {
        // Say what is being written and how far it is: a long silent wait reads as a hang.
        const p = this.pendingTool;
        const waited = Date.now() - p.since;
        label = `${PENDING_LABEL[p.name] ?? `Preparing ${toolLabel(p.name)}`}${p.chars > 200 ? ` · ${formatTokens(p.chars)} chars so far` : ""}${waited > 5000 ? ` · ${formatDuration(waited)}` : ""}`;
      } else if (this.thinking) label = "Thinking";
      else if (this.md) label = "Writing";
      else if (this.tools.size) label = "Running tools";
      if (lines.length) lines.push("");
      lines.push(`${c.orange(spin)} ${c.bold(label + "…")} ${c.dim(`${formatDuration(Date.now() - this.busySince)} · esc to interrupt`)}`);
      const todos = this.agent.todos;
      if (todos.length) {
        const doneCount = todos.filter((t) => t.status === "completed").length;
        const current = todos.find((t) => t.status === "in_progress");
        lines.push(c.dim(`  ${doneCount}/${todos.length} steps${current ? ` · now: ${current.content}` : ""}`));
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
      if (lines.length) lines.push("");
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
    if (!run || (!run.files.length && took < 30_000)) return;
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
    this.out("notice", ...box(rows, Math.min(termWidth() - 1, 96), c.dim, "Done"));
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
        this.stats = this.agent.stats;
        this.out("banner", ...this.banner());
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

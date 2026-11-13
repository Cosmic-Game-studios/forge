import path from "node:path";
import type { ContentBlock, ToolSpec } from "../providers/types.ts";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Mutable state shared by all tools of one agent session. */
export interface ToolContext {
  /** Current working directory; the shell tool updates it after `cd`. */
  cwd: string;
  signal: AbortSignal;
  /** path -> mtime (ms) at the time the model last read or wrote the file. */
  fileState: Map<string, number>;
  /** "file|range" -> mtime of ranges whose content is already in the conversation. */
  readSeen: Map<string, number>;
  todos: TodoItem[];
  /** Files written through the file tools in this session (absolute paths). */
  changed?: Set<string>;
  /** Type-check state: errors seen at the previous check (null before the first), and whether it is switched off. */
  diag?: { known: Set<string> | null; off: boolean };
  /** Linters that turned out to be missing or too slow in this session. */
  lintOff?: Set<string>;
  /** Run a sub-agent with a fresh context; returns its final report. */
  runSubagent(prompt: string, description: string): Promise<string>;
  /** Live progress line for long-running tools. */
  progress(text: string): void;
}

export interface ToolOutput {
  /** What the model sees. */
  content: string | ContentBlock[];
  isError?: boolean;
  /** Optional lines shown to the user (e.g. a diff) instead of a content preview. */
  display?: string[];
}

export type ToolKind = "read" | "edit" | "exec" | "meta";

export interface Tool {
  spec: ToolSpec;
  /** read: no side effects, safe to run in parallel. */
  kind: ToolKind;
  /** Comes from an MCP server: its schema is not ours to validate. */
  external?: boolean;
  /** One-line description of this call for the UI. */
  summarize(input: Record<string, any>, ctx: ToolContext): string;
  run(input: Record<string, any>, ctx: ToolContext): Promise<ToolOutput>;
}

export function resolvePath(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.cwd, p);
}

export function displayPath(ctx: ToolContext, p: string): string {
  const abs = path.resolve(ctx.cwd, p);
  const rel = path.relative(ctx.cwd, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
}

/** Keep the head and tail of oversized output so the model sees both ends. */
export function clip(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const dropped = text.length - max;
  return `${text.slice(0, head)}\n\n[... ${dropped} characters omitted ...]\n\n${text.slice(-tail)}`;
}

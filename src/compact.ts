// Graded context compression.
//
// The conversation is rewritten as: one summary + the most recent messages
// kept word for word. The summary is written by the cheapest model of the
// connected provider, from a transcript in which detail already falls off with
// age: recent tool output is passed almost whole, old output only as a stub.
// The summary itself is asked to keep the same gradient, and an earlier
// summary is compressed again each time, so old work fades instead of
// vanishing.

import { getKey, type Config } from "./config.ts";
import { modelInfo, type ModelRef } from "./models.ts";
import type { ContentBlock, Message } from "./providers/types.ts";

export const SUMMARY_MARK = "[Forge context summary]";

/** The cheapest capable model reachable with the keys the user has connected. */
export function cheapModel(cfg: Config, main: ModelRef): ModelRef {
  if (getKey(cfg, "anthropic")) return { provider: "anthropic", id: "claude-haiku-5-5" };
  // On OpenRouter the Claude ids mirror Anthropic's; other providers keep the session's model.
  if (main.provider === "openrouter" && /^anthropic\/claude/.test(main.id)) return { provider: "openrouter", id: "anthropic/claude-haiku-5.5" };
  return main;
}

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.ceil(max * 0.7))}\n[… ${s.length - max} chars omitted …]\n${s.slice(-Math.floor(max * 0.3))}`);

function blockSize(b: ContentBlock): number {
  const any = b as Record<string, any>;
  if (b.type === "text") return any.text.length;
  if (b.type === "image") return 6000;
  if (b.type === "tool_use") return JSON.stringify(any.input ?? {}).length + 40;
  if (b.type === "tool_result") return typeof any.content === "string" ? any.content.length : (any.content ?? []).reduce((n: number, x: ContentBlock) => n + blockSize(x), 0);
  return 0; // thinking is not carried over
}

export const messageSize = (m: Message) => (typeof m.content === "string" ? m.content.length : m.content.reduce((n, b) => n + blockSize(b), 0));

/** One message as plain text, with tool traffic limited to `limit` characters per item. */
function renderMessage(m: Message, limit: number): string {
  if (typeof m.content === "string") {
    if (m.content.startsWith(SUMMARY_MARK)) return `EARLIER SUMMARY (already compressed once):\n${m.content}`;
    return `USER:\n${cut(m.content, Math.max(limit, 4000))}`; // the user's own words are the most valuable part
  }
  const out: string[] = [];
  for (const b of m.content) {
    const any = b as Record<string, any>;
    if (b.type === "text") {
      if (any.text.startsWith(SUMMARY_MARK)) out.push(`EARLIER SUMMARY (already compressed once):\n${any.text}`);
      else out.push(`${m.role === "user" ? "USER" : "ASSISTANT"}:\n${cut(any.text, Math.max(limit * 2, 1500))}`);
    } else if (b.type === "tool_use") out.push(`TOOL CALL ${any.name}: ${cut(JSON.stringify(any.input ?? {}), limit)}`);
    else if (b.type === "tool_result") {
      const text = typeof any.content === "string" ? any.content : (any.content ?? []).map((x: any) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
      out.push(`TOOL RESULT${any.is_error ? " (error)" : ""}: ${cut(text, limit)}`);
    } else if (b.type === "image") out.push("[image]");
  }
  return out.join("\n");
}

/**
 * Render messages for the summarizer. Detail follows age, measured by position
 * in the text: the oldest half gets stubs, the next 30% excerpts, the newest
 * 20% nearly everything. Limits shrink further if the result would not fit.
 */
export function renderTranscript(messages: Message[], maxChars: number): string {
  const sizes = messages.map(messageSize);
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  for (let scale = 1; ; scale /= 2) {
    let pos = 0;
    const parts = messages.map((m, i) => {
      const age = 1 - (pos + sizes[i] / 2) / total; // 1 = oldest, 0 = newest
      pos += sizes[i];
      const limit = (age > 0.5 ? 300 : age > 0.2 ? 1500 : 6000) * scale;
      const tier = age > 0.5 ? "old" : age > 0.2 ? "middle" : "recent";
      return `--- message ${i + 1} (${tier}) ---\n${renderMessage(m, Math.max(80, Math.round(limit)))}`;
    });
    const text = parts.join("\n\n");
    if (text.length <= maxChars || scale < 0.02) return text.slice(-maxChars);
  }
}

/**
 * Where the verbatim tail starts: the earliest assistant message from which
 * everything up to the end fits in `budget` characters. Starting at an
 * assistant message keeps every tool result next to its call.
 */
export function tailStart(messages: Message[], budget: number): number {
  let size = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    size += messageSize(messages[i]);
    if (size > budget) break;
    if (messages[i].role === "assistant") start = i;
  }
  return start;
}

/** Thinking is bound to the conversation that produced it and cannot be replayed after a rewrite. */
export function stripThinking(messages: Message[]): Message[] {
  return messages
    .map((m) => (typeof m.content === "string" ? m : { ...m, content: m.content.filter((b) => !["thinking", "redacted_thinking", "x_reasoning", "compaction"].includes(b.type)) }))
    .filter((m) => typeof m.content === "string" || m.content.length > 0);
}

export const COMPACT_SYSTEM =
  "You compress the transcript of a coding session between a user and an AI coding agent into a summary. The agent will continue the work from your summary and will not see the transcript again, so anything you leave out is lost to it. You write only the summary: plain text, no preamble, no questions, no tool calls.";

export function compactPrompt(transcript: string, opts: { tailKept: boolean; midTask: boolean }): string {
  return `${transcript}

=== end of transcript ===

Write the summary that replaces the transcript above. Precision must follow age: the most recent work is recorded exactly, older work more and more briefly - but never so briefly that the agent could not act on it. Use these four sections, in this order:

## Goal and instructions
What the user wants, in their terms. Every explicit instruction, constraint and preference the user gave, including ones from long ago (these never expire unless the user withdrew them). Quote short key phrases word for word.

## Earlier work (brief)
The messages marked "old", and any EARLIER SUMMARY: compress them further. One line per finished piece of work: what was done, in which files, and the decision or reason that still matters. Drop dead ends, superseded attempts and output nobody needs again. Keep anything a later step may depend on (names, paths, interfaces, commands that work).

## Recent work (detailed)
The messages marked "middle" and "recent", in order. For each step: the files and functions touched (exact paths and names), what changed and why, commands run and what they showed, errors met and how they were resolved or why they are still open. Keep exact identifiers, numbers, error messages and short code fragments the agent will need.

## Current state
Exactly where things stand at the end: what is finished and verified, what is finished but not verified, what is in progress, known problems, and the next steps in order.${opts.tailKept ? " The last few messages follow your summary word for word, so do not repeat their content; describe the state just before them." : ""}${opts.midTask ? " The agent is in the middle of the task and will carry on at once, so the next step must be unambiguous." : ""}

Be specific, not short: a summary of a long session is normally 600 to 2000 words, most of them in the last two sections. Never invent details; if the transcript is unclear about something, say so.`;
}

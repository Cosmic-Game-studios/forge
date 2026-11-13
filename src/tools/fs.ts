// File tools: read, write, edit, multi_edit.

import fs from "node:fs/promises";
import path from "node:path";
import { c } from "../ui/term.ts";
import { syntaxCheck } from "./check.ts";
import { typeProblems } from "./diagnose.ts";
import { editNotes, formatNotes, lintProblems } from "./watch.ts";
import { findSymbols, supportsOutline, symbolRange } from "./outline.ts";
import { displayPath, resolvePath, type Tool, type ToolContext, type ToolOutput } from "./types.ts";

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_BYTES = 10 * 1024 * 1024;
/** Above this size an existing file must be changed with edit, not rewritten. */
const REWRITE_GUARD_LINES = 200;

async function mtime(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export const readTool: Tool = {
  kind: "read",
  spec: {
    name: "read",
    description:
      "Read a file. Returns text with line numbers (`<n>\\t<line>`). Read only what you need: pass `symbol` to get one function, class or type by name (see `outline` for the names), or `offset`/`limit` for a line range; without them up to 2000 lines are returned. Reading the same unchanged range again returns a short note instead of the content - your earlier result is still valid. PNG/JPEG/GIF/WebP images are returned as images. Several reads can be issued in one turn and run in parallel.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory." },
        symbol: { type: "string", description: "Name of a function, class, method or type to read instead of a line range." },
        offset: { type: "integer", description: "1-based line number to start from." },
        limit: { type: "integer", description: "Maximum number of lines to return." },
        refresh: { type: "boolean", description: "Return the content even if this unchanged range was already read." },
      },
      required: ["path"],
    },
  },
  summarize: (i, ctx) =>
    displayPath(ctx, String(i.path ?? "")) +
    (i.symbol ? c.dim(` › ${i.symbol}`) : i.offset ? c.dim(` :${i.offset}${i.limit ? `-${i.offset + i.limit - 1}` : ""}`) : ""),
  async run(input, ctx) {
    const file = resolvePath(ctx, input.path);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return { content: `File not found: ${file}`, isError: true };
    }
    if (stat.isDirectory()) return { content: `${file} is a directory. Use glob or outline to see what is in it.`, isError: true };

    const ext = path.extname(file).toLowerCase();
    const media = IMAGE_TYPES[ext];
    if (media) {
      if (stat.size > 5 * 1024 * 1024) return { content: `Image is too large to read (${stat.size} bytes).`, isError: true };
      const data = (await fs.readFile(file)).toString("base64");
      return {
        content: [{ type: "image", source: { type: "base64", media_type: media, data } }],
        display: [c.dim(`image, ${Math.round(stat.size / 1024)} KB`)],
      };
    }
    if (stat.size > MAX_READ_BYTES)
      return { content: `File is ${stat.size} bytes, too large to read whole. Use grep or outline, then read a range.`, isError: true };

    // Context layer: an unchanged range that is already in the conversation is not sent again.
    const rangeKey = `${file}|${input.symbol ?? ""}|${input.offset ?? ""}|${input.limit ?? ""}`;
    if (!input.refresh && ctx.readSeen.get(rangeKey) === stat.mtimeMs) {
      return {
        content: `Unchanged since you last read it: this exact range of ${file} is already in the conversation above and is still current. (Pass refresh=true if you really need it repeated.)`,
        display: [c.dim("unchanged, not re-sent")],
      };
    }

    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8192).includes(0)) return { content: `${file} looks like a binary file (${stat.size} bytes).`, isError: true };

    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    let start = Math.max(1, Number(input.offset) || 1);
    let limit = Math.max(1, Number(input.limit) || MAX_LINES);
    let note = "";

    if (input.symbol) {
      const symbols = findSymbols(text, file);
      const wanted = String(input.symbol);
      const hits = symbols.map((s, i) => ({ s, i })).filter(({ s }) => s.name === wanted || s.name.endsWith("." + wanted));
      if (!hits.length) {
        const names = [...new Set(symbols.map((s) => s.name))].slice(0, 40).join(", ");
        return { content: `No declaration named \`${wanted}\` in ${file}.${names ? ` Declarations found: ${names}.` : " Use grep to locate it."}`, isError: true };
      }
      const range = symbolRange(symbols, hits[0].i, lines.length, lines);
      start = range.start;
      limit = Math.min(MAX_LINES, range.end - range.start + 1);
      if (hits.length > 1) note = `\n\n[${hits.length} declarations are named \`${wanted}\`; showing the first. Others start at line ${hits.slice(1).map((h) => h.s.line).join(", ")}.]`;
    }

    const slice = lines.slice(start - 1, start - 1 + limit);
    ctx.fileState.set(file, stat.mtimeMs);
    ctx.readSeen.set(rangeKey, stat.mtimeMs);

    if (slice.length === 0) {
      return { content: lines.length === 0 ? "(file is empty)" : `(no lines at offset ${start}; file has ${lines.length} lines)` };
    }
    let out = slice
      .map((l, i) => `${start + i}\t${l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + " [line truncated]" : l}`)
      .join("\n");
    const end = start - 1 + slice.length;
    if (!input.symbol && end < lines.length) out += `\n\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
    return { content: out + note, display: [c.dim(input.symbol ? `lines ${start}-${end}` : `${slice.length} lines`)] };
  },
};

/** A stale-write guard: the model must have seen the current version of an existing file. */
async function staleError(ctx: ToolContext, file: string, unreadOk = false): Promise<string | null> {
  const current = await mtime(file);
  if (current === null) return null; // new file
  const seen = ctx.fileState.get(file);
  // An edit must match the file's current text exactly once, which already proves the model
  // knows it (for example from grep or cat); demanding a read first only costs a round trip.
  if (seen === undefined && unreadOk) return null;
  if (seen === undefined) return `Read ${file} first: it exists and has not been read in this session.`;
  if (current > seen + 1) return `${file} changed on disk since it was last read. Read it again before modifying it.`;
  return null;
}

/** Changed lines between two texts (common prefix and suffix removed). */
function changedLines(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { removed: a.slice(pre, a.length - suf), added: b.slice(pre, b.length - suf) };
}

function diffDisplay(oldText: string, newText: string, max = 24): string[] {
  const { removed, added } = changedLines(oldText, newText);
  // Both sides start at the same line: everything before the change is identical.
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let first = 0;
  while (first < a.length && first < b.length && a[first] === b[first]) first++;
  const no = (i: number) => c.dim(String(first + i + 1).padStart(4) + " ");
  const out = [...removed.map((l, i) => no(i) + c.red("- " + l)), ...added.map((l, i) => no(i) + c.green("+ " + l))];
  if (out.length > max) {
    const extra = out.length - max;
    out.length = max;
    out.push(c.dim(`  … ${extra} more changed lines`));
  }
  return out;
}

/** After a change: record the new mtime and run the fast syntax check. */
async function afterWrite(ctx: ToolContext, file: string): Promise<string> {
  ctx.fileState.set(file, (await mtime(file)) ?? Date.now());
  ctx.changed?.add(file);
  // The content changed: earlier reads of this file are no longer "already in the conversation".
  // (Not left to the timestamp alone - two writes can land within its resolution.)
  for (const key of ctx.readSeen.keys()) if (key.startsWith(file + "|")) ctx.readSeen.delete(key);
  const problems = await syntaxCheck(file);
  return problems ? `\n\nSyntax check of ${path.basename(file)} found a problem - fix it before going on:\n${problems}` : "";
}

export const writeTool: Tool = {
  kind: "edit",
  spec: {
    name: "write",
    description:
      "Create a new file, or replace the whole contents of a small one. Parent directories are created. To change an existing file use `edit` or `multi_edit`: they send only the changed lines. Rewriting an existing file of more than 200 lines is refused unless `overwrite` is true - set it only when nearly every line really changes. An existing file must have been read first.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory." },
        content: { type: "string", description: "Complete new file contents." },
        overwrite: { type: "boolean", description: "Allow replacing an existing file of more than 200 lines." },
      },
      required: ["path", "content"],
    },
  },
  summarize: (i, ctx) => displayPath(ctx, String(i.path ?? "")),
  async run(input, ctx) {
    const file = resolvePath(ctx, input.path);
    const stale = await staleError(ctx, file);
    if (stale) return { content: stale, isError: true };
    let previous: string | null = null;
    try {
      previous = await fs.readFile(file, "utf8");
    } catch {
      /* new file */
    }
    const content = String(input.content);
    if (previous !== null && !input.overwrite && previous.split("\n").length > REWRITE_GUARD_LINES) {
      return {
        content: `${file} has ${previous.split("\n").length} lines. Change it with edit or multi_edit so only the lines that change are written. If nearly every line really changes, call write again with overwrite=true.`,
        isError: true,
      };
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    const problems = (await afterWrite(ctx, file)) + (await typeProblems(ctx, [file])) + (await lintProblems(ctx, [file])) + formatNotes(editNotes(file, previous, content));
    const n = content.replace(/\n$/, "").split("\n").length;
    if (previous === null) {
      return { content: `Created ${file} (${n} lines).${problems}`, display: [c.dim(`created, ${n} lines`), ...(problems ? [/Noticed in this edit/.test(problems) && !/Syntax check|Type errors|linter reports/.test(problems) ? c.yellow("note for the model") : c.red("problem found")] : [])] };
    }
    const { removed, added } = changedLines(previous.replace(/\r/g, ""), content.replace(/\r/g, ""));
    return {
      content: `Overwrote ${file} (${n} lines, +${added.length}/-${removed.length}).${problems}`,
      display: [c.dim(`overwrote, +${added.length}/-${removed.length} lines`), ...(problems ? [c.red("syntax problem found")] : [])],
    };
  },
};

interface EditSpec {
  /** Replace the whole declaration with this name instead of matching old_string. */
  symbol?: string;
  old_string?: string;
  new_string: string;
  replace_all?: boolean;
}

type EditResult = { text: string; count: number; line: number; fuzzy: boolean } | { error: string };

/**
 * Apply one replacement to a text. Exact match first; if that fails, a match
 * that differs only in indentation or trailing whitespace is accepted when it
 * is unambiguous, and the replacement is re-indented to fit the file.
 */
export function applyEdit(original: string, spec: EditSpec, file: string): EditResult {
  if (spec.symbol) return replaceSymbol(original, String(spec.symbol), String(spec.new_string), file);
  if (typeof spec.old_string !== "string") return { error: "Give old_string (the exact text to replace) or symbol (the name of a declaration to replace whole)." };
  let oldStr = String(spec.old_string);
  let newStr = String(spec.new_string);
  if (oldStr === newStr) return { error: "old_string and new_string are identical; nothing to change." };
  if (oldStr === "") return { error: "old_string is empty. Use write to create a file." };

  // The model writes "\n"; match files that use CRLF without changing their line endings.
  const crlf = original.includes("\r\n");
  if (crlf) {
    oldStr = oldStr.replace(/\r?\n/g, "\r\n");
    newStr = newStr.replace(/\r?\n/g, "\r\n");
  }

  const count = original.split(oldStr).length - 1;
  if (count > 1 && !spec.replace_all)
    return { error: `old_string occurs ${count} times in ${file}. Add surrounding lines to make it unique, or set replace_all to true.` };
  if (count >= 1) {
    const line = original.slice(0, original.indexOf(oldStr)).split("\n").length;
    const text = spec.replace_all ? original.split(oldStr).join(newStr) : original.replace(oldStr, () => newStr);
    return { text, count: spec.replace_all ? count : 1, line, fuzzy: false };
  }

  // Whitespace-tolerant match on whole lines.
  const eol = crlf ? "\r\n" : "\n";
  const fileLines = original.split(eol);
  const oldLines = oldStr.split(eol);
  while (oldLines.length > 1 && oldLines[oldLines.length - 1].trim() === "") oldLines.pop();
  while (oldLines.length > 1 && oldLines[0].trim() === "") oldLines.shift();
  const wanted = oldLines.map((l) => l.trim());
  const starts: number[] = [];
  for (let i = 0; i + wanted.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < wanted.length; k++) {
      if (fileLines[i + k].trim() !== wanted[k]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  if (starts.length === 1 && wanted.some((l) => l.length > 0)) {
    const at = starts[0];
    // Re-indent the replacement by the difference between the file's and the model's indentation.
    const ref = oldLines.findIndex((l) => l.trim());
    const fileIndent = /^\s*/.exec(fileLines[at + ref])![0];
    const oldIndent = /^\s*/.exec(oldLines[ref])![0];
    const newLines = newStr.split(eol);
    while (newLines.length > 1 && newLines[newLines.length - 1].trim() === "" && oldStr.split(eol).length > oldLines.length) newLines.pop();
    const adjusted = newLines.map((l) => {
      if (!l.trim()) return l;
      if (l.startsWith(oldIndent)) return fileIndent + l.slice(oldIndent.length);
      return l;
    });
    const text = [...fileLines.slice(0, at), ...adjusted, ...fileLines.slice(at + wanted.length)].join(eol);
    return { text, count: 1, line: at + 1, fuzzy: true };
  }
  if (starts.length > 1)
    return { error: `old_string matches ${starts.length} places in ${file} when whitespace is ignored (lines ${starts.map((s) => s + 1).join(", ")}). Add surrounding lines to make it unique.` };

  const first = wanted.find((l) => l.length > 0) ?? "";
  const near = first ? fileLines.findIndex((l) => l.trim() === first) : -1;
  return {
    error:
      `old_string was not found in ${file}.` +
      (near >= 0
        ? ` Its first line does occur at line ${near + 1}, so a later line differs. Read lines ${Math.max(1, near + 1)}-${near + wanted.length + 2} and copy them exactly.`
        : " Read the file again: its content differs from what you expect."),
  };
}

/** Replace one whole declaration (function, class, method, type ...) found by name. */
function replaceSymbol(original: string, name: string, replacement: string, file: string): EditResult {
  if (!supportsOutline(file)) return { error: `Replacing by symbol is not available for this file type. Use old_string for ${file}.` };
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const symbols = findSymbols(original, file);
  const matches = symbols.map((s, i) => ({ s, i })).filter(({ s }) => s.name === name);
  if (!matches.length) {
    const names = [...new Set(symbols.map((s) => s.name))];
    return { error: `No declaration named \`${name}\` in ${file}. Declarations there: ${names.slice(0, 40).join(", ") || "none found"}.` };
  }
  if (matches.length > 1) {
    return { error: `\`${name}\` is declared ${matches.length} times in ${file} (lines ${matches.map(({ s }) => s.line).join(", ")}). Use old_string with a few exact lines to pick one.` };
  }
  const { s, i } = matches[0];
  const { start, end } = symbolRange(symbols, i, lines.length, lines);
  const fresh = replacement.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  // Fit the replacement to the indentation the declaration has in the file.
  const given = /^\s*/.exec(fresh.find((l) => l.trim()) ?? "")![0];
  const wanted = " ".repeat(s.indent);
  const indentChar = /^\t/.test(lines[start - 1]) ? lines[start - 1].slice(0, lines[start - 1].length - lines[start - 1].trimStart().length) : wanted;
  const fitted = given === indentChar ? fresh : fresh.map((l) => (l.trim() ? indentChar + (l.startsWith(given) ? l.slice(given.length) : l.trimStart()) : l));
  if (fitted.join("\n") === lines.slice(start - 1, end).join("\n")) return { error: `The new text for \`${name}\` is identical to what is there; nothing to change.` };
  const text = [...lines.slice(0, start - 1), ...fitted, ...lines.slice(end)].join(eol);
  return { text, count: 1, line: start, fuzzy: false };
}

function editSummary(file: string, r: { count: number; line: number; fuzzy: boolean }, before: string, after: string): string {
  const { removed, added } = changedLines(before.replace(/\r/g, ""), after.replace(/\r/g, ""));
  return `${file}: ${r.count > 1 ? `${r.count} occurrences` : `line ${r.line}`}, +${added.length}/-${removed.length} lines${r.fuzzy ? " (matched ignoring indentation; the replacement was re-indented to fit)" : ""}`;
}

export const editTool: Tool = {
  kind: "edit",
  spec: {
    name: "edit",
    description:
      "Change a file in one of two ways. (1) Replace one exact string: give `old_string`, as small as will identify the place uniquely - a few lines, not the whole function; it must be unique unless `replace_all` is true, and must not include the line-number prefix from `read` output. (2) Replace a whole declaration by name: give `symbol` (a function, class, method, type or constant) and the complete new declaration as `new_string`, without quoting the old text; use this when most of a function changes. In a TypeScript project the result reports type errors the edit caused, in this file and in others. For several changes, in one file or across files, use `multi_edit`.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory." },
        old_string: { type: "string", description: "Exact text to replace." },
        symbol: { type: "string", description: "Instead of old_string: name of the declaration to replace whole." },
        new_string: { type: "string", description: "Replacement text (must differ from what it replaces)." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of exactly one." },
      },
      required: ["path", "new_string"],
    },
  },
  summarize: (i, ctx) => displayPath(ctx, String(i.path ?? "")),
  async run(input, ctx) {
    return runEdits(ctx, [{ path: String(input.path), old_string: input.old_string, symbol: input.symbol, new_string: input.new_string, replace_all: !!input.replace_all }]);
  },
};

export const multiEditTool: Tool = {
  kind: "edit",
  spec: {
    name: "multi_edit",
    description:
      "Apply several replacements in one call, in one file or across several files (each one by `old_string` or by `symbol`, as in `edit`). All of them are applied or none: if any replacement does not match, nothing is written and you are told which one failed. Edits to the same file apply in the order given, each on the result of the previous one. Prefer this over a series of `edit` calls for a change that touches several places (a rename, a changed signature and its callers). Each file must have been read first.",
    input_schema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              old_string: { type: "string" },
              symbol: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["path", "new_string"],
          },
        },
      },
      required: ["edits"],
    },
  },
  summarize: (i, ctx) => {
    const edits: { path?: string }[] = Array.isArray(i.edits) ? i.edits : [];
    const files = [...new Set(edits.map((e) => displayPath(ctx, String(e.path ?? ""))))];
    return files.length === 1 ? `${files[0]} ${c.dim(`(${edits.length} edits)`)}` : `${edits.length} edits in ${files.length} files`;
  },
  async run(input, ctx) {
    const edits = (Array.isArray(input.edits) ? input.edits : []).filter((e: unknown) => e && typeof e === "object");
    if (!edits.length) return { content: "`edits` is empty.", isError: true };
    for (const [i, e] of edits.entries()) {
      if (typeof e.path !== "string" || typeof e.new_string !== "string" || (typeof e.old_string !== "string" && typeof e.symbol !== "string"))
        return { content: `Edit ${i + 1} needs string values for path, new_string, and old_string or symbol.`, isError: true };
    }
    return runEdits(ctx, edits);
  },
};

/** Shared engine: compute every edit in memory, write only if all of them succeed. */
async function runEdits(ctx: ToolContext, edits: (EditSpec & { path: string })[]): Promise<ToolOutput> {
  const originals = new Map<string, string>();
  const current = new Map<string, string>();
  const summaries: string[] = [];
  const display: string[] = [];

  for (const [i, e] of edits.entries()) {
    const file = resolvePath(ctx, e.path);
    const label = edits.length > 1 ? `Edit ${i + 1} of ${edits.length} failed, so nothing was written. ` : "";
    if (!current.has(file)) {
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        return { content: `${label}File not found: ${file}. Use write to create it.`, isError: true };
      }
      const stale = await staleError(ctx, file, true);
      if (stale) return { content: label + stale, isError: true };
      originals.set(file, text);
      current.set(file, text);
    }
    const before = current.get(file)!;
    const r = applyEdit(before, e, file);
    if ("error" in r) return { content: label + r.error, isError: true };
    current.set(file, r.text);
    summaries.push(editSummary(file, r, before, r.text));
    if (edits.length > 1) display.push(c.dim(`${displayPath(ctx, file)}:${r.line}`));
    display.push(...diffDisplay(before.replace(/\r/g, ""), r.text.replace(/\r/g, ""), edits.length > 1 ? 8 : 24));
  }

  let problems = "";
  for (const [file, text] of current) {
    await fs.writeFile(file, text, "utf8");
    problems += await afterWrite(ctx, file);
  }
  problems += await typeProblems(ctx, [...current.keys()]);
  problems += await lintProblems(ctx, [...current.keys()]);
  problems += formatNotes([...current].flatMap(([file, text]) => editNotes(file, originals.get(file) ?? null, text)).slice(0, 5));
  if (problems) display.push(/Type errors|broke other files/.test(problems) ? c.red("type errors found") : /Syntax check|linter reports/.test(problems) ? c.red("problem found") : c.yellow("note for the model"));
  return { content: `Edited ${summaries.join("\n")}${problems}`, display: display.slice(0, 40) };
}

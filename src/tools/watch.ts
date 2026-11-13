// Feedback while the code is being written, in any language.
//
// Two layers, both attached to the result of the edit that caused them:
//  - editNotes: free, instant, textual. Looks only at the lines an edit added,
//    for the things that are wrong in every language: placeholders left in,
//    debug statements, swallowed errors, pasted duplicates, runaway functions.
//  - lintProblems: the project's own linter on the changed file, when the
//    project has one set up.
// (The third layer, a small model that reads the changes, lives in the agent.)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ToolContext } from "./types.ts";

const DEBUG_STATEMENTS: [RegExp, string][] = [
  [/^\s*debugger\s*;?\s*$/, "a `debugger` statement"],
  [/\bconsole\.(log|debug|trace)\s*\(/, "console.log output"],
  [/\bdbg!\s*\(/, "a dbg! call"],
  [/\b(binding\.pry|byebug)\b/, "a debugger breakpoint"],
  [/\b(pdb|ipdb)\.set_trace\s*\(|\bbreakpoint\s*\(\s*\)/, "a debugger breakpoint"],
  [/\bvar_dump\s*\(|\bdd\s*\(/, "a debug dump"],
];
const PLACEHOLDER = /\b(TODO|FIXME|XXX)\b|not implemented|implement (this|me|later)|your code here|\.\.\. ?rest of|rest of the (code|file|function)|(existing|previous|remaining) code (here|unchanged|stays)|unchanged for brevity/i;
const EMPTY_HANDLER = /catch\s*(\([^)]*\))?\s*\{\s*\}|except[^:\n]*:\s*pass\b|rescue\s*(=>\s*\w+)?\s*;?\s*end\b/;
const FUNCTION_START = /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:function\b|def\s|fn\s|func\s)|^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{\s*$/;
const LONG_FUNCTION_LINES = 90;
const DUPLICATE_BLOCK_LINES = 7;

/** Lines of `now` that were not in `old`, with their 1-based numbers. */
function addedLines(old: string | null, now: string): { line: number; text: string }[] {
  const b = now.split(/\r?\n/);
  if (old === null) return b.map((text, i) => ({ line: i + 1, text }));
  const seen = new Map<string, number>();
  for (const l of old.split(/\r?\n/)) seen.set(l, (seen.get(l) ?? 0) + 1);
  const out: { line: number; text: string }[] = [];
  b.forEach((text, i) => {
    const n = seen.get(text) ?? 0;
    if (n > 0) seen.set(text, n - 1);
    else out.push({ line: i + 1, text });
  });
  return out;
}

/** Things wrong in any language, found in what this edit added. Empty when there is nothing to say. */
export function editNotes(file: string, old: string | null, now: string): string[] {
  const name = path.basename(file);
  if (/\.(md|txt|json|ya?ml|toml|lock|svg|csv|html?)$/i.test(name) || now.length > 400_000) return [];
  const notes: string[] = [];
  const added = addedLines(old, now);
  if (!added.length) return [];
  const isTest = /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/i.test(file.split(path.sep).join("/"));

  if (/^(<{7}|={7}|>{7})( |$)/m.test(now)) notes.push(`${name} contains merge-conflict markers.`);

  const placeholder = added.find((l) => PLACEHOLDER.test(l.text));
  if (placeholder) notes.push(`${name}:${placeholder.line} looks like a placeholder ("${placeholder.text.trim().slice(0, 70)}"). Write the real code, or say plainly that this part is not done.`);

  if (!isTest) {
    for (const [re, what] of DEBUG_STATEMENTS) {
      const hit = added.find((l) => re.test(l.text));
      // A file that already printed this way before the edit does so on purpose (a CLI, a logger).
      if (hit && !(old && old.split(/\r?\n/).some((l) => re.test(l)))) {
        notes.push(`${name}:${hit.line} adds ${what}. Remove it before you finish, unless it is intended output.`);
        break;
      }
    }
  }

  const swallowed = added.find((l) => EMPTY_HANDLER.test(l.text));
  if (swallowed) notes.push(`${name}:${swallowed.line} swallows an error silently. Handle it, or say in a comment why ignoring it is right.`);

  // A block of several lines pasted twice: usually a function waiting to be extracted.
  const lines = now.split(/\r?\n/);
  const addedSet = new Set(added.map((l) => l.line));
  const starts = new Map<string, number>();
  for (let i = 0; i + DUPLICATE_BLOCK_LINES <= lines.length; i++) {
    const block = lines.slice(i, i + DUPLICATE_BLOCK_LINES).map((l) => l.trim());
    if (block.filter((l) => l.length > 12).length < DUPLICATE_BLOCK_LINES - 1) continue; // braces and blanks repeat by nature
    const key = block.join("\n");
    const first = starts.get(key);
    if (first === undefined) starts.set(key, i);
    else if (i - first >= DUPLICATE_BLOCK_LINES && (addedSet.has(i + 1) || addedSet.has(first + 1))) {
      notes.push(`${name}: lines ${first + 1}-${first + DUPLICATE_BLOCK_LINES} are repeated at line ${i + 1}. If that is the same logic twice, put it in one place.`);
      break;
    }
  }

  // A function this edit made very long.
  for (let i = 0; i < lines.length; i++) {
    if (!FUNCTION_START.test(lines[i])) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].length - lines[end].trimStart().length > indent || /^\s*[}\])]/.test(lines[end]))) {
      if (lines[end].trim() && lines[end].length - lines[end].trimStart().length <= indent && /^\s*[}\])]/.test(lines[end])) {
        end++;
        break;
      }
      end++;
    }
    const length = end - i;
    if (length > LONG_FUNCTION_LINES && added.filter((l) => l.line > i && l.line <= end).length > length / 3) {
      notes.push(`${name}:${i + 1} is a function of ${length} lines. Consider splitting it where it does separate jobs.`);
      break;
    }
    i = end - 1;
  }
  return notes.slice(0, 4);
}

interface Linter {
  name: string;
  /** Files it understands. */
  files: RegExp;
  available(cwd: string): boolean;
  command(cwd: string, rel: string): string;
  parse(output: string, rel: string): string[];
}

const binPath = (cwd: string, name: string) => path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
const hasAny = (cwd: string, names: string[]) => names.some((n) => fs.existsSync(path.join(cwd, n)));

const LINTERS: Linter[] = [
  {
    name: "eslint",
    files: /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/,
    available: (cwd) => fs.existsSync(binPath(cwd, "eslint")) && hasAny(cwd, ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml"]),
    command: (cwd, rel) => `"${binPath(cwd, "eslint")}" --format unix --no-warn-ignored "${rel}"`,
    // unix format: path:line:col: message [Error/rule]
    parse: (output) => output.split(/\r?\n/).map((l) => /^.+?:(\d+):\d+: (.+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m && /\[Error/.test(m[2])).map((m) => `line ${m[1]}: ${m[2]}`),
  },
  {
    name: "ruff",
    files: /\.py$/,
    available: (cwd) => hasAny(cwd, ["ruff.toml", ".ruff.toml"]) || (fs.existsSync(path.join(cwd, "pyproject.toml")) && /\[tool\.ruff/.test(fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf8"))),
    command: (_cwd, rel) => `ruff check --output-format concise --quiet "${rel}"`,
    parse: (output) => output.split(/\r?\n/).map((l) => /^.+?:(\d+):\d+: (.+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => `line ${m[1]}: ${m[2]}`),
  },
];

function run(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<{ output: string; timedOut: boolean; missing: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
    const stop = () => child.kill();
    const timer = setTimeout(() => ((timedOut = true), stop()), timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ output, timedOut, missing: code === 127 || code === 9009 || /not recognized|command not found/i.test(output) });
    };
    child.on("error", () => done(127));
    child.on("close", done);
  });
}

/** The project's linter on the files just written; errors only, and only if the project set a linter up. */
export async function lintProblems(ctx: ToolContext, files: string[]): Promise<string> {
  const off = (ctx.lintOff ??= new Set<string>());
  const parts: string[] = [];
  for (const file of files.slice(0, 6)) {
    const linter = LINTERS.find((l) => l.files.test(file) && !off.has(l.name));
    if (!linter) continue;
    let ok = false;
    try {
      ok = linter.available(ctx.cwd);
    } catch {
      /* unreadable config */
    }
    if (!ok) continue;
    const rel = path.relative(ctx.cwd, file).split(path.sep).join("/");
    if (rel.startsWith("..")) continue;
    const res = await run(linter.command(ctx.cwd, rel), ctx.cwd, ctx.signal, 8000);
    if (ctx.signal.aborted) return "";
    if (res.timedOut || res.missing) {
      off.add(linter.name); // too slow or not installed: do not try again this session
      continue;
    }
    const problems = linter.parse(res.output, rel);
    if (problems.length) parts.push(`${linter.name} on ${rel}:\n${problems.slice(0, 8).map((p) => `  ${p}`).join("\n")}${problems.length > 8 ? `\n  … ${problems.length - 8} more` : ""}`);
  }
  return parts.length ? `\n\nThe project's linter reports errors in what you just wrote - fix them before going on:\n${parts.join("\n")}` : "";
}

export function formatNotes(notes: string[]): string {
  return notes.length ? `\n\nNoticed in this edit (automatic; act on what applies):\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
}

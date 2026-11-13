// Type errors right after an edit.
//
// A syntax check catches a missing brace; it does not catch the caller that
// no longer compiles because a signature changed. In a TypeScript project the
// project's own compiler runs after every edit of a TypeScript file, and the
// errors that edit caused come back in the edit's result - one round trip
// earlier than a test run would show them.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ToolContext } from "./types.ts";

const TS_FILE = /\.(ts|tsx|mts|cts)$/;
const TIMEOUT_MS = 20_000;
/** A compiler slower than this per edit costs more than it saves; it is turned off for the session. */
const TOO_SLOW_MS = 12_000;

interface Problem {
  file: string;
  line: number;
  code: string;
  message: string;
}

function runCompiler(cwd: string, signal: AbortSignal): Promise<{ output: string; ms: number; timedOut: boolean }> {
  const bin = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(`"${bin}" --noEmit --pretty false -p .`, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
    const stop = () => child.kill();
    const timer = setTimeout(() => ((timedOut = true), stop()), TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ output, ms: Date.now() - started, timedOut });
    };
    child.on("error", done);
    child.on("close", done);
  });
}

export function parseCompilerOutput(output: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line.trim());
    if (m) problems.push({ file: m[1].split(path.sep).join("/"), line: Number(m[2]), code: m[3], message: m[4].slice(0, 240) });
  }
  return problems;
}

/** Whether this project can be type-checked after edits. */
export function canTypeCheck(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "tsconfig.json")) && fs.existsSync(path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"));
}

/**
 * Type-check the project after `files` were written. Returns text to append to
 * the edit's result: the errors in the edited files, and errors elsewhere that
 * were not there at the previous check. Empty when there is nothing to say.
 */
export async function typeProblems(ctx: ToolContext, files: string[]): Promise<string> {
  const diag = ctx.diag;
  if (!diag || diag.off || !files.some((f) => TS_FILE.test(f)) || !canTypeCheck(ctx.cwd)) return "";
  const { output, ms, timedOut } = await runCompiler(ctx.cwd, ctx.signal);
  if (ctx.signal.aborted) return "";
  if (timedOut || ms > TOO_SLOW_MS) {
    diag.off = true;
    return timedOut ? "" : "\n\n(The type check after edits took too long and is off for this session; run the check tool when you want one.)";
  }
  const problems = parseCompilerOutput(output);
  const edited = new Set(files.map((f) => path.relative(ctx.cwd, f).split(path.sep).join("/")));
  // Line numbers shift with every edit, so an error is recognised by file, code and message.
  const key = (p: Problem) => `${p.file}|${p.code}|${p.message}`;
  const first = diag.known === null;
  const known = diag.known ?? new Set<string>();
  const here = problems.filter((p) => edited.has(p.file));
  const elsewhere = problems.filter((p) => !edited.has(p.file) && !known.has(key(p)));
  diag.known = new Set(problems.map(key));
  if (!here.length && !elsewhere.length) return "";
  const show = (list: Problem[], max: number) => list.slice(0, max).map((p) => `  ${p.file}:${p.line} ${p.code} ${p.message}`).join("\n") + (list.length > max ? `\n  … ${list.length - max} more` : "");
  const parts: string[] = [];
  if (here.length) parts.push(`Type errors in what you just edited - fix them before going on:\n${show(here, 10)}`);
  if (elsewhere.length) {
    parts.push(
      first
        ? `Type errors in other files (this is the first check of the session, so they may have been there before your edit):\n${show(elsewhere, 5)}`
        : `Your edit broke other files - these errors were not there before it:\n${show(elsewhere, 8)}`,
    );
  }
  return "\n\n" + parts.join("\n\n");
}

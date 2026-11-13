// Independent review before "done".
//
// The model that wrote a change is a poor judge of it: it reads what it meant
// to write. So when a request changed more than a few lines, a second run with
// an empty context gets only the request and the changes, looks for defects
// that would block a merge, and its findings go back to the author once.

import fs from "node:fs";
import path from "node:path";

/** Changes smaller than this are not worth a review's cost. */
export const REVIEW_MIN_LINES = 8;
const MAX_CHANGES_CHARS = 60_000;

export interface Changes {
  text: string;
  files: number;
  lines: number;
}

const clipLines = (lines: string[], max: number) => (lines.length <= max ? lines : [...lines.slice(0, max), `  … ${lines.length - max} more lines (read the file)`]);

/** Describe what changed, given each touched file's content before the request (null = it did not exist). */
export function renderChanges(before: Map<string, string | null>, cwd: string): Changes {
  const parts: string[] = [];
  let files = 0;
  let lines = 0;
  for (const [file, old] of before) {
    let now: string | null = null;
    try {
      now = fs.readFileSync(file, "utf8");
    } catch {
      /* deleted */
    }
    if (now === old) continue;
    files++;
    const rel = path.relative(cwd, file).split(path.sep).join("/");
    if (now === null) {
      parts.push(`### ${rel} (deleted)`);
      continue;
    }
    const b = now.split("\n");
    if (old === null) {
      lines += b.length;
      parts.push(`### ${rel} (new file, ${b.length} lines)\n${clipLines(b.map((l, i) => `+${String(i + 1).padStart(4)} ${l}`), 400).join("\n")}`);
      continue;
    }
    const a = old.split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
    lines += endA - start + (endB - start);
    const context = (from: number, to: number) => b.slice(Math.max(0, from), Math.min(b.length, to)).map((l, i) => ` ${String(Math.max(0, from) + i + 1).padStart(4)} ${l}`);
    parts.push(
      [
        `### ${rel} (changed region: lines ${start + 1}-${endB} of the new file)`,
        ...context(start - 3, start),
        ...clipLines(a.slice(start, endA).map((l) => `-     ${l}`), 200),
        ...clipLines(b.slice(start, endB).map((l, i) => `+${String(start + i + 1).padStart(4)} ${l}`), 300),
        ...context(endB, endB + 3),
      ].join("\n"),
    );
  }
  let text = parts.join("\n\n");
  if (text.length > MAX_CHANGES_CHARS) text = text.slice(0, MAX_CHANGES_CHARS) + "\n… (cut; read the files for the rest)";
  return { text, files, lines };
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  kind: "new" | "changed" | "deleted";
}

/** Per file: how many lines a request added and removed. */
export function changeStats(before: Map<string, string | null>, cwd: string): FileChange[] {
  const out: FileChange[] = [];
  for (const [file, old] of before) {
    let now: string | null = null;
    try {
      now = fs.readFileSync(file, "utf8");
    } catch {
      /* deleted */
    }
    if (now === old) continue;
    const rel = path.relative(cwd, file).split(path.sep).join("/");
    // A final line break ends the last line; it is not one more line.
    const split = (text: string | null) => (text ? text.replace(/\n$/, "").split("\n") : []);
    const a = split(old);
    const b = split(now);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
    out.push({ path: rel, added: endB - start, removed: endA - start, kind: old === null ? "new" : now === null ? "deleted" : "changed" });
  }
  return out;
}

export const REVIEW_SYSTEM = `You are an independent code reviewer inside Forge, a coding agent. Another agent just finished a request and believes it is done. You see the request and the changes it made, nothing else of its work. The author will read only your final message; the user does not see it.

Your job is to find what would make a strict senior engineer refuse to merge this. You have read-only tools: read, grep, glob, outline, deps, and bash for running the code or its tests. Read the changed files and what they touch. When you suspect a defect, confirm it - run a small snippet or the tests - rather than guessing. Do not change any file.

Check, in this order:
1. The request, requirement by requirement: is each one actually met? Name any that is missing or only partly done.
2. Wrong results: bugs, unhandled edge cases (empty, zero, negative, very large, boundary values), broken callers of anything whose behaviour or signature changed.
3. Safety: input from outside reaching host objects, files or commands; silently accepting input of the wrong type where that gives a wrong answer.
4. Proof: changed behaviour without a test; a fix without a test that would have caught it; a refactor or optimisation that "must not change behaviour" with nothing comparing old and new.
5. Leftovers: comments or docs the change made untrue, debug output, files or changes the request did not ask for.
6. Clarity, only where it is clearly poor: cryptic names, one file doing several separate jobs.

Report only what matters. No praise, no style preferences, no speculation you did not check. At most six findings, the most serious first.

Your final message must start with exactly one of these lines:
VERDICT: PASS
VERDICT: FIX

After "VERDICT: PASS" add nothing. After "VERDICT: FIX" list the findings, each as:
N. path:line - what is wrong; the concrete input or situation in which it fails; the fix in one sentence.`;

export function reviewPrompt(request: string, changes: Changes, cwd: string): string {
  return `Working directory: ${cwd}

## The request the author received

${request}

## What the author changed (${changes.files} file${changes.files === 1 ? "" : "s"}; "-" lines were removed, "+" lines are new and carry their line number)

${changes.text}

Review these changes as described. Start your final message with the verdict line.`;
}

/** The reviewer's findings, or null when it passed the change (or said nothing usable). */
export function parseVerdict(report: string): string | null {
  const m = /VERDICT:\s*(PASS|FIX)\s*/.exec(report);
  if (!m || m[1] === "PASS") return null;
  const findings = report.slice(m.index + m[0].length).trim();
  return findings || null;
}

export function reviewFeedback(findings: string): string {
  return `[Independent review by Forge - not a message from the user]\nA reviewer with a fresh context read the request and your changes and reports the points below. Check each one against the code. Fix the ones that are real, including missing tests. For any you do not act on, say why in one line. Make no changes beyond these points.\n\n${findings}`;
}

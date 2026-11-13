// Preparing a request before the model sees it.
//
// The user's words are never rewritten. Forge adds what it can find out
// faster and more reliably than the model would by spending turns on it:
//  - a picture of the project (first request of a session),
//  - where the files and names the request mentions actually are,
//  - a read of what kind of task this is, from the cheapest model, which
//    decides how much checking the work gets.
// Everything goes into one clearly marked block after the request.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectChecks } from "./tools/check.ts";
import { walk } from "./tools/search.ts";

const LANGUAGES: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".cs": "C#", ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C/C++ headers",
  ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".vue": "Vue", ".svelte": "Svelte", ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".sql": "SQL", ".sh": "Shell",
};
const SOURCE = new Set(Object.keys(LANGUAGES));

export type TaskKind = "question" | "fix" | "feature" | "refactor" | "ui" | "other";
export interface Triage {
  kind: TaskKind;
  size: "small" | "medium" | "large";
  ambiguity: string | null;
}

async function listFiles(cwd: string, signal: AbortSignal, max = 4000): Promise<string[]> {
  const files: string[] = [];
  for await (const rel of walk(cwd, signal)) {
    files.push(rel);
    if (files.length >= max) break;
  }
  return files;
}

const git = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2500, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : "";
};

/** What a newcomer would want to know before touching the project. Plain facts, a few lines. */
export function projectSnapshot(cwd: string, files: string[]): string {
  if (!files.length) return "Project: the working directory is empty.";
  const byLang = new Map<string, number>();
  const top = new Map<string, number>();
  for (const f of files) {
    const lang = LANGUAGES[path.extname(f)];
    if (lang) byLang.set(lang, (byLang.get(lang) ?? 0) + 1);
    const slash = f.indexOf("/");
    const head = slash === -1 ? f : f.slice(0, slash + 1);
    top.set(head, (top.get(head) ?? 0) + 1);
  }
  const langs = [...byLang].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([l, n]) => `${l} (${n})`);
  const dirs = [...top].sort((a, b) => Number(b[0].endsWith("/")) - Number(a[0].endsWith("/")) || b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = dirs.slice(0, 14).map(([name, n]) => (name.endsWith("/") ? `${name} (${n})` : name));
  const lines = [
    `Project: ${files.length}${files.length >= 4000 ? "+" : ""} files${langs.length ? " - " + langs.join(", ") : ""}`,
    `Top level: ${shown.join(", ")}${dirs.length > 14 ? `, … ${dirs.length - 14} more` : ""}`,
  ];
  const checks = detectChecks(cwd);
  lines.push(checks.length ? `Checks the project defines: ${checks.map((ch) => `${ch.kind} \`${ch.command}\``).join(", ")}` : "Checks: none detected (no test, lint or type-check command found)");
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) {
    const status = git(cwd, ["status", "--short"]).split("\n").filter(Boolean);
    lines.push(`Git: branch ${branch}, ${status.length ? `${status.length} uncommitted change${status.length === 1 ? "" : "s"} (${status.slice(0, 6).map((s) => s.trim()).join("; ")}${status.length > 6 ? "; …" : ""})` : "clean working tree"}`);
    const log = git(cwd, ["log", "-3", "--pretty=%s"]);
    if (log) lines.push(`Last commits: ${log.split("\n").map((s) => `"${s.slice(0, 70)}"`).join(", ")}`);
  }
  return lines.join("\n");
}

const DEFINITION = (name: string) =>
  new RegExp(`(?:\\b(?:function|class|const|let|var|def|fn|func|interface|type|struct|enum|trait)\\s+\\*?\\s*${name}\\b)|(?:^\\s*(?:export\\s+)?(?:async\\s+)?${name}\\s*[:=(].*(?:=>|\\{)\\s*$)`);

/** Files and identifiers the request names, resolved to where they are. */
export function locateMentions(request: string, cwd: string, files: string[]): string[] {
  const out: string[] = [];
  const text = request.slice(0, 4000);

  const fileTokens = new Set((text.match(/[\w@./\\-]+\.[A-Za-z]{1,5}\b/g) ?? []).map((t) => t.replace(/\\/g, "/").replace(/^\.\//, "")));
  for (const token of [...fileTokens].slice(0, 8)) {
    const hits = files.filter((f) => f === token || f.endsWith("/" + token));
    if (hits.length === 1) {
      let lines = 0;
      try {
        lines = fs.readFileSync(path.join(cwd, hits[0]), "utf8").split("\n").length;
      } catch {
        continue;
      }
      out.push(`${hits[0]} exists (${lines} lines)`);
    } else if (hits.length > 1) out.push(`"${token}" matches ${hits.length} files: ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ", …" : ""}`);
    else if (token.includes("/")) out.push(`${token} does not exist`);
  }

  // Identifiers: in backticks, called like name(), or shaped like code (camelCase, snake_case).
  const names = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_$][\w$]{2,40})(?:\(\))?`|\b([A-Za-z_$][\w$]{2,40})\(\)|\b([a-z]+[A-Z][\w$]{1,38}|[a-z]+_[a-z_\d]{2,38})\b/g)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name && !fileTokens.has(name)) names.add(name);
  }
  const wanted = [...names].slice(0, 6);
  if (!wanted.length) return out;
  const patterns = wanted.map((n) => [n, DEFINITION(n.replace(/\$/g, "\\$"))] as const);
  const found = new Map<string, string[]>();
  const deadline = Date.now() + 1500;
  let budget = 8_000_000;
  for (const f of files) {
    if (!SOURCE.has(path.extname(f)) || budget <= 0 || Date.now() > deadline) continue;
    let body: string;
    try {
      const stat = fs.statSync(path.join(cwd, f));
      if (stat.size > 300_000) continue;
      body = fs.readFileSync(path.join(cwd, f), "utf8");
    } catch {
      continue;
    }
    budget -= body.length;
    if (!wanted.some((n) => body.includes(n))) continue;
    const lines = body.split("\n");
    for (const [name, re] of patterns) {
      if (!body.includes(name)) continue;
      const at = lines.findIndex((l) => re.test(l));
      if (at >= 0) found.set(name, [...(found.get(name) ?? []), `${f}:${at + 1}`]);
    }
  }
  for (const [name, places] of found) out.push(`\`${name}\` is defined at ${places.slice(0, 4).join(", ")}${places.length > 4 ? `, … ${places.length - 4} more` : ""}`);
  return out;
}

export const TRIAGE_SYSTEM = `You sort requests that a user sends to a coding agent. Reply with one JSON object and nothing else:
{"kind": "...", "size": "...", "ambiguity": null}

kind:
- "question": the user wants an explanation or information; no files should change
- "fix": something is broken or wrong and should be repaired
- "feature": new behaviour or new code is wanted
- "refactor": restructure, rename, clean up or speed up code whose behaviour must stay the same
- "ui": the result is mainly something people look at (page, component, styling, layout)
- "other": anything else (setup, git, running a command, a short follow-up like "yes, do it")

size: "small" (a few lines in one place), "medium" (one feature or several places), "large" (many files, a new module, or open-ended).

ambiguity: null, unless the request can reasonably be read in two ways that would lead to clearly different work and nothing in it settles which. Then one short sentence naming the two readings, in the user's language. Missing detail that a competent developer would simply decide is not ambiguity.`;

export function parseTriage(text: string): Triage | null {
  try {
    const raw = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "");
    const kind = (["question", "fix", "feature", "refactor", "ui", "other"] as const).find((k) => k === raw.kind);
    const size = (["small", "medium", "large"] as const).find((s) => s === raw.size);
    if (!kind || !size) return null;
    return { kind, size, ambiguity: typeof raw.ambiguity === "string" && raw.ambiguity.trim() ? raw.ambiguity.trim().slice(0, 300) : null };
  } catch {
    return null;
  }
}

/** What Forge has learned works for each kind of task: one line the model would otherwise have to think of itself. */
const ADVICE: Record<TaskKind, string> = {
  question: "This reads as a question: answer it from the code. Do not change files unless the user asks for that.",
  fix: "This reads as a fix: reproduce the failure before changing anything, find the cause rather than the symptom, and leave a test that fails without the fix.",
  feature: "This reads as new behaviour: list its requirements as todo items first, then build and test each.",
  refactor: "This reads as a change that must keep behaviour the same: keep the old implementation until you have compared old and new on many inputs.",
  ui: "This reads as visual work: read the frontend-design skill first if you have it, and look at the result with the screenshot tool before you call it done.",
  other: "",
};

export const KIND_LABEL: Record<TaskKind, string> = { question: "question", fix: "fix", feature: "new feature", refactor: "refactor", ui: "interface work", other: "task" };

export function contextBlock(parts: { snapshot?: string; mentions: string[]; triage: Triage | null }): string {
  const sections: string[] = [];
  if (parts.snapshot) sections.push(parts.snapshot);
  if (parts.mentions.length) sections.push(`Named in the request:\n${parts.mentions.map((m) => `- ${m}`).join("\n")}`);
  if (parts.triage) {
    const lines = [ADVICE[parts.triage.kind]];
    if (parts.triage.ambiguity) lines.push(`Possibly ambiguous: ${parts.triage.ambiguity} If the readings lead to different work and the project does not settle it, ask the user one question before changing anything; otherwise choose and say which you chose.`);
    if (lines.some(Boolean)) sections.push(lines.filter(Boolean).join("\n"));
  }
  if (!sections.length) return "";
  return `[Gathered by Forge before you started. The project facts were looked up just now; the last part is Forge's read of the task, a hint that the user's own words override.]\n${sections.join("\n\n")}`;
}

export { listFiles };

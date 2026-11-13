// Feedback loops for code quality:
//  - syntaxCheck: a fast per-file check that runs after every edit, so the
//    model sees a broken file immediately instead of several steps later.
//  - check tool: runs the project's own type checker / linter / tests and
//    returns only what failed, not the whole log.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { c } from "../ui/term.ts";
import { buildGraph, dependents } from "./graph.ts";
import { shellTool } from "./shell.ts";
import type { Tool, ToolContext } from "./types.ts";

function run(file: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(file, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: null, out: "" });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

function findUp(start: string, rel: string): string | null {
  let cur = start;
  for (;;) {
    const candidate = path.join(cur, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

const STRIP_CHECK =
  "const m=require('node:module');const fs=require('fs');if(!m.stripTypeScriptTypes)process.exit(0);" +
  "try{m.stripTypeScriptTypes(fs.readFileSync(process.argv[1],'utf8'),{mode:'transform'})}" +
  "catch(e){console.error(String(e.message).split('\\n').slice(0,6).join('\\n'));process.exit(1)}";

const tsModules = new Map<string, any>();
let pythonCmd: string | null | undefined;

function python(): string | null {
  if (pythonCmd === undefined) {
    pythonCmd = ["python3", "python"].find((p) => spawnSync(p, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0) ?? null;
  }
  return pythonCmd;
}

/**
 * Check one file for syntax errors. Returns a short problem report, or null
 * when the file is fine or its type cannot be checked. Never throws; a check
 * that cannot run is simply skipped.
 */
export async function syntaxCheck(file: string): Promise<string | null> {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === ".json") {
      try {
        JSON.parse(fs.readFileSync(file, "utf8"));
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const r = await run(process.execPath, ["--check", file], path.dirname(file), 5000);
      if (r.code === 0 || r.code === null) return null;
      return r.out.split(/\r?\n/).filter((l) => l.trim() && !/^\s+at |^Node\.js v/.test(l)).slice(0, 6).join("\n");
    }
    if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts" || ext === ".jsx") {
      // Use the project's own TypeScript when it has one; syntax only, so it takes milliseconds.
      const tsPath = findUp(path.dirname(file), path.join("node_modules", "typescript", "lib", "typescript.js"));
      if (!tsPath) {
        // No JavaScript TypeScript compiler in the project (none installed, or the
        // native TypeScript 7): fall back to Node's built-in parser, which handles .ts but not JSX.
        if (ext === ".tsx" || ext === ".jsx") return null;
        const r = await run(process.execPath, ["--no-warnings", "-e", STRIP_CHECK, file], path.dirname(file), 5000);
        return r.code === 1 && r.out.trim() ? r.out.trim() : null;
      }
      let ts = tsModules.get(tsPath);
      if (!ts) {
        const mod = await import(pathToFileURL(tsPath).href);
        ts = mod.default ?? mod;
        tsModules.set(tsPath, ts);
      }
      const result = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext },
      });
      const problems = (result.diagnostics ?? []).slice(0, 6).map((d: any) => {
        const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
        return `${pos ? `line ${pos.line + 1}: ` : ""}${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
      });
      return problems.length ? problems.join("\n") : null;
    }
    if (ext === ".py") {
      const py = python();
      if (!py) return null;
      const r = await run(py, ["-c", "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf8').read(), sys.argv[1])", file], path.dirname(file), 5000);
      if (r.code === 0 || r.code === null) return null;
      return r.out.trim().split(/\r?\n/).slice(-4).join("\n");
    }
  } catch {
    /* the check itself failed; say nothing rather than mislead */
  }
  return null;
}

export interface ProjectCheck {
  kind: "typecheck" | "lint" | "test";
  command: string;
}

/** Work out how this project checks itself, from its own config files. */
export function detectChecks(cwd: string): ProjectCheck[] {
  const checks: ProjectCheck[] = [];
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  if (has("package.json")) {
    let scripts: Record<string, string> = {};
    try {
      scripts = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).scripts ?? {};
    } catch {
      /* unreadable package.json: fall through with no scripts */
    }
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    const script = (name: string) => `${pm} run ${name}`;
    const tc = ["typecheck", "type-check", "check-types", "tsc"].find((s) => scripts[s]);
    if (tc) checks.push({ kind: "typecheck", command: script(tc) });
    else if (has("tsconfig.json") && has("node_modules/typescript")) checks.push({ kind: "typecheck", command: "npx tsc --noEmit" });
    if (scripts.lint) checks.push({ kind: "lint", command: script("lint") });
    if (scripts.test && !/no test specified/.test(scripts.test)) checks.push({ kind: "test", command: pm === "npm" ? "npm test --silent" : `${pm} test` });
  }
  if (has("Cargo.toml")) {
    checks.push({ kind: "typecheck", command: "cargo check --quiet" }, { kind: "test", command: "cargo test --quiet" });
  }
  if (has("go.mod")) {
    checks.push({ kind: "typecheck", command: "go vet ./..." }, { kind: "test", command: "go test ./..." });
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py") || has("requirements.txt")) {
    let pyproject = "";
    try {
      pyproject = fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf8");
    } catch {
      /* no pyproject */
    }
    if (/\[tool\.ruff/.test(pyproject) || has("ruff.toml")) checks.push({ kind: "lint", command: "ruff check ." });
    if (/\[tool\.mypy/.test(pyproject) || has("mypy.ini")) checks.push({ kind: "typecheck", command: "mypy ." });
    if (has("pytest.ini") || /\[tool\.pytest/.test(pyproject) || has("tests")) checks.push({ kind: "test", command: "pytest -q" });
  }
  return checks;
}

const IS_TEST = /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/i;

/**
 * A command that runs only the tests reaching the files changed in this
 * session, or null when that cannot be worked out (unknown runner, nothing
 * changed, no test reaches the changes) and the full test command should run.
 */
export async function affectedTestCommand(ctx: ToolContext): Promise<{ command: string; files: string[] } | null> {
  const changed = [...(ctx.changed ?? [])].map((f) => path.relative(ctx.cwd, f).split(path.sep).join("/")).filter((f) => !f.startsWith(".."));
  if (!changed.length) return null;
  const graph = await buildGraph(ctx.cwd, ctx.signal);
  const tests = new Set<string>();
  for (const f of changed) {
    if (IS_TEST.test(f)) tests.add(f);
    for (const dep of dependents(graph, f).keys()) if (IS_TEST.test(dep)) tests.add(dep);
  }
  const files = [...tests].filter((f) => fs.existsSync(path.join(ctx.cwd, f))).sort();
  if (!files.length || files.length > 40) return null;
  const list = files.map((f) => `"${f}"`).join(" ");
  let script = "";
  try {
    script = JSON.parse(fs.readFileSync(path.join(ctx.cwd, "package.json"), "utf8")).scripts?.test ?? "";
  } catch {
    /* not a Node project */
  }
  const runner = /\bvitest\b/.test(script) ? "npx vitest run" : /\bjest\b/.test(script) ? "npx jest" : /\bmocha\b/.test(script) ? "npx mocha" : /\bnode\b.*--test\b/.test(script) ? "node --test" : files.every((f) => f.endsWith(".py")) ? "pytest -q" : "";
  return runner ? { command: `${runner} ${list}`, files } : null;
}

const ERROR_LINE = /error|fail|✖|✗|not ok|assert|expected|panic|traceback|exception|warning|\w\.\w+[:(]\d+/i;

/** Keep what explains a failure: lines that look like errors, plus the end of the log. */
export function condense(output: string, maxLines = 60): string {
  const lines = output.split("\n").filter((l) => l.trim());
  if (lines.length <= maxLines) return lines.join("\n");
  const tailCount = Math.floor(maxLines / 2);
  const tailStart = lines.length - tailCount;
  const picked: string[] = [];
  for (let i = 0; i < tailStart && picked.length < maxLines - tailCount; i++) {
    if (ERROR_LINE.test(lines[i])) picked.push(lines[i]);
  }
  const omitted = lines.length - picked.length - tailCount;
  return [...picked, `[... ${omitted} lines without errors omitted ...]`, ...lines.slice(tailStart)].join("\n");
}

export const checkTool: Tool = {
  kind: "exec",
  spec: {
    name: "check",
    description:
      "Run this project's own checks (type checker, linter, tests - detected from its config files) and get a condensed report: one line for each check that passes, and only the relevant output for a check that fails. Use it to verify your work after a change; it costs far fewer tokens than running the commands through bash and reading the full logs. Use bash instead when you need one specific test or a command the project does not define.",
    input_schema: {
      type: "object",
      properties: {
        only: {
          type: "array",
          items: { type: "string", enum: ["typecheck", "lint", "test"] },
          description: "Run only these kinds of checks. Default: all that the project has.",
        },
        affected: {
          type: "boolean",
          description: "Run only the tests that depend on the files you changed in this session (found through the import graph), instead of the whole suite and the other checks. Fast feedback while you work; run the full check before you finish.",
        },
      },
    },
  },
  summarize: (i) => (i.affected ? "tests affected by the changes" : Array.isArray(i.only) && i.only.length ? i.only.join(", ") : "typecheck, lint, test"),
  async run(input, ctx: ToolContext) {
    const only: string[] = Array.isArray(input.only) ? input.only : [];
    let checks = detectChecks(ctx.cwd).filter((ch) => !only.length || only.includes(ch.kind));
    let note = "";
    if (input.affected) {
      const narrowed = await affectedTestCommand(ctx);
      if (narrowed) {
        checks = [{ kind: "test", command: narrowed.command }];
        note = `Ran only the ${narrowed.files.length} test file${narrowed.files.length === 1 ? "" : "s"} that depend on your changes; the rest of the suite and the other checks did not run.\n\n`;
      } else note = "Could not narrow the tests to your changes (unknown test runner, or no test file imports the changed files), so everything ran.\n\n";
    }
    if (!checks.length) {
      return {
        content: `No ${only.length ? only.join("/") + " " : ""}checks detected in ${ctx.cwd} (looked at package.json scripts, tsconfig.json, Cargo.toml, go.mod, pyproject.toml). Run the right command with bash instead.`,
        isError: true,
      };
    }
    const report: string[] = [];
    const display: string[] = [];
    let failed = 0;
    for (const ch of checks) {
      if (ctx.signal.aborted) break;
      ctx.progress(`${ch.kind}: ${ch.command}`);
      const started = Date.now();
      // The shell tool tracks `cd`; checks must not move the session's directory.
      const sub: ToolContext = Object.create(ctx, { cwd: { value: ctx.cwd, writable: true } });
      const r = await shellTool.run({ command: ch.command, timeout: 300 }, sub);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (r.isError) {
        failed++;
        report.push(`FAILED ${ch.kind} (\`${ch.command}\`, ${secs}s):\n${condense(String(r.content))}`);
        display.push(c.red(`✗ ${ch.kind}`) + c.dim(` ${ch.command} · ${secs}s`));
      } else {
        report.push(`passed ${ch.kind} (\`${ch.command}\`, ${secs}s)`);
        display.push(c.green(`✓ ${ch.kind}`) + c.dim(` ${ch.command} · ${secs}s`));
      }
    }
    return { content: note + report.join("\n\n"), isError: failed > 0, display };
  },
};

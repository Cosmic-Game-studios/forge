// Tests for the code-navigation, precise-editing, checking and context-layer tools.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { checkTool, condense, detectChecks, syntaxCheck } from "../src/tools/check.ts";
import { applyEdit, editTool, multiEditTool, readTool, writeTool } from "../src/tools/fs.ts";
import { findSymbols, outlineTool } from "../src/tools/outline.ts";
import type { ToolContext } from "../src/tools/types.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-t2-"));
function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal, fileState: new Map(), readSeen: new Map(), todos: [], runSubagent: async () => "", progress: () => {} };
}

const SAMPLE = `import x from "y";

export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  constructor(private r: number) {}

  area(): number {
    return Math.PI * this.r ** 2;
  }

  async scale(factor: number) {
    if (factor > 0) {
      this.r *= factor;
    }
  }
}

export const double = (n: number) => n * 2;

export function total(shapes: Shape[]): number {
  let sum = 0;
  for (const s of shapes) sum += s.area();
  return sum;
}
`;

test("outline lists declarations with line numbers and skips control flow", async () => {
  const names = findSymbols(SAMPLE, "a.ts").map((s) => `${s.line}:${s.name}`);
  assert.deepEqual(names, ["3:Shape", "7:Circle", "10:area", "14:scale", "21:double", "23:total"]);
  assert.deepEqual(findSymbols("class A:\n    def run(self):\n        pass\n\nasync def main():\n    pass\n", "a.py").map((s) => s.name), ["A", "run", "main"]);
  assert.deepEqual(findSymbols("func (s *Srv) Start() error {\n}\ntype Srv struct {\n}\n", "a.go").map((s) => s.name), ["Start", "Srv"]);

  const dir = tmp();
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/shapes.ts"), SAMPLE);
  const file = await outlineTool.run({ path: "src/shapes.ts" }, ctx(dir));
  assert.match(String(file.content), /src\/shapes\.ts \(28 lines\)/);
  assert.match(String(file.content), /\s+10\s+area\(\): number/);
  const folder = await outlineTool.run({ path: "." }, ctx(dir));
  assert.match(String(folder.content), /src\/shapes\.ts/);
  assert.doesNotMatch(String(folder.content), /scale/, "folder view shows top-level declarations only");
});

test("read by symbol returns just that declaration; unchanged re-reads are not re-sent", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "shapes.ts"), SAMPLE);
  const c1 = ctx(dir);
  const r = await readTool.run({ path: "shapes.ts", symbol: "total" }, c1);
  assert.equal(r.content, "23\texport function total(shapes: Shape[]): number {\n24\t  let sum = 0;\n25\t  for (const s of shapes) sum += s.area();\n26\t  return sum;\n27\t}");
  const m = await readTool.run({ path: "shapes.ts", symbol: "area" }, c1);
  assert.match(String(m.content), /^10\t  area\(\): number \{\n11\t.*\n12\t  \}$/);
  const missing = await readTool.run({ path: "shapes.ts", symbol: "nope" }, c1);
  assert.ok(missing.isError && /Declarations found: Shape, Circle/.test(String(missing.content)));

  // Same range again: a stub. After a change: full content again.
  const again = await readTool.run({ path: "shapes.ts", symbol: "total" }, c1);
  assert.match(String(again.content), /^Unchanged since you last read it/);
  const forced = await readTool.run({ path: "shapes.ts", symbol: "total", refresh: true }, c1);
  assert.match(String(forced.content), /^23\t/);
  const e = await editTool.run({ path: "shapes.ts", old_string: "let sum = 0;", new_string: "let sum = 1;" }, c1);
  assert.ok(!e.isError, String(e.content));
  const afterEdit = await readTool.run({ path: "shapes.ts", symbol: "total" }, c1);
  assert.match(String(afterEdit.content), /let sum = 1;/);
});

test("edit tolerates indentation differences when the match is unambiguous", () => {
  const src = "function a() {\n    if (x) {\n        return 1;\n    }\n}\n";
  // The model sent 2-space indentation; the file uses 4.
  const r = applyEdit(src, { old_string: "  if (x) {\n    return 1;\n  }", new_string: "  if (x) {\n    return 2;\n  }" }, "f.js");
  assert.ok(!("error" in r));
  if (!("error" in r)) {
    assert.equal(r.fuzzy, true);
    assert.equal(r.text, "function a() {\n    if (x) {\n      return 2;\n    }\n}\n".replace("      return 2;", "      return 2;"));
  }
  const amb = applyEdit("a\n  x = 1\nb\n    x = 1\n", { old_string: "x = 1 ", new_string: "x = 2" }, "f.py");
  assert.ok("error" in amb && /matches 2 places/.test(amb.error));
  const none = applyEdit(src, { old_string: "if (y) {\n  return 1;", new_string: "z" }, "f.js");
  assert.ok("error" in none && /not found/.test(none.error));
});

test("multi_edit is all-or-nothing across files and reports line deltas", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "a.js"), "export function oldName() {\n  return 1;\n}\n");
  fs.writeFileSync(path.join(dir, "b.js"), 'import { oldName } from "./a.js";\nconsole.log(oldName());\n');
  const c1 = ctx(dir);
  await readTool.run({ path: "a.js" }, c1);
  await readTool.run({ path: "b.js" }, c1);

  const bad = await multiEditTool.run(
    { edits: [{ path: "a.js", old_string: "oldName", new_string: "newName" }, { path: "b.js", old_string: "doesNotExist", new_string: "x" }] },
    c1,
  );
  assert.ok(bad.isError && /Edit 2 of 2 failed, so nothing was written/.test(String(bad.content)));
  assert.match(fs.readFileSync(path.join(dir, "a.js"), "utf8"), /oldName/, "first file untouched after a failed batch");

  const ok = await multiEditTool.run(
    { edits: [{ path: "a.js", old_string: "oldName", new_string: "newName" }, { path: "b.js", old_string: "oldName", new_string: "newName", replace_all: true }] },
    c1,
  );
  assert.ok(!ok.isError, String(ok.content));
  assert.match(String(ok.content), /a\.js: line 1, \+1\/-1 lines/);
  assert.match(String(ok.content), /b\.js: 2 occurrences, \+2\/-2 lines/);
  assert.equal(fs.readFileSync(path.join(dir, "b.js"), "utf8"), 'import { newName } from "./a.js";\nconsole.log(newName());\n');
});

test("syntax errors are reported right after an edit; large rewrites are refused", async () => {
  const dir = tmp();
  const c1 = ctx(dir);
  const broken = await writeTool.run({ path: "bad.js", content: "function f( {\n  return 1;\n}\n" }, c1);
  assert.match(String(broken.content), /Syntax check of bad\.js found a problem/);
  const fine = await writeTool.run({ path: "good.js", content: "export const a = 1;\n" }, c1);
  assert.doesNotMatch(String(fine.content), /Syntax check/);
  const json = await writeTool.run({ path: "data.json", content: '{"a": 1,}\n' }, c1);
  assert.match(String(json.content), /Syntax check of data\.json/);
  assert.equal(await syntaxCheck(path.join(dir, "good.js")), null);

  // This repository has TypeScript installed, so .ts files are checked with it.
  const tsFile = path.join(import.meta.dirname, "..", "tmp-syntax-check.ts");
  fs.writeFileSync(tsFile, "const x: number = ;\n");
  try {
    assert.match(String(await syntaxCheck(tsFile)), /Expression expected/);
  } finally {
    fs.rmSync(tsFile);
  }

  fs.writeFileSync(path.join(dir, "big.txt"), "line\n".repeat(300));
  await readTool.run({ path: "big.txt", limit: 5 }, c1);
  const refused = await writeTool.run({ path: "big.txt", content: "short\n" }, c1);
  assert.ok(refused.isError && /Change it with edit or multi_edit/.test(String(refused.content)));
  const allowed = await writeTool.run({ path: "big.txt", content: "short\n", overwrite: true }, c1);
  assert.ok(!allowed.isError);
});

test("check tool detects project checks and condenses failures", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node run-tests.js", lint: "node lint.js" } }));
  fs.writeFileSync(path.join(dir, "lint.js"), "console.log('lint ok');\n");
  // A plain script instead of `node --test`: a nested test runner behaves differently inside this test run.
  fs.writeFileSync(path.join(dir, "run-tests.js"), 'import assert from "node:assert/strict";\nassert.equal(1 + 1, 3);\n');
  assert.deepEqual(detectChecks(dir), [
    { kind: "lint", command: "npm run lint" },
    { kind: "test", command: "npm test --silent" },
  ]);
  const c1 = ctx(dir);
  const r = await checkTool.run({}, c1);
  assert.ok(r.isError);
  assert.match(String(r.content), /passed lint/);
  assert.match(String(r.content), /FAILED test/);
  assert.match(String(r.content), /2 !== 3|Expected values to be strictly equal/);
  assert.equal(c1.cwd, dir);
  const lintOnly = await checkTool.run({ only: ["lint"] }, c1);
  assert.ok(!lintOnly.isError);
  assert.doesNotMatch(String(lintOnly.content), /test/);

  const noisy = Array.from({ length: 500 }, (_, i) => (i === 100 ? "src/a.ts(3,1): error TS2304: Cannot find name 'q'." : `ok ${i}`)).join("\n");
  const short = condense(noisy);
  assert.ok(short.split("\n").length <= 62);
  assert.match(short, /error TS2304/);
  assert.match(short, /ok 499/);
});

test("sub-agents default to the cheapest model; budget stops the session", async () => {
  process.env.FORGE_HOME = tmp();
  const base: Config = { keys: { anthropic: "k" }, effort: "high", permissionMode: "yolo", webTools: false, showThinking: true };
  const ui = { onText() {}, onThinking() {}, onAssistantEnd() {}, onToolPending() {}, onToolProgress() {}, onToolStart() {}, onToolLive() {}, onToolEnd() {}, onServerTool() {}, onNotice() {}, onStats() {}, askPermission: async () => ({ allow: true as const }) };
  const main = { provider: "anthropic" as const, id: "claude-opus-5-5" };
  const mk = (cfg: Config) => new Agent({ cfg, cwd: tmp(), ui, model: main });
  assert.equal(mk(base).subagentModel().id, "claude-haiku-5-5");
  assert.equal(mk({ ...base, subagentModel: "same" }).subagentModel().id, "claude-opus-5-5");
  assert.equal(mk({ ...base, subagentModel: "anthropic:claude-sonnet-5-5" }).subagentModel().id, "claude-sonnet-5-5");

  const agent = mk({ ...base, budget: 0.5 });
  agent.stats.cost = 0.6;
  await assert.rejects(agent.run("hi"), /Session budget of \$0\.50 reached/);
});

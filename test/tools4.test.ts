// Stronger tools: edit by symbol, type errors after an edit, affected tests, undo.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, type AgentUI } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { affectedTestCommand, checkTool } from "../src/tools/check.ts";
import { editTool, multiEditTool } from "../src/tools/fs.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { startMock } from "./mock-anthropic.ts";

const tmpDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
function context(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal, fileState: new Map(), readSeen: new Map(), changed: new Set(), diag: { known: null, off: false }, todos: [], runSubagent: async () => "", progress: () => {} };
}

test("edit by symbol replaces one whole declaration and nothing around it", async () => {
  const cwd = tmpDir("forge-sym-");
  write(cwd, "shapes.js", ["// Area helpers.", "function square(side) {", "  return side * side;", "}", "", "// Circle area.", "function circle(r) {", "  const pi = 3;", "  return pi * r * r;", "}", "", "class Box {", "  volume(a, b, c) {", "    return a * b;", "  }", "", "  name() {", '    return "box";', "  }", "}", ""].join("\n"));
  const ctx = context(cwd);

  let r = await editTool.run({ path: "shapes.js", symbol: "circle", new_string: "function circle(r) {\n  return Math.PI * r * r;\n}" }, ctx);
  assert.ok(!r.isError, String(r.content));
  // A method, given without indentation: it is fitted to the class body.
  r = await editTool.run({ path: "shapes.js", symbol: "volume", new_string: "volume(a, b, c) {\n  return a * b * c;\n}" }, ctx);
  assert.ok(!r.isError, String(r.content));
  assert.equal(
    read(cwd, "shapes.js"),
    ["// Area helpers.", "function square(side) {", "  return side * side;", "}", "", "// Circle area.", "function circle(r) {", "  return Math.PI * r * r;", "}", "", "class Box {", "  volume(a, b, c) {", "    return a * b * c;", "  }", "", "  name() {", '    return "box";', "  }", "}", ""].join("\n"),
  );

  r = await editTool.run({ path: "shapes.js", symbol: "triangle", new_string: "x" }, ctx);
  assert.ok(r.isError && /No declaration named `triangle`/.test(String(r.content)) && /square, circle, Box/.test(String(r.content)), String(r.content));
  r = await editTool.run({ path: "shapes.js", new_string: "x" }, ctx);
  assert.ok(r.isError && /old_string .* or symbol/.test(String(r.content)), String(r.content));

  // multi_edit mixes both forms and stays all-or-nothing.
  const before = read(cwd, "shapes.js");
  r = await multiEditTool.run({ edits: [{ path: "shapes.js", symbol: "square", new_string: "function square(side) {\n  return side ** 2;\n}" }, { path: "shapes.js", old_string: "not there", new_string: "y" }] }, ctx);
  assert.ok(r.isError);
  assert.equal(read(cwd, "shapes.js"), before);
});

test("type errors caused by an edit come back with the edit, including broken callers", async () => {
  const cwd = tmpDir("forge-ts-");
  const forgeTsc = path.join(import.meta.dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  // Give the project "its own" compiler by pointing at the one this repository uses.
  if (process.platform === "win32") write(cwd, "node_modules/.bin/tsc.cmd", `@"${forgeTsc}" %*\r\n`);
  else {
    write(cwd, "node_modules/.bin/tsc", `#!/bin/sh\nexec "${forgeTsc}" "$@"\n`);
    fs.chmodSync(path.join(cwd, "node_modules/.bin/tsc"), 0o755);
  }
  write(cwd, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022" }, include: ["*.ts"] }));
  write(cwd, "a.ts", "export function double(x: number): number {\n  return x * 2;\n}\n");
  write(cwd, "b.ts", 'import { double } from "./a";\nexport const four = double(2);\n');
  const ctx = context(cwd);

  // Changing the signature breaks the caller in b.ts.
  let r = await editTool.run({ path: "a.ts", old_string: "x: number", new_string: "x: string" }, ctx);
  assert.match(String(r.content), /Type errors in what you just edited[\s\S]*a\.ts:2 TS\d+/);
  assert.match(String(r.content), /other files[\s\S]*b\.ts:2 TS2345/);

  r = await editTool.run({ path: "a.ts", symbol: "double", new_string: "export function double(x: number): number {\n  return x * 2;\n}" }, ctx);
  assert.doesNotMatch(String(r.content), /Type errors|broke other files/, "a clean project adds nothing to the result");

  r = await editTool.run({ path: "a.ts", old_string: "double(x: number)", new_string: "double(x: number, times: number)" }, ctx);
  assert.match(String(r.content), /Your edit broke other files - these errors were not there before it:\n {2}b\.ts:2 TS2554/);
});

test("check with affected runs only the tests that import what changed", async () => {
  const cwd = tmpDir("forge-aff-");
  write(cwd, "package.json", JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
  write(cwd, "src/a.js", "exports.a = 1;\n");
  write(cwd, "src/b.js", "exports.b = 2;\n");
  write(cwd, "test/a.test.js", 'const { test } = require("node:test");\nconst assert = require("node:assert");\ntest("a", () => assert.equal(require("../src/a.js").a, 1));\n');
  write(cwd, "test/b.test.js", 'const { test } = require("node:test");\ntest("b", () => { throw new Error("B MUST NOT RUN"); });\nrequire("../src/b.js");\n');
  const ctx = context(cwd);
  assert.equal(await affectedTestCommand(ctx), null, "nothing changed yet");
  ctx.changed!.add(path.join(cwd, "src", "a.js"));
  assert.deepEqual(await affectedTestCommand(ctx), { command: 'node --test "test/a.test.js"', files: ["test/a.test.js"] });
  const r = await checkTool.run({ affected: true }, ctx);
  assert.ok(!r.isError, String(r.content));
  assert.match(String(r.content), /Ran only the 1 test file that depend/);
  assert.doesNotMatch(String(r.content), /B MUST NOT RUN/);
});

test("undo restores the files of the last request and tells the model", async () => {
  const mock = await startMock([
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "edit", input: { path: "keep.txt", old_string: "original", new_string: "changed" } },
        { type: "tool_use", id: "t2", name: "write", input: { path: "new.txt", content: "fresh\n" } },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
  ]);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = tmpDir("forge-home-");
  delete process.env.ANTHROPIC_API_KEY;
  const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: "yolo", webTools: false, showThinking: true, prepare: false, watch: false };
  const cwd = tmpDir("forge-undo-");
  write(cwd, "keep.txt", "original\n");
  const ui: AgentUI = { onText() {}, onThinking() {}, onAssistantEnd() {}, onToolPending() {}, onToolProgress() {}, onToolStart() {}, onToolLive() {}, onToolEnd() {}, onServerTool() {}, onNotice() {}, onStats() {}, askPermission: async () => ({ allow: true }) };
  const agent = new Agent({ cfg, cwd, ui, model: { provider: "anthropic", id: "claude-opus-5-5" } });
  await agent.run("change things");
  assert.equal(read(cwd, "keep.txt"), "changed\n");
  assert.equal(agent.undoable, 1);

  const undone = agent.undo();
  assert.deepEqual(undone?.files.sort(), ["keep.txt", "new.txt"]);
  assert.equal(read(cwd, "keep.txt"), "original\n");
  assert.equal(fs.existsSync(path.join(cwd, "new.txt")), false);
  assert.equal(agent.undo(), null);

  await agent.run("what now?");
  await mock.close();
  assert.match(mock.requests[2].body.messages.at(-1).content, /^what now\?\n\n\[Forge: the user undid the file changes of the request "change things"/);
});

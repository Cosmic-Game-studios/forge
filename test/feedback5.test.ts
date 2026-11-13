// Immediate feedback on edits, the watcher, the request summary, and the browser tools.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, type AgentUI } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { changeStats } from "../src/review.ts";
import { loadSkills } from "../src/skills.ts";
import { findBrowser, resolveTarget } from "../src/tools/browser.ts";
import { describeObjects } from "../src/tools/scene3d.ts";
import { screenshotTool } from "../src/tools/screenshot.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { editNotes, formatNotes, lintProblems } from "../src/tools/watch.ts";
import { startMock, type ScriptTurn } from "./mock-anthropic.ts";

const tmpDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const toolContext = (cwd: string) => ({ cwd, signal: new AbortController().signal }) as ToolContext;

const quietUI: AgentUI = {
  onText: () => {},
  onThinking: () => {},
  onAssistantEnd: () => {},
  onToolPending: () => {},
  onToolProgress: () => {},
  onToolStart: () => {},
  onToolLive: () => {},
  onToolEnd: () => {},
  onServerTool: () => {},
  onNotice: () => {},
  onStats: () => {},
  askPermission: async () => ({ allow: true }),
};

async function setup(script: ScriptTurn[], extra: Partial<Config> = {}) {
  const mock = await startMock(script);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = tmpDir("forge-home-");
  delete process.env.ANTHROPIC_API_KEY;
  const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: "yolo", webTools: false, showThinking: true, prepare: false, watch: false, review: false, autoCheck: false, ...extra };
  return { mock, cfg, cwd: tmpDir("forge-proj-") };
}
const OPUS = { provider: "anthropic" as const, id: "claude-opus-5-5" };

test("edit notes: placeholders, debug output and conflict markers in what an edit added are named with their line", () => {
  const old = "export function total(items) {\n  return items.length;\n}\n";
  const now = 'export function total(items) {\n  console.log("here", items);\n  // TODO: implement the real sum\n  return items.length;\n}\n';
  const notes = editNotes(path.join("src", "total.js"), old, now);
  assert.ok(notes.some((n) => /total\.js:3 looks like a placeholder/.test(n)), notes.join("\n"));
  assert.ok(notes.some((n) => /total\.js:2 adds /.test(n)), notes.join("\n"));
  assert.match(formatNotes(notes), /^\n\nNoticed in this edit/);

  assert.deepEqual(editNotes("total.js", now, now), [], "nothing added, nothing to say");
  assert.deepEqual(editNotes("notes.md", null, "TODO: write this\n"), [], "prose is not code");
  assert.equal(formatNotes([]), "");
  assert.ok(editNotes("a.py", null, "x = 1\n<<<<<<< HEAD\ny = 2\n=======\ny = 3\n>>>>>>> other\n").some((n) => /merge-conflict markers/.test(n)));
  // A file that printed before the edit prints on purpose.
  const cli = 'console.log("usage: tool <file>");\n';
  assert.ok(!editNotes("cli.js", cli, cli + 'console.log("done");\n').some((n) => / adds /.test(n)));
});

test("linter: errors from the project's own linter come back with the edit; no linter set up means silence", async () => {
  const cwd = tmpDir("forge-lint-");
  write(cwd, "lib.js", "var a = 1;\n");
  assert.equal(await lintProblems(toolContext(cwd), [path.join(cwd, "lib.js")]), "", "no linter configured");

  write(cwd, "eslint.config.js", "export default [];\n");
  const line = "lib.js:1:1: Unexpected var, use let or const instead. [Error/no-var]";
  const warning = "lib.js:1:5: 'a' is assigned a value but never used. [Warning/no-unused-vars]";
  if (process.platform === "win32") write(cwd, "node_modules/.bin/eslint.cmd", `@echo ${line}\r\n@echo ${warning}\r\n`);
  else {
    write(cwd, "node_modules/.bin/eslint", `#!/bin/sh\necho "${line}"\necho "${warning}"\n`);
    fs.chmodSync(path.join(cwd, "node_modules/.bin/eslint"), 0o755);
  }
  const out = await lintProblems(toolContext(cwd), [path.join(cwd, "lib.js")]);
  assert.match(out, /eslint on lib\.js:\n {2}line 1: Unexpected var/);
  assert.doesNotMatch(out, /never used/, "warnings are not reported");
});

const MODULE = Array.from({ length: 20 }, (_, i) => `exports.f${i} = () => ${i};`).join("\n") + "\n";
const isWatcher = (body: any) => /You watch a coding agent/.test(body.system?.[0]?.text ?? JSON.stringify(body.system));

test("watcher: a burst of edits is read by the cheap model while work goes on; its findings reach the author", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      { when: (b) => !isWatcher(b), stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "write", input: { path: "lib.js", content: MODULE } }] },
      { when: isWatcher, stop_reason: "end_turn", content: [{ type: "text", text: "1. lib.js:3 - f2 should return 3, the task says so." }] },
      { when: (b) => !isWatcher(b), stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      { when: (b) => !isWatcher(b), stop_reason: "end_turn", content: [{ type: "text", text: "Checked: 2 is right." }] },
    ],
    { watch: true },
  );
  const agent = new Agent({ cfg, cwd, ui: quietUI, model: OPUS });
  await agent.run("Create lib.js with twenty functions");
  await mock.close();

  assert.equal(mock.requests.length, 4);
  const watcher = mock.requests.find((q) => isWatcher(q.body))!.body;
  assert.match(watcher.model, /haiku/, "the cheapest model watches");
  assert.equal(watcher.tools?.length ?? 0, 0);
  assert.match(JSON.stringify(watcher.messages), /Create lib\.js with twenty functions/);
  assert.match(JSON.stringify(watcher.messages), /exports\.f19/);
  const main = mock.requests.filter((q) => !isWatcher(q.body));
  assert.match(JSON.stringify(main[2].body.messages), /Forge watcher[^]*f2 should return 3/);

  // The request's summary, as the terminal shows it at the end.
  assert.deepEqual(agent.lastRun!.files, [{ path: "lib.js", added: 20, removed: 0, kind: "new" }]);
  assert.equal(agent.lastRun!.checks, null);
  assert.equal(agent.lastRun!.requests, 4);
});

test("watcher: an OK and small edits cost nothing more", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "write", input: { path: "a.js", content: "exports.a = 1;\n" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
    ],
    { watch: true },
  );
  await new Agent({ cfg, cwd, ui: quietUI, model: OPUS }).run("Create a.js");
  await mock.close();
  assert.equal(mock.requests.length, 2, "two lines are not worth a look");
});

test("change stats: added and removed lines per file, new and deleted files", () => {
  const cwd = tmpDir("forge-stats-");
  write(cwd, "kept.js", "a\nB\nC\nd\n");
  write(cwd, "new.js", "x\ny\n");
  write(cwd, "same.js", "same\n");
  const before = new Map<string, string | null>([
    [path.join(cwd, "kept.js"), "a\nb\nd\n"],
    [path.join(cwd, "new.js"), null],
    [path.join(cwd, "gone.js"), "one\ntwo\n"],
    [path.join(cwd, "same.js"), "same\n"],
  ]);
  assert.deepEqual(changeStats(before, cwd), [
    { path: "kept.js", added: 2, removed: 1, kind: "changed" },
    { path: "new.js", added: 2, removed: 0, kind: "new" },
    { path: "gone.js", added: 0, removed: 2, kind: "deleted" },
  ]);
});

test("3d: identical objects are grouped with their extent, named ones are listed alone and first", () => {
  const wall = (x: number) => ({ name: "", type: "Mesh", pos: [x, 0.5, 0], size: [1, 1, 1], dist: 10 + x, inView: x < 2, visible: true, color: "#2233ff", count: 1, parent: "maze" });
  const player = { name: "player", type: "Mesh", pos: [0, 0.4, 3], size: [0.8, 0.8, 0.8], dist: 9, inView: true, visible: true, color: "#ffff00", count: 1, parent: "" };
  const text = describeObjects([wall(0), wall(1), wall(2), player], 10);
  const lines = text.split("\n");
  assert.match(lines[0], /^- "player" Mesh #ffff00: at \(0, 0\.4, 3\), size \(0\.8, 0\.8, 0\.8\), 9 from the camera, in the camera's view$/);
  assert.match(lines[1], /^- 3 x \(unnamed\) Mesh #2233ff in maze, each size \(1, 1, 1\): positions from \(0, 0\.5, 0\) to \(2, 0\.5, 0\), 2 in the camera's view$/);
  assert.match(lines[2], /10 objects in the scene; the first 4 were read/);
});

test("3d: the 3d-worlds skill ships with Forge", () => {
  process.env.FORGE_HOME = tmpDir("forge-home-");
  const skill = loadSkills(tmpDir("forge-proj-")).find((s) => s.name === "3d-worlds");
  assert.ok(skill, "3d-worlds is a built-in skill");
  assert.match(skill.description, /three\.js/);
});

test("browser: a local page is served over HTTP from the project folder, and nothing outside it", async () => {
  const cwd = tmpDir("forge-web-");
  write(cwd, "site/index.html", "<!doctype html><title>t</title><script type=module src=./app.js></script>");
  write(cwd, "site/app.js", "document.title = 'ok';");
  assert.equal(await resolveTarget("missing.html", cwd), null);
  assert.equal((await resolveTarget("https://example.com/x", cwd))!.url, "https://example.com/x");

  const target = (await resolveTarget("site/index.html", cwd))!;
  try {
    assert.match(target.url, /^http:\/\/127\.0\.0\.1:\d+\/site\/index\.html$/);
    const page = await fetch(target.url);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /app\.js/);
    const script = await fetch(new URL("./app.js", target.url));
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    const origin = new URL(target.url).origin;
    assert.ok((await fetch(`${origin}/..%2f..%2fsecret.txt`)).status >= 400);
    assert.equal((await fetch(`${origin}/nope.js`)).status, 404);
  } finally {
    target.close();
  }
});

test("browser: a screenshot comes back with the errors the page reported", { skip: findBrowser() ? false : "no Chrome or Edge installed" }, async () => {
  const cwd = tmpDir("forge-shot-");
  write(cwd, "page.html", "<!doctype html><h1>Hello</h1><script>console.error('boom from the page')</script>");
  const out = await screenshotTool.run({ target: "page.html", wait: 300, width: 400, height: 300 }, toolContext(cwd));
  assert.ok(!out.isError, typeof out.content === "string" ? out.content : "");
  const blocks = out.content as { type: string; text?: string }[];
  assert.match(blocks[0].text!, /reported 1 error[^]*boom from the page/);
  assert.equal(blocks[1].type, "image");
});

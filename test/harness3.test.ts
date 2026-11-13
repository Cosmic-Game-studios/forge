// Skills, the import graph, MCP, graded compaction, automatic checks, repeat guard.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, type AgentUI, type PermissionRequest } from "../src/agent.ts";
import { renderTranscript, stripThinking, SUMMARY_MARK, tailStart } from "../src/compact.ts";
import type { Config } from "../src/config.ts";
import type { Message } from "../src/providers/types.ts";
import { loadSkills, skillsPrompt } from "../src/skills.ts";
import { buildGraph, dependents, depsTool } from "../src/tools/graph.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { startMock, type ScriptTurn } from "./mock-anthropic.ts";

const tmpDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

function recorder() {
  const r = {
    tools: [] as string[],
    notices: [] as string[],
    permissions: [] as PermissionRequest[],
  };
  const ui: AgentUI = {
    onText: () => {},
    onThinking: () => {},
    onAssistantEnd: () => {},
    onToolPending: () => {},
    onToolProgress: () => {},
    onToolStart: () => {},
    onToolLive: () => {},
    onToolEnd: (call, out) => void r.tools.push(`${call.name}:${out.isError ? "error" : "ok"}`),
    onServerTool: () => {},
    onNotice: (m) => void r.notices.push(m),
    onStats: () => {},
    askPermission: async (req) => {
      r.permissions.push(req);
      return { allow: true };
    },
  };
  return { r, ui };
}

async function setup(script: ScriptTurn[], extra: Partial<Config> = {}) {
  const mock = await startMock(script);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = tmpDir("forge-home-");
  delete process.env.ANTHROPIC_API_KEY;
  const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: "ask", webTools: false, showThinking: true, prepare: false, watch: false, ...extra };
  return { mock, cfg, cwd: tmpDir("forge-proj-") };
}
const OPUS = { provider: "anthropic" as const, id: "claude-opus-5-5" };

test("skills: built-in and project skills are listed in the system prompt by description only", () => {
  process.env.FORGE_HOME = tmpDir("forge-home-");
  const cwd = tmpDir("forge-proj-");
  write(cwd, ".forge/skills/release/SKILL.md", "---\nname: release\ndescription: How this project cuts a release.\n---\n\nSECRET BODY\n");
  write(cwd, ".forge/skills/broken/SKILL.md", "no frontmatter here");
  const skills = loadSkills(cwd);
  const names = skills.map((s) => s.name);
  assert.ok(names.includes("frontend-design"), "the bundled design skill is found");
  assert.ok(names.includes("release"));
  assert.ok(!names.includes("broken"));
  const prompt = skillsPrompt(skills);
  assert.match(prompt, /release: How this project cuts a release\. \(.*SKILL\.md\)/);
  assert.doesNotMatch(prompt, /SECRET BODY/);
});

test("deps: import graph finds direct and indirect dependents and the tests that reach a file", async () => {
  const cwd = tmpDir("forge-proj-");
  write(cwd, "src/b.ts", "export const b = 1;\n");
  write(cwd, "src/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
  write(cwd, "src/util/index.ts", 'export * from "../b.ts";\n');
  write(cwd, "test/a.test.ts", 'import { a } from "../src/a.ts";\nconst lazy = () => import("../src/util");\n');
  write(cwd, "pkg/__init__.py", "");
  write(cwd, "pkg/core.py", "X = 1\n");
  write(cwd, "pkg/app.py", "from .core import X\nimport os\n");
  const signal = new AbortController().signal;
  const graph = await buildGraph(cwd, signal);
  const deps = dependents(graph, "src/b.ts");
  assert.equal(deps.get("src/a.ts"), 1);
  assert.equal(deps.get("src/util/index.ts"), 1);
  assert.equal(deps.get("test/a.test.ts"), 2);
  assert.ok(graph.importedBy.get("pkg/core.py")?.has("pkg/app.py"));

  const ctx = { cwd, signal } as ToolContext;
  const out = await depsTool.run({ path: "src/b.ts" }, ctx);
  assert.match(String(out.content), /imported by \(2\):\n {2}src\/a\.ts\n {2}src\/util\/index\.ts/);
  assert.match(String(out.content), /tests that reach it \(1\):\n {2}test\/a\.test\.ts/);
});

test("mcp: server tools join the tool set; read-only ones run without a prompt", async () => {
  const { mock, cfg, cwd } = await setup([
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "mcp__fake__now", input: {} },
        { type: "tool_use", id: "t2", name: "mcp__fake__echo", input: { text: "hi" } },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
  ]);
  const server = { command: process.execPath, args: [path.join(import.meta.dirname, "fake-mcp.mjs")] };
  write(process.env.FORGE_HOME!, "mcp.json", JSON.stringify({ mcpServers: { fake: server } }));
  write(cwd, ".mcp.json", JSON.stringify({ mcpServers: { untrusted: server } }));
  const { r, ui } = recorder();
  const agent = new Agent({ cfg, cwd, ui, model: OPUS });
  await agent.init(); // no approval callback: the project's server must stay off
  try {
    assert.deepEqual(agent.mcp.status.map((s) => `${s.name}:${s.state}:${s.tools}`), ["fake:connected:2", "untrusted:not approved:0"]);
    await agent.run("use the tools");
  } finally {
    agent.close();
    await mock.close();
  }
  const [r1, r2] = mock.requests.map((q) => q.body);
  assert.ok(r1.tools.some((t: any) => t.name === "mcp__fake__echo" && /MCP server "fake"/.test(t.description)));
  assert.ok(!r1.tools.some((t: any) => /untrusted/.test(t.name)));
  const results = r2.messages[2].content;
  assert.equal(results[0].content, "12:00");
  assert.equal(results[1].content, "echo: hi");
  assert.deepEqual(r.permissions.map((p) => p.tool), ["mcp__fake__echo"]);
});

test("compaction units: detail falls off with age; the tail starts at an assistant message", () => {
  const big = (tag: string) => `${tag} ${"x".repeat(9000)} END-${tag}`;
  const messages: Message[] = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" } as any, { type: "tool_use", id: `t${i}`, name: "read", input: { path: `f${i}` } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: big(`R${i}`) }] });
  }
  const text = renderTranscript(messages, 1_000_000);
  const resultLen = (i: number) => /TOOL RESULT: ([\s\S]*?)(\n\n---|$)/.exec(text.slice(text.indexOf(`"path":"f${i}"`)))![1].length;
  assert.ok(resultLen(0) < 500, "oldest results are stubs");
  assert.ok(resultLen(6) > 1000 && resultLen(6) < 2000, "middle results are excerpts");
  assert.ok(resultLen(9) > 5000, "newest results are nearly whole");
  assert.match(text, /message 1 \(old\)/);
  assert.match(text, /message 20 \(recent\)/);
  assert.ok(renderTranscript(messages, 5000).length <= 5000, "shrinks to fit the summarizer's window");

  const start = tailStart(messages, 24_000);
  assert.equal(messages[start].role, "assistant");
  assert.equal(start, 16, "two whole rounds fit in the budget");
  const tail = stripThinking(messages.slice(start));
  assert.ok(tail.every((m) => typeof m.content === "string" || m.content.every((b) => b.type !== "thinking")));
});

test("compaction: the cheapest model summarizes mid-task; the newest round stays word for word", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "look" }, { type: "tool_use", id: "t1", name: "read", input: { path: "one.txt" } }] },
      { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "more" }, { type: "tool_use", id: "t2", name: "read", input: { path: "two.txt" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "## Goal and instructions\nSUMMARY-TEXT" }] }, // the summarizer
      { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
    ],
    { compactAt: 500 },
  );
  const lines = (tag: string) => Array.from({ length: 300 }, (_, i) => `${tag} line ${i} ${"y".repeat(55)}`).join("\n");
  write(cwd, "one.txt", lines("ONE"));
  write(cwd, "two.txt", lines("TWO"));
  const { r, ui } = recorder();
  const agent = new Agent({ cfg, cwd, ui, model: OPUS });
  await agent.run("Read both files");
  await mock.close();

  assert.equal(mock.requests.length, 4);
  const summarizer = mock.requests[2].body;
  assert.equal(summarizer.model, "claude-haiku-5-5");
  assert.deepEqual(summarizer.tools, []);
  assert.match(summarizer.messages[0].content, /USER:\nRead both files/);
  assert.match(summarizer.messages[0].content, /TOOL RESULT: [\s\S]*ONE line 0/);
  assert.doesNotMatch(summarizer.messages[0].content, /TWO line/, "the kept tail is not paid for twice");

  const after = mock.requests[3].body.messages;
  assert.equal(after.length, 3);
  assert.ok(after[0].content.startsWith(SUMMARY_MARK));
  assert.match(after[0].content, /SUMMARY-TEXT/);
  assert.deepEqual(after[1].content.map((b: any) => b.type), ["tool_use"], "thinking is not replayed after a rewrite");
  assert.match(after[2].content[0].content, /TWO line 299/);
  assert.ok(r.notices.some((n) => /compressed into a summary by Claude Haiku 5\.5/.test(n)));
  assert.equal(agent.messages.length, 4);
});

test("automatic check: failing checks go back to the model, passing ones end the turn silently", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "write", input: { path: "state.txt", content: "bad" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "write", input: { path: "state.txt", content: "good", overwrite: true } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "fixed" }] },
    ],
    { permissionMode: "yolo" },
  );
  write(cwd, "package.json", JSON.stringify({ name: "p", scripts: { test: "node verify.js" } }));
  write(cwd, "verify.js", 'const ok = require("fs").readFileSync("state.txt", "utf8") === "good";\nif (!ok) { console.error("STATE IS BAD"); process.exit(1); }\n');
  const { r, ui } = recorder();
  const agent = new Agent({ cfg, cwd, ui, model: OPUS });
  await agent.run("set the state");
  await mock.close();

  assert.equal(mock.requests.length, 4);
  assert.deepEqual(r.tools, ["write:ok", "check:error", "write:ok", "check:ok"]);
  const fed = mock.requests[2].body.messages.at(-1).content;
  assert.match(fed, /Automatic check by Forge/);
  assert.match(fed, /STATE IS BAD/);
  assert.equal(fs.readFileSync(path.join(cwd, "state.txt"), "utf8"), "good");
});

test("repeat guard: the third identical call with an identical result is flagged", async () => {
  const call = (id: string): ScriptTurn => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "glob", input: { pattern: "*.nothing" } }] });
  const { mock, cfg, cwd } = await setup([call("t1"), call("t2"), call("t3"), { stop_reason: "end_turn", content: [{ type: "text", text: "stuck" }] }]);
  const { ui } = recorder();
  await new Agent({ cfg, cwd, ui, model: OPUS }).run("find it");
  await mock.close();
  const results = mock.requests[3].body.messages.filter((m: any) => Array.isArray(m.content) && m.content[0].type === "tool_result").map((m: any) => m.content[0].content);
  assert.doesNotMatch(results[1], /Forge:/);
  assert.match(results[2], /Forge: you have made this exact `glob` call 3 times/);
});

const MODULE = Array.from({ length: 14 }, (_, i) => `exports.f${i} = () => ${i};`).join("\n") + "\n";

test("independent review: findings go back to the author once; the reviewer has no edit tools", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "write", input: { path: "lib.js", content: MODULE } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Checked.\nVERDICT: FIX\n1. lib.js:3 - f2 returns the wrong value; f2() gives 2; return 3." }] }, // the reviewer
      { stop_reason: "end_turn", content: [{ type: "text", text: "The reviewer is mistaken: 2 is what was asked for." }] },
    ],
    { permissionMode: "yolo" },
  );
  const { r, ui } = recorder();
  const agent = new Agent({ cfg, cwd, ui, model: OPUS });
  await agent.run("Create lib.js with fourteen functions");
  await mock.close();

  assert.equal(mock.requests.length, 4, "one review round, no second review after the author's answer");
  const review = mock.requests[2].body;
  assert.match(review.system[0].text, /independent code reviewer/);
  assert.match(review.messages[0].content, /Create lib\.js with fourteen functions/);
  assert.match(review.messages[0].content, /### lib\.js \(new file, 15 lines\)\n\+ {3}1 exports\.f0/);
  const names = review.tools.map((t: any) => t.name);
  assert.ok(names.includes("read") && names.includes("bash"));
  assert.ok(!names.some((n: string) => ["write", "edit", "multi_edit", "task", "remember"].includes(n)));
  const fed = mock.requests[3].body.messages.at(-1).content;
  assert.match(fed, /Independent review by Forge/);
  assert.match(fed, /1\. lib\.js:3 - f2 returns the wrong value/);
  assert.doesNotMatch(fed, /Checked\./, "only the findings are passed on");
  assert.deepEqual(r.tools, ["write:ok", "review:ok"]);
});

test("independent review: a pass ends the turn; small changes and /review off are not reviewed", async () => {
  const script = (content: string): ScriptTurn[] => [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "write", input: { path: "lib.js", content } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "VERDICT: PASS" }] },
  ];
  let s = await setup(script(MODULE), { permissionMode: "yolo" });
  await new Agent({ cfg: s.cfg, cwd: s.cwd, ui: recorder().ui, model: OPUS }).run("make it");
  await s.mock.close();
  assert.equal(s.mock.requests.length, 3);
  assert.equal(s.mock.requests[2].body.messages.length, 1, "the reviewer starts with an empty context");

  s = await setup(script("exports.one = 1;\n"), { permissionMode: "yolo" });
  await new Agent({ cfg: s.cfg, cwd: s.cwd, ui: recorder().ui, model: OPUS }).run("make it");
  await s.mock.close();
  assert.equal(s.mock.requests.length, 2, "a two-line change is not worth a review");

  s = await setup(script(MODULE), { permissionMode: "yolo", review: false });
  await new Agent({ cfg: s.cfg, cwd: s.cwd, ui: recorder().ui, model: OPUS }).run("make it");
  await s.mock.close();
  assert.equal(s.mock.requests.length, 2);
});

test("project notes: remember stores a fact that the next session finds in its system prompt", async () => {
  const { mock, cfg, cwd } = await setup([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "remember", input: { note: "Tests run with  npm run test:unit, not npm test." } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "noted" }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] },
  ]);
  const { r, ui } = recorder();
  await new Agent({ cfg, cwd, ui, model: OPUS }).run("how do the tests run?");
  assert.equal(r.permissions.length, 0);
  assert.equal(fs.readFileSync(path.join(cwd, ".forge/notes.md"), "utf8").split("\n").at(-2), "- Tests run with npm run test:unit, not npm test.");
  assert.doesNotMatch(mock.requests[0].body.system[0].text, /# Project notes/);
  await new Agent({ cfg, cwd, ui, model: OPUS }).run("hello");
  await mock.close();
  assert.match(mock.requests[2].body.system[0].text, /# Project notes[\s\S]*- Tests run with npm run test:unit/);
});

test("request preparation: snapshot, located mentions and triage are added after the user's own words", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      { stop_reason: "end_turn", content: [{ type: "text", text: '{"kind": "question", "size": "small", "ambiguity": "Either the parser or the formatter could be meant."}' }] }, // triage
      { stop_reason: "end_turn", content: [{ type: "text", text: "It parses dates." }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }, // triage of the follow-up fails quietly
      { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
    ],
    { prepare: true },
  );
  write(cwd, "package.json", JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
  write(cwd, "lib/dates.js", "const x = 1;\nfunction parseIsoDate(text) {\n  return text;\n}\nmodule.exports = { parseIsoDate };\n");
  write(cwd, "src/app.ts", "export const app = 1;\n");
  const { r, ui } = recorder();
  const agent = new Agent({ cfg, cwd, ui, model: OPUS });
  await agent.run("What does `parseIsoDate` in dates.js do?");
  await agent.run("and now?");
  await mock.close();

  const triage = mock.requests[0].body;
  assert.equal(triage.model, "claude-haiku-5-5");
  assert.match(triage.messages[0].content, /The user's request:\nWhat does `parseIsoDate`/);
  const main = mock.requests[1].body;
  const first = main.messages[0].content;
  assert.ok(first.startsWith("What does `parseIsoDate` in dates.js do?\n\n[Gathered by Forge"), "the user's words come first, unchanged");
  assert.match(first, /Project: 3 files - JavaScript \(1\), TypeScript \(1\)/);
  assert.match(first, /Top level: lib\/ \(1\), src\/ \(1\), package\.json/);
  assert.match(first, /Checks the project defines: test `npm test/);
  assert.match(first, /- lib\/dates\.js exists \(6 lines\)/);
  assert.match(first, /- `parseIsoDate` is defined at lib\/dates\.js:2/);
  assert.match(first, /reads as a question/);
  assert.match(first, /Possibly ambiguous: Either the parser or the formatter/);
  assert.deepEqual(main.output_config, { effort: "medium" }, "a question does not get the session's full thinking effort");
  assert.ok(r.notices.some((n) => /Read as: question, small · located 2 things/.test(n)));

  assert.match(mock.requests[2].body.messages[0].content, /previous reply ended with:\nIt parses dates\./);
  const second = mock.requests[3].body.messages.at(-1).content;
  assert.equal(second, "and now?", "nothing is added when there is nothing to add; the snapshot is sent once");
  assert.deepEqual(mock.requests[3].body.output_config, { effort: "high" });
});

test("a tool input that is not valid JSON costs that one call, not the whole turn", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      {
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "Writing two files." },
          { type: "tool_use", id: "t1", name: "write", input: {}, rawJson: '{"path": "bad.txt", "content": "unterminated' },
          { type: "tool_use", id: "t2", name: "write", input: { path: "good.txt", content: "ok\n" } },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "retrying later" }] },
    ],
    { permissionMode: "yolo" },
  );
  const { r, ui } = recorder();
  await new Agent({ cfg, cwd, ui, model: OPUS }).run("write them");
  await mock.close();

  assert.equal(mock.requests.length, 2, "the turn is not requested again");
  assert.equal(fs.readFileSync(path.join(cwd, "good.txt"), "utf8"), "ok\n");
  assert.equal(fs.existsSync(path.join(cwd, "bad.txt")), false);
  const [assistant, results] = mock.requests[1].body.messages.slice(1);
  assert.deepEqual(assistant.content.map((b: any) => b.type), ["thinking", "text", "tool_use", "tool_use"]);
  assert.equal(assistant.content[0].signature, "sig_1_0", "thinking is sent back as it came");
  assert.deepEqual(assistant.content[2].input, {});
  assert.match(results.content[0].content, /INVALID_JSON.*unterminated/);
  assert.equal(results.content[0].is_error, true);
  assert.equal(results.content[1].is_error, undefined);
  assert.ok(!r.notices.some((n) => /invalid JSON/i.test(n)));
});

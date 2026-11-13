// End-to-end tests of the agent loop against the scripted mock API.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, type AgentUI, type PermissionAnswer, type PermissionRequest } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { startMock, type ScriptTurn } from "./mock-anthropic.ts";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Recorder extends AgentUI {
  text: string;
  thinking: string;
  tools: string[];
  notices: string[];
  permissions: PermissionRequest[];
}

function recorder(answer: (req: PermissionRequest) => PermissionAnswer = () => ({ allow: true })): Recorder {
  const r: Recorder = {
    text: "",
    thinking: "",
    tools: [],
    notices: [],
    permissions: [],
    onText: (d) => void (r.text += d),
    onThinking: (d) => void (r.thinking += d),
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
      return answer(req);
    },
  };
  return r;
}

async function setup(script: ScriptTurn[], mode: Config["permissionMode"] = "ask") {
  const mock = await startMock(script);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = tmpDir("forge-home-");
  // A fresh key per test gives each test its own provider client (and base URL).
  const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: mode, webTools: true, showThinking: true, prepare: false, watch: false };
  delete process.env.ANTHROPIC_API_KEY;
  const cwd = tmpDir("forge-proj-");
  return { mock, cfg, cwd };
}

test("full tool round: parallel reads, write, append-only history, request shape", async () => {
  const { mock, cfg, cwd } = await setup([
    {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "I should look at both files first." },
        { type: "text", text: "Reading the two files." },
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.txt" } },
        { type: "tool_use", id: "t2", name: "read", input: { path: "b.txt" } },
      ],
    },
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t3", name: "write", input: { path: "out/sum.txt", content: "alpha+beta\n" } }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Done: wrote **out/sum.txt**." }] },
  ]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(cwd, "b.txt"), "beta\n");
  const ui = recorder();
  const agent = new Agent({ cfg, cwd, ui, model: { provider: "anthropic", id: "claude-opus-5-5" } });
  await agent.run("Combine a.txt and b.txt into out/sum.txt");
  await mock.close();

  assert.equal(fs.readFileSync(path.join(cwd, "out/sum.txt"), "utf8"), "alpha+beta\n");
  assert.deepEqual(ui.tools, ["read:ok", "read:ok", "write:ok"]);
  assert.match(ui.text, /Reading the two files\..*Done: wrote/s);
  assert.equal(ui.thinking, "I should look at both files first.");
  assert.equal(ui.permissions.length, 1, "only the write needs approval");
  assert.equal(ui.permissions[0].tool, "write");

  const [r1, r2, r3] = mock.requests.map((r) => r.body);
  // Request shape
  assert.equal(r1.model, "claude-opus-5-5");
  assert.equal(r1.stream, true);
  assert.deepEqual(r1.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(r1.output_config, { effort: "high" });
  assert.deepEqual(r1.cache_control, { type: "ephemeral" });
  assert.deepEqual(r1.system[0].cache_control, { type: "ephemeral" });
  assert.equal(r1.fallbacks, "default");
  assert.equal(r1.context_management, undefined, "Forge compacts on its own, with a cheaper model");
  assert.match(String(mock.requests[0].headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  const clientTools = r1.tools.filter((t: any) => t.input_schema);
  assert.ok(clientTools.every((t: any) => t.eager_input_streaming === true));
  assert.deepEqual(clientTools.map((t: any) => t.name), [...clientTools.map((t: any) => t.name)].sort(), "tools are sorted");
  assert.ok(r1.tools.some((t: any) => t.type === "web_search_20260209"));

  // Append-only: every request repeats the previous one's system, tools and messages byte for byte.
  for (const [prev, next] of [[r1, r2], [r2, r3]]) {
    assert.equal(JSON.stringify(next.system), JSON.stringify(prev.system));
    assert.equal(JSON.stringify(next.tools), JSON.stringify(prev.tools));
    assert.equal(JSON.stringify(next.messages.slice(0, prev.messages.length)), JSON.stringify(prev.messages));
  }
  // The assistant turn goes back verbatim, thinking block and signature included.
  assert.equal(r2.messages[1].role, "assistant");
  assert.deepEqual(r2.messages[1].content[0], { type: "thinking", thinking: "I should look at both files first.", signature: "sig_1_0" });
  // Both results of the parallel round are in ONE user message, in call order.
  const results = r2.messages[2].content;
  assert.deepEqual(results.map((b: any) => [b.type, b.tool_use_id]), [["tool_result", "t1"], ["tool_result", "t2"]]);
  assert.match(results[0].content, /^1\talpha/);

  assert.ok(agent.stats.total.cacheRead > 0);
  assert.ok((agent.stats.cost ?? 0) > 0);
});

test("declined permission is reported to the model and nothing is written", async () => {
  const { mock, cfg, cwd } = await setup([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi > made.txt" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Okay, I will not." }] },
  ]);
  const ui = recorder(() => ({ allow: false, feedback: "do not create files" }));
  const agent = new Agent({ cfg, cwd, ui, model: { provider: "anthropic", id: "claude-opus-5-5" } });
  await agent.run("make a file");
  await mock.close();
  assert.equal(fs.existsSync(path.join(cwd, "made.txt")), false);
  const result = mock.requests[1].body.messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /declined.*do not create files/);
});

test("invalid tool input and unknown tools become error results instead of running", async () => {
  const { mock, cfg, cwd } = await setup([
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "read", input: { offset: 3 } },
        { type: "tool_use", id: "t2", name: "nope", input: {} },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
  ]);
  const agent = new Agent({ cfg, cwd, ui: recorder(), model: { provider: "anthropic", id: "claude-opus-5-5" } });
  await agent.run("go");
  await mock.close();
  const [a, b] = mock.requests[1].body.messages[2].content;
  assert.match(a.content, /Missing required parameter `path`/);
  assert.match(b.content, /Unknown tool `nope`/);
});

test("a tool call cut off by max_tokens is not executed", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      { stop_reason: "max_tokens", content: [{ type: "tool_use", id: "t1", name: "write", input: { path: "x.txt", content: "partial" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
    ],
    "yolo",
  );
  const agent = new Agent({ cfg, cwd, ui: recorder(), model: { provider: "anthropic", id: "claude-opus-5-5" } });
  await agent.run("go");
  await mock.close();
  assert.equal(fs.existsSync(path.join(cwd, "x.txt")), false);
  assert.match(mock.requests[1].body.messages[2].content[0].content, /cut off by the output limit/);
});

test("an optional feature rejected with a 400 is dropped and the turn retried", async () => {
  const { mock, cfg, cwd } = await setup([
    { stop_reason: "", content: [], error: { status: 400, message: "fallbacks: Extra inputs are not permitted" } },
    { stop_reason: "end_turn", content: [{ type: "text", text: "hello" }] },
  ]);
  const ui = recorder();
  const agent = new Agent({ cfg, cwd, ui, model: { provider: "anthropic", id: "claude-opus-5-5" } });
  await agent.run("hi");
  await mock.close();
  assert.equal(ui.text, "hello");
  assert.equal(mock.requests[1].body.fallbacks, undefined);
  assert.equal(mock.requests[1].body.context_management, undefined);
  assert.ok(ui.notices.some((n) => /optional feature/.test(n)));
});

test("sub-agent runs with a fresh context and returns only its report", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "task", input: { description: "count files", prompt: "Count the files." } }] },
      // sub-agent turns
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "s1", name: "glob", input: { pattern: "*.txt" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "There is 1 text file." }] },
      // main agent again
      { stop_reason: "end_turn", content: [{ type: "text", text: "The sub-agent found 1 file." }] },
    ],
    "yolo",
  );
  fs.writeFileSync(path.join(cwd, "only.txt"), "x");
  const agent = new Agent({ cfg, cwd, ui: recorder(), model: { provider: "anthropic", id: "claude-opus-5-5" } });
  await agent.run("how many files?");
  await mock.close();
  const sub = mock.requests[1].body;
  assert.equal(sub.messages.length, 1);
  // The brief, then the team section every sub-agent gets.
  assert.match(sub.messages[0].content, /^Count the files\.\n\n# Your team\n\nYou are sub-agent ag1\./);
  assert.ok(!sub.tools.some((t: any) => t.name === "task"), "no nested sub-agents");
  assert.match(sub.system[0].text, /sub-agent of Forge/);
  const main = mock.requests[3].body;
  assert.equal(main.messages[2].content[0].content, "There is 1 text file.");
});

test("a message typed mid-run is delivered with the tool results", async () => {
  const { mock, cfg, cwd } = await setup(
    [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "glob", input: { pattern: "*" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
    ],
    "yolo",
  );
  const agent = new Agent({ cfg, cwd, ui: recorder(), model: { provider: "anthropic", id: "claude-opus-5-5" } });
  agent.steering.push("also check the README");
  await agent.run("go");
  await mock.close();
  const content = mock.requests[1].body.messages[2].content;
  assert.equal(content[0].type, "tool_result");
  assert.match(content[1].text, /also check the README/);
});

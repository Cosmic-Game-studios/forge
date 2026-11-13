// The advisor: a cheap working model may ask an expensive one on hard problems.
// Off by default; limited per request.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, type AgentUI } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { startMock, type ScriptTurn } from "./mock-anthropic.ts";

const isAdvisor = (b: any) => JSON.stringify(b.system ?? "").includes("senior advisor");
const toolNames = (b: any) => (b.tools ?? []).map((t: any) => t.name);

async function run(script: ScriptTurn[], extra: Partial<Config>) {
  const mock = await startMock(script);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  delete process.env.ANTHROPIC_API_KEY;
  const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: "yolo", webTools: true, showThinking: true, prepare: false, watch: false, review: false, autoCheck: false, ...extra };
  const notices: string[] = [];
  let text = "";
  const ui: AgentUI = {
    onText: (d) => void (text += d), onThinking: () => {}, onAssistantEnd: () => {}, onToolPending: () => {}, onToolProgress: () => {},
    onToolStart: () => {}, onToolLive: () => {}, onToolEnd: () => {}, onServerTool: () => {}, onNotice: (m) => void notices.push(m), onStats: () => {},
    askPermission: async () => ({ allow: true }),
  };
  const agent = new Agent({ cfg, cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-proj-")), ui, model: { provider: "anthropic", id: "claude-haiku-5-5" }, resume: null });
  await agent.run("fix the flaky orbit test");
  agent.close();
  await mock.close();
  return { mock, notices, text, agent };
}

test("off by default: the working model is not even offered the advisor", async () => {
  const { mock } = await run([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }], {});
  assert.ok(!toolNames(mock.requests[0].body).includes("advisor"));
});

test("switched on: Haiku asks Fable, which answers from the conversation record, and the advice reaches Haiku", async () => {
  const { mock, notices, text } = await run(
    [
      { when: (b) => !isAdvisor(b) && b.messages.length === 1, stop_reason: "tool_use", content: [{ type: "tool_use", id: "a1", name: "advisor", input: { question: "The orbit drifts outward after 1000 steps. I tried a smaller dt. Why?" } }] },
      { when: isAdvisor, stop_reason: "end_turn", content: [{ type: "text", text: "Explicit Euler adds energy. Switch to velocity Verlet in physics.js." }] },
      { when: (b) => !isAdvisor(b) && b.messages.length === 3, stop_reason: "end_turn", content: [{ type: "text", text: "Switched to Verlet." }] },
    ],
    { advisor: "anthropic:claude-fable-5-2" },
  );
  const main = mock.requests.filter((r) => !isAdvisor(r.body));
  const adv = mock.requests.filter((r) => isAdvisor(r.body));
  assert.ok(toolNames(main[0].body).includes("advisor"));
  assert.equal(main[0].body.model, "claude-haiku-5-5");
  assert.equal(adv.length, 1);
  assert.equal(adv[0].body.model, "claude-fable-5-2");
  assert.equal((adv[0].body.tools ?? []).length, 0, "the advisor runs no tools");
  const brief = JSON.stringify(adv[0].body.messages);
  assert.match(brief, /running on Claude Haiku 5\.5/);
  assert.match(brief, /orbit drifts outward/);
  assert.match(brief, /fix the flaky orbit test/, "the advisor sees the conversation record");
  const result = JSON.stringify(main[1].body.messages.at(-1));
  assert.match(result, /Advice from Claude Fable 5\.2/);
  assert.match(result, /velocity Verlet/);
  assert.ok(notices.some((n) => /Asking Claude Fable 5\.2 for advice \(1\/3 this request\) - an expensive request/.test(n)));
  assert.match(text, /Switched to Verlet/);
});

test("the limit per request holds, and an advisor equal to the working model stays inactive", async () => {
  const { mock } = await run(
    [
      { when: (b) => !isAdvisor(b) && b.messages.length === 1, stop_reason: "tool_use", content: [{ type: "tool_use", id: "a1", name: "advisor", input: { question: "first" } }] },
      { when: isAdvisor, stop_reason: "end_turn", content: [{ type: "text", text: "Try A." }] },
      { when: (b) => !isAdvisor(b) && b.messages.length === 3, stop_reason: "tool_use", content: [{ type: "tool_use", id: "a2", name: "advisor", input: { question: "second" } }] },
      { when: (b) => !isAdvisor(b) && b.messages.length === 5, stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
    ],
    { advisor: "anthropic:claude-fable-5-2", advisorLimit: 1 },
  );
  assert.equal(mock.requests.filter((r) => isAdvisor(r.body)).length, 1);
  assert.match(JSON.stringify(mock.requests.at(-1)!.body.messages.at(-1)), /already been asked 1 time in this request, the limit/);

  const same = await run([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }], { advisor: "anthropic:claude-haiku-5-5" });
  assert.ok(!toolNames(same.mock.requests[0].body).includes("advisor"));
});

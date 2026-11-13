// Pair mode: two different models discuss, agree on a plan that splits the
// work, then code at the same time and talk until both parts are done.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, type AgentUI } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { discuss } from "../src/pair.ts";
import { startMock } from "./mock-anthropic.ts";

const isDisc = (b: any) => JSON.stringify(b.system ?? "").includes("pair-program on a task as equals");
const isSub = (b: any) => JSON.stringify(b.system ?? "").includes("sub-agent of Forge");
const has = (b: any, s: string) => JSON.stringify(b.messages).includes(s);
const HAIKU = "claude-haiku-5-5";
const OPUS = "claude-opus-5-5";

test("the discussion: proposals, a critique round, and the plan; agreement on both sides ends it early", async () => {
  const said: string[] = [];
  const ask = async (side: "lead" | "partner", _s: string, prompt: string) => {
    said.push(`${side}:${prompt.includes("Propose") ? "proposal" : prompt.includes("Compare") ? "critique" : "plan"}`);
    return prompt.includes("Compare") ? "AGREE - same idea" : "idea";
  };
  const d = await discuss(ask, "task", "", { name: "A" }, { name: "B" }, 3);
  // Three rounds allowed, but both agreed after the first.
  assert.deepEqual(said, ["lead:proposal", "partner:proposal", "lead:critique", "partner:critique", "lead:plan"]);
  assert.equal(d.turns.at(-1)!.phase, "plan");
});

test("pair mode: Haiku and Opus discuss, split the work, both write their part and talk, and the request ends when both are done", async () => {
  const plan = "## Approach\nAn LRU cache.\n\n## Claude Haiku 5.5 (lead) does\n- cache.js\n\n## Claude Opus 5.5 (partner) does\n- cache.test.js\n\n## Shared\n- get(key), set(key, value)";
  const mock = await startMock([
    { when: (b) => isDisc(b) && b.model === HAIKU && has(b, "Propose how"), stop_reason: "end_turn", content: [{ type: "text", text: "Use a plain Map as the cache." }] },
    { when: (b) => isDisc(b) && b.model === OPUS && has(b, "Propose how"), stop_reason: "end_turn", content: [{ type: "text", text: "Use an LRU cache with a size limit." }] },
    { when: (b) => isDisc(b) && b.model === HAIKU && has(b, "Compare the two"), stop_reason: "end_turn", content: [{ type: "text", text: "DIFFER: the LRU limit is better, I take it." }] },
    { when: (b) => isDisc(b) && b.model === OPUS && has(b, "Compare the two"), stop_reason: "end_turn", content: [{ type: "text", text: "AGREE - LRU with a limit." }] },
    { when: (b) => isDisc(b) && b.model === HAIKU && has(b, "Write the plan"), stop_reason: "end_turn", content: [{ type: "text", text: plan }] },
    {
      when: (b) => isSub(b) && b.model === OPUS && b.messages.length === 1,
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "p1", name: "write", input: { path: "cache.test.js", content: "// tests for get/set\n" } },
        { type: "tool_use", id: "p2", name: "message", input: { to: "main", text: "cache.test.js is written against get/set." } },
      ],
    },
    { when: (b) => isSub(b) && b.model === OPUS && b.messages.length === 3, stop_reason: "end_turn", content: [{ type: "text", text: "REPORT: wrote cache.test.js." }] },
    { when: (b) => !isDisc(b) && !isSub(b) && b.messages.length === 1, stop_reason: "tool_use", content: [{ type: "tool_use", id: "m1", name: "write", input: { path: "cache.js", content: "export class LRU {}\n" } }] },
    { when: (b) => !isDisc(b) && !isSub(b) && has(b, "REPORT: wrote cache.test.js"), stop_reason: "end_turn", content: [{ type: "text", text: "Both parts are done." }] },
    // The partner's message may reach the lead after it ended its turn: it then takes one more step.
    ...[1, 2, 3].map(() => ({ when: (b: any) => !isDisc(b) && !isSub(b) && !has(b, "REPORT: wrote"), stop_reason: "end_turn", content: [{ type: "text" as const, text: "My part is done." }] })),
  ]);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  delete process.env.ANTHROPIC_API_KEY;
  const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: "yolo", webTools: true, showThinking: true, prepare: false, watch: false, review: false, autoCheck: false, pair: `anthropic:${OPUS}` };
  const turns: string[] = [];
  const partnerTools: string[] = [];
  let text = "";
  const ui: AgentUI = {
    onText: (d) => void (text += d), onThinking: () => {}, onAssistantEnd: () => {}, onToolPending: () => {}, onToolProgress: () => {},
    onToolStart: () => {}, onToolLive: () => {}, onToolEnd: () => {}, onServerTool: () => {}, onNotice: () => {}, onStats: () => {},
    onPairTurn: (who, phase) => void turns.push(`${who}:${phase}`),
    onPartnerTool: (job, call) => void partnerTools.push(`${job.partner}:${call.name}`),
    askPermission: async () => ({ allow: true }),
  };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-proj-"));
  const agent = new Agent({ cfg, cwd, ui, model: { provider: "anthropic", id: HAIKU }, resume: null });
  await agent.run("add a cache for the API client");
  agent.close();
  await mock.close();

  assert.deepEqual(turns, [
    "Claude Haiku 5.5:proposal",
    "Claude Opus 5.5:proposal",
    "Claude Haiku 5.5:critique",
    "Claude Opus 5.5:critique",
    "Claude Haiku 5.5:plan",
  ]);
  // Each side saw the other's position in the critique round.
  const critique = mock.requests.find((r) => isDisc(r.body) && r.body.model === OPUS && has(r.body, "Compare the two"))!;
  assert.ok(has(critique.body, "plain Map"));
  // Both parts were written, each by its model.
  assert.ok(fs.existsSync(path.join(cwd, "cache.js")));
  assert.ok(fs.existsSync(path.join(cwd, "cache.test.js")));
  assert.deepEqual(partnerTools, ["Claude Opus 5.5:write", "Claude Opus 5.5:message"]);
  // The lead got the plan and its partner's id; the partner got the plan and works on Opus.
  const main = mock.requests.filter((r) => !isDisc(r.body) && !isSub(r.body));
  assert.equal(main[0].body.model, HAIKU);
  assert.match(main[0].body.messages[0].content, /Forge pair mode: you \(Claude Haiku 5\.5\) work on this request together with Claude Opus 5\.5, who is running right now as agent `ag1`/);
  assert.match(main[0].body.messages[0].content, /An LRU cache/);
  const partner = mock.requests.filter((r) => isSub(r.body));
  assert.ok(partner.every((r) => r.body.model === OPUS));
  assert.match(partner[0].body.messages[0].content, /Do the part marked for Claude Opus 5\.5/);
  // The partner's message and report reached the lead, which ended only after both.
  assert.ok(main.some((r) => has(r.body, "cache.test.js is written against get/set")));
  assert.match(text, /Both parts are done\./);
});

test("pair mode stays off by default and pauses when both sides are the same model", async () => {
  const mock = await startMock([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }, { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  for (const pair of [undefined, `anthropic:${HAIKU}`]) {
    const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: "yolo", webTools: true, showThinking: true, prepare: false, watch: false, review: false, autoCheck: false, pair };
    const noop = () => {};
    const ui: AgentUI = { onText: noop, onThinking: noop, onAssistantEnd: noop, onToolPending: noop, onToolProgress: noop, onToolStart: noop, onToolLive: noop, onToolEnd: noop, onServerTool: noop, onNotice: noop, onStats: noop, askPermission: async () => ({ allow: true }) };
    const agent = new Agent({ cfg, cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-proj-")), ui, model: { provider: "anthropic", id: HAIKU }, resume: null });
    assert.equal(agent.pairModel(), null);
    await agent.run("hi");
    agent.close();
  }
  await mock.close();
  assert.equal(mock.requests.length, 2, "no discussion, no partner");
  assert.ok(mock.requests.every((r) => !isDisc(r.body)));
});

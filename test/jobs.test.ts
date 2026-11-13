// Background jobs: shell commands that keep running, and sub-agents that work
// alongside the main agent and report when they are done.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, type AgentUI } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { Jobs } from "../src/jobs.ts";
import { buildTools } from "../src/tools/index.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { startMock } from "./mock-anthropic.ts";

function ctx(jobs: Jobs): ToolContext {
  return {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-jobs-")),
    signal: new AbortController().signal,
    fileState: new Map(),
    readSeen: new Map(),
    todos: [],
    jobs,
    runSubagent: async () => "",
    progress: () => {},
  };
}

const tools = buildTools({ subagent: false });
const bash = tools.get("bash")!;
const jobsTool = tools.get("jobs")!;
const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));

test("a background command returns at once, keeps running, and its later output can be read", async () => {
  const jobs = new Jobs();
  const c = ctx(jobs);
  const started = Date.now();
  const out = await bash.run({ command: "echo first; sleep 4; echo second", background: true }, c);
  assert.ok(Date.now() - started < 3900, "the tool waited for the command to end");
  assert.match(text(out.content), /running in the background as job sh1/);
  assert.match(text(out.content), /first/);
  assert.equal(jobs.running("shell").length, 1);

  const later = await jobsTool.run({ action: "output", id: "sh1", wait: 20 }, c);
  assert.match(text(later.content), /second/);
  // The first line names the job (its command contains "first"); the rest is new output.
  assert.doesNotMatch(text(later.content).split(/\n/).slice(1).join(" "), /first/, "output already shown is not repeated");
  assert.match(text(later.content), /done after .*exit code 0/);
  assert.equal(jobs.running().length, 0);
  assert.equal(jobs.unreported().length, 0, "reading the final output counts as reporting it");
});

test("a background command can be stopped, and stopAll ends what is left", async () => {
  const jobs = new Jobs();
  const c = ctx(jobs);
  await bash.run({ command: "sleep 60", background: true }, c);
  await bash.run({ command: "sleep 60", background: true }, c);
  const stopped = await jobsTool.run({ action: "stop", id: "sh1" }, c);
  assert.match(text(stopped.content), /sh1: command `sleep 60`, stopped/);
  const list = await jobsTool.run({ action: "list" }, c);
  assert.match(text(list.content), /sh1: .*stopped/);
  assert.match(text(list.content), /sh2: .*running/);
  jobs.stopAll();
  await Promise.all(jobs.list().map((j) => j.done));
  assert.equal(jobs.running().length, 0);
  const unknown = await jobsTool.run({ action: "output", id: "sh9" }, c);
  assert.equal(unknown.isError, true);
  assert.match(text(unknown.content), /Known jobs: sh1, sh2/);
});

test("a background sub-agent works while the main agent goes on, and its report arrives before the request ends", async () => {
  const isSub = (b: any) => String(JSON.stringify(b.system)).includes("sub-agent of Forge");
  const mock = await startMock([
    {
      when: (b) => !isSub(b) && b.messages.length === 1,
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "task", input: { description: "Find the config loader", prompt: "Where is the config loaded?", background: true } }],
    },
    {
      when: isSub,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "REPORT: config is loaded in src/config.ts line 12." }],
    },
    {
      when: (b) => !isSub(b) && b.messages.length === 3,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Started the search; waiting for it." }],
    },
    {
      when: (b) => !isSub(b) && b.messages.length === 5,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "The config loader is in src/config.ts." }],
    },
  ]);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  delete process.env.ANTHROPIC_API_KEY;
  const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: "yolo", webTools: true, showThinking: true, prepare: false, watch: false, review: false, autoCheck: false };
  const notices: string[] = [];
  let text = "";
  const ui: AgentUI = {
    onText: (d) => void (text += d),
    onThinking: () => {},
    onAssistantEnd: () => {},
    onToolPending: () => {},
    onToolProgress: () => {},
    onToolStart: () => {},
    onToolLive: () => {},
    onToolEnd: () => {},
    onServerTool: () => {},
    onNotice: (m) => void notices.push(m),
    onStats: () => {},
    askPermission: async () => ({ allow: true }),
  };
  const agent = new Agent({ cfg, cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-proj-")), ui, model: { provider: "anthropic", id: "claude-opus-5-5" }, resume: null });
  await agent.run("where is the config loaded?");
  agent.close();
  await mock.close();

  const main = mock.requests.filter((r) => !isSub(r.body));
  assert.equal(main.length, 3, "the main agent got one more turn for the report");
  const last = JSON.stringify(main[2].body.messages.at(-1));
  assert.match(last, /background ag1: sub-agent \\"Find the config loader\\", done/);
  assert.match(last, /REPORT: config is loaded in src\/config\.ts/);
  assert.match(text, /The config loader is in src\/config\.ts\./);
  assert.ok(notices.some((n) => /Waiting for 1 background sub-agent/.test(n)) || main.length === 3);
  const job = agent.jobs.get("ag1")!;
  assert.equal(job.status, "done");
  assert.equal(job.calls, 0);
});

test("team mailboxes: direct messages, sharing with all, waiting for a reply", async () => {
  const { Team } = await import("../src/team.ts");
  let live = ["main", "ag1", "ag2"];
  const team = new Team(() => live);
  assert.match(team.send("ag1", "ag7", "hi")!, /not an active agent\. Active: main, ag2/);
  assert.equal(team.send("ag1", "ag2", "port is 5173"), null);
  assert.equal(team.send("ag1", "all", "config lives in src/config.ts"), null);
  assert.deepEqual(team.take("ag2").map((m) => m.text), ["port is 5173", "config lives in src/config.ts"]);
  assert.deepEqual(team.take("main").map((m) => m.text), ["config lives in src/config.ts"]);
  assert.equal(team.take("ag1").length, 0, "a broadcast does not come back to its sender");
  assert.match(team.shared(), /- ag1: config lives in src\/config\.ts/);
  const waited = team.waitFor("ag1", 5000);
  setTimeout(() => team.send("main", "ag1", "go ahead"), 50);
  const t0 = Date.now();
  await waited;
  assert.ok(Date.now() - t0 < 2000, "waiting ends when the reply arrives");
  assert.equal(team.take("ag1")[0].text, "go ahead");
  live = ["main"];
  assert.match(team.send("main", "ag1", "late")!, /not an active agent\. No other agent is active/);
});

test("parallel sub-agents message each other, and what is shared with all reaches the main agent", async () => {
  const isSub = (b: any) => String(JSON.stringify(b.system)).includes("sub-agent of Forge");
  const has = (b: any, s: string) => JSON.stringify(b.messages).includes(s);
  const mock = await startMock([
    {
      when: (b) => !isSub(b) && b.messages.length === 1,
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "task", input: { description: "Task A", prompt: "Task A: find the port." } },
        { type: "tool_use", id: "t2", name: "task", input: { description: "Task B", prompt: "Task B: write the client." } },
      ],
    },
    {
      when: (b) => isSub(b) && has(b, "Task A") && b.messages.length === 1,
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "a1", name: "message", input: { to: "ag2", text: "the server listens on port 5173" } },
        { type: "tool_use", id: "a2", name: "message", input: { to: "all", text: "config lives in src/config.ts" } },
      ],
    },
    { when: (b) => isSub(b) && has(b, "Task A") && b.messages.length === 3, stop_reason: "end_turn", content: [{ type: "text", text: "A: port 5173." }] },
    {
      when: (b) => isSub(b) && has(b, "Task B") && b.messages.length === 1,
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "b1", name: "bash", input: { command: "node -e \"setTimeout(() => {}, 1500)\"" } }],
    },
    { when: (b) => isSub(b) && has(b, "Task B") && b.messages.length === 3, stop_reason: "end_turn", content: [{ type: "text", text: "B: client uses 5173." }] },
    { when: (b) => !isSub(b) && b.messages.length === 3, stop_reason: "end_turn", content: [{ type: "text", text: "Both done." }] },
  ]);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  delete process.env.ANTHROPIC_API_KEY;
  const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: "yolo", webTools: true, showThinking: true, prepare: false, watch: false, review: false, autoCheck: false };
  const seen: string[] = [];
  const ui: AgentUI = {
    onText: () => {}, onThinking: () => {}, onAssistantEnd: () => {}, onToolPending: () => {}, onToolProgress: () => {},
    onToolStart: () => {}, onToolLive: () => {}, onToolEnd: () => {}, onServerTool: () => {}, onNotice: () => {}, onStats: () => {},
    onMessage: (m) => void seen.push(`${m.from}->${m.to}`),
    askPermission: async () => ({ allow: true }),
  };
  const agent = new Agent({ cfg, cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-proj-")), ui, model: { provider: "anthropic", id: "claude-opus-5-5" }, resume: null });
  await agent.run("build the client");
  agent.close();
  await mock.close();

  const subB = mock.requests.filter((r) => isSub(r.body) && has(r.body, "Task B"));
  assert.equal(subB.length, 2);
  // B's next step carries both messages as a text block after its tool result.
  const bNext = subB[1].body.messages.at(-1).content.find((b: any) => b.type === "text").text as string;
  assert.ok(bNext.includes("[Message from ag1]\nthe server listens on port 5173"), bNext);
  assert.ok(bNext.includes("[Message from ag1 to all agents]\nconfig lives in src/config.ts"), bNext);
  const main = mock.requests.filter((r) => !isSub(r.body));
  assert.equal(main.length, 2);
  assert.match(JSON.stringify(main[1].body.messages.at(-1)), /Message from ag1 to all agents/);
  // Sub-agent B's brief named A as a teammate.
  assert.match(JSON.stringify(subB[0].body.messages[0]), /ag1 \(\\"Task A\\"\)/);
  assert.deepEqual(seen, ["ag1->ag2", "ag1->all"]);
  assert.equal(agent.team.board.length, 1);
});

test("a background sub-agent asks the main agent, which wakes up, answers, and then gets the report", async () => {
  const isSub = (b: any) => String(JSON.stringify(b.system)).includes("sub-agent of Forge");
  const has = (b: any, s: string) => JSON.stringify(b.messages).includes(s);
  const mock = await startMock([
    { when: (b) => !isSub(b) && b.messages.length === 1, stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "task", input: { description: "Wire the client", prompt: "Wire the client.", background: true } }] },
    { when: (b) => !isSub(b) && b.messages.length === 3, stop_reason: "end_turn", content: [{ type: "text", text: "The sub-agent is on it." }] },
    { when: (b) => isSub(b) && b.messages.length === 1, stop_reason: "tool_use", content: [{ type: "tool_use", id: "s1", name: "message", input: { to: "main", text: "Which port should the client use?", wait: 20 } }] },
    { when: (b) => !isSub(b) && has(b, "Which port should the client use?") && !has(b, "REPORT"), stop_reason: "tool_use", content: [{ type: "tool_use", id: "m1", name: "message", input: { to: "ag1", text: "Use 5173." } }] },
    { when: (b) => isSub(b) && b.messages.length === 3, stop_reason: "end_turn", content: [{ type: "text", text: "REPORT: client wired to 5173." }] },
    { when: (b) => !isSub(b) && has(b, "REPORT"), stop_reason: "end_turn", content: [{ type: "text", text: "Done: the client uses 5173." }] },
    { when: (b) => !isSub(b), stop_reason: "end_turn", content: [{ type: "text", text: "Waiting for the report." }] },
  ]);
  process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
  process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  delete process.env.ANTHROPIC_API_KEY;
  const cfg: Config = { keys: { anthropic: `test-key-${Math.random()}` }, effort: "high", permissionMode: "yolo", webTools: true, showThinking: true, prepare: false, watch: false, review: false, autoCheck: false };
  let text = "";
  const ui: AgentUI = {
    onText: (d) => void (text += d), onThinking: () => {}, onAssistantEnd: () => {}, onToolPending: () => {}, onToolProgress: () => {},
    onToolStart: () => {}, onToolLive: () => {}, onToolEnd: () => {}, onServerTool: () => {}, onNotice: () => {}, onStats: () => {},
    askPermission: async () => ({ allow: true }),
  };
  const agent = new Agent({ cfg, cwd: fs.mkdtempSync(path.join(os.tmpdir(), "forge-proj-")), ui, model: { provider: "anthropic", id: "claude-opus-5-5" }, resume: null });
  const t0 = Date.now();
  await agent.run("wire the client");
  agent.close();
  await mock.close();

  assert.ok(Date.now() - t0 < 15_000, "nobody waited for a timeout");
  const sub = mock.requests.filter((r) => isSub(r.body));
  assert.equal(sub.length, 2);
  // The answer came back as the result of the sub-agent's message call.
  const result = sub[1].body.messages.at(-1).content.find((b: any) => b.type === "tool_result").content as string;
  assert.ok(result.includes("[Message from main]\nUse 5173."), result);
  assert.match(text, /Done: the client uses 5173\./);
  assert.equal(agent.jobs.get("ag1")!.status, "done");
});

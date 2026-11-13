// Forge benchmark: every task runs once per configuration and repetition, in a
// fresh folder, headless. Afterwards a hidden test decides pass or fail.
//
//   node bench/run.mjs --selfcheck          verify the tasks themselves (no model, no cost)
//   node bench/run.mjs [--reps 3] [--model anthropic:claude-haiku-5-5] [--only name] [--jobs 4]
//
// Configurations:  baseline = the usual tools only (read, write, edit, glob, grep, bash, todo)
//                  full     = everything Forge has (outline, deps, multi_edit, check, automatic checks, skills)
// The API key is taken from your Forge config or the environment; it is never printed.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TASKS } from "./tasks.mjs";

const root = path.dirname(import.meta.dirname);
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const reps = Number(opt("reps", 3));
const jobs = Number(opt("jobs", 4));
const model = opt("model", "anthropic:claude-haiku-5-5");
const only = opt("only", "");
const tasks = TASKS.filter((t) => !only || t.name === only);

function project(task, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-bench-${task.name}-`));
  for (const [rel, text] of Object.entries({ ...task.files, ...extra })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function hiddenTest(task, dir) {
  for (const [rel, text] of Object.entries(task.hidden(task.files))) fs.writeFileSync(path.join(dir, rel), text);
  const res = spawnSync(process.execPath, ["__hidden.test.js"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  return { pass: res.status === 0, why: res.status === 0 ? "" : (res.stderr || "").split("\n").find((l) => /Error|assert/i.test(l)) ?? "failed" };
}

if (args.includes("--selfcheck")) {
  let bad = 0;
  for (const t of TASKS) {
    const before = hiddenTest(t, project(t)).pass;
    const after = hiddenTest(t, project(t, t.solution));
    const ok = !before && after.pass;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "} ${t.name}: fails before = ${!before}, passes with the reference solution = ${after.pass} ${after.why}`);
  }
  process.exit(bad ? 1 : 0);
}

const userConfig = path.join(process.env.FORGE_HOME || path.join(os.homedir(), ".forge"), "config.json");
let key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  try {
    key = JSON.parse(fs.readFileSync(userConfig, "utf8")).keys?.anthropic;
  } catch {}
}
if (!key) {
  console.error("No Anthropic API key found (Forge config or ANTHROPIC_API_KEY).");
  process.exit(2);
}

function runOne(task, config, rep) {
  return new Promise((resolve) => {
    const dir = project(task);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bench-home-"));
    // Its own settings folder: the benchmark never touches your Forge settings or sessions.
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ keys: {}, model, effort: "medium", permissionMode: "yolo", webTools: false, showThinking: false, budget: 0.5 }));
    const stats = path.join(home, "stats.json");
    const env = { ...process.env, ANTHROPIC_API_KEY: key, FORGE_HOME: home, FORGE_STATS_FILE: stats, NO_COLOR: "1" };
    delete env.FORGE_ANTHROPIC_BASE_URL;
    if (config === "baseline") env.FORGE_BASELINE = "1";
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(root, "dist", "main.js"), "-p", task.prompt], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const timer = setTimeout(() => child.kill(), 8 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let s = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, requests: 0 };
      try {
        s = JSON.parse(fs.readFileSync(stats, "utf8"));
      } catch {}
      const verdict = hiddenTest(task, dir);
      const tools = (log.match(/^\s*● (\S+)/gm) ?? []).length;
      const result = { task: task.name, config, rep, pass: verdict.pass, why: verdict.why, exit: code, seconds: Math.round((Date.now() - started) / 1000), requests: s.requests, tools, cost: s.cost, ...s.usage };
      fs.writeFileSync(path.join(root, "bench", "logs", `${task.name}-${config}-${rep}.log`), log);
      console.log(`${verdict.pass ? "pass" : "FAIL"}  ${task.name.padEnd(22)} ${config.padEnd(9)} #${rep}  ${String(result.seconds).padStart(3)}s  ${String(s.requests).padStart(2)} requests  $${(s.cost ?? 0).toFixed(4)}  ${verdict.why}`);
      resolve(result);
    });
  });
}

fs.mkdirSync(path.join(root, "bench", "logs"), { recursive: true });
const queue = [];
for (let rep = 1; rep <= reps; rep++) for (const t of tasks) for (const config of ["baseline", "full"]) queue.push([t, config, rep]);
console.log(`${queue.length} runs: ${tasks.length} tasks x 2 configurations x ${reps} repetitions on ${model}\n`);
const results = [];
await Promise.all(
  Array.from({ length: jobs }, async () => {
    for (let job; (job = queue.shift()); ) results.push(await runOne(...job));
  }),
);

const sum = (rows, f) => rows.reduce((n, r) => n + (f(r) || 0), 0);
const summary = {};
console.log("\nconfiguration  passed   requests/run  tool calls/run  input+cache tok/run  output tok/run  cost/run   seconds/run");
for (const config of ["baseline", "full"]) {
  const rows = results.filter((r) => r.config === config);
  const n = rows.length || 1;
  const s = (summary[config] = {
    runs: rows.length,
    passed: rows.filter((r) => r.pass).length,
    requests: sum(rows, (r) => r.requests) / n,
    tools: sum(rows, (r) => r.tools) / n,
    inputTokens: sum(rows, (r) => r.input + r.cacheRead + r.cacheWrite) / n,
    outputTokens: sum(rows, (r) => r.output) / n,
    cost: sum(rows, (r) => r.cost) / n,
    seconds: sum(rows, (r) => r.seconds) / n,
  });
  console.log(`${config.padEnd(13)}  ${`${s.passed}/${s.runs}`.padEnd(7)}  ${s.requests.toFixed(1).padStart(12)}  ${s.tools.toFixed(1).padStart(14)}  ${Math.round(s.inputTokens).toString().padStart(19)}  ${Math.round(s.outputTokens).toString().padStart(14)}  $${s.cost.toFixed(4)}  ${s.seconds.toFixed(0).padStart(11)}`);
}
console.log(`\ntotal cost of this benchmark run: $${sum(results, (r) => r.cost).toFixed(4)}`);
fs.writeFileSync(path.join(root, "bench", "results.json"), JSON.stringify({ model, reps, date: new Date().toISOString(), summary, results }, null, 2));

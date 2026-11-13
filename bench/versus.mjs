// Forge against Claude Code, same model, same hard tasks, hidden tests with partial credit.
//
//   node bench/versus.mjs --selfcheck                 verify the tasks (no model, no cost)
//   node bench/versus.mjs [--reps 2] [--jobs 4] [--only task] [--agents forge,claude] [--tag name]
//
// Both agents get the same prompt in a fresh copy of the project, run headless
// with permission to edit and run commands there, and are scored afterwards by
// a test they never see. The final src/ of every run is kept for code review.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.dirname(import.meta.dirname);
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const reps = Number(opt("reps", 2));
const jobs = Number(opt("jobs", 4));
const only = opt("only", "");
const agents = opt("agents", "forge,claude").split(",");
const tag = opt("tag", "run1");
const MODEL = "claude-haiku-5-5";
const EFFORT = opt("effort", "high");
// Price per million tokens used for BOTH agents (Forge's table), so the costs are comparable.
const PRICE = { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };

const TASKS = [];
for (const f of ["regex", "interp", "decimal", "dedupe", "bughunt"]) TASKS.push((await import(`./hard/${f}.mjs`)).default);
const tasks = TASKS.filter((t) => !only || only.split(",").includes(t.name));

const SCORE_HELPER = `const fs = require("node:fs");
const path = require("node:path");
exports.run = (cases) => {
  const state = { passed: 0, total: cases.reduce((n, c) => n + (c[2] || 1), 0), failed: [] };
  const save = () => fs.writeFileSync(path.join(__dirname, "__score.json"), JSON.stringify(state));
  save();
  for (const [name, fn, weight = 1] of cases) {
    try { fn(); state.passed += weight; } catch (e) { state.failed.push(name + " :: " + String((e && e.message) || e).split("\\n")[0].slice(0, 160)); }
    save();
  }
  console.log(state.passed + "/" + state.total);
};
`;

function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}
function project(task, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vs-${task.name}-`));
  write(dir, { ...task.files, ...extra });
  return dir;
}
/** Run the hidden test; the score survives a test that hangs or crashes half way. */
function grade(task, dir) {
  write(dir, { "__score.js": SCORE_HELPER, "__hidden.test.js": task.hidden });
  fs.rmSync(path.join(dir, "__score.json"), { force: true });
  spawnSync(process.execPath, ["__hidden.test.js"], { cwd: dir, encoding: "utf8", timeout: 180_000 });
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "__score.json"), "utf8"));
  } catch {
    return { passed: 0, total: 1, failed: ["the hidden test could not start"] };
  }
}

if (args.includes("--selfcheck")) {
  for (const t of TASKS) {
    const before = grade(t, project(t));
    const after = grade(t, project(t, t.solution));
    console.log(`${t.name.padEnd(20)} untouched ${before.passed}/${before.total}   reference ${after.passed}/${after.total}`);
    for (const f of after.failed) console.log("      reference fails: " + f);
  }
  process.exit(0);
}

let key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  try {
    key = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".forge", "config.json"), "utf8")).keys?.anthropic;
  } catch {}
}
const claudeExe = [path.join(os.homedir(), ".local", "bin", "claude.exe"), path.join(os.homedir(), ".local", "bin", "claude")].find((p) => fs.existsSync(p)) ?? "claude";

function launch(agent, task, dir, home) {
  if (agent === "forge") {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ keys: {}, model: `anthropic:${MODEL}`, effort: EFFORT, permissionMode: "yolo", webTools: false, showThinking: false, budget: 3 }));
    const env = { ...process.env, ANTHROPIC_API_KEY: key, FORGE_HOME: home, FORGE_STATS_FILE: path.join(home, "stats.json"), NO_COLOR: "1" };
    delete env.FORGE_ANTHROPIC_BASE_URL;
    return spawn(process.execPath, [path.join(root, "dist", "main.js"), "-p", task.prompt], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  }
  // Stock Claude Code: no personal MCP servers or user settings, edits and shell commands allowed.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const child = spawn(claudeExe, ["-p", "--model", MODEL, "--effort", EFFORT, "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--strict-mcp-config", "--setting-sources", "project"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(task.prompt);
  return child;
}

function usageOf(agent, home, log) {
  const u = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  try {
    if (agent === "forge") {
      const s = JSON.parse(fs.readFileSync(path.join(home, "stats.json"), "utf8"));
      Object.assign(u, s.usage, { requests: s.requests });
    } else {
      const r = JSON.parse(log.split("\n").find((l) => l.startsWith("{") && l.includes('"modelUsage"')));
      for (const m of Object.values(r.modelUsage ?? {})) {
        u.input += m.inputTokens;
        u.output += m.outputTokens;
        u.cacheRead += m.cacheReadInputTokens;
        u.cacheWrite += m.cacheCreationInputTokens;
      }
      u.requests = r.num_turns ?? 0;
      u.text = r.result;
    }
  } catch {}
  u.cost = (u.input * PRICE.in + u.output * PRICE.out + u.cacheRead * PRICE.cacheRead + u.cacheWrite * PRICE.cacheWrite) / 1e6;
  return u;
}

function snapshot(dir, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const p = String(rel).split(path.sep).join("/");
    if (/^(node_modules|\.git|\.claude)\//.test(p) || /^__/.test(p)) continue;
    const abs = path.join(dir, p);
    if (!fs.statSync(abs).isFile() || fs.statSync(abs).size > 300_000) continue;
    fs.mkdirSync(path.dirname(path.join(dest, p)), { recursive: true });
    fs.copyFileSync(abs, path.join(dest, p));
  }
}

function runOne(task, agent, rep) {
  return new Promise((resolve) => {
    const dir = project(task);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-home-"));
    const started = Date.now();
    const child = launch(agent, task, dir, home);
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const timer = setTimeout(() => child.kill(), 25 * 60_000);
    child.on("error", (e) => (log += `\nspawn error: ${e.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - started) / 1000);
      const out = path.join(root, "bench", "versus", tag, `${task.name}__${agent}__${rep}`);
      snapshot(dir, out);
      fs.writeFileSync(out + ".log", log);
      const s = grade(task, dir);
      const u = usageOf(agent, home, log);
      delete u.text;
      const srcLines = fs.readdirSync(path.join(out, "src"), { recursive: true }).filter((f) => String(f).endsWith(".js")).reduce((n, f) => n + fs.readFileSync(path.join(out, "src", String(f)), "utf8").split("\n").length, 0);
      const result = { task: task.name, agent, rep, score: s.passed / s.total, passed: s.passed, total: s.total, failed: s.failed, exit: code, seconds, srcLines, ...u };
      console.log(`${task.name.padEnd(20)} ${agent.padEnd(7)} #${rep}  ${String(Math.round(result.score * 100)).padStart(3)}%  (${s.passed}/${s.total})  ${String(seconds).padStart(4)}s  ${String(u.requests).padStart(3)} turns  $${u.cost.toFixed(4)}  ${srcLines} lines`);
      resolve(result);
    });
  });
}

fs.mkdirSync(path.join(root, "bench", "versus", tag), { recursive: true });
const queue = [];
for (let rep = 1; rep <= reps; rep++) for (const t of tasks) for (const a of agents) queue.push([t, a, rep]);
console.log(`${queue.length} runs: ${tasks.length} tasks x ${agents.join(" / ")} x ${reps} repetitions, ${MODEL}, effort ${EFFORT}\n`);
const results = [];
await Promise.all(
  Array.from({ length: jobs }, async () => {
    for (let job; (job = queue.shift()); ) results.push(await runOne(...job));
  }),
);

const avg = (rows, f) => (rows.length ? rows.reduce((n, r) => n + f(r), 0) / rows.length : 0);
console.log(`\n${"task".padEnd(20)} ${agents.map((a) => a.padStart(9)).join(" ")}`);
for (const t of tasks) console.log(`${t.name.padEnd(20)} ${agents.map((a) => `${Math.round(avg(results.filter((r) => r.task === t.name && r.agent === a), (r) => r.score) * 100)}%`.padStart(9)).join(" ")}`);
const summary = {};
for (const a of agents) {
  const rows = results.filter((r) => r.agent === a);
  summary[a] = { score: avg(rows, (r) => r.score), solved: rows.filter((r) => r.score === 1).length, runs: rows.length, seconds: avg(rows, (r) => r.seconds), cost: avg(rows, (r) => r.cost), turns: avg(rows, (r) => r.requests), tokensIn: avg(rows, (r) => r.input + r.cacheRead + r.cacheWrite), tokensOut: avg(rows, (r) => r.output) };
  const s = summary[a];
  console.log(`\n${a}: average score ${(s.score * 100).toFixed(1)}%, fully solved ${s.solved}/${s.runs}, ${s.seconds.toFixed(0)}s, ${s.turns.toFixed(1)} turns, ${Math.round(s.tokensIn)} in / ${Math.round(s.tokensOut)} out tokens, $${s.cost.toFixed(4)} per run`);
}
fs.writeFileSync(path.join(root, "bench", "versus", tag, "results.json"), JSON.stringify({ model: MODEL, effort: EFFORT, reps, date: new Date().toISOString(), summary, results }, null, 2));

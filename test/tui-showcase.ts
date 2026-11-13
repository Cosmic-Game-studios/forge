// Plays a scripted multi-step session through the real interactive app and
// writes what a terminal shows at a few moments as colored HTML pages.
// Usage: node test/tui-showcase.ts <out-dir>
// Used to look at the transcript design; not part of the test suite.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import xterm from "@xterm/headless";
import { startMock } from "./mock-anthropic.ts";

const COLS = 100;
const ROWS = 36;
const outDir = path.resolve(process.argv[2] ?? "showcase");
fs.mkdirSync(outDir, { recursive: true });

const plan = (s: string[]) => ({
  todos: [
    { content: "Read the upload route", status: s[0] },
    { content: "Add a rate limiter to the route", status: s[1] },
    { content: "Cover it with a test and run the suite", status: s[2] },
  ],
});

const mock = await startMock([
  {
    stop_reason: "tool_use",
    content: [
      {
        type: "thinking",
        thinking:
          "**Understanding the request**\n\nThe user wants uploads limited per client. Before changing anything I should see how the route is wired and whether a limiter exists.\n\n**Planning the change**\n\nA limiter in front of the handler, twenty requests a minute, then a test that sends one more than that.",
        hold: 1200,
      },
      { type: "text", text: "I'll look at the route first, then add the limiter and a test." },
      { type: "tool_use", id: "p1", name: "todo", input: plan(["in_progress", "pending", "pending"]) },
    ],
  },
  {
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "r1", name: "read", input: { path: "src/upload.js" } },
      { type: "tool_use", id: "g1", name: "grep", input: { pattern: "rateLimit" } },
      { type: "tool_use", id: "s1", name: "bash", input: { command: "node -e \"console.log('dev server on http://localhost:5173'); setInterval(() => {}, 1000)\"", background: true } },
    ],
  },
  {
    stop_reason: "tool_use",
    content: [
      { type: "thinking", thinking: "**Choosing where the limiter goes**\n\nNo limiter exists yet. It belongs right before the handler so other routes stay unaffected." },
      { type: "tool_use", id: "p2", name: "todo", input: plan(["completed", "in_progress", "pending"]) },
      {
        type: "tool_use",
        id: "e1",
        name: "edit",
        input: {
          path: "src/upload.js",
          old_string: "export function upload(req, res) {",
          new_string: "const limiter = rateLimit({ windowMs: 60_000, max: 20 });\n\nexport function upload(req, res) {\n  if (!limiter.allow(req.ip)) return res.status(429).end();",
        },
      },
    ],
  },
  {
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "p3", name: "todo", input: plan(["completed", "completed", "in_progress"]) },
      { type: "tool_use", id: "w1", name: "write", input: { path: "test/upload.test.js", content: "// sends 21 uploads and expects the last one to be refused\n".repeat(12) } },
      { type: "tool_use", id: "b1", name: "bash", input: { command: "node -e \"setTimeout(() => console.log('12 passed'), 1600)\"" } },
    ],
  },
  {
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "p4", name: "todo", input: plan(["completed", "completed", "completed"]) },
    ],
  },
  {
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: "Uploads are now limited to **20 per minute** per client; the 21st gets a `429`.\n\n- `src/upload.js`: limiter in front of the handler\n- `test/upload.test.js`: sends 21 uploads, expects the last to be refused\n\nThe suite passes (12 tests).",
      },
    ],
  },
  {
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "**Explaining the window**\n\nA fixed window per client IP." },
      { type: "text", text: "The limiter counts uploads per client IP in a fixed **60-second window**. When the window ends, the count starts again at zero." },
    ],
  },
  {
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Yes: pass `max` from the config, e.g. `rateLimit({ windowMs: 60_000, max: config.uploadLimit })`." }],
  },
]);

process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-show-home-"));
process.env.ANTHROPIC_API_KEY = "test-key";
fs.writeFileSync(
  path.join(process.env.FORGE_HOME, "config.json"),
  JSON.stringify({ prepare: false, watch: false, review: false, autoCheck: false, permissionMode: "yolo", model: "anthropic:claude-fable-5-2" }),
);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-show-proj-"));
fs.mkdirSync(path.join(cwd, "src"));
fs.writeFileSync(path.join(cwd, "src/upload.js"), "import { store } from './store.js';\n\nexport function upload(req, res) {\n  store.save(req.body);\n  res.status(201).end();\n}\n");
process.chdir(cwd);

const stdin = new PassThrough() as PassThrough & { setRawMode: (v: boolean) => void; isTTY: boolean };
stdin.setRawMode = () => {};
stdin.isTTY = true;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
let captured = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array) => {
  captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  return true;
}) as typeof process.stdout.write;
Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

const { loadConfig } = await import("../src/config.ts");
const { runInteractive } = await import("../src/ui/app.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await sleep(20);
  }
  fs.writeFileSync(path.join(outDir, "debug.txt"), captured.replace(/[[0-9;?]*[a-zA-Z]/g, ""));
  throw new Error(`timed out waiting for: ${label}`);
};

const finished = runInteractive({ cfg: loadConfig(), cwd, resume: null });
await sleep(100);
stdin.write("add rate limiting to the upload route");
await sleep(50);
stdin.write("\r");
const shots: [string, string][] = [];
await until(() => captured.includes("Thinking"), "thinking");
await sleep(700);
shots.push(["1-thinking", captured]);
await until(() => captured.includes("Running a command"), "bash running");
await sleep(500);
shots.push(["2-working", captured]);
await until(() => captured.includes("suite passes"), "final answer");
await sleep(300);
shots.push(["3-done", captured]);
for (const [q, a] of [["how does the window work?", "starts again at zero"], ["can the limit come from the config?", "uploadLimit"]]) {
  stdin.write(q);
  await sleep(50);
  stdin.write("\r");
  await until(() => captured.includes(a), q);
  await sleep(300);
}
shots.push(["4-tidy", captured]);
stdin.write("\x04");
await finished;
await mock.close();

// ---- render: replay into a terminal emulator, then cells -> HTML ----
const BASE16 = ["#1b1a1f", "#f0705f", "#5fd38d", "#ffd166", "#6aa7ff", "#d58cff", "#5fd3d3", "#d8d2ca", "#6b655e", "#ff8c7c", "#7fe3a6", "#ffe08a", "#8cbcff", "#e2a8ff", "#86e6e6", "#ffffff"];
function palette(n: number): string {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function html(data: string, title: string): Promise<string> {
  const term = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 3000, allowProposedApi: true });
  await new Promise<void>((r) => term.write(data, r));
  const buf = term.buffer.active;
  let last = buf.length - 1;
  while (last > 0 && !buf.getLine(last)!.translateToString(true).trim()) last--;
  const rows: string[] = [];
  for (let y = Math.max(0, last - ROWS + 1); y <= last; y++) {
    const line = buf.getLine(y)!;
    let row = "";
    for (let x = 0; x < COLS; x++) {
      const cell = line.getCell(x)!;
      if (cell.getWidth() === 0) continue;
      const ch = cell.getChars() || " ";
      const st: string[] = [];
      if (cell.isFgPalette()) st.push(`color:${palette(cell.getFgColor())}`);
      if (cell.isBgPalette()) st.push(`background:${palette(cell.getBgColor())}`);
      if (cell.isBold()) st.push("font-weight:700");
      if (cell.isItalic()) st.push("font-style:italic");
      if (cell.isDim()) st.push("opacity:.55");
      row += st.length ? `<span style="${st.join(";")}">${esc(ch)}</span>` : esc(ch);
    }
    rows.push(row);
  }
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;background:#0e0f13"><pre style="margin:0;padding:18px 22px;color:#e8e2da;font:15px/1.35 'Cascadia Mono','Cascadia Code',Consolas,monospace">${rows.join("\n")}</pre>`;
}

for (const [name, data] of shots) fs.writeFileSync(path.join(outDir, name + ".html"), await html(data, name));
realWrite(`wrote ${shots.length} pages to ${outDir}\n`);
process.exit(0);

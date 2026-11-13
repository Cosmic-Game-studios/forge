// Drives the real interactive app with scripted keystrokes against the mock API
// and replays everything it wrote into a headless terminal emulator.
// Prints the final screen (scrollback + viewport) as JSON on fd 3-less stdout.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import xterm from "@xterm/headless";
import { startMock } from "./mock-anthropic.ts";

const COLS = 90;
const ROWS = 30;

const mock = await startMock([
  {
    stop_reason: "tool_use",
    content: [
      { type: "thinking", thinking: "The user wants a file. I will write it." },
      { type: "text", text: "I'll create the file now.\n\n- step **one**\n- step `two`\n" },
      { type: "tool_use", id: "t1", name: "write", input: { path: "hello.txt", content: "hi\nthere\n" } },
    ],
  },
  {
    stop_reason: "end_turn",
    content: [{ type: "text", text: "## Done\n\nCreated `hello.txt` with two lines.\n\n```sh\ncat hello.txt\n```\n" }],
  },
]);

process.env.FORGE_ANTHROPIC_BASE_URL = mock.url;
process.env.FORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tui-home-"));
process.env.ANTHROPIC_API_KEY = "test-key";
// The script above counts model requests; request preparation would add one.
fs.writeFileSync(path.join(process.env.FORGE_HOME, "config.json"), JSON.stringify({ prepare: false, watch: false }));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tui-proj-"));
process.chdir(cwd);

// Fake TTY.
const stdin = new PassThrough() as PassThrough & { setRawMode: (v: boolean) => void; isTTY: boolean };
stdin.setRawMode = () => {};
stdin.isTTY = true;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
let captured = "";
let writes = 0;
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array) => {
  captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  writes++;
  return true;
}) as typeof process.stdout.write;
Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

const { loadConfig } = await import("../src/config.ts");
const { runInteractive } = await import("../src/ui/app.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for: ${label}`);
};

const finished = runInteractive({ cfg: loadConfig(), cwd, resume: null });

await sleep(100);
stdin.write("make a hello file");
await sleep(60);
stdin.write("\r");
await until(() => captured.includes("Permission needed"), "permission prompt");
const promptScreenAt = captured.length;
await sleep(80);
stdin.write("y");
await until(() => mock.requests.length === 2 && captured.includes("cat hello.txt"), "second turn");
await sleep(200);
stdin.write("/cost\r");
await sleep(150);
stdin.write("/mode\r");
await sleep(150);
stdin.write("\x1b[B\r"); // pick "auto-edit"
await sleep(150);
stdin.write("draft text");
await sleep(120);
const beforeExit = captured.length;
stdin.write("\x15\x04"); // clear line, ctrl+d
await finished;
await mock.close();

async function render(data: string): Promise<string[]> {
  const term = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  await new Promise<void>((r) => term.write(data, r));
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)!.translateToString(true));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const result = {
  fileWritten: fs.existsSync(path.join(cwd, "hello.txt")) ? fs.readFileSync(path.join(cwd, "hello.txt"), "utf8") : null,
  writes,
  bytes: captured.length,
  permissionScreen: await render(captured.slice(0, promptScreenAt)),
  beforeExit: await render(captured.slice(0, beforeExit)),
  final: await render(captured),
};
realWrite(JSON.stringify(result));
process.exit(0);

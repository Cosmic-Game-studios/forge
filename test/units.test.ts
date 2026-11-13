import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { toWireMessages } from "../src/providers/openai-compat.ts";
import type { Message } from "../src/providers/types.ts";
import { editTool, readTool, writeTool } from "../src/tools/fs.ts";
import { validateInput } from "../src/tools/index.ts";
import { globToRegExp, globTool, grepTool } from "../src/tools/search.ts";
import { commandPrefix, isReadOnlyCommand, shellTool } from "../src/tools/shell.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { Editor, KeyDecoder } from "../src/ui/input.ts";
import { MarkdownStream, renderMarkdown } from "../src/ui/markdown.ts";
import { stripAnsi, truncate, width, wrap } from "../src/ui/term.ts";

function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal, fileState: new Map(), readSeen: new Map(), todos: [], runSubagent: async () => "", progress: () => {} };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-unit-"));

test("width / truncate / wrap handle ANSI and wide characters", () => {
  assert.equal(width("\x1b[1mab\x1b[22m"), 2);
  assert.equal(width("日本"), 4);
  assert.equal(width("é"), 1);
  assert.equal(stripAnsi(truncate("\x1b[31mhello world\x1b[39m", 6)), "hello…");
  const rows = wrap("the quick brown fox jumps over the lazy dog", 12);
  assert.ok(rows.length >= 4);
  assert.ok(rows.every((r) => width(r) <= 12), JSON.stringify(rows));
  assert.equal(rows.map((r) => stripAnsi(r).trim()).join(" "), "the quick brown fox jumps over the lazy dog");
  // A style opened before the break is re-opened on the next row.
  const styled = wrap("\x1b[1m" + "word ".repeat(8) + "\x1b[22m", 14);
  assert.ok(styled[1].includes("\x1b[1m"));
});

test("markdown stream commits whole lines only and matches one-shot rendering", () => {
  const text = "# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ndone";
  const whole = renderMarkdown(text, 80).map(stripAnsi);
  const md = new MarkdownStream(() => 80);
  const streamed: string[] = [];
  for (let i = 0; i < text.length; i += 3) streamed.push(...md.push(text.slice(i, i + 3)));
  assert.equal(stripAnsi(md.partial()), "done");
  streamed.push(...md.end());
  assert.deepEqual(streamed.map(stripAnsi), whole);
  assert.ok(whole.includes("Title"));
  assert.ok(whole.includes("• one"));
  assert.ok(whole.includes("  │ const a = 1;"));
  assert.ok(whole.some((l) => /^a\s+│\s+b$/.test(l)));
  assert.ok(!whole.some((l) => l.includes("**")));
});

test("key decoder: sequences, bracketed paste across chunks, unbracketed multi-line paste", () => {
  const d = new KeyDecoder();
  assert.deepEqual(d.decode("ab\x1b[A\r").map((k) => k.type), ["text", "up", "enter"]);
  assert.deepEqual(d.decode("\x1b[200~line1\r\nli"), []);
  assert.deepEqual(d.decode("ne2\x1b[201~x"), [{ type: "paste", text: "line1\nline2" }, { type: "text", text: "x" }]);
  assert.deepEqual(d.decode("first line\rsecond line\r"), [{ type: "paste", text: "first line\nsecond line" }]);
  assert.deepEqual(d.decode("\x1b").map((k) => k.type), ["escape"]);
  assert.deepEqual(d.decode("\x1b[Z\x1b\r").map((k) => k.type), ["shift-tab", "newline"]);
});

test("editor: editing, multi-line navigation, history, soft wrap layout", () => {
  const e = new Editor();
  e.handle({ type: "text", text: "hello world" });
  e.handle({ type: "delete-word" });
  assert.equal(e.value, "hello ");
  e.handle({ type: "newline" });
  e.handle({ type: "text", text: "second" });
  e.handle({ type: "up" });
  assert.equal(e.cursor, 6);
  e.handle({ type: "home" });
  e.handle({ type: "text", text: "😀" });
  e.handle({ type: "backspace" });
  assert.equal(e.value, "hello \nsecond");
  e.remember("older");
  e.clear();
  e.handle({ type: "text", text: "draft" });
  e.handle({ type: "up" });
  assert.equal(e.value, "older");
  e.handle({ type: "down" });
  assert.equal(e.value, "draft");
  e.set("x".repeat(25));
  const lay = e.layout(10, 10);
  assert.deepEqual(lay.rows.map((r) => r.length), [10, 10, 5]);
  assert.deepEqual([lay.cursorRow, lay.cursorCol], [2, 5]);
});

test("glob patterns", () => {
  assert.ok(globToRegExp("**/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("**/*.ts").test("b.ts"));
  assert.ok(!globToRegExp("*.ts").test("src/b.ts"));
  assert.ok(globToRegExp("src/**/*.{js,jsx}").test("src/x/y.jsx"));
  assert.ok(!globToRegExp("src/**/*.{js,jsx}").test("src/x/y.ts"));
});

test("read / write / edit: line numbers, stale-write guard, CRLF preserved, unique match", async () => {
  const dir = tmp();
  const c1 = ctx(dir);
  fs.writeFileSync(path.join(dir, "f.txt"), "one\r\ntwo\r\nthree\r\ntwo\r\n");

  let r = await writeTool.run({ path: "f.txt", content: "replaced" }, c1);
  assert.ok(r.isError && /Read .* first/.test(String(r.content)), "overwriting an unread file is refused");

  r = await readTool.run({ path: "f.txt" }, c1);
  assert.equal(r.content, "1\tone\n2\ttwo\n3\tthree\n4\ttwo");

  r = await editTool.run({ path: "f.txt", old_string: "two", new_string: "2" }, c1);
  assert.ok(r.isError && /occurs 2 times/.test(String(r.content)));

  r = await editTool.run({ path: "f.txt", old_string: "one\ntwo", new_string: "ONE\nTWO" }, c1);
  assert.ok(!r.isError, String(r.content));
  assert.equal(fs.readFileSync(path.join(dir, "f.txt"), "utf8"), "ONE\r\nTWO\r\nthree\r\ntwo\r\n");

  r = await editTool.run({ path: "f.txt", old_string: "missing", new_string: "x" }, c1);
  assert.ok(r.isError && /not found/.test(String(r.content)));

  // Changed behind the agent's back -> must re-read.
  await new Promise((res) => setTimeout(res, 20));
  fs.writeFileSync(path.join(dir, "f.txt"), "changed\n");
  fs.utimesSync(path.join(dir, "f.txt"), new Date(), new Date(Date.now() + 5000));
  r = await writeTool.run({ path: "f.txt", content: "mine\n" }, c1);
  assert.ok(r.isError && /changed on disk/.test(String(r.content)));

  r = await writeTool.run({ path: "new/dir/g.txt", content: "fresh\n" }, c1);
  assert.ok(!r.isError);
  assert.equal(fs.readFileSync(path.join(dir, "new/dir/g.txt"), "utf8"), "fresh\n");

  r = await readTool.run({ path: "nope.txt" }, c1);
  assert.ok(r.isError);
});

test("glob and grep tools skip dependency folders", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "node_modules/pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/a.ts"), "export const needle = 1;\n");
  fs.writeFileSync(path.join(dir, "node_modules/pkg/b.ts"), "export const needle = 2;\n");
  const g = await globTool.run({ pattern: "*.ts" }, ctx(dir));
  assert.equal(g.content, "src/a.ts");
  const s = await grepTool.run({ pattern: "needle\\s*=", glob: "*.ts" }, ctx(dir));
  assert.match(String(s.content), /a\.ts:1:export const needle = 1;/);
  assert.doesNotMatch(String(s.content), /node_modules/);
  const none = await grepTool.run({ pattern: "zzz_not_there" }, ctx(dir));
  assert.equal(none.content, "No matches.");
});

test("shell tool: output, exit code, working directory persists, timeout", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "sub"));
  const c1 = ctx(dir);
  let r = await shellTool.run({ command: "echo hello" }, c1);
  assert.equal(r.content, "hello");
  assert.ok(!r.isError);
  r = await shellTool.run({ command: "cd sub" }, c1);
  assert.equal(path.resolve(c1.cwd), path.resolve(dir, "sub"));
  r = await shellTool.run({ command: "exit 3" }, c1);
  assert.ok(r.isError && /Exit code 3/.test(String(r.content)));
  const started = Date.now();
  r = await shellTool.run({ command: "sleep 20", timeout: 1 }, c1);
  assert.ok(r.isError && /timed out/.test(String(r.content)));
  assert.ok(Date.now() - started < 10_000);
});

test("read-only command detection and allow-rule prefixes", () => {
  assert.ok(isReadOnlyCommand("git status"));
  assert.ok(isReadOnlyCommand("ls -la src"));
  assert.ok(!isReadOnlyCommand("git status; rm -rf x"));
  assert.ok(!isReadOnlyCommand("cat a > b"));
  assert.ok(!isReadOnlyCommand("git branch -D main"));
  assert.ok(!isReadOnlyCommand("find . -delete"));
  assert.ok(!isReadOnlyCommand("echo $(rm x)"));
  assert.ok(!isReadOnlyCommand("npm install"));
  assert.equal(commandPrefix("npm test -- --watch"), "npm test");
  assert.equal(commandPrefix("rm -rf build"), "rm");
});

test("input validation: required, types, coercion", () => {
  assert.match(validateInput(readTool, {})!, /Missing required parameter `path`/);
  assert.match(validateInput(readTool, { path: 5 })!, /must be of type string/);
  const input: Record<string, unknown> = { path: "a", offset: "12" };
  assert.equal(validateInput(readTool, input), null);
  assert.equal(input.offset, 12);
});

test("OpenAI-compatible wire translation", () => {
  const messages: Message[] = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret", signature: "s" },
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "c1", name: "read", input: { path: "a" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "1\tx", is_error: true },
        { type: "text", text: "extra note" },
      ],
    },
  ];
  const wire = toWireMessages("SYS", messages, "openrouter", true);
  assert.deepEqual(wire.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
  assert.deepEqual((wire[0].content as any)[0].cache_control, { type: "ephemeral" });
  assert.equal(wire[2].content, "Let me look.");
  assert.deepEqual(wire[2].tool_calls, [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }]);
  assert.equal(wire[3].tool_call_id, "c1");
  assert.equal(wire[3].content, "ERROR: 1\tx");
  assert.ok(!JSON.stringify(wire).includes("secret"), "thinking never leaves the Anthropic path");
});

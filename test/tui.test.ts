// Runs the interactive app in a child process (it needs to own stdin/stdout)
// and checks what a terminal emulator shows.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

test("interactive session renders cleanly: header, chat, permission box, commands, status bar", () => {
  const driver = path.join(import.meta.dirname, "tui-driver.ts");
  const raw = execFileSync(process.execPath, [driver], { encoding: "utf8", timeout: 60_000, env: { ...process.env, FORGE_TUI_VIEW: "0" } });
  const r = JSON.parse(raw) as { fileWritten: string; writes: number; permissionScreen: string[]; beforeExit: string[]; final: string[] };

  assert.equal(r.fileWritten, "hi\nthere\n");

  // Header box: product name, model, provider, effort, mode.
  const head = r.beforeExit.slice(0, 11).join("\n");
  assert.match(head, /^╭─+╮/);
  assert.match(head, /Forge Coding Agent v0\.2\.0 alpha/);
  assert.match(head, /Model\s+Claude Opus 5\.5 claude-opus-5-5/);
  assert.match(head, /Provider\s+Anthropic/);
  assert.match(head, /Effort\s+high/);
  assert.match(head, /Mode\s+ask/);

  const perm = r.permissionScreen.join("\n");
  assert.match(perm, /╭─ Permission needed ─+╮/);
  assert.match(perm, /│ Write hello\.txt/);
  assert.match(perm, /│\s+\+ hi/);
  assert.match(perm, /y Yes\s+n No\s+t Tell Forge/);
  assert.match(perm, /a Always allow all file edits/);

  const screen = r.beforeExit;
  const text = screen.join("\n");
  // Scrollback holds each finished piece exactly once, in order, with no leftovers of the live region.
  const order = ["❯ make a hello file", "✻ Thought for", "◆ I'll create the file now.", "• step one", "● Write hello.txt · created, 2 lines", "◆ Done", "│ cat hello.txt", "╭─ Done ─", "Changed  hello.txt +2 new", "/undo takes these changes back", "❯ /cost", "Usage this session", "Cache read", "❯ /mode", "✓ Permission mode: auto-edit"];
  let pos = -1;
  for (const marker of order) {
    const at = text.indexOf(marker, pos + 1);
    assert.ok(at > pos, `"${marker}" missing or out of order`);
    assert.equal(text.indexOf(marker, at + 1), -1, `"${marker}" appears twice`);
    pos = at;
  }
  assert.doesNotMatch(text, /Working…|Running tools…|Permission needed/, "live-region remnants in scrollback");
  assert.doesNotMatch(text, /\*\*|`two`/, "markdown markers leaked");
  // Every row fits the terminal: nothing wrapped by accident.
  assert.ok(screen.every((l) => l.length <= 90));
  // The live region is the last four rows: input box (3) and status bar.
  const n = screen.length;
  assert.match(screen[n - 4], /^╭─+╮$/);
  assert.match(screen[n - 3], /^│ ❯ draft text\s+│$/);
  assert.match(screen[n - 2], /^╰─+╯$/);
  assert.match(screen[n - 1], /◆ Claude Opus 5\.5 │ Anthropic │ effort high │ mode auto-edit │/);

  // After exit the live region is gone and the shell gets a clean line.
  assert.equal(r.final[r.final.length - 1], "Conversation saved. Continue it with: forge --continue");
  assert.doesNotMatch(r.final.join("\n"), /draft text/);
  // Token streams are coalesced into frames rather than written piece by piece.
  assert.ok(r.writes < 60, `too many terminal writes: ${r.writes}`);
});

test("tidy screen: earlier requests shrink to request, activity, answer and card", () => {
  const driver = path.join(import.meta.dirname, "tui-driver.ts");
  const raw = execFileSync(process.execPath, [driver], { encoding: "utf8", timeout: 60_000, env: { ...process.env, FORGE_TUI_VIEW: "5" } });
  const r = JSON.parse(raw) as { beforeExit: string[] };
  const text = r.beforeExit.join("\n");
  // The banner gives way to one header line, and the scrollback was cleared with it.
  assert.match(r.beforeExit[0], /^Forge v0\.2\.0 alpha · Claude Opus 5\.5 · /);
  assert.doesNotMatch(text, /╭─+╮\n│ +▄/);
  const order = ["❯ make a hello file", "⋯ thought once · 1 tool call", "◆ Done", "cat hello.txt", "╭─ Done ─", "❯ /cost", "Usage this session", "❯ /mode", "✓ Permission mode: auto-edit"];
  let pos = -1;
  for (const marker of order) {
    const at = text.indexOf(marker, pos + 1);
    assert.ok(at > pos, `"${marker}" missing or out of order`);
    assert.equal(text.indexOf(marker, at + 1), -1, `"${marker}" appears twice`);
    pos = at;
  }
  // The steps of the earlier request are gone; only its answer remains.
  assert.doesNotMatch(text, /Thought for|● Write hello\.txt|I'll create the file now/);
  assert.ok(r.beforeExit.every((l) => l.length <= 90));
});

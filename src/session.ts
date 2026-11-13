// Session persistence: one JSON file per session under ~/.forge/sessions/<project>/.
// The system prompt is stored with the session so a resumed conversation sends
// the exact same prefix it was created with.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { forgeHome } from "./config.ts";
import type { Message } from "./providers/types.ts";

export interface SessionData {
  id: string;
  cwd: string;
  model: string;
  system: string;
  messages: Message[];
  created: string;
  updated: string;
  title: string;
}

function projectDir(cwd: string): string {
  const hash = crypto.createHash("sha1").update(path.resolve(cwd).toLowerCase()).digest("hex").slice(0, 12);
  return path.join(forgeHome(), "sessions", `${path.basename(cwd).replace(/[^\w.-]/g, "_")}-${hash}`);
}

export function newSessionId(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(3).toString("hex");
}

export function saveSession(data: SessionData): void {
  const dir = projectDir(data.cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${data.id}.json`);
  const tmp = file + ".tmp";
  // Write-then-rename so a crash mid-write never leaves a truncated session.
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function listSessions(cwd: string): { id: string; title: string; updated: string; turns: number }[] {
  const dir = projectDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: { id: string; title: string; updated: string; turns: number }[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SessionData;
      out.push({ id: d.id, title: d.title, updated: d.updated, turns: d.messages.length });
    } catch {
      /* skip unreadable files */
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

export function loadSession(cwd: string, id?: string): SessionData | null {
  const target = id ?? listSessions(cwd)[0]?.id;
  if (!target) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir(cwd), `${target}.json`), "utf8")) as SessionData;
  } catch {
    return null;
  }
}

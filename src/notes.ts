// Project notes: what Forge learned about a project, kept across sessions in
// <project>/.forge/notes.md. The file is plain Markdown; the user can read,
// edit or delete it. It is loaded into the system prompt when a session starts.

import fs from "node:fs";
import path from "node:path";
import { c } from "./ui/term.ts";
import type { Tool } from "./tools/types.ts";

const MAX_NOTES_CHARS = 6000;

export const notesFile = (cwd: string) => path.join(cwd, ".forge", "notes.md");

export function loadNotes(cwd: string): string {
  try {
    return fs.readFileSync(notesFile(cwd), "utf8").trim().slice(0, MAX_NOTES_CHARS);
  } catch {
    return "";
  }
}

export const rememberTool: Tool = {
  kind: "meta",
  spec: {
    name: "remember",
    description:
      "Save one fact about this project for future sessions (it is stored in .forge/notes.md and shown to you when a session starts). Use it when you learned something that would have saved you time had you known it at the start: the exact command that runs the tests or the build, a convention that is not visible from the code, a trap you fell into and how to avoid it, where something non-obvious lives. One short sentence per note. Do not record what you did, the state of a task, anything already in the project's own instruction files, or secrets.",
    input_schema: {
      type: "object",
      properties: { note: { type: "string", description: "The fact, as one self-contained sentence." } },
      required: ["note"],
    },
  },
  summarize: (i) => String(i.note ?? "").slice(0, 80),
  async run(input, ctx) {
    const note = String(input.note).replace(/\s+/g, " ").trim().slice(0, 300);
    if (!note) return { content: "The note is empty.", isError: true };
    const file = notesFile(ctx.cwd);
    const existing = loadNotes(ctx.cwd);
    if (existing.includes(note)) return { content: "That note is already saved." };
    if (existing.length + note.length > MAX_NOTES_CHARS) {
      return { content: "The notes file is full. Tell the user they can prune .forge/notes.md; do not try to save this note again.", isError: true };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${existing ? existing + "\n" : "# Project notes (kept by Forge; edit or delete freely)\n\n"}- ${note}\n`);
    return { content: "Saved for future sessions.", display: [c.dim(note)] };
  },
};

export function notesPrompt(notes: string): string {
  if (!notes) return "";
  return `\n\n# Project notes\n\nYou saved these notes about this project in earlier sessions. They may be out of date: check a note against the project before you rely on it.\n\n${notes}`;
}

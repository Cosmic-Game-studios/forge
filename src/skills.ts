// Skills: instruction files the model loads only when a task calls for them.
// Each skill is a folder with a SKILL.md whose frontmatter has a name and a
// description. Only the one-line descriptions sit in the system prompt; the
// model reads the full file with the read tool when it is relevant.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forgeHome } from "./config.ts";

export interface Skill {
  name: string;
  description: string;
  file: string;
  source: "built-in" | "user" | "project";
}

function parseSkill(file: string, source: Skill["source"]): Skill | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const field = (key: string) => {
    const m = fm && new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm[1]);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  const name = field("name") || path.basename(path.dirname(file));
  const description = field("description");
  if (!description) return null;
  return { name, description: description.slice(0, 400), file, source };
}

/** Later sources override earlier ones with the same name: built-in < user < project. */
export function loadSkills(cwd: string): Skill[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots: [string, Skill["source"]][] = [
    [path.join(here, "..", "skills"), "built-in"],
    [path.join(os.homedir(), ".claude", "skills"), "user"],
    [path.join(forgeHome(), "skills"), "user"],
    [path.join(cwd, ".claude", "skills"), "project"],
    [path.join(cwd, ".forge", "skills"), "project"],
  ];
  const byName = new Map<string, Skill>();
  for (const [root, source] of roots) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const d of dirs) {
      const skill = parseSkill(path.join(root, d, "SKILL.md"), source);
      if (skill) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].slice(0, 40);
}

export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return "";
  return (
    "\n\n# Skills\n\nSkills are instruction files for particular kinds of work. When a task matches a skill's description, read its file with the read tool before you start, and follow it. Do not read skills that do not apply.\n\n" +
    skills.map((s) => `- ${s.name}: ${s.description} (${s.file})`).join("\n")
  );
}

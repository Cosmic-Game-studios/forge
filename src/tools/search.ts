// Search tools: glob and grep. grep uses ripgrep when it is installed and a
// built-in scanner otherwise, so the harness has no hard external dependency.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { c } from "../ui/term.ts";
import { clip, resolvePath, type Tool } from "./types.ts";

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".hg", ".svn", "dist", "build", "out", "target", ".next", ".nuxt", ".venv", "venv",
  "__pycache__", ".cache", ".idea", ".gradle", "coverage", ".turbo", "vendor", ".tox", "Library", "obj",
]);

/** Convert a glob (supports **, *, ?, {a,b}, [abc]) to a RegExp over forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  let depth = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      re += "(?:";
      depth++;
    } else if (ch === "}" && depth > 0) {
      re += ")";
      depth--;
    } else if (ch === "," && depth > 0) re += "|";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        re += "[" + glob.slice(i + 1, end).replace(/\\/g, "\\\\") + "]";
        i = end;
      }
    } else re += ch.replace(/[.+^$()|\\]/g, "\\$&");
    i++;
  }
  return new RegExp("^" + re + "$", process.platform === "win32" ? "i" : "");
}

/** Walk a tree, skipping dependency/build directories. Yields forward-slash relative paths. */
export async function* walk(root: string, signal: AbortSignal): AsyncGenerator<string> {
  const stack: string[] = [""];
  while (stack.length) {
    if (signal.aborted) return;
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(childRel);
      } else if (e.isFile()) yield childRel;
    }
  }
}

export const globTool: Tool = {
  kind: "read",
  spec: {
    name: "glob",
    description:
      "Find files by name pattern, e.g. `**/*.ts` or `src/**/*.{js,jsx}`. Returns paths sorted by modification time, newest first. Dependency and build directories (node_modules, .git, dist, ...) are skipped.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, relative to `path`." },
        path: { type: "string", description: "Directory to search. Defaults to the working directory." },
      },
      required: ["pattern"],
    },
  },
  summarize: (i) => String(i.pattern ?? "") + (i.path ? c.dim(` in ${i.path}`) : ""),
  async run(input, ctx) {
    const root = resolvePath(ctx, input.path || ".");
    let pattern = String(input.pattern).replace(/\\/g, "/");
    if (!pattern.includes("/")) pattern = "**/" + pattern; // bare names match at any depth
    const re = globToRegExp(pattern);
    const found: { p: string; t: number }[] = [];
    for await (const rel of walk(root, ctx.signal)) {
      if (!re.test(rel)) continue;
      let t = 0;
      try {
        t = (await fs.stat(path.join(root, rel))).mtimeMs;
      } catch {
        /* raced with a delete */
      }
      found.push({ p: rel, t });
      if (found.length >= 5000) break;
    }
    if (found.length === 0) return { content: "No files matched.", display: [c.dim("no matches")] };
    found.sort((a, b) => b.t - a.t);
    const shown = found.slice(0, 200).map((f) => f.p);
    const more = found.length > shown.length ? `\n[${found.length - shown.length} more not shown; narrow the pattern]` : "";
    return { content: shown.join("\n") + more, display: [c.dim(`${found.length} files`)] };
  },
};

let rgAvailable: boolean | null = null;
function hasRipgrep(): boolean {
  if (rgAvailable === null) {
    rgAvailable = spawnSync("rg", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
  }
  return rgAvailable;
}

function runRipgrep(args: string[], cwd: string, signal: AbortSignal): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd, windowsHide: true, signal });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 400_000) out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (out.length < 400_000) out += d.toString("utf8");
    });
    child.on("error", () => resolve({ out, code: 2 }));
    child.on("close", (code) => resolve({ out, code }));
  });
}

export const grepTool: Tool = {
  kind: "read",
  spec: {
    name: "grep",
    description:
      "Search file contents with a regular expression. Default output is matching lines as `path:line:text`. Set `files_only` to list only the files that contain a match. Use `glob` to restrict which files are searched and `context` for surrounding lines.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "File or directory to search. Defaults to the working directory." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. `*.ts`." },
        ignore_case: { type: "boolean" },
        files_only: { type: "boolean", description: "Return only the paths of files with matches." },
        context: { type: "integer", description: "Lines of context before and after each match." },
      },
      required: ["pattern"],
    },
  },
  summarize: (i) => `/${i.pattern ?? ""}/` + (i.glob ? c.dim(` ${i.glob}`) : "") + (i.path ? c.dim(` in ${i.path}`) : ""),
  async run(input, ctx) {
    const target = resolvePath(ctx, input.path || ".");
    const pattern = String(input.pattern);

    if (hasRipgrep()) {
      const args = ["--no-heading", "--line-number", "--color", "never", "--max-columns", "400", "--max-columns-preview"];
      if (input.ignore_case) args.push("-i");
      if (input.files_only) args.push("-l");
      if (input.context) args.push("-C", String(Math.min(20, Number(input.context))));
      if (input.glob) args.push("--glob", String(input.glob));
      args.push("-e", pattern, "--", target);
      const { out, code } = await runRipgrep(args, ctx.cwd, ctx.signal);
      if (code === 1 || (code === 0 && !out.trim())) return { content: "No matches.", display: [c.dim("no matches")] };
      if (code !== 0) return { content: `grep failed: ${out.trim() || "unknown error"}`, isError: true };
      const rel = out.split(path.join(ctx.cwd, path.sep)).join("");
      const lines = rel.trimEnd().split("\n");
      const shown = lines.slice(0, 300).join("\n");
      const more = lines.length > 300 ? `\n[${lines.length - 300} more lines not shown; narrow the search]` : "";
      return { content: clip(shown + more), display: [c.dim(`${lines.length} ${input.files_only ? "files" : "lines"}`)] };
    }

    // Built-in fallback.
    let re: RegExp;
    try {
      re = new RegExp(pattern, input.ignore_case ? "i" : "");
    } catch (err) {
      return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true };
    }
    const fileRe = input.glob ? globToRegExp(String(input.glob).includes("/") ? String(input.glob) : "**/" + input.glob) : null;
    const results: string[] = [];
    const ctxLines = Math.min(20, Number(input.context) || 0);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return { content: `Path not found: ${target}`, isError: true };
    }
    const files = stat.isFile() ? [""] : walk(target, ctx.signal);
    for await (const rel of files as AsyncIterable<string> | string[]) {
      if (fileRe && rel && !fileRe.test(rel)) continue;
      const abs = rel ? path.join(target, rel) : target;
      let text: string;
      try {
        const buf = await fs.readFile(abs);
        if (buf.length > 2_000_000 || buf.subarray(0, 4096).includes(0)) continue;
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      const shownPath = path.relative(ctx.cwd, abs).split(path.sep).join("/") || abs;
      const lines = text.split(/\r?\n/);
      for (let n = 0; n < lines.length; n++) {
        if (!re.test(lines[n])) continue;
        if (input.files_only) {
          results.push(shownPath);
          break;
        }
        for (let k = Math.max(0, n - ctxLines); k <= Math.min(lines.length - 1, n + ctxLines); k++) {
          results.push(`${shownPath}:${k + 1}${k === n ? ":" : "-"}${lines[k].slice(0, 400)}`);
        }
        if (results.length >= 300) break;
      }
      if (results.length >= 300) break;
    }
    if (results.length === 0) return { content: "No matches.", display: [c.dim("no matches")] };
    const more = results.length >= 300 ? "\n[output limit reached; narrow the search]" : "";
    return { content: clip(results.join("\n") + more), display: [c.dim(`${results.length} ${input.files_only ? "files" : "lines"}`)] };
  },
};

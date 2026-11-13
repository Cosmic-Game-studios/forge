// deps: the project's import graph. Answers "what does this file use?" and,
// more importantly, "what breaks if I change it?" - the files that import it,
// directly and indirectly. Built from the import statements on demand, so it
// can never be stale.

import fs from "node:fs/promises";
import path from "node:path";
import { c } from "../ui/term.ts";
import { walk } from "./search.ts";
import { displayPath, resolvePath, type Tool } from "./types.ts";

const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const JS_IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_IMPORT = /^\s*(?:from\s+([.\w]+)\s+import\s+([\w, ]+|\*|\()|import\s+([\w.]+))/gm;

export interface ImportGraph {
  /** file -> files it imports (project files only, forward-slash relative paths) */
  imports: Map<string, Set<string>>;
  /** file -> files that import it */
  importedBy: Map<string, Set<string>>;
}

function resolveJs(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith(".")) return null; // packages are outside the project graph
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, ""); // TS sources are often imported as ".js"
  for (const cand of [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => stem + e), ...JS_EXT.map((e) => `${base}/index${e}`)]) {
    if (files.has(cand)) return cand;
  }
  return null;
}

function resolvePy(from: string, mod: string, files: Set<string>): string | null {
  let dir = "";
  let name = mod;
  const dots = /^\.+/.exec(mod)?.[0].length ?? 0;
  if (dots) {
    dir = path.posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    name = mod.slice(dots);
  }
  const rel = name.split(".").filter(Boolean).join("/");
  const base = dir && dir !== "." ? (rel ? `${dir}/${rel}` : dir) : rel;
  for (const cand of [`${base}.py`, `${base}/__init__.py`, `src/${base}.py`, `src/${base}/__init__.py`]) {
    if (files.has(cand)) return cand;
  }
  return null;
}

export async function buildGraph(root: string, signal: AbortSignal): Promise<ImportGraph> {
  const all: string[] = [];
  for await (const rel of walk(root, signal)) {
    const ext = path.extname(rel);
    if (JS_EXT.includes(ext) || ext === ".py") all.push(rel);
    if (all.length >= 6000) break;
  }
  const files = new Set(all);
  const graph: ImportGraph = { imports: new Map(), importedBy: new Map() };
  const link = (from: string, to: string | null) => {
    if (!to || to === from) return;
    if (!graph.imports.has(from)) graph.imports.set(from, new Set());
    graph.imports.get(from)!.add(to);
    if (!graph.importedBy.has(to)) graph.importedBy.set(to, new Set());
    graph.importedBy.get(to)!.add(from);
  };
  await Promise.all(
    all.map(async (rel) => {
      let text: string;
      try {
        const buf = await fs.readFile(path.join(root, rel));
        if (buf.length > 1_000_000) return;
        text = buf.toString("utf8");
      } catch {
        return;
      }
      if (rel.endsWith(".py")) {
        for (const m of text.matchAll(PY_IMPORT)) {
          if (m[3]) link(rel, resolvePy(rel, m[3], files));
          else if (m[1]) {
            const direct = resolvePy(rel, m[1], files);
            link(rel, direct);
            // `from pkg import module` may name sub-modules.
            for (const name of (m[2] ?? "").split(",").map((s) => s.trim()).filter((s) => /^\w+$/.test(s))) {
              link(rel, resolvePy(rel, `${m[1]}${m[1].endsWith(".") ? "" : "."}${name}`, files));
            }
          }
        }
      } else {
        for (const m of text.matchAll(JS_IMPORT)) link(rel, resolveJs(rel, m[1] ?? m[2] ?? m[3] ?? m[4], files));
      }
    }),
  );
  return graph;
}

/** Everything that depends on `file`, by distance (1 = imports it directly). */
export function dependents(graph: ImportGraph, file: string, maxDepth = 6): Map<string, number> {
  const seen = new Map<string, number>();
  let frontier = [file];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const user of graph.importedBy.get(f) ?? []) {
        if (user === file || seen.has(user)) continue;
        seen.set(user, depth);
        next.push(user);
      }
    }
    frontier = next;
  }
  return seen;
}

const list = (items: string[], max: number) => items.slice(0, max).map((i) => `  ${i}`).join("\n") + (items.length > max ? `\n  … ${items.length - max} more` : "");

export const depsTool: Tool = {
  kind: "read",
  spec: {
    name: "deps",
    description:
      "Query the project's import graph for a file: which project files it imports, which files import it, and which files depend on it indirectly. Use it before changing what a file exports (a signature, a renamed or removed function, a changed type) to find every place that could break, and to see which tests cover a file. Works for JavaScript/TypeScript and Python. Faster and more complete than grepping for the file name.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file, absolute or relative to the working directory." },
      },
      required: ["path"],
    },
  },
  summarize: (i, ctx) => displayPath(ctx, String(i.path ?? "")),
  async run(input, ctx) {
    const abs = resolvePath(ctx, input.path);
    const rel = path.relative(ctx.cwd, abs).split(path.sep).join("/");
    if (rel.startsWith("..")) return { content: `${abs} is outside the working directory ${ctx.cwd}.`, isError: true };
    const graph = await buildGraph(ctx.cwd, ctx.signal);
    const imports = [...(graph.imports.get(rel) ?? [])].sort();
    const deps = dependents(graph, rel);
    const direct = [...deps].filter(([, d]) => d === 1).map(([f]) => f).sort();
    const indirect = [...deps].filter(([, d]) => d > 1).map(([f]) => f).sort();
    if (!imports.length && !deps.size) {
      return { content: `${rel}: no import relations with other project files found (it may be an entry point, unused, or in an unsupported language).`, display: [c.dim("no relations")] };
    }
    const isTest = (f: string) => /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/i.test(f);
    const tests = [...deps.keys()].filter(isTest).sort();
    const parts = [
      `${rel}`,
      `imports (${imports.length}):\n${imports.length ? list(imports, 40) : "  none"}`,
      `imported by (${direct.length}):\n${direct.length ? list(direct, 60) : "  none"}`,
    ];
    if (indirect.length) parts.push(`depends on it indirectly (${indirect.length}):\n${list(indirect, 40)}`);
    if (tests.length) parts.push(`tests that reach it (${tests.length}):\n${list(tests, 20)}`);
    return { content: parts.join("\n\n"), display: [c.dim(`${imports.length} imports, ${direct.length} direct + ${indirect.length} indirect dependents`)] };
  },
};

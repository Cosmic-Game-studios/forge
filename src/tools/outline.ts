// outline: the shape of a file or folder (functions, classes, types with line
// numbers) without its bodies. Lets the model find the 40 lines it needs
// instead of reading 2000. Pattern-based, so it is instant and needs no parser.

import fs from "node:fs/promises";
import path from "node:path";
import { c } from "../ui/term.ts";
import { walk } from "./search.ts";
import { displayPath, resolvePath, type Tool } from "./types.ts";

export interface SymbolInfo {
  /** 1-based line number. */
  line: number;
  indent: number;
  /** The declaration line, trimmed. */
  text: string;
  name: string;
}

interface Lang {
  patterns: RegExp[];
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "else", "do", "try", "function", "new", "await", "typeof", "with", "super", "constructor_"]);

const JS: Lang = {
  patterns: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/,
    /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+(\w+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)/,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\b/,
    // class members: `name(args) {`, `async name(`, `static name(`, `get name(`
    /^\s+(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*(#?\w+)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^{;]+)?\{\s*$/,
  ],
};

const LANGS: Record<string, Lang> = {
  ".js": JS, ".mjs": JS, ".cjs": JS, ".jsx": JS, ".ts": JS, ".tsx": JS, ".mts": JS, ".cts": JS,
  ".py": { patterns: [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/] },
  ".go": { patterns: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)/] },
  ".rs": {
    patterns: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|mod|type|const|static|union)\s+(\w+)/, /^\s*impl(?:<[^>]*>)?\s+([\w:<>, ]+?)\s*\{/],
  },
  ".rb": { patterns: [/^\s*(?:def|class|module)\s+([\w.?!]+)/] },
  ".php": { patterns: [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)/, /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/] },
};

// Java, C#, Kotlin, Swift, C/C++, Scala, Dart: one generic set.
const GENERIC: Lang = {
  patterns: [
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial|export)\s+)*(?:class|interface|enum|record|struct|trait|object|protocol|extension|namespace)\s+(\w+)/,
    /^\s*(?:(?:public|private|protected|internal|static|override|suspend|inline|mutating)\s+)*(?:fun|func)\s+(?:<[^>]*>\s*)?([\w.]+)/,
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|inline|const|extern|unsigned)\s+)*[\w<>\[\],:*&]+\s+[*&]?(\w+)\s*\([^;]*\)?\s*(?:const\s*)?(?:throws\s+[\w, ]+)?\{?\s*$/,
  ],
};
for (const ext of [".java", ".cs", ".kt", ".kts", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".scala", ".dart"]) LANGS[ext] = GENERIC;

export function supportsOutline(file: string): boolean {
  return path.extname(file).toLowerCase() in LANGS;
}

export function findSymbols(text: string, file: string): SymbolInfo[] {
  const lang = LANGS[path.extname(file).toLowerCase()];
  if (!lang) return [];
  const out: SymbolInfo[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400 || !line.trim()) continue;
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*")) continue;
    for (const re of lang.patterns) {
      const m = re.exec(line);
      if (!m || KEYWORDS.has(m[1])) continue;
      out.push({ line: i + 1, indent: line.length - t.length, text: t.replace(/\s*\{\s*$/, "").slice(0, 140), name: m[1] });
      break;
    }
  }
  return out;
}

/** The line range of a symbol: from its declaration to just before the next symbol at the same or outer level. */
export function symbolRange(symbols: SymbolInfo[], index: number, totalLines: number, lines: string[]): { start: number; end: number } {
  const sym = symbols[index];
  let end = totalLines;
  for (let k = index + 1; k < symbols.length; k++) {
    if (symbols[k].indent <= sym.indent) {
      end = symbols[k].line - 1;
      break;
    }
  }
  // Leading comments/decorators of the next symbol and blank lines do not belong to this one.
  while (end > sym.line && /^\s*(\/\/.*|\/\*.*|\*.*|#.*|@\w.*)?$/.test(lines[end - 1])) end--;
  return { start: sym.line, end };
}

function formatSymbols(symbols: SymbolInfo[]): string[] {
  const minIndent = Math.min(...symbols.map((s) => s.indent));
  return symbols.map((s) => `${String(s.line).padStart(5)}  ${"  ".repeat(Math.min(4, Math.round((s.indent - minIndent) / 2)))}${s.text}`);
}

const MAX_FILES = 60;

export const outlineTool: Tool = {
  kind: "read",
  spec: {
    name: "outline",
    description:
      "Show the structure of a source file or folder: its functions, classes, methods and types with line numbers, without the bodies. Use it before reading a large or unfamiliar file, then read only the part you need with `read` (`symbol` or `offset`/`limit`). For a folder it lists the top-level declarations of each source file. Much cheaper than reading whole files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or folder, absolute or relative to the working directory." },
      },
      required: ["path"],
    },
  },
  summarize: (i, ctx) => displayPath(ctx, String(i.path ?? ".")),
  async run(input, ctx) {
    const target = resolvePath(ctx, input.path || ".");
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return { content: `Path not found: ${target}`, isError: true };
    }

    if (stat.isFile()) {
      if (!supportsOutline(target)) return { content: `No outline support for ${path.extname(target) || "this file type"}. Use read or grep.`, isError: true };
      const text = await fs.readFile(target, "utf8");
      const symbols = findSymbols(text, target);
      const total = text.split(/\r?\n/).length;
      if (!symbols.length) return { content: `No declarations found in ${target} (${total} lines).`, display: [c.dim("no declarations")] };
      return {
        content: `${displayPath(ctx, target)} (${total} lines)\n${formatSymbols(symbols).join("\n")}`,
        display: [c.dim(`${symbols.length} declarations, ${total} lines`)],
      };
    }

    const parts: string[] = [];
    let files = 0;
    let skipped = 0;
    const all: string[] = [];
    for await (const rel of walk(target, ctx.signal)) if (supportsOutline(rel)) all.push(rel);
    all.sort();
    for (const rel of all) {
      if (files >= MAX_FILES) {
        skipped++;
        continue;
      }
      let text: string;
      try {
        const buf = await fs.readFile(path.join(target, rel));
        if (buf.length > 1_000_000) continue;
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      const symbols = findSymbols(text, rel);
      if (!symbols.length) continue;
      const minIndent = Math.min(...symbols.map((s) => s.indent));
      const top = symbols.filter((s) => s.indent === minIndent);
      files++;
      const shown = top.slice(0, 25);
      parts.push(
        `${rel} (${text.split(/\r?\n/).length} lines)\n${formatSymbols(shown).join("\n")}${top.length > shown.length ? `\n       … ${top.length - shown.length} more` : ""}`,
      );
    }
    if (!parts.length) return { content: "No source files with declarations found here.", display: [c.dim("nothing found")] };
    const more = skipped ? `\n\n[${skipped} more files not shown; outline a sub-folder]` : "";
    return { content: parts.join("\n\n") + more, display: [c.dim(`${files} files`)] };
  },
};

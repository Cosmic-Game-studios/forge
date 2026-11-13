// Streaming markdown renderer.
//
// Text arrives in arbitrary chunks. Complete lines are rendered once and
// committed to scrollback; only the unfinished tail line is kept "live".
// That keeps rendering O(new text) instead of re-rendering the whole message.

import { c, wrap, width, stripAnsi } from "./term.ts";

export function renderInline(s: string): string {
  // Protect code spans first so their content is not styled further.
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(c.cyan(code));
    return `\x00${codes.length - 1}\x00`;
  });
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => c.bold(t))
    .replace(/__([^_\n]+)__/g, (_m, t: string) => c.bold(t))
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=$|[\s).,;:!?])/g, (_m, pre: string, t: string) => pre + c.italic(t))
    .replace(/~~([^~\n]+)~~/g, (_m, t: string) => c.strike(t))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, t: string, url: string) =>
      t === url ? c.underline(url) : `${c.underline(t)} ${c.dim("(" + url + ")")}`,
    );
  return s.replace(/\x00(\d+)\x00/g, (_m, i: string) => codes[Number(i)]);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((x) => x.trim());
}

function renderTable(rows: string[], maxWidth: number): string[] {
  const cells = rows.map(splitRow);
  const isSep = (r: string[]) => r.every((x) => /^:?-{1,}:?$/.test(x));
  const body = cells.filter((r) => !isSep(r)).map((r) => r.map(renderInline));
  const cols = Math.max(...body.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...body.map((r) => width(r[i] ?? ""))));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * cols + 1;
  if (total > maxWidth) {
    // Too wide to align: fall back to one "key: value" style line per cell row.
    return body.map((r) => r.join(c.dim(" │ ")));
  }
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));
  const out: string[] = [];
  body.forEach((r, idx) => {
    const line = widths.map((w, i) => pad(r[i] ?? "", w)).join(c.dim(" │ "));
    out.push(idx === 0 ? c.bold(line) : line);
    if (idx === 0) out.push(c.dim(widths.map((w) => "─".repeat(w)).join("─┼─")));
  });
  return out;
}

export class MarkdownStream {
  private buf = "";
  private inFence = false;
  private table: string[] = [];
  private maxWidth: () => number;
  private prefix: string;

  constructor(maxWidth: () => number, prefix = "") {
    this.maxWidth = maxWidth;
    this.prefix = prefix;
  }

  /** Feed a chunk; returns fully rendered lines ready to commit. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this.renderLine(line, out);
    }
    return out;
  }

  /** The unfinished tail line, lightly styled, for the live region. */
  partial(): string {
    if (!this.buf) return "";
    return this.prefix + (this.inFence ? c.dim("  " + this.buf) : renderInline(this.buf));
  }

  /** Flush whatever is left at the end of a block. */
  end(): string[] {
    const out: string[] = [];
    if (this.buf) {
      this.renderLine(this.buf, out);
      this.buf = "";
    }
    this.flushTable(out);
    this.inFence = false;
    return out;
  }

  private flushTable(out: string[]) {
    if (!this.table.length) return;
    const rows = this.table;
    this.table = [];
    for (const l of renderTable(rows, this.maxWidth() - width(this.prefix))) out.push(this.prefix + l);
  }

  private emit(out: string[], text: string, indent = "") {
    const max = this.maxWidth() - width(this.prefix);
    for (const row of wrap(text, max, indent)) out.push(this.prefix + row);
  }

  private renderLine(line: string, out: string[]) {
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      this.flushTable(out);
      this.inFence = !this.inFence;
      if (this.inFence) out.push(this.prefix + c.dim("  ┌─ " + (fence[2] || "code")));
      else out.push(this.prefix + c.dim("  └─"));
      return;
    }
    if (this.inFence) {
      // Code is never re-wrapped: the terminal wraps it, so copy/paste stays intact.
      out.push(this.prefix + c.dim("  │ ") + line);
      return;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      this.table.push(line);
      return;
    }
    this.flushTable(out);

    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const text = renderInline(m[2]);
      this.emit(out, m[1].length <= 2 ? c.bold(c.orange(text)) : c.bold(text));
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(this.prefix + c.dim("─".repeat(Math.min(40, this.maxWidth() - width(this.prefix)))));
    } else if ((m = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
      const box = m[3] ? (/x/i.test(m[3]) ? c.green("☑ ") : "☐ ") : "";
      const lead = m[1] + c.orange("•") + " ";
      this.emit(out, lead + box + renderInline(m[4]), " ".repeat(m[1].length + 2));
    } else if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) {
      const lead = `${m[1]}${c.orange(m[2] + ".")} `;
      this.emit(out, lead + renderInline(m[3]), " ".repeat(width(stripAnsi(lead))));
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      this.emit(out, c.dim("▎ ") + c.italic(renderInline(m[1])), c.dim("▎ "));
    } else {
      this.emit(out, renderInline(line));
    }
  }
}

/** Render a complete markdown string in one go. */
export function renderMarkdown(text: string, maxWidth: number, prefix = ""): string[] {
  const md = new MarkdownStream(() => maxWidth, prefix);
  return [...md.push(text), ...md.end()];
}

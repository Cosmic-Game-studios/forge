// Terminal primitives: colors, display width, ANSI-aware wrapping/truncation.

const colorEnabled = !process.env.NO_COLOR && process.env.TERM !== "dumb";

function sgr(open: string, close: string) {
  return (s: string) => (colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const c = {
  bold: sgr("1", "22"),
  dim: sgr("2", "22"),
  italic: sgr("3", "23"),
  underline: sgr("4", "24"),
  strike: sgr("9", "29"),
  red: sgr("31", "39"),
  green: sgr("32", "39"),
  yellow: sgr("33", "39"),
  blue: sgr("34", "39"),
  magenta: sgr("35", "39"),
  cyan: sgr("36", "39"),
  gray: sgr("90", "39"),
  orange: sgr("38;5;208", "39"),
  bgGray: sgr("48;5;236", "49"),
};

// Matches CSI sequences and OSC sequences.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const ANSI_RE_G = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE_G, "");
}

/** Display width of a single code point (0, 1 or 2 columns). */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  // Combining marks, zero-width joiners, variation selectors.
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  )
    return 0;
  // East Asian wide + emoji ranges.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Display width of a string, ignoring ANSI escapes. */
export function width(s: string): number {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(s);
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    w += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return w;
}

/** Cut a string to at most `max` columns, keeping ANSI escapes intact. */
export function truncate(s: string, max: number, ellipsis = "…"): string {
  if (width(s) <= max) return s;
  const limit = Math.max(0, max - width(ellipsis));
  let out = "";
  let w = 0;
  let i = 0;
  let sawAnsi = false;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(s);
      if (m) {
        out += m[0];
        sawAnsi = true;
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const cw = charWidth(cp);
    if (w + cw > limit) break;
    out += String.fromCodePoint(cp);
    w += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  return out + ellipsis + (sawAnsi ? "\x1b[0m" : "");
}

/**
 * Word-wrap one logical line to `max` columns. ANSI state is carried across
 * the break so styles survive wrapping. `indent` prefixes continuation rows.
 */
export function wrap(line: string, max: number, indent = ""): string[] {
  if (max < 8 || width(line) <= max) return [line];
  const rows: string[] = [];
  let active = ""; // SGR sequences currently in effect
  let row = "";
  let rowW = 0;
  let lastBreak = -1; // index in `row` after the last space
  let lastBreakW = 0;
  let lastBreakActive = "";
  const indentW = width(indent);

  const flush = (text: string) => {
    rows.push(text.replace(/\s+$/, "") + (active || lastBreakActive ? "\x1b[0m" : ""));
  };

  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b) {
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(line);
      if (m) {
        row += m[0];
        if (m[0].endsWith("m")) {
          active = /\x1b\[0?m/.test(m[0]) ? "" : active + m[0];
        }
        i += m[0].length;
        continue;
      }
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (rowW + cw > max) {
      if (lastBreak > 0) {
        const rest = row.slice(lastBreak);
        const restW = rowW - lastBreakW;
        const saved = active;
        active = lastBreakActive;
        flush(row.slice(0, lastBreak));
        active = saved;
        row = indent + lastBreakActive + rest;
        rowW = indentW + restW;
      } else {
        flush(row);
        row = indent + active;
        rowW = indentW;
      }
      lastBreak = -1;
    }
    row += ch;
    rowW += cw;
    if (ch === " ") {
      lastBreak = row.length;
      lastBreakW = rowW;
      lastBreakActive = active;
    }
    i += ch.length;
  }
  if (stripAnsi(row).trim().length > 0 || rows.length === 0) rows.push(row);
  return rows;
}

export function termWidth(): number {
  return Math.max(20, process.stdout.columns || 80);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

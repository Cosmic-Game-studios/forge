// Raw-mode key decoding and a small multi-line editor.

import { charWidth } from "./term.ts";

export type Key =
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | {
      type:
        | "enter" | "newline" | "backspace" | "delete" | "left" | "right" | "up" | "down" | "home" | "end"
        | "word-left" | "word-right" | "delete-word" | "kill-line" | "kill-to-end" | "tab" | "shift-tab"
        | "escape" | "ctrl-c" | "ctrl-d" | "ctrl-l" | "page-up" | "page-down";
    };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const SEQUENCES: [string, Key["type"]][] = [
  ["\x1b[13;2u", "newline"], // shift+enter (kitty / modifyOtherKeys)
  ["\x1b[27;2;13~", "newline"],
  ["\x1b[1;5C", "word-right"],
  ["\x1b[1;5D", "word-left"],
  ["\x1b[1;3C", "word-right"],
  ["\x1b[1;3D", "word-left"],
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],
  ["\x1bOA", "up"],
  ["\x1bOB", "down"],
  ["\x1bOC", "right"],
  ["\x1bOD", "left"],
  ["\x1b[H", "home"],
  ["\x1b[F", "end"],
  ["\x1bOH", "home"],
  ["\x1bOF", "end"],
  ["\x1b[1~", "home"],
  ["\x1b[4~", "end"],
  ["\x1b[3~", "delete"],
  ["\x1b[5~", "page-up"],
  ["\x1b[6~", "page-down"],
  ["\x1b[Z", "shift-tab"],
  ["\x1b\r", "newline"], // alt+enter
  ["\x1b\n", "newline"],
  ["\x1b\x7f", "delete-word"],
  ["\x1b\b", "delete-word"],
  ["\x1bb", "word-left"],
  ["\x1bf", "word-right"],
];

const CONTROL: Record<string, Key["type"]> = {
  "\r": "enter",
  "\n": "newline", // ctrl+j
  "\x7f": "backspace",
  "\b": "backspace",
  "\t": "tab",
  "\x01": "home",
  "\x05": "end",
  "\x03": "ctrl-c",
  "\x04": "ctrl-d",
  "\x0b": "kill-to-end",
  "\x0c": "ctrl-l",
  "\x15": "kill-line",
  "\x17": "delete-word",
  "\x02": "left",
  "\x06": "right",
  "\x10": "up",
  "\x0e": "down",
};

export class KeyDecoder {
  private pasteBuf: string | null = null;

  /** Decode one chunk of raw stdin into keys. */
  decode(chunk: string): Key[] {
    const keys: Key[] = [];
    let s = chunk;
    while (s.length) {
      if (this.pasteBuf !== null) {
        const end = s.indexOf(PASTE_END);
        if (end === -1) {
          this.pasteBuf += s;
          return keys;
        }
        keys.push({ type: "paste", text: (this.pasteBuf + s.slice(0, end)).replace(/\r\n?/g, "\n") });
        this.pasteBuf = null;
        s = s.slice(end + PASTE_END.length);
        continue;
      }
      if (s.startsWith(PASTE_START)) {
        this.pasteBuf = "";
        s = s.slice(PASTE_START.length);
        continue;
      }
      if (s[0] === "\x1b") {
        const hit = SEQUENCES.find(([seq]) => s.startsWith(seq));
        if (hit) {
          keys.push({ type: hit[1] } as Key);
          s = s.slice(hit[0].length);
          continue;
        }
        // Unknown CSI/SS3 sequence: swallow it whole so it never lands in the text.
        const m = /^\x1b(?:\[[0-9;?<>=]*[ -/]*[@-~]|O.)/.exec(s);
        if (m) {
          s = s.slice(m[0].length);
          continue;
        }
        keys.push({ type: "escape" });
        s = s.slice(1);
        continue;
      }
      const ctl = CONTROL[s[0]];
      if (ctl) {
        keys.push({ type: ctl } as Key);
        s = s.slice(1);
        continue;
      }
      if (s.charCodeAt(0) < 0x20) {
        s = s.slice(1); // other control characters are ignored
        continue;
      }
      // Run of printable characters.
      let i = 0;
      while (i < s.length && s.charCodeAt(i) >= 0x20 && s[i] !== "\x7f") i++;
      keys.push({ type: "text", text: s.slice(0, i) });
      s = s.slice(i);
    }
    // A terminal without bracketed paste delivers a paste as text + enter keys
    // in a single chunk. Treat that as one paste so it is not submitted line by line.
    if (keys.length > 2 && keys.filter((k) => k.type === "enter").length >= 1 && keys.some((k) => k.type === "text")) {
      const onlyTextish = keys.every((k) => k.type === "text" || k.type === "enter" || k.type === "newline" || k.type === "tab");
      if (onlyTextish && chunk.length > 8) {
        const text = keys.map((k) => (k.type === "text" ? k.text : k.type === "tab" ? "\t" : "\n")).join("");
        return [{ type: "paste", text: text.replace(/\n$/, "") }];
      }
    }
    return keys;
  }
}

export class Editor {
  value = "";
  cursor = 0;
  mask = false;
  private history: string[] = [];
  private histIndex = -1;
  private draft = "";

  set(value: string) {
    this.value = value;
    this.cursor = value.length;
  }

  clear() {
    this.value = "";
    this.cursor = 0;
    this.histIndex = -1;
  }

  remember(entry: string) {
    if (entry.trim() && this.history[this.history.length - 1] !== entry) this.history.push(entry);
    this.histIndex = -1;
  }

  insert(text: string) {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  private lineStart(pos = this.cursor): number {
    return this.value.lastIndexOf("\n", pos - 1) + 1;
  }
  private lineEnd(pos = this.cursor): number {
    const i = this.value.indexOf("\n", pos);
    return i === -1 ? this.value.length : i;
  }
  private prevChar(pos: number): number {
    if (pos <= 0) return 0;
    const lo = this.value.charCodeAt(pos - 1);
    return lo >= 0xdc00 && lo <= 0xdfff && pos >= 2 ? pos - 2 : pos - 1;
  }
  private nextChar(pos: number): number {
    if (pos >= this.value.length) return this.value.length;
    const hi = this.value.charCodeAt(pos);
    return hi >= 0xd800 && hi <= 0xdbff ? pos + 2 : pos + 1;
  }
  private wordLeft(pos: number): number {
    let i = pos;
    while (i > 0 && /\s/.test(this.value[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.value[i - 1])) i--;
    return i;
  }
  private wordRight(pos: number): number {
    let i = pos;
    while (i < this.value.length && /\s/.test(this.value[i])) i++;
    while (i < this.value.length && !/\s/.test(this.value[i])) i++;
    return i;
  }

  /** Apply an editing key. Returns false if the key is not an editing key. */
  handle(key: Key): boolean {
    switch (key.type) {
      case "text":
      case "paste":
        this.insert(key.text);
        return true;
      case "newline":
        this.insert("\n");
        return true;
      case "backspace": {
        const p = this.prevChar(this.cursor);
        this.value = this.value.slice(0, p) + this.value.slice(this.cursor);
        this.cursor = p;
        return true;
      }
      case "delete":
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.nextChar(this.cursor));
        return true;
      case "left":
        this.cursor = this.prevChar(this.cursor);
        return true;
      case "right":
        this.cursor = this.nextChar(this.cursor);
        return true;
      case "home":
        this.cursor = this.lineStart();
        return true;
      case "end":
        this.cursor = this.lineEnd();
        return true;
      case "word-left":
        this.cursor = this.wordLeft(this.cursor);
        return true;
      case "word-right":
        this.cursor = this.wordRight(this.cursor);
        return true;
      case "delete-word": {
        const p = this.wordLeft(this.cursor);
        this.value = this.value.slice(0, p) + this.value.slice(this.cursor);
        this.cursor = p;
        return true;
      }
      case "kill-line": {
        const p = this.lineStart();
        this.value = this.value.slice(0, p) + this.value.slice(this.cursor);
        this.cursor = p;
        return true;
      }
      case "kill-to-end":
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.lineEnd());
        return true;
      case "up":
      case "down": {
        const up = key.type === "up";
        const start = this.lineStart();
        const onFirst = start === 0;
        const onLast = this.lineEnd() === this.value.length;
        if ((up && onFirst) || (!up && onLast)) {
          this.navigateHistory(up ? -1 : 1);
          return true;
        }
        const col = this.cursor - start;
        if (up) {
          const prevStart = this.lineStart(start - 1);
          this.cursor = Math.min(prevStart + col, start - 1);
        } else {
          const nextStart = this.lineEnd() + 1;
          this.cursor = Math.min(nextStart + col, this.lineEnd(nextStart));
        }
        return true;
      }
      default:
        return false;
    }
  }

  private navigateHistory(dir: -1 | 1) {
    if (!this.history.length) return;
    if (this.histIndex === -1) {
      if (dir === 1) return;
      this.draft = this.value;
      this.histIndex = this.history.length - 1;
    } else {
      this.histIndex += dir;
      if (this.histIndex >= this.history.length) {
        this.histIndex = -1;
        this.set(this.draft);
        return;
      }
      if (this.histIndex < 0) this.histIndex = 0;
    }
    this.set(this.history[this.histIndex]);
  }

  /**
   * Lay the text out for a given column budget: soft-wraps long lines and
   * reports where the caret is. At most `maxRows` rows around the caret are returned.
   */
  layout(cols: number, maxRows: number): { rows: string[]; cursorRow: number; cursorCol: number } {
    const text = this.mask ? "•".repeat(this.value.length) : this.value;
    const rows: string[] = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let offset = 0;
    const budget = Math.max(8, cols);
    for (const line of text.split("\n")) {
      let row = "";
      let rowW = 0;
      let i = 0;
      if (this.cursor === offset) {
        cursorRow = rows.length;
        cursorCol = 0;
      }
      while (i < line.length) {
        const cp = line.codePointAt(i)!;
        const ch = cp === 9 ? "  " : String.fromCodePoint(cp);
        const w = cp === 9 ? 2 : charWidth(cp);
        if (rowW + w > budget) {
          rows.push(row);
          row = "";
          rowW = 0;
        }
        row += ch;
        rowW += w;
        i += cp > 0xffff ? 2 : 1;
        if (this.cursor === offset + i) {
          cursorRow = rows.length;
          cursorCol = rowW;
        }
      }
      rows.push(row);
      offset += line.length + 1;
    }
    if (rows.length > maxRows) {
      const first = Math.min(Math.max(0, cursorRow - maxRows + 1), rows.length - maxRows);
      return { rows: rows.slice(first, first + maxRows), cursorRow: cursorRow - first, cursorCol };
    }
    return { rows, cursorRow, cursorCol };
  }
}

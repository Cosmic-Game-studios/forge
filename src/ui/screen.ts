// Screen: append-only scrollback plus a small "live" region at the bottom.
//
// Why this is fast:
//  - Finished output is written to the terminal exactly once and then belongs
//    to the terminal's own scrollback. It is never redrawn.
//  - Only the live region (a handful of rows: streaming tail, status, input)
//    is repainted, and repaints are coalesced to one frame per ~16 ms no
//    matter how many tokens arrive in between.
//  - Each frame is a single write wrapped in synchronized-output mode
//    (DEC 2026), so the terminal presents it atomically: no flicker, no tearing.
//  - Unchanged frames are skipped entirely.

import { truncate, termWidth } from "./term.ts";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const FRAME_MS = 16;

export interface LiveFrame {
  lines: string[];
  /** Cursor position inside the live region (row index, column), or null to hide it. */
  cursor: { row: number; col: number } | null;
}

export class Screen {
  private out: NodeJS.WriteStream;
  private pending: string[] = []; // committed lines not yet flushed
  private liveRows = 0; // rows the live region currently occupies
  private cursorRow = 0; // row inside the live region where the cursor was left
  private lastFrame = "";
  private timer: NodeJS.Timeout | null = null;
  private lastPaint = 0;
  private frameSource: () => LiveFrame = () => ({ lines: [], cursor: null });
  private closed = false;
  frames = 0; // painted frames (for diagnostics)

  constructor(out: NodeJS.WriteStream = process.stdout) {
    this.out = out;
    out.on("resize", () => {
      this.lastFrame = "";
      this.schedule();
    });
  }

  /** Provide the function that builds the live region on demand. */
  setFrameSource(fn: () => LiveFrame) {
    this.frameSource = fn;
    this.schedule();
  }

  /** Append finished lines to scrollback. */
  commit(...lines: string[]) {
    for (const l of lines) for (const part of l.split(/\r?\n/)) this.pending.push(part);
    this.schedule();
  }

  /** Request a repaint of the live region. Cheap; coalesced. */
  schedule() {
    if (this.timer || this.closed) return;
    const wait = Math.max(0, FRAME_MS - (Date.now() - this.lastPaint));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.paint();
    }, wait);
  }

  /** Paint immediately (used before exit and before handing the terminal away). */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.paint();
  }

  private paint() {
    if (this.closed) return;
    const cols = termWidth();
    const frame = this.frameSource();
    // Every live line must fit on one physical row, otherwise the row count
    // (and therefore the next repaint) would be wrong.
    const lines = frame.lines.map((l) => truncate(l, cols - 1));
    // Explicit CR+LF: correct whether or not the terminal translates a bare LF.
    const body = lines.join("\r\n");
    const key = body + "\u0001" + (frame.cursor ? `${frame.cursor.row}:${frame.cursor.col}` : "-");
    if (this.pending.length === 0 && key === this.lastFrame) return;

    let buf = SYNC_START;
    // Move to the top-left of the old live region and clear it.
    if (this.cursorRow > 0) buf += `\x1b[${this.cursorRow}A`;
    buf += "\r\x1b[J";
    if (this.pending.length) {
      buf += this.pending.join("\r\n") + "\r\n";
      this.pending = [];
    }
    buf += body;
    this.liveRows = lines.length;
    // Leave the cursor where the input caret is.
    if (frame.cursor && lines.length) {
      const up = lines.length - 1 - frame.cursor.row;
      if (up > 0) buf += `\x1b[${up}A`;
      buf += `\r`;
      if (frame.cursor.col > 0) buf += `\x1b[${Math.min(frame.cursor.col, cols - 1)}C`;
      buf += "\x1b[?25h";
      this.cursorRow = frame.cursor.row;
    } else {
      buf += "\x1b[?25l";
      this.cursorRow = Math.max(0, lines.length - 1);
    }
    buf += SYNC_END;
    this.out.write(buf);
    this.lastFrame = key;
    this.lastPaint = Date.now();
    this.frames++;
  }

  /**
   * Replace the screen and the terminal's scrollback with these lines; the live
   * region is painted below them. Lines committed but not yet flushed are
   * dropped: the caller's lines are meant to include them.
   */
  reset(lines: string[]) {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
    const body = lines.flatMap((l) => l.split(/\r?\n/)).join("\r\n");
    // Clear the visible screen and the scrollback, then start at the top.
    this.out.write(SYNC_START + "\x1b[H\x1b[2J\x1b[3J" + body + (lines.length ? "\r\n" : "") + SYNC_END);
    this.cursorRow = 0;
    this.liveRows = 0;
    this.lastFrame = "";
    this.paint();
  }

  /** Erase the live region and stop painting; scrollback stays. */
  close() {
    if (this.closed) return;
    this.flush();
    let buf = "";
    if (this.cursorRow > 0) buf += `\x1b[${this.cursorRow}A`;
    buf += "\r\x1b[J\x1b[?25h";
    this.out.write(buf);
    this.closed = true;
  }
}

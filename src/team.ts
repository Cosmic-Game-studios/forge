// The team: the main agent and its sub-agents talk to each other through
// mailboxes, and share findings on a board that every new sub-agent reads.
// A message reaches its recipient at the recipient's next step.

export interface TeamMessage {
  from: string;
  /** An agent id ("main", "ag2") or "all". */
  to: string;
  text: string;
  at: number;
}

const BOARD_BRIEF_CHARS = 6000;

export class Team {
  /** Everything said to "all": the shared context. */
  board: TeamMessage[] = [];
  /** Every message, for the record. */
  log: TeamMessage[] = [];
  private inbox = new Map<string, TeamMessage[]>();
  private waiters = new Map<string, Set<() => void>>();
  /** Called for every message that is sent. */
  onMessage: (m: TeamMessage) => void = () => {};

  /** The agents that can receive messages right now, "main" included. */
  private members: () => string[];

  constructor(members: () => string[]) {
    this.members = members;
  }

  /** Send a message. Returns an error text when the recipient cannot receive it, else null. */
  send(from: string, to: string, text: string): string | null {
    to = to.trim();
    const live = this.members();
    if (to !== "all" && !live.includes(to)) {
      const others = live.filter((m) => m !== from);
      return `"${to}" is not an active agent.${others.length ? ` Active: ${others.join(", ")}.` : " No other agent is active."} Use "all" to share something with everyone.`;
    }
    if (to === from) return "That is you.";
    const msg: TeamMessage = { from, to, text, at: Date.now() };
    this.log.push(msg);
    if (to === "all") this.board.push(msg);
    for (const id of to === "all" ? live.filter((m) => m !== from) : [to]) {
      const box = this.inbox.get(id) ?? [];
      box.push(msg);
      this.inbox.set(id, box);
      for (const wake of this.waiters.get(id) ?? []) wake();
    }
    this.onMessage(msg);
    return null;
  }

  /** Messages waiting for this agent; they are removed from its mailbox. */
  take(id: string): TeamMessage[] {
    const box = this.inbox.get(id) ?? [];
    this.inbox.delete(id);
    return box;
  }

  has(id: string): boolean {
    return (this.inbox.get(id)?.length ?? 0) > 0;
  }

  /** Wait until a message for this agent arrives, the time runs out or the signal fires. */
  async waitFor(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    if (this.has(id) || signal?.aborted) return;
    let timer: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    const set = this.waiters.get(id) ?? new Set();
    this.waiters.set(id, set);
    await new Promise<void>((resolve) => {
      wake = () => resolve();
      set.add(wake);
      timer = setTimeout(wake, ms);
      signal?.addEventListener("abort", wake, { once: true });
    });
    clearTimeout(timer);
    if (wake) {
      set.delete(wake);
      signal?.removeEventListener("abort", wake);
    }
  }

  /** What has been shared with everyone, for a new sub-agent's brief (newest kept when long). */
  shared(): string {
    const lines: string[] = [];
    let size = 0;
    for (const m of [...this.board].reverse()) {
      const line = `- ${m.from}: ${m.text.replace(/\s+/g, " ").trim()}`;
      if (size + line.length > BOARD_BRIEF_CHARS) break;
      lines.unshift(line);
      size += line.length;
    }
    return lines.join("\n");
  }

  clear() {
    this.board = [];
    this.log = [];
    this.inbox.clear();
  }
}

/** Messages as the recipient's model sees them. */
export function formatMail(mail: TeamMessage[]): string {
  return mail
    .map((m) => `[Message from ${m.from}${m.to === "all" ? " to all agents" : ""}]\n${m.text}`)
    .join("\n\n");
}

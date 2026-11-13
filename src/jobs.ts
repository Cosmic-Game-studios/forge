// Background jobs: shell commands that keep running (dev servers, watchers,
// long builds) and sub-agents that work while the main agent goes on.
// The agent hands finished jobs back to the model at its next step.

export type JobKind = "shell" | "agent";
export type JobStatus = "running" | "done" | "failed" | "stopped";

export interface Job {
  id: string;
  kind: JobKind;
  /** The command, or the sub-agent's short description. */
  label: string;
  started: number;
  ended?: number;
  status: JobStatus;
  /** Shell: everything printed so far (capped, oldest dropped). Agent: its final report. */
  output: string;
  /** How much of `output` the model has already been shown. */
  readPos: number;
  /** Characters dropped from the start of `output` to stay under the cap. */
  dropped: number;
  exitCode?: number | null;
  /** The latest thing it did: a sub-agent's current tool, a shell's last line. */
  activity: string;
  /** Tool calls a sub-agent has made. */
  calls: number;
  /** The model has been told that it finished. */
  reported: boolean;
  /** Runs alongside the agent that started it (false: that agent waits for it). */
  background: boolean;
  /** Pair mode: the partner model's name; its steps are shown in the transcript. */
  partner?: string;
  stop(): void;
  /** Settles when the job ends, however it ends. */
  done: Promise<void>;
}

const OUTPUT_CAP = 200_000;

export class Jobs {
  private all = new Map<string, Job>();
  private counters: Record<JobKind, number> = { shell: 0, agent: 0 };
  /** Called whenever a job starts, changes state or finishes. */
  onChange: (job: Job) => void = () => {};

  /** Register a job; `start` wires it up and returns how it stops and when it ends. */
  add(kind: JobKind, label: string, start: (job: Job) => { stop(): void; done: Promise<void> }, background = true): Job {
    const id = `${kind === "shell" ? "sh" : "ag"}${++this.counters[kind]}`;
    const job: Job = {
      id,
      kind,
      label,
      started: Date.now(),
      status: "running",
      output: "",
      readPos: 0,
      dropped: 0,
      activity: "",
      calls: 0,
      reported: false,
      background,
      stop: () => {},
      done: Promise.resolve(),
    };
    this.all.set(id, job);
    const wired = start(job);
    job.stop = wired.stop;
    job.done = wired.done.finally(() => {
      job.ended ??= Date.now();
      if (job.status === "running") job.status = "done";
      this.onChange(job);
    });
    this.onChange(job);
    return job;
  }

  /** Append output to a shell job, dropping the oldest part beyond the cap. */
  append(job: Job, text: string) {
    job.output += text;
    if (job.output.length > OUTPUT_CAP) {
      const cut = job.output.length - OUTPUT_CAP;
      job.output = job.output.slice(cut);
      job.dropped += cut;
      job.readPos = Math.max(0, job.readPos - cut);
    }
    const last = job.output.split(/\r?\n|\r/).filter((l) => l.trim()).pop();
    if (last) job.activity = last.slice(0, 200);
  }

  get(id: string): Job | undefined {
    return this.all.get(id.trim());
  }

  list(): Job[] {
    return [...this.all.values()];
  }

  running(kind?: JobKind): Job[] {
    return this.list().filter((j) => j.status === "running" && (!kind || j.kind === kind));
  }

  /** Jobs that ended and that the model has not heard about yet. */
  unreported(): Job[] {
    return this.list().filter((j) => j.status !== "running" && !j.reported);
  }

  /** Wait until one of these jobs ends, the time runs out or the signal fires. */
  async waitAny(jobs: Job[], ms: number, signal?: AbortSignal): Promise<void> {
    if (!jobs.length) return;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      ...jobs.map((j) => j.done),
      new Promise<void>((r) => {
        timer = setTimeout(r, ms);
        onAbort = () => r();
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }

  stopAll(kind?: JobKind) {
    for (const j of this.running(kind)) {
      j.status = "stopped";
      j.stop();
    }
  }
}

export function jobAge(job: Job, now = Date.now()): number {
  return (job.ended ?? now) - job.started;
}

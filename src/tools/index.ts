// Tool registry, input validation, and the two "meta" tools (todo, task).

import { c } from "../ui/term.ts";
import { checkTool } from "./check.ts";
import { editTool, multiEditTool, readTool, writeTool } from "./fs.ts";
import { rememberTool } from "../notes.ts";
import { depsTool } from "./graph.ts";
import { outlineTool } from "./outline.ts";
import { scene3dTool } from "./scene3d.ts";
import { screenshotTool } from "./screenshot.ts";
import { globTool, grepTool } from "./search.ts";
import { describeJob, shellTool } from "./shell.ts";
import { formatMail } from "../team.ts";
import { clip, type TodoItem, type Tool } from "./types.ts";

const todoTool: Tool = {
  kind: "meta",
  spec: {
    name: "todo",
    description:
      "Record or update your task list for multi-step work. Send the complete list every time; it replaces the previous one. Keep exactly one item `in_progress` while working and mark items `completed` as soon as they are done. The user sees this list, so it doubles as a progress report. Skip it for small, single-step requests.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Short imperative description of the step." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  summarize: (i) => {
    const list = Array.isArray(i.todos) ? i.todos : [];
    const done = list.filter((t: TodoItem) => t.status === "completed").length;
    return `${done}/${list.length} done`;
  },
  async run(input, ctx) {
    const list: TodoItem[] = (Array.isArray(input.todos) ? input.todos : [])
      .filter((t: unknown) => t && typeof t === "object")
      .map((t: Record<string, unknown>) => ({
        content: String(t.content ?? ""),
        status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
      }));
    ctx.todos.length = 0;
    ctx.todos.push(...list);
    const display = list.map((t) =>
      t.status === "completed" ? `${c.green("✔")} ${c.dim(t.content)}` : t.status === "in_progress" ? `${c.orange("◼")} ${c.bold(t.content)}` : c.dim(`◻ ${t.content}`),
    );
    return { content: "Task list updated.", display };
  },
};

const taskTool: Tool = {
  kind: "read", // sub-agents may run in parallel with each other
  spec: {
    name: "task",
    description:
      "Hand a self-contained piece of work to a sub-agent that starts with an empty context and has the same file, search and shell tools. It returns only its final report, so the files it read do not fill your context. Sub-agents usually run on a smaller, cheaper model: they are good at searching, reading and summarizing, and should not be trusted with changes that need careful judgment - make those yourself. A sub-agent still costs an extra model session, so use one when that buys something: a broad search or investigation across many files whose details you do not need, or independent pieces of work that can run in parallel (issue several task calls in one turn). Do the work yourself when it is a few tool calls or when you already know where to look. The sub-agent knows nothing about this conversation: state the goal, what is already known, the files or directories that matter, and exactly what to report back. Parallel sub-agents must not edit the same files. Sub-agents get an id (ag1, ag2, …) and can message you and each other with the message tool, so parallel sub-agents can split work and share findings; you can message a running one to redirect it. Set `background: true` to keep working yourself while a sub-agent runs: you get its job id at once, its report is handed to you when it finishes, and your turn does not end before every background sub-agent has reported.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "3-6 words naming the task, shown to the user." },
        prompt: { type: "string", description: "The full brief for the sub-agent." },
        background: { type: "boolean", description: "Run it in the background and return at once with its job id." },
      },
      required: ["description", "prompt"],
    },
  },
  summarize: (i) => String(i.description ?? "") + (i.background ? c.dim(" (background)") : ""),
  async run(input, ctx) {
    if (input.background) {
      if (!ctx.startSubagent) return { content: "Background sub-agents are not available here; run the task normally.", isError: true };
      const job = ctx.startSubagent(String(input.prompt), String(input.description ?? "sub-agent"));
      return {
        content: `Started the sub-agent in the background as job ${job.id}. Go on with other work; its report is handed to you when it is done. To wait for it, use jobs {action: "output", id: "${job.id}", wait: <seconds>}.`,
        display: [c.dim(`working in the background as ${job.id}`)],
      };
    }
    const report = await ctx.runSubagent(String(input.prompt), String(input.description ?? "sub-agent"));
    return { content: report || "(the sub-agent returned no report)", display: [c.dim(`report: ${report.length} chars`)] };
  },
};

const jobsTool: Tool = {
  kind: "read",
  spec: {
    name: "jobs",
    description:
      "List, read or stop background jobs: commands started with bash `background: true` and sub-agents started with task `background: true`. `output` returns what a command printed since you last looked, or a sub-agent's report once it is done; with `wait` it first waits up to that many seconds for the job to end. `stop` ends a job. Stop servers and watchers you no longer need before you finish.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "output", "stop"] },
        id: { type: "string", description: "The job id, e.g. sh1 or ag2 (not needed for list)." },
        wait: { type: "integer", description: "For output: seconds to wait for the job to end first (max 600)." },
      },
      required: ["action"],
    },
  },
  summarize: (i) => `${i.action ?? ""}${i.id ? " " + i.id : ""}${i.wait ? c.dim(` (wait up to ${i.wait}s)`) : ""}`,
  async run(input, ctx) {
    const jobs = ctx.jobs;
    if (!jobs) return { content: "Background jobs are not available here.", isError: true };
    if (input.action === "list") {
      const all = jobs.list();
      if (!all.length) return { content: "No background jobs.", display: [c.dim("none")] };
      const lines = all.map(describeJob);
      return { content: lines.join("\n"), display: lines.map((l) => c.dim(l)) };
    }
    const job = jobs.get(String(input.id ?? ""));
    if (!job) {
      const known = jobs.list().map((j) => j.id);
      return { content: `No job "${input.id ?? ""}".${known.length ? ` Known jobs: ${known.join(", ")}.` : " There are no background jobs."}`, isError: true };
    }
    if (input.action === "stop") {
      if (job.status === "running") {
        job.status = "stopped";
        job.stop();
        await jobs.waitAny([job], 3000);
      }
      job.reported = true;
      return { content: `${describeJob(job)}.`, display: [c.dim(`${job.id} ${job.status}`)] };
    }
    const wait = Math.min(600, Math.max(0, Number(input.wait) || 0));
    if (wait && job.status === "running") await jobs.waitAny([job], wait * 1000, ctx.signal);
    if (job.kind === "agent") {
      if (job.status === "running") {
        return { content: `${describeJob(job)}. Still working${job.activity ? `; now: ${job.activity}` : ""}.`, display: [c.dim(`still working · ${job.calls} tool calls`)] };
      }
      job.reported = true;
      return { content: `${describeJob(job)}.\n\nReport:\n${job.output || "(no report)"}`, display: [c.dim(`report: ${job.output.length} chars`)] };
    }
    const fresh = job.output.slice(job.readPos).replace(/\s+$/, "");
    job.readPos = job.output.length;
    if (job.status !== "running") job.reported = true;
    const lines = fresh ? fresh.split("\n") : [];
    return {
      content: `${describeJob(job)}.\n${fresh ? clip(fresh, 30_000) : "(no new output)"}`,
      display: [c.dim(`${job.status} · ${lines.length} new line${lines.length === 1 ? "" : "s"}`), ...lines.slice(-3).map((l) => c.dim(l))],
    };
  },
};

const messageTool: Tool = {
  kind: "read",
  spec: {
    name: "message",
    description:
      "Talk to the other agents working on this request. The main agent is `main`; sub-agents have ids like ag1, ag2. Send to one agent by id, or to `all` to share a finding with every active agent: what goes to `all` is also kept on a shared board that every sub-agent started later receives in its brief. A message reaches its recipient at the recipient's next step. Use it to share what others need (a file you found, an interface you settled, a fact that changes their work), to avoid doing the same work twice, and to ask when you are blocked. With `wait`, wait up to that many seconds for a reply addressed to you and return it. The main agent can reply only between its own steps: it cannot answer while it waits for a sub-agent it started in the foreground. Keep messages short and concrete.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "An agent id (main, ag1, …) or all." },
        text: { type: "string", description: "The message." },
        wait: { type: "integer", description: "Seconds to wait for a reply (max 600). Leave out to go on at once." },
      },
      required: ["to", "text"],
    },
  },
  summarize: (i, ctx) => `${ctx.agentId ?? "?"} → ${i.to ?? ""}${i.wait ? c.dim(` (waits up to ${i.wait}s)`) : ""}`,
  async run(input, ctx) {
    const team = ctx.team;
    const me = ctx.agentId;
    if (!team || !me) return { content: "Messaging is not available here.", isError: true };
    const error = team.send(me, String(input.to), String(input.text));
    if (error) return { content: error, isError: true };
    const wait = Math.min(600, Math.max(0, Number(input.wait) || 0));
    if (!wait) return { content: `Sent to ${input.to}.`, display: [c.dim(truncateText(String(input.text), 90))] };
    await team.waitFor(me, wait * 1000, ctx.signal);
    const mail = team.take(me);
    return {
      content: `Sent to ${input.to}.${mail.length ? `\n\n${formatMail(mail)}` : ` No reply within ${wait}s; go on with what you can do.`}`,
      display: [c.dim(mail.length ? `${mail.length} repl${mail.length === 1 ? "y" : "ies"}` : "no reply yet")],
    };
  },
};

function truncateText(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export const advisorTool: Tool = {
  kind: "read",
  spec: {
    name: "advisor",
    description:
      "Ask a much stronger and much more expensive model for help with a hard problem. It reads your question and a condensed record of this conversation (the request, what you tried, recent tool results) and answers with an analysis and concrete next steps; it cannot run tools or see files beyond that record. Use it only when it pays off: you failed twice at the same problem, you cannot explain a bug, or a design decision is hard to undo. Do not use it for routine work. Ask one precise question, say what you tried and what happened, and quote the error. Treat the answer as guidance from a senior engineer: follow it, and verify it in the code. The number of calls per request is limited.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The problem, what you tried, what happened, and what you need to know." },
      },
      required: ["question"],
    },
  },
  summarize: (i) => truncateText(String(i.question ?? ""), 70),
  async run(input, ctx) {
    if (!ctx.consult) return { content: "The advisor is not available here.", isError: true };
    const answer = await ctx.consult(String(input.question));
    return { content: answer, display: [c.dim(`advice: ${answer.length} chars`)] };
  },
};

/** Tools for the main agent, and the subset a sub-agent gets (no nested sub-agents). */
export function buildTools(opts: { subagent: boolean }): Map<string, Tool> {
  // FORGE_BASELINE=1 leaves only the tools every coding agent has; the benchmark compares against it.
  if (process.env.FORGE_BASELINE === "1") return new Map([readTool, writeTool, editTool, globTool, grepTool, shellTool, todoTool].map((t) => [t.spec.name, t]));
  const list = [readTool, outlineTool, depsTool, writeTool, editTool, multiEditTool, globTool, grepTool, shellTool, checkTool, todoTool];
  if (!opts.subagent) list.push(screenshotTool, scene3dTool, rememberTool);
  if (!opts.subagent) list.push(taskTool, jobsTool, advisorTool);
  list.push(messageTool);
  return new Map(list.map((t) => [t.spec.name, t]));
}

/**
 * Check a tool input against its schema. Tool inputs stream eagerly, so the
 * API does not validate them for us: a truncated or mistyped input must be
 * caught here and reported back to the model instead of being executed.
 */
export function validateInput(tool: Tool, input: Record<string, unknown>): string | null {
  const schema = tool.spec.input_schema;
  for (const key of schema.required ?? []) {
    if (input[key] === undefined || input[key] === null) return `Missing required parameter \`${key}\`.`;
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = schema.properties[key] as { type?: string; enum?: unknown[] } | undefined;
    if (!prop) continue; // unknown extras are ignored rather than rejected
    if (value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const ok =
      !prop.type ||
      prop.type === actual ||
      (prop.type === "integer" && typeof value === "number" && Number.isFinite(value)) ||
      (prop.type === "number" && typeof value === "number");
    if (!ok) {
      // Models occasionally send "5" for an integer or "true" for a boolean; coerce the harmless cases.
      if ((prop.type === "integer" || prop.type === "number") && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
        input[key] = Number(value);
        continue;
      }
      if (prop.type === "boolean" && (value === "true" || value === "false")) {
        input[key] = value === "true";
        continue;
      }
      return `Parameter \`${key}\` must be of type ${prop.type}, got ${actual}.`;
    }
    if (prop.enum && !prop.enum.includes(value)) return `Parameter \`${key}\` must be one of: ${prop.enum.join(", ")}.`;
  }
  return null;
}

export type { Tool, ToolContext, ToolOutput, TodoItem } from "./types.ts";

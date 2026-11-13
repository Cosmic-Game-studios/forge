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
import { shellTool } from "./shell.ts";
import type { TodoItem, Tool } from "./types.ts";

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
      t.status === "completed" ? c.dim(`☑ ${t.content}`) : t.status === "in_progress" ? c.bold(`▸ ${t.content}`) : `☐ ${t.content}`,
    );
    return { content: "Task list updated.", display };
  },
};

const taskTool: Tool = {
  kind: "read", // sub-agents may run in parallel with each other
  spec: {
    name: "task",
    description:
      "Hand a self-contained piece of work to a sub-agent that starts with an empty context and has the same file, search and shell tools. It returns only its final report, so the files it read do not fill your context. Sub-agents usually run on a smaller, cheaper model: they are good at searching, reading and summarizing, and should not be trusted with changes that need careful judgment - make those yourself. A sub-agent still costs an extra model session, so use one when that buys something: a broad search or investigation across many files whose details you do not need, or independent pieces of work that can run in parallel (issue several task calls in one turn). Do the work yourself when it is a few tool calls or when you already know where to look. The sub-agent knows nothing about this conversation: state the goal, what is already known, the files or directories that matter, and exactly what to report back. Parallel sub-agents must not edit the same files.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "3-6 words naming the task, shown to the user." },
        prompt: { type: "string", description: "The full brief for the sub-agent." },
      },
      required: ["description", "prompt"],
    },
  },
  summarize: (i) => String(i.description ?? ""),
  async run(input, ctx) {
    const report = await ctx.runSubagent(String(input.prompt), String(input.description ?? "sub-agent"));
    return { content: report || "(the sub-agent returned no report)", display: [c.dim(`report: ${report.length} chars`)] };
  },
};

/** Tools for the main agent, and the subset a sub-agent gets (no nested sub-agents). */
export function buildTools(opts: { subagent: boolean }): Map<string, Tool> {
  // FORGE_BASELINE=1 leaves only the tools every coding agent has; the benchmark compares against it.
  if (process.env.FORGE_BASELINE === "1") return new Map([readTool, writeTool, editTool, globTool, grepTool, shellTool, todoTool].map((t) => [t.spec.name, t]));
  const list = [readTool, outlineTool, depsTool, writeTool, editTool, multiEditTool, globTool, grepTool, shellTool, checkTool, todoTool];
  if (!opts.subagent) list.push(screenshotTool, scene3dTool, rememberTool);
  if (!opts.subagent) list.push(taskTool);
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

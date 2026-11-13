#!/usr/bin/env node
// Forge entry point: argument parsing, interactive mode, headless mode, key management.

import fs from "node:fs";
import { Agent, type AgentUI } from "./agent.ts";
import {
  EFFORTS,
  PERMISSION_MODES,
  PROVIDERS,
  envVarName,
  getKey,
  keySource,
  loadConfig,
  maskKey,
  saveConfig,
  type Effort,
  type PermissionMode,
  type ProviderId,
} from "./config.ts";
import { ANTHROPIC_MODELS, formatModelRef, parseModelRef } from "./models.ts";
import { loadSession } from "./session.ts";
import { pickInitialModel, runInteractive } from "./ui/app.ts";
import { STAGE, VERSION } from "./version.ts";
import { c, stripAnsi } from "./ui/term.ts";

const HELP = `Forge - a terminal coding agent for Claude models

Usage
  forge                      start an interactive session in the current folder
  forge "fix the failing test"   start with a first message
  forge -p "question"        headless: run one request, print the answer, exit
  forge keys                 show which API keys are configured
  forge keys set <provider>  store a key (anthropic | openrouter | openai); reads it from stdin
  forge models               list the built-in Claude models

Options
  -m, --model <provider:id>  e.g. anthropic:claude-opus-5-5, openrouter:anthropic/claude-opus-5.5
  -e, --effort <level>       low | medium | high | xhigh | max   (default: high)
      --mode <mode>          ask | auto-edit | yolo               (default: ask)
  -c, --continue             continue the most recent conversation in this folder
      --resume <id>          continue a specific conversation
  -p, --print                headless mode (edits and commands need --mode auto-edit or yolo)
  -h, --help                 this text
  -v, --version

Keys are read from ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY, or from
~/.forge/config.json (set them inside Forge with /keys).`;

interface Args {
  prompt: string[];
  model?: string;
  effort?: string;
  mode?: string;
  cont: boolean;
  resume?: string;
  print: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { prompt: [], cont: false, print: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Option ${arg} needs a value.`);
      return v;
    };
    if (arg === "-h" || arg === "--help") a.help = true;
    else if (arg === "-v" || arg === "--version") a.version = true;
    else if (arg === "-p" || arg === "--print") a.print = true;
    else if (arg === "-c" || arg === "--continue") a.cont = true;
    else if (arg === "--resume") a.resume = next();
    else if (arg === "-m" || arg === "--model") a.model = next();
    else if (arg === "-e" || arg === "--effort") a.effort = next();
    else if (arg === "--mode") a.mode = next();
    else if (arg === "--yolo") a.mode = "yolo";
    else if (arg.startsWith("-") && arg.length > 1) throw new Error(`Unknown option ${arg}. Try --help.`);
    else a.prompt.push(arg);
  }
  return a;
}

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function keysCommand(args: string[]): Promise<number> {
  const cfg = loadConfig();
  if (args[0] === "set") {
    const provider = args[1] as ProviderId;
    if (!PROVIDERS.includes(provider)) {
      console.error(`Usage: forge keys set <${PROVIDERS.join("|")}>   (the key is read from stdin)`);
      return 2;
    }
    if (process.stdin.isTTY) console.error(`Paste the ${provider} key, then press enter and ctrl+${process.platform === "win32" ? "z, enter" : "d"}:`);
    const key = (await readStdin()).trim();
    if (!key) {
      console.error("No key received.");
      return 1;
    }
    cfg.keys[provider] = key;
    saveConfig(cfg);
    console.log(`Saved the ${provider} key (${maskKey(key)}).`);
    return 0;
  }
  for (const p of PROVIDERS) {
    const key = getKey(cfg, p);
    const src = keySource(cfg, p);
    console.log(`${p.padEnd(11)} ${key ? `${maskKey(key)}  (${src === "env" ? envVarName(p) : "saved in ~/.forge/config.json"})` : "not set"}`);
  }
  return 0;
}

/** Headless UI: answer on stdout, activity on stderr, no prompts. */
function headlessUI(): AgentUI {
  let wroteText = false;
  return {
    onText(delta) {
      process.stdout.write(delta);
      wroteText = true;
    },
    onThinking() {},
    onAssistantEnd() {
      if (wroteText) process.stdout.write("\n");
      wroteText = false;
    },
    onToolPending() {},
    onToolProgress() {},
    onToolStart(call, summary, depth) {
      process.stderr.write(c.dim(`${"  ".repeat(depth)}● ${call.name} ${stripAnsi(summary)}\n`));
    },
    onToolLive() {},
    onToolEnd(call, output, _ms, depth) {
      if (output.isError) {
        const msg = typeof output.content === "string" ? output.content.split("\n")[0] : "error";
        process.stderr.write(c.red(`${"  ".repeat(depth)}  ✗ ${call.name}: ${msg}\n`));
      }
    },
    onServerTool(name, detail) {
      process.stderr.write(c.dim(`● ${name} ${detail}\n`));
    },
    onNotice(msg, level) {
      process.stderr.write((level === "error" ? c.red : c.yellow)(`▪ ${msg}\n`));
    },
    onStats() {},
    async askPermission(req) {
      return {
        allow: false,
        feedback: `Forge runs headless in "ask" mode, so ${req.tool} calls that change things are not permitted. Finish with what you can do read-only and tell the user to re-run with --mode auto-edit or --mode yolo.`,
      };
    },
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "keys") return keysCommand(argv.slice(1));
  if (argv[0] === "models") {
    for (const m of ANTHROPIC_MODELS) console.log(`anthropic:${m.id.padEnd(20)} ${m.name}${m.note ? "  - " + m.note : ""}`);
    console.log("\nOpenRouter and OpenAI models are listed live inside Forge with /model.");
    return 0;
  }

  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.version) {
    console.log(`forge ${VERSION} ${STAGE}`.trim());
    return 0;
  }

  const cfg = loadConfig();
  if (args.effort) {
    if (!EFFORTS.includes(args.effort as Effort)) throw new Error(`Unknown effort "${args.effort}". Use: ${EFFORTS.join(", ")}.`);
    cfg.effort = args.effort as Effort;
  }
  if (args.mode) {
    if (!PERMISSION_MODES.includes(args.mode as PermissionMode)) throw new Error(`Unknown mode "${args.mode}". Use: ${PERMISSION_MODES.join(", ")}.`);
    cfg.permissionMode = args.mode as PermissionMode;
  }
  if (args.model) {
    const ref = parseModelRef(args.model) ?? (ANTHROPIC_MODELS.some((m) => m.id === args.model) ? { provider: "anthropic" as const, id: args.model } : null);
    if (!ref) throw new Error(`Model must look like provider:id, e.g. anthropic:claude-opus-5-5.`);
    cfg.model = formatModelRef(ref);
  }

  const cwd = process.cwd();
  const resume = args.resume ? loadSession(cwd, args.resume) : args.cont ? loadSession(cwd) : null;
  if ((args.resume || args.cont) && !resume) console.error(c.yellow("No earlier conversation found in this folder; starting a new one."));
  if (resume && args.model) resume.model = cfg.model!;

  let prompt = args.prompt.join(" ").trim();
  const piped = !process.stdin.isTTY;

  if (args.print || piped || !process.stdout.isTTY) {
    // Read the prompt from stdin only when none was given as an argument:
    // an inherited stdin that never closes (CI, scripts) would block forever.
    if (piped && !prompt) prompt = (await readStdin()).trim();
    if (!prompt) {
      console.error("Nothing to do: pass a prompt, e.g. forge -p \"explain this project\".");
      return 2;
    }
    const model = (resume && parseModelRef(resume.model)) || pickInitialModel(cfg);
    const agent = new Agent({ cfg, cwd, ui: headlessUI(), model, resume });
    process.on("SIGINT", () => agent.interrupt());
    await agent.init(); // project MCP servers start only if approved earlier in the interactive app
    try {
      await agent.run(prompt);
    } finally {
      agent.close();
      // For scripts and the benchmark: what the run cost.
      if (process.env.FORGE_STATS_FILE) fs.writeFileSync(process.env.FORGE_STATS_FILE, JSON.stringify({ usage: agent.stats.total, cost: agent.stats.cost, requests: agent.requests }));
    }
    return 0;
  }

  await runInteractive({ cfg, cwd, resume, initialPrompt: prompt || undefined });
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    // Let stdout drain, then leave even if a stray handle is still open.
    setTimeout(() => process.exit(code), 50).unref();
  },
  (err) => {
    console.error(c.red(`forge: ${(err as Error).message}`));
    process.exit(1);
  },
);

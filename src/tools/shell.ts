// Shell tool. Each command runs in a fresh shell process, but the working
// directory carries over between calls (a `cd` sticks), like a real session.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jobAge, type Job, type Jobs } from "../jobs.ts";
import { c, stripAnsi, formatDuration } from "../ui/term.ts";
import { clip, type Tool, type ToolContext } from "./types.ts";

export interface ShellInfo {
  kind: "bash" | "powershell";
  path: string;
  label: string;
}

let cached: ShellInfo | null = null;

export function detectShell(): ShellInfo {
  if (cached) return cached;
  if (process.platform !== "win32") {
    const bash = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find((p) => fs.existsSync(p));
    cached = bash ? { kind: "bash", path: bash, label: "bash" } : { kind: "bash", path: "/bin/sh", label: "sh (POSIX)" };
    return cached;
  }
  // Windows: prefer Git Bash (the model writes much better POSIX shell than PowerShell).
  const candidates = [
    process.env.FORGE_SHELL,
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  ].filter((p): p is string => !!p);
  const where = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
  if (where.status === 0) {
    const gitExe = where.stdout.split(/\r?\n/)[0]?.trim();
    if (gitExe) candidates.push(path.join(path.dirname(path.dirname(gitExe)), "bin", "bash.exe"));
  }
  const bash = candidates.find((p) => fs.existsSync(p));
  if (bash) {
    cached = { kind: "bash", path: bash, label: "bash (Git Bash on Windows; use POSIX syntax and forward slashes)" };
    return cached;
  }
  const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0;
  cached = { kind: "powershell", path: pwsh ? "pwsh" : "powershell.exe", label: pwsh ? "PowerShell 7" : "Windows PowerShell 5.1" };
  return cached;
}

const CWD_MARK = "__FORGE_CWD__";

function wrapCommand(shell: ShellInfo, command: string): { file: string; args: string[] } {
  if (shell.kind === "bash") {
    // The shell records its own pid so a timeout can kill the whole process group (see killTree).
    const script = `[ -n "$FORGE_PIDFILE" ] && echo $$ > "$FORGE_PIDFILE"\n${command}\n__forge_rc=$?\nprintf '\\n${CWD_MARK}%s\\n' "$(pwd -W 2>/dev/null || pwd)"\nexit $__forge_rc`;
    return { file: shell.path, args: ["-c", script] };
  }
  const script =
    `${command}\n$__forge_rc = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n` +
    `Write-Output "\`n${CWD_MARK}$((Get-Location).Path)"\nexit $__forge_rc`;
  return { file: shell.path, args: ["-NoProfile", "-NonInteractive", "-Command", script] };
}

function killTree(pid: number, shell: ShellInfo, pidFile: string) {
  if (process.platform === "win32") {
    // Git Bash children are not reliably part of the Windows process tree, so
    // taskkill alone leaves them running. Ask bash to kill its own process group first.
    if (shell.kind === "bash") {
      try {
        const shellPid = fs.readFileSync(pidFile, "utf8").trim();
        if (/^\d+$/.test(shellPid)) {
          spawnSync(shell.path, ["-c", `kill -9 -- -${shellPid} 2>/dev/null; kill -9 ${shellPid} 2>/dev/null`], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 5000,
          });
        }
      } catch {
        /* no pid recorded; fall through to taskkill */
      }
    }
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

let callCounter = 0;
const HEAD_KEEP = 20_000;
const TAIL_KEEP = 20_000;

export const shellTool: Tool = {
  kind: "exec",
  spec: {
    name: "bash",
    description:
      "Run a shell command and return its combined stdout/stderr and exit code. The working directory persists between calls; other shell state (variables, functions) does not. Commands run non-interactively with no stdin, so pass flags that avoid prompts (`-y`, `--no-edit`, ...) and never start an editor or pager. Use this for builds, tests, git, package managers and anything without a dedicated tool. Prefer the read/edit/glob/grep tools for file work: they are faster and their results are easier for the user to review. Default timeout is 120 s (max 600 s). For servers, watchers and long builds set `background: true`: the command keeps running, you get its id and first output after a few seconds, and you can read more output or stop it with the `jobs` tool while you go on working. Forge tells you when a background command exits. Do not use `&` or `nohup` for this.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
        timeout: { type: "integer", description: "Timeout in seconds (default 120, max 600)." },
        description: { type: "string", description: "A few words on what this command does, shown to the user." },
        background: { type: "boolean", description: "Keep the command running in the background and return at once with its job id." },
      },
      required: ["command"],
    },
  },
  summarize: (i) => {
    const cmd = String(i.command ?? "").split("\n");
    return cmd[0] + (cmd.length > 1 ? c.dim(` … (+${cmd.length - 1} lines)`) : "") + (i.background ? c.dim(" (background)") : "");
  },
  async run(input, ctx) {
    if (input.background) {
      if (!ctx.jobs) return { content: "Background commands are not available here; run the command normally.", isError: true };
      return startBackground(String(input.command), ctx, ctx.jobs, input.description ? String(input.description) : "");
    }
    const shell = detectShell();
    const timeoutMs = Math.min(600, Math.max(1, Number(input.timeout) || 120)) * 1000;
    const { file, args } = wrapCommand(shell, String(input.command));
    const pidFile = path.join(os.tmpdir(), `forge-${process.pid}-${++callCounter}.pid`).split(path.sep).join("/");

    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn(file, args, {
          cwd: ctx.cwd,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, CI: process.env.CI ?? "1", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", FORGE_PIDFILE: pidFile },
        });
      } catch (err) {
        resolve({ content: `Could not start the shell (${file}): ${(err as Error).message}`, isError: true });
        return;
      }

      let head = "";
      let tail = "";
      let total = 0;
      let timedOut = false;
      let lastProgress = 0;

      const onData = (d: Buffer) => {
        const s = d.toString("utf8");
        total += s.length;
        if (head.length < HEAD_KEEP) head += s.slice(0, HEAD_KEEP - head.length);
        tail = (tail + s).slice(-TAIL_KEEP - 200);
        const now = Date.now();
        if (now - lastProgress > 100) {
          lastProgress = now;
          const lines = stripAnsi(tail).split(/\r?\n|\r/).filter((l) => l.trim() && !l.includes(CWD_MARK));
          if (lines.length) ctx.progress(lines[lines.length - 1]);
        }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);

      let settled = false;
      const kill = () => {
        if (child.pid) killTree(child.pid, shell, pidFile);
        // Never wait forever for a process that ignores the kill or keeps the pipes open.
        setTimeout(() => finish(null), 2000).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => kill();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (code: number | null, spawnError?: string) => {
        if (settled) return;
        settled = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        fs.rm(pidFile, { force: true }, () => {});
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        let output = total <= HEAD_KEEP + TAIL_KEEP ? (total <= HEAD_KEEP ? head : head + tail.slice(-(total - head.length))) : `${head}\n\n[... ${total - HEAD_KEEP - TAIL_KEEP} characters omitted ...]\n\n${tail.slice(-TAIL_KEEP)}`;
        output = stripAnsi(output).replace(/\r\n/g, "\n");

        // Pick up the working directory the command ended in.
        const mark = output.lastIndexOf(CWD_MARK);
        if (mark !== -1) {
          const newCwd = output.slice(mark + CWD_MARK.length).split("\n")[0].trim();
          output = output.slice(0, mark).replace(/\n$/, "");
          if (newCwd && fs.existsSync(newCwd)) ctx.cwd = path.resolve(newCwd);
        }
        output = output.replace(/\s+$/, "");

        let status: string;
        let isError = false;
        if (spawnError) {
          status = `Could not run the command: ${spawnError}`;
          isError = true;
        } else if (ctx.signal.aborted) {
          status = "Command was interrupted by the user.";
          isError = true;
        } else if (timedOut) {
          status = `Command timed out after ${timeoutMs / 1000}s and was killed. If it needs longer, raise \`timeout\`; if it never exits (server, watcher), run it in the background.`;
          isError = true;
        } else if (code !== 0) {
          status = `Exit code ${code}`;
          isError = true;
        } else status = "";

        const body = clip(output || "(no output)", 40_000) + (status ? `\n\n${status}` : "");
        const shownLines = output ? output.split("\n") : [];
        const preview = shownLines.slice(-6).map((l) => c.dim(l));
        if (shownLines.length > 6) preview.unshift(c.dim(`… ${shownLines.length - 6} earlier lines`));
        if (status) preview.push(c.red(status.split(". ")[0]));
        resolve({ content: body, isError, display: preview.length ? preview : [c.dim("(no output)")] });
      };

      child.on("error", (err) => finish(null, err.message));
      child.on("close", (code) => finish(code));
    });
  },
};

/** How long a new background command is watched before the tool returns. */
const BACKGROUND_PEEK_MS = 3000;

/** Start a command that keeps running; the tool returns after a short look at its first output. */
async function startBackground(command: string, ctx: ToolContext, jobs: Jobs, description: string) {
  const shell = detectShell();
  const { file, args } = wrapCommand(shell, command);
  const pidFile = path.join(os.tmpdir(), `forge-${process.pid}-${++callCounter}.pid`).split(path.sep).join("/");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(file, args, {
      cwd: ctx.cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: process.env.CI ?? "1", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", FORGE_PIDFILE: pidFile },
    });
  } catch (err) {
    return { content: `Could not start the shell (${file}): ${(err as Error).message}`, isError: true };
  }
  const job = jobs.add("shell", description || command.split("\n")[0], (j) => ({
    stop: () => {
      if (child.pid) killTree(child.pid, shell, pidFile);
    },
    done: new Promise<void>((resolve) => {
      const onData = (d: Buffer) => jobs.append(j, stripAnsi(d.toString("utf8")).replace(/\r\n/g, "\n"));
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.on("error", (err) => {
        jobs.append(j, `\nCould not run the command: ${err.message}\n`);
        j.status = "failed";
        resolve();
      });
      child.on("close", (code) => {
        // The working-directory marker is bookkeeping, not output.
        const mark = j.output.lastIndexOf(CWD_MARK);
        if (mark !== -1) j.output = j.output.slice(0, mark).replace(/\n$/, "");
        j.exitCode = code;
        if (j.status === "running") j.status = code === 0 ? "done" : "failed";
        fs.rm(pidFile, { force: true }, () => {});
        resolve();
      });
    }),
  }));
  // A server prints its address, a build its first error: worth waiting a moment for.
  await jobs.waitAny([job], BACKGROUND_PEEK_MS, ctx.signal);
  const first = job.output.replace(/\s+$/, "");
  job.readPos = job.output.length;
  const state = job.status === "running" ? `is running in the background as job ${job.id}` : `already ended (${job.status}, exit code ${job.exitCode ?? "none"})`;
  if (job.status !== "running") job.reported = true;
  const lines = first ? first.split("\n") : [];
  return {
    content: `The command ${state}.${first ? `\nOutput so far:\n${clip(first, 8000)}` : " No output yet."}${job.status === "running" ? `\nRead more with jobs {action: "output", id: "${job.id}"}; stop it with jobs {action: "stop", id: "${job.id}"}. You will be told when it exits.` : ""}`,
    isError: job.status === "failed",
    display: [c.dim(job.status === "running" ? `running in the background as ${job.id}` : `ended: ${job.status}`), ...lines.slice(-3).map((l) => c.dim(l))],
  };
}

/** One line per job for the model. */
export function describeJob(job: Job): string {
  const age = formatDuration(jobAge(job));
  const what = job.kind === "shell" ? `command \`${job.label}\`` : `sub-agent "${job.label}"`;
  const state = job.status === "running" ? `running for ${age}` : `${job.status} after ${age}${job.kind === "shell" && job.exitCode != null ? `, exit code ${job.exitCode}` : ""}`;
  return `${job.id}: ${what}, ${state}${job.kind === "agent" ? `, ${job.calls} tool calls` : ""}`;
}

// Commands that only read state. They run without a permission prompt when the
// command line contains no chaining, redirection or substitution.
const SAFE_COMMANDS = new Set([
  "ls", "dir", "pwd", "cat", "head", "tail", "wc", "which", "whoami", "echo", "file", "stat", "du", "df",
  "rg", "grep", "find", "diff", "printenv", "uname", "type", "nl", "cut",
]);
const SAFE_GIT = new Set(["status", "diff", "log", "show", "branch", "remote", "blame", "ls-files", "rev-parse", "describe", "tag", "shortlog", "stash list"]);

export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || /[;&|<>`\n]|\$\(/.test(cmd)) return false;
  const words = cmd.split(/\s+/);
  if (words[0] === "git") {
    if (!SAFE_GIT.has(words[1] ?? "")) return false;
    // `git branch -D x`, `git tag -d x`, `git remote add ...` change state.
    return !words.slice(2).some((w) => /^(-[dDmMfc]|--delete|--force|add|remove|rename|set-url|prune)$/.test(w));
  }
  if (words[0] === "find") return !words.some((w) => /^-(delete|exec|execdir|ok|fprint.*)$/.test(w));
  return SAFE_COMMANDS.has(words[0]);
}

/** The prefix used for "always allow" rules, e.g. "npm test" or "git commit". */
export function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/);
  const two = new Set(["git", "npm", "pnpm", "yarn", "npx", "cargo", "go", "docker", "kubectl", "pip", "uv", "dotnet", "make", "bun", "deno", "python", "python3", "node"]);
  return two.has(words[0]) && words[1] && !words[1].startsWith("-") ? `${words[0]} ${words[1]}` : words[0];
}

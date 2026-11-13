// Shell tool. Each command runs in a fresh shell process, but the working
// directory carries over between calls (a `cd` sticks), like a real session.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { c, stripAnsi } from "../ui/term.ts";
import { clip, type Tool } from "./types.ts";

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
      "Run a shell command and return its combined stdout/stderr and exit code. The working directory persists between calls; other shell state (variables, functions) does not. Commands run non-interactively with no stdin, so pass flags that avoid prompts (`-y`, `--no-edit`, ...) and never start an editor or pager. Use this for builds, tests, git, package managers and anything without a dedicated tool. Prefer the read/edit/glob/grep tools for file work: they are faster and their results are easier for the user to review. Default timeout is 120 s (max 600 s); for servers or watchers that never exit, start them in the background (`cmd > log 2>&1 &`) and inspect the log.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
        timeout: { type: "integer", description: "Timeout in seconds (default 120, max 600)." },
        description: { type: "string", description: "A few words on what this command does, shown to the user." },
      },
      required: ["command"],
    },
  },
  summarize: (i) => {
    const cmd = String(i.command ?? "").split("\n");
    return cmd[0] + (cmd.length > 1 ? c.dim(` … (+${cmd.length - 1} lines)`) : "");
  },
  async run(input, ctx) {
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

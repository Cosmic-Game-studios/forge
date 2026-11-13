// MCP (Model Context Protocol) client for stdio servers.
//
// Servers are configured like in other coding agents:
//   ~/.forge/mcp.json        - your own servers, trusted
//   <project>/.mcp.json      - servers a project asks for; started only after you approve them
// Format: { "mcpServers": { "name": { "command": "npx", "args": ["..."], "env": {} } } }
//
// Each server tool becomes a Forge tool named mcp__<server>__<tool>.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { forgeHome } from "./config.ts";
import type { ContentBlock } from "./providers/types.ts";
import type { Tool } from "./tools/types.ts";
import { c } from "./ui/term.ts";
import { VERSION } from "./version.ts";
import { clip } from "./tools/types.ts";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  source: "user" | "project";
}

export interface McpStatus {
  name: string;
  source: "user" | "project";
  state: "connected" | "failed" | "not approved";
  tools: number;
  detail?: string;
}

function readServers(file: string, source: McpServerConfig["source"]): McpServerConfig[] {
  let json: { mcpServers?: Record<string, { command?: unknown; args?: unknown; env?: unknown }> };
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const out: McpServerConfig[] = [];
  for (const [name, s] of Object.entries(json.mcpServers ?? {})) {
    if (!s || typeof s.command !== "string") continue; // only stdio servers are supported
    out.push({
      name: name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24),
      command: s.command,
      args: Array.isArray(s.args) ? s.args.map(String) : [],
      env: s.env && typeof s.env === "object" ? Object.fromEntries(Object.entries(s.env as object).map(([k, v]) => [k, String(v)])) : {},
      source,
    });
  }
  return out;
}

export function loadMcpConfig(cwd: string): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  for (const s of readServers(path.join(cwd, ".mcp.json"), "project")) byName.set(s.name, s);
  for (const s of readServers(path.join(forgeHome(), "mcp.json"), "user")) byName.set(s.name, s); // your own config wins
  return [...byName.values()];
}

/** Identity of a project server for the "approved" list: changing its command asks again. */
export function serverFingerprint(cwd: string, s: McpServerConfig): string {
  return `${path.resolve(cwd)}|${s.name}|${s.command} ${s.args.join(" ")}`;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  readonly config: McpServerConfig;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private stderr = "";
  private closed = false;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  async connect(cwd: string): Promise<void> {
    const { command, args, env } = this.config;
    const options = { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    if (process.platform === "win32") {
      // .cmd shims (npx, uvx) need a shell on Windows; quote arguments ourselves.
      const quote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
      this.child = spawn([command, ...args].map(quote).join(" "), { ...options, shell: true });
    } else {
      this.child = spawn(command, args, options);
    }
    const child = this.child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    child.stderr!.on("data", (d: Buffer) => (this.stderr = (this.stderr + d.toString("utf8")).slice(-1500)));
    const fail = (why: string) => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
      this.pending.clear();
    };
    child.on("error", (e) => fail(`could not start: ${e.message}`));
    child.on("close", (code) => fail(`server exited (code ${code})${this.stderr.trim() ? ": " + this.stderr.trim().split("\n").slice(-2).join(" ") : ""}`));

    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "forge", version: VERSION } }, 30_000);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout; ignore anything that is not JSON-RPC
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
        else p.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        // A request from the server (sampling, roots, ...): not supported.
        this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported by this client" } });
      }
    }
  }

  private send(msg: unknown) {
    if (this.closed || !this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params: unknown, timeoutMs = 120_000, signal?: AbortSignal): Promise<any> {
    if (this.closed) return Promise.reject(new Error("server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
          reject(new Error("interrupted"));
        },
        { once: true },
      );
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async listTools(): Promise<any[]> {
    const tools: any[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request("tools/list", cursor ? { cursor } : {}, 30_000);
      tools.push(...(res.tools ?? []));
      cursor = res.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  }

  close() {
    this.closed = true;
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }
}

function toForgeTool(client: McpClient, def: any): Tool {
  const server = client.config.name;
  const name = `mcp__${server}__${String(def.name).replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
  const schema = def.inputSchema && def.inputSchema.type === "object" ? def.inputSchema : { type: "object", properties: {} };
  return {
    // A server may declare a tool read-only; those run without a permission prompt.
    kind: def.annotations?.readOnlyHint === true ? "read" : "exec",
    external: true,
    spec: {
      name,
      description: `[MCP server "${server}"] ${String(def.description ?? def.name).slice(0, 1500)}`,
      input_schema: { ...schema, type: "object", properties: schema.properties ?? {} },
    },
    summarize: (input) => {
      const s = JSON.stringify(input);
      return s.length > 80 ? s.slice(0, 77) + "…" : s;
    },
    async run(input, ctx) {
      const res = await client.request("tools/call", { name: def.name, arguments: input }, 300_000, ctx.signal);
      const blocks: ContentBlock[] = [];
      let text = "";
      for (const item of res.content ?? []) {
        if (item.type === "text") text += (text ? "\n" : "") + item.text;
        else if (item.type === "image" && item.data && /^image\/(png|jpeg|gif|webp)$/.test(item.mimeType)) {
          blocks.push({ type: "image", source: { type: "base64", media_type: item.mimeType, data: item.data } });
        } else if (item.type === "resource" && item.resource?.text) text += (text ? "\n" : "") + item.resource.text;
      }
      if (!text && res.structuredContent) text = JSON.stringify(res.structuredContent);
      text = clip(text || (blocks.length ? "" : "(no output)"), 30_000);
      const lines = text.split("\n");
      return {
        content: blocks.length ? [...(text ? [{ type: "text" as const, text }] : []), ...blocks] : text,
        isError: res.isError === true,
        display: [c.dim(lines.length > 1 ? `${lines.length} lines` : lines[0].slice(0, 100))],
      };
    },
  };
}

export class McpManager {
  clients: McpClient[] = [];
  status: McpStatus[] = [];

  /** Start the configured servers and return their tools. A server that fails is reported, not fatal. */
  async start(cwd: string, servers: McpServerConfig[], approved: (s: McpServerConfig) => Promise<boolean>): Promise<Tool[]> {
    const tools: Tool[] = [];
    await Promise.all(
      servers.map(async (s) => {
        if (s.source === "project" && !(await approved(s))) {
          this.status.push({ name: s.name, source: s.source, state: "not approved", tools: 0 });
          return;
        }
        const client = new McpClient(s);
        try {
          await client.connect(cwd);
          const defs = await client.listTools();
          this.clients.push(client);
          for (const d of defs.slice(0, 60)) tools.push(toForgeTool(client, d));
          this.status.push({ name: s.name, source: s.source, state: "connected", tools: Math.min(60, defs.length) });
        } catch (err) {
          client.close();
          this.status.push({ name: s.name, source: s.source, state: "failed", tools: 0, detail: (err as Error).message });
        }
      }),
    );
    // Stable order keeps the request prefix (and the prompt cache) identical across sessions.
    this.status.sort((a, b) => a.name.localeCompare(b.name));
    return tools.sort((a, b) => a.spec.name.localeCompare(b.spec.name));
  }

  close() {
    for (const cl of this.clients) cl.close();
    this.clients = [];
  }
}

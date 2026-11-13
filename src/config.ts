// User configuration and API key storage (~/.forge/config.json).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ProviderId = "anthropic" | "openrouter" | "openai";
export const PROVIDERS: ProviderId[] = ["anthropic", "openrouter", "openai"];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export type PermissionMode = "ask" | "auto-edit" | "yolo";
export const PERMISSION_MODES: PermissionMode[] = ["ask", "auto-edit", "yolo"];

export interface Config {
  keys: Partial<Record<ProviderId, string>>;
  /** "provider:model-id" */
  model?: string;
  effort: Effort;
  permissionMode: PermissionMode;
  /** Model for sub-agents: "provider:id", "same", or unset for the automatic cheap default. */
  subagentModel?: string;
  /** Spending limit per session in USD; the agent stops when it is reached. */
  budget?: number;
  /** Prepare each request: project snapshot, located mentions, task triage. Default on. */
  prepare?: boolean;
  /** Let a small model read larger bursts of edits while the work goes on. Default on. */
  watch?: boolean;
  /** Have an independent reviewer read larger changes before a turn ends. Default on. */
  review?: boolean;
  /** Run the project's checks automatically when a turn that changed files ends. Default on. */
  autoCheck?: boolean;
  /** Compress the conversation once it exceeds this many tokens. Default 120000. */
  compactAt?: number;
  /** Project MCP servers the user approved (see mcp.ts serverFingerprint). */
  trustedMcp?: string[];
  /** Allow Anthropic's server-side web search / fetch tools. */
  webTools: boolean;
  showThinking: boolean;
}

const ENV_KEYS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function forgeHome(): string {
  return process.env.FORGE_HOME || path.join(os.homedir(), ".forge");
}

function configPath(): string {
  return path.join(forgeHome(), "config.json");
}

const DEFAULTS: Config = {
  keys: {},
  effort: "high",
  permissionMode: "ask",
  webTools: true,
  showThinking: true,
};

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return { ...DEFAULTS, ...raw, keys: { ...(raw.keys ?? {}) } };
  } catch {
    return { ...DEFAULTS, keys: {} };
  }
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(forgeHome(), { recursive: true });
  const file = configPath();
  // 0600: readable by the owner only (enforced on POSIX; on Windows the file
  // lives in the user profile, which is already private to the account).
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not supported on this filesystem */
  }
}

/** Environment variables win over the stored key. */
export function getKey(cfg: Config, provider: ProviderId): string | undefined {
  return process.env[ENV_KEYS[provider]]?.trim() || cfg.keys[provider]?.trim() || undefined;
}

export function keySource(cfg: Config, provider: ProviderId): "env" | "config" | null {
  if (process.env[ENV_KEYS[provider]]?.trim()) return "env";
  if (cfg.keys[provider]?.trim()) return "config";
  return null;
}

export function envVarName(provider: ProviderId): string {
  return ENV_KEYS[provider];
}

export function maskKey(key: string): string {
  if (key.length <= 12) return "•".repeat(key.length);
  return key.slice(0, 7) + "…" + key.slice(-4);
}

// Provider-neutral contract.
//
// The conversation history is stored in one canonical shape: Anthropic's
// Messages format (content blocks). The Anthropic provider sends it as-is,
// which keeps thinking blocks, compaction blocks and the prompt cache intact.
// OpenAI-compatible providers translate to and from it at the wire boundary.

import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.ts";

export type ContentBlock = Anthropic.Beta.BetaContentBlockParam;
/** A user or assistant turn. Structurally a subset of the SDK's message param. */
export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}
export type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;

/** Private block that carries OpenRouter reasoning details between turns. */
export interface ForeignReasoningBlock {
  type: "x_reasoning";
  provider: string;
  details: unknown[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the model's JSON could not be parsed. */
  invalidJson?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "pause_turn" | "refusal" | "other";

export interface TurnResult {
  /** Assistant content to append to history verbatim. */
  content: ContentBlock[];
  toolCalls: ToolCall[];
  stop: StopReason;
  stopDetail?: string;
  usage: Usage;
  /** Model that actually served the turn (differs after a fallback). */
  servedBy?: string;
}

export interface StreamHandlers {
  onText(delta: string): void;
  onThinking(delta: string): void;
  /** A tool call started streaming (input not complete yet). */
  onToolPending(name: string): void;
  /** Bytes of tool input received so far, for progress display. */
  onToolProgress(chars: number): void;
  /** A server-side tool (web search / fetch) ran. */
  onServerTool(name: string, detail: string): void;
  onNotice(msg: string): void;
  /** The server replaced earlier history with a summary. */
  onCompaction(): void;
}

export interface TurnRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  effort: Effort;
  maxTokens: number;
  webTools: boolean;
  signal: AbortSignal;
}

export interface Provider {
  readonly id: string;
  runTurn(req: TurnRequest, handlers: StreamHandlers): Promise<TurnResult>;
  listModels(): Promise<{ id: string; name: string }[]>;
}

export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

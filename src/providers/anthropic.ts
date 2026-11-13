// Anthropic provider: the first-class path.
//
// What it does to get the most out of Claude models:
//  - Streams every turn (long outputs never hit HTTP timeouts).
//  - Adaptive thinking with an explicit effort level; summarized thinking is
//    shown so long turns are not silent.
//  - Prompt caching: one breakpoint on the frozen system prompt (covers tools
//    + system) and automatic caching on the conversation tail.
//  - The history is sent back verbatim and append-only, so thinking blocks stay
//    valid and the cache keeps hitting.
//  - Server-side compaction keeps very long sessions inside the context window
//    without a client-side history rewrite.
//  - Server-side refusal fallback, where the model supports it.
//  - Eager tool-input streaming, with validation left to the agent loop.

import Anthropic from "@anthropic-ai/sdk";
import { modelInfo } from "../models.ts";
import {
  ProviderError,
  type ContentBlock,
  type Message,
  type Provider,
  type StopReason,
  type StreamHandlers,
  type ToolCall,
  type TurnRequest,
  type TurnResult,
} from "./types.ts";

const BETA_COMPACT = "compact-2026-01-12";
const BETA_FALLBACK = "server-side-fallback-2026-07-01";

type Feature = "compaction" | "fallbacks" | "webTools";

/** Remove blocks that only other providers understand. */
function toWire(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const content = m.content.filter((b) => (b as { type: string }).type !== "x_reasoning");
    if (content.length === 0) continue;
    out.push(content.length === m.content.length ? m : { ...m, content });
  }
  return out;
}

function stripThinkingInPlace(messages: Message[]): void {
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    m.content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    if (m.content.length === 0) m.content = [{ type: "text", text: "(no visible output)" }];
  }
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private client: Anthropic;
  /** Optional features switched off after the API rejected them. */
  private disabled = new Set<Feature>();

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, baseURL, maxRetries: 4 });
  }

  async listModels(): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = [];
    try {
      for await (const m of this.client.models.list()) {
        out.push({ id: m.id, name: m.display_name });
      }
    } catch (err) {
      throw this.mapError(err);
    }
    return out;
  }

  private buildParams(req: TurnRequest): { params: Record<string, unknown>; active: Feature[] } {
    const info = modelInfo({ provider: "anthropic", id: req.model });
    const active: Feature[] = [];
    const betas: string[] = [];

    // Tools are sorted by name so the serialized prefix is deterministic.
    const tools: Record<string, unknown>[] = [...req.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ ...t, eager_input_streaming: true }));

    if (req.webTools && info.webTools && !this.disabled.has("webTools")) {
      active.push("webTools");
      tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 8 });
      tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 });
    }

    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: toWire(req.messages),
      tools,
      cache_control: { type: "ephemeral" },
    };

    if (info.adaptive) {
      params.thinking = { type: "adaptive", display: "summarized" };
      params.output_config = { effort: req.effort };
    }
    if (process.env.FORGE_SERVER_COMPACTION === "1" && info.compaction && !this.disabled.has("compaction")) {
      active.push("compaction");
      betas.push(BETA_COMPACT);
      params.context_management = { edits: [{ type: "compact_20260112" }] };
    }
    if (info.fallbacks && !this.disabled.has("fallbacks")) {
      active.push("fallbacks");
      betas.push(BETA_FALLBACK);
      params.fallbacks = "default";
    }
    if (betas.length) params.betas = betas;
    return { params, active };
  }

  async runTurn(req: TurnRequest, h: StreamHandlers): Promise<TurnResult> {
    let strippedThinking = false;
    for (;;) {
      const { params, active } = this.buildParams(req);
      try {
        return await this.streamOnce(params, req.signal, h);
      } catch (err) {
        if (req.signal.aborted) throw err;
        if (err instanceof Anthropic.BadRequestError) {
          const msg = err.message;
          // History no longer matches the thinking blocks (e.g. a resumed
          // session under a different tool set): drop thinking once and retry.
          if (!strippedThinking && /thinking/i.test(msg) && /signature|bound to a different/i.test(msg)) {
            strippedThinking = true;
            stripThinkingInPlace(req.messages);
            h.onNotice("Earlier thinking blocks were no longer valid; continuing without them.");
            continue;
          }
          // An optional feature may be unavailable for this account or platform.
          if (active.length > 0) {
            for (const f of active) this.disabled.add(f);
            h.onNotice(`The API rejected an optional feature (${active.join(", ")}); retrying without it. Reason: ${msg}`);
            continue;
          }
          throw this.mapError(err);
        }
        if (err instanceof Anthropic.APIError) throw this.mapError(err);
        // Not an API error: the stream itself broke (connection dropped, malformed event).
        throw new ProviderError(`The response stream broke off (${(err as Error).message})`, { retryable: true });
      }
    }
  }

  private async streamOnce(params: Record<string, unknown>, signal: AbortSignal, h: StreamHandlers): Promise<TurnResult> {
    const stream = (await this.client.beta.messages.create(
      { ...params, stream: true } as unknown as Anthropic.Beta.MessageCreateParamsStreaming,
      { signal },
    )) as AsyncIterable<any>;

    // The message is assembled here from the raw events. Tool inputs stream
    // eagerly and may turn out not to be valid JSON; that must cost one tool
    // call, not the whole turn, so their text is only parsed once complete.
    const blocks: any[] = [];
    const invalid = new Map<string, string>();
    const usage: Record<string, number> = {};
    let stopReason: string | null = null;
    let stopDetails: unknown;
    let servedBy: string | undefined;

    // index -> state for blocks whose input streams as JSON fragments
    const jsonBlocks = new Map<number, { kind: "client" | "server"; name: string; json: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          Object.assign(usage, event.message?.usage);
          servedBy = event.message?.model;
          break;
        case "message_delta":
          for (const [k, v] of Object.entries(event.usage ?? {})) if (typeof v === "number") usage[k] = v;
          stopReason = event.delta?.stop_reason ?? stopReason;
          stopDetails = event.delta?.stop_details ?? stopDetails;
          break;
        case "content_block_start": {
          const b = event.content_block as { type: string; name?: string };
          blocks[event.index] = structuredClone(event.content_block);
          if (b.type === "tool_use") {
            jsonBlocks.set(event.index, { kind: "client", name: b.name ?? "tool", json: "" });
            h.onToolPending(b.name ?? "tool");
          } else if (b.type === "server_tool_use") {
            jsonBlocks.set(event.index, { kind: "server", name: b.name ?? "server_tool", json: "" });
          } else if (b.type === "compaction") {
            h.onNotice("Context was compacted server-side to make room.");
            h.onCompaction();
          }
          break;
        }
        case "content_block_delta": {
          const d = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string; signature?: string; citation?: unknown; content?: string };
          const block = blocks[event.index];
          if (block) {
            if (d.type === "text_delta") block.text = (block.text ?? "") + (d.text ?? "");
            else if (d.type === "thinking_delta") block.thinking = (block.thinking ?? "") + (d.thinking ?? "");
            else if (d.type === "signature_delta") block.signature = d.signature;
            else if (d.type === "citations_delta") (block.citations ??= []).push(d.citation);
            else if (d.type === "compaction_delta") block.content = (block.content ?? "") + (d.content ?? "");
          }
          if (d.type === "text_delta" && d.text) h.onText(d.text);
          else if (d.type === "thinking_delta" && d.thinking) h.onThinking(d.thinking);
          else if (d.type === "input_json_delta" && d.partial_json) {
            const st = jsonBlocks.get(event.index);
            if (st) {
              st.json += d.partial_json;
              if (st.kind === "client") h.onToolProgress(st.json.length);
            }
          }
          break;
        }
        case "content_block_stop": {
          const st = jsonBlocks.get(event.index);
          if (st) {
            const block = blocks[event.index];
            try {
              const parsed = JSON.parse(st.json || "{}");
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
              block.input = parsed;
            } catch {
              // Keep the block (the API needs it in the history) with an empty input;
              // the agent answers this call with an INVALID_JSON error result.
              block.input = {};
              if (st.kind === "client") invalid.set(block.id, st.json);
            }
          }
          if (st?.kind === "server") {
            let detail = "";
            try {
              const input = JSON.parse(st.json || "{}") as Record<string, unknown>;
              detail = String(input.query ?? input.url ?? "");
            } catch {
              /* detail stays empty */
            }
            h.onServerTool(st.name, detail);
          }
          break;
        }
      }
    }

    const final = { content: blocks.filter(Boolean), stop_reason: stopReason, stop_details: stopDetails, usage: usage as Record<string, number | undefined> };
    const toolCalls: ToolCall[] = [];
    for (const block of final.content) {
      if (block.type === "tool_use") {
        const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
        const raw = invalid.get(block.id);
        toolCalls.push({ id: block.id, name: block.name, input, ...(raw !== undefined ? { invalidJson: raw } : {}) });
      } else if ((block as { type: string }).type === "fallback") {
        const fb = block as unknown as { from?: { model?: string }; to?: { model?: string } };
        h.onNotice(`${fb.from?.model ?? "The model"} declined this request; ${fb.to?.model ?? "a fallback model"} continued.`);
      }
    }

    let stop: StopReason;
    let stopDetail: string | undefined;
    switch (final.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        stop = "end_turn";
        break;
      case "tool_use":
        stop = "tool_use";
        break;
      case "max_tokens":
        stop = "max_tokens";
        break;
      case "pause_turn":
        stop = "pause_turn";
        break;
      case "refusal": {
        stop = "refusal";
        const d = (final as unknown as { stop_details?: { category?: string | null; explanation?: string } }).stop_details;
        stopDetail = [d?.category, d?.explanation].filter(Boolean).join(": ") || undefined;
        break;
      }
      default:
        stop = "other";
        stopDetail = String(final.stop_reason);
    }

    const u = final.usage;
    return {
      content: final.content as unknown as ContentBlock[],
      toolCalls,
      stop,
      stopDetail,
      usage: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      servedBy: servedBy ?? String(params.model),
    };
  }

  private mapError(err: unknown): ProviderError {
    if (err instanceof Anthropic.AuthenticationError)
      return new ProviderError("Anthropic rejected the API key (401). Set a valid key with /keys.", { status: 401 });
    if (err instanceof Anthropic.PermissionDeniedError)
      return new ProviderError(`Anthropic denied access (403): ${err.message}`, { status: 403 });
    if (err instanceof Anthropic.NotFoundError)
      return new ProviderError(`Model or endpoint not found (404): ${err.message}. Pick another model with /model.`, { status: 404 });
    if (err instanceof Anthropic.RateLimitError)
      return new ProviderError(`Rate limited by Anthropic (429) after retries: ${err.message}`, { status: 429, retryable: true });
    if (err instanceof Anthropic.BadRequestError)
      return new ProviderError(`Anthropic rejected the request (400): ${err.message}`, { status: 400 });
    if (err instanceof Anthropic.APIConnectionError)
      return new ProviderError(`Could not reach Anthropic: ${err.message}`, { retryable: true });
    if (err instanceof Anthropic.APIError)
      return new ProviderError(`Anthropic API error ${err.status ?? ""}: ${err.message}`, {
        status: err.status,
        retryable: (err.status ?? 0) >= 500,
      });
    return new ProviderError((err as Error)?.message ?? String(err));
  }
}

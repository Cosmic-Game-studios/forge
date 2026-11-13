// OpenAI-compatible provider (Chat Completions wire format).
// Used for OpenRouter (which serves Claude models) and for OpenAI itself.
// Translates the canonical Anthropic-shaped history at the wire boundary.

import {
  ProviderError,
  type ContentBlock,
  type ForeignReasoningBlock,
  type Message,
  type Provider,
  type StopReason,
  type StreamHandlers,
  type ToolCall,
  type TurnRequest,
  type TurnResult,
} from "./types.ts";

type Flavor = "openrouter" | "openai";

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning_details?: unknown[];
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : b.type === "image" ? "[image omitted]" : ""))
    .join("\n");
}

export function toWireMessages(system: string, messages: Message[], flavor: Flavor, cacheSystem: boolean): WireMessage[] {
  const out: WireMessage[] = [
    {
      role: "system",
      content: cacheSystem ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system,
    },
  ];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      let text = "";
      const toolCalls: unknown[] = [];
      let reasoning: unknown[] | undefined;
      for (const b of m.content as (ContentBlock | ForeignReasoningBlock)[]) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use")
          toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        else if (b.type === "x_reasoning" && b.provider === flavor) reasoning = b.details;
        // thinking / server-tool blocks belong to the Anthropic API and are not portable.
      }
      if (!text && toolCalls.length === 0) continue;
      const msg: WireMessage = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (reasoning?.length) msg.reasoning_details = reasoning;
      out.push(msg);
      continue;
    }
    // user turn: tool results first (they must directly follow the assistant turn), then other content
    const parts: unknown[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const body = blockText(b.content);
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "ERROR: " : "") + (body || "(no output)") });
      } else if (b.type === "text") {
        parts.push({ type: "text", text: b.text });
      } else if (b.type === "image" && b.source.type === "base64") {
        parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
    }
    if (parts.length) out.push({ role: "user", content: parts });
  }
  return out;
}

/** Merge streamed reasoning_details fragments (keyed by index) into whole entries. */
function mergeReasoning(acc: Record<string, unknown>[], chunk: Record<string, unknown>[]) {
  for (const part of chunk) {
    const idx = typeof part.index === "number" ? part.index : acc.length;
    const cur = (acc[idx] ??= {});
    for (const [k, v] of Object.entries(part)) {
      if (typeof v === "string" && (k === "text" || k === "summary" || k === "data") && typeof cur[k] === "string") {
        cur[k] = (cur[k] as string) + v;
      } else if (v !== null && v !== undefined) {
        cur[k] = v;
      }
    }
  }
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const rest = buf.trim();
  if (rest.startsWith("data:")) yield rest.slice(5).trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAICompatProvider implements Provider {
  readonly id: Flavor;
  private apiKey: string;
  private baseURL: string;

  constructor(flavor: Flavor, apiKey: string, baseURL?: string) {
    this.id = flavor;
    this.apiKey = apiKey;
    this.baseURL = (baseURL ?? (flavor === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")).replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
    if (this.id === "openrouter") h["x-title"] = "Forge";
    return h;
  }

  async listModels(): Promise<{ id: string; name: string }[]> {
    const res = await fetch(`${this.baseURL}/models`, { headers: this.headers() });
    if (!res.ok) throw new ProviderError(`${this.id}: could not list models (${res.status})`, { status: res.status });
    const json = (await res.json()) as { data?: { id: string; name?: string }[] };
    return (json.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));
  }

  async runTurn(req: TurnRequest, h: StreamHandlers): Promise<TurnResult> {
    const claude = /claude/i.test(req.model);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toWireMessages(req.system, req.messages, this.id, this.id === "openrouter" && claude),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) {
      body.tools = [...req.tools]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    }
    if (this.id === "openrouter") {
      body.max_tokens = req.maxTokens;
      body.usage = { include: true };
      const effort = req.effort === "xhigh" || req.effort === "max" ? "high" : req.effort;
      if (claude) body.reasoning = { effort };
    } else {
      body.max_completion_tokens = req.maxTokens;
    }

    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        if (req.signal.aborted) throw err;
        if (attempt < 3) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ProviderError(`Could not reach ${this.id}: ${(err as Error).message}`, { retryable: true });
      }
      if (res.ok && res.body) break;
      const text = await res.text().catch(() => "");
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      let detail = text.slice(0, 600);
      try {
        detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
      } catch {
        /* keep raw text */
      }
      if (res.status === 401) throw new ProviderError(`${this.id} rejected the API key (401). Set a valid key with /keys.`, { status: 401 });
      throw new ProviderError(`${this.id} error ${res.status}: ${detail}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
    }

    let text = "";
    const calls: { id: string; name: string; args: string }[] = [];
    const reasoning: Record<string, unknown>[] = [];
    let finish = "";
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let servedBy: string | undefined;

    for await (const data of sseEvents(res.body!)) {
      if (data === "[DONE]") break;
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // keep-alive comments and partial noise
      }
      if (chunk.error) throw new ProviderError(`${this.id} stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      if (chunk.model) servedBy = chunk.model;
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage.input = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached);
        usage.cacheRead = cached;
        usage.output = chunk.usage.completion_tokens ?? 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (typeof d.content === "string" && d.content) {
        text += d.content;
        h.onText(d.content);
      }
      if (typeof d.reasoning === "string" && d.reasoning) h.onThinking(d.reasoning);
      if (Array.isArray(d.reasoning_details)) mergeReasoning(reasoning, d.reasoning_details);
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = typeof tc.index === "number" ? tc.index : calls.length;
          const cur = (calls[i] ??= { id: "", name: "", args: "" });
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) {
            cur.name = tc.function.name;
            h.onToolPending(cur.name);
          }
          if (tc.function?.arguments) {
            cur.args += tc.function.arguments;
            h.onToolProgress(cur.args.length);
          }
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const content: (ContentBlock | ForeignReasoningBlock)[] = [];
    if (reasoning.length) content.push({ type: "x_reasoning", provider: this.id, details: reasoning.filter(Boolean) });
    if (text) content.push({ type: "text", text });
    const toolCalls: ToolCall[] = [];
    calls.filter(Boolean).forEach((cl, i) => {
      const id = cl.id || `call_${Date.now().toString(36)}_${i}`;
      let input: Record<string, unknown> = {};
      let invalidJson: string | undefined;
      try {
        const parsed = JSON.parse(cl.args || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
        else invalidJson = cl.args;
      } catch {
        invalidJson = cl.args;
      }
      content.push({ type: "tool_use", id, name: cl.name, input });
      toolCalls.push({ id, name: cl.name, input, invalidJson });
    });

    let stop: StopReason = "end_turn";
    if (toolCalls.length) stop = finish === "length" ? "max_tokens" : "tool_use";
    else if (finish === "length") stop = "max_tokens";
    else if (finish === "content_filter") stop = "refusal";

    return { content: content as ContentBlock[], toolCalls, stop, usage, servedBy };
  }
}

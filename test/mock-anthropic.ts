// A scripted stand-in for the Anthropic Messages API (streaming only).
// Each POST /v1/messages consumes the next scripted turn and replays it as SSE.

import http from "node:http";
import type { AddressInfo } from "node:net";

export type ScriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; rawJson?: string };

/** Optional pause (ms) after a block has streamed, to look at the screen mid-response. */
export type HeldBlock = ScriptBlock & { hold?: number };

export interface ScriptTurn {
  content: HeldBlock[];
  stop_reason: string;
  /** Only answer a request this accepts. Requests that race (the watcher) need it; give it to every turn of such a script. */
  when?: (body: any) => boolean;
  /** Respond with an HTTP error instead of a stream. */
  error?: { status: number; message: string };
}

export interface MockServer {
  url: string;
  requests: { headers: http.IncomingHttpHeaders; body: any }[];
  close(): Promise<void>;
}

function sse(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chunks(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [""];
}

export async function startMock(script: ScriptTurn[]): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  let turn = 0;
  const used = new Set<number>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ headers: req.headers, body });
      const index = script.findIndex((s, i) => !used.has(i) && (!s.when || s.when(body)));
      used.add(index);
      turn++;
      const t = script[index];
      if (!t) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "script exhausted" } }));
        return;
      }
      if (t.error) {
        res.writeHead(t.error.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: t.error.message } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, "message_start", {
        type: "message_start",
        message: {
          id: `msg_${turn}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: turn > 1 ? 900 : 0, cache_creation_input_tokens: turn > 1 ? 50 : 950 },
        },
      });
      for (const [index, b] of t.content.entries()) {
        if (b.type === "text") {
          sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
          for (const part of chunks(b.text, 7)) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
        } else if (b.type === "thinking") {
          sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
          for (const part of chunks(b.thinking, 9)) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part } });
          sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: `sig_${turn}_${index}` } });
        } else {
          sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
          for (const part of chunks(b.rawJson ?? JSON.stringify(b.input), 11))
            sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } });
        }
        if (b.hold) await new Promise((r) => setTimeout(r, b.hold));
        sse(res, "content_block_stop", { type: "content_block_stop", index });
      }
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: t.stop_reason, stop_sequence: null }, usage: { output_tokens: 42 } });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

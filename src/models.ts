// Model catalog and capability table.

import type { ProviderId } from "./config.ts";

export interface ModelInfo {
  id: string;
  name: string;
  note?: string;
  /** Context window in tokens. */
  context: number;
  /** $ per million tokens: input, output, cache read. */
  price?: { in: number; out: number; cacheRead: number };
  /** Adaptive thinking + effort parameter supported. */
  adaptive: boolean;
  /** Server-side refusal fallback ("fallbacks: default") supported. */
  fallbacks: boolean;
  /** Server-side compaction supported. */
  compaction: boolean;
  /** Newer web search / fetch tool versions supported. */
  webTools: boolean;
}

// Anthropic first-party catalog. IDs are complete as written (no date suffix).
export const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    note: "default - strong all-round coding model",
    context: 1_000_000,
    price: { in: 4, out: 20, cacheRead: 0.2 },
    adaptive: true,
    fallbacks: true,
    compaction: true,
    webTools: true,
  },
  {
    id: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    note: "most capable, long-horizon work, highest price",
    context: 1_000_000,
    price: { in: 8, out: 40, cacheRead: 0.2 },
    adaptive: true,
    fallbacks: true,
    compaction: true,
    webTools: true,
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    note: "fast and cheap for everyday work",
    context: 1_000_000,
    price: { in: 2, out: 10, cacheRead: 0.1 },
    adaptive: true,
    fallbacks: true,
    compaction: true,
    webTools: true,
  },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    note: "fastest, good for sub-agents",
    context: 1_000_000,
    price: { in: 0.1, out: 0.5, cacheRead: 0.01 },
    adaptive: true,
    fallbacks: false,
    compaction: true,
    webTools: false,
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    context: 1_000_000,
    price: { in: 5, out: 25, cacheRead: 0.5 },
    adaptive: true,
    fallbacks: true,
    compaction: true,
    webTools: true,
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    context: 1_000_000,
    price: { in: 5, out: 25, cacheRead: 0.5 },
    adaptive: true,
    fallbacks: false,
    compaction: true,
    webTools: true,
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    context: 1_000_000,
    price: { in: 2, out: 10, cacheRead: 0.2 },
    adaptive: true,
    fallbacks: false,
    compaction: true,
    webTools: true,
  },
];

export const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: "claude-opus-5-5",
  // OpenRouter slugs are resolved from its live model list (see providers/openai-compat.ts).
  openrouter: "anthropic/claude-opus-5.5",
  openai: "",
};

export interface ModelRef {
  provider: ProviderId;
  id: string;
}

export function parseModelRef(spec: string): ModelRef | null {
  const i = spec.indexOf(":");
  if (i <= 0) return null;
  const provider = spec.slice(0, i) as ProviderId;
  if (provider !== "anthropic" && provider !== "openrouter" && provider !== "openai") return null;
  const id = spec.slice(i + 1).trim();
  return id ? { provider, id } : null;
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.id}`;
}

/** Capability lookup. Unknown Claude ids get conservative-but-modern defaults. */
export function modelInfo(ref: ModelRef): ModelInfo {
  if (ref.provider === "anthropic") {
    const known = ANTHROPIC_MODELS.find((m) => m.id === ref.id);
    if (known) return known;
    return {
      id: ref.id,
      name: ref.id,
      context: 200_000,
      adaptive: !/claude-(3|haiku-4|sonnet-4-5|opus-4-[015])/.test(ref.id),
      fallbacks: false,
      compaction: false,
      webTools: false,
    };
  }
  // Via OpenRouter, match a Claude slug back to the first-party entry for pricing/context.
  const slug = ref.id.replace(/^anthropic\//, "").replace(/\./g, "-");
  const known = ANTHROPIC_MODELS.find((m) => m.id === slug);
  return {
    id: ref.id,
    name: known?.name ?? ref.id,
    context: known?.context ?? 200_000,
    price: known?.price,
    adaptive: !!known,
    fallbacks: false,
    compaction: false,
    webTools: false,
  };
}

export function isClaude(ref: ModelRef): boolean {
  return ref.provider === "anthropic" || /claude/i.test(ref.id);
}

import { envVarName, getKey, type Config, type ProviderId } from "../config.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAICompatProvider } from "./openai-compat.ts";
import { ProviderError, type Provider } from "./types.ts";

const cache = new Map<string, Provider>();

/** Build (and reuse) the provider client for a provider id. Throws if no key is configured. */
export function getProvider(cfg: Config, id: ProviderId): Provider {
  const key = getKey(cfg, id);
  if (!key) {
    throw new ProviderError(`No API key for ${id}. Add one with /keys, or set ${envVarName(id)}.`);
  }
  const cacheKey = `${id}:${key}`;
  let p = cache.get(cacheKey);
  if (!p) {
    if (id === "anthropic") p = new AnthropicProvider(key, process.env.FORGE_ANTHROPIC_BASE_URL || undefined);
    else if (id === "openrouter") p = new OpenAICompatProvider("openrouter", key, process.env.FORGE_OPENROUTER_BASE_URL || undefined);
    else p = new OpenAICompatProvider("openai", key, process.env.FORGE_OPENAI_BASE_URL || undefined);
    cache.set(cacheKey, p);
  }
  return p;
}

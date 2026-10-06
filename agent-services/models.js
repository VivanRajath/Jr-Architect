// pi-ai builds its model registry from MODELS when it first loads, so models newer than this pi-ai release are added here before it does.
import { MODELS } from "@mariozechner/pi-ai/dist/models.generated.js";

function add(provider, base, id, name, extra) {
  const from = MODELS[provider] && MODELS[provider][base];
  if (from && !MODELS[provider][id]) MODELS[provider][id] = { ...from, id, name, ...extra };
}

add("anthropic", "claude-opus-4-6", "claude-opus-5-5", "Claude Opus 5.5",
  { contextWindow: 1000000, maxTokens: 128000, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } });
add("anthropic", "claude-sonnet-4-6", "claude-sonnet-5-5", "Claude Sonnet 5.5",
  { contextWindow: 1000000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } });

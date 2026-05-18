import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { ZENMUX_DEFAULT_MAX_TOKENS } from "./constants.js";

const ZENMUX_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const STATIC_ZENMUX_MODELS: ModelDefinitionConfig[] = [
  {
    id: "openai/gpt-5.5",
    name: "OpenAI: GPT-5.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZENMUX_DEFAULT_COST },
    contextWindow: 1_050_000,
    maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
  },
  {
    id: "openai/gpt-5.5-pro",
    name: "OpenAI: GPT-5.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZENMUX_DEFAULT_COST },
    contextWindow: 1_050_000,
    maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
  },
  {
    id: "openai/chat-latest",
    name: "OpenAI: Chat Latest (GPT-5.5 Instant)",
    reasoning: false,
    input: ["text", "image"],
    cost: { ...ZENMUX_DEFAULT_COST },
    contextWindow: 400_000,
    maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
  },
  {
    id: "openai/gpt-5.4",
    name: "OpenAI: GPT-5.4",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZENMUX_DEFAULT_COST },
    contextWindow: 1_050_000,
    maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
  },
  {
    id: "anthropic/claude-opus-4.7",
    name: "Anthropic: Claude Opus 4.7",
    reasoning: false,
    input: ["text", "image"],
    cost: { ...ZENMUX_DEFAULT_COST },
    contextWindow: 1_000_000,
    maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Anthropic: Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZENMUX_DEFAULT_COST },
    contextWindow: 1_000_000,
    maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
  },
  {
    id: "google/gemini-3.1-flash-lite-preview",
    name: "Google: Gemini 3.1 Flash Lite Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZENMUX_DEFAULT_COST },
    contextWindow: 1_048_576,
    maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
  },
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Google: Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: { ...ZENMUX_DEFAULT_COST },
    contextWindow: 1_048_576,
    maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
  },
];

export function isZenmuxAnthropicModelId(modelId: string): boolean {
  return modelId.startsWith("anthropic/claude-");
}

export function isZenmuxGeminiModelId(modelId: string): boolean {
  return (
    modelId.startsWith("google/gemini-") ||
    modelId.startsWith("google/gemma-") ||
    modelId.startsWith("google/veo-") ||
    modelId.startsWith("google/lyria-") ||
    modelId.startsWith("google/imagen-")
  );
}

const GOOGLE_PROVIDER_PREFIX = "google/";

export function normalizeZenmuxGoogleModelId(modelId: string): string {
  if (modelId.startsWith(GOOGLE_PROVIDER_PREFIX)) {
    const bareModelId = modelId.slice(GOOGLE_PROVIDER_PREFIX.length);
    const normalizedBareModelId = normalizeZenmuxGoogleModelId(bareModelId);
    return normalizedBareModelId === bareModelId
      ? modelId
      : `${GOOGLE_PROVIDER_PREFIX}${normalizedBareModelId}`;
  }
  if (modelId === "gemini-3-pro" || modelId === "gemini-3-pro-preview") {
    return "gemini-3.1-pro-preview";
  }
  if (modelId === "gemini-3-flash") {
    return "gemini-3-flash-preview";
  }
  if (modelId === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (modelId === "gemini-3.1-flash-lite") {
    return "gemini-3.1-flash-lite-preview";
  }
  if (modelId === "gemini-3.1-flash" || modelId === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  return modelId;
}

function cloneModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
  };
}

// Small static fallback returned before live ZenMux discovery is available.
// The authoritative catalog is fetched at runtime from /api/v1/models.
export function staticZenmuxModelDefinitions(
  filter?: (model: ModelDefinitionConfig) => boolean,
): ModelDefinitionConfig[] {
  const models = filter ? STATIC_ZENMUX_MODELS.filter(filter) : STATIC_ZENMUX_MODELS;
  return models.map(cloneModelDefinition);
}

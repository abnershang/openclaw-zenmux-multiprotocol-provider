import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { applyZenmuxConfig } from "./onboard.js";
import { buildZenmuxOpenaiProvider } from "./provider-catalog-openai.js";
import { buildZenmuxAnthropicProvider } from "./provider-catalog-anthropic.js";
import { buildZenmuxVertexProvider } from "./provider-catalog-vertex.js";
import { buildZenmuxGeminiProvider } from "./provider-catalog-gemini.js";
import { buildZenmuxImageGenerationProvider } from "./image-generation-provider.js";
import { createZenmuxGeminiTransportStreamFn, ZENMUX_GEMINI_BASE_URL } from "./transport-zenmux-gemini.js";
import { isZenmuxAnthropicModelId, isZenmuxGeminiModelId } from "./zenmux-models.js";
import {
  getZenmuxModelCapabilities,
  loadZenmuxModelDefinitions,
  loadZenmuxModelCapabilities,
} from "./zenmux-capabilities-cache.js";
import {
  ZENMUX_OPENAI_BASE_URL,
  ZENMUX_ANTHROPIC_BASE_URL,
  ZENMUX_VERTEX_BASE_URL,
  ZENMUX_DEFAULT_CONTEXT_WINDOW,
  ZENMUX_DEFAULT_MAX_TOKENS,
} from "./constants.js";

const DEFAULT_INPUT: Array<"text" | "image"> = ["text"];

type ModelApi = "openai-completions" | "anthropic-messages" | "google-generative-ai"; // eslint-disable-line @typescript-eslint/no-unused-vars

function buildDynamicModel(
  ctx: { modelId: string },
  api: ModelApi,
  baseUrl: string,
  provider: string,
) {
  const caps = getZenmuxModelCapabilities(ctx.modelId);
  return {
    id: ctx.modelId,
    name: caps?.name ?? ctx.modelId,
    api,
    provider,
    baseUrl,
    reasoning: caps?.reasoning ?? false,
    input: caps?.input ?? DEFAULT_INPUT,
    cost: caps?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: caps?.contextWindow ?? ZENMUX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: caps?.maxTokens ?? ZENMUX_DEFAULT_MAX_TOKENS,
  };
}

function makeAuth() {
  return createProviderApiKeyAuthMethod({
    providerId: "zenmux",
    methodId: "api-key",
    label: "ZenMux API key",
    hint: "API key",
    optionKey: "zenmuxApiKey",
    flagName: "--zenmux-api-key",
    envVar: "ZENMUX_API_KEY",
    promptMessage: "Enter ZenMux API key",
    expectedProviders: ["zenmux"],
    applyConfig: (cfg) => applyZenmuxConfig(cfg),
    wizard: {
      choiceId: "zenmux-api-key",
      choiceLabel: "ZenMux API key",
      groupId: "zenmux",
      groupLabel: "ZenMux",
      groupHint: "API key",
    },
  });
}

/** Singleton StreamFn for the Zenmux Gemini native transport. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const zenmuxGeminiStreamFn = createZenmuxGeminiTransportStreamFn() as any;

async function loadCatalogModels(
  filter?: (model: ModelDefinitionConfig) => boolean,
): Promise<ModelDefinitionConfig[] | undefined> {
  const models = await loadZenmuxModelDefinitions();
  const filtered = filter ? models.filter(filter) : models;
  return filtered.length > 0 ? filtered : undefined;
}

export default definePluginEntry({
  id: "zenmux-multiprotocol",
  name: "ZenMux Multi-Protocol Provider",
  description:
    "ZenMux LLM provider plugin for OpenClaw — native OpenAI, Anthropic, and Vertex transports",
  register(api) {
    api.registerImageGenerationProvider(buildZenmuxImageGenerationProvider());

    api.registerProvider({
      id: "zenmux-openai",
      label: "ZenMux (OpenAI)",
      docsPath: "/providers/zenmux",
      envVars: ["ZENMUX_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey =
            ctx.resolveProviderApiKey("zenmux").apiKey ??
            ctx.resolveProviderApiKey("zenmux-openai").apiKey;
          if (!apiKey) return null;
          const models = await loadCatalogModels();
          return { provider: { ...buildZenmuxOpenaiProvider(models), apiKey } };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildZenmuxOpenaiProvider() }),
      },
      resolveDynamicModel: (ctx) =>
        buildDynamicModel(ctx, "openai-completions", ZENMUX_OPENAI_BASE_URL, "zenmux-openai"),
      prepareDynamicModel: async (ctx) => {
        await loadZenmuxModelCapabilities(ctx.modelId);
      },
    });

    api.registerProvider({
      id: "zenmux-anthropic",
      label: "ZenMux (Anthropic)",
      docsPath: "/providers/zenmux",
      envVars: ["ZENMUX_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey =
            ctx.resolveProviderApiKey("zenmux").apiKey ??
            ctx.resolveProviderApiKey("zenmux-anthropic").apiKey;
          if (!apiKey) return null;
          const models = await loadCatalogModels((model) => isZenmuxAnthropicModelId(model.id));
          return { provider: { ...buildZenmuxAnthropicProvider(models), apiKey } };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildZenmuxAnthropicProvider() }),
      },
      resolveDynamicModel: (ctx) =>
        buildDynamicModel(
          ctx,
          "anthropic-messages",
          ZENMUX_ANTHROPIC_BASE_URL,
          "zenmux-anthropic",
        ),
      prepareDynamicModel: async (ctx) => {
        await loadZenmuxModelCapabilities(ctx.modelId);
      },
    });

    // zenmux-vertex: now uses the native Gemini transport + google-generative-ai api.
    // The static catalog is kept for model discovery; the createStreamFn override
    // routes all zenmux-vertex calls through the Zenmux bare-vertex URL shape.
    api.registerProvider({
      id: "zenmux-vertex",
      label: "ZenMux (Vertex AI / Gemini)",
      docsPath: "/providers/zenmux",
      envVars: ["ZENMUX_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey =
            ctx.resolveProviderApiKey("zenmux").apiKey ??
            ctx.resolveProviderApiKey("zenmux-vertex").apiKey;
          if (!apiKey) return null;
          const models = await loadCatalogModels((model) => isZenmuxGeminiModelId(model.id));
          return { provider: { ...buildZenmuxGeminiProvider(models), apiKey } };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildZenmuxGeminiProvider() }),
      },
      resolveDynamicModel: (ctx) =>
        buildDynamicModel(ctx, "google-generative-ai", ZENMUX_GEMINI_BASE_URL, "zenmux-vertex"),
      prepareDynamicModel: async (ctx) => {
        await loadZenmuxModelCapabilities(ctx.modelId);
      },
      createStreamFn: () => zenmuxGeminiStreamFn,
    });

    // Back-compat alias + smart-routing provider.
    //
    // Model refs written as `zenmux/<upstream-id>` resolve to the single
    // `zenmux` provider below. Transport dispatch by model id:
    //   - `anthropic/claude-*`  → anthropic-messages (native Anthropic; prompt caching)
    //   - `google/gemini-*` etc → google-generative-ai via Zenmux bare-vertex transport
    //     (returns thoughtSignature; adaptive thinking; native Gemini protocol)
    //   - everything else       → openai-completions (unchanged from v0.5.0)
    api.registerProvider({
      id: "zenmux",
      label: "ZenMux",
      docsPath: "/providers/zenmux",
      envVars: ["ZENMUX_API_KEY"],
      auth: [makeAuth()],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey("zenmux").apiKey;
          if (!apiKey) return null;
          const models = await loadCatalogModels();
          return { provider: { ...buildZenmuxOpenaiProvider(models), apiKey } };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildZenmuxOpenaiProvider() }),
      },
      resolveDynamicModel: (ctx) => {
        if (ctx.modelId.startsWith("anthropic/claude-")) {
          return buildDynamicModel(
            ctx,
            "anthropic-messages",
            ZENMUX_ANTHROPIC_BASE_URL,
            "zenmux",
          );
        }
        if (isZenmuxGeminiModelId(ctx.modelId)) {
          return buildDynamicModel(
            ctx,
            "google-generative-ai",
            ZENMUX_GEMINI_BASE_URL,
            "zenmux",
          );
        }
        return buildDynamicModel(ctx, "openai-completions", ZENMUX_OPENAI_BASE_URL, "zenmux");
      },
      prepareDynamicModel: async (ctx) => {
        await loadZenmuxModelCapabilities(ctx.modelId);
      },
      createStreamFn: (ctx) => {
        if (ctx.model.api === "google-generative-ai") {
          return zenmuxGeminiStreamFn;
        }
        return undefined; // let core handle anthropic-messages and openai-completions
      },
    });
  },
});

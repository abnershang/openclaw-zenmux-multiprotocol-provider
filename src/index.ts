import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { applyZenmuxConfig } from "./onboard.js";
import { buildZenmuxOpenaiProvider } from "./provider-catalog-openai.js";
import { buildZenmuxAnthropicProvider } from "./provider-catalog-anthropic.js";
import { buildZenmuxVertexProvider } from "./provider-catalog-vertex.js";
import {
  getZenmuxModelCapabilities,
  loadZenmuxModelCapabilities,
} from "./zenmux-capabilities-cache.js";
import {
  ZENMUX_OPENAI_BASE_URL,
  ZENMUX_ANTHROPIC_BASE_URL,
  ZENMUX_VERTEX_BASE_URL,
  ZENMUX_DEFAULT_CONTEXT_WINDOW,
  ZENMUX_DEFAULT_MAX_TOKENS,
} from "./constants.js";

const ALL_PROVIDER_IDS = ["zenmux", "zenmux-openai", "zenmux-anthropic", "zenmux-vertex"] as const;

type ModelApi = "openai-completions" | "anthropic-messages";

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
    input: caps?.input ?? (["text"] as Array<"text" | "image">),
    cost: caps?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: caps?.contextWindow ?? ZENMUX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: caps?.maxTokens ?? ZENMUX_DEFAULT_MAX_TOKENS,
  };
}

function makeAuth(providerId: string) {
  return createProviderApiKeyAuthMethod({
    providerId,
    methodId: "api-key",
    label: "ZenMux API key",
    hint: "API key",
    optionKey: "zenmuxApiKey",
    flagName: "--zenmux-api-key",
    envVar: "ZENMUX_API_KEY",
    promptMessage: "Enter ZenMux API key",
    expectedProviders: [...ALL_PROVIDER_IDS],
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

export default definePluginEntry({
  id: "zenmux-multiprotocol",
  name: "ZenMux Multi-Protocol Provider",
  description:
    "ZenMux LLM provider plugin for OpenClaw — native OpenAI, Anthropic, and Vertex transports",
  register(api) {
    api.registerProvider({
      id: "zenmux-openai",
      label: "ZenMux (OpenAI)",
      docsPath: "/providers/zenmux",
      envVars: ["ZENMUX_API_KEY"],
      auth: [makeAuth("zenmux-openai")],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey("zenmux-openai").apiKey;
          if (!apiKey) return null;
          return { provider: { ...buildZenmuxOpenaiProvider(), apiKey } };
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
      auth: [makeAuth("zenmux-anthropic")],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey("zenmux-anthropic").apiKey;
          if (!apiKey) return null;
          return { provider: { ...buildZenmuxAnthropicProvider(), apiKey } };
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

    api.registerProvider({
      id: "zenmux-vertex",
      label: "ZenMux (Vertex AI)",
      docsPath: "/providers/zenmux",
      envVars: ["ZENMUX_API_KEY"],
      auth: [makeAuth("zenmux-vertex")],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey("zenmux-vertex").apiKey;
          if (!apiKey) return null;
          return { provider: { ...buildZenmuxVertexProvider(), apiKey } };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildZenmuxVertexProvider() }),
      },
      resolveDynamicModel: (ctx) =>
        buildDynamicModel(ctx, "openai-completions", ZENMUX_VERTEX_BASE_URL, "zenmux-vertex"),
      prepareDynamicModel: async (ctx) => {
        await loadZenmuxModelCapabilities(ctx.modelId);
      },
    });

    // Back-compat alias + smart-routing provider.
    //
    // Model refs written as `zenmux/<upstream-id>` resolve to the single
    // `zenmux` provider below. To give users native Anthropic prompt caching
    // without forcing them to migrate every ref to `zenmux-anthropic/...`,
    // this provider's resolveDynamicModel dispatches the transport by model
    // id: `anthropic/claude-*` routes over `anthropic-messages`, everything
    // else stays on `openai-completions` (which the full ZenMux catalog
    // supports). The static catalog is intentionally empty so dynamic
    // resolution is the sole source of truth for transport selection.
    api.registerProvider({
      id: "zenmux",
      label: "ZenMux",
      docsPath: "/providers/zenmux",
      envVars: ["ZENMUX_API_KEY"],
      auth: [makeAuth("zenmux")],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey("zenmux").apiKey;
          if (!apiKey) return null;
          return { provider: { ...buildZenmuxOpenaiProvider(), apiKey } };
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
        return buildDynamicModel(ctx, "openai-completions", ZENMUX_OPENAI_BASE_URL, "zenmux");
      },
      prepareDynamicModel: async (ctx) => {
        await loadZenmuxModelCapabilities(ctx.modelId);
      },
    });
  },
});

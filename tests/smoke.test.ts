import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerProviderPlugins, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  PROVIDER_IDS,
  ZENMUX_ANTHROPIC_BASE_URL,
  ZENMUX_DEFAULT_CONTEXT_WINDOW,
  ZENMUX_DEFAULT_MAX_TOKENS,
  ZENMUX_GEMINI_BASE_URL,
  ZENMUX_OPENAI_BASE_URL,
  ZENMUX_VERTEX_BASE_URL,
} from "../src/constants.js";
import zenmuxPlugin from "../src/index.js";
import {
  buildZenmuxGeminiUrl,
  _buildZenmuxGeminiPayloadForTesting,
  _parseZenmuxGeminiSseForTesting,
} from "../src/transport-zenmux-gemini.js";
import {
  normalizeZenmuxGoogleModelId,
  staticZenmuxModelDefinitions,
} from "../src/zenmux-models.js";
import {
  _resetCacheForTesting,
  getZenmuxModelCapabilities,
} from "../src/zenmux-capabilities-cache.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(async () => ({
    response: new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: async () => {},
  })),
}));

describe("constants", () => {
  it("exports correct base URLs", () => {
    expect(ZENMUX_OPENAI_BASE_URL).toBe("https://zenmux.ai/api/v1");
    expect(ZENMUX_ANTHROPIC_BASE_URL).toBe("https://zenmux.ai/api/anthropic/v1");
    expect(ZENMUX_VERTEX_BASE_URL).toBe("https://zenmux.ai/api/vertex-ai/v1beta");
    expect(ZENMUX_GEMINI_BASE_URL).toBe("https://zenmux.ai/api/vertex-ai/v1");
  });

  it("exports correct defaults", () => {
    expect(ZENMUX_DEFAULT_CONTEXT_WINDOW).toBe(200_000);
    expect(ZENMUX_DEFAULT_MAX_TOKENS).toBe(8192);
  });

  it("exports all 4 provider IDs", () => {
    expect(PROVIDER_IDS).toContain("zenmux");
    expect(PROVIDER_IDS).toContain("zenmux-openai");
    expect(PROVIDER_IDS).toContain("zenmux-anthropic");
    expect(PROVIDER_IDS).toContain("zenmux-vertex");
    expect(PROVIDER_IDS).toHaveLength(4);
  });
});

describe("provider registration", () => {
  it("exposes one shared ZenMux auth method across all protocol providers", async () => {
    const providers = await registerProviderPlugins(zenmuxPlugin);

    expect(requireRegisteredProvider(providers, "zenmux").auth).toHaveLength(1);
    expect(requireRegisteredProvider(providers, "zenmux-openai").auth).toHaveLength(0);
    expect(requireRegisteredProvider(providers, "zenmux-anthropic").auth).toHaveLength(0);
    expect(requireRegisteredProvider(providers, "zenmux-vertex").auth).toHaveLength(0);
  });

  it("normalizes Gemini preview aliases for the smart ZenMux provider", async () => {
    const providers = await registerProviderPlugins(zenmuxPlugin);
    const provider = requireRegisteredProvider(providers, "zenmux");

    expect(
      provider.normalizeModelId?.({
        provider: "zenmux",
        modelId: "google/gemini-3.1-flash-lite",
      }),
    ).toBe("google/gemini-3.1-flash-lite-preview");
  });
});

describe("normalizeZenmuxGoogleModelId", () => {
  it("mirrors OpenClaw Google preview aliases for Gemini 3.x", () => {
    expect(normalizeZenmuxGoogleModelId("google/gemini-3.1-flash-lite")).toBe(
      "google/gemini-3.1-flash-lite-preview",
    );
    expect(normalizeZenmuxGoogleModelId("gemini-3.1-pro")).toBe(
      "gemini-3.1-pro-preview",
    );
    expect(normalizeZenmuxGoogleModelId("google/gemini-3.1-flash")).toBe(
      "google/gemini-3-flash-preview",
    );
  });
});

describe("staticZenmuxModelDefinitions", () => {
  it("returns a non-empty array", () => {
    const defs = staticZenmuxModelDefinitions();
    expect(defs.length).toBeGreaterThan(0);
  });

  it("each model has required fields with valid values", () => {
    for (const def of staticZenmuxModelDefinitions()) {
      expect(typeof def.id).toBe("string");
      expect(def.id.length).toBeGreaterThan(0);
      expect(typeof def.name).toBe("string");
      expect(def.contextWindow).toBeGreaterThan(0);
      expect(def.maxTokens).toBeGreaterThan(0);
      expect(def.cost).toBeDefined();
    }
  });
});

describe("transport-zenmux-gemini URL builder", () => {
  it("builds bare-vertex URL shape for a Gemini model (no project/location segments)", () => {
    const url = buildZenmuxGeminiUrl("gemini-3.1-pro-preview");
    expect(url).toBe(
      "https://zenmux.ai/api/vertex-ai/v1/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
    );
    // Must NOT contain GCP project/location path segments
    expect(url).not.toContain("/projects/");
    expect(url).not.toContain("/locations/");
    // Must use the bare-vertex segment
    expect(url).toContain("/publishers/google/models/");
  });

  it("percent-encodes model IDs with special characters", () => {
    const url = buildZenmuxGeminiUrl("gemini-3.1-flash-lite-preview");
    expect(url).toContain("gemini-3.1-flash-lite-preview");
    expect(url).toContain(":streamGenerateContent");
  });

  it("uses v1 API version (not v1beta)", () => {
    const url = buildZenmuxGeminiUrl("gemini-3-flash-preview");
    expect(url).toContain("/api/vertex-ai/v1/");
    expect(url).not.toContain("v1beta");
  });

  it("strips google/ publisher prefix before encoding (regression: zenmux 404 invalid_model)", () => {
    // OpenClaw model refs arrive as "google/<id>". Zenmux's bare-vertex
    // endpoint pins publisher=google and requires the bare id in the path
    // segment; the prefixed form returns 404 invalid_model.
    const url = buildZenmuxGeminiUrl("google/gemini-3.1-flash-lite-preview");
    expect(url).toBe(
      "https://zenmux.ai/api/vertex-ai/v1/publishers/google/models/gemini-3.1-flash-lite-preview:streamGenerateContent?alt=sse",
    );
    expect(url).not.toContain("google%2F");
  });

  it("normalizes bare Gemini 3.1 Flash Lite before building the ZenMux URL", () => {
    const url = buildZenmuxGeminiUrl("google/gemini-3.1-flash-lite");
    expect(url).toBe(
      "https://zenmux.ai/api/vertex-ai/v1/publishers/google/models/gemini-3.1-flash-lite-preview:streamGenerateContent?alt=sse",
    );
  });
});

describe("parseZenmuxGeminiSse", () => {
  it("parses a well-formed SSE event in a single chunk", async () => {
    const payload = { candidates: [{ content: { parts: [{ text: "hi" }] } }] };
    const chunks = [`data: ${JSON.stringify(payload)}\n\n`];
    const results = await _parseZenmuxGeminiSseForTesting(chunks);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(payload);
  });

  it("regression bug 1: parses event split across read cycles (data: line and blank line in separate chunks)", async () => {
    // Before fix: pendingData was reset each while iteration, so the blank-line
    // terminator arriving in a separate read() cycle silently dropped the event.
    const payload = { candidates: [{ content: { parts: [{ text: "split" }] } }] };
    const chunks = [
      `data: ${JSON.stringify(payload)}\n`,  // data line, no terminator yet
      `\n`,                                   // blank-line terminator in next read cycle
    ];
    const results = await _parseZenmuxGeminiSseForTesting(chunks);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(payload);
  });

  it("regression bug 2: parses final SSE frame with no trailing blank line (tail flush)", async () => {
    // Before fix: the last frame's data was left in buffer/pendingData and
    // never flushed after done=true, so usage metadata chunks were dropped.
    const payload = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
    // No trailing \n\n — simulates a stream that ends mid-frame
    const chunks = [`data: ${JSON.stringify(payload)}`];
    const results = await _parseZenmuxGeminiSseForTesting(chunks);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(payload);
  });

  it("handles [DONE] sentinel correctly", async () => {
    const payload = { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
    const chunks = [`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`];
    const results = await _parseZenmuxGeminiSseForTesting(chunks);
    expect(results).toHaveLength(1);
  });

  it("skips malformed JSON chunks without throwing", async () => {
    const good = { candidates: [{ content: { parts: [{ text: "good" }] } }] };
    const chunks = [`data: not-json\n\ndata: ${JSON.stringify(good)}\n\n`];
    const results = await _parseZenmuxGeminiSseForTesting(chunks);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(good);
  });
});

describe("transport-zenmux-gemini thought signatures", () => {
  const gemini3Model = {
    id: "google/gemini-3.1-flash-lite-preview",
    provider: "zenmux",
    api: "google-generative-ai",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  function toolCallTurn(
    blockOverrides: Record<string, unknown> = {},
    messageOverrides: Record<string, unknown> = {},
  ) {
    return {
      role: "assistant",
      provider: "zenmux",
      api: "google-generative-ai",
      model: "google/gemini-3.1-flash-lite-preview",
      stopReason: "toolUse",
      timestamp: 0,
      ...messageOverrides,
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "lookup",
          arguments: { q: "hello" },
          ...blockOverrides,
        },
      ],
    };
  }

  function getModelTurns(params: { contents: Array<Record<string, unknown>> }) {
    return params.contents.filter((turn) => turn.role === "model") as Array<{
      parts: Array<Record<string, unknown>>;
    }>;
  }

  it("adds Gemini 3 skip-validator fallback for unsigned tool-call history", () => {
    const params = _buildZenmuxGeminiPayloadForTesting(gemini3Model, {
      messages: [toolCallTurn()],
    });

    expect(getModelTurns(params)[0].parts[0]).toMatchObject({
      thoughtSignature: "skip_thought_signature_validator",
      functionCall: { name: "lookup", args: { q: "hello" } },
    });
  });

  it("replays a previous same-route Gemini tool-call thought signature", () => {
    const params = _buildZenmuxGeminiPayloadForTesting(gemini3Model, {
      messages: [
        toolCallTurn({ thoughtSignature: "call_sig_replay_1" }),
        {
          role: "toolResult",
          toolName: "lookup",
          content: [{ type: "text", text: "result" }],
        },
        toolCallTurn({ timestamp: 2 }),
      ],
    });

    expect(getModelTurns(params).at(-1)?.parts[0]).toMatchObject({
      thoughtSignature: "call_sig_replay_1",
      functionCall: { name: "lookup", args: { q: "hello" } },
    });
  });

  it("does not replay foreign-route signatures into ZenMux Gemini", () => {
    const params = _buildZenmuxGeminiPayloadForTesting(gemini3Model, {
      messages: [
        toolCallTurn(
          { thoughtSignature: "msg_01XFDUDYJgAACcnSM2TTgQsA" },
          {
            provider: "zenmux",
            api: "anthropic-messages",
            model: "anthropic/claude-sonnet-4.6",
          },
        ),
      ],
    });

    expect(getModelTurns(params)[0].parts[0]).toMatchObject({
      thoughtSignature: "skip_thought_signature_validator",
      functionCall: { name: "lookup", args: { q: "hello" } },
    });
    expect(JSON.stringify(params.contents)).not.toContain("msg_01XFDUDYJgAACcnSM2TTgQsA");
  });

  it("does not add fallback signatures for non-Gemini-3 models", () => {
    const params = _buildZenmuxGeminiPayloadForTesting(
      { ...gemini3Model, id: "google/gemini-2.5-pro" },
      { messages: [toolCallTurn({}, { model: "google/gemini-2.5-pro" })] },
    );

    expect(getModelTurns(params)[0].parts[0]).toEqual({
      functionCall: { name: "lookup", args: { q: "hello" } },
    });
  });
});

describe("zenmux-capabilities-cache", () => {
  beforeEach(() => {
    _resetCacheForTesting();
  });

  it("returns undefined for unknown model when cache is cold", () => {
    expect(getZenmuxModelCapabilities("unknown/model-xyz")).toBeUndefined();
  });

  it("_resetCacheForTesting clears state without throwing", () => {
    _resetCacheForTesting();
  });

  it("returns undefined again after reset even if a fetch was triggered", () => {
    getZenmuxModelCapabilities("some/model");
    _resetCacheForTesting();
    expect(getZenmuxModelCapabilities("some/model")).toBeUndefined();
  });
});

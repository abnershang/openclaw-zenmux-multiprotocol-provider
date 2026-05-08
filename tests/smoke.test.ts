import { beforeEach, describe, expect, it } from "vitest";
import {
  PROVIDER_IDS,
  ZENMUX_ANTHROPIC_BASE_URL,
  ZENMUX_DEFAULT_CONTEXT_WINDOW,
  ZENMUX_DEFAULT_MAX_TOKENS,
  ZENMUX_OPENAI_BASE_URL,
  ZENMUX_VERTEX_BASE_URL,
} from "../src/constants.js";
import { staticZenmuxModelDefinitions } from "../src/zenmux-models.js";
import {
  _resetCacheForTesting,
  getZenmuxModelCapabilities,
} from "../src/zenmux-capabilities-cache.js";

describe("constants", () => {
  it("exports correct base URLs", () => {
    expect(ZENMUX_OPENAI_BASE_URL).toBe("https://zenmux.ai/api/v1");
    expect(ZENMUX_ANTHROPIC_BASE_URL).toBe("https://zenmux.ai/api/anthropic/v1");
    expect(ZENMUX_VERTEX_BASE_URL).toBe("https://zenmux.ai/api/vertex-ai/v1beta");
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

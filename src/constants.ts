export const ZENMUX_OPENAI_BASE_URL = "https://zenmux.ai/api/v1";
export const ZENMUX_ANTHROPIC_BASE_URL = "https://zenmux.ai/api/anthropic/v1";
export const ZENMUX_VERTEX_BASE_URL = "https://zenmux.ai/api/vertex-ai/v1beta";
export const ZENMUX_DEFAULT_CONTEXT_WINDOW = 200_000;
export const ZENMUX_DEFAULT_MAX_TOKENS = 8192;
export const PROVIDER_IDS = ["zenmux-openai", "zenmux-anthropic", "zenmux-vertex", "zenmux"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { ZENMUX_GEMINI_BASE_URL } from "./constants.js";
import { isZenmuxGeminiModelId, staticZenmuxModelDefinitions } from "./zenmux-models.js";

/**
 * Zenmux Gemini provider catalog.
 *
 * Uses `api: "google-generative-ai"` for correct OpenClaw thinking-level
 * handling and adaptive reasoning support. The actual HTTP transport is
 * overridden via `createStreamFn` in index.ts to use the Zenmux bare-vertex
 * URL shape: /publishers/google/models/{id}:streamGenerateContent?alt=sse
 */
export function buildZenmuxGeminiProvider(
  models: ModelDefinitionConfig[] = staticZenmuxModelDefinitions((model) =>
    isZenmuxGeminiModelId(model.id),
  ),
): ModelProviderConfig {
  return {
    baseUrl: ZENMUX_GEMINI_BASE_URL,
    api: "google-generative-ai",
    models: models.filter((model) => isZenmuxGeminiModelId(model.id)),
  };
}

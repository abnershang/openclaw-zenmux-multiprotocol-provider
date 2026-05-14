import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { ZENMUX_VERTEX_BASE_URL } from "./constants.js";
import { isZenmuxGeminiModelId, staticZenmuxModelDefinitions } from "./zenmux-models.js";

export function buildZenmuxVertexProvider(
  models: ModelDefinitionConfig[] = staticZenmuxModelDefinitions((model) =>
    isZenmuxGeminiModelId(model.id),
  ),
): ModelProviderConfig {
  return {
    baseUrl: ZENMUX_VERTEX_BASE_URL,
    api: "openai-completions",
    models: models.filter((model) => isZenmuxGeminiModelId(model.id)),
  };
}

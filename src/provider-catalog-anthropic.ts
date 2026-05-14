import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { ZENMUX_ANTHROPIC_BASE_URL } from "./constants.js";
import { isZenmuxAnthropicModelId, staticZenmuxModelDefinitions } from "./zenmux-models.js";

export function buildZenmuxAnthropicProvider(
  models: ModelDefinitionConfig[] = staticZenmuxModelDefinitions((model) =>
    isZenmuxAnthropicModelId(model.id),
  ),
): ModelProviderConfig {
  return {
    baseUrl: ZENMUX_ANTHROPIC_BASE_URL,
    api: "anthropic-messages",
    models: models.filter((model) => isZenmuxAnthropicModelId(model.id)),
  };
}

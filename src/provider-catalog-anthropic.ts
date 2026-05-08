import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { ZENMUX_ANTHROPIC_BASE_URL } from "./constants.js";
import { staticZenmuxModelDefinitions } from "./zenmux-models.js";

export function buildZenmuxAnthropicProvider(): ModelProviderConfig {
  return {
    baseUrl: ZENMUX_ANTHROPIC_BASE_URL,
    api: "anthropic-messages",
    models: staticZenmuxModelDefinitions(),
  };
}

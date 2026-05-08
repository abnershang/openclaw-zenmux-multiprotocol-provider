import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { ZENMUX_OPENAI_BASE_URL } from "./constants.js";
import { staticZenmuxModelDefinitions } from "./zenmux-models.js";

export function buildZenmuxOpenaiProvider(): ModelProviderConfig {
  return {
    baseUrl: ZENMUX_OPENAI_BASE_URL,
    api: "openai-completions",
    models: staticZenmuxModelDefinitions(),
  };
}

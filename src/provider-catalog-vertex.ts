import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { ZENMUX_VERTEX_BASE_URL } from "./constants.js";
import { staticZenmuxModelDefinitions } from "./zenmux-models.js";

export function buildZenmuxVertexProvider(): ModelProviderConfig {
  return {
    baseUrl: ZENMUX_VERTEX_BASE_URL,
    api: "openai-completions",
    models: staticZenmuxModelDefinitions(),
  };
}

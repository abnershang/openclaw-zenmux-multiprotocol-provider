import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { ZENMUX_DEFAULT_CONTEXT_WINDOW, ZENMUX_DEFAULT_MAX_TOKENS } from "./constants.js";

const ZENMUX_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

// Small static catalog returned by buildZenmux*Provider(). Contains only the
// onboarding default model so the picker has something before the dynamic
// capabilities cache is warm. Any other zenmux/<id> still works on demand via
// resolveDynamicModel + prepareDynamicModel.
export function staticZenmuxModelDefinitions(): ModelDefinitionConfig[] {
  return [
    {
      id: "openai/gpt-5.4",
      name: "GPT-5.4",
      reasoning: false,
      input: ["text", "image"],
      cost: { ...ZENMUX_DEFAULT_COST },
      contextWindow: ZENMUX_DEFAULT_CONTEXT_WINDOW,
      maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
    },
  ];
}

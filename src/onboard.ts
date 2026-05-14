import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  ZENMUX_OPENAI_BASE_URL,
  ZENMUX_ANTHROPIC_BASE_URL,
  ZENMUX_VERTEX_BASE_URL,
} from "./constants.js";

export const ZENMUX_DEFAULT_MODEL_REF = "zenmux/openai/gpt-5.5";

function applyOpenaiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: cfg.agents?.defaults?.models ?? {},
    providerId: "zenmux-openai",
    api: "openai-completions",
    baseUrl: ZENMUX_OPENAI_BASE_URL,
    catalogModels: [],
  });
}

function applyAnthropicProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: cfg.agents?.defaults?.models ?? {},
    providerId: "zenmux-anthropic",
    api: "anthropic-messages",
    baseUrl: ZENMUX_ANTHROPIC_BASE_URL,
    catalogModels: [],
  });
}

function applyVertexProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: cfg.agents?.defaults?.models ?? {},
    providerId: "zenmux-vertex",
    api: "openai-completions",
    baseUrl: ZENMUX_VERTEX_BASE_URL,
    catalogModels: [],
  });
}

function applyBackCompatProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: cfg.agents?.defaults?.models ?? {},
    providerId: "zenmux",
    api: "openai-completions",
    baseUrl: ZENMUX_OPENAI_BASE_URL,
    catalogModels: [],
  });
}

export function applyZenmuxAllProviderConfigs(cfg: OpenClawConfig): OpenClawConfig {
  return applyBackCompatProviderConfig(
    applyVertexProviderConfig(
      applyAnthropicProviderConfig(applyOpenaiProviderConfig(cfg)),
    ),
  );
}

export function applyZenmuxConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyZenmuxAllProviderConfigs(cfg),
    ZENMUX_DEFAULT_MODEL_REF,
  );
}

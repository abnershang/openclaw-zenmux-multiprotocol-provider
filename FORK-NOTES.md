# Fork Notes — openclaw-zenmux-multiprotocol-provider

**Forked from:** zenmux/openclaw-zenmux-provider v0.2.0  
**Fork author:** Vulcan  
**Fork version:** 0.5.0-vulcan.1

## Why this fork exists

The upstream plugin registered a single `zenmux` provider using the OpenAI-compatible transport. This fork adds native Anthropic Messages and Vertex AI transports so model-specific protocol requirements are honoured end-to-end (e.g. Anthropic-native features like extended thinking, cache control headers).

## v0.5.0-vulcan.1 — Smart transport dispatch on the `zenmux` alias (replaces v0.4.0 approach)

### What changed

The `zenmux` back-compat provider now dispatches transport per model id inside `resolveDynamicModel`:

- `anthropic/claude-*` → `anthropic-messages` against `https://zenmux.ai/api/anthropic/v1` (native Anthropic transport; prompt caching works)
- everything else → `openai-completions` against `https://zenmux.ai/api/v1` (unchanged from v0.3.0)

The provider id on the returned model is still `zenmux`, so there's no provider-id rewrite — only the transport and baseUrl change based on the model id. Users can keep writing `zenmux/anthropic/claude-sonnet-4.6` in their config and automatically get native caching.

### Why the v0.4.0 approach was reverted

v0.4.0 attempted a plugin-side config rewriter via the `applyConfigDefaults` SDK hook on the `zenmux` provider. It compiled, typechecked, and its unit tests passed — but the hook never fired at runtime.

Root cause: core (`src/config/defaults.ts`) only invokes `applyProviderConfigDefaultsForConfig` for `provider: "anthropic"` inside `applyContextPruningDefaults`, gated on `hasAnthropicDefaultSignal`. The SDK exposes `applyConfigDefaults` as a field on every `ProviderPlugin`, but the core runtime never walks all registered providers to trigger it. The hook was effectively dead code when attached to a third-party provider.

Verification: a live Claude call via `zenmux/anthropic/claude-sonnet-4.6` landed in `cache-trace.jsonl` with `provider: zenmux, modelApi: openai-completions` — proving the hook did not rewrite the ref before transport selection.

v0.5.0 achieves the same user-visible outcome ("write `zenmux/anthropic/claude-*` and native caching just works") using a hook (`resolveDynamicModel`) that core actually invokes per model resolution.

### Removed

- `src/config-rewriter.ts`
- `tests/rewriter.test.ts`

### Modified

**`src/index.ts`** — the `zenmux` alias provider's `resolveDynamicModel` now branches on `ctx.modelId.startsWith("anthropic/claude-")` and returns an `anthropic-messages` model for that case; otherwise returns the `openai-completions` model.

**`package.json`** — version bumped to `0.5.0-vulcan.1`.

### Limitations

- Only `anthropic/claude-*` is auto-routed. `google/gemini-*` stays on openai-compat (ZenMux's vertex endpoint isn't wired into OpenClaw's `google-generative-ai` transport, and there's no confirmed benefit to routing it differently today).
- The explicit `zenmux-anthropic/...` namespace still works for users who want to be explicit.

---

## v0.4.0-vulcan.1 — Anthropic ref auto-rewriter (SUPERSEDED; see v0.5.0 above)

### New files

| File | Purpose |
|------|---------|
| `src/config-rewriter.ts` | Pure functions that rewrite `zenmux/anthropic/claude-*` model refs to `zenmux-anthropic/anthropic/claude-*` in-memory at config-load time |

### Modified files

**`src/index.ts`**
- Added `applyConfigDefaults` hook to the `zenmux` back-compat provider registration only
- Hook calls `rewriteZenmuxAnthropicRefs(ctx.config)` so existing configs using `zenmux/anthropic/claude-*` refs transparently get native Anthropic transport without any user migration

**`package.json`**
- `version`: `0.4.0-vulcan.1`

### Behaviour

When a user has a config containing `zenmux/anthropic/claude-*` model refs (e.g. `zenmux/anthropic/claude-sonnet-4.6`), the `zenmux` provider's `applyConfigDefaults` hook rewrites them in-memory to `zenmux-anthropic/anthropic/claude-sonnet-4.6` before any request is made. The rewrite is:

- **Narrow**: only `^zenmux/anthropic/claude-` prefixes are touched; OpenAI and Vertex refs are unaffected
- **Idempotent**: already-migrated `zenmux-anthropic/` refs pass through unchanged
- **Non-persisting**: the rewrite is in-memory only; `~/.openclaw/openclaw.json` is never modified
- **Covers 11 config paths**: `agents.defaults` model fields (model, heartbeat.model, subagents.model, compaction.model, compaction.memoryFlush.model, models map keys), same for each `agents.list[i]`, `channels.modelByChannel` values, `hooks.mappings[].model`, `hooks.gmail.model`, `tools.subagents.model`

## Changes from upstream v0.2.0

### New files

| File | Purpose |
|------|---------|
| `src/constants.ts` | All URL and default constants in one place; replaces inline literals scattered across upstream files |
| `src/provider-catalog-openai.ts` | `buildZenmuxOpenaiProvider()` — `api: "openai-completions"`, OpenAI base URL |
| `src/provider-catalog-anthropic.ts` | `buildZenmuxAnthropicProvider()` — `api: "anthropic-messages"`, Anthropic base URL |
| `src/provider-catalog-vertex.ts` | `buildZenmuxVertexProvider()` — `api: "openai-completions"`, Vertex base URL |

### Modified files (relative to upstream)

**`src/onboard.ts`** (was `onboard.ts` in upstream flat layout)
- Moved to `src/` subdirectory (all source now under `src/`)
- `applyZenmuxProviderConfig` replaced by four private functions, one per provider ID
- `applyZenmuxAllProviderConfigs` applies all four in sequence
- `applyZenmuxConfig` unchanged in signature; now delegates to `applyZenmuxAllProviderConfigs`

**`src/index.ts`** (was `index.ts`)
- Plugin entry ID changed from `"zenmux"` to `"zenmux-multiprotocol"` to avoid collision when both plugins are installed
- `api.registerProvider` called four times (once per provider ID) instead of once
- `makeAuth(providerId)` helper extracts the repeated `createProviderApiKeyAuthMethod` pattern; `expectedProviders` covers all four IDs so entering the key via any provider's wizard configures all four
- `buildDynamicModel(ctx, api, baseUrl, provider)` extracts the repeated dynamic-model builder; `api` and `baseUrl` are provider-specific

**`src/zenmux-capabilities-cache.ts`** (was `zenmux-capabilities-cache.js` — plain JS in upstream)
- Rewritten as TypeScript with explicit types for all structures
- Exports and runtime logic are identical to the upstream compiled JS

**`openclaw.plugin.json`**
- `id` changed to `"zenmux-multiprotocol"`
- `providers` array extended to all four IDs
- `modelSupport.modelPrefixes` extended to all four prefixes
- `providerAuthEnvVars` maps all four providers to `ZENMUX_API_KEY`
- `setup.providers` lists all four

**`package.json`**
- `name`: `openclaw-zenmux-multiprotocol-provider`
- `version`: `0.3.0-vulcan.1`
- `openclaw.providers`: all four IDs
- `devDependencies.openclaw`: `file:../../openclaw/openclaw` (local workspace ref; upstream used npm registry)

### Structural changes

- Source files moved from flat root layout to `src/` subdirectory
- `provider-catalog.ts` split into three typed files (`provider-catalog-openai.ts`, `provider-catalog-anthropic.ts`, `provider-catalog-vertex.ts`)
- `zenmux-models.ts` imports constants from `./constants.js` instead of defining them inline

## Back-compat guarantee

The `zenmux` provider (fourth registration, Option A) is byte-for-byte equivalent to `zenmux-openai`: same base URL, same `api: "openai-completions"`, same static catalog, same dynamic model resolution. Existing openclaw configs referencing `zenmux/…` model IDs require no changes.

## Known limitations

- `zenmux-vertex` uses `api: "openai-completions"` because OpenClaw's `ModelApi` enum does not include a `"vertex-ai"` value. The Vertex endpoint is OpenAI-schema compatible, so this works in practice but loses any future Vertex-native protocol optimisations.
- `maxTokens` for dynamic models always falls back to `ZENMUX_DEFAULT_MAX_TOKENS` (8192) because the ZenMux `/api/v1/models` response does not expose per-model output token limits.

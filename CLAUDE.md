# CLAUDE.md — openclaw-zenmux-multiprotocol-provider

## Project context
OpenClaw plugin that registers four ZenMux provider IDs sharing one `ZENMUX_API_KEY`:
- `zenmux` — smart-routing back-compat alias; auto-dispatches `anthropic/claude-*` to native Anthropic transport
- `zenmux-openai` — explicit OpenAI-compat transport (`openai-completions`)
- `zenmux-anthropic` — explicit native Anthropic transport (`anthropic-messages`); enables prompt caching
- `zenmux-vertex` — explicit Vertex AI endpoint via OpenAI-compat

## Key files
| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry; registers all 4 providers |
| `src/onboard.ts` | Config defaults for all 4 providers |
| `src/constants.ts` | Base URLs and defaults |
| `src/provider-catalog-{openai,anthropic,vertex}.ts` | Static catalog builders |
| `src/zenmux-models.ts` | Static model fallback |
| `src/zenmux-capabilities-cache.ts` | Singleton in-memory + disk model capabilities cache |

## Build
- `npm run build` — compile TypeScript to `dist/`
- `npm run typecheck` — type-check without emitting
- `npm test` — vitest smoke tests

## SDK import contract
Only import from `openclaw/plugin-sdk/*` paths. Do NOT import from internal `src/**` paths.

## Smart dispatch
The `zenmux` provider's `resolveDynamicModel` branches on `modelId.startsWith("anthropic/claude-")` and returns an `anthropic-messages` model with `ZENMUX_ANTHROPIC_BASE_URL` for those. All other model ids return `openai-completions` with `ZENMUX_OPENAI_BASE_URL`. This means users can keep writing `zenmux/anthropic/claude-*` refs in config and get native Anthropic caching automatically.

## Conventions
- Version: semver
- Commit style: conventional commits
- Do not modify the plugin host config file from this project
- Do not publish to npm

# openclaw-zenmux-multiprotocol-provider

> Multi-protocol ZenMux provider plugin for [OpenClaw](https://github.com/openclaw/openclaw) — four provider IDs, one API key, native OpenAI + Anthropic + Vertex transports.

Registers four ZenMux provider IDs that share a single `ZENMUX_API_KEY` and route over the correct native transport for the upstream model. Anthropic models get native prompt caching automatically; Google Gemini/Vertex models use the native Gemini transport with thoughtSignature retention and adaptive thinking; all other models use OpenAI-compatible chat completions.

## Providers

| Provider ID        | API type              | Base URL                                  |
|--------------------|-----------------------|-------------------------------------------|
| `zenmux`           | Smart dispatch        | see **Smart dispatch** below              |
| `zenmux-openai`    | `openai-completions`  | `https://zenmux.ai/api/v1`                |
| `zenmux-anthropic` | `anthropic-messages`  | `https://zenmux.ai/api/anthropic/v1`      |
| `zenmux-vertex`    | `google-generative-ai` | `https://zenmux.ai/api/vertex-ai/v1`     |

## Smart dispatch

The `zenmux` provider inspects each model id at resolve time:

- `zenmux/anthropic/claude-*` → routed to **`anthropic-messages`** transport (native Anthropic API, prompt caching enabled)
- `zenmux/google/gemini-*`, `zenmux/google/gemma-*`, `zenmux/google/veo-*`, `zenmux/google/lyria-*`, `zenmux/google/imagen-*` → routed to **`google-generative-ai`** transport (native Gemini/bare-vertex, supports thoughtSignature + adaptive thinking)
- any other `zenmux/*` id → routed to **`openai-completions`** transport

This means existing configs that reference `zenmux/anthropic/claude-sonnet-4.6` (or any `claude-*` variant) automatically get native Anthropic prompt caching with **zero config changes** — no rewrite, no migration, just install and restart.

**Native Gemini transport:** `zenmux-vertex` and Gemini models via `zenmux` use ZenMux's bare-vertex URL shape (`POST https://zenmux.ai/api/vertex-ai/v1/publishers/google/models/{model}:streamGenerateContent?alt=sse`) rather than the AI Studio or full GCP Vertex path. This preserves `thoughtSignature` across tool-use turns and correctly passes adaptive thinking config.

If you want explicit control (e.g. to force OpenAI-compat transport for a Claude model, or to skip smart dispatch), use one of the explicit provider IDs (`zenmux-openai`, `zenmux-anthropic`, `zenmux-vertex`) directly.

## Install

From a local checkout:

```bash
openclaw plugins install --link /path/to/openclaw-zenmux-multiprotocol-provider
```

Set your ZenMux API key once — it covers all four providers:

```bash
export ZENMUX_API_KEY=zm-...
```

Or configure via the OpenClaw onboarding flow when you first enable any of the providers.

## Development

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

## Model discovery

Model capabilities (context window, modalities, pricing, reasoning flag) are resolved on demand from `https://zenmux.ai/api/v1/models` and cached in-memory plus on disk at `<state-dir>/cache/zenmux-models.json`. The cache is shared across all four providers, so one fetch populates discovery for every transport.

## Fork provenance

Forked from [`zenmux/openclaw-zenmux-provider`](https://github.com/zenmux/openclaw-zenmux-provider) **v0.2.0** by Vulcan. Licensed under MIT (see `LICENSE`). See `FORK-NOTES.md` for the detailed change log vs. upstream.

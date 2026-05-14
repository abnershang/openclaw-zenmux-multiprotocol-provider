# openclaw-zenmux-multiprotocol-provider

> Multi-protocol ZenMux provider plugin for [OpenClaw](https://github.com/openclaw/openclaw) — one smart-dispatch provider, one API key, native OpenAI + Anthropic + Vertex transports.

Use `zenmux/<upstream-model-id>` for model references. The smart-dispatch provider routes each upstream model family over the correct native transport. Anthropic models get native prompt caching automatically; Google Gemini/Vertex models use the native Gemini transport with thoughtSignature retention and adaptive thinking; all other models use OpenAI-compatible chat completions.

## Provider

| Provider ID | Behavior |
|-------------|----------|
| `zenmux`    | Smart dispatch by upstream model family |

The explicit protocol provider IDs (`zenmux-openai`, `zenmux-anthropic`, `zenmux-vertex`) remain registered for transport isolation and legacy config compatibility, but they are not separate setup/auth choices.

## Smart dispatch

The `zenmux` provider inspects each model id at resolve time:

- `zenmux/anthropic/claude-*` → routed to **`anthropic-messages`** transport (native Anthropic API, prompt caching enabled)
- `zenmux/google/gemini-*`, `zenmux/google/gemma-*`, `zenmux/google/veo-*`, `zenmux/google/lyria-*`, `zenmux/google/imagen-*` → routed to **`google-generative-ai`** transport (native Gemini/bare-vertex, supports thoughtSignature + adaptive thinking)
- any other `zenmux/*` id → routed to **`openai-completions`** transport

This means existing configs that reference `zenmux/anthropic/claude-sonnet-4.6` (or any `claude-*` variant) automatically get native Anthropic prompt caching with **zero config changes** — no rewrite, no migration, just install and restart.

**Native Gemini transport:** `zenmux-vertex` and Gemini models via `zenmux` use ZenMux's bare-vertex URL shape (`POST https://zenmux.ai/api/vertex-ai/v1/publishers/google/models/{model}:streamGenerateContent?alt=sse`) rather than the AI Studio or full GCP Vertex path. This preserves `thoughtSignature` across tool-use turns and correctly passes adaptive thinking config.

## Install

From a local checkout:

```bash
openclaw plugins install --link /path/to/openclaw-zenmux-multiprotocol-provider
```

Set your ZenMux API key once:

```bash
export ZENMUX_API_KEY=zm-...
```

Or configure via the OpenClaw onboarding flow. Only the `zenmux` provider exposes the ZenMux auth prompt; protocol-specific registrations reuse that same key.

## Development

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

## Model discovery

Authenticated catalog discovery and per-model capabilities (context window, modalities, pricing, reasoning flag) are resolved from `https://zenmux.ai/api/v1/models` and cached in-memory plus on disk at `<state-dir>/cache/zenmux-models.json`. The cache is shared across all four providers, so one fetch populates discovery for every transport.

The committed model list in `src/zenmux-models.ts` is only an offline/static fallback for startup and unauthenticated catalog views. It is not the authoritative ZenMux catalog.

## Fork provenance

Forked from [`zenmux/openclaw-zenmux-provider`](https://github.com/zenmux/openclaw-zenmux-provider) **v0.2.0** by abnershang. Licensed under MIT (see `LICENSE`). See `FORK-NOTES.md` for the detailed change log vs. upstream.

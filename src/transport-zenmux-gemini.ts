/**
 * Native Zenmux Gemini transport.
 *
 * Zenmux exposes Gemini models via its Vertex-schema endpoint:
 *   POST https://zenmux.ai/api/vertex-ai/v1/publishers/google/models/{model}:streamGenerateContent?alt=sse
 *   Authorization: Bearer <ZENMUX_API_KEY>
 *
 * This differs from OpenClaw's built-in transports:
 *   - `google-generative-ai` builds `{baseUrl}/models/{id}:streamGenerateContent` (AI Studio shape)
 *   - `google-vertex` builds `{origin}/v1/projects/{p}/locations/{l}/publishers/google/models/{id}:...` (full GCP shape)
 *
 * Zenmux only accepts the "bare vertex" shape — no project/location prefix.
 * Live-probe evidence: 2026-05-08, see FORK-NOTES.md v0.6.0 section.
 *
 * Implementation: custom StreamFn registered via ProviderPlugin.createStreamFn.
 * The payload builder and SSE parser are adapted from OpenClaw's google transport
 * (extensions/google/transport-stream.ts).
 */

// @mariozechner/pi-ai is OpenClaw's internal core package and is NOT part of
// the public plugin SDK surface. External plugins must not import from it —
// the package is not in the plugin's own node_modules and cannot be resolved
// from a sibling directory at runtime. All types and helpers are replaced with
// self-contained equivalents below so this transport depends only on
// openclaw/plugin-sdk/* subpaths.
import { createProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import {
  buildGuardedModelFetch,
  coerceTransportToolCallArguments,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeTransportPayloadText,
  stripSystemPromptCacheBoundary,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { normalizeZenmuxGoogleModelId } from "./zenmux-models.js";

// ---------------------------------------------------------------------------
// Self-contained helpers (replacing @mariozechner/pi-ai imports)
// ---------------------------------------------------------------------------

/** Minimal model shape used by this transport. Typed to match pi-ai's Model<string>. */
type ZenmuxGeminiModel = {
  id: string;
  provider: string;
  api: string;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  [key: string]: unknown;
};

/** Minimal message content block shapes used in context messages. */
type ZenmuxMsgBlock = { type: string; [key: string]: unknown };

/** Minimal context shape used by this transport. Typed to match pi-ai's Context. */
type ZenmuxGeminiContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: Array<any>;
  systemPrompt?: string;
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
};

/** Usage cost structure returned by createEmptyTransportUsage. */
type ZenmuxUsageCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

/**
 * Inline equivalent of pi-ai's calculateCost.
 * Mutates usage.cost in place (same contract as the original).
 */
function calculateCostInline(
  model: ZenmuxGeminiModel,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: ZenmuxUsageCost },
): ZenmuxUsageCost {
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = 0;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ZENMUX_GEMINI_BASE_URL = "https://zenmux.ai/api/vertex-ai/v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Minimal stand-in for the pi-ai SimpleStreamOptions fields this transport uses.
// Typed as an interface so the intersection below stays clean.
interface ZenmuxGeminiStreamOptions {
  apiKey?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  reasoning?: { enabled?: boolean; budgetTokens?: number; level?: string };
  thinking?: { enabled?: boolean; budgetTokens?: number; level?: string };
  onPayload?: unknown;
  headers?: Record<string, string>;
  cachedContent?: string;
}

type GoogleTransportOptions = ZenmuxGeminiStreamOptions & {
  apiKey?: string;
  cachedContent?: string;
  headers?: Record<string, string>;
  onPayload?: (
    params: GoogleGenerateContentRequest,
    model: ZenmuxGeminiModel,
  ) => Promise<unknown> | unknown;
};

type GoogleGenerateContentRequest = {
  cachedContent?: string;
  contents: Array<Record<string, unknown>>;
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
};

type GoogleTransportContentBlock =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    };

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<GoogleTransportContentBlock>;
  api: string;
  provider: string;
  model: string;
  usage: ReturnType<typeof createEmptyTransportUsage>;
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
};

type GoogleSseChunk = {
  responseId?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        thoughtSignature?: string;
        functionCall?: {
          id?: string;
          name?: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let toolCallCounter = 0;
const GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP = "skip_thought_signature_validator";

function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) return incoming;
  return existing;
}

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requiresToolCallThoughtSignature(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(normalizeZenmuxGoogleModelId(modelId)).includes("gemini-3");
}

function stableStringifyGoogleToolCallValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyGoogleToolCallValue(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringifyGoogleToolCallValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isJsonLikeThoughtSignature(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.includes('":') ||
    trimmed.includes('","') ||
    trimmed.includes('"type"')
  );
}

const GEMINI_THOUGHT_SIGNATURE_ELLIPSIS_RE = /[\u2026]|\.\.\./;
const GEMINI_THOUGHT_SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function hasGeminiThoughtSignatureTruncationFootprint(value: string): boolean {
  return (
    GEMINI_THOUGHT_SIGNATURE_ELLIPSIS_RE.test(value) ||
    (GEMINI_THOUGHT_SIGNATURE_BASE64_RE.test(value) && value.length % 4 !== 0)
  );
}

function sanitizeGeminiThoughtSignature(
  thoughtSignature: string | undefined,
): string | undefined {
  if (typeof thoughtSignature !== "string") {
    return undefined;
  }
  const trimmed = thoughtSignature.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isJsonLikeThoughtSignature(trimmed)) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (
    lowered === "reasoning" ||
    lowered === normalizeLowercaseStringOrEmpty(GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP)
  ) {
    return undefined;
  }
  if (hasGeminiThoughtSignatureTruncationFootprint(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isSameZenmuxGeminiRoute(
  source: { api?: string; provider?: string; model?: string },
  model: ZenmuxGeminiModel,
): boolean {
  return (
    source.provider === model.provider &&
    source.api === "google-generative-ai" &&
    model.api === "google-generative-ai" &&
    source.model === model.id
  );
}

function toolCallThoughtSignatureReplayKey(block: {
  id: string;
  name: string;
  arguments: unknown;
}): string {
  return [
    block.id,
    block.name,
    stableStringifyGoogleToolCallValue(coerceTransportToolCallArguments(block.arguments)),
  ].join("\u0000");
}

function mapStopReason(reason: string): "stop" | "length" | "error" {
  switch (reason.toUpperCase()) {
    case "STOP":
    case "FINISH_REASON_STOP":
      return "stop";
    case "MAX_TOKENS":
    case "FINISH_REASON_MAX_TOKENS":
      return "length";
    default:
      return "error";
  }
}

export function buildZenmuxGeminiUrl(modelId: string): string {
  // Zenmux's bare-vertex endpoint already pins publisher=google, so the
  // model segment must be the bare id (e.g. "gemini-3.1-flash-lite-preview").
  // OpenClaw model refs arrive as "google/<id>" — strip the publisher prefix
  // before URL-encoding. Live-probe evidence 2026-05-08: the prefixed form
  // returns 404 invalid_model; the stripped form returns 200.
  const normalized = normalizeZenmuxGoogleModelId(modelId);
  const bare = normalized.startsWith("google/") ? normalized.slice("google/".length) : normalized;
  const encoded = encodeURIComponent(bare);
  return `${ZENMUX_GEMINI_BASE_URL}/publishers/google/models/${encoded}:streamGenerateContent?alt=sse`;
}

function buildZenmuxGeminiHeaders(
  apiKey: string | undefined,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const authHeader: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};
  return (
    mergeTransportHeaders(
      { "Content-Type": "application/json", accept: "text/event-stream" },
      authHeader,
      extraHeaders,
    ) ?? { "Content-Type": "application/json", accept: "text/event-stream" }
  );
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

function buildZenmuxGeminiPayload(
  model: ZenmuxGeminiModel,
  context: ZenmuxGeminiContext,
  options: GoogleTransportOptions | undefined,
): GoogleGenerateContentRequest {
  const generationConfig: Record<string, unknown> = {};
  if (typeof options?.temperature === "number") {
    generationConfig.temperature = options.temperature;
  }
  if (typeof options?.maxTokens === "number") {
    generationConfig.maxOutputTokens = options.maxTokens;
  }

  // Thinking config
  if (options?.thinking?.enabled !== false) {
    const level = options?.thinking?.level?.trim();
    if (level === "adaptive") {
      // Omit thinkingLevel — Google chooses dynamically
      generationConfig.thinkingConfig = { includeThoughts: true };
    } else if (level) {
      generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
    } else if (typeof options?.thinking?.budgetTokens === "number") {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: options.thinking.budgetTokens,
      };
    }
  }

  const contents: Array<Record<string, unknown>> = [];
  const replayToolCallThoughtSignatures = new Map<string, string>();
  const shouldReplayToolCallThoughtSignature = requiresToolCallThoughtSignature(model.id);

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: sanitizeTransportPayloadText(msg.content) || " " }],
        });
        continue;
      }
      const parts = (msg.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>)
        .map((item) =>
          item.type === "text"
            ? { text: sanitizeTransportPayloadText(item.text ?? "") || " " }
            : { inlineData: { mimeType: item.mimeType, data: item.data } },
        )
        .filter((item) => model.input.includes("image") || !("inlineData" in item));
      contents.push({ role: "user", parts: parts.length > 0 ? parts : [{ text: " " }] });
      continue;
    }

    if (msg.role === "assistant") {
      const isSameRoute = isSameZenmuxGeminiRoute(msg, model);
      const parts: Array<Record<string, unknown>> = [];
      const nextReplayToolCallThoughtSignatures = new Map<string, string>();
      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text.trim()) continue;
          const sanitizedTextSignature = isSameRoute
            ? sanitizeGeminiThoughtSignature((block as { textSignature?: string }).textSignature)
            : undefined;
          parts.push({
            text: sanitizeTransportPayloadText(block.text),
            ...(sanitizedTextSignature ? { thoughtSignature: sanitizedTextSignature } : {}),
          });
          continue;
        }
        if (block.type === "thinking") {
          const thinkBlock = block as { thinking: string; thinkingSignature?: string };
          if (!thinkBlock.thinking.trim()) continue;
          if (isSameRoute) {
            const sanitizedThinkingSignature = sanitizeGeminiThoughtSignature(
              thinkBlock.thinkingSignature,
            );
            parts.push({
              thought: true,
              text: sanitizeTransportPayloadText(thinkBlock.thinking),
              ...(sanitizedThinkingSignature
                ? { thoughtSignature: sanitizedThinkingSignature }
                : {}),
            });
          } else {
            parts.push({ text: sanitizeTransportPayloadText(thinkBlock.thinking) });
          }
          continue;
        }
        if (block.type === "toolCall") {
          const tcBlock = block as { id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string };
          const replayKey = toolCallThoughtSignatureReplayKey(tcBlock);
          const replayedThoughtSignature =
            shouldReplayToolCallThoughtSignature && isSameRoute
              ? replayToolCallThoughtSignatures.get(replayKey)
              : undefined;
          // Use a block's own same-route signature first; otherwise fall back
          // to a same-route replayed value from already-converted context.
          // Never replay signatures from foreign providers; Gemini requires
          // its own signatures returned exactly as issued.
          const ownSignature = isSameRoute
            ? sanitizeGeminiThoughtSignature(tcBlock.thoughtSignature)
            : undefined;
          if (ownSignature) {
            nextReplayToolCallThoughtSignatures.set(replayKey, ownSignature);
          }
          const thoughtSignature =
            ownSignature ??
            replayedThoughtSignature ??
            (shouldReplayToolCallThoughtSignature
              ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP
              : undefined);
          parts.push({
            functionCall: {
              name: tcBlock.name,
              args: coerceTransportToolCallArguments(tcBlock.arguments),
            },
            ...(thoughtSignature ? { thoughtSignature } : {}),
          });
        }
      }
      for (const [key, signature] of nextReplayToolCallThoughtSignatures) {
        replayToolCallThoughtSignatures.set(key, signature);
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "toolResult") {
      const trMsg = msg as typeof msg & { toolName: string };
      const textResult = trMsg.content
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((item: any) => item.type === "text")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((item: any) => item.text ?? "")
        .join("\n");
      const functionResponse = {
        functionResponse: {
          name: trMsg.toolName,
          response: trMsg.isError ? { error: textResult } : { output: textResult },
        },
      };
      const last = contents[contents.length - 1];
      if (
        last?.role === "user" &&
        Array.isArray(last.parts) &&
        (last.parts as Array<Record<string, unknown>>).some((p) => "functionResponse" in p)
      ) {
        (last.parts as Array<Record<string, unknown>>).push(functionResponse);
      } else {
        contents.push({ role: "user", parts: [functionResponse] });
      }
    }
  }

  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: " " }] });

  const params: GoogleGenerateContentRequest = { contents };

  if (typeof options?.cachedContent === "string" && options.cachedContent.trim()) {
    params.cachedContent = options.cachedContent.trim();
  }
  if (Object.keys(generationConfig).length > 0) {
    params.generationConfig = generationConfig;
  }
  if (context.systemPrompt) {
    params.systemInstruction = {
      parts: [
        {
          text: sanitizeTransportPayloadText(
            stripSystemPromptCacheBreadary(context.systemPrompt),
          ),
        },
      ],
    };
  }
  if (context.tools?.length) {
    params.tools = [
      {
        functionDeclarations: context.tools.map((tool: { name: string; description: string; parameters: unknown }) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })),
      },
    ];
  }
  return params;
}

// Typo guard — we use the SDK export name
function stripSystemPromptCacheBreadary(text: string): string {
  return stripSystemPromptCacheBoundary(text);
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

async function* parseZenmuxGeminiSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<GoogleSseChunk> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abortHandler = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abortHandler);
  // Bug fixes (2026-05-08):
  // 1. pendingData hoisted outside the while loop — if a `data:` line and its
  //    blank-line terminator arrive in separate read() cycles the event was
  //    silently dropped.
  // 2. Buffer flushed after stream end — the final SSE frame's blank-line
  //    terminator is consumed by lines.pop(); without an explicit flush the
  //    tail chunk (often usage metadata or [DONE]) was discarded.
  let pendingData = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          pendingData = line.slice(6).trim();
        } else if (line.trim() === "" && pendingData) {
          if (pendingData === "[DONE]") return;
          try {
            yield JSON.parse(pendingData) as GoogleSseChunk;
          } catch {
            // malformed chunk — skip
          }
          pendingData = "";
        }
      }
    }
    // Flush any trailing data left after stream end. Two cases:
    // a) buffer holds a `data: {...}` line whose blank-line terminator never arrived
    // b) pendingData was set but the blank-line terminator came in a separate
    //    chunk that turned out to be the final read (loop broke before processing it)
    const bufferTail = buffer.trim();
    const rawTail = bufferTail.startsWith("data: ")
      ? bufferTail.slice(6).trim()
      : bufferTail;
    const tail = rawTail || pendingData;
    if (tail && tail !== "[DONE]") {
      try {
        yield JSON.parse(tail) as GoogleSseChunk;
      } catch {
        // malformed tail — skip
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}

// ---------------------------------------------------------------------------
// StreamFn factory
// ---------------------------------------------------------------------------

// Typed as returning `unknown` to avoid the dual-path @mariozechner/pi-agent-core
// StreamFn type mismatch between the plugin's node_modules and openclaw's node_modules.
// The call site in index.ts casts this to StreamFn via `as never`.
export function createZenmuxGeminiTransportStreamFn(): unknown {
  return (rawModel: unknown, context: unknown, rawOptions: unknown) => {
    const model = rawModel as ZenmuxGeminiModel;
    const ctx = context as ZenmuxGeminiContext;
    const options = rawOptions as GoogleTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();

    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant",
        content: [],
        api: "google-generative-ai",
        provider: model.provider,
        model: model.id,
        usage: createEmptyTransportUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey =
          options?.apiKey ??
          // No pi-ai getEnvApiKey — use the plugin-specific env var directly.
          // Zenmux uses a single key for all providers.
          process.env["ZENMUX_API_KEY"] ??
          undefined;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const guardedFetch = buildGuardedModelFetch(model as any);
        let params = buildZenmuxGeminiPayload(model, ctx, options);
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as GoogleGenerateContentRequest;
        }

        const url = buildZenmuxGeminiUrl(model.id);
        const headers = buildZenmuxGeminiHeaders(apiKey, options?.headers);

        const response = await guardedFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(params),
          signal: options?.signal,
        });

        if (!response.ok) {
          throw await createProviderHttpError(response, "Zenmux Gemini API error");
        }

        // Bug fix (2026-05-08): delay stream.push({ type: "start" }) until the
        // first SSE chunk arrives. Pushing "start" immediately on HTTP 200
        // signals stream liveness before any body data flows — if Zenmux stalls
        // after sending headers the stream appears healthy to OpenClaw and the
        // fallback never triggers; the only exit is a full timeout (the #79333
        // symptom). Deferring to first-chunk gives OpenClaw a chance to detect
        // the no-data stall via its own signal/timeout path.
        let streamStarted = false;
        let currentBlockIndex = -1;

        const pushBlockEnd = (idx: number) => {
          const block = output.content[idx];
          if (!block) return;
          if (block.type === "thinking") {
            stream.push({ type: "thinking_end", contentIndex: idx, partial: output as never });
          } else if (block.type === "text") {
            stream.push({ type: "text_end", contentIndex: idx, partial: output as never });
          }
        };

        for await (const chunk of parseZenmuxGeminiSse(response, options?.signal)) {
          if (!streamStarted) {
            stream.push({ type: "start", partial: output as never });
            streamStarted = true;
          }
          output.responseId ||= chunk.responseId;

          const meta = chunk.usageMetadata;
          if (meta) {
            const inputTokens = meta.promptTokenCount ?? output.usage.input;
            const outputTokens =
              ((meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0)) ||
              (meta.candidatesTokenCount ?? output.usage.output);
            const cacheRead = meta.cachedContentTokenCount ?? output.usage.cacheRead;
            output.usage.input = inputTokens;
            output.usage.output = outputTokens;
            output.usage.cacheRead = cacheRead;
            output.usage.totalTokens =
              meta.totalTokenCount ?? inputTokens + outputTokens;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            output.usage.cost = calculateCostInline(model, output.usage as any);
          }

          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              const hasThoughtSig =
                typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0;
              const hasText = typeof part.text === "string";

              if (hasText || (hasThoughtSig && !part.functionCall)) {
                if (hasThoughtSig && !hasText && part.thought !== true) {
                  const latestBlock = output.content[output.content.length - 1];
                  if (latestBlock?.type === "toolCall") {
                    latestBlock.thoughtSignature = retainThoughtSignature(
                      latestBlock.thoughtSignature,
                      part.thoughtSignature,
                    );
                    continue;
                  }
                }
                const isThinking = part.thought === true || !hasText;
                const currentBlock = output.content[currentBlockIndex];

                if (
                  currentBlockIndex < 0 ||
                  !currentBlock ||
                  (isThinking && currentBlock.type !== "thinking") ||
                  (!isThinking && currentBlock.type !== "text")
                ) {
                  if (currentBlockIndex >= 0) pushBlockEnd(currentBlockIndex);

                  if (isThinking) {
                    output.content.push({ type: "thinking", thinking: "" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      type: "thinking_start",
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                    });
                  } else {
                    output.content.push({ type: "text", text: "" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      type: "text_start",
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                    });
                  }
                }

                const activeBlock = output.content[currentBlockIndex];
                if (activeBlock?.type === "thinking") {
                  const delta = hasText ? (part.text ?? "") : "";
                  activeBlock.thinking += delta;
                  activeBlock.thinkingSignature = retainThoughtSignature(
                    activeBlock.thinkingSignature,
                    part.thoughtSignature,
                  );
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: currentBlockIndex,
                    delta,
                    partial: output as never,
                  });
                } else if (activeBlock?.type === "text") {
                  activeBlock.text += part.text ?? "";
                  activeBlock.textSignature = retainThoughtSignature(
                    activeBlock.textSignature,
                    part.thoughtSignature,
                  );
                  stream.push({
                    type: "text_delta",
                    contentIndex: currentBlockIndex,
                    delta: part.text ?? "",
                    partial: output as never,
                  });
                }
              }

              if (part.functionCall) {
                if (currentBlockIndex >= 0) {
                  pushBlockEnd(currentBlockIndex);
                  currentBlockIndex = -1;
                }
                const providedId = part.functionCall.id;
                const isDup = output.content.some(
                  (b) => b.type === "toolCall" && b.id === providedId,
                );
                const existingToolCall =
                  typeof providedId === "string"
                    ? output.content.find(
                        (
                          b,
                        ): b is Extract<GoogleTransportContentBlock, { type: "toolCall" }> =>
                          b.type === "toolCall" && b.id === providedId,
                      )
                    : undefined;
                const toolCallId =
                  providedId && !isDup
                    ? providedId
                    : `${part.functionCall.name ?? "tool"}_${Date.now()}_${++toolCallCounter}`;
                const toolCall: GoogleTransportContentBlock = {
                  type: "toolCall",
                  id: toolCallId,
                  name: part.functionCall.name ?? "",
                  arguments: part.functionCall.args ?? {},
                  thoughtSignature: retainThoughtSignature(
                    existingToolCall?.thoughtSignature,
                    part.thoughtSignature,
                  ),
                };
                output.content.push(toolCall);
                const blockIndex = output.content.length - 1;
                stream.push({
                  type: "toolcall_start",
                  contentIndex: blockIndex,
                  partial: output as never,
                });
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: blockIndex,
                  delta: JSON.stringify(toolCall.arguments),
                  partial: output as never,
                });
                stream.push({
                  type: "toolcall_end",
                  contentIndex: blockIndex,
                  toolCall,
                  partial: output as never,
                });
              }
            }
          }

          if (typeof candidate?.finishReason === "string") {
            output.stopReason = mapStopReason(candidate.finishReason);
            if (output.content.some((b) => b.type === "toolCall")) {
              output.stopReason = "toolUse";
            }
          }
        }

        if (currentBlockIndex >= 0) pushBlockEnd(currentBlockIndex);
        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error) {
        failTransportStream({ stream, output, signal: options?.signal, error });
      }
    })();

    return eventStream as unknown;
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Exported for unit tests only. */
export async function _parseZenmuxGeminiSseForTesting(
  chunks: string[],
): Promise<GoogleSseChunk[]> {
  const encoder = new TextEncoder();
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < chunks.length) {
        controller.enqueue(encoder.encode(chunks[offset++]));
      } else {
        controller.close();
      }
    },
  });
  const response = new Response(stream);
  const results: GoogleSseChunk[] = [];
  for await (const chunk of parseZenmuxGeminiSse(response)) {
    results.push(chunk);
  }
  return results;
}

/** @internal Exported for unit tests only. */
export function _buildZenmuxGeminiPayloadForTesting(
  model: unknown,
  context: unknown,
  options?: unknown,
): GoogleGenerateContentRequest {
  return buildZenmuxGeminiPayload(
    model as ZenmuxGeminiModel,
    context as ZenmuxGeminiContext,
    options as GoogleTransportOptions | undefined,
  );
}

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

// We intentionally do NOT import StreamFn from @mariozechner/pi-agent-core here.
// The plugin resolves that package through the openclaw devdep path; importing it
// directly causes a duplicate-module type mismatch with the openclaw SDK types.
// Instead we type createStreamFn's return as `unknown` at the call-site cast.

import {
  calculateCost,
  getEnvApiKey,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ZENMUX_GEMINI_BASE_URL = "https://zenmux.ai/api/vertex-ai/v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoogleTransportOptions = SimpleStreamOptions & {
  apiKey?: string;
  cachedContent?: string;
  headers?: Record<string, string>;
  onPayload?: (
    params: GoogleGenerateContentRequest,
    model: Model<string>,
  ) => Promise<unknown> | unknown;
  thinking?: {
    enabled?: boolean;
    budgetTokens?: number;
    level?: string;
  };
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

function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (incoming) return incoming;
  return existing;
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
  const bare = modelId.startsWith("google/") ? modelId.slice("google/".length) : modelId;
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
  model: Model<string>,
  context: Context,
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
      const isSameModel = msg.provider === model.provider && msg.model === model.id;
      const parts: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text.trim()) continue;
          parts.push({
            text: sanitizeTransportPayloadText(block.text),
            ...(isSameModel && (block as { textSignature?: string }).textSignature
              ? { thoughtSignature: (block as { textSignature?: string }).textSignature }
              : {}),
          });
          continue;
        }
        if (block.type === "thinking") {
          const thinkBlock = block as { thinking: string; thinkingSignature?: string };
          if (!thinkBlock.thinking.trim()) continue;
          if (isSameModel) {
            parts.push({
              thought: true,
              text: sanitizeTransportPayloadText(thinkBlock.thinking),
              ...(thinkBlock.thinkingSignature
                ? { thoughtSignature: thinkBlock.thinkingSignature }
                : {}),
            });
          } else {
            parts.push({ text: sanitizeTransportPayloadText(thinkBlock.thinking) });
          }
          continue;
        }
        if (block.type === "toolCall") {
          const tcBlock = block as { id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string };
          parts.push({
            functionCall: {
              name: tcBlock.name,
              args: coerceTransportToolCallArguments(tcBlock.arguments),
            },
            ...(isSameModel && tcBlock.thoughtSignature
              ? { thoughtSignature: tcBlock.thoughtSignature }
              : {}),
          });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "toolResult") {
      const trMsg = msg as {
        toolName: string;
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      const textResult = trMsg.content
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
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
        functionDeclarations: context.tools.map((tool) => ({
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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let pendingData = "";
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
    const model = rawModel as Model<string>;
    const ctx = context as Context;
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
          getEnvApiKey(model.provider) ??
          process.env["ZENMUX_API_KEY"] ??
          undefined;

        const guardedFetch = buildGuardedModelFetch(model);
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

        stream.push({ type: "start", partial: output as never });

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
            output.usage.cost = calculateCost(model, output.usage);
          }

          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              const hasThoughtSig =
                typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0;
              const hasText = typeof part.text === "string";

              if (hasText || (hasThoughtSig && !part.functionCall)) {
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
                const toolCallId =
                  providedId && !isDup
                    ? providedId
                    : `${part.functionCall.name ?? "tool"}_${Date.now()}_${++toolCallCounter}`;
                const toolCall: GoogleTransportContentBlock = {
                  type: "toolCall",
                  id: toolCallId,
                  name: part.functionCall.name ?? "",
                  arguments: part.functionCall.args ?? {},
                  thoughtSignature: part.thoughtSignature,
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

import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationSourceImage,
} from "openclaw/plugin-sdk/image-generation";
import {
  generatedImageAssetFromBase64,
  generatedImageAssetFromDataUrl,
  imageSourceUploadFileName,
  parseOpenAiCompatibleImageResponse,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ZENMUX_OPENAI_BASE_URL } from "./constants.js";

const ZENMUX_IMAGE_PROVIDER_ID = "zenmux";
const ZENMUX_OPENAI_IMAGE_ALIAS = "zenmux-openai";
const DEFAULT_ZENMUX_IMAGE_MODEL = "openai/gpt-image-2";
const DEFAULT_ZENMUX_IMAGE_TIMEOUT_MS = 300_000;
const DEFAULT_ZENMUX_IMAGE_SIZE = "1024x1024";
const MAX_ZENMUX_IMAGE_RESULTS = 4;
const MAX_ZENMUX_INPUT_IMAGES = 5;
const ZENMUX_IMAGE_FILE_PREFIX = "zenmux-image";
const ZENMUX_SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const ZENMUX_IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const ZENMUX_IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
const ZENMUX_IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const ZENMUX_IMAGE_MODELS = [
  DEFAULT_ZENMUX_IMAGE_MODEL,
  "openai/gpt-image-1.5",
  "openai/gpt-image-1",
  "openai/gpt-image-1-mini",
] as const;

type ZenmuxImageResponseEntry = {
  b64_json?: unknown;
  b64Json?: unknown;
  image_base64?: unknown;
  base64?: unknown;
  data?: unknown;
  url?: unknown;
  image_url?: unknown;
  imageUrl?: unknown;
  mime_type?: unknown;
  mimeType?: unknown;
  revised_prompt?: unknown;
  revisedPrompt?: unknown;
};

type ZenmuxImageResponsePayload = {
  data?: unknown;
  images?: unknown;
  image?: unknown;
  b64_json?: unknown;
  b64Json?: unknown;
  url?: unknown;
  output?: unknown;
};

function resolveImageCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return 1;
  }
  return Math.max(1, Math.min(MAX_ZENMUX_IMAGE_RESULTS, Math.trunc(count)));
}

function normalizeZenmuxImageModel(model: string | undefined): string {
  return normalizeOptionalString(model) ?? DEFAULT_ZENMUX_IMAGE_MODEL;
}

function appendZenmuxImageOptions(
  target: Record<string, unknown> | FormData,
  req: ImageGenerationRequest,
): void {
  const openai = req.providerOptions?.openai;
  const background = openai?.background ?? req.background;
  const entries: Record<string, unknown> = {
    ...(req.quality !== undefined ? { quality: req.quality } : {}),
    ...(req.outputFormat !== undefined ? { output_format: req.outputFormat } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(openai?.moderation !== undefined ? { moderation: openai.moderation } : {}),
    ...(openai?.outputCompression !== undefined
      ? { output_compression: openai.outputCompression }
      : {}),
    ...(openai?.user !== undefined ? { user: openai.user } : {}),
  };
  for (const [key, value] of Object.entries(entries)) {
    if (target instanceof FormData) {
      target.set(key, String(value));
    } else {
      target[key] = value;
    }
  }
}

function buildGenerateBody(req: ImageGenerationRequest, model: string, count: number) {
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    n: count,
    size: req.size ?? DEFAULT_ZENMUX_IMAGE_SIZE,
  };
  appendZenmuxImageOptions(body, req);
  return body;
}

function buildEditFormData(
  req: ImageGenerationRequest,
  model: string,
  count: number,
  inputImages: ImageGenerationSourceImage[],
): FormData {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", req.prompt);
  form.set("n", String(count));
  form.set("size", req.size ?? DEFAULT_ZENMUX_IMAGE_SIZE);
  appendZenmuxImageOptions(form, req);
  for (const [index, image] of inputImages.entries()) {
    const blob = new Blob([new Uint8Array(image.buffer)], {
      type: image.mimeType || "application/octet-stream",
    });
    form.append(
      "image[]",
      blob,
      imageSourceUploadFileName({
        image,
        index,
        fileNamePrefix: "zenmux-input",
      }),
    );
  }
  return form;
}

function normalizeImageUrl(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return normalizeImageUrl(record.url);
}

function pushBase64Image(
  images: GeneratedImageAsset[],
  base64: unknown,
  entry?: ZenmuxImageResponseEntry,
): void {
  if (typeof base64 !== "string") {
    return;
  }
  const image = generatedImageAssetFromBase64({
    base64,
    index: images.length,
    mimeType: normalizeOptionalString(entry?.mime_type) ?? normalizeOptionalString(entry?.mimeType),
    revisedPrompt:
      normalizeOptionalString(entry?.revised_prompt) ?? normalizeOptionalString(entry?.revisedPrompt),
    fileNamePrefix: ZENMUX_IMAGE_FILE_PREFIX,
    sniffMimeType: true,
  });
  if (image) {
    images.push(image);
  }
}

async function pushUrlImage(images: GeneratedImageAsset[], url: string): Promise<void> {
  if (url.startsWith("data:image/")) {
    const image = generatedImageAssetFromDataUrl({
      dataUrl: url,
      index: images.length,
      fileNamePrefix: ZENMUX_IMAGE_FILE_PREFIX,
    });
    if (image) {
      images.push(image);
    }
    return;
  }

  const response = await fetch(url);
  await assertOkOrThrowHttpError(response, "ZenMux image generation result download failed");
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  images.push({
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType,
    fileName: `${ZENMUX_IMAGE_FILE_PREFIX}-${images.length + 1}`,
  });
}

async function collectZenmuxEntryImages(
  images: GeneratedImageAsset[],
  entry: ZenmuxImageResponseEntry,
): Promise<void> {
  pushBase64Image(
    images,
    entry.b64_json ?? entry.b64Json ?? entry.image_base64 ?? entry.base64 ?? entry.data,
    entry,
  );
  const url = normalizeImageUrl(entry.url ?? entry.image_url ?? entry.imageUrl);
  if (url) {
    await pushUrlImage(images, url);
  }
}

async function parseZenmuxImageResponse(
  payload: ZenmuxImageResponsePayload,
): Promise<GeneratedImageAsset[]> {
  const openAiImages = parseOpenAiCompatibleImageResponse(payload as never, {
    fileNamePrefix: ZENMUX_IMAGE_FILE_PREFIX,
    sniffMimeType: true,
  });
  if (openAiImages.length > 0) {
    return openAiImages;
  }

  const images: GeneratedImageAsset[] = [];
  const candidates = [payload.data, payload.images, payload.image, payload.output].filter(
    (value) => value !== undefined,
  );
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (entry && typeof entry === "object") {
          await collectZenmuxEntryImages(images, entry as ZenmuxImageResponseEntry);
        } else if (typeof entry === "string") {
          if (entry.startsWith("data:image/")) {
            await pushUrlImage(images, entry);
          } else {
            pushBase64Image(images, entry);
          }
        }
      }
      continue;
    }
    if (candidate && typeof candidate === "object") {
      await collectZenmuxEntryImages(images, candidate as ZenmuxImageResponseEntry);
    } else if (typeof candidate === "string") {
      if (candidate.startsWith("data:image/")) {
        await pushUrlImage(images, candidate);
      } else {
        pushBase64Image(images, candidate);
      }
    }
  }
  pushBase64Image(images, payload.b64_json ?? payload.b64Json);
  const url = normalizeImageUrl(payload.url);
  if (url) {
    await pushUrlImage(images, url);
  }
  return images;
}

function resolveZenmuxImageUrl(baseUrl: string, hasInputImages: boolean): string {
  return `${baseUrl.replace(/\/+$/u, "")}/images/${hasInputImages ? "edits" : "generations"}`;
}

export function buildZenmuxImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: ZENMUX_IMAGE_PROVIDER_ID,
    aliases: [ZENMUX_OPENAI_IMAGE_ALIAS],
    label: "ZenMux Images",
    defaultModel: DEFAULT_ZENMUX_IMAGE_MODEL,
    models: [...ZENMUX_IMAGE_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({ provider: ZENMUX_IMAGE_PROVIDER_ID, agentDir }),
    capabilities: {
      generate: {
        maxCount: MAX_ZENMUX_IMAGE_RESULTS,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: MAX_ZENMUX_IMAGE_RESULTS,
        maxInputImages: MAX_ZENMUX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...ZENMUX_SUPPORTED_SIZES],
      },
      output: {
        qualities: [...ZENMUX_IMAGE_QUALITIES],
        formats: [...ZENMUX_IMAGE_OUTPUT_FORMATS],
        backgrounds: [...ZENMUX_IMAGE_BACKGROUNDS],
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: ZENMUX_IMAGE_PROVIDER_ID,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("ZenMux API key missing");
      }

      const providerConfig =
        req.cfg?.models?.providers?.[req.provider] ??
        req.cfg?.models?.providers?.[ZENMUX_IMAGE_PROVIDER_ID];
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: normalizeOptionalString(providerConfig?.baseUrl),
          defaultBaseUrl: ZENMUX_OPENAI_BASE_URL,
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
          allowPrivateNetwork: true,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: ZENMUX_IMAGE_PROVIDER_ID,
          capability: "image",
          transport: "http",
        });

      const inputImages = req.inputImages ?? [];
      if (inputImages.length > MAX_ZENMUX_INPUT_IMAGES) {
        throw new Error(
          `ZenMux image editing supports up to ${MAX_ZENMUX_INPUT_IMAGES} reference images.`,
        );
      }
      const model = normalizeZenmuxImageModel(req.model);
      const count = resolveImageCount(req.count);
      const timeoutMs = req.timeoutMs ?? DEFAULT_ZENMUX_IMAGE_TIMEOUT_MS;
      const url = resolveZenmuxImageUrl(baseUrl, inputImages.length > 0);
      const request =
        inputImages.length > 0
          ? postMultipartRequest({
              url,
              headers: (() => {
                const multipartHeaders = new Headers(headers);
                multipartHeaders.delete("Content-Type");
                return multipartHeaders;
              })(),
              body: buildEditFormData(req, model, count, inputImages),
              timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              dispatcherPolicy,
            })
          : postJsonRequest({
              url,
              headers: (() => {
                const jsonHeaders = new Headers(headers);
                jsonHeaders.set("Content-Type", "application/json");
                return jsonHeaders;
              })(),
              body: buildGenerateBody(req, model, count),
              timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              dispatcherPolicy,
            });

      const { response, release } = await request;
      try {
        await assertOkOrThrowHttpError(response, "ZenMux image generation failed");
        const payload = (await response.json()) as ZenmuxImageResponsePayload;
        const images = await parseZenmuxImageResponse(payload);
        if (images.length === 0) {
          throw new Error("ZenMux image generation response missing image data");
        }
        return { images, model };
      } finally {
        await release();
      }
    },
  };
}

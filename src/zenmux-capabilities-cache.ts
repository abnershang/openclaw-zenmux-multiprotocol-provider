// Singleton in-memory + disk cache of ZenMux model capabilities.
//
// Mirrors the canonical openclaw bundled-provider pattern (see
// extensions/openrouter): the catalog stays small and curated, and per-model
// capabilities for any zenmux/<id> are resolved on demand via this cache,
// with a single-flight network fetch against https://zenmux.ai/api/v1/models
// and a disk-persisted snapshot that survives gateway restarts.
//
// The cache is shared across all four registered provider ids (zenmux-openai,
// zenmux-anthropic, zenmux-vertex, zenmux) because model IDs are upstream-
// scoped, not provider-scoped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const ZENMUX_MODELS_URL = "https://zenmux.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 10_000;
const DISK_CACHE_FILENAME = "zenmux-models.json";
const ZENMUX_DEFAULT_CONTEXT_WINDOW = 200_000;
const ZENMUX_DEFAULT_MAX_TOKENS = 8192;
const ZENMUX_DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type ZenmuxModelCapabilities = {
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

type PricingTier = Array<{ value: number }>;

type ZenmuxApiModel = {
  id: string;
  display_name?: string;
  input_modalities?: string[];
  capabilities?: { reasoning?: boolean };
  context_length?: number;
  pricings?: {
    prompt?: PricingTier;
    completion?: PricingTier;
    input_cache_read?: PricingTier;
    input_cache_write?: PricingTier;
    input_cache_write_5_min?: PricingTier;
    input_cache_write_1_h?: PricingTier;
  };
};

type ZenmuxModelsApiResponse = { data?: ZenmuxApiModel[] };

let cache: Map<string, ZenmuxModelCapabilities> | undefined;
let fetchInFlight: Promise<void> | undefined;
const skipNextMissRefresh = new Set<string>();

function resolveDiskCacheDir(): string {
  return join(resolveStateDir(), "cache");
}

function resolveDiskCachePath(): string {
  return join(resolveDiskCacheDir(), DISK_CACHE_FILENAME);
}

function isValidCapabilities(value: unknown): value is ZenmuxModelCapabilities {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["name"] === "string" &&
    Array.isArray(r["input"]) &&
    typeof r["reasoning"] === "boolean" &&
    typeof r["contextWindow"] === "number" &&
    typeof r["maxTokens"] === "number" &&
    r["cost"] !== null &&
    typeof r["cost"] === "object"
  );
}

function readDiskCache(): Map<string, ZenmuxModelCapabilities> | undefined {
  try {
    const path = resolveDiskCachePath();
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf-8");
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object") return undefined;
    const models = (payload as Record<string, unknown>)["models"];
    if (!models || typeof models !== "object") return undefined;
    const map = new Map<string, ZenmuxModelCapabilities>();
    for (const [id, caps] of Object.entries(models as Record<string, unknown>)) {
      if (isValidCapabilities(caps)) map.set(id, caps);
    }
    return map.size > 0 ? map : undefined;
  } catch {
    return undefined;
  }
}

function writeDiskCache(map: Map<string, ZenmuxModelCapabilities>): void {
  try {
    const dir = resolveDiskCacheDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolveDiskCachePath(),
      JSON.stringify({ models: Object.fromEntries(map) }),
      "utf-8",
    );
  } catch {
    // best-effort; ignore
  }
}

function extractCost(p: ZenmuxApiModel["pricings"]): ZenmuxModelCapabilities["cost"] {
  const get = (a?: PricingTier) => a?.[0]?.value ?? 0;
  return {
    input: get(p?.prompt),
    output: get(p?.completion),
    cacheRead: get(p?.input_cache_read),
    cacheWrite: get(
      [p?.input_cache_write, p?.input_cache_write_5_min, p?.input_cache_write_1_h].find(
        (t) => t != null && t.length > 0,
      ),
    ),
  };
}

function parseModel(model: ZenmuxApiModel): ZenmuxModelCapabilities {
  const inputModalities = model.input_modalities ?? ["text"];
  const hasImage = inputModalities.includes("image");
  return {
    name: model.display_name || model.id,
    reasoning: model.capabilities?.reasoning ?? false,
    input: hasImage ? ["text", "image"] : ["text"],
    cost: model.pricings ? extractCost(model.pricings) : { ...ZENMUX_DEFAULT_COST },
    contextWindow: model.context_length ?? ZENMUX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: ZENMUX_DEFAULT_MAX_TOKENS,
  };
}

async function doFetch(): Promise<void> {
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: ZENMUX_MODELS_URL,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      init: { headers: { Accept: "application/json" } },
      policy: { allowedHostnames: ["zenmux.ai"] },
      auditContext: "zenmux-model-discovery",
    });
    try {
      if (!response.ok) return;
      const data = (await response.json()) as ZenmuxModelsApiResponse;
      const models = data.data ?? [];
      if (models.length === 0) return;
      const map = new Map<string, ZenmuxModelCapabilities>();
      for (const m of models) map.set(m.id, parseModel(m));
      cache = map;
      writeDiskCache(map);
    } finally {
      await release();
    }
  } catch {
    // best-effort: keep whatever's already in cache
  }
}

function triggerFetch(): void {
  if (fetchInFlight) return;
  fetchInFlight = doFetch().finally(() => {
    fetchInFlight = undefined;
  });
}

function ensureZenmuxModelCache(): void {
  if (cache) return;
  const disk = readDiskCache();
  if (disk) {
    cache = disk;
    return;
  }
  triggerFetch();
}

// Ensure capabilities for a specific model are available before first use.
// Awaits at most one in-flight fetch. Called from prepareDynamicModel.
export async function loadZenmuxModelCapabilities(modelId: string): Promise<void> {
  ensureZenmuxModelCache();
  if (cache?.has(modelId)) return;
  let p = fetchInFlight;
  if (!p) {
    triggerFetch();
    p = fetchInFlight;
  }
  if (p) await p;
  if (!cache?.has(modelId)) skipNextMissRefresh.add(modelId);
}

// Synchronous cache lookup. Used from resolveDynamicModel. If the cache
// exists but the model is missing, triggers a background refresh in case
// it's a newly added model not yet in the cached snapshot.
export function getZenmuxModelCapabilities(
  modelId: string,
): ZenmuxModelCapabilities | undefined {
  ensureZenmuxModelCache();
  const result = cache?.get(modelId);
  if (!result && skipNextMissRefresh.delete(modelId)) return undefined;
  if (!result && cache && !fetchInFlight) triggerFetch();
  return result;
}

// Test-only: clear the singleton state between tests.
export function _resetCacheForTesting(): void {
  cache = undefined;
  fetchInFlight = undefined;
  skipNextMissRefresh.clear();
}

/**
 * 从中转站 GET {base}/v1/models 拉模型列表，填进 chrome_ext_models
 * 官方侧栏不走 /v1/models，但中转（OpenAI/Anthropic 兼容）通常有这个接口。
 */

const STORAGE_MODEL_CONFIG = "localCfcModelConfig";
const STORAGE_MODELS_AT = "localCfcModelsFetchedAt";
const CACHE_TTL_MS = 5 * 60 * 1000;

function isPlaceholderKey(key) {
  if (!key) return true;
  const k = String(key).trim();
  return !k || k === "sk-your-key-here" || k === "REPLACE_ME" || k.startsWith("sk-your-");
}

/** claude-sonnet-4-5-20250929 → Sonnet 4.5 */
export function displayNameFromModelId(id) {
  const s = String(id || "");
  const m = s.match(/claude-(sonnet|opus|haiku)-(\d+(?:\.\d+)?)(?:-|$)/i);
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `${family} ${m[2]}`;
  }
  // 中转自定义 id：尽量好看一点
  if (s.length <= 32) return s;
  return s.slice(0, 28) + "…";
}

function pickDefault(ids) {
  const prefer = [
    /claude-sonnet-4-5/,
    /claude-sonnet-4/,
    /sonnet/,
    /claude-opus/,
    /opus/,
    /claude-haiku/,
    /haiku/,
  ];
  for (const re of prefer) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0] || "claude-sonnet-4-5-20250929";
}

function pickSmallFast(ids, defaultId) {
  const haiku = ids.find((id) => /haiku/i.test(id));
  return haiku || defaultId || ids[0];
}

/**
 * 兼容多种中转响应：
 * - OpenAI: { data: [{ id, ... }] }
 * - Anthropic: { data: [{ id, display_name, ... }] }
 * - 裸数组: ["model-a", ...] 或 [{ id|name|model }]
 */
export function normalizeModelsResponse(json) {
  let rows = [];
  if (!json) return [];
  if (Array.isArray(json)) rows = json;
  else if (Array.isArray(json.data)) rows = json.data;
  else if (Array.isArray(json.models)) rows = json.models;
  else if (Array.isArray(json.body)) rows = json.body;
  else return [];

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    let id = "";
    let name = "";
    if (typeof row === "string") {
      id = row.trim();
    } else if (row && typeof row === "object") {
      id = String(row.id || row.model || row.name || row.model_id || "").trim();
      name = String(row.display_name || row.displayName || row.name || row.title || "").trim();
      if (name === id) name = "";
    }
    if (!id || seen.has(id)) continue;
    // 过滤明显非聊天的
    if (/embedding|whisper|tts|dall-e|moderation|rerank/i.test(id)) continue;
    seen.add(id);
    out.push({
      model: id,
      name: name || displayNameFromModelId(id),
    });
  }
  return out;
}

/** 侧栏 kz()/Po() 认的 chrome_ext_models value */
export function buildChromeExtModelsValue(options, preferredDefault) {
  const opts = Array.isArray(options) ? options.filter((o) => o && o.model) : [];
  if (!opts.length) {
    const fallback = preferredDefault || "claude-sonnet-4-5-20250929";
    return {
      default: fallback,
      options: [{ model: fallback, name: displayNameFromModelId(fallback) }],
      models: [{ model: fallback, name: displayNameFromModelId(fallback) }],
      small_fast_model: fallback,
      source: "local-cfc-fallback",
    };
  }
  const ids = opts.map((o) => o.model);
  const def =
    (preferredDefault && ids.includes(preferredDefault) && preferredDefault) ||
    pickDefault(ids);
  return {
    default: def,
    options: opts,
    models: opts,
    small_fast_model: pickSmallFast(ids, def),
    source: "local-cfc-upstream-models",
  };
}

export async function loadCachedModelConfig() {
  try {
    const data = await chrome.storage.local.get({
      [STORAGE_MODEL_CONFIG]: null,
      [STORAGE_MODELS_AT]: 0,
    });
    return {
      config: data[STORAGE_MODEL_CONFIG],
      fetchedAt: data[STORAGE_MODELS_AT] || 0,
    };
  } catch {
    return { config: null, fetchedAt: 0 };
  }
}

/**
 * @param {{ baseUrl: string, apiKey: string, force?: boolean }} opts
 * @returns {Promise<{ ok: boolean, config: object|null, error?: string, fromCache?: boolean }>}
 */
export async function fetchUpstreamModels({ baseUrl, apiKey, force = false } = {}) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/$/, "");
  const key = String(apiKey || "").trim();

  if (!base || !/^https?:\/\//i.test(base)) {
    return { ok: false, config: null, error: "no base url" };
  }
  if (isPlaceholderKey(key)) {
    return { ok: false, config: null, error: "no api key" };
  }

  if (!force) {
    const { config, fetchedAt } = await loadCachedModelConfig();
    if (
      config &&
      Array.isArray(config.options) &&
      config.options.length &&
      Date.now() - fetchedAt < CACHE_TTL_MS
    ) {
      return { ok: true, config, fromCache: true };
    }
  }

  const url = `${base}/v1/models`;
  const fetchFn = globalThis.__fetch || fetch.bind(globalThis);

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        "x-api-key": key,
        Authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[local-cfc] /v1/models", res.status, text.slice(0, 300));
      // 失败时尽量用缓存
      const { config } = await loadCachedModelConfig();
      if (config?.options?.length) {
        return { ok: true, config, fromCache: true, error: `http ${res.status}` };
      }
      return { ok: false, config: null, error: `http ${res.status}` };
    }
    const json = await res.json();
    const options = normalizeModelsResponse(json);
    if (!options.length) {
      console.warn("[local-cfc] /v1/models empty/unparsed", json);
      return { ok: false, config: null, error: "empty models list" };
    }
    const config = buildChromeExtModelsValue(options);
    await chrome.storage.local.set({
      [STORAGE_MODEL_CONFIG]: config,
      [STORAGE_MODELS_AT]: Date.now(),
    });
    console.info("[local-cfc] models from upstream", {
      url,
      count: options.length,
      default: config.default,
      sample: options.slice(0, 8).map((o) => o.model),
    });
    return { ok: true, config, fromCache: false };
  } catch (e) {
    console.warn("[local-cfc] /v1/models failed", e);
    const { config } = await loadCachedModelConfig();
    if (config?.options?.length) {
      return { ok: true, config, fromCache: true, error: String(e) };
    }
    return { ok: false, config: null, error: String(e && e.message ? e.message : e) };
  }
}

export { STORAGE_MODEL_CONFIG, STORAGE_MODELS_AT };

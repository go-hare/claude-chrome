/**
 * 本地完整 options（对齐 openclaude /api/options，但不请求云端）
 * storage key: localCfcOptions
 */

export const STORAGE_OPTIONS = "localCfcOptions";
export const STORAGE_API_KEY = "anthropicApiKey";
export const STORAGE_API_BASE = "customApiBaseUrl"; // 兼容旧字段 / 侧栏

/** 与 openclaude 默认规则对齐的本地默认值 */
export const DEFAULT_OPTIONS = {
  // api_key = 免登录；claude = 接近官方（仍可被我们的 OAuth 拦截影响）
  mode: "api_key",

  // 兼容字段：原 cfcBase。本地模式下不再指向远程站；
  // 若 proxyMode=rewrite 且填写了 proxyBase，则 proxyIncludes 走 proxyBase 前缀拼接。
  cfcBase: "",
  proxyBase: "",
  // discard | rewrite
  // discard: proxyIncludes 命中直接 204（本地默认，不依赖中转站）
  // rewrite: proxyIncludes 命中改为 proxyBase + 原完整 URL（需你有兼容反代）
  proxyMode: "discard",

  // API 根（原 anthropicBaseUrl）
  anthropicBaseUrl: "https://api.anthropic.com",

  // 只改写对话/模型 API。不要写整站 https://api.anthropic.com/，
  // 否则 /api/web/url_hash_check 等产品接口会被误打到中转 → 404。
  apiBaseIncludes: ["https://api.anthropic.com/v1/"],

  // 原 openclaude 会反代的列表；本地默认当 discard 处理
  proxyIncludes: [
    "featureassets.org",
    "assetsconfigcdn.org",
    "featuregates.org",
    "prodregistryv2.org",
    "beyondwickedmapping.org",
    "api.honeycomb.io",
    "statsigapi.net",
    "events.statsigapi.net",
    "api.statsigcdn.com",
    "*ingest.us.sentry.io",
    "https://api.anthropic.com/api/oauth/profile",
    "https://api.anthropic.com/api/bootstrap",
    "https://console.anthropic.com/v1/oauth/token",
    "https://platform.claude.com/v1/oauth/token",
    "https://api.anthropic.com/api/oauth/account",
    "https://api.anthropic.com/api/oauth/organizations",
    "https://api.anthropic.com/api/oauth/chat_conversations",
    "/api/web/domain_info/browser_extension",
    "/api/web/url_hash_check/browser_extension",
  ],

  discardIncludes: [
    "cdn.segment.com",
    "api.segment.io",
    "events.statsigapi.net",
    "api.honeycomb.io",
    "prodregistryv2.org",
    "*ingest.us.sentry.io",
    "browser-intake-us5-datadoghq.com",
    "openclaude.724111.xyz",
    "cfc.aroic.workers.dev",
  ],

  // { "claude-sonnet-4-...": "my-alias" }
  modelAlias: {},

  // 登录跳转拦截（本地固定行为，也可在配置页开关）
  blockOAuth: true,
  blockRemoteOpenclaude: true,
  noLogin: true,
};

export function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeAlias(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k && v != null && String(v).trim()) out[String(k).trim()] = String(v).trim();
    }
    return out;
  }
  if (typeof value === "string") {
    const out = {};
    for (const line of value.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const idx = s.indexOf("=>");
      const idx2 = idx === -1 ? s.indexOf("=") : idx;
      if (idx2 === -1) continue;
      const k = s.slice(0, idx2).trim();
      const v = s.slice(idx2 + (idx === -1 ? 1 : 2)).trim();
      if (k && v) out[k] = v;
    }
    return out;
  }
  return {};
}

export function normalizeOptions(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const out = {
    ...DEFAULT_OPTIONS,
    ...src,
    apiBaseIncludes: normalizeList(
      src.apiBaseIncludes ?? DEFAULT_OPTIONS.apiBaseIncludes,
    ),
    proxyIncludes: normalizeList(src.proxyIncludes ?? DEFAULT_OPTIONS.proxyIncludes),
    discardIncludes: normalizeList(
      src.discardIncludes ?? DEFAULT_OPTIONS.discardIncludes,
    ),
    modelAlias: normalizeAlias(src.modelAlias ?? DEFAULT_OPTIONS.modelAlias),
  };
  // 历史配置常含整站 https://api.anthropic.com/，会把 /api/web/* 误打中转
  out.apiBaseIncludes = out.apiBaseIncludes.filter((x) => {
    const s = String(x).trim().replace(/\/$/, "");
    return s !== "https://api.anthropic.com" && s !== "http://api.anthropic.com";
  });
  if (!out.apiBaseIncludes.length) {
    out.apiBaseIncludes = [...DEFAULT_OPTIONS.apiBaseIncludes];
  }
  // 确保 url_hash_check 始终可被 proxy/mock 命中（用户旧列表可能没有）
  if (
    !out.proxyIncludes.some((x) => String(x).includes("url_hash_check"))
  ) {
    out.proxyIncludes.push("/api/web/url_hash_check/browser_extension");
  }
  out.mode = String(out.mode || "api_key");
  out.proxyMode = out.proxyMode === "rewrite" ? "rewrite" : "discard";
  out.cfcBase = String(out.cfcBase || "").replace(/\/?$/, out.cfcBase ? "/" : "");
  out.proxyBase = String(out.proxyBase || out.cfcBase || "").replace(
    /\/?$/,
    out.proxyBase || out.cfcBase ? "/" : "",
  );
  out.anthropicBaseUrl = String(
    out.anthropicBaseUrl || DEFAULT_OPTIONS.anthropicBaseUrl,
  ).replace(/\/$/, "");
  out.blockOAuth = out.blockOAuth !== false;
  out.blockRemoteOpenclaude = out.blockRemoteOpenclaude !== false;
  out.noLogin = out.noLogin !== false;
  return out;
}

export async function loadOptionsFromStorage() {
  const data = await chrome.storage.local.get({
    [STORAGE_OPTIONS]: null,
    [STORAGE_API_BASE]: "",
    [STORAGE_API_KEY]: "",
    apiKey: "",
    ANTHROPIC_API_KEY: "",
  });
  const raw = data[STORAGE_OPTIONS] || {};
  // 兼容旧字段
  if (!raw.anthropicBaseUrl && data[STORAGE_API_BASE]) {
    raw.anthropicBaseUrl = data[STORAGE_API_BASE];
  }
  const options = normalizeOptions(raw);
  // Key：正式键优先，兼容 apiKey / ANTHROPIC_API_KEY
  let apiKey = String(data[STORAGE_API_KEY] || "").trim();
  if (isPlaceholderKey(apiKey)) {
    for (const c of [data.apiKey, data.ANTHROPIC_API_KEY]) {
      const k = String(c || "").trim();
      if (!isPlaceholderKey(k)) {
        apiKey = k;
        break;
      }
    }
  }
  return {
    options,
    apiKey,
  };
}

function isPlaceholderKey(key) {
  if (!key) return true;
  const k = String(key).trim();
  return (
    !k ||
    k === "sk-your-key-here" ||
    k === "REPLACE_ME" ||
    k.startsWith("sk-your-") ||
    k.includes("your-key-here")
  );
}

function b64url(obj) {
  const json = typeof obj === "string" ? obj : JSON.stringify(obj);
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(json)))
      : Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * 对齐原 openclaude 劫持：伪造 JWT accessToken（payload.iss === "auth"）。
 * 官方侧栏只认 storage 里的 accessToken + 能拉到 profile，不校验签名。
 */
export function makeLocalAccessToken() {
  const header = b64url({ alg: "none", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url({
    iss: "auth",
    sub: "00000000-0000-4000-8000-000000000001",
    exp: now + 86400 * 365,
    iat: now,
    type: "access",
    // 本地标记，方便识别
    local_cfc: true,
  });
  return `${header}.${payload}.local`;
}

/**
 * 写入官方认的会话字段。
 * @param {string} [apiKey] 真实 key 时一并写入 anthropicApiKey；可空，仍发 JWT 以过登录页
 * @param {{ forceToken?: boolean }} [opts]
 */
export function buildLocalAuthPatch(apiKey, opts = {}) {
  const key = String(apiKey || "").trim();
  const hasKey = !isPlaceholderKey(key);
  const forceToken = opts.forceToken !== false; // 默认即使无 key 也写 token，先过登录 UI

  if (!hasKey && !forceToken) {
    return { lastAuthFailureReason: "" };
  }

  const patch = {
    accessToken: makeLocalAccessToken(),
    refreshToken: "local-cfc-no-refresh",
    tokenExpiry: Date.now() + 86400 * 365 * 1000,
    accountUuid: "00000000-0000-4000-8000-000000000001",
    lastActiveOrgHint: "00000000-0000-4000-8000-000000000002",
    lastAuthFailureReason: "",
    oauthState: null,
    codeVerifier: null,
    preferCoworkExperience: false,
  };
  if (hasKey) {
    patch[STORAGE_API_KEY] = key;
  }
  return patch;
}

export async function saveOptionsToStorage({ options, apiKey, keepApiKeyIfEmpty = true }) {
  const normalized = normalizeOptions(options || {});
  const patch = {
    [STORAGE_OPTIONS]: normalized,
    [STORAGE_API_BASE]: normalized.anthropicBaseUrl,
  };
  if (apiKey != null && String(apiKey).trim()) {
    Object.assign(patch, buildLocalAuthPatch(apiKey));
  } else if (!keepApiKeyIfEmpty && apiKey === "") {
    patch[STORAGE_API_KEY] = "";
  } else if (keepApiKeyIfEmpty) {
    try {
      const cur = await chrome.storage.local.get({ [STORAGE_API_KEY]: "" });
      if (!isPlaceholderKey(cur[STORAGE_API_KEY])) {
        Object.assign(patch, buildLocalAuthPatch(cur[STORAGE_API_KEY]));
      }
    } catch {}
  }
  if (normalized.noLogin !== false && normalized.mode !== "claude") {
    patch.preferCoworkExperience = false;
    patch.lastAuthFailureReason = "";
  }
  await chrome.storage.local.set(patch);
  return normalized;
}

/** openclaude 风格 isMatch */
export function isMatch(u, includes) {
  if (!includes || !includes.length) return false;
  let url;
  try {
    url = typeof u === "string" ? new URL(u, globalThis.location?.origin) : u;
  } catch {
    return false;
  }
  return includes.some((v) => {
    if (!v) return false;
    if (url.host === v) return true;
    if (url.href.startsWith(v)) return true;
    if (url.pathname.startsWith(v)) return true;
    if (v[0] === "*" && (url.host + url.pathname).includes(v.slice(1))) return true;
    // host contains
    if (!v.includes("://") && !v.startsWith("/") && url.host.includes(v.replace(/^\*\./, ""))) {
      return true;
    }
    return false;
  });
}

export function aliasToText(alias) {
  return Object.entries(alias || {})
    .map(([k, v]) => `${k} => ${v}`)
    .join("\n");
}

export function listToText(list) {
  return (list || []).join("\n");
}

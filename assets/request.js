/**
 * 本地 CFC 引擎（不请求 openclaude 云端）
 * - 完整应用 localCfcOptions：apiBaseIncludes / proxyIncludes / discardIncludes / modelAlias
 * - API Key 注入 + 免登录 OAuth 拦截
 */
import {
  STORAGE_OPTIONS,
  STORAGE_API_KEY,
  STORAGE_API_BASE,
  loadOptionsFromStorage,
  isMatch,
  normalizeOptions,
} from "./local-options.js";
import {
  buildLocalFeaturesMap,
  buildLocalFeaturesPayload,
} from "./local-system-prompt.js";
import {
  fetchUpstreamModels,
  loadCachedModelConfig,
  buildChromeExtModelsValue,
} from "./local-models.js";

const CONFIG_PATH = "config.html";

const state = {
  options: normalizeOptions({}),
  apiKey: "",
  ready: null,
};

function configUrl() {
  try {
    return chrome.runtime.getURL(CONFIG_PATH);
  } catch {
    return CONFIG_PATH;
  }
}

function isLoginOrOAuthUrl(url) {
  if (!url || typeof url !== "string") return false;
  const u = url.toLowerCase();
  return (
    u.startsWith("https://claude.ai/oauth/authorize") ||
    u.startsWith("https://claude.ai/login") ||
    u.startsWith("https://claude.ai/chrome/installed") ||
    u.includes("://claude.ai/oauth/") ||
    u.startsWith("https://platform.claude.com/v1/oauth/") ||
    u.startsWith("https://console.anthropic.com/v1/oauth/") ||
    u.includes("openclaude.724111.xyz/oauth") ||
    u.includes("724111.xyz/oauth")
  );
}

function isRemoteControlHost(url) {
  const s = String(url);
  return s.includes("openclaude.724111.xyz") || s.includes("cfc.aroic.workers.dev");
}

async function refreshConfig() {
  try {
    const { options, apiKey } = await loadOptionsFromStorage();
    state.options = options;
    state.apiKey = (apiKey || "").trim();
    // 给官方 J()/SDK 读：真实上游根（无则保持官方）
    const base = (options.anthropicBaseUrl || "").replace(/\/$/, "");
    globalThis.__localCfcApiBase = base || "https://api.anthropic.com";
    globalThis.__localCfcHasApiKey = Boolean(
      state.apiKey &&
        state.apiKey !== "sk-your-key-here" &&
        !state.apiKey.startsWith("sk-your-") &&
        state.apiKey !== "REPLACE_ME",
    );

    // 先读缓存模型，再后台拉中转 /v1/models
    try {
      const cached = await loadCachedModelConfig();
      if (cached.config?.options?.length) {
        globalThis.__localCfcModelConfig = cached.config;
      }
    } catch {}

    console.info("[local-cfc] config", {
      base: globalThis.__localCfcApiBase,
      hasKey: globalThis.__localCfcHasApiKey,
      mode: options.mode,
      models: globalThis.__localCfcModelConfig?.options?.length || 0,
    });

    if (
      globalThis.__localCfcHasApiKey &&
      base &&
      !/^https:\/\/api\.anthropic\.com$/i.test(base)
    ) {
      fetchUpstreamModels({ baseUrl: base, apiKey: state.apiKey, force: false })
        .then(async (r) => {
          if (!r.ok || !r.config) return;
          globalThis.__localCfcModelConfig = r.config;
          try {
            await chrome.storage.local.set({
              features: {
                timestamp: Date.now(),
                payload: {
                  features: buildLocalFeaturesMap(r.config),
                  success: true,
                  source: "local-cfc-models-refresh",
                },
              },
            });
          } catch (e) {
            console.warn("[local-cfc] seed features with models failed", e);
          }
        })
        .catch(() => {});
    }
  } catch (e) {
    console.warn("[local-cfc] storage read failed", e);
  }
}

state.ready = refreshConfig();

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      STORAGE_OPTIONS in changes ||
      STORAGE_API_KEY in changes ||
      STORAGE_API_BASE in changes
    ) {
      state.ready = refreshConfig();
    }
  });
} catch {}

if (!globalThis.__fetch) {
  globalThis.__fetch = fetch.bind(globalThis);
}

/** 是否为本地免登录塞的伪 OAuth JWT（iss: auth） */
function isLocalCfcAuthToken(value) {
  if (!value || typeof value !== "string") return false;
  const v = value.replace(/^Bearer\s+/i, "").trim();
  if (!v) return false;
  if (v === "local-cfc-api-key-mode" || v.endsWith(".local")) return true;
  if (!v.includes(".")) return false;
  try {
    const mid = v.split(".")[1] || "";
    const b64 = mid.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(pad));
    return Boolean(json && (json.iss === "auth" || json.local_cfc === true));
  } catch {
    return false;
  }
}

/**
 * 对话请求必须用真实 API Key。
 * 官方客户端在有 accessToken 时会走 authToken(Bearer JWT)；
 * 我们的 JWT 只为过登录页，不能打到上游 → 这里改成 x-api-key / Bearer sk-...
 */
function hasRealApiKey() {
  const k = (state.apiKey || "").trim();
  if (!k) return false;
  if (
    k === "sk-your-key-here" ||
    k === "REPLACE_ME" ||
    k.startsWith("sk-your-") ||
    k.includes("your-key-here")
  ) {
    return false;
  }
  if (isLocalCfcAuthToken(k)) return false;
  return true;
}

function withApiKeyHeaders(init = {}) {
  const headers = new Headers(init.headers || {});
  const auth = headers.get("Authorization") || headers.get("authorization") || "";

  // 永远先干掉伪 OAuth Bearer（即使暂时没 key，也不能把假 JWT 打到上游）
  if (isLocalCfcAuthToken(auth) || isLocalCfcAuthToken(auth.replace(/^Bearer\s+/i, ""))) {
    headers.delete("Authorization");
    headers.delete("authorization");
  }

  if (!hasRealApiKey()) {
    return { ...init, headers };
  }

  headers.set("x-api-key", state.apiKey);

  // 多数中转也认 Bearer sk-；官方 Anthropic 认 x-api-key
  const remaining = headers.get("Authorization") || headers.get("authorization");
  if (!remaining) {
    headers.set("Authorization", `Bearer ${state.apiKey}`);
  } else if (isLocalCfcAuthToken(remaining)) {
    headers.set("Authorization", `Bearer ${state.apiKey}`);
  }

  if (!headers.has("anthropic-version")) {
    headers.set("anthropic-version", "2023-06-01");
  }
  // 部分中转只认 anthropic-compatible，不认 anthropic-beta 也没关系
  return { ...init, headers };
}

function applyModelAlias(init) {
  const alias = state.options.modelAlias || {};
  if (!alias || !Object.keys(alias).length) return init;
  if (!init || typeof init.body !== "string") return init;
  try {
    const body = JSON.parse(init.body);
    if (body && body.model && alias[body.model]) {
      body.model = alias[body.model];
      return { ...init, body: JSON.stringify(body) };
    }
  } catch {}
  return init;
}

function rewriteApiUrl(raw) {
  const u = new URL(raw, globalThis.location?.origin);
  const base = (state.options.anthropicBaseUrl || "https://api.anthropic.com").replace(
    /\/$/,
    "",
  );
  return base + u.pathname + u.search;
}

/** 是否对话/模型 API（含已指向自定义 base 的直连） */
function isChatApiUrl(raw) {
  const href = String(raw || "");
  const path = pathOf(raw);
  if (
    path.includes("/v1/messages") ||
    path.includes("/v1/chat/completions") ||
    path.includes("/v1/completions") ||
    path.includes("/v1/models")
  ) {
    return true;
  }
  const base = (state.options.anthropicBaseUrl || "").replace(/\/$/, "");
  if (base && href.startsWith(base + "/")) {
    // 自定义根下的任意 path 也当 API（避免漏掉中转特有路径）
    if (path.includes("/v1/") || path.includes("/messages")) return true;
  }
  return false;
}

/** Anthropic 产品接口（账号/安全分类等），中转站通常没有 → 不得当 chat API 改写 */
function isAnthropicProductApiPath(path) {
  const p = String(path || "");
  return (
    p.includes("/api/web/") ||
    p.includes("/api/oauth/") ||
    p.includes("/api/bootstrap") ||
    p.includes("/api/feature") ||
    p.includes("/api/organizations") ||
    p.includes("/api/auth") ||
    p.includes("/v1/oauth/")
  );
}

function shouldRewriteAsApi(raw) {
  const opt = state.options;
  if (opt.mode === "claude") return false;
  const path = pathOf(raw);
  // 即使旧配置 apiBaseIncludes 写了整站 api.anthropic.com，也跳过产品接口
  if (isAnthropicProductApiPath(path)) return false;
  if (isMatch(raw, opt.apiBaseIncludes)) {
    // includes 命中时仍限制为对话相关 path，避免 /api/* 漏网
    if (
      path.includes("/v1/messages") ||
      path.includes("/v1/chat/completions") ||
      path.includes("/v1/completions") ||
      path.includes("/v1/models") ||
      path.includes("/v1/")
    ) {
      return true;
    }
    // 兼容极少数中转自定义 path：仅当原始 host 已是自定义 base 时放行
    return isChatApiUrl(raw);
  }
  // J() 已改成自定义 base 时，请求不再命中 api.anthropic.com includes
  if (isChatApiUrl(raw)) return true;
  return false;
}

function rewriteProxyUrl(raw) {
  const base = state.options.proxyBase || state.options.cfcBase || "";
  if (!base) return raw;
  // openclaude: cfcBase + full original href
  return base.replace(/\/?$/, "/") + raw;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function pathOf(raw) {
  try {
    return new URL(raw, globalThis.location?.origin).pathname;
  } catch {
    return String(raw || "");
  }
}

const LOCAL_ACCOUNT = {
  uuid: "00000000-0000-4000-8000-000000000001",
  email: "local-api-key@local",
  full_name: "Local API Key",
  display_name: "Local API Key",
  has_claude_ai: true,
  has_claude_max: true,
  has_claude_pro: true,
};

const LOCAL_ORG = {
  uuid: "00000000-0000-4000-8000-000000000002",
  name: "Local",
  organization_type: "claude_ai",
  rate_limit_tier: "default_claude_ai",
};

const LOCAL_PROFILE = {
  account: LOCAL_ACCOUNT,
  organization: LOCAL_ORG,
  organizations: [LOCAL_ORG],
  source: "local-cfc-mock",
};

/** 官方 FeatureStore：features[name] = { on, value }；value 必须稳定引用字段 */
/** FeatureStore：长 system prompt 见 local-system-prompt.js；模型列表可来自中转 /v1/models */
function getLocalModelConfigSync() {
  // request 路径里优先用内存；storage 异步在 refresh 里灌
  return globalThis.__localCfcModelConfig || null;
}

function LOCAL_FEATURES_MAP() {
  return buildLocalFeaturesMap(getLocalModelConfigSync());
}

function LOCAL_FEATURES_PAYLOAD() {
  return buildLocalFeaturesPayload(getLocalModelConfigSync());
}

/**
 * Mock 官方账号/bootstrap 等接口，避免无 OAuth 时侧栏反复 401 / 拉登录。
 * 只在 noLogin / api_key 模式下启用。
 */
function mockCloudAccountIfNeeded(raw, init) {
  const opt = state.options;
  if (opt.mode === "claude" || opt.noLogin === false) return null;

  const method = String(init?.method || "GET").toUpperCase();
  const path = pathOf(raw);
  const href = String(raw);

  // feature bootstrap — 官方 FeatureStore 结构：features[name] = { on, value }
  // 若 value 缺失，侧栏 k("chrome_ext_announcement", {}) 每次拿到新 {} → React #185 死循环
  if (
    path.includes("/api/bootstrap/features") ||
    href.includes("/api/bootstrap/features") ||
    path.includes("/api/feature_flags") ||
    path.includes("/api/features")
  ) {
    return jsonResponse(LOCAL_FEATURES_PAYLOAD());
  }
  if (
    path.endsWith("/api/bootstrap") ||
    path.includes("/api/bootstrap?") ||
    path.includes("/api/bootstrap/")
  ) {
    return jsonResponse({
      success: true,
      account: LOCAL_ACCOUNT,
      organization: LOCAL_ORG,
      ...LOCAL_FEATURES_PAYLOAD(),
      source: "local-cfc-mock",
    });
  }

  // profile（侧栏 isAuthenticated 依赖这份）
  if (path.includes("/api/oauth/profile") || path.includes("/oauth/profile")) {
    return jsonResponse(LOCAL_PROFILE);
  }

  // account / org surfaces used by sidepanel
  if (path.includes("/api/oauth/account")) {
    if (method === "GET" || method === "HEAD") {
      return jsonResponse({
        account: LOCAL_ACCOUNT,
        organization: LOCAL_ORG,
        organizations: [LOCAL_ORG],
        source: "local-cfc-mock",
      });
    }
    // PATCH settings etc.
    return jsonResponse({ success: true, source: "local-cfc-mock" });
  }

  if (path.includes("/api/oauth/organizations") || path.includes("/api/organizations")) {
    // spotlight / mcp bootstrap under org — return empty success-ish payloads
    if (path.includes("/mcp/")) {
      return jsonResponse({ servers: [], source: "local-cfc-mock" });
    }
    if (path.includes("/spotlight")) {
      return jsonResponse({ items: [], source: "local-cfc-mock" });
    }
    if (path.includes("/chat_conversations") || path.includes("/conversations")) {
      return jsonResponse({ data: [], conversations: [], source: "local-cfc-mock" });
    }
    if (method === "GET" || method === "HEAD") {
      return jsonResponse({
        data: [LOCAL_ORG],
        organizations: [LOCAL_ORG],
        source: "local-cfc-mock",
      });
    }
    return jsonResponse({ success: true, source: "local-cfc-mock" });
  }

  if (path.includes("/api/oauth/chat_conversations") || path.includes("/chat_conversations")) {
    return jsonResponse({ data: [], conversations: [], source: "local-cfc-mock" });
  }

  // browser extension domain info
  if (path.includes("/api/web/domain_info") || href.includes("/domain_info/browser_extension")) {
    return jsonResponse({ ok: true, allowed: true, source: "local-cfc-mock" });
  }

  // URL 安全分类（官方打 api.anthropic.com/api/web/url_hash_check）
  // 中转无此接口；category0 = 最低限制（可浏览）。
  // category1/2/org_blocked 会被官方当黑名单拦截导航。
  if (
    path.includes("/api/web/url_hash_check") ||
    href.includes("/url_hash_check/browser_extension")
  ) {
    return jsonResponse({
      category: "category0",
      org_policy: "allow",
      max_supported_category: 4,
      source: "local-cfc-mock",
    });
  }

  // 其余 /api/web/* 产品接口：本地一律放行空成功，避免打中转 404
  if (path.includes("/api/web/")) {
    return jsonResponse({
      ok: true,
      allowed: true,
      category: "category0",
      source: "local-cfc-mock",
    });
  }

  // token endpoints should never hit network in no-login mode
  if (
    href.includes("/v1/oauth/token") ||
    href.includes("/oauth/token") ||
    path.includes("/api/oauth/token")
  ) {
    // 对齐 openclaude：返回 JWT 形态 access_token（iss: auth）
    const b64 = (o) =>
      btoa(unescape(encodeURIComponent(JSON.stringify(o))))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    const now = Math.floor(Date.now() / 1000);
    const access_token = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      iss: "auth",
      sub: "00000000-0000-4000-8000-000000000001",
      exp: now + 86400 * 365,
      iat: now,
      type: "access",
      local_cfc: true,
    })}.local`;
    return jsonResponse({
      access_token,
      refresh_token: "local-cfc-no-refresh",
      expires_in: 86400 * 365,
      token_type: "Bearer",
      scope: "user:profile user:inference user:chat",
      source: "local-cfc-mock",
    });
  }

  return null;
}

export async function request(input, init) {
  await state.ready;
  const opt = state.options;
  const raw = typeof input === "string" ? input : input?.url || String(input);

  // 永远可关掉远程控制面
  if (opt.blockRemoteOpenclaude !== false && isRemoteControlHost(raw)) {
    return new Response(
      JSON.stringify({ ok: false, error: "remote openclaude disabled (local options)" }),
      { status: 410, headers: { "Content-Type": "application/json" } },
    );
  }

  // P0: mock/吞掉账号与 bootstrap（免登录）
  const mocked = mockCloudAccountIfNeeded(raw, init);
  if (mocked) return mocked;

  // discard
  if (isMatch(raw, opt.discardIncludes)) {
    return new Response(null, { status: 204 });
  }

  // API rewrite（真正的 messages/completions 等；含自定义 base 直连）
  if (shouldRewriteAsApi(raw)) {
    const maybePath = pathOf(raw);
    // 账号/bootstrap/web 安全分类绝不能打到中转
    if (isAnthropicProductApiPath(maybePath)) {
      const m2 = mockCloudAccountIfNeeded(raw, init);
      if (m2) return m2;
      // 未覆盖的账号类接口：空成功，避免 401/404
      return jsonResponse({ success: true, data: [], source: "local-cfc-mock-fallback" });
    }

    // 对话类：必须有真实 API Key，否则明确失败（比静默 401 好排查）
    const isMessages =
      maybePath.includes("/v1/messages") ||
      maybePath.includes("/v1/chat/completions") ||
      maybePath.includes("/v1/completions") ||
      maybePath.includes("/v1/models");
    if (isMessages && !hasRealApiKey()) {
      console.warn("[local-cfc] block send: no real API key", maybePath);
      return jsonResponse(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message:
              "本地未配置 API Key。请打开扩展配置页填写 Base URL + API Key 后重载。",
          },
        },
        401,
      );
    }

    const url = rewriteApiUrl(raw);
    const nextInit = withApiKeyHeaders(applyModelAlias(init));
    console.info("[local-cfc] API", String(init?.method || "GET").toUpperCase(), raw, "→", url, {
      hasKey: hasRealApiKey(),
    });
    try {
      const res = await globalThis.__fetch(url, nextInit);
      if (!res.ok) {
        // 克隆一份日志，不消耗业务 body
        try {
          const clone = res.clone();
          const text = await clone.text();
          console.warn(
            "[local-cfc] upstream",
            res.status,
            url,
            text.slice(0, 500),
          );
        } catch {}
      }
      return res;
    } catch (err) {
      console.error("[local-cfc] upstream fetch failed", url, err);
      return jsonResponse(
        {
          type: "error",
          error: {
            type: "api_error",
            message: `上游请求失败: ${String(err && err.message ? err.message : err)}（检查 Base URL 是否可达）`,
          },
        },
        502,
      );
    }
  }

  // proxyIncludes
  if (isMatch(raw, opt.proxyIncludes)) {
    // oauth/bootstrap 已在 mock；其余按 proxyMode
    if (opt.proxyMode === "rewrite" && (opt.proxyBase || opt.cfcBase)) {
      const url = rewriteProxyUrl(raw);
      return globalThis.__fetch(url, init);
    }
    // 本地默认：丢弃（无需云端反代）
    return new Response(null, { status: 204 });
  }

  // 绝对 URL 指向 claude.ai 的账号页接口也 mock
  if (String(raw).includes("claude.ai/api/")) {
    const m3 = mockCloudAccountIfNeeded(raw, init);
    if (m3) return m3;
  }

  return globalThis.__fetch(input, init);
}

request.toString = () => globalThis.__fetch.toString();
globalThis.fetch = request;

// XHR：discard/proxy/API 改写 + send 前注入 API Key（与 fetch 对齐）
if (globalThis.XMLHttpRequest && !globalThis.__xhrOpen) {
  globalThis.__xhrOpen = XMLHttpRequest.prototype.open;
  globalThis.__xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    const opt = state.options;
    let finalUrl = url;
    let finalMethod = method;
    this.__localCfcNeedKey = false;
    try {
      if (opt.blockRemoteOpenclaude !== false && isRemoteControlHost(url)) {
        finalUrl = "data:text/plain,blocked-openclaude";
        finalMethod = "GET";
      } else if (isMatch(url, opt.discardIncludes)) {
        finalUrl = "data:text/plain,";
        finalMethod = "GET";
      } else if (isMatch(url, opt.proxyIncludes)) {
        if (opt.proxyMode === "rewrite" && (opt.proxyBase || opt.cfcBase)) {
          finalUrl = rewriteProxyUrl(String(url));
        } else {
          finalUrl = "data:text/plain,";
          finalMethod = "GET";
        }
      } else if (shouldRewriteAsApi(url)) {
        finalUrl = rewriteApiUrl(String(url));
        this.__localCfcNeedKey = isChatApiUrl(finalUrl) || isChatApiUrl(url);
      } else if (isChatApiUrl(url)) {
        this.__localCfcNeedKey = true;
      }
    } catch {}
    this.__localCfcUrl = String(finalUrl);
    return globalThis.__xhrOpen.call(this, finalMethod, finalUrl, ...args);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__localCfcNeedKey && hasRealApiKey()) {
        // send 前仍可 setRequestHeader
        try {
          this.setRequestHeader("x-api-key", state.apiKey);
        } catch {}
        try {
          this.setRequestHeader("Authorization", `Bearer ${state.apiKey}`);
        } catch {}
        try {
          this.setRequestHeader("anthropic-version", "2023-06-01");
        } catch {}
      }
    } catch {}
    return globalThis.__xhrSend.call(this, body);
  };
}

// ---------- block OAuth / login tabs ----------
if (globalThis.chrome?.tabs?.create && !globalThis.__createTab) {
  globalThis.__createTab = chrome.tabs.create.bind(chrome.tabs);
  chrome.tabs.create = async function (createProperties, callback) {
    await state.ready;
    const props = { ...(createProperties || {}) };
    if (state.options.blockOAuth !== false && isLoginOrOAuthUrl(props.url)) {
      console.info("[local-cfc] blocked oauth tab → config", props.url);
      props.url = configUrl();
    }
    if (typeof callback === "function") return globalThis.__createTab(props, callback);
    return globalThis.__createTab(props);
  };
}

if (globalThis.chrome?.tabs?.update && !globalThis.__updateTab) {
  globalThis.__updateTab = chrome.tabs.update.bind(chrome.tabs);
  chrome.tabs.update = async function (tabId, updateProperties, callback) {
    await state.ready;
    let id = tabId;
    let props = updateProperties;
    let cb = callback;
    if (typeof tabId === "object" && tabId !== null) {
      props = tabId;
      id = undefined;
      cb = updateProperties;
    }
    props = { ...(props || {}) };
    if (state.options.blockOAuth !== false && isLoginOrOAuthUrl(props.url)) {
      console.info("[local-cfc] blocked oauth update → config", props.url);
      props.url = configUrl();
    }
    if (id === undefined) {
      return typeof cb === "function" ? globalThis.__updateTab(props, cb) : globalThis.__updateTab(props);
    }
    return typeof cb === "function"
      ? globalThis.__updateTab(id, props, cb)
      : globalThis.__updateTab(id, props);
  };
}

if (globalThis.chrome?.identity?.launchWebAuthFlow && !globalThis.__launchWebAuthFlow) {
  globalThis.__launchWebAuthFlow = chrome.identity.launchWebAuthFlow.bind(chrome.identity);
  chrome.identity.launchWebAuthFlow = function (details, callback) {
    const url = details?.url || "";
    const block = state.options.blockOAuth !== false;
    if (block && (isLoginOrOAuthUrl(url) || url.includes("claude.ai"))) {
      const err = new Error("OAuth disabled — local API key mode");
      if (typeof callback === "function") {
        try {
          chrome.runtime.lastError = { message: err.message };
        } catch {}
        callback(undefined);
        return;
      }
      return Promise.reject(err);
    }
    if (typeof callback === "function") return globalThis.__launchWebAuthFlow(details, callback);
    return globalThis.__launchWebAuthFlow(details);
  };
}

export function setJsx() {}
export function addLocales(locales, localMap) {
  const more = {
    "ru-RU": "Русский",
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
  };
  if (Array.isArray(locales) && locales[0] === "en-US" && localMap) {
    Object.keys(more).forEach((k) => {
      if (!locales.includes(k)) locales.push(k);
      localMap[k] = more[k];
    });
  }
}

export async function getOptions() {
  await state.ready;
  return {
    ...state.options,
    // 必须排除占位符，否则 sidepanel-boot 会以为已配置 Key
    apiKeyConfigured: hasRealApiKey(),
    source: "local-storage",
  };
}


// ---------- block official bridge WS (fake JWT → upstream_401) ----------
// 官方侧栏会连 wss://bridge.claudeusercontent.com/chrome/{uuid}，
// 用本地假 JWT 当 oauth_token → upstream_401。本地 key 模式不需要这条通道。
if (globalThis.WebSocket && !globalThis.__LocalCfcWebSocket) {
  const NativeWS = globalThis.WebSocket;
  globalThis.__LocalCfcWebSocket = NativeWS;

  function isOfficialBridgeUrl(url) {
    const u = String(url || "");
    if (!u) return false;
    if (
      u.includes("bridge.claudeusercontent.com") ||
      u.includes("bridge-staging.claudeusercontent.com")
    ) {
      return true;
    }
    // 保险：官方路径形态 /chrome/<uuid>
    try {
      const parsed = new URL(u);
      if (
        (parsed.protocol === "wss:" || parsed.protocol === "ws:") &&
        /bridge(-staging)?\.claudeusercontent\.com$/i.test(parsed.hostname) &&
        parsed.pathname.startsWith("/chrome/")
      ) {
        return true;
      }
    } catch {}
    return false;
  }

  function makeBlockedSocket(url) {
    const listeners = { open: [], message: [], error: [], close: [] };
    const dummy = {
      url: String(url || ""),
      readyState: NativeWS.CLOSED, // 3
      bufferedAmount: 0,
      extensions: "",
      protocol: "",
      binaryType: "blob",
      close() {
        dummy.readyState = NativeWS.CLOSED;
      },
      send() {
        /* no-op: never OPEN */
      },
      addEventListener(type, fn) {
        if (listeners[type] && typeof fn === "function") listeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        const arr = listeners[type];
        if (!arr) return;
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
      dispatchEvent() {
        return false;
      },
      _fire(type, ev) {
        const arr = listeners[type] || [];
        for (const fn of arr.slice()) {
          try {
            fn(ev);
          } catch {}
        }
        const prop = dummy["on" + type];
        if (typeof prop === "function") {
          try {
            prop(ev);
          } catch {}
        }
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    // 异步 CLOSE，避免同步抛错；永不 OPEN，因此不会发 connect/oauth_token
    queueMicrotask(() => {
      dummy.readyState = NativeWS.CLOSED;
      dummy._fire("close", {
        type: "close",
        code: 1000,
        reason: "local-cfc-blocked-bridge",
        wasClean: true,
      });
    });
    return dummy;
  }

  function LocalCfcWebSocket(url, protocols) {
    if (isOfficialBridgeUrl(url)) {
      console.info("[local-cfc] blocked bridge WebSocket", String(url));
      return makeBlockedSocket(url);
    }
    return protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
  }
  LocalCfcWebSocket.CONNECTING = 0;
  LocalCfcWebSocket.OPEN = 1;
  LocalCfcWebSocket.CLOSING = 2;
  LocalCfcWebSocket.CLOSED = 3;
  LocalCfcWebSocket.prototype = NativeWS.prototype;
  try {
    Object.setPrototypeOf(LocalCfcWebSocket, NativeWS);
  } catch {}
  globalThis.WebSocket = LocalCfcWebSocket;
}

console.info("[local-cfc] request.js ready (no remote /api/options)");

/**
 * 免登录启动 + 灌入完整本地 options（不请求 openclaude 云端）
 *
 * 侧栏打开策略（重要）：
 * - **不**注册 action.onClicked（官方 SW 的 ye() 会 open 侧栏）
 * - 在官方 SW 加载前包装 chrome.sidePanel.open：
 *   - 有 API Key → 放行官方 open
 *   - 无 API Key → 改开 config.html（同步缓存判断，不丢 user gesture）
 */
import { LOCAL_DEFAULTS } from "./local-defaults.js";
import {
  STORAGE_OPTIONS,
  STORAGE_API_KEY,
  STORAGE_API_BASE,
  normalizeOptions,
  saveOptionsToStorage,
  buildLocalAuthPatch,
} from "./local-options.js";
import { buildLocalFeaturesCache } from "./local-system-prompt.js";
import { fetchUpstreamModels, loadCachedModelConfig } from "./local-models.js";

const CONFIG_PATH = "config.html";
const NATIVE_HOSTS = [
  "com.anthropic.claude_code_browser_extension",
  "com.anthropic.claude_browser_extension",
];

/** 同步缓存：sidePanel.open 包装器用，禁止在 open 路径上 await storage */
const syncAuth = {
  hasKey: false,
  noLogin: true,
  mode: "api_key",
  extensionId: "",
  nativeHostOk: null,
};

function configUrl() {
  return chrome.runtime.getURL(CONFIG_PATH);
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

function looksLikeLocalJwt(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  try {
    const mid = token.split(".")[1] || "";
    const b64 = mid.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(pad));
    return Boolean(json && (json.iss === "auth" || json.local_cfc === true));
  } catch {
    return false;
  }
}

function extractKeyFromStorageData(data = {}) {
  const candidates = [
    data[STORAGE_API_KEY],
    data.anthropicApiKey,
    data.apiKey,
    data.ANTHROPIC_API_KEY,
  ];
  for (const c of candidates) {
    const k = String(c || "").trim();
    if (!isPlaceholderKey(k)) return k;
  }
  return "";
}

function refreshSyncAuthFromData(data = {}) {
  const key = extractKeyFromStorageData(data);
  const opt = normalizeOptions(data[STORAGE_OPTIONS] || {});
  syncAuth.hasKey = Boolean(key);
  syncAuth.noLogin = opt.noLogin !== false;
  syncAuth.mode = opt.mode || "api_key";
  return syncAuth;
}

/**
 * @param {{ fetchModels?: boolean }} opts
 */
async function seedLocalAll({ fetchModels = true } = {}) {
  const force = LOCAL_DEFAULTS.forceOverwrite === true;
  const desiredKey = (LOCAL_DEFAULTS.apiKey || "").trim();
  const desiredOptions = normalizeOptions(LOCAL_DEFAULTS.options || {});

  const current = await chrome.storage.local.get({
    [STORAGE_OPTIONS]: null,
    [STORAGE_API_KEY]: "",
    [STORAGE_API_BASE]: "",
    preferCoworkExperience: false,
    accessToken: "",
    features: null,
    apiKey: "",
    ANTHROPIC_API_KEY: "",
  });

  const hasOptions =
    current[STORAGE_OPTIONS] && typeof current[STORAGE_OPTIONS] === "object";
  const patch = {
    lastAuthFailureReason: "",
    preferCoworkExperience: false,
  };

  const storedOptions = hasOptions
    ? normalizeOptions(current[STORAGE_OPTIONS])
    : desiredOptions;
  const effectiveOptions = force ? desiredOptions : storedOptions;

  if (force || !hasOptions) {
    patch[STORAGE_OPTIONS] = desiredOptions;
    patch[STORAGE_API_BASE] = desiredOptions.anthropicBaseUrl;
  } else if (!current[STORAGE_API_BASE] && effectiveOptions.anthropicBaseUrl) {
    patch[STORAGE_API_BASE] = effectiveOptions.anthropicBaseUrl;
  }

  const currentKey = extractKeyFromStorageData(current);
  if (desiredKey && !isPlaceholderKey(desiredKey)) {
    if (force || !currentKey) {
      patch[STORAGE_API_KEY] = desiredKey;
    }
  }
  // 兼容键里有真 Key、正式键没有 → 归一到 anthropicApiKey
  if (currentKey && isPlaceholderKey(current[STORAGE_API_KEY] || "")) {
    patch[STORAGE_API_KEY] = currentKey;
  }

  const finalKey = (patch[STORAGE_API_KEY] ?? currentKey ?? "").trim();
  const hasKey = !isPlaceholderKey(finalKey);
  const finalOptions = normalizeOptions(
    patch[STORAGE_OPTIONS] || current[STORAGE_OPTIONS] || desiredOptions,
  );

  if (finalOptions.noLogin !== false && finalOptions.mode !== "claude") {
    const needToken = !looksLikeLocalJwt(current.accessToken);
    if (needToken) {
      Object.assign(patch, buildLocalAuthPatch(finalKey, { forceToken: true }));
    }

    const hasFeatures = Boolean(
      current.features?.payload?.features?.chrome_ext_system_prompt ||
        current.features?.payload?.features?.chrome_ext_announcement,
    );
    let modelConfig = null;
    let modelsUpdated = false;
    try {
      const cached = await loadCachedModelConfig();
      modelConfig = cached.config;
    } catch {}
    if (fetchModels && hasKey && finalOptions.anthropicBaseUrl) {
      try {
        const r = await fetchUpstreamModels({
          baseUrl: finalOptions.anthropicBaseUrl,
          apiKey: finalKey,
          force: false,
        });
        if (r.ok && r.config) {
          modelConfig = r.config;
          modelsUpdated = !r.fromCache;
        }
      } catch (e) {
        console.warn("[local-cfc] bootstrap models", e);
      }
    }
    if (!hasFeatures || modelsUpdated || force) {
      patch.features = buildLocalFeaturesCache(modelConfig);
    }
  }

  await chrome.storage.local.set(patch);

  // 刷新同步缓存（含刚写入的 key）
  refreshSyncAuthFromData({
    ...current,
    ...patch,
    [STORAGE_API_KEY]: finalKey,
    [STORAGE_OPTIONS]: finalOptions,
  });

  return {
    hasKey,
    apiKey: finalKey,
    options: finalOptions,
  };
}

async function openConfigPage() {
  const url = configUrl();
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(url));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  const create = globalThis.__createTab || chrome.tabs.create.bind(chrome.tabs);
  await create({ url });
}

async function enableSidePanelForTab(tabId) {
  if (!tabId || !chrome.sidePanel?.setOptions) return;
  await chrome.sidePanel.setOptions({
    tabId,
    path: `sidepanel.html?tabId=${encodeURIComponent(tabId)}`,
    enabled: true,
  });
}

/**
 * 包装 sidePanel.open：无 Key 时改开配置页。
 * 必须在官方 service-worker 加载前安装；判断用 syncAuth，禁止 await。
 */
function installSidePanelOpenGuard() {
  if (!chrome.sidePanel?.open || globalThis.__localCfcSidePanelOpen) return;
  const nativeOpen = chrome.sidePanel.open.bind(chrome.sidePanel);
  globalThis.__localCfcSidePanelOpen = nativeOpen;

  chrome.sidePanel.open = function localCfcSidePanelOpen(options) {
    // 有 Key / 官方 OAuth 模式：放行官方 ye()
    if (
      syncAuth.hasKey ||
      syncAuth.mode === "claude" ||
      syncAuth.noLogin === false
    ) {
      return nativeOpen(options);
    }

    // 无 Key：不 open 侧栏，改配置页
    console.info("[local-cfc] sidePanel.open blocked (no API key) → config");
    openConfigPage().catch((e) =>
      console.warn("[local-cfc] open config failed", e),
    );
    return Promise.resolve();
  };
}

/**
 * 探测 Native Messaging host 是否接受当前扩展 ID。
 * 扩展无法改系统 host json；只诊断并写入 storage 供配置页/日志看。
 */
function probeNativeHosts() {
  const extensionId = chrome.runtime?.id || "";
  syncAuth.extensionId = extensionId;
  if (!extensionId || typeof chrome.runtime.connectNative !== "function") {
    return Promise.resolve({
      ok: false,
      extensionId,
      error: "nativeMessaging unavailable",
    });
  }

  const origin = `chrome-extension://${extensionId}/`;
  const results = [];

  const tryOne = (name) =>
    new Promise((resolve) => {
      let port;
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        try {
          port?.disconnect();
        } catch {}
        resolve(value);
      };
      const timer = setTimeout(
        () => finish({ name, ok: false, error: "timeout (host may still be ok)" }),
        1500,
      );
      try {
        port = chrome.runtime.connectNative(name);
      } catch (e) {
        clearTimeout(timer);
        return finish({ name, ok: false, error: String(e?.message || e) });
      }
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError?.message || "disconnected";
        // 指定 origin 不在白名单时常见：Specified native messaging host not found. / Access to... denied
        finish({ name, ok: false, error: err });
      });
      // 若 host 起来会先连上；发空/忽略均可。很多 host 连上即表示白名单通过。
      try {
        port.onMessage.addListener(() => {
          clearTimeout(timer);
          finish({ name, ok: true });
        });
        // 不发协议外消息，仅看是否立刻 disconnect
        setTimeout(() => {
          // 仍连着 → 认为白名单 OK（host 在等长度前缀帧）
          if (!done) {
            clearTimeout(timer);
            finish({ name, ok: true, note: "connected" });
          }
        }, 400);
      } catch (e) {
        clearTimeout(timer);
        finish({ name, ok: false, error: String(e?.message || e) });
      }
    });

  return Promise.all(NATIVE_HOSTS.map(tryOne)).then(async (hosts) => {
    const ok = hosts.some((h) => h.ok);
    syncAuth.nativeHostOk = ok;
    const report = {
      ok,
      extensionId,
      origin,
      hosts,
      hint: ok
        ? "native host allowed_origins 包含本扩展"
        : `请把 ${origin} 写入 NativeMessagingHosts 里 com.anthropic.claude_code_browser_extension.json 的 allowed_origins，或运行 scripts/ensure-native-host.sh`,
      at: Date.now(),
    };
    try {
      await chrome.storage.local.set({ localCfcNativeHostStatus: report });
    } catch {}
    console.info("[local-cfc] native host probe", report);
    return report;
  });
}

async function boot(reason = "manual", ui = {}) {
  const {
    openConfigIfNoKey = false,
    tabId = null,
    fetchModels = true,
  } = ui;

  const auth = await seedLocalAll({ fetchModels });
  console.info("[local-cfc] boot", reason, {
    hasKey: auth.hasKey,
    base: auth.options.anthropicBaseUrl,
    mode: auth.options.mode,
    extensionId: chrome.runtime?.id,
  });

  try {
    const tid =
      tabId ||
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (tid) await enableSidePanelForTab(tid);
  } catch {}

  if (!auth.hasKey || auth.options.noLogin === false) {
    if (openConfigIfNoKey) await openConfigPage();
  }

  return auth;
}

// ---- 安装 open 守卫（官方 SW 尚未加载）----
installSidePanelOpenGuard();

// 启动时灌同步缓存，避免首击 hasKey 仍是 false
chrome.storage.local
  .get({
    [STORAGE_API_KEY]: "",
    [STORAGE_OPTIONS]: null,
    apiKey: "",
    ANTHROPIC_API_KEY: "",
  })
  .then((data) => {
    refreshSyncAuthFromData(data);
    console.info("[local-cfc] syncAuth", {
      hasKey: syncAuth.hasKey,
      mode: syncAuth.mode,
    });
  })
  .catch(() => {});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      STORAGE_API_KEY in changes ||
      STORAGE_OPTIONS in changes ||
      "apiKey" in changes ||
      "ANTHROPIC_API_KEY" in changes
    ) {
      chrome.storage.local
        .get({
          [STORAGE_API_KEY]: "",
          [STORAGE_OPTIONS]: null,
          apiKey: "",
          ANTHROPIC_API_KEY: "",
        })
        .then(refreshSyncAuthFromData)
        .catch(() => {});
    }
  });
} catch {}

// 注意：故意不注册 action.onClicked，避免与官方 ye() 双开 / 丢手势

chrome.runtime.onInstalled.addListener((details) => {
  boot(`installed:${details.reason}`, {
    openConfigIfNoKey: details.reason === "install",
    fetchModels: true,
  })
    .then(() => probeNativeHosts())
    .catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  seedLocalAll({ fetchModels: false })
    .then(() => probeNativeHosts())
    .catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "OPEN_CONFIG_PAGE") {
    openConfigPage()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "SEED_LOCAL_AUTH" || msg?.type === "NO_LOGIN_BOOT") {
    boot(msg.type, {
      openConfigIfNoKey: false,
      fetchModels: false,
    })
      .then((auth) => sendResponse({ ok: true, hasKey: auth.hasKey }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "GET_LOCAL_OPTIONS") {
    seedLocalAll({ fetchModels: false })
      .then((x) =>
        sendResponse({
          ok: true,
          ...x,
          apiKey: x.hasKey ? "***" : "",
          extensionId: chrome.runtime?.id,
          nativeHost: syncAuth.nativeHostOk,
        }),
      )
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "SAVE_LOCAL_OPTIONS") {
    saveOptionsToStorage({
      options: msg.options,
      apiKey: msg.apiKey,
      keepApiKeyIfEmpty: true,
    })
      .then(async (options) => {
        // 保存后立刻刷新 sync 缓存，下次点图标守卫正确
        const data = await chrome.storage.local.get({
          [STORAGE_API_KEY]: "",
          [STORAGE_OPTIONS]: options,
        });
        refreshSyncAuthFromData(data);
        sendResponse({ ok: true, options, hasKey: syncAuth.hasKey });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "PROBE_NATIVE_HOST") {
    probeNativeHosts()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

seedLocalAll({ fetchModels: false })
  .then(() => probeNativeHosts())
  .catch(console.error);

console.info("[local-cfc] bootstrap ready", {
  extensionId: chrome.runtime?.id,
  note: "no local action.onClicked; sidePanel.open guarded",
});

/**
 * 侧栏启动前写入官方认的 JWT accessToken（对齐 openclaude iss:"auth"）。
 * 避免 React 先读 storage → 无 token → 登录页。
 */
import {
  STORAGE_API_KEY,
  STORAGE_OPTIONS,
  loadOptionsFromStorage,
  buildLocalAuthPatch,
  normalizeOptions,
  makeLocalAccessToken,
} from "./local-options.js";
import { buildLocalFeaturesCache } from "./local-system-prompt.js";
import { fetchUpstreamModels, loadCachedModelConfig } from "./local-models.js";

function isPlaceholderKey(key) {
  if (!key) return true;
  const k = String(key).trim();
  return !k || k === "sk-your-key-here" || k === "REPLACE_ME" || k.startsWith("sk-your-");
}

function looksLikeLocalJwt(token) {
  if (!token || typeof token !== "string") return false;
  if (!token.includes(".")) return false;
  try {
    const mid = token.split(".")[1] || "";
    const b64 = mid.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(pad));
    return json && json.iss === "auth";
  } catch {
    return false;
  }
}

export async function ensureLocalAuth() {
  const { options, apiKey } = await loadOptionsFromStorage();
  const opt = normalizeOptions(options || {});

  if (opt.mode === "claude" || opt.noLogin === false) {
    return { ok: true, skipped: true };
  }

  const cur = await chrome.storage.local.get({
    accessToken: "",
    [STORAGE_API_KEY]: "",
    [STORAGE_OPTIONS]: null,
  });

  const key = !isPlaceholderKey(apiKey)
    ? String(apiKey).trim()
    : !isPlaceholderKey(cur[STORAGE_API_KEY])
      ? String(cur[STORAGE_API_KEY]).trim()
      : "";

  const needRewrite = !looksLikeLocalJwt(cur.accessToken);
  const patch = {};

  // 只在缺/坏 token 时写 JWT，避免 storage 抖动触发 React 重渲染
  if (needRewrite) {
    Object.assign(patch, buildLocalAuthPatch(key, { forceToken: true }));
  } else if (key && isPlaceholderKey(cur[STORAGE_API_KEY] || "")) {
    patch[STORAGE_API_KEY] = key;
  }

  if (!cur[STORAGE_OPTIONS] || typeof cur[STORAGE_OPTIONS] !== "object") {
    patch[STORAGE_OPTIONS] = opt;
  }

  // FeatureStore 缓存：结构必须是 { payload: { features: { name: { on, value } } } }
  // 否则 chrome_ext_announcement 回落到每次新的 {} → setAnnouncementDismissed 死循环 (React #185)
  // 模型列表：缓存优先，有 base+key 再拉中转 /v1/models
  let modelConfig = null;
  try {
    const cached = await loadCachedModelConfig();
    modelConfig = cached.config;
  } catch {}
  try {
    if (key && opt.anthropicBaseUrl) {
      const r = await fetchUpstreamModels({
        baseUrl: opt.anthropicBaseUrl,
        apiKey: key,
        force: false,
      });
      if (r.ok && r.config) modelConfig = r.config;
    }
  } catch (e) {
    console.warn("[local-cfc] models fetch in ensureLocalAuth", e);
  }
  if (modelConfig) globalThis.__localCfcModelConfig = modelConfig;

  const featuresCache = buildLocalFeaturesCache(modelConfig);
  patch.features = featuresCache;
  patch.preferCoworkExperience = false;
  patch.lastAuthFailureReason = "";

  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }

  const verify = await chrome.storage.local.get({ accessToken: "", features: null });
  const ok = looksLikeLocalJwt(verify.accessToken);
  console.info("[local-cfc] ensureLocalAuth", {
    ok,
    hasKey: Boolean(key),
    featuresSeeded: Boolean(verify.features?.payload?.features),
    tokenPreview: String(verify.accessToken || "").slice(0, 24),
  });
  return { ok, hasKey: Boolean(key) };
}

const _boot = ensureLocalAuth().catch((e) => {
  console.warn("[local-cfc] ensureLocalAuth failed", e);
  return { ok: false, error: String(e) };
});

// 给 sidepanel 入口 await
export default _boot;

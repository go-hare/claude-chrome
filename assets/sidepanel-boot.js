/**
 * 侧栏入口（外部 module，满足扩展 CSP script-src 'self'）
 * 顺序：写本地 JWT → 挂钩 fetch/WS → 拉中转模型 → 加载官方侧栏
 */
import boot from "./ensure-local-auth.js";
import { getOptions } from "./request.js";
import { fetchUpstreamModels, loadCachedModelConfig } from "./local-models.js";
import { buildLocalFeaturesCache } from "./local-system-prompt.js";

await boot;

try {
  const opts = await getOptions();
  console.info("[local-cfc] sidepanel-boot ready", {
    base: opts.anthropicBaseUrl,
    hasKey: opts.apiKeyConfigured,
    mode: opts.mode,
  });

  // 启动前尽量灌好模型列表，避免只有「Sonnet 4」一项
  if (opts.apiKeyConfigured && opts.anthropicBaseUrl) {
    // getOptions 不回传真 key；从 storage 读
    const { anthropicApiKey } = await chrome.storage.local.get({ anthropicApiKey: "" });
    const r = await fetchUpstreamModels({
      baseUrl: opts.anthropicBaseUrl,
      apiKey: anthropicApiKey,
      force: false,
    });
    if (r.ok && r.config) {
      globalThis.__localCfcModelConfig = r.config;
      await chrome.storage.local.set({ features: buildLocalFeaturesCache(r.config) });
      console.info("[local-cfc] sidepanel models", {
        count: r.config.options?.length,
        default: r.config.default,
        fromCache: r.fromCache,
      });
    } else {
      const cached = await loadCachedModelConfig();
      console.warn("[local-cfc] models not loaded", r.error, "cached", cached.config?.options?.length || 0);
    }
  }
} catch (e) {
  console.warn("[local-cfc] sidepanel-boot getOptions/models failed", e);
}

await import("./sidepanel-CEYFzMrx.js");

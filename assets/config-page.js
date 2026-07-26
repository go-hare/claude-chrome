import {
  DEFAULT_OPTIONS,
  loadOptionsFromStorage,
  saveOptionsToStorage,
  normalizeOptions,
  normalizeAlias,
  listToText,
  aliasToText,
} from "./local-options.js";

function $(id) {
  return document.getElementById(id);
}

function mask(key) {
  if (!key) return "";
  if (key.length <= 8) return "*".repeat(key.length);
  return key.slice(0, 3) + "*".repeat(Math.max(0, key.length - 7)) + key.slice(-4);
}

function fillForm(options, apiKey) {
  const o = normalizeOptions(options || {});
  $("anthropicBaseUrl").value = o.anthropicBaseUrl || "";
  $("mode").value = o.mode === "claude" ? "claude" : "api_key";
  $("proxyMode").value = o.proxyMode === "rewrite" ? "rewrite" : "discard";
  $("proxyBase").value = o.proxyBase || o.cfcBase || "";
  $("noLogin").checked = o.noLogin !== false;
  $("blockOAuth").checked = o.blockOAuth !== false;
  $("blockRemoteOpenclaude").checked = o.blockRemoteOpenclaude !== false;
  $("apiBaseIncludes").value = listToText(o.apiBaseIncludes);
  $("proxyIncludes").value = listToText(o.proxyIncludes);
  $("discardIncludes").value = listToText(o.discardIncludes);
  $("modelAlias").value = aliasToText(o.modelAlias);
  $("apiKey").value = "";
  $("apiKey").placeholder = apiKey ? `已保存: ${mask(apiKey)}` : "sk-... / 上游 Key";
}

function readForm() {
  return {
    options: normalizeOptions({
      mode: $("mode").value,
      anthropicBaseUrl: $("anthropicBaseUrl").value.trim(),
      proxyMode: $("proxyMode").value,
      proxyBase: $("proxyBase").value.trim(),
      cfcBase: $("proxyBase").value.trim(),
      noLogin: $("noLogin").checked,
      blockOAuth: $("blockOAuth").checked,
      blockRemoteOpenclaude: $("blockRemoteOpenclaude").checked,
      apiBaseIncludes: $("apiBaseIncludes").value,
      proxyIncludes: $("proxyIncludes").value,
      discardIncludes: $("discardIncludes").value,
      modelAlias: normalizeAlias($("modelAlias").value),
    }),
    apiKey: $("apiKey").value.trim(),
  };
}

async function load() {
  const { options, apiKey } = await loadOptionsFromStorage();
  fillForm(options, apiKey);
  const msg = $("msg");
  if (apiKey && !String(apiKey).includes("your-key-here")) {
    msg.innerHTML = '<span class="ok">本地 options 已加载 · API Key 免登录</span>';
  } else {
    msg.innerHTML = '<span class="muted">请填写真实 API Key（或改 local-defaults.js 后重载）</span>';
  }
}

async function save() {
  const msg = $("msg");
  const { options, apiKey } = readForm();
  if (options.anthropicBaseUrl && !/^https?:\/\//i.test(options.anthropicBaseUrl)) {
    msg.innerHTML = '<span class="bad">anthropicBaseUrl 需要 http(s):// 开头</span>';
    return;
  }
  if (
    options.proxyMode === "rewrite" &&
    options.proxyBase &&
    !/^https?:\/\//i.test(options.proxyBase)
  ) {
    msg.innerHTML = '<span class="bad">proxyBase 需要 http(s):// 开头</span>';
    return;
  }
  await saveOptionsToStorage({ options, apiKey, keepApiKeyIfEmpty: true });
  msg.innerHTML = '<span class="ok">已保存到本机 storage</span>';
  await load();
}

async function resetDefaults() {
  const current = await loadOptionsFromStorage();
  fillForm(
    {
      ...DEFAULT_OPTIONS,
      anthropicBaseUrl: current.options.anthropicBaseUrl || DEFAULT_OPTIONS.anthropicBaseUrl,
    },
    current.apiKey,
  );
  $("msg").innerHTML = '<span class="muted">已填入默认规则（未保存，请点保存）</span>';
}

async function openSidepanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && chrome.sidePanel?.open) {
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: `sidepanel.html?tabId=${encodeURIComponent(tab.id)}`,
        enabled: true,
      });
      await chrome.sidePanel.open({ tabId: tab.id });
      return;
    }
  } catch (e) {
    console.warn(e);
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") });
}

$("save").addEventListener("click", () => {
  save().catch((e) => {
    $("msg").innerHTML = `<span class="bad">${e.message || e}</span>`;
  });
});
$("resetDefaults").addEventListener("click", () => {
  resetDefaults().catch(console.error);
});
$("openSidepanel").addEventListener("click", () => {
  openSidepanel().catch(console.error);
});
load().catch(console.error);

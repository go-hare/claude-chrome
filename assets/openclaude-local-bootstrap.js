/**
 * Bootstrap: on extension click / install / startup,
 * ask native host com.openclaude.local to ensure localhost:8787 is up,
 * then open the local config page (API URL + Key).
 */
const HOST_NAME = "com.openclaude.local";
const CONFIG_URL = "http://127.0.0.1:8787/";

function sendNative(message, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    let port;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        port?.disconnect();
      } catch {}
      resolve(value);
    };
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      return finish({ ok: false, error: String(e) });
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: "native host timeout" });
    }, timeoutMs);
    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      finish(msg || { ok: false, error: "empty native response" });
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || "native host disconnected";
      clearTimeout(timer);
      finish({ ok: false, error: err });
    });
    try {
      port.postMessage(message);
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: String(e) });
    }
  });
}

async function ensureLocalServer() {
  // Prefer native host so click can auto-start the daemon.
  const native = await sendNative({ type: "start" });
  if (native?.ok) {
    return { ok: true, via: "native", ...native };
  }
  // Fallback: maybe user already started server manually.
  try {
    const res = await fetch(CONFIG_URL + "api/health", { cache: "no-store" });
    if (res.ok) {
      return { ok: true, via: "existing", url: CONFIG_URL, nativeError: native?.error };
    }
  } catch {}
  return { ok: false, error: native?.error || "local server unavailable" };
}

async function openConfigPage() {
  const result = await ensureLocalServer();
  if (result.ok) {
    const url = result.configUrl || result.url || CONFIG_URL;
    await chrome.tabs.create({ url });
    return result;
  }
  // Last resort: open extension options + notify how to install host.
  try {
    await chrome.notifications.create(`openclaude-local-${Date.now()}`, {
      type: "basic",
      iconUrl: "/icon-128.png",
      title: "OpenClaude Local 未启动",
      message:
        "请先运行 openclaude-local/install.sh，或手动执行: python3 openclaude-local/host.py start",
      priority: 2,
    });
  } catch {}
  try {
    await chrome.runtime.openOptionsPage();
  } catch {}
  return result;
}

// Click toolbar icon → config page (instead of only side panel).
chrome.action.onClicked.addListener(() => {
  openConfigPage().catch(console.error);
});

// Warm up local server in the background.
chrome.runtime.onInstalled.addListener(() => {
  ensureLocalServer().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  ensureLocalServer().catch(() => {});
});

// Allow other extension pages to request start/open.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === "OPENCLAUDE_LOCAL_START") {
    ensureLocalServer().then(sendResponse);
    return true;
  }
  if (msg.type === "OPENCLAUDE_LOCAL_OPEN_CONFIG") {
    openConfigPage().then(sendResponse);
    return true;
  }
});

console.info("[openclaude-local-bootstrap] loaded");

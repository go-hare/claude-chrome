#!/usr/bin/env python3
"""Local openclaude-compatible server for the patched Claude Chrome extension.

- GET  /                config UI (API URL + API Key)
- GET  /api/options     CFC remote config consumed by assets/request.js
- GET  /api/config      current config (key masked)
- POST /api/config      save API base URL + key
- GET  /api/health      liveness
- ANY  /v1/*            reverse-proxy to configured upstream with injected key
"""

from __future__ import annotations

import json
import os
import re
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HOST = os.environ.get("OPENCLAUDE_HOST", "127.0.0.1")
PORT = int(os.environ.get("OPENCLAUDE_PORT", "8787"))
BASE = f"http://{HOST}:{PORT}/"
ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(
    os.environ.get(
        "OPENCLAUDE_CONFIG",
        Path.home() / ".openclaude-local" / "config.json",
    )
)

DEFAULT_CONFIG = {
    "apiBaseUrl": "https://api.anthropic.com",
    "apiKey": "",
    "mode": "api_key",
}


def load_config() -> dict:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG.copy())
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    cfg = DEFAULT_CONFIG.copy()
    cfg.update({k: v for k, v in data.items() if k in DEFAULT_CONFIG})
    if isinstance(cfg.get("apiBaseUrl"), str):
        cfg["apiBaseUrl"] = cfg["apiBaseUrl"].rstrip("/")
    return cfg


def save_config(cfg: dict) -> dict:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    clean = DEFAULT_CONFIG.copy()
    clean.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    if isinstance(clean.get("apiBaseUrl"), str):
        clean["apiBaseUrl"] = clean["apiBaseUrl"].rstrip("/")
    CONFIG_PATH.write_text(
        json.dumps(clean, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return clean


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return key[:3] + "*" * (len(key) - 7) + key[-4:]


def build_options(cfg: dict) -> dict:
    # Point the extension API base at THIS local proxy so the key stays server-side.
    return {
        "mode": cfg.get("mode") or "api_key",
        "cfcBase": BASE,
        "anthropicBaseUrl": BASE.rstrip("/"),
        "apiBaseIncludes": [
            "https://api.anthropic.com/v1/",
            "https://api.anthropic.com/",
        ],
        "proxyIncludes": [],
        "discardIncludes": [
            "cdn.segment.com",
            "api.segment.io",
            "events.statsigapi.net",
            "api.honeycomb.io",
            "prodregistryv2.org",
            "*ingest.us.sentry.io",
            "browser-intake-us5-datadoghq.com",
            "api.statsigcdn.com",
            "statsigapi.net",
            "featuregates.org",
            "featureassets.org",
            "assetsconfigcdn.org",
            "beyondwickedmapping.org",
        ],
        "modelAlias": {},
        "ui": {},
        "uiNodes": [],
        "local": {
            "configPath": str(CONFIG_PATH),
            "upstream": cfg.get("apiBaseUrl") or "",
            "hasKey": bool(cfg.get("apiKey")),
        },
    }


CONFIG_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaude Local</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    body { margin: 0; background: #0f0f0f; color: #f5f5f4; }
    .wrap { max-width: 640px; margin: 48px auto; padding: 0 20px; }
    h1 { font-size: 1.4rem; margin: 0 0 8px; }
    p { color: #a8a29e; line-height: 1.5; }
    .card { background: #1c1917; border: 1px solid #292524; border-radius: 14px; padding: 20px; margin-top: 20px; }
    label { display: block; font-size: 0.85rem; color: #d6d3d1; margin: 14px 0 6px; }
    input { width: 100%; box-sizing: border-box; border-radius: 10px; border: 1px solid #44403c; background: #0c0a09; color: #fafaf9; padding: 12px 14px; font-size: 0.95rem; }
    button { margin-top: 18px; border: 0; border-radius: 10px; background: #d97706; color: #111; font-weight: 600; padding: 12px 16px; cursor: pointer; }
    button:hover { background: #f59e0b; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .ok { color: #86efac; } .bad { color: #fca5a5; } .muted { color: #a8a29e; font-size: 0.85rem; }
    code { background: #292524; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>OpenClaude Local</h1>
    <p>本地配置页：填写上游 API URL 和 Key。扩展会通过 <code>/api/options</code> 拿到配置，并把模型请求转到本机代理。</p>
    <div class="card">
      <div class="row">
        <span id="status" class="muted">检查服务状态…</span>
      </div>
      <label for="apiBaseUrl">API Base URL</label>
      <input id="apiBaseUrl" placeholder="https://api.anthropic.com 或你的中转地址" />
      <label for="apiKey">API Key</label>
      <input id="apiKey" type="password" placeholder="sk-... 或上游要求的 key" autocomplete="off" />
      <p class="muted">Key 只保存在本机 <code>~/.openclaude-local/config.json</code>，由本地服务注入请求，不发给远程 openclaude。</p>
      <div class="row">
        <button id="save" type="button">保存</button>
        <span id="msg" class="muted"></span>
      </div>
    </div>
  </div>
  <script>
    async function load() {
      const st = document.getElementById('status');
      try {
        const h = await fetch('/api/health').then(r => r.json());
        st.innerHTML = h.ok
          ? '<span class="ok">服务运行中</span> · ' + h.base
          : '<span class="bad">服务异常</span>';
        const c = await fetch('/api/config').then(r => r.json());
        document.getElementById('apiBaseUrl').value = c.apiBaseUrl || '';
        document.getElementById('apiKey').value = '';
        document.getElementById('apiKey').placeholder = c.hasKey
          ? ('已保存: ' + (c.apiKeyMasked || '****'))
          : 'sk-... 或上游要求的 key';
      } catch (e) {
        st.innerHTML = '<span class="bad">无法连接本地服务</span>';
      }
    }
    document.getElementById('save').onclick = async () => {
      const msg = document.getElementById('msg');
      msg.textContent = '保存中…';
      const body = {
        apiBaseUrl: document.getElementById('apiBaseUrl').value.trim(),
        apiKey: document.getElementById('apiKey').value,
      };
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'save failed');
        msg.innerHTML = '<span class="ok">已保存</span>';
        document.getElementById('apiKey').value = '';
        await load();
      } catch (e) {
        msg.innerHTML = '<span class="bad">' + (e.message || e) + '</span>';
      }
    };
    load();
  </script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[openclaude-local] {self.address_string()} {fmt % args}")

    def _send(self, code: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self) -> None:
        self._send(204, b"")

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._send(200, CONFIG_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/api/health":
            self._json(200, {"ok": True, "base": BASE, "pid": os.getpid()})
            return
        if path == "/api/options":
            self._json(200, build_options(load_config()))
            return
        if path == "/api/config":
            cfg = load_config()
            self._json(
                200,
                {
                    "apiBaseUrl": cfg.get("apiBaseUrl") or "",
                    "hasKey": bool(cfg.get("apiKey")),
                    "apiKeyMasked": mask_key(cfg.get("apiKey") or ""),
                    "mode": cfg.get("mode") or "api_key",
                    "configPath": str(CONFIG_PATH),
                },
            )
            return
        if path.startswith("/v1/") or path == "/v1":
            self._proxy()
            return
        self._json(404, {"error": "not found", "path": path})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/config":
            try:
                body = self._read_json()
            except Exception as e:
                self._json(400, {"error": f"invalid json: {e}"})
                return
            cfg = load_config()
            if "apiBaseUrl" in body and body["apiBaseUrl"] is not None:
                url = str(body["apiBaseUrl"]).strip()
                if url and not re.match(r"^https?://", url):
                    self._json(400, {"error": "apiBaseUrl must start with http:// or https://"})
                    return
                cfg["apiBaseUrl"] = url.rstrip("/") if url else DEFAULT_CONFIG["apiBaseUrl"]
            if "apiKey" in body and body["apiKey"] not in (None, ""):
                cfg["apiKey"] = str(body["apiKey"]).strip()
            if "mode" in body and body["mode"]:
                cfg["mode"] = str(body["mode"])
            save_config(cfg)
            self._json(
                200,
                {
                    "ok": True,
                    "apiBaseUrl": cfg["apiBaseUrl"],
                    "hasKey": bool(cfg.get("apiKey")),
                    "apiKeyMasked": mask_key(cfg.get("apiKey") or ""),
                },
            )
            return
        if path.startswith("/v1/") or path == "/v1":
            self._proxy()
            return
        self._json(404, {"error": "not found", "path": path})

    def do_PUT(self) -> None:
        self.do_POST()

    def do_PATCH(self) -> None:
        self.do_POST()

    def do_DELETE(self) -> None:
        if urlparse(self.path).path.startswith("/v1"):
            self._proxy()
            return
        self._json(405, {"error": "method not allowed"})

    def _proxy(self) -> None:
        cfg = load_config()
        upstream = (cfg.get("apiBaseUrl") or DEFAULT_CONFIG["apiBaseUrl"]).rstrip("/")
        key = cfg.get("apiKey") or ""
        parsed = urlparse(self.path)
        target = upstream + parsed.path + (f"?{parsed.query}" if parsed.query else "")

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        headers = {}
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in {"host", "content-length", "connection", "transfer-encoding"}:
                continue
            headers[k] = v

        # Inject credentials for Anthropic-style and Bearer-style upstreams.
        if key:
            if "x-api-key" not in {h.lower() for h in headers}:
                headers["x-api-key"] = key
            if "authorization" not in {h.lower() for h in headers}:
                headers["Authorization"] = f"Bearer {key}"
            if "anthropic-version" not in {h.lower() for h in headers}:
                headers["anthropic-version"] = "2023-06-01"

        req = urllib.request.Request(target, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in {"content-encoding", "transfer-encoding", "connection"}:
                        continue
                    self.send_header(k, v)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            resp_body = e.read() or str(e).encode("utf-8")
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(resp_body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            self._json(502, {"error": "upstream proxy failed", "detail": str(e), "target": target})


_server: ThreadingHTTPServer | None = None
_thread: threading.Thread | None = None


def is_running() -> bool:
    try:
        import http.client

        conn = http.client.HTTPConnection(HOST, PORT, timeout=1)
        conn.request("GET", "/api/health")
        resp = conn.getresponse()
        ok = resp.status == 200
        resp.read()
        conn.close()
        return ok
    except Exception:
        return False


def start_server(block: bool = True) -> str:
    global _server, _thread
    if is_running():
        return BASE
    _server = ThreadingHTTPServer((HOST, PORT), Handler)
    if block:
        print(f"[openclaude-local] listening on {BASE}")
        _server.serve_forever()
    else:
        _thread = threading.Thread(target=_server.serve_forever, daemon=True)
        _thread.start()
        print(f"[openclaude-local] listening on {BASE}")
    return BASE


def main() -> None:
    load_config()
    start_server(block=True)


if __name__ == "__main__":
    main()

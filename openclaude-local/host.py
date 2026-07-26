#!/usr/bin/env python3
"""Chrome Native Messaging host: start/status for openclaude-local HTTP server."""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server.py"
HOST = os.environ.get("OPENCLAUDE_HOST", "127.0.0.1")
PORT = int(os.environ.get("OPENCLAUDE_PORT", "8787"))
BASE = f"http://{HOST}:{PORT}/"
PYTHON = sys.executable or "python3"
PID_PATH = Path.home() / ".openclaude-local" / "server.pid"


def read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    data = sys.stdin.buffer.read(length)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


def send_message(msg: dict) -> None:
    payload = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def health() -> dict | None:
    # Bypass system HTTP proxies (urllib.getproxies can break 127.0.0.1 checks).
    try:
        req = urllib.request.Request(
            f"{BASE}api/health",
            headers={"Cache-Control": "no-cache"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=1.5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        try:
            import http.client

            conn = http.client.HTTPConnection(HOST, PORT, timeout=1.5)
            conn.request("GET", "/api/health")
            resp = conn.getresponse()
            data = resp.read().decode("utf-8")
            conn.close()
            if resp.status == 200:
                return json.loads(data)
        except Exception:
            return None
        return None


def start_server() -> dict:
    existing = health()
    if existing and existing.get("ok"):
        return {
            "ok": True,
            "alreadyRunning": True,
            "url": BASE,
            "configUrl": BASE,
            "pid": existing.get("pid"),
        }

    PID_PATH.parent.mkdir(parents=True, exist_ok=True)
    log_path = PID_PATH.parent / "server.log"
    log_f = open(log_path, "a", encoding="utf-8")
    proc = subprocess.Popen(
        [PYTHON, str(SERVER)],
        cwd=str(ROOT),
        stdout=log_f,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env={
            **os.environ,
            "OPENCLAUDE_HOST": HOST,
            "OPENCLAUDE_PORT": str(PORT),
        },
    )
    PID_PATH.write_text(str(proc.pid), encoding="utf-8")

    # Server import/bind can take >1s on cold start; wait up to ~5s.
    for _ in range(50):
        time.sleep(0.1)
        h = health()
        if h and h.get("ok"):
            return {
                "ok": True,
                "alreadyRunning": False,
                "url": BASE,
                "configUrl": BASE,
                "pid": h.get("pid") or proc.pid,
            }
        if proc.poll() is not None:
            break

    return {
        "ok": False,
        "error": "server failed to become healthy",
        "url": BASE,
        "log": str(log_path),
        "pid": proc.pid,
    }


def handle(msg: dict) -> dict:
    mtype = msg.get("type") or msg.get("method") or ""
    if mtype in {"ping", "PING"}:
        return {"type": "pong", "ok": True, "url": BASE}
    if mtype in {"status", "get_status", "STATUS"}:
        h = health()
        return {
            "type": "status_response",
            "ok": bool(h and h.get("ok")),
            "running": bool(h and h.get("ok")),
            "url": BASE,
            "configUrl": BASE,
            "pid": (h or {}).get("pid"),
        }
    if mtype in {"start", "ensure", "START", "ensure_server"}:
        result = start_server()
        result["type"] = "start_response"
        return result
    if mtype in {"open_config"}:
        result = start_server()
        result["type"] = "open_config_response"
        return result
    return {"ok": False, "error": f"unknown message type: {mtype}", "type": "error"}


def main() -> None:
    # One-shot CLI helpers for install/debug without Chrome.
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd == "start":
            print(json.dumps(start_server(), ensure_ascii=False, indent=2))
            return
        if cmd == "status":
            h = health()
            print(
                json.dumps(
                    {
                        "running": bool(h and h.get("ok")),
                        "url": BASE,
                        "health": h,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return
        if cmd == "health":
            print(json.dumps(health() or {"ok": False}, ensure_ascii=False, indent=2))
            return

    while True:
        msg = read_message()
        if msg is None:
            break
        try:
            send_message(handle(msg))
        except Exception as e:
            send_message({"ok": False, "type": "error", "error": str(e)})


if __name__ == "__main__":
    main()

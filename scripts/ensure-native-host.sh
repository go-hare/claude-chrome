#!/usr/bin/env bash
# 把扩展 ID 写入 Claude Code Native Messaging host 白名单。
# 用法：
#   ./scripts/ensure-native-host.sh
#   ./scripts/ensure-native-host.sh <extension-id> [more-ids...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/manifest.json"
HOST_NAME="com.anthropic.claude_code_browser_extension"
HOST_BIN="${HOME}/.claude/chrome/chrome-native-host"

HOST_DIRS=()
for d in \
  "${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "${HOME}/Library/Application Support/Chromium/NativeMessagingHosts" \
  "${HOME}/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
do
  parent="$(dirname "$d")"
  [[ -d "$parent" ]] || continue
  mkdir -p "$d"
  HOST_DIRS+=("$d")
done

compute_id_from_manifest() {
  python3 - <<'PY' "$MANIFEST"
import base64, hashlib, json, sys
from pathlib import Path
manifest = json.loads(Path(sys.argv[1]).read_text())
key = manifest.get("key")
if not key:
    raise SystemExit(0)
der = base64.b64decode(key)
digest = hashlib.sha256(der).digest()[:16]
print("".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0xF)) for b in digest))
PY
}

IDS=()
for a in "$@"; do
  a="${a#chrome-extension://}"
  a="${a%/}"
  [[ -n "$a" ]] && IDS+=("$a")
done

if MID="$(compute_id_from_manifest 2>/dev/null || true)"; then
  [[ -n "${MID:-}" ]] && IDS+=("$MID")
fi
IDS+=("fcoeoabgfenejglbffodgkkbkcdhcgfn")

# unique
UNIQUE_IDS=()
for id in "${IDS[@]}"; do
  seen=0
  for u in "${UNIQUE_IDS[@]:-}"; do
    [[ "$u" == "$id" ]] && seen=1 && break
  done
  [[ $seen -eq 0 ]] && UNIQUE_IDS+=("$id")
done

if [[ ! -e "$HOST_BIN" ]]; then
  echo "warn: native host binary missing: $HOST_BIN" >&2
fi
if [[ -f "$HOST_BIN" && ! -x "$HOST_BIN" ]]; then
  chmod +x "$HOST_BIN" || true
fi

export HOST_NAME HOST_BIN
export UNIQUE_IDS_JSON
UNIQUE_IDS_JSON="$(printf '%s\n' "${UNIQUE_IDS[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')"

write_one() {
  local dir="$1"
  local file="${dir}/${HOST_NAME}.json"
  HOST_FILE="$file" python3 - <<'PY'
import json, os
from pathlib import Path

path = Path(os.environ["HOST_FILE"])
host_bin = os.environ["HOST_BIN"]
ids = json.loads(os.environ["UNIQUE_IDS_JSON"])
origins = [f"chrome-extension://{i}/" for i in ids]

data = {
    "name": os.environ["HOST_NAME"],
    "description": "Claude Code Browser Extension Native Host (local-cfc ensured)",
    "path": host_bin,
    "type": "stdio",
    "allowed_origins": origins,
}

if path.exists():
    try:
        old = json.loads(path.read_text())
        merged = []
        for o in list(old.get("allowed_origins") or []) + origins:
            if o and o not in merged:
                merged.append(o)
        data["allowed_origins"] = merged
        old_path = old.get("path") or ""
        if old_path and not Path(host_bin).exists() and Path(old_path).exists():
            data["path"] = old_path
    except Exception:
        pass

path.write_text(json.dumps(data, indent=2) + "\n")
print(f"wrote {path}")
for o in data["allowed_origins"]:
    print(f"  - {o}")
PY
}

echo "extension ids: ${UNIQUE_IDS[*]}"
if [[ ${#HOST_DIRS[@]} -eq 0 ]]; then
  echo "error: no browser NativeMessagingHosts parent dir found" >&2
  exit 1
fi
for dir in "${HOST_DIRS[@]}"; do
  write_one "$dir"
done

echo
echo "done. Reload the extension, then check SW console:"
echo "  [local-cfc] native host probe"
echo "If ok:false, copy chrome.runtime.id from extension details into:"
echo "  ./scripts/ensure-native-host.sh <that-id>"

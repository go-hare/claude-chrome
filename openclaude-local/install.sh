#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST_PY="$ROOT/host.py"
WRAPPER="$ROOT/host-wrapper.sh"
MANIFEST_SRC="$ROOT/com.openclaude.local.json"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"

chmod +x "$HOST_PY" "$ROOT/server.py" 2>/dev/null || true

cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$PYTHON_BIN" "$HOST_PY"
EOF
chmod +x "$WRAPPER"

TMP_MANIFEST="$(mktemp)"
python3 - "$MANIFEST_SRC" "$WRAPPER" "$TMP_MANIFEST" <<'PY'
import json, sys
src, path, out = sys.argv[1:4]
data = json.loads(open(src, encoding="utf-8").read())
data["path"] = path
open(out, "w", encoding="utf-8").write(json.dumps(data, indent=2) + "\n")
print(json.dumps(data, indent=2))
PY

install_one() {
  local dir="$1"
  mkdir -p "$dir"
  cp "$TMP_MANIFEST" "$dir/com.openclaude.local.json"
  echo "installed: $dir/com.openclaude.local.json"
}

# User-level native messaging host locations (macOS)
install_one "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
install_one "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
install_one "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
install_one "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
install_one "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"

rm -f "$TMP_MANIFEST"

echo
echo "Native host name: com.openclaude.local"
echo "Wrapper: $WRAPPER"
echo "Allowed extension id: fcoeoabgfenejglbffodgkkbkcdhcgfn"
echo
echo "Smoke test:"
echo "  $PYTHON_BIN $HOST_PY start"
echo "  open http://127.0.0.1:8787/"
echo
echo "Then reload the unpacked extension in chrome://extensions"

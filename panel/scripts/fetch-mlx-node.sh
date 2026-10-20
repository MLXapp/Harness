#!/bin/bash
# Fetch the public MLX Node build and stage it for MLX Harness to carry:
#   panel/resources/bundled-node/MLX Node.zip   (ditto zip of "MLX Node.app")
#   panel/resources/bundled-node/MLX Node.json  (version, build, sha256)
# electron-builder ships both to Contents/Resources/bundled-node/ (extraResources)
# and leaves them unsigned (mac.signIgnore), so MLX Node keeps its own
# Developer ID signature, entitlements and provisioning profile.
#
# Checks before anything is staged: the DMG's app is MLX Node (bundle id
# app.mlx.mac), strictly signed by our team (CCKXS9W488) and accepted by
# Gatekeeper as notarized. The DMG names it "MLX.app" before 0.9.0 and
# "MLX Node.app" from 0.9.0; the staged copy is always "MLX Node.app".
#
# Exits non-zero on any failure (the workflow decides whether that's fatal).
# MLX_NODE_URL overrides the source (default: mlx.app's public download).
set -euo pipefail

URL="${MLX_NODE_URL:-https://mlx.app/api/download/mac}"
BUNDLE_ID="app.mlx.mac"
TEAM_ID="CCKXS9W488"
REQ="anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$TEAM_ID\" and identifier \"$BUNDLE_ID\""

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
PANEL_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd -P)"
OUT="$PANEL_DIR/resources/bundled-node"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: MLX Node can only be checked and staged on macOS" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mlx-node.XXXXXX")"
MNT="$WORK/mnt"
cleanup() {
  if [[ -d "$MNT" ]]; then /usr/bin/hdiutil detach "$MNT" -quiet -force >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Downloading MLX Node from $URL"
/usr/bin/curl -fL --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 5 --max-time 600 \
  -A "MLXHarness-CI" -o "$WORK/node.dmg" "$URL"
DMG_SHA="$(/usr/bin/shasum -a 256 "$WORK/node.dmg" | awk '{print $1}')"
echo "    $(du -h "$WORK/node.dmg" | awk '{print $1}')  sha256 $DMG_SHA"

mkdir -p "$MNT"
/usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$MNT" "$WORK/node.dmg" >/dev/null

APP=""
for name in "MLX Node.app" "MLX.app"; do
  if [[ -d "$MNT/$name" ]]; then APP="$MNT/$name"; break; fi
done
if [[ -z "$APP" ]]; then
  echo "ERROR: no MLX Node.app or MLX.app in the DMG:" >&2
  ls -la "$MNT" >&2
  exit 1
fi
echo "==> Found $(basename "$APP")"

id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")"
version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist")"
build="$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$APP/Contents/Info.plist" 2>/dev/null || echo "")"
if [[ "$id" != "$BUNDLE_ID" ]]; then
  echo "ERROR: bundle id is $id, expected $BUNDLE_ID" >&2
  exit 1
fi

verify_app() {
  local app="$1"
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
  /usr/bin/codesign --verify --deep --strict -R "=$REQ" "$app"
  local info
  info="$(/usr/bin/codesign -dv "$app" 2>&1)"
  grep -qx "Identifier=$BUNDLE_ID" <<<"$info" || { echo "ERROR: signing identifier is not $BUNDLE_ID" >&2; echo "$info" >&2; return 1; }
  grep -qx "TeamIdentifier=$TEAM_ID" <<<"$info" || { echo "ERROR: team is not $TEAM_ID" >&2; echo "$info" >&2; return 1; }
  grep -q "flags=.*runtime" <<<"$info" || { echo "ERROR: hardened runtime is off" >&2; echo "$info" >&2; return 1; }
}

echo "==> Verifying MLX Node $version ($build)"
verify_app "$APP"
/usr/sbin/spctl -a -t exec -vv "$APP"

# Copy out of the DMG under its new name and check the copy the same way.
mkdir -p "$WORK/stage"
/usr/bin/ditto "$APP" "$WORK/stage/MLX Node.app"
verify_app "$WORK/stage/MLX Node.app"

rm -rf "$OUT"
mkdir -p "$OUT"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$WORK/stage/MLX Node.app" "$OUT/MLX Node.zip"

# The zip must give back the same, valid app.
mkdir -p "$WORK/unzip"
/usr/bin/ditto -x -k "$OUT/MLX Node.zip" "$WORK/unzip"
verify_app "$WORK/unzip/MLX Node.app"

ZIP_SHA="$(/usr/bin/shasum -a 256 "$OUT/MLX Node.zip" | awk '{print $1}')"
/usr/bin/python3 - "$OUT/MLX Node.json" "$version" "$build" "$ZIP_SHA" "$DMG_SHA" "$(basename "$APP")" <<'PY'
import json, sys, datetime
out, version, build, zip_sha, dmg_sha, source_name = sys.argv[1:]
json.dump({
    "name": "MLX Node",
    "bundleId": "app.mlx.mac",
    "teamId": "CCKXS9W488",
    "version": version,
    "build": build,
    "sha256": zip_sha,
    "dmgSha256": dmg_sha,
    "sourceName": source_name,
    "fetchedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}, open(out, "w"), indent=2)
open(out, "a").write("\n")
PY

echo "==> Staged MLX Node $version in resources/bundled-node ($(du -h "$OUT/MLX Node.zip" | awk '{print $1}'))"

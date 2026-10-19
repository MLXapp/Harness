#!/bin/bash
# Build the MLX Studio DMG for Apple Silicon:
#   panel/release/MLX-Studio-<version>-arm64.dmg
#
# Flavours (same source, different MLX wheels — see upstream vmlx#169):
#   MLX_STUDIO_FLAVOR=sequoia (default)  macosx_14 wheels, macOS 14.5 and newer
#   MLX_STUDIO_FLAVOR=tahoe              native macosx_26 wheels, macOS 26 only
#                                        (file name gets a -tahoe suffix)
#
# Signing: when a Developer ID Application identity is available (CSC_LINK +
# CSC_KEY_PASSWORD, or one in the login keychain) electron-builder signs with
# the hardened runtime; otherwise the DMG is unsigned. Notarisation runs only
# when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD (and the team id in package.json)
# are set; electron-builder skips it silently otherwise.
#
# Python: the relocatable engine runtime is built by bundle-python.sh into
# panel/bundled-python. Set MLX_STUDIO_REUSE_PYTHON=1 to reuse an existing one.
# JANG tools come from VMLX_JANG_TOOLS_SOURCE (a jjang-ai/jangq checkout's
# jang-tools dir); set VMLX_ALLOW_PYPI_JANG=1 to fall back to PyPI.
#
# Upstream's attested release driver (build-release-dmgs.sh) is kept untouched
# for merges and is not used here.
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
PANEL_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd -P)"
cd "$PANEL_DIR"

FLAVOR="${MLX_STUDIO_FLAVOR:-sequoia}"
case "$FLAVOR" in
  sequoia) PLATFORM="macosx_14_0_arm64"; MIN_SYSTEM="14.5.0"; SUFFIX="" ;;
  tahoe)   PLATFORM="macosx_26_0_arm64"; MIN_SYSTEM="26.0.0"; SUFFIX="-tahoe" ;;
  *) echo "ERROR: MLX_STUDIO_FLAVOR must be sequoia or tahoe (got: $FLAVOR)" >&2; exit 1 ;;
esac

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: MLX Studio DMGs are built on an Apple Silicon Mac" >&2
  exit 1
fi

# The electron-builder hooks and bundled-Python verifier call Homebrew's node.
for tool in /opt/homebrew/bin/node /opt/homebrew/bin/npx; do
  if [[ ! -x "$tool" ]]; then
    echo "ERROR: $tool is required (brew install node)" >&2
    exit 1
  fi
done

VERSION="$(/opt/homebrew/bin/node -p "require('./package.json').version")"
echo "==> MLX Studio $VERSION ($FLAVOR, $PLATFORM, macOS $MIN_SYSTEM+)"

if [[ "${MLX_STUDIO_REUSE_PYTHON:-0}" == "1" && -x bundled-python/python/bin/python3 ]]; then
  echo "==> Reusing panel/bundled-python"
else
  echo "==> Building the bundled Python runtime"
  VMLX_BUNDLE_MLX_PLATFORM="$PLATFORM" ./scripts/bundle-python.sh
fi
./scripts/verify-bundled-python.sh

identity_args=()
if [[ -z "${CSC_LINK:-}" ]] && ! /usr/bin/security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  echo "==> No Developer ID identity: building an unsigned DMG"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  identity_args=(--config.mac.identity=null --config.dmg.sign=false)
  # An unsigned app cannot be notarized.
  unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_KEYCHAIN_PROFILE
fi

# Notarisation team: package.json carries ours; APPLE_TEAM_ID overrides it.
if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
  identity_args+=(--config.mac.notarize.teamId="$APPLE_TEAM_ID")
fi

rm -rf release
/opt/homebrew/bin/npx --no-install electron-builder --mac dmg --arm64 \
  --config.mac.minimumSystemVersion="$MIN_SYSTEM" \
  --config.artifactName="MLX-Studio-\${version}${SUFFIX}-\${arch}.\${ext}" \
  ${identity_args[@]+"${identity_args[@]}"}

DMG="release/MLX-Studio-${VERSION}${SUFFIX}-arm64.dmg"
if [[ ! -f "$DMG" ]]; then
  echo "ERROR: expected $DMG was not produced" >&2
  ls -la release >&2 || true
  exit 1
fi
/usr/bin/shasum -a 256 "$DMG" | tee "$DMG.sha256"
echo "==> Built $DMG"

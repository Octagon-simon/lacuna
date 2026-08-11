#!/bin/bash
# Usage (from extension/): OVSX_TOKEN=<token> npm run publish:ovsx
#
# Publishes the CURRENT extension version to Open VSX (Cursor / Windsurf / VSCodium / Antigravity),
# and nothing else. Use it to add Open VSX for a version that is ALREADY on the VS Code Marketplace:
# re-running the ext-v* release tag would fail on vsce's duplicate-version check, so this path skips
# vsce entirely and only calls ovsx. For brand-new versions you don't need this — the release
# workflow publishes to both registries from the tag.
set -e

cd "$(dirname "$0")/.."
: "${OVSX_TOKEN:?Set OVSX_TOKEN (your Open VSX access token) first, e.g. OVSX_TOKEN=xxx npm run publish:ovsx}"

# Rebuild from source (core first — the bundle embeds ../dist) so the published artifact matches HEAD.
( cd .. && npm run build )
npm run build

VERSION=$(node -p "require('./package.json').version")
PUBLISHER=$(node -p "require('./package.json').publisher")
VSIX="lacuna-vscode-${VERSION}.vsix"

# Open VSX needs the namespace (= package.json publisher) to exist before the first publish. This is
# idempotent: it no-ops (non-zero exit, swallowed) if the namespace already exists / you're a member.
# Creating it does NOT require "claiming" — claiming is the optional verified-owner badge on the site.
npx ovsx create-namespace "$PUBLISHER" -p "$OVSX_TOKEN" 2>/dev/null \
  || echo "namespace '${PUBLISHER}' already exists (or you're already a member) — continuing"

npx @vscode/vsce package --no-dependencies -o "$VSIX"
npx ovsx publish "$VSIX" -p "$OVSX_TOKEN"
rm -f "$VSIX"

echo "✓ Published ${VERSION} to Open VSX"

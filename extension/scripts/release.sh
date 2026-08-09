#!/bin/bash
# Usage (from extension/): npm run release [patch|minor|major]
#
# Bumps the extension version, validates the build + package locally (so a broken bundle or manifest
# fails BEFORE we tag), then commits, tags `ext-vX.Y.Z`, and pushes. CI takes over from the tag:
# .github/workflows/release-extension.yml builds, packages, and publishes to the VS Code Marketplace,
# and attaches the .vsix to a GitHub release. Mirrors the CLI's scripts/release.sh (tag → CI ships),
# except the extension tag is namespaced `ext-v*` so it never collides with the CLI's `v*` tags.
set -e

BUMP=${1:-patch}
if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: npm run release [patch|minor|major]"
  exit 1
fi

# Always operate from the extension/ directory (this script lives in extension/scripts/).
cd "$(dirname "$0")/.."
ROOT=".."

# A release tags committed history — a dirty tree would tag the wrong thing.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes. Commit or stash them first."
  exit 1
fi

# The extension bundle EMBEDS the CLI core (esbuild aliases `lacuna-cli`/`lacuna-scaffold` → ../dist).
# Build the core first so the bundle — and the copied lacuna.schema.json — are current.
( cd "$ROOT" && npm run build )
npm run build

# Pre-flight: package to a throwaway .vsix (gitignored) to catch .vscodeignore / manifest errors
# before we cut a tag. Discarded — CI produces the real, published artifact.
npx @vscode/vsce package --no-dependencies -o /tmp/lacuna-ext-preflight.vsix >/dev/null
rm -f /tmp/lacuna-ext-preflight.vsix
echo "✓ pre-flight package OK"

# Bump extension/package.json only (no npm git tag — we tag ext-v* ourselves).
npm version "$BUMP" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
TAG="ext-v${VERSION}"

git add package.json package-lock.json
git commit -m "chore: release extension ${TAG}"
git tag "$TAG"
git push origin main
git push origin "$TAG"

echo ""
echo "Released extension ${TAG} — CI will build, package, and publish to the VS Code Marketplace."
echo "Watch: https://github.com/Octagon-simon/lacuna/actions"

#!/bin/bash
# Usage (from extension/): npm run release [patch|minor|major|--no-bump]
#
# Bumps the extension version (or --no-bump to ship the current version as-is — for the FIRST
# Marketplace release, where you want 0.1.0 published rather than skipping straight to 0.1.1),
# validates the build + package locally (so a broken bundle or manifest fails BEFORE we tag), then
# commits, tags `ext-vX.Y.Z`, and pushes. CI takes over from the tag:
# .github/workflows/release-extension.yml builds, packages, and publishes to the VS Code Marketplace,
# and attaches the .vsix to a GitHub release. Mirrors the CLI's scripts/release.sh (tag → CI ships),
# except the extension tag is namespaced `ext-v*` so it never collides with the CLI's `v*` tags.
set -e

BUMP=${1:-patch}
NO_BUMP=0
if [[ "$BUMP" == "--no-bump" ]]; then
  NO_BUMP=1
elif [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: npm run release [patch|minor|major|--no-bump]"
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

# Bump extension/package.json (or keep the current version with --no-bump). No npm git tag — we tag
# ext-v* ourselves.
if [[ "$NO_BUMP" == "1" ]]; then
  VERSION=$(node -p "require('./package.json').version")
  echo "No-bump: releasing current version ${VERSION}"
else
  npm version "$BUMP" --no-git-tag-version
  VERSION=$(node -p "require('./package.json').version")
fi
TAG="ext-v${VERSION}"

# Never silently move an existing tag (a --no-bump re-run, or a version already released).
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Tag ${TAG} already exists. Bump the version instead of re-releasing ${VERSION}."
  exit 1
fi

# Stage whatever changed since the clean checkpoint: the version bump, and any dist the pre-flight
# build refreshed. With --no-bump on an already-current tree there's nothing to stage — then we just
# tag the existing HEAD (no empty commit) and push only the tag.
git add -A
if git diff --cached --quiet; then
  git tag "$TAG"
  git push origin "$TAG"
else
  git commit -m "chore: release extension ${TAG}"
  git tag "$TAG"
  git push origin main
  git push origin "$TAG"
fi

echo ""
echo "Released extension ${TAG} — CI will build, package, and publish to the VS Code Marketplace."
echo "Watch: https://github.com/Octagon-simon/lacuna/actions"

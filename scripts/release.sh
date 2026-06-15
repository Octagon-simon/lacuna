#!/bin/bash
# Usage: npm run release [patch|minor|major]
# Bumps version, commits, tags, and pushes — CI handles build + npm publish.
set -e

BUMP=${1:-patch}

if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: npm run release [patch|minor|major]"
  exit 1
fi

# Verify clean working tree (staged or unstaged changes block tagging)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes. Commit or stash them first."
  exit 1
fi

# Bump version in package.json only (no automatic git commit/tag from npm)
npm version "$BUMP" --no-git-tag-version

VERSION=$(node -p "require('./package.json').version")

npm run build

git add .
git commit -m "chore: release v${VERSION}"
git tag "v${VERSION}"
git push origin main
git push origin "v${VERSION}"

echo ""
echo "Released v${VERSION} — CI will build dist and publish to npm."
echo "Watch: https://github.com/Octagon-simon/lacuna/actions"

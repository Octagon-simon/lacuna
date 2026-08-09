#!/bin/bash
# Usage: npm run release:all [patch|minor|major]
#
# Releases the CLI and/or the VS Code extension — whichever has actually changed since ITS last
# release tag. Commit your work first (both sub-releases require a clean tree); this then bumps,
# tags, and pushes only the package(s) that changed. CI publishes each from its tag.
#
# Key rule: the extension bundles the CLI core, so a core (src/) change ALSO warrants an extension
# release — otherwise a core fix would ship to npm but never reach extension users.
set -e

BUMP=${1:-patch}
if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: npm run release:all [patch|minor|major]"
  exit 1
fi

cd "$(dirname "$0")/.."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes. Commit or stash them first."
  exit 1
fi

# Latest tag for a package (empty string if none yet → treated as "changed", i.e. first release).
last_tag() { git describe --tags --match "$1" --abbrev=0 2>/dev/null || true; }

# True (0) when any of the given paths changed between $tag and HEAD, or when there is no tag yet.
changed() {
  local tag="$1"; shift
  [ -z "$tag" ] && return 0
  ! git diff --quiet "$tag" HEAD -- "$@"
}

# CLI tags are vX.Y.Z (the floating `v1` has no dots, so it's excluded); extension tags are ext-v*.
CLI_TAG=$(last_tag 'v[0-9]*.[0-9]*.[0-9]*')
EXT_TAG=$(last_tag 'ext-v[0-9]*.[0-9]*.[0-9]*')

# Paths that define each package's published surface.
CLI_PATHS=(src package.json bin scripts tsconfig.json README.md)
# Extension = its own sources OR the bundled core (src/ + the schema it embeds).
EXT_PATHS=(extension/src extension/package.json extension/esbuild.mjs extension/tsconfig.json extension/media extension/README.md src lacuna.schema.json)

DID=0

if changed "$CLI_TAG" "${CLI_PATHS[@]}"; then
  echo "▶ CLI changed since ${CLI_TAG:-<no tag>} — releasing CLI ($BUMP)"
  bash scripts/release.sh "$BUMP"
  DID=1
else
  echo "• CLI unchanged since ${CLI_TAG} — skipping"
fi

if changed "$EXT_TAG" "${EXT_PATHS[@]}"; then
  if [ -z "$EXT_TAG" ]; then
    # First-ever extension release: ship the current version as-is (e.g. 0.1.0) rather than bumping
    # straight to 0.1.1. After this the ext-v* tag exists and normal bumping applies.
    echo "▶ First extension release — shipping current version as-is (no bump)"
    bash extension/scripts/release.sh --no-bump
  else
    echo "▶ Extension changed since ${EXT_TAG} — releasing extension ($BUMP)"
    bash extension/scripts/release.sh "$BUMP"
  fi
  DID=1
else
  echo "• Extension unchanged since ${EXT_TAG} — skipping"
fi

if [ "$DID" -eq 0 ]; then
  echo "Nothing to release — no CLI or extension changes since the last tags."
else
  echo "Done."
fi

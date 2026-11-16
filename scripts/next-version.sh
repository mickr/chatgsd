#!/bin/bash
# Prints the latest release tag and the next version for a bump:
#
#   scripts/next-version.sh patch   # v1.2.0 1.2.1
#
# Release tags are strict vMAJOR.MINOR.PATCH, and the highest version wins
# rather than the nearest tag: one commit can carry several (a manual minor
# release of an already released commit), and git describe keeps whichever
# lightweight tag it meets first.
set -euo pipefail

previous=$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
  sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)
if [ -z "$previous" ]; then
  echo "No vMAJOR.MINOR.PATCH release tag found" >&2
  exit 1
fi

IFS=. read -r major minor patch <<< "$previous"
case "${1:-patch}" in
  patch) next="$major.$minor.$((patch + 1))" ;;
  minor) next="$major.$((minor + 1)).0" ;;
  major) next="$((major + 1)).0.0" ;;
  *) echo "usage: $0 patch|minor|major" >&2; exit 2 ;;
esac
echo "v$previous $next"

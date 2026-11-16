#!/bin/bash
# Withdraws a version whose release run failed or was cancelled: deletes its
# draft release and its tag, so no tag points at a build that never shipped.
#
#   scripts/withdraw-release.sh v1.2.3   # needs GH_TOKEN and GITHUB_REPOSITORY
#
# Fails closed: unless GitHub's release list was read completely, nothing is
# deleted, and a published release keeps its tag. The list is used rather than
# the by-tag lookup because that one hides drafts.
set -euo pipefail
tag=${1:?usage: $0 <tag>}
: "${GITHUB_REPOSITORY:?}"

releases=$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" |
  jq -r --arg tag "$tag" '.[] | select(.tag_name == $tag) | "\(.id) \(.draft)"')

if grep -q ' false$' <<< "$releases"; then
  echo "$tag is published; leaving it."
  exit 0
fi
while read -r id _; do
  if [ -n "$id" ]; then
    gh api -X DELETE "repos/$GITHUB_REPOSITORY/releases/$id"
  fi
done <<< "$releases"
gh api -X DELETE "repos/$GITHUB_REPOSITORY/git/refs/tags/$tag"
echo "Withdrew $tag."

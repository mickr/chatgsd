#!/bin/bash
# Withdraws a version whose release run failed or was cancelled: deletes its
# draft release and its tag, so no tag points at a build that never shipped.
#
#   scripts/withdraw-release.sh v1.2.3 <commit>   # needs GH_TOKEN and GITHUB_REPOSITORY
#
# Fails closed: nothing is deleted unless GitHub was read successfully, the tag
# is on this run's commit (a reused version number belongs to another run), and
# the release isn't published. The release list is read rather than the by-tag
# lookup because that one hides drafts.
set -euo pipefail
usage="usage: $0 <tag> <commit>"
tag=${1:?$usage}
commit=${2:?$usage}
: "${GITHUB_REPOSITORY:?}"

tagged=$(gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/$tag" |
  jq -r --arg ref "refs/tags/$tag" '.[] | select(.ref == $ref) | .object.sha')
if [ "$tagged" != "$commit" ]; then
  echo "$tag isn't on ${commit:0:7} (it's on ${tagged:-no commit}); leaving it."
  exit 0
fi

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

#!/bin/bash
# Runs a command, trying again when it fails: the release runner sometimes
# can't reach GitHub for a few seconds. Only for commands that are safe to
# repeat.
#
#   scripts/retry.sh gh release edit v1.2.3 --draft=false
set -uo pipefail
attempts=5
for attempt in $(seq 1 "$attempts"); do
  "$@" && exit 0
  status=$?
  if [ "$attempt" -lt "$attempts" ]; then
    delay=$((attempt * 15))
    echo "Attempt $attempt of $attempts failed (exit $status); trying again in ${delay}s." >&2
    sleep "$delay"
  fi
done
echo "Gave up after $attempts attempts." >&2
exit "$status"

#!/bin/bash
# Release signing on Mars, a persistent Mac (unlike a fresh hosted runner).
# The Developer ID identity lives in a job-owned keychain that is appended to
# the user's search list (the default keychain is never changed) and removed
# afterwards, leaving the user's keychains as they were.
#
#   scripts/ci-signing.sh install   # needs SCRATCH_CERTIFICATE_BASE64/_PASSWORD
#                                   # and SCRATCH_NOTARY_API_KEY
#   scripts/ci-signing.sh remove
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
: "${RUNNER_TEMP:?}"
# Resolved, because the search list reports real paths (/var is /private/var).
keychain="$(cd "$RUNNER_TEMP" && pwd -P)/scratch-signing.keychain-db"
api_key="$RUNNER_TEMP/scratch-notary-key.p8"

# The user's keychain search list, one path per line, without our keychain.
search_list() {
  security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//' | grep -vxF "$keychain" || true
}

set_search_list() {
  local paths=()
  while IFS= read -r path; do [[ -n "$path" ]] && paths+=("$path"); done
  security list-keychains -d user -s "${paths[@]}"
}

case "${1:-}" in
  install)
    : "${SCRATCH_CERTIFICATE_BASE64:?Missing signing certificate secret}"
    : "${SCRATCH_CERTIFICATE_PASSWORD:?Missing certificate password secret}"
    : "${SCRATCH_NOTARY_API_KEY:?Missing notarization API key secret}"
    : "${APPLE_SIGNING_IDENTITY:?Missing signing identity}"
    : "${GITHUB_ENV:?}"
    umask 077
    certificate="$RUNNER_TEMP/scratch-certificate.p12"
    password=$(openssl rand -hex 32)
    echo "::add-mask::$password"
    printf '%s' "$SCRATCH_CERTIFICATE_BASE64" | base64 --decode > "$certificate"
    security create-keychain -p "$password" "$keychain"
    security set-keychain-settings -lut 7200 "$keychain"
    security unlock-keychain -p "$password" "$keychain"
    security import "$certificate" -P "$SCRATCH_CERTIFICATE_PASSWORD" -f pkcs12 \
      -k "$keychain" -T /usr/bin/codesign -T /usr/bin/security
    rm -f "$certificate"
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" > /dev/null
    { search_list; echo "$keychain"; } | set_search_list
    if ! security find-identity -v -p codesigning "$keychain" | grep -q "$APPLE_SIGNING_IDENTITY"; then
      echo "The certificate secret doesn't hold the pinned Developer ID identity" >&2
      exit 1
    fi
    # The App Store Connect key Tauri's notarization reads from a file.
    printf '%s\n' "$SCRATCH_NOTARY_API_KEY" > "$api_key"
    echo "APPLE_API_KEY_PATH=$api_key" >> "$GITHUB_ENV"
    ;;
  remove)
    # Re-read the list so concurrent changes by other jobs are kept.
    search_list | set_search_list
    security delete-keychain "$keychain" 2> /dev/null || true
    rm -f "$RUNNER_TEMP/scratch-certificate.p12" "$api_key"
    ;;
  *)
    echo "usage: $0 install|remove" >&2
    exit 2
    ;;
esac

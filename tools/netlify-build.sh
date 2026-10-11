#!/bin/sh
# The deploy-time check, run by Netlify as the build command.
#
# Nothing goes live that does not extend what is live now: the built document
# must be consistent, and must keep every key entry and revocation record of
# the LIVE site — what verifiers actually fetch — except as revocation allows.
# A failing production build leaves the live site as it is; a failing Deploy
# Preview fails the pull request's required check.
#
# Environment:
#   URL                    the production URL (set by Netlify), whose live
#                          state is fetched and compared
#   DID_PREVIOUS_DIR       a local copy of the previous state, instead of $URL
#   DID_ALLOW_NO_PREVIOUS  1 to deploy without a previous state (first deploy
#                          of a new site only; set by hand in Netlify)
#   DID_SITE, DID_CONFIG   default public/ and did.config.json
#   NODE                   default node
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
SITE=${DID_SITE:-public}
CONFIG=${DID_CONFIG:-$HERE/../did.config.json}
DOC=$SITE/.well-known/did.json

say() { printf 'netlify-build: %s\n' "$*" >&2; }
make_did() { "$NODE" "$HERE/make-did.mjs" --config "$CONFIG" --site "$SITE" "$@"; }

make_did --verify-file "$DOC" || exit 1

if [ -n "${DID_PREVIOUS_DIR:-}" ]; then
  previous=$DID_PREVIOUS_DIR
else
  previous=$(mktemp -d)/live
  trap 'rm -rf "$(dirname "$previous")"' EXIT
  if ! "$NODE" "$HERE/fetch-live.mjs" "${URL:-}" "$previous"; then
    if [ "${DID_ALLOW_NO_PREVIOUS:-}" = 1 ]; then
      say "no previous state (DID_ALLOW_NO_PREVIOUS=1)"
      say "OK"
      exit 0
    fi
    say "cannot fetch the live state from ${URL:-<URL unset>}; set DID_ALLOW_NO_PREVIOUS=1 for a first deploy"
    exit 1
  fi
fi

make_did --verify-file "$DOC" --previous "$previous" || exit 1
say "OK"

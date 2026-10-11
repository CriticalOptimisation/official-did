#!/bin/sh
# Applies one make-did.mjs operation to the DID document and pushes it to the
# branch Netlify publishes, for tools that change the document unattended.
#
# Changes are RE-APPLIED, NOT MERGED. Each round fetches, resets the working
# copy to the remote head, applies the operation, checks the result, commits
# and pushes. A push rejected as non-fast-forward means another tool published
# first: the round starts again from the new head, after a random pause, for
# as long as it takes. Every DID_PUBLISH_ALERT_EVERY rejections, one line is
# written to stderr and to syslog, for monitoring. Any other failure stops at
# once. The operations are idempotent and computed from the current document,
# so a retry adds to what the other tool published, and never conflicts.
#
# Secrets: the private key, when the operation needs one, comes on stdin and
# stays in memory. Git authentication is the environment's: the calling tool's
# own deploy key, through an SSH agent or GIT_SSH_COMMAND.
#
# Usage: DID_PUBLISH_WORKDIR=<clone> tools/publish.sh <make-did.mjs arguments>
# Environment:
#   DID_PUBLISH_WORKDIR      a clone of the repository, used by this script only
#   DID_PUBLISH_BRANCH       default main
#   DID_PUBLISH_ALERT_EVERY  default 10
#   DID_PUBLISH_PAUSE_MAX    longest random pause between rounds, in seconds; default 5
#   DID_PUBLISH_LOGGER       a command called with the alert line; default
#                            `logger -t did-publish` when logger exists
#   NODE                     default node
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
WORK=${DID_PUBLISH_WORKDIR:?DID_PUBLISH_WORKDIR must name a clone of the repository}
BRANCH=${DID_PUBLISH_BRANCH:-main}
EVERY=${DID_PUBLISH_ALERT_EVERY:-10}
PAUSE_MAX=${DID_PUBLISH_PAUSE_MAX:-5}

say() { printf 'publish: %s\n' "$*" >&2; }

alert() {
  say "$1"
  if [ -n "${DID_PUBLISH_LOGGER+set}" ]; then
    [ -n "$DID_PUBLISH_LOGGER" ] && "$DID_PUBLISH_LOGGER" "$1"
  elif command -v logger >/dev/null 2>&1; then
    logger -t did-publish "$1"
  fi
}

pause() {
  [ "$PAUSE_MAX" -gt 0 ] 2>/dev/null || return 0
  sleep "$(awk -v max="$PAUSE_MAX" 'BEGIN { srand(); print int(rand() * (max + 1)) }')"
}

# The private key, if the operation reads one from stdin, is read once and
# kept in memory for every round.
uses_stdin=0
previous=
for a in "$@"; do
  [ "$a" = - ] && [ "$previous" = --from-private ] && uses_stdin=1
  previous=$a
done
input=
[ "$uses_stdin" = 1 ] && input=$(cat)

apply() {
  if [ "$uses_stdin" = 1 ]; then
    printf '%s' "$input" | "$NODE" "$HERE/make-did.mjs" --config "$WORK/did.config.json" \
      --site "$WORK/public" --out "$WORK/public/.well-known/did.json" "$@"
  else
    "$NODE" "$HERE/make-did.mjs" --config "$WORK/did.config.json" \
      --site "$WORK/public" --out "$WORK/public/.well-known/did.json" "$@" </dev/null
  fi
}

errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
rejected=0
while :; do
  git -C "$WORK" fetch -q origin "$BRANCH" 2>"$errors" ||
    { say "fetch failed, not retried: $(tail -n 1 "$errors")"; exit 1; }
  git -C "$WORK" reset -q --hard "origin/$BRANCH" 2>"$errors" ||
    { say "reset failed, not retried: $(tail -n 1 "$errors")"; exit 1; }

  apply "$@"
  status=$?
  [ "$status" -eq 0 ] || { say "make-did.mjs failed, not retried"; exit "$status"; }
  "$NODE" "$HERE/make-did.mjs" --config "$WORK/did.config.json" --site "$WORK/public" \
    --verify-file "$WORK/public/.well-known/did.json" ||
    { say "the result does not verify, not published"; exit 1; }

  if [ -z "$(git -C "$WORK" status --porcelain -- public)" ]; then
    say "nothing to publish"
    exit 0
  fi
  git -C "$WORK" add -A -- public &&
    git -C "$WORK" commit -q -m "did: make-did.mjs $*" ||
    { say "commit failed, not retried"; exit 1; }

  result=$(git -C "$WORK" push --porcelain origin "HEAD:refs/heads/$BRANCH" 2>"$errors")
  if [ $? -eq 0 ]; then
    say "published $(git -C "$WORK" rev-parse HEAD) after $rejected rejected pushes"
    exit 0
  fi
  if printf '%s\n' "$result" | grep -Eq '^!.*\[rejected\] \((fetch first|non-fast-forward)\)$'; then
    rejected=$((rejected + 1))
    [ $((rejected % EVERY)) -eq 0 ] && alert "still retrying after $rejected rejected pushes ($*)"
    pause
    continue
  fi
  say "push failed, not retried: $(tail -n 1 "$errors")"
  exit 1
done

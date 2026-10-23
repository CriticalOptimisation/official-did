#!/bin/sh
# Applies one make-did.mjs operation to a domain's DID document, pushes it to
# the domain's data branch data/$DID_DOMAIN, then calls the domain's build
# hook, for tools that change the document unattended. It never writes to any
# other branch, and commits the data paths only.
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
# The domain's Netlify project builds `main`, so a push to a data branch does
# not trigger it: once the push is accepted, the build hook is called with a
# POST. If the hook fails, the change is on the branch but not live: an alert
# is logged and the exit code is 3; the caller calls the hook again.
#
# Secrets: the private key, when the operation needs one, comes on stdin and
# stays in memory. Git authentication is the environment's: the publishing
# server's own deploy key, through an SSH agent or GIT_SSH_COMMAND.
#
# Usage: DID_DOMAIN=<domain> DID_PUBLISH_WORKDIR=<clone> DID_PUBLISH_BUILD_HOOK=<url> \
#          tools/publish.sh <make-did.mjs arguments>
# Environment:
#   DID_DOMAIN               required; the branch is always data/$DID_DOMAIN
#   DID_PUBLISH_WORKDIR      required; a clone of data/$DID_DOMAIN, used by this
#                            script only, whose root is the site
#   DID_PUBLISH_BUILD_HOOK   required; the project's build hook
#   DID_PUBLISH_ALERT_EVERY  default 10
#   DID_PUBLISH_PAUSE_MAX    longest random pause between rounds, in seconds; default 5
#   DID_PUBLISH_LOGGER       a command called with the alert line; default
#                            `logger -t did-publish` when logger exists
#   NODE                     default node
# Exit codes: 0 published and deployed, or nothing to publish; 1 a failure,
# nothing pushed; 2 a usage error; 3 published, not deployed.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
EVERY=${DID_PUBLISH_ALERT_EVERY:-10}
PAUSE_MAX=${DID_PUBLISH_PAUSE_MAX:-5}

say() { printf 'publish: %s\n' "$*" >&2; }

for v in DID_DOMAIN DID_PUBLISH_WORKDIR DID_PUBLISH_BUILD_HOOK; do
  eval "[ -n \"\${$v:-}\" ]" || { say "$v is not set"; exit 2; }
done
WORK=$DID_PUBLISH_WORKDIR
HOOK=$DID_PUBLISH_BUILD_HOOK
DID="did:web:$DID_DOMAIN"
BRANCH="data/$DID_DOMAIN"
DOC=$WORK/.well-known/did.json
# The paths a data branch may hold, besides its .gitignore: the same
# expression as DATA_PATH in tools/build-site.mjs.
DATA_PATH='(\.well-known/did\.json|revocations/[A-Za-z0-9_-]{43}\.json|revocations/[A-Za-z0-9_-]{43}/[1-9][0-9]*\.(ots|tsr))'

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
    printf '%s' "$input" | "$NODE" "$HERE/make-did.mjs" --did "$DID" --site "$WORK" --out "$DOC" "$@"
  else
    "$NODE" "$HERE/make-did.mjs" --did "$DID" --site "$WORK" --out "$DOC" "$@" </dev/null
  fi
}

# The build hook, POSTed once; prints the reason of a failure.
deploy() {
  "$NODE" -e '
    fetch(process.argv[1], { method: "POST", signal: AbortSignal.timeout(30000) }).then(
      (r) => { if (!r.ok) { console.log(`HTTP ${r.status}`); process.exit(1); } },
      (e) => { console.log(e.cause?.code ?? e.message); process.exit(1); });' "$HOOK"
}

errors=$(mktemp)
porcelain=$(mktemp)
trap 'rm -f "$errors" "$porcelain"' EXIT
rejected=0
while :; do
  git -C "$WORK" fetch -q origin "refs/heads/$BRANCH" 2>"$errors" ||
    { say "fetch failed, not retried: $(tail -n 1 "$errors")"; exit 1; }
  git -C "$WORK" reset -q --hard FETCH_HEAD 2>"$errors" &&
    git -C "$WORK" clean -q -d -x -f 2>"$errors" ||
    { say "reset failed, not retried: $(tail -n 1 "$errors")"; exit 1; }

  apply "$@"
  status=$?
  [ "$status" -eq 0 ] || { say "make-did.mjs failed, not retried"; exit "$status"; }
  "$NODE" "$HERE/make-did.mjs" --did "$DID" --site "$WORK" --verify-file "$DOC" ||
    { say "the result does not verify, not published"; exit 1; }

  # Every change, ignored files included, must be on a data path.
  git -C "$WORK" status --porcelain -z --ignored --untracked-files=all >"$porcelain" 2>"$errors" ||
    { say "status failed, not retried: $(tail -n 1 "$errors")"; exit 1; }
  changes=$(tr '\0' '\n' <"$porcelain" | cut -c4-)
  if [ -z "$changes" ]; then
    say "nothing to publish"
    exit 0
  fi
  stray=$(printf '%s\n' "$changes" | grep -Evx "$DATA_PATH" | head -n 1)
  [ -z "$stray" ] || { say "$stray is not a data path, not published"; exit 1; }
  git -C "$WORK" add -A -- . &&
    git -C "$WORK" commit -q -m "did: make-did.mjs $*" ||
    { say "commit failed, not retried"; exit 1; }

  result=$(git -C "$WORK" push --porcelain origin "HEAD:refs/heads/$BRANCH" 2>"$errors")
  if [ $? -eq 0 ]; then
    head=$(git -C "$WORK" rev-parse HEAD)
    say "published $head after $rejected rejected pushes"
    reason=$(deploy) && exit 0
    alert "published $head, not deployed: build hook failed (${reason:-no reason given})"
    exit 3
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
exit 0

# --- Change History -------------------------------------------------------
# | PR     | Summary                                                       |
# |--------|---------------------------------------------------------------|
# | #6     | re-apply and push, retrying lost races without limit (#1)     |

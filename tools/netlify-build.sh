#!/bin/sh
# The build of one domain's site, run by Netlify as the build command of every
# domain's project. Every project builds `main`, so this code, and the
# configuration Netlify reads, always come from `main`; the domain's data
# comes from its branch data/$DID_DOMAIN, which is read as data only.
#
# 1. Fetches data/$DID_DOMAIN from the repository into a temporary tree.
# 2. Assembles the site in $DID_DIST with tools/build-site.mjs, which refuses
#    a tree holding anything but that domain's data.
# 3. The deploy-time check: nothing goes live that does not extend what is
#    live now. The built document must be consistent, and must keep every key
#    entry and revocation record of the domain's LIVE site — what verifiers
#    actually fetch — except as revocation allows. A failing production build
#    leaves the live site as it is; a failing Deploy Preview fails the pull
#    request's required check.
#
# Environment:
#   DID_DOMAIN             the domain; the DID is did:web:$DID_DOMAIN
#   DID_REDIRECT, DID_LOG  the project's other variables (see README.md)
#   URL                    the production URL (set by Netlify), whose live
#                          state is fetched and compared; its host name must
#                          be DID_DOMAIN
#   REPOSITORY_URL         the repository (set by Netlify)
#   DID_DATA_DIR           a local data tree, instead of fetching the branch
#   DID_PREVIOUS_DIR       a local copy of the previous state, instead of $URL
#   DID_ALLOW_NO_PREVIOUS  1 to deploy without a previous state (first deploy
#                          of a new domain only; set by hand in Netlify)
#   DID_DIST               the output directory, default dist
#   NODE                   default node
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
DIST=${DID_DIST:-dist}

say() { printf 'netlify-build: %s\n' "$*" >&2; }

[ -n "${DID_DOMAIN:-}" ] || { say "DID_DOMAIN is not set"; exit 1; }
# The same expression as HOST_NAME in tools/build-site.mjs.
printf '%s\n' "$DID_DOMAIN" | grep -Exq '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*' &&
  [ "${#DID_DOMAIN}" -le 253 ] ||
  { say "DID_DOMAIN $DID_DOMAIN is not a lower-case host name"; exit 1; }
[ -n "${DID_REDIRECT:-}" ] || { say "DID_REDIRECT is not set"; exit 1; }
[ -n "${URL:-}" ] || { say "URL is not set"; exit 1; }
host=$("$NODE" -e 'console.log(new URL(process.argv[1]).hostname)' "$URL" 2>/dev/null) ||
  { say "URL $URL is not a URL"; exit 1; }
[ "$host" = "$DID_DOMAIN" ] || { say "URL host $host is not DID_DOMAIN $DID_DOMAIN"; exit 1; }

DID="did:web:$DID_DOMAIN"
BRANCH="data/$DID_DOMAIN"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -n "${DID_DATA_DIR:-}" ]; then
  data=$DID_DATA_DIR
else
  [ -n "${REPOSITORY_URL:-}" ] || { say "REPOSITORY_URL is not set"; exit 1; }
  git init -q "$TMP/repo" || exit 1
  git ls-remote --exit-code "$REPOSITORY_URL" "refs/heads/$BRANCH" >/dev/null 2>"$TMP/errors"
  case $? in
    0) ;;
    2) say "no branch $BRANCH in $REPOSITORY_URL"; exit 1 ;;
    *) say "cannot read $REPOSITORY_URL: $(tail -n 1 "$TMP/errors")"; exit 1 ;;
  esac
  git -C "$TMP/repo" fetch -q --depth=1 "$REPOSITORY_URL" "refs/heads/$BRANCH" 2>"$TMP/errors" ||
    { say "cannot fetch $BRANCH from $REPOSITORY_URL: $(tail -n 1 "$TMP/errors")"; exit 1; }
  sha=$(git -C "$TMP/repo" rev-parse FETCH_HEAD) || exit 1
  # The branch's own .gitattributes must not hide or rewrite a file of the
  # archive: $GIT_DIR/info/attributes takes precedence over it.
  printf '* -export-ignore -export-subst\n' >"$TMP/repo/.git/info/attributes"
  mkdir "$TMP/data" &&
    git -C "$TMP/repo" archive "$sha" | tar -x -C "$TMP/data" ||
    { say "cannot extract $BRANCH at $sha"; exit 1; }
  say "$BRANCH at $sha"
  data=$TMP/data
fi

rm -rf "$DIST"
"$NODE" "$HERE/build-site.mjs" --data "$data" --out "$DIST" || exit 1

DOC=$DIST/.well-known/did.json
make_did() { "$NODE" "$HERE/make-did.mjs" --did "$DID" --site "$DIST" "$@"; }

make_did --verify-file "$DOC" || exit 1

if [ -n "${DID_PREVIOUS_DIR:-}" ]; then
  previous=$DID_PREVIOUS_DIR
else
  previous=$TMP/live
  if ! "$NODE" "$HERE/fetch-live.mjs" "$URL" "$previous"; then
    if [ "${DID_ALLOW_NO_PREVIOUS:-}" = 1 ]; then
      say "no previous state (DID_ALLOW_NO_PREVIOUS=1)"
      say "OK"
      exit 0
    fi
    say "cannot fetch the live state from $URL; set DID_ALLOW_NO_PREVIOUS=1 for a first deploy"
    exit 1
  fi
fi

make_did --verify-file "$DOC" --previous "$previous" || exit 1
say "OK"
exit 0

# --- Change History -------------------------------------------------------
# | PR     | Summary                                                       |
# |--------|---------------------------------------------------------------|
# | #6     | deploy-time check against the live state (#1)                 |

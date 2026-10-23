#!/bin/sh
# Creates the orphan commit of a new data branch, data/<domain>, in a local
# clone, and prints its SHA on stdout. IT PUSHES NOTHING: a maintainer reviews
# the commit and pushes it.
#
# The commit holds tools/data-branch.gitignore as its .gitignore and, from
# <source site> when one is given, the data paths of that directory byte for
# byte, and nothing else. A source is copied only if it IS the live state:
# each of its data files must be identical to the one the domain's live site
# serves, and each data file the live site serves must be in it. The live
# state is fetched from https://<domain>/, or read from DID_PREVIOUS_DIR.
#
# The working tree, the index and HEAD of <clone> are not touched: the commit
# is built with a temporary index.
#
# Usage: tools/data-branch.sh init <domain> <clone> [<source site>]
# Environment:
#   DID_PREVIOUS_DIR  a local copy of the live state, instead of https://<domain>/
#   NODE              default node
# Exit codes: 0 created; 1 refused or failed, nothing created; 2 usage error.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
# The paths a data branch may hold, besides its .gitignore: the same
# expression as DATA_PATH in tools/build-site.mjs.
DATA_PATH='(\.well-known/did\.json|revocations/[A-Za-z0-9_-]{43}\.json|revocations/[A-Za-z0-9_-]{43}/[1-9][0-9]*\.(ots|tsr))'

say() { printf 'data-branch: %s\n' "$*" >&2; }
usage() { say "$*"; say "usage: data-branch.sh init <domain> <clone> [<source site>]"; exit 2; }

[ "${1:-}" = init ] || usage "unknown command: ${1:-<none>}"
[ $# -ge 3 ] && [ $# -le 4 ] || usage "wrong number of arguments"
domain=$2
clone=$3
source=${4:-}
# The same expression as HOST_NAME in tools/build-site.mjs.
printf '%s\n' "$domain" | grep -Exq '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*' &&
  [ "${#domain}" -le 253 ] || usage "$domain is not a lower-case host name"
[ -z "$source" ] || [ -d "$source" ] || usage "$source is not a directory"
branch=data/$domain

git -C "$clone" rev-parse --git-dir >/dev/null 2>&1 || { say "$clone is not a git repository"; exit 1; }
if git -C "$clone" rev-parse --verify -q "refs/heads/$branch" >/dev/null; then
  say "$branch already exists in $clone"
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# The data files of a directory, one relative path per line, sorted.
data_files() {
  (cd "$1" && find . -type f | sed 's|^\./||' | grep -Ex "$DATA_PATH" | LC_ALL=C sort)
}

files=
if [ -n "$source" ]; then
  # A file under a data path that is not a regular file, such as a link.
  stray=$(cd "$source" && find .well-known revocations ! -type f ! -type d 2>/dev/null | head -n 1)
  [ -z "$stray" ] || { say "${stray#./} is not a regular file"; exit 1; }
  if [ -n "${DID_PREVIOUS_DIR:-}" ]; then
    live=$DID_PREVIOUS_DIR
  else
    live=$TMP/live
    "$NODE" "$HERE/fetch-live.mjs" "https://$domain/" "$live" ||
      { say "cannot fetch the live state from https://$domain/"; exit 1; }
  fi
  files=$(data_files "$source")
  for f in $files; do
    cmp -s "$source/$f" "$live/$f" || { say "$f differs from the live state"; exit 1; }
  done
  for f in $(data_files "$live"); do
    [ -f "$source/$f" ] || { say "$f is live but missing from $source"; exit 1; }
  done
fi

export GIT_INDEX_FILE="$TMP/index"
add() {
  sha=$(git -C "$clone" hash-object -w --no-filters "$1") &&
    git -C "$clone" update-index --add --cacheinfo "100644,$sha,$2"
}
add "$HERE/data-branch.gitignore" .gitignore || exit 1
for f in $files; do
  add "$(cd "$source" && pwd)/$f" "$f" || exit 1
done
tree=$(git -C "$clone" write-tree) || exit 1
if [ -n "$source" ]; then message="$branch: the data of $source, as live"; else message="$branch: a new domain"; fi
commit=$(git -C "$clone" commit-tree "$tree" -m "$message") || exit 1
# The empty old value refuses to overwrite a branch created meanwhile.
git -C "$clone" update-ref "refs/heads/$branch" "$commit" "" || exit 1
printf '%s\n' "$commit"
exit 0

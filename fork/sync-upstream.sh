#!/usr/bin/env bash
# Merges an upstream T3 Code release into the fork's main branch, then checks it.
#
#   fork/sync-upstream.sh                  # newest upstream nightly release
#   fork/sync-upstream.sh <tag>            # a specific upstream tag
#   fork/sync-upstream.sh upstream/main    # unreleased upstream work
#
# Merges rather than rebases, so release tags and deployed builds keep pointing
# at history that exists. Never pushes.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source fork/lib.sh

[ "$(git symbolic-ref --quiet --short HEAD || true)" = main ] || die "check out main first"
[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes"

git fetch --quiet origin main
git merge --quiet --ff-only origin/main || die "local main has diverged from origin/main; reconcile that first"

target="${1:-}"
if [ -z "$target" ]; then
  target="$(git ls-remote --tags --refs upstream 'refs/tags/v*-nightly.*' | sed 's#.*refs/tags/##' | sort -V | tail -n 1)"
  [ -n "$target" ] || die "found no upstream nightly tags"
fi
case "$target" in
  upstream/*) git fetch --quiet upstream "${target#upstream/}" ;;
  *) git fetch --quiet upstream "refs/tags/${target}:refs/tags/${target}" ;;
esac

if git merge-base --is-ancestor "$target" HEAD; then
  echo "main already contains $target; checking it."
else
  echo "Merging $target ($(git rev-list --count "HEAD..$target") upstream commits) into main..."
  if ! git merge --no-ff --no-edit -m "fork: sync upstream $target" "$target"; then
    echo
    echo "Conflicts:"
    git diff --name-only --diff-filter=U | sed 's/^/  /'
    cat <<EOF

Keep upstream's version of each conflict and re-apply the fork's change on top.
fork/README.md lists every fork change, and \`git grep -n "fork:"\` finds the
marked lines. rerere replays resolutions it has seen before. Then:

  git add <files> && git commit --no-edit
  fork/sync-upstream.sh $target    # re-run to install and check

or give up with \`git merge --abort\`.
EOF
    exit 1
  fi
fi

echo
echo "Fork changes on top of $target:"
git diff --stat "$target" HEAD

echo
echo "Installing dependencies..."
with_node vp i

echo
echo "Typechecking..."
with_node vp run typecheck

tests="$(git diff --name-only --diff-filter=d "$target" HEAD -- '*.test.ts' '*.test.tsx' | grep -v '\.browser\.test\.' || true)"
if [ -n "$tests" ]; then
  echo
  echo "Running tests the fork changed..."
  # shellcheck disable=SC2086 # one path per word
  with_node vp test run $tests
fi

cat <<EOF

Synced to $target. Next:
  git push origin main
  fork/release.sh
EOF

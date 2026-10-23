#!/usr/bin/env bash
# Builds a fork release and publishes it as a GitHub prerelease on the fork,
# where the desktop update button, Update everything, `t3 update`, and server
# self-updates find it.
#
#   fork/release.sh             # build and publish
#   fork/release.sh --dry-run   # build only
#   fork/release.sh --unsigned  # allow an unsigned macOS app (testing only)
#
# Builds the macOS app in a sibling worktree on this Mac while the Linux builder
# ($T3_FORK_LINUX_BUILDER, default dev1) builds the server archive. Signing
# settings live outside the repo; see fork/README.md.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
source fork/lib.sh

dry_run=false
unsigned=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --unsigned) unsigned=true ;;
    *) die "unknown option: $arg" ;;
  esac
done

[ "$(git symbolic-ref --quiet --short HEAD || true)" = main ] || die "check out main first"
[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes"
git fetch --quiet origin
sha="$(git rev-parse HEAD)"
[ "$sha" = "$(git rev-parse origin/main)" ] || die "push main first; the Linux builder checks out origin"
gh auth status >/dev/null 2>&1 || die "gh is not signed in"

# Upstream's nightly format with a fork build number of 100001 and up.
stable="$(git show HEAD:apps/server/package.json | sed -n 's/^  "version": "\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/p')"
[ -n "$stable" ] || die "could not read the version in apps/server/package.json"
last_build="$(git ls-remote --tags --refs origin 'refs/tags/v*-nightly.*' |
  sed -n 's#.*-nightly\.[0-9]\{8\}\.\([0-9]\{6,\}\)$#\1#p' | sort -n | tail -n 1)"
version="${stable%.*}.$((${stable##*.} + 1))-nightly.$(date -u +%Y%m%d).$((${last_build:-100000} + 1))"

release_env="${T3_FORK_RELEASE_ENV:-$HOME/.config/t3code-fork/release.env}"
if [ -f "$release_env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$release_env"
  set +a
fi
sign_flag=--signed
sign_label=signed
if [ -z "${T3CODE_MACOS_PROVISIONING_PROFILE:-}" ]; then
  $unsigned || die "no signing profile in $release_env (see fork/README.md); --unsigned builds without one"
  sign_flag=
  sign_label=unsigned
fi

build_dir="${T3_FORK_BUILD_DIR:-$(dirname "$root")/t3code-fork-build}"
out="$FORK_CACHE_DIR/releases/$version"
logs="$FORK_CACHE_DIR/logs/$version"
mkdir -p "$out" "$logs"
[ -d "$build_dir" ] || git worktree add --quiet --detach "$build_dir" "$sha"
git -C "$build_dir" checkout --quiet --force --detach "$sha"
# The same public T3 Connect configuration official builds embed (.env is gitignored).
cp .env.example "$build_dir/.env"

echo "Releasing $version from $(git rev-parse --short "$sha") ($sign_label)."
echo "Building the Linux server archive on $LINUX_BUILDER (log: $logs/linux.log)..."
ssh -o BatchMode=yes "$LINUX_BUILDER" bash -s -- "$FORK_REPO" "$sha" "$version" >"$logs/linux.log" 2>&1 <<'REMOTE' &
set -euo pipefail
repo="$1" sha="$2" version="$3"
dir="$HOME/t3code-fork-build"
[ -d "$dir/.git" ] || git clone --quiet "https://github.com/$repo.git" "$dir"
cd "$dir"
git fetch --quiet origin
git checkout --quiet --force --detach "$sha"
bash fork/build-linux-cli.sh "$version"
REMOTE
linux_pid=$!

echo "Building the macOS app (log: $logs/mac.log)..."
# errexit is ignored inside a subshell tested with ||, so capture its status instead.
set +e
(
  set -e
  cd "$build_dir"
  export T3CODE_DESKTOP_UPDATE_REPOSITORY="$FORK_REPO"
  rm -rf release
  with_node vp i
  with_node node scripts/update-release-package-versions.ts "$version"
  # shellcheck disable=SC2086 # empty when unsigned
  with_node node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
    --build-version "$version" $sign_flag --verbose
) >"$logs/mac.log" 2>&1
mac_status=$?
wait "$linux_pid"
linux_status=$?
set -e
git -C "$build_dir" checkout --quiet --force "$sha" # drop the version alignment
[ "$mac_status" -eq 0 ] || die "the macOS build failed; see $logs/mac.log"
[ "$linux_status" -eq 0 ] || die "the Linux build failed; see $logs/linux.log"

cp "$build_dir"/release/*.dmg "$build_dir"/release/*.zip "$build_dir"/release/*.blockmap "$out/"
for manifest in "$build_dir"/release/*.yml; do
  [ "$(basename "$manifest")" = builder-debug.yml ] || cp "$manifest" "$out/"
done
scp -q -o BatchMode=yes "$LINUX_BUILDER:t3code-fork-build/release-cli/t3-$version-linux-*.tar.gz" "$out/"
(cd "$out" && shasum -a 256 t3-*.tar.gz >SHA256SUMS)

base="$(git tag --merged "$sha" --list 'v*-nightly.*' | grep -Ev '\.[0-9]{6,}$' | sort -V | tail -n 1 || true)"
[ -n "$base" ] || die "no upstream nightly tag is merged into main; run fork/sync-upstream.sh"
notes="Upstream $base plus these fork changes:

$(git log --no-merges --format='- %s (%h)' "$base..$sha")"

if $dry_run; then
  echo
  echo "Dry run. v$version would publish these files from $out:"
  ls -1 "$out" | sed 's/^/  /'
  echo
  echo "$notes"
  exit 0
fi

gh release create "v$version" --repo "$FORK_REPO" --target "$sha" --prerelease \
  --title "T3 Code Fork $version" --notes "$notes" "$out"/*

cat <<EOF

Published https://github.com/$FORK_REPO/releases/tag/v$version
  This Mac: the update button in T3 Code installs it.
  Hosts: Update everything in the desktop app, or fork/switch-host.sh <host> $version
EOF

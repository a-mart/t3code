# Shared settings for the fork scripts. Sourced, not executed.
# Keep these scripts compatible with macOS's bash 3.2.

FORK_REPO="a-mart/t3code"
FORK_RELEASES_URL="https://github.com/${FORK_REPO}/releases/download"
LINUX_BUILDER="${T3_FORK_LINUX_BUILDER:-dev1}"
FORK_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/t3code-fork"

die() {
  printf '%s: %s\n' "$(basename "$0")" "$1" >&2
  exit 1
}

# package.json pins an exact Node, and the Linux single-executable build refuses
# any other. vp in system-first mode would hand out the system Node instead, so
# ask for the pinned version explicitly.
with_node() {
  local version
  version="$(sed -n 's/.*"node": *"\([0-9][0-9.]*\)".*/\1/p' "$(git rev-parse --show-toplevel)/package.json" | head -n 1)"
  [ -n "$version" ] || die "could not read engines.node from package.json"
  vp env exec --node "$version" "$@"
}

# Upstream CI builds the native helpers with the newest stable Rust, and their
# crates keep raising the minimum version, so builds refresh and use stable.
use_current_stable_rust() {
  rustup update stable --no-self-update
  export RUSTUP_TOOLCHAIN=stable
}

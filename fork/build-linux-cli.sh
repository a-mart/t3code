#!/usr/bin/env bash
# Builds the fork's Linux CLI archive on this machine: the runtime that
# `t3 update`, the background service, and server self-updates install.
# fork/release.sh runs it on the Linux builder over SSH; run it by hand there to
# debug a failed build. Mirrors the CLI archive steps of
# .github/workflows/release-desktop.yml.
#
#   fork/build-linux-cli.sh <version>
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source fork/lib.sh

version="${1:-}"
[ -n "$version" ] || die "usage: fork/build-linux-cli.sh <version>"
case "$(uname -m)" in
  x86_64) arch=x64 rust_target=x86_64-unknown-linux-gnu ;;
  aarch64) arch=arm64 rust_target=aarch64-unknown-linux-gnu ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

# User-level toolchains, installed on first use.
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:$HOME/.cargo/bin:$PATH"
command -v vp >/dev/null || curl -fsSL https://vite.plus | bash
command -v cargo >/dev/null ||
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
command -v vp >/dev/null || die "vp is not on PATH after installing it"

# The same public T3 Connect configuration official builds embed (.env is gitignored).
cp .env.example .env
export T3CODE_DESKTOP_UPDATE_REPOSITORY="$FORK_REPO"

with_node vp install --filter=t3... --filter=@t3tools/web... --filter=@t3tools/scripts...
with_node node scripts/update-release-package-versions.ts "$version"
with_node vp run --filter t3 build
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target "$rust_target"
# Fork versions use the nightly format, so they get nightly branding like upstream nightlies.
with_node node scripts/apply-web-brand-assets.ts nightly apps/server/dist/client
with_node node apps/server/scripts/cli.ts build-exe --verbose

monitor_dir="$(mktemp -d)"
mkdir -p "$monitor_dir/linux-$arch"
cp "native/resource-monitor/target/$rust_target/release/t3-resource-monitor" "$monitor_dir/linux-$arch/"
rm -rf release-cli
with_node node scripts/build-cli-archive.ts --platform linux --arch "$arch" --version "$version" \
  --resource-monitor-dir "$monitor_dir" --output-dir release-cli
archive="release-cli/t3-$version-linux-$arch.tar.gz"
with_node node scripts/smoke-cli-archive.ts --archive "$archive" --expect-version "$version"

git checkout --quiet -- . # drop the version alignment
echo "Built $archive"

#!/usr/bin/env bash
# Builds the fork's Windows x64 release on this Linux machine: the NSIS
# installer with its updater manifest, and the CLI archive. fork/release.sh runs
# it on the Linux builder after fork/build-linux-cli.sh, whose archive the
# installer embeds as its WSL runtime; run it by hand there to debug a failed
# build. Mirrors the Windows steps of .github/workflows/release-desktop.yml,
# unsigned.
#
#   fork/build-windows.sh <version> <linux-x64-cli-archive>
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source fork/lib.sh

version="${1:-}"
wsl_runtime="${2:-}"
[ -n "$version" ] && [ -f "$wsl_runtime" ] || die "usage: fork/build-windows.sh <version> <linux-x64-cli-archive>"
wsl_runtime="$(realpath "$wsl_runtime")"
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || die "build on x64 Linux; the installer embeds this host's Linux archive"
# The desktop bundle builds the Linux browser secret helper on any Linux host,
# and build-cli-archive packs Windows archives with zip.
command -v zip >/dev/null && pkg-config --exists libsecret-1 2>/dev/null ||
  die "install the build packages first: sudo apt-get install -y zip pkg-config libsecret-1-dev"

export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.vite-plus/bin:$HOME/.cargo/bin:$PATH"
use_current_stable_rust
rustup target add x86_64-pc-windows-msvc
command -v cargo-xwin >/dev/null || cargo install --locked cargo-xwin@0.23.1

# The same public T3 Connect configuration official builds embed (.env is gitignored).
cp .env.example .env
export T3CODE_DESKTOP_UPDATE_REPOSITORY="$FORK_REPO"

with_node vp install --filter=@t3tools/desktop... --filter=t3... --filter=@t3tools/scripts...
with_node node scripts/update-release-package-versions.ts "$version"
with_node vp run build:desktop
cargo xwin build --locked --release --manifest-path native/resource-monitor/Cargo.toml \
  --target x86_64-pc-windows-msvc
# Fork versions use the nightly format, so they get nightly branding like upstream nightlies.
with_node node scripts/apply-web-brand-assets.ts nightly apps/server/dist/client
with_node node apps/server/scripts/cli.ts build-exe --verbose --target win-x64

monitor_dir="$(mktemp -d)"
mkdir -p "$monitor_dir/win32-x64"
cp native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe "$monitor_dir/win32-x64/"
with_node node scripts/build-cli-archive.ts --platform win --arch x64 --version "$version" \
  --resource-monitor-dir "$monitor_dir" --output-dir release-cli

rm -rf release
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true with_node node scripts/build-desktop-artifact.ts \
  --platform win --target nsis --arch x64 --build-version "$version" --skip-build \
  --wsl-runtime "$wsl_runtime" --verbose

git checkout --quiet -- . # drop the version alignment
echo "Built release-cli/t3-$version-win32-x64.zip and the installer in release/"

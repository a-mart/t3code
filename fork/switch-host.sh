#!/usr/bin/env bash
# Moves a host's T3 Code background service onto fork releases, or updates it to
# a given fork release.
#
#   fork/switch-host.sh <ssh-host> [version]    # default: newest fork release
#
# Writes T3CODE_RELEASE_BASE_URL into the host's service.env so even an upstream
# launcher downloads from the fork, updates to the release, then reinstalls the
# service so the launcher is the fork's build too. Restarts T3 Code on the host,
# which interrupts its running agents.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

host="${1:-}"
[ -n "$host" ] || die "usage: fork/switch-host.sh <ssh-host> [version]"
version="${2:-$(gh release list --repo "$FORK_REPO" --limit 1 --json tagName --jq '.[0].tagName // ""')}"
version="${version#v}"
[ -n "$version" ] || die "found no fork release"

echo "Moving $host to T3 Code $version from $FORK_REPO..."
ssh -o BatchMode=yes "$host" bash -s -- "$version" "$FORK_RELEASES_URL" <<'REMOTE'
set -euo pipefail
version="$1" base_url="$2"
t3="$(command -v t3 || echo "$HOME/.local/bin/t3")"
[ -x "$t3" ] || { echo "t3 is not installed on $(hostname); see 'New host' in fork/README.md." >&2; exit 1; }
env_file="${T3CODE_HOME:-$HOME/.t3}/service.env"
touch "$env_file"
chmod 600 "$env_file"
if grep -q '^T3CODE_RELEASE_BASE_URL=' "$env_file"; then
  sed -i.bak "s#^T3CODE_RELEASE_BASE_URL=.*#T3CODE_RELEASE_BASE_URL=$base_url#" "$env_file"
  rm -f "$env_file.bak"
else
  printf 'T3CODE_RELEASE_BASE_URL=%s\n' "$base_url" >>"$env_file"
fi
export T3CODE_RELEASE_BASE_URL="$base_url"
"$t3" update "$version" --yes
"$t3" service install
"$t3" service status
REMOTE

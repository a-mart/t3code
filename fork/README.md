# Fork maintenance

This is Adam's fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It follows upstream's
nightly releases and adds a few customizations. Everything fork-specific lives in this directory, plus
the upstream lines listed under [Fork changes](#fork-changes).

## How it fits together

- **`main`** is the only long-lived branch: an upstream nightly release with the fork's commits on top.
  It moves forward by merging newer upstream releases, never by rebasing, so release tags and installed
  builds always point at history that still exists.
- **Remotes.** `origin` is `a-mart/t3code`. `upstream` is `pingdotgg/t3code`, with pushing disabled and
  tags fetched only when a script needs one.
- **Releases** are GitHub prereleases on `a-mart/t3code` holding the macOS app and the Windows x64
  installer with their updater manifests, the Linux and Windows server archives, and `SHA256SUMS`.
  Every T3 Code updater reads GitHub Releases, so once a build points at the fork, the desktop update
  button, **Update everything**, `t3 update`, and server self-updates all deliver fork builds.
- **Versions** use upstream's nightly format, `X.Y.Z-nightly.YYYYMMDD.N`, with fork build numbers `N`
  from 100001 up. `X.Y.Z` is the patch after upstream's last stable release and the date is the build
  day in UTC. Every channel check treats a fork build like an upstream nightly, and it sorts after any
  upstream nightly from the same day or earlier, so moving a host from upstream to the fork is an
  ordinary update.
- **GitHub Actions are disabled.** Upstream's workflows run on paid runners and publish to upstream's
  services. `fork/release.sh` builds releases on this Mac and dev1.

## Rules for fork changes

Upstream merges about 250 commits a day, and every upstream line the fork changes can conflict on a
later sync. So:

1. **Configure, then upstream, then fork.** Settings, themes, keybindings, provider instances, ACP
   agents, and project scripts need no fork code. If a code change would help every T3 Code user,
   propose it upstream. The fork carries only what upstream won't take, and drops a fork change once
   upstream ships an equivalent.
2. **Add, don't edit.** Put fork code in new files and connect it to upstream code with as few changed
   lines as possible. Never reformat, rename, or reorganize upstream code. Mark changed upstream lines
   with a `fork:` comment where the file allows one; `git grep -n "fork:"` lists them.
3. **Stay wire-compatible.** The store mobile apps, app.t3.codes, and upstream desktop builds all
   connect to fork servers. Changes to `packages/contracts` must be additive. Never change existing
   schemas or `ORCHESTRATION_PROTOCOL_VERSION`.
4. **No database migrations.** Migration numbers belong to upstream, so a fork migration will collide
   with a later upstream one. Keep fork state in settings or files of its own.
5. **One customization per commit**, titled `fork(<area>): …` and listed below.

## Fork changes

| Commit                                                              | Upstream files touched                                                                                                       | Why                                                                                                                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fork(release)`: fetch releases and updates from a-mart/t3code      | `packages/shared/src/cliRelease.ts`, `scripts/install.sh`, `scripts/install.ps1`, and the two tests that assert release URLs | Hosts download fork builds. When an upstream client asks a fork server to update, the download fails and the server keeps running the fork instead of turning into upstream. |
| `fork(desktop)`: sign the macOS app as com.adammartin.t3code        | `scripts/build-desktop-artifact.ts` and its test                                                                             | Signed builds need a provisioning profile for the bundle ID, and only the ID owner's Apple team can create one. Data locations don't depend on the bundle ID.                |
| `fork(docs)`: point agents at the fork guide                        | `AGENTS.md`, `CLAUDE.md`                                                                                                     | Agents read these rules before changing code; Claude Code loads this guide every session.                                                                                    |
| `fork(secrets)`: Bitwarden secrets for agents through `secure_bash` | The [extension seams](#extension-seams) below                                                                                | Agents use passwords, tokens, and SSH keys from Bitwarden without seeing them. Upstream has no secret store for agents. See [secrets.md](secrets.md).                        |
| `fork(agents)`: wait with Monitor, not a background shell command   | None (agent instructions seam)                                                                                               | A background shell command doesn't mark the thread Waiting, so a thread waiting on a backup or deploy looks finished. Monitor and subagents do mark it.                      |

## Extension seams

The `fork(secrets)` lines connect upstream registries to fork files, so the next fork feature edits
fork files only:

| To add             | Write it in                                                                                                                                                                        | Upstream reads it in                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A WebSocket RPC    | `packages/contracts/src/fork/rpc.ts` for the method and its scope, `apps/server/src/fork/ws.ts` for the handler, `apps/server/src/fork/rpcAggregates.ts` for tracing               | `packages/contracts/src/rpc.ts`, `clientRpcPermissions.ts`, and `index.ts`; `apps/server/src/ws.ts`, `auth/RpcAuthorization.ts`, and `observability/RpcInstrumentation.ts` |
| A server service   | `apps/server/src/fork/layer.ts`                                                                                                                                                    | `apps/server/src/server.ts`                                                                                                                                                |
| An agent tool      | A toolkit registered in `apps/server/src/fork/mcp.ts`, with its timeline label in `packages/shared/src/fork/t3McpTools.ts` and `packages/client-runtime/src/fork/t3ToolSummary.ts` | `apps/server/src/mcp/McpHttpServer.ts`, `packages/shared/src/t3McpToolPresentation.ts`, `packages/client-runtime/src/t3ToolSummary.ts`                                     |
| Agent instructions | `packages/provider-core/src/server/fork/orchestrationInstructions.ts`                                                                                                              | `packages/provider-core/src/server/orchestrationInstructions.ts`                                                                                                           |
| A settings page    | `apps/web/src/fork/settings.ts` and a route at `apps/web/src/routes/_chat.settings.<page>.tsx`; the dev server regenerates `routeTree.gen.ts`                                      | `apps/web/src/components/settings/settingsSearch.ts` and `SettingsSidebarNav.tsx`, `apps/web/src/routes/_chat.settings.tsx`                                                |

- Fork services are provided with the server's runtime services, not on the routes: each WebSocket
  connection builds its handlers from the request context, which sees only runtime services.
- `apps/server/src/fork/ws.ts` looks its services up with `Effect.serviceOption`, so upstream tests
  that build the WebSocket layer need no fork services.
- Fork RPC methods carry a `fork` prefix, such as `forkSecrets.getState`, so they can't collide with
  upstream names. Clients that don't know them never call them.
- Fork state lives in files under `~/.t3/userdata/fork/` and in server secrets named `fork-…`.

## Sync with upstream

```sh
fork/sync-upstream.sh                 # newest upstream nightly release
fork/sync-upstream.sh <tag>           # a specific upstream tag
fork/sync-upstream.sh upstream/main   # unreleased upstream work
```

The script merges into `main`, installs dependencies, typechecks, and runs the tests the fork changed.
It never pushes. On a conflict it stops and lists the files: keep upstream's version, re-apply the
fork's change, `git add` and `git commit --no-edit`, then re-run the script to check. `git rerere` is
on, so a resolution made once is replayed on later syncs.

Sync at least weekly; small merges are easy. Prefer nightly tags, which upstream has release-tested.

Never install a fork build whose upstream base is older than what a host last ran. Database migrations
only move forward.

## Release

One-time setup on this Mac:

1. In the [Apple Developer portal](https://developer.apple.com/account/resources/identifiers/list),
   register the App ID `com.adammartin.t3code` with **Associated Domains** enabled. Create a
   **Developer ID** provisioning profile for it with your Developer ID Application certificate, and save
   it as `~/.config/t3code-fork/t3code-fork.provisionprofile`.
2. Create `~/.config/t3code-fork/release.env`:

   ```sh
   T3CODE_APPLE_TEAM_ID=6CYCXAY4WL
   T3CODE_MACOS_PROVISIONING_PROFILE=$HOME/.config/t3code-fork/t3code-fork.provisionprofile
   # Optional notarization. Only Macs that download the DMG need it.
   # APPLE_API_KEY=$HOME/.config/t3code-fork/AuthKey_<key id>.p8
   # APPLE_API_KEY_ID=<key id>
   # APPLE_API_ISSUER=<issuer id>
   ```

Then, from a clean `main` that you have pushed:

```sh
fork/release.sh             # build and publish
fork/release.sh --dry-run   # build only
```

It builds the signed macOS app in the sibling worktree `../t3code-fork-build` while dev1 builds the
Linux server archive and then the Windows x64 release, which embeds that archive as its WSL runtime.
Then it publishes them all. Set `T3_FORK_LINUX_BUILDER` to build on another x64 Linux host. The builder
needs `sudo apt-get install -y zip pkg-config libsecret-1-dev patchelf` once. The first build on a builder
installs `vp`, Rust, and `cargo-xwin` for that user, and every build updates the builder's `stable`
Rust toolchain, since upstream builds with the newest one. Artifacts and logs are under
`~/.cache/t3code-fork`.

The Windows build is unsigned, and nothing in the release runs it on Windows before publishing. Upstream
checks its builds on a Windows runner with `scripts/verify-windows-desktop-artifact.ts`.

The Linux archive's resource monitor links against the builder's glibc, and dev1 runs Ubuntu 26.04. A
host on an older distribution may need an archive built on a machine running that release.

## Deploy

### This Mac

First install: quit T3 Code, open the DMG from the release, and drag **T3 Code (Nightly)** onto the
existing app in Applications. The fork reads the same `~/.t3` home and app data, so threads, projects,
settings, saved connections, the T3 Connect link, and this machine's environment identity carry over.
The app is now signed by you, so macOS asks once for Keychain access to **t3code Safe Storage** (choose
**Always Allow**) and again for privacy permissions such as screen recording or the microphone.

After that, the update button at the bottom of the sidebar installs new fork releases.

### dev1 and other hosts already running T3 Code

```sh
fork/switch-host.sh dev1              # newest fork release
fork/switch-host.sh dev1 <version>
```

It pins the host's service downloads to the fork in `~/.t3/service.env`, updates the host to the
release, and reinstalls the service so its launcher is the fork's build too. This restarts T3 Code on
the host. From then on, **Update everything** in the desktop app moves the host to the desktop's
version.

### A Windows PC

Run `T3-Code-<version>-x64.exe` from the release. It is unsigned, so SmartScreen warns first: choose
**More info**, then **Run anyway**. After that, the update button installs new fork releases. The fork
installs under its own app ID, so an upstream T3 Code install stays beside it until you uninstall it
from **Settings → Apps**. Both read the same `~\.t3` home.

### New host

Linux or Windows, since fork releases carry no macOS server archive:

```sh
curl -fsSL https://raw.githubusercontent.com/a-mart/t3code/main/scripts/install.sh | T3CODE_CHANNEL=nightly sh
t3 service install
t3 connect   # or pair over Tailscale: t3 pair --tailscale
```

On Windows, install the CLI from PowerShell. T3 Code has no background service on Windows, so the
desktop app is usually the simpler host there.

```powershell
$env:T3CODE_CHANNEL="nightly"; irm https://raw.githubusercontent.com/a-mart/t3code/main/scripts/install.ps1 | iex
```

### Phone

The App Store and Google Play apps connect to fork servers like upstream ones, over T3 Connect,
Tailscale, or LAN pairing. Fork builds embed the public T3 Connect configuration from `.env.example`,
so linked hosts stay reachable. The store apps track upstream closely: if upstream changes the
orchestration protocol, phones stop connecting to fork servers until the fork syncs past that change.

Update hosts from the desktop app. The phone looks for updates in upstream's releases, and an update it
offers fails to download and leaves the host as it was.

Fork features that need phone UI require a fork mobile build with its own bundle IDs, Expo project, and
push setup. None is set up.

## Roll back

- **This Mac:** install an upstream nightly from
  [upstream releases](https://github.com/pingdotgg/t3code/releases) at least as new as the fork build's
  upstream base, which its release notes name. macOS asks for permissions again, since that app has a
  different signer and bundle ID.
- **A host:**

  ```sh
  sed -i '/^T3CODE_RELEASE_BASE_URL=/d' ~/.t3/service.env
  T3CODE_RELEASE_BASE_URL=https://github.com/pingdotgg/t3code/releases/download \
    t3 update <upstream version> --allow-downgrade --yes
  t3 service install --allow-downgrade
  ```

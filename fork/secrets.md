# Secrets for agents

Agents can run commands that use passwords, tokens, and SSH keys from Bitwarden without seeing the
values. You connect Bitwarden on a host, choose which collections to sync, and grant each secret to
the projects whose agents may use it. Agents see only aliases such as `PROD_DB`. A command that needs a
value runs through the `secure_bash` tool, which puts the value in an environment variable named after
the alias and removes it from the output before the agent reads it.

This is the Bitwarden Password Manager, not Bitwarden Secrets Manager.

## Set up

1. In **Settings → Secrets**, select **Install Bitwarden CLI**. T3 downloads the official `bw` from
   Bitwarden's GitHub releases onto the host, checks it against a SHA-256 pinned in T3, and keeps it
   in its data folder. Each T3 update can pin a newer `bw`; **Update** appears next to the CLI when
   one is available. A `bw` you installed yourself, with Homebrew or npm, works too; on Windows, only a
   `bw.exe`, so use T3's copy rather than npm's. T3 keeps its own
   `bw` login under `~/.t3/userdata/bitwarden-cli`, so it never touches yours, and unlocking one never
   locks the other.
2. Use a dedicated Bitwarden account that can see only what agents should reach, for example a member
   of one organization collection.
3. In **Settings → Secrets**, choose the server, then run the sign-in command shown there once in a
   terminal on the host and sign in as that account. A terminal in any T3 project on the host works.
   On Windows, the command is for PowerShell. For an SSO account, add `--sso` after `login`. Select
   **Check again**, then unlock with the master password.
4. Under **Bitwarden collections**, choose the collections to sync and select **Save and sync**.
   Logins share their password, secure notes their text, and SSH keys their private key.
5. Under **Secrets**, open each secret's project menu and grant it to projects, or to **All projects**.
   New secrets start with no projects. Rename an alias if you like; it is also the variable name.
6. To let agents save new secrets, choose a collection under **Where agents save new secrets**. The
   account T3 signs in with needs permission to edit items in it.

Settings → Secrets acts on one host at a time. Pick the host in the scope menu at the top of the page.

## How agents use secrets

- `list_secrets` lists the aliases granted to the thread's project.
- `secure_bash` runs a bash command on the host, in the project folder, with the requested secrets in
  its environment. SSH key secrets are also loaded into an ssh-agent for that command, and
  `$T3_ASKPASS` answers password prompts from `ssh`, `sudo -A`, and `git` without a terminal.
- Secret-backed commands need the thread in full-access mode.
- Every call appears in the thread as **Ran a command with secrets**.
- Output reaches the agent with each value replaced by `[redacted:ALIAS]`, including its base64
  (even wrapped across lines), hex, URL, and JSON encodings. When a value is too short or simple to
  find safely, as with a PIN, the whole output stream is withheld instead. Output over 1 MiB per
  stream is withheld too.
- Locking Bitwarden, removing a grant, or stopping the agent's turn stops the commands using it.
- A value someone gave the agent through a T3 secret request can be passed to `secure_bash` the same
  way, without Bitwarden.
- `save_secret` keeps a new credential without the agent seeing it: one you type when the agent asks
  through a secret request, or one a command creates, such as a generated password or a new API key.
  It becomes a Bitwarden login or secure note in the collection you chose, granted to the agent's
  project, and shows up under **Secrets** like any other. A command that fails saves nothing.
- A private key pasted into a secret request loses its line breaks, since the field is a single
  line. T3 restores them, both when it saves the key and when a command uses one already saved that
  way.

## Sandbox

Turn on **Run secret commands in a sandbox** to run secret-backed commands inside
[nono](https://github.com/nolabs-ai/nono). The first time, T3 downloads the official nono release
from GitHub, checks it against a SHA-256 pinned in T3, and keeps it in its data folder. **Update**
appears when a T3 update pins a newer nono. A nono already on the host's PATH works too.

In the sandbox, a command:

- starts from a clean environment instead of the server's, with an empty home folder that is deleted
  when it ends;
- can write only to the project folder, including a worktree's git directory, and to temporary
  folders: its own, deleted when it ends, and the system's shared ones such as `/tmp`;
- can't read your home folder, except the PATH folders that hold your tools and
  `~/.ssh/known_hosts` and `~/.ssh/config`, so your SSH keys and other logins stay out of reach;
- can still reach the network.

A command that signs in with a secret, such as `docker login`, leaves nothing behind, and a command
can authenticate only with the secrets it was given. While the setting is on, nothing runs without
nono: if nono stops working, secret-backed commands fail until you fix it or turn the sandbox off.
Each command starts about 50 ms slower. Linux hosts need a kernel with Landlock; WSL's kernel has it,
so a WSL environment works like any Linux host.

### Windows

nono doesn't run on Windows, so there every secret-backed command runs in Docker, as in Forge, and the
sandbox switch is replaced by the Docker status. Install Docker Desktop with Linux containers, start
it, then select **Install secure runner** in **Settings → Secrets**. T3 builds its runner image in
Docker; the first build downloads about 400 MB and takes a few minutes.

In Docker, a command:

- runs in a Debian container with bash, git, ssh, curl, jq, rsync, node, npm, pnpm, python3, psql, and
  build tools, as an unprivileged user with a read-only system;
- sees only the project folder, at `/workspace`, plus a linked worktree's git directory;
- starts from a clean environment with only the secrets it asked for, which never appear in Docker's
  settings or logs;
- gets a copy of `~/.ssh/known_hosts` and `~/.ssh/config`, but none of your logins or SSH keys.

Each thread gets one container, which its subagents share, so the home folder and anything installed
outside the project carry over from command to command. The container is deleted when Bitwarden locks
or signs out, when a secret it received is revoked, after an hour without commands, after a
`save_secret` command that creates a credential, and when T3 stops; if T3 crashes, it ends itself
within seconds. Nothing runs outside Docker: while Docker Desktop
is stopped, secret-backed commands fail.

## Locking and restarts

The unlocked session lives in the server's memory, so a restart leaves Bitwarden locked. Shutting the
server down locks the vault.

Turn on **Stay unlocked across restarts** if scheduled tasks need secrets after a restart. The session
key is then saved in T3's data folder, where any process running as your user can read it.

## Connections

Unlocking works from the host itself, over Tailscale, or over HTTPS. It is refused over T3 Connect,
where Cloudflare's edge decrypts the traffic, and over unencrypted LAN or internet connections. The
App Store and Google Play apps can't show this page, but threads you drive from your phone can still
use secrets.

## What this protects, and what it doesn't

Values stay out of prompts, tool arguments, transcripts, logs, and command output, which prevents
accidental disclosure by an agent doing its job. It does not contain a hostile agent: a full-access
agent has its own shell, and a command can send a value anywhere it can reach, since only the output
returned to the agent is filtered. The sandbox limits what a secret-backed command can touch, but
the agent's own shell runs outside it. Grant each project only what it needs, and keep the agent
account separate from your own.

On Windows, secret-backed commands need Docker Desktop; see [Windows](#windows).

## Troubleshooting

| Message                                        | What to do                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| CLI needed                                     | Select **Install Bitwarden CLI**, or install `bw` yourself and select **Check again**.              |
| T3 couldn't install the Bitwarden CLI          | Check that the host can reach github.com, then try again.                                           |
| This Bitwarden CLI can't keep a separate login | That `bw` stores its data in a `bw-data` folder beside it. Install it with Homebrew or npm instead. |
| Still not signed in after running the command  | Run the exact command from Settings, on that host. A plain `bw login` signs in your own `bw`.       |
| Bitwarden didn't unlock                        | Check the master password.                                                                          |
| An agent reports a secret isn't granted        | Grant it to the thread's project in Settings → Secrets.                                             |
| An agent can't save a secret                   | Choose **Where agents save new secrets**, and check the account can edit items in that collection.  |
| nono can't sandbox commands on this host       | Turn the sandbox off and on again to reinstall T3's copy. On Linux, the kernel needs Landlock.      |
| T3 couldn't install nono                       | Check that the host can reach github.com, then try again.                                           |
| A sandboxed command reports a permission error | It reached outside the project or used a host login. Pass the credential as a secret instead.       |
| Docker Desktop isn't running on this host      | Start Docker Desktop with Linux containers, then select **Check again**.                            |
| T3 couldn't build its secure runner            | Check that Docker Desktop is running and can reach Docker Hub, then try again.                      |

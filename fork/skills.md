# Skills and instructions for every host

One git repo, the fleet repo, holds the skills and global instructions every agent on every host
should have. Each host's T3 server pulls it when it starts and every 15 minutes, then links each
skill into the folders its providers read and writes the instructions into Claude's and Codex's
global instruction files. Agents add skills to it with the `save_global_skill` tool.

## Set up

1. Create a private GitHub repo (Adam's is `a-mart/fleet`). Make sure every host can clone it with
   its own git login: on a host with the GitHub CLI, `gh auth login`, then `gh auth setup-git`.
2. On each host, in **Settings → Skills**, enter the repository (`owner/name` or any git URL), a short
   host name and any tags, then **Save**. The host name defaults to the environment's name as
   lowercase words joined by hyphens.
3. **Sync now** pulls one host; **Sync all hosts** pulls every host this client is connected to.

## The repo

```
AGENTS.md                 rules for agents working in the repo
instructions/AGENTS.md    shared instructions for every host
instructions/hosts/<host>.md   added after the shared part on that host
skills/<name>/SKILL.md    a skill, with optional scripts/, references/, assets/
```

A skill's frontmatter can limit where it goes:

```yaml
hosts: [mac, tag:gpu] # host names or tags; default every host
providers: [claude, codex] # default every provider
requires: [gh, python3] # commands it runs; hosts without one skip it
```

Settings shows why a skill is skipped on a host. A provider limit picks folders, and providers share
some: Grok and Cursor also read `~/.claude/skills`, and Cursor reads `~/.codex/skills`.

## Where things go on a host

| What         | Where                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills       | Links in `~/.agents/skills` (Codex, Grok, Cursor, fx), each Claude config folder's `skills`, and `~/.gemini/config/skills` (Antigravity). The last two only when the Claude or `~/.gemini` folder exists. Directory junctions on Windows. |
| Instructions | Each Claude config folder's `CLAUDE.md` and `$CODEX_HOME/AGENTS.md`. Other providers' instruction files aren't managed.                                                                                                                   |
| T3's copy    | `~/.t3/userdata/fork/skills/`: the clone, the built-in `t3-skills` skill, settings, and the list of links and files T3 created.                                                                                                           |

T3 changes and removes only what it created. A skill folder or instruction file already there is
taken over only when it is empty or already matches the repo; otherwise Settings shows a conflict
and leaves it alone. An instruction file T3 wrote and you then edited on the host is also a
conflict, so a local edit is never lost. To resolve one, back up the file, then make it match the
repo or delete it.

To move an existing skill into the repo, commit it, then delete the host's copy; the next sync links
the repo's version in its place. A skill that is a clone of someone else's repo, updated with
`git pull`, is better left on its host.

## Agents

- The built-in **t3-skills** skill tells agents what deserves a skill, whether it belongs to a project
  (`.agents/skills` in that repo) or every host, and the format.
- **`save_global_skill`** writes a skill into the clone, commits it with the thread id in the message,
  and pushes. It refuses files that look like they contain a token or private key. There's no
  approval step: review recent commits in the repo and `git revert` what you don't want.

## Turn it off

In **Settings → Skills**, **Disconnect** removes every link T3 made on that host. Instruction files
stay as they are, no longer managed.

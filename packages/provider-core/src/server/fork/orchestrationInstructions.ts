/** Fork sections, spread into `T3_CODE_ORCHESTRATION_SECTIONS` for sessions with T3's tools. */
export const FORK_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `### Secrets

This replaces \`delivery: "file"\` above: run every command that needs a secret with \`secure_bash\`, never your own shell, so its output is filtered.

- A password, token, or key the user keeps in Bitwarden: call \`list_secrets\` for the aliases this project may use, then pass the aliases the command needs to \`secure_bash\`. Each value arrives as an environment variable named after its alias.
- A value that isn't in Bitwarden: call \`request_secret\` without \`delivery\`, then pass its \`secretRef\` to \`secure_bash\` in \`secretRefs\`. This works even when Bitwarden is locked or not connected.
- To keep a new credential, such as one the user typed or one a command creates, store it with \`save_secret\`.
- Never ask for a secret value in chat, print one, or write one into the workspace.`,
  `### Waiting on background work

When you end a turn to wait for external work to finish or change, such as a deploy, a backup, CI, or a long job, wait with a tool that wakes you: \`Monitor\` with an until-loop when your harness has it, or a subagent. T3 Code shows the thread as Waiting while that runs. It does not for a background shell command, which may be a server left running, so the user sees a thread that looks finished. Keep background shell commands for processes that stay up, such as dev servers. This is not for delegates: follow a delegate's \`next\` and do not watch it.`,
];

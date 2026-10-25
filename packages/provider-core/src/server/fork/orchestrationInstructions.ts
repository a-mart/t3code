/** Fork sections, spread into `T3_CODE_ORCHESTRATION_SECTIONS` for sessions with T3's tools. */
export const FORK_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `### Secrets

When a command needs a password, token, or key the user keeps in Bitwarden, call \`list_secrets\` for the aliases this project may use, then run the command with \`secure_bash\`, passing the aliases it needs. Each value arrives as an environment variable named after its alias and is filtered from the output. To keep a new credential, such as one the user gives you through \`request_secret\` or one a command creates, store it with \`save_secret\` instead of handling the value. Never ask for a secret value in chat, print one, or write one into the workspace.`,
  `### Waiting on background work

When you end a turn to wait for something to finish or change, such as a deploy, a backup, CI, or a long job, wait with a tool that wakes you: \`Monitor\` with an until-loop when your harness has it, or a subagent. T3 Code shows the thread as Waiting while that runs. It does not for a background shell command, which may be a server left running, so the user sees a thread that looks finished. Keep background shell commands for processes that stay up, such as dev servers.`,
];

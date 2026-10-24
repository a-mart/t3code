/** Fork sections, spread into `T3_CODE_ORCHESTRATION_SECTIONS` for sessions with T3's tools. */
export const FORK_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `### Secrets

When a command needs a password, token, or key the user keeps in Bitwarden, call \`list_secrets\` for the aliases this project may use, then run the command with \`secure_bash\`, passing the aliases it needs. Each value arrives as an environment variable named after its alias and is filtered from the output. To keep a new credential, such as one the user gives you through \`request_secret\` or one a command creates, store it with \`save_secret\` instead of handling the value. Never ask for a secret value in chat, print one, or write one into the workspace.`,
];

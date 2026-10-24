import type { ForkT3McpToolSummaryAction } from "@t3tools/shared/t3McpToolPresentation";

/** Group summaries for the fork's T3 tools, such as "Ran 2 commands with secrets". */
export function forkT3ToolSummaryLabel(
  action: ForkT3McpToolSummaryAction,
  completedCount: number,
  selectedCount: number,
): string {
  const tried = completedCount === 0;
  switch (action) {
    case "fork-secure-command": {
      const commands = `${selectedCount} ${selectedCount === 1 ? "command" : "commands"} with secrets`;
      return tried ? `Tried to run ${commands}` : `Ran ${commands}`;
    }
    case "fork-secrets-list":
      return tried ? "Tried to list available secrets" : "Listed available secrets";
    case "fork-secret-save": {
      const secrets = `${selectedCount} ${selectedCount === 1 ? "secret" : "secrets"}`;
      return tried ? `Tried to save ${secrets}` : `Saved ${secrets}`;
    }
  }
}

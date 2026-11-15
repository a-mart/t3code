import type { T3McpToolDefinition } from "../t3McpToolPresentation.ts";

/**
 * Timeline presentation for the fork's tools on T3's MCP server. The upstream
 * tables spread these in; summaries for them come from `forkT3ToolSummaryLabel`
 * in client-runtime.
 */
export type ForkT3McpToolSummaryAction =
  | "fork-secure-command"
  | "fork-secrets-list"
  | "fork-secret-save"
  | "fork-skill-save";

export const FORK_T3_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  secure_bash: {
    displayName: "Run a command with secrets",
    labels: ["Run", "Running", "Ran", "a command with secrets"],
    icon: "t3-code",
    summaryAction: "fork-secure-command",
  },
  list_secrets: {
    displayName: "List available secrets",
    labels: ["List", "Listing", "Listed", "available secrets"],
    icon: "t3-code",
    summaryAction: "fork-secrets-list",
  },
  save_secret: {
    displayName: "Save a secret",
    labels: ["Save", "Saving", "Saved", "a secret"],
    icon: "t3-code",
    summaryAction: "fork-secret-save",
  },
  save_global_skill: {
    displayName: "Save a global skill",
    labels: ["Save", "Saving", "Saved", "a global skill"],
    icon: "t3-code",
    summaryAction: "fork-skill-save",
  },
};

export const isForkT3McpToolSummaryAction = (
  action: string,
): action is ForkT3McpToolSummaryAction =>
  action === "fork-secure-command" ||
  action === "fork-secrets-list" ||
  action === "fork-secret-save" ||
  action === "fork-skill-save";

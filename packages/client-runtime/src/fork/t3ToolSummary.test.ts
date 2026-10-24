import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { describe, expect, it } from "vite-plus/test";

import { summarizeT3ToolCalls } from "../t3ToolSummary.ts";

describe("fork T3 tool summaries", () => {
  it("presents secure_bash as a T3 tool under any provider's naming", () => {
    for (const name of ["mcp__t3-code__secure_bash", "t3-code.secure_bash", "secure_bash"]) {
      expect(resolveT3McpToolDefinition(name)?.displayName).toBe("Run a command with secrets");
    }
  });

  it("summarizes commands run with secrets", () => {
    const completed = { input: {}, output: {}, outcome: "completed" as const };
    expect(summarizeT3ToolCalls("fork-secure-command", [completed, completed])).toEqual({
      label: "Ran 2 commands with secrets",
      failedCount: 0,
    });
    expect(
      summarizeT3ToolCalls("fork-secure-command", [{ ...completed, outcome: "failed" }]),
    ).toEqual({ label: "Tried to run 1 command with secrets", failedCount: 1 });
    expect(summarizeT3ToolCalls("fork-secrets-list", [completed]).label).toBe(
      "Listed available secrets",
    );
    expect(summarizeT3ToolCalls("fork-secret-save", [completed]).label).toBe("Saved 1 secret");
  });
});

import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const SaveGlobalSkillTool = Tool.make("save_global_skill", {
  description: [
    "Save a skill for every host: it's committed to the user's fleet repo and reaches every agent on every T3 host within 15 minutes. Read the t3-skills skill first; use this only for skills about the user, their tools, or how they work that help in any repo. Project skills go in the repo's .agents/skills instead.",
    "- name: the skill's folder name, lowercase letters, digits and hyphens.",
    "- files: every file in the skill, with paths relative to its folder. SKILL.md is required, with frontmatter whose name matches and whose description says what it does, when to use it, and the phrases the user would say.",
    "- Saving an existing name replaces the whole skill, so include all of its files.",
    "- Files that look like they contain a secret are refused; name the secure_bash alias instead.",
    "- Result: saved, the commit, and status on this host (linked, or why it's skipped here).",
  ].join("\n"),
  parameters: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        content: Schema.String,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  }),
  success: Schema.Struct({
    saved: Schema.Boolean,
    commit: Schema.NullOr(Schema.String),
    status: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Save a global skill")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const SkillsToolkit = Toolkit.make(SaveGlobalSkillTool);

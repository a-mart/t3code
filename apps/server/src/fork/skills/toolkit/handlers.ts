import { OrchestratorMcpFailure, type ForkSkillsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { loadCaller } from "../../../mcp/threadAccess.ts";
import * as SkillsService from "../SkillsService.ts";
import { SkillsToolkit } from "./tools.ts";

const failureCode = (reason: ForkSkillsError["reason"]): OrchestratorMcpFailure["code"] => {
  switch (reason) {
    case "not_configured":
      return "capability_denied";
    case "git_failed":
    case "persist_failed":
    case "dirty":
      return "orchestration_error";
    default:
      return "invalid_request";
  }
};

// Optional, so upstream harnesses that build the MCP tools layer need no fork services.
const skillsService = Effect.serviceOption(SkillsService.SkillsService).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.die(new Error("The skills service isn't running on this server.")),
      onSome: Effect.succeed,
    }),
  ),
);

export const layer = McpToolAccess.toLayer(SkillsToolkit, {
  save_global_skill: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* loadCaller();
      const skills = yield* skillsService;
      const state = yield* skills
        .saveGlobal({ name: input.name, files: input.files, threadId: context.caller?.id })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: failureCode(error.reason),
                message:
                  error.reason === "not_configured"
                    ? "No fleet repo is set up on this host. Ask the user to set one in Settings → Skills."
                    : error.message,
              }),
          ),
        );
      const skill = state.skills.find((entry) => entry.name === input.name);
      return {
        saved: true,
        commit: state.commit,
        status:
          skill === undefined
            ? "saved"
            : skill.status === "linked"
              ? "linked on this host"
              : `${skill.status} on this host: ${skill.reason ?? "see Settings → Skills"}`,
      };
    }),
  ),
});

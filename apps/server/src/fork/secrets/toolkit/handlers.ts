import { OrchestratorMcpFailure, type ProjectId, type SecretRef } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { isLiveCallerShell } from "../../../mcp/OrchestratorMcpService.ts";
import { assertFullAccess, assertLiveCaller, loadCaller } from "../../../mcp/threadAccess.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as SecretsService from "../SecretsService.ts";
import { SECURE_BASH_DEFAULT_TIMEOUT_SECONDS, SecretsToolkit } from "./tools.ts";

const FULL_ACCESS_REQUIRED =
  "secure_bash and save_secret use the user's secrets, so they need a thread in full-access runtime mode and default (not plan) interaction mode. Ask the user to switch the thread's mode.";

const failureCode = (
  reason: SecretsService.SecureCommandError["reason"],
): OrchestratorMcpFailure["code"] => {
  switch (reason) {
    case "not_granted":
      return "capability_denied";
    case "run_stopped":
      return "parent_not_active";
    case "no_secrets":
    case "unknown_secret":
    case "invalid_name":
    case "duplicate_secret":
    case "too_many_secrets":
    case "value_too_large":
    case "value_invalid":
    case "redaction_budget":
    case "invalid_alias":
    case "alias_taken":
    case "value_empty":
    case "value_multiline":
    case "sandbox_dropped_name":
      return "invalid_request";
    case "save_not_configured":
    case "sandbox_unavailable":
    case "sandbox_path_unsupported":
    case "runner_unavailable":
      return "capability_denied";
    default:
      return "orchestration_error";
  }
};

const toMcpFailure = (error: SecretsService.SecureCommandError) =>
  new OrchestratorMcpFailure({ code: failureCode(error.reason), message: error.message });

/** The calling thread, which `readsAsCaller` and `actsAsCaller` guarantee exists. */
const callerThread = Effect.gen(function* () {
  const context = yield* loadCaller();
  if (context.caller === undefined || context.scope.thread === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message:
        "Secrets belong to a project, so this tool needs an agent running inside a T3 thread.",
    });
  }
  return { context, caller: context.caller, thread: context.scope.thread };
});

/**
 * What a tool that uses secret values needs from its caller: a full-access
 * thread with a workspace, a liveness check for its run, and a re-check of its
 * authority to run right before anything starts.
 */
const callerExecution = Effect.gen(function* () {
  const { context, caller, thread } = yield* callerThread;
  yield* assertFullAccess(context, FULL_ACCESS_REQUIRED);
  const cwd = yield* threadWorkspaceRoot(caller.id);
  if (cwd === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "This thread's workspace no longer exists.",
    });
  }
  // The run admitted now; a later run in the same thread doesn't keep this command alive.
  const admittedRunId = caller.activeRunId;
  const stillLive = context.threads.getThreadShell(caller.id).pipe(
    Effect.map(
      (shell) =>
        isLiveCallerShell(shell, thread.providerInstanceId) &&
        (admittedRunId === null ||
          shell?.activeRunId === null ||
          shell?.activeRunId === admittedRunId),
    ),
    // A failed read isn't proof the run ended; the command's timeout still bounds it.
    Effect.orElseSucceed(() => true),
  );
  const callerServices = yield* Effect.context<
    McpInvocationContext.McpInvocationContext | ThreadManagementService.ThreadManagementService
  >();
  const authorize = loadCaller().pipe(
    Effect.tap(assertLiveCaller),
    Effect.tap((latest) => assertFullAccess(latest, FULL_ACCESS_REQUIRED)),
    Effect.asVoid,
    Effect.provide(callerServices),
  );
  // Subagents share the container of the thread that delegated to them, as Forge's workers did.
  let sessionId: string = caller.id;
  let lineage = caller.lineage;
  for (let depth = 0; depth < 16 && lineage.relationshipToParent === "subagent"; depth += 1) {
    const parentId = lineage.parentThreadId;
    if (parentId === null) break;
    const parent = yield* context.threads
      .getThreadShell(parentId)
      .pipe(Effect.orElseSucceed(() => null));
    if (parent === null) break;
    sessionId = parent.id;
    lineage = parent.lineage;
  }
  return { projectId: caller.projectId, sessionId, cwd, stillLive, authorize };
});

const consumeRef =
  (secretRequests: SecretRequests.SecretRequests["Service"]) =>
  (ref: SecretRef, projectId: ProjectId) =>
    secretRequests
      .consume({ ref, projectId })
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
        ),
      );

export const layer = McpToolAccess.toLayer(SecretsToolkit, {
  list_secrets: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { caller } = yield* callerThread;
      const secrets = yield* SecretsService.SecretsService;
      return yield* secrets.listForProject(caller.projectId);
    }),
  ),
  secure_bash: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { projectId, sessionId, cwd, stillLive, authorize } = yield* callerExecution;
      const secrets = yield* SecretsService.SecretsService;
      const consume = consumeRef(yield* SecretRequests.SecretRequests);
      const refs = input.secretRefs ?? [];
      return yield* secrets
        .runSecureCommand({
          projectId,
          sessionId,
          cwd,
          aliases: input.secrets,
          command: input.command,
          timeout: Duration.seconds(input.timeoutSeconds ?? SECURE_BASH_DEFAULT_TIMEOUT_SECONDS),
          authorize,
          stillLive,
          ...(refs.length === 0
            ? {}
            : {
                oneOff: {
                  names: refs.map((ref) => ref.name),
                  // Refs are one-use and project-bound; the service consumes them only once admitted.
                  consume: Effect.forEach(refs, ({ ref }) => consume(ref, projectId)),
                },
              }),
        })
        .pipe(
          Effect.catchTags({ SecureCommandError: (error) => Effect.fail(toMcpFailure(error)) }),
        );
    }),
  ),
  save_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { projectId, sessionId, cwd, stillLive, authorize } = yield* callerExecution;
      if ((input.secretRef === undefined) === (input.command === undefined)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass exactly one of secretRef or command as the value's source.",
        });
      }
      const secrets = yield* SecretsService.SecretsService;
      const consume = consumeRef(yield* SecretRequests.SecretRequests);
      return yield* secrets
        .saveSecret({
          projectId,
          sessionId,
          cwd,
          alias: input.alias,
          name: input.name,
          kind: input.type ?? "login",
          username: input.username?.trim() || null,
          source:
            input.secretRef !== undefined
              ? { _tag: "Ref", consume: consume(input.secretRef, projectId) }
              : {
                  _tag: "Command",
                  command: input.command ?? "",
                  aliases: input.secrets ?? [],
                  timeout: Duration.seconds(
                    input.timeoutSeconds ?? SECURE_BASH_DEFAULT_TIMEOUT_SECONDS,
                  ),
                },
          authorize,
          stillLive,
        })
        .pipe(
          Effect.catchTags({ SecureCommandError: (error) => Effect.fail(toMcpFailure(error)) }),
        );
    }),
  ),
});

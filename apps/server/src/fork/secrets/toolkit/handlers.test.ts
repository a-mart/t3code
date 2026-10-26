import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as SecretsService from "../SecretsService.ts";
import * as SecretsHandlers from "./handlers.ts";
import { SecretsToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:secrets");
const threadId = ThreadId.make("thread:secrets");
const projectId = ProjectId.make("project:mcp-test");

const invocation = (thread: boolean): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider:secrets",
  thread: thread
    ? {
        threadId,
        providerSessionId: "provider:secrets",
        providerInstanceId: ProviderInstanceId.make("codex"),
      }
    : undefined,
  client: thread ? undefined : { sessionId: "client", label: "Client", access: "full-access" },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

interface Recorded {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly aliases: ReadonlyArray<string>;
}

const runTool = (input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly thread?: boolean;
  readonly tool: "secure_bash" | "list_secrets" | "save_secret";
  readonly params?: unknown;
  readonly service?: (
    shell: Ref.Ref<OrchestrationV2ThreadShell>,
  ) => Partial<SecretsService.SecretsService["Service"]>;
  readonly onRun?: (recorded: Recorded) => void;
  readonly onConsume?: (consumed: { readonly ref: string; readonly projectId: ProjectId }) => void;
}) =>
  Effect.gen(function* () {
    const shell = yield* Ref.make(input.shell);
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, invocation(input.thread ?? true)),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Ref.get(shell),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeedSome({ workspaceRoot: "/work/project" } as never),
      }),
      Layer.mock(SecretRequests.SecretRequests)({
        consume: ({ ref, projectId: requested }) =>
          Effect.sync(() => {
            input.onConsume?.({ ref, projectId: requested });
            return `value-of-${ref}`;
          }),
      }),
      Layer.mock(SecretsService.SecretsService)({
        listForProject: (requested) =>
          Effect.succeed({
            bitwarden: "ready" as const,
            sandboxed: false,
            containerized: false,
            secrets:
              requested === projectId
                ? [{ alias: "PROD_DB", kind: "login" as const, name: "Prod DB", username: "app" }]
                : [],
          }),
        runSecureCommand: (command) =>
          Effect.gen(function* () {
            input.onRun?.({
              projectId: command.projectId,
              cwd: command.cwd,
              aliases: command.aliases,
            });
            yield* command.authorize;
            return { exitCode: 0, timedOut: false, stdout: "ok\n", stderr: "", redacted: false };
          }),
        saveSecret: (save) =>
          Effect.gen(function* () {
            input.onRun?.({ projectId: save.projectId, cwd: save.cwd, aliases: [save.alias] });
            yield* save.authorize;
            if (save.source._tag === "Ref") yield* save.source.consume;
            return {
              saved: true,
              alias: save.alias,
              collection: "Acme / Infra",
              exitCode: null,
              timedOut: false,
              stderr: "",
            };
          }),
        ...input.service?.(shell),
      }),
    );
    return yield* Effect.gen(function* () {
      const toolkit = yield* SecretsToolkit;
      const results = yield* toolkit
        .handle(input.tool, (input.params ?? {}) as never)
        .pipe(Stream.unwrap, Stream.runCollect);
      return { result: results.at(-1)?.result, shell };
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SecretsHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
  });

describe("secure_bash", () => {
  it.effect("runs in the calling thread's project and workspace", () =>
    Effect.gen(function* () {
      const recorded: Array<Recorded> = [];
      const { result } = yield* runTool({
        shell: liveThreadShell(threadId),
        tool: "secure_bash",
        params: { command: "echo ok", secrets: ["PROD_DB"] },
        onRun: (entry) => recorded.push(entry),
      });
      expect(result).toMatchObject({ exitCode: 0, stdout: "ok\n" });
      expect(recorded).toEqual([{ projectId, cwd: "/work/project", aliases: ["PROD_DB"] }]);
    }),
  );

  it.effect("refuses threads that need approval or are planning", () =>
    Effect.gen(function* () {
      for (const modes of [
        { runtimeMode: "approval-required" as const },
        { runtimeMode: "auto-accept-edits" as const },
        { interactionMode: "plan" as const },
      ]) {
        const recorded: Array<Recorded> = [];
        const { result } = yield* runTool({
          shell: liveThreadShell(threadId, modes),
          tool: "secure_bash",
          params: { command: "echo ok", secrets: ["PROD_DB"] },
          onRun: (entry) => recorded.push(entry),
        });
        expect(result).toMatchObject({ code: "capability_denied" });
        expect(recorded).toEqual([]);
      }
    }),
  );

  it.effect("refuses MCP clients outside a thread", () =>
    Effect.gen(function* () {
      const { result } = yield* runTool({
        shell: liveThreadShell(threadId),
        thread: false,
        tool: "secure_bash",
        params: { command: "echo ok", secrets: [] },
      });
      expect(result).toMatchObject({ code: "thread_credential_required" });
    }),
  );

  it.effect("refuses to start once the caller's run has ended during admission", () =>
    Effect.gen(function* () {
      const { result } = yield* runTool({
        shell: liveThreadShell(threadId),
        tool: "secure_bash",
        params: { command: "echo ok", secrets: ["PROD_DB"] },
        service: (shell) => ({
          runSecureCommand: (command) =>
            Effect.gen(function* () {
              // The run ends between the entry check and the final authorization.
              yield* Ref.update(shell, (current) => ({ ...current, activeRunId: null }));
              yield* command.authorize;
              return { exitCode: 0, timedOut: false, stdout: "", stderr: "", redacted: false };
            }),
        }),
      });
      expect(result).toMatchObject({ code: "parent_not_active" });
    }),
  );

  it.effect("reports the command as live only while its own run is", () =>
    Effect.gen(function* () {
      const liveness: Array<boolean> = [];
      yield* runTool({
        shell: liveThreadShell(threadId),
        tool: "secure_bash",
        params: { command: "echo ok", secrets: ["PROD_DB"] },
        service: (shell) => ({
          runSecureCommand: (command) =>
            Effect.gen(function* () {
              liveness.push(yield* command.stillLive);
              yield* Ref.update(shell, (current) => ({
                ...current,
                activeRunId: "run:next" as never,
              }));
              liveness.push(yield* command.stillLive);
              return { exitCode: 0, timedOut: false, stdout: "", stderr: "", redacted: false };
            }),
        }),
      });
      expect(liveness).toEqual([true, false]);
    }),
  );

  it.effect("tells the agent which secret isn't granted", () =>
    Effect.gen(function* () {
      const { result } = yield* runTool({
        shell: liveThreadShell(threadId),
        tool: "secure_bash",
        params: { command: "true", secrets: ["BILLING"] },
        service: () => ({
          runSecureCommand: () =>
            Effect.fail(
              new SecretsService.SecureCommandError({ reason: "not_granted", alias: "BILLING" }),
            ),
        }),
      });
      expect(result).toMatchObject({
        code: "capability_denied",
        message:
          "BILLING isn't granted to this project. Ask the user to grant it in Settings → Secrets.",
      });
    }),
  );
});

describe("secure_bash secretRefs", () => {
  it.effect("passes one-off values that the service consumes for the calling project", () =>
    Effect.gen(function* () {
      const consumed: Array<{ readonly ref: string; readonly projectId: ProjectId }> = [];
      const delivered: Array<ReadonlyArray<string>> = [];
      const ref = `secret-ref:${"a".repeat(32)}`;
      const { result } = yield* runTool({
        shell: liveThreadShell(threadId),
        tool: "secure_bash",
        params: { command: "echo ok", secrets: [], secretRefs: [{ ref, name: "SIGNING_KEY" }] },
        onConsume: (entry) => consumed.push(entry),
        service: () => ({
          runSecureCommand: (command) =>
            Effect.gen(function* () {
              expect(command.oneOff?.names).toEqual(["SIGNING_KEY"]);
              // Nothing is consumed until the service asks, after admission.
              expect(consumed).toEqual([]);
              delivered.push(yield* command.oneOff!.consume);
              return { exitCode: 0, timedOut: false, stdout: "", stderr: "", redacted: false };
            }),
        }),
      });
      expect(result).toMatchObject({ exitCode: 0 });
      expect(consumed).toEqual([{ ref, projectId }]);
      expect(delivered).toEqual([[`value-of-${ref}`]]);
    }),
  );
});

describe("list_secrets", () => {
  it.effect("lists only the calling project's secrets", () =>
    Effect.gen(function* () {
      const { result } = yield* runTool({ shell: liveThreadShell(threadId), tool: "list_secrets" });
      expect(result).toEqual({
        bitwarden: "ready",
        sandboxed: false,
        containerized: false,
        secrets: [{ alias: "PROD_DB", kind: "login", name: "Prod DB", username: "app" }],
      });
    }),
  );
});

describe("save_secret", () => {
  const ref = `secret-ref:${"b".repeat(32)}`;

  it.effect("saves a request answer for the calling project", () =>
    Effect.gen(function* () {
      const consumed: Array<{ readonly ref: string; readonly projectId: ProjectId }> = [];
      const sources: Array<string> = [];
      const { result } = yield* runTool({
        shell: liveThreadShell(threadId),
        tool: "save_secret",
        params: { alias: "NEW_TOKEN", name: "New token", secretRef: ref },
        onConsume: (entry) => consumed.push(entry),
        service: () => ({
          saveSecret: (save) =>
            Effect.gen(function* () {
              expect(save).toMatchObject({ projectId, cwd: "/work/project", kind: "login" });
              sources.push(save.source._tag === "Ref" ? yield* save.source.consume : "command");
              return {
                saved: true,
                alias: save.alias,
                collection: "Acme / Infra",
                exitCode: null,
                timedOut: false,
                stderr: "",
              };
            }),
        }),
      });
      expect(result).toMatchObject({ saved: true, alias: "NEW_TOKEN" });
      expect(consumed).toEqual([{ ref, projectId }]);
      expect(sources).toEqual([`value-of-${ref}`]);
    }),
  );

  it.effect("refuses threads that need approval or are planning", () =>
    Effect.gen(function* () {
      const recorded: Array<Recorded> = [];
      const { result } = yield* runTool({
        shell: liveThreadShell(threadId, { runtimeMode: "approval-required" }),
        tool: "save_secret",
        params: { alias: "NEW_TOKEN", name: "New token", command: "openssl rand -base64 24" },
        onRun: (entry) => recorded.push(entry),
      });
      expect(result).toMatchObject({ code: "capability_denied" });
      expect(recorded).toEqual([]);
    }),
  );

  it.effect("needs exactly one source for the value", () =>
    Effect.gen(function* () {
      for (const source of [{}, { secretRef: ref, command: "openssl rand -base64 24" }]) {
        const recorded: Array<Recorded> = [];
        const { result } = yield* runTool({
          shell: liveThreadShell(threadId),
          tool: "save_secret",
          params: { alias: "NEW_TOKEN", name: "New token", ...source },
          onRun: (entry) => recorded.push(entry),
        });
        expect(result).toMatchObject({ code: "invalid_request" });
        expect(recorded).toEqual([]);
      }
    }),
  );
});

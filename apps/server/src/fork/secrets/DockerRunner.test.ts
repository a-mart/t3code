// @effect-diagnostics nodeBuiltinImport:off - tests hash the state folder and run the guest programs directly.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as ServerConfig from "../../config.ts";
import { GUEST_EXECUTOR_SOURCE, GUEST_TERMINATOR_SOURCE } from "./dockerGuest.ts";
import * as DockerRunner from "./DockerRunner.ts";
import {
  installFakeDocker,
  readDockerFrames,
  readDockerInvocations,
  readFakeDocker,
  writeFakeDocker,
} from "./fakeDocker.testkit.ts";

const projectA = ProjectId.make("project-a");
const TOKEN = "tOk-3n_Zx8Cv7Bn6Mq5Wl4";
const toolPath = [NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(":");

/**
 * The runner with a fake Docker CLI first on PATH and the executor's folders
 * on the host, so commands run here instead of in a container.
 */
const harness = Effect.fn("harness")(function* (
  options: { readonly platform?: NodeJS.Platform; readonly withDocker?: boolean } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-docker-runner-" });
  const bin = path.join(root, "bin");
  const engine = path.join(root, "engine");
  yield* fileSystem.makeDirectory(bin, { recursive: true });
  if (options.withDocker !== false) {
    yield* installFakeDocker({
      binDirectory: bin,
      stateDirectory: engine,
      name: options.platform === "win32" ? "docker.exe" : "docker",
    });
  }
  const askpass = path.join(root, "askpass");
  yield* fileSystem.writeFileString(askpass, '#!/bin/sh\nexec printenv "$T3_ASKPASS_VAR"\n', {
    mode: 0o755,
  });
  const layout: DockerRunner.GuestLayout = {
    executions: path.join(root, "guest", "executions"),
    temp: path.join(root, "guest", "tmp"),
    home: path.join(root, "guest", "home"),
    askpass,
    path: toolPath,
    env: {},
  };
  const workspace = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-docker-workspace-" }),
  );
  const config = ServerConfig.layerTest(root, path.join(root, "t3"));
  const stateDir = yield* Effect.gen(function* () {
    return (yield* ServerConfig.ServerConfig).stateDir;
  }).pipe(Effect.provide(config));
  const layer = DockerRunner.layer.pipe(
    Layer.provideMerge(config),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(DockerRunner.GuestLayoutOverride, layout),
        Layer.succeed(HostProcess.Platform, options.platform ?? "darwin"),
        Layer.succeed(HostProcess.Environment, { PATH: bin, DOCKER_CONFIG: engine }),
        Layer.succeed(HostProcess.HomeDirectory, root),
      ),
    ),
  );
  return { root, engine, layout, workspace, layer, stateDir };
});

const command = (
  workspace: string,
  input: Partial<DockerRunner.DockerRunInput> & Pick<DockerRunner.DockerRunInput, "command">,
): DockerRunner.DockerRunInput => ({
  sessionId: "thread-a",
  projectId: projectA,
  itemIds: new Set(["item-1"]),
  usesVault: true,
  cwd: workspace,
  deliveries: {},
  sshKeys: [],
  timeout: Duration.seconds(30),
  ...input,
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("DockerRunner", () => {
  it.live("reports a host without Docker, then a missing runner until it is built", () =>
    Effect.gen(function* () {
      // Windows, so the fallback folders this machine may have Docker in don't apply.
      const without = yield* harness({ platform: "win32", withDocker: false });
      const missing = yield* Effect.gen(function* () {
        return yield* (yield* DockerRunner.DockerRunner).status(true);
      }).pipe(Effect.provide(without.layer));
      expect(missing.state).toBe("docker_missing");

      const { engine, layer } = yield* harness();
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        expect((yield* runner.status(true)).state).toBe("runner_missing");
        expect(yield* runner.installRunner).toEqual({ state: "ready", serverVersion: "29.0.0" });
        const fileSystem = yield* FileSystem.FileSystem;
        const dockerfile = yield* fileSystem.readFileString(NodePath.join(engine, "Dockerfile"));
        expect(dockerfile).toContain("FROM node:22.19.0-bookworm-slim@sha256:");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses an engine that isn't on this machine", () =>
    Effect.gen(function* () {
      const { engine, layer } = yield* harness();
      yield* writeFakeDocker(engine, { endpoint: "tcp://10.0.0.5:2375", built: true });
      const status = yield* Effect.gen(function* () {
        return yield* (yield* DockerRunner.DockerRunner).status(true);
      }).pipe(Effect.provide(layer));
      expect(status.state).toBe("engine_unavailable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps one hardened container per session, with values only in a command's stdin", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace } = yield* harness();
      yield* writeFakeDocker(engine, { built: true });
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        const first = yield* runner.run(
          command(workspace, {
            command: 'echo "${#DEPLOY_TOKEN}"; echo kept > "$HOME/state"; pwd',
            deliveries: { DEPLOY_TOKEN: TOKEN },
          }),
        );
        expect(first.exitCode).toBe(0);
        expect(text(first.stdout.bytes)).toBe(`${TOKEN.length}\n${workspace}\n`);
        const second = yield* runner.run(
          command(workspace, { command: 'cat "$HOME/state"; echo "${DEPLOY_TOKEN:-unset}"' }),
        );
        expect(text(second.stdout.bytes)).toBe("kept\nunset\n");
        const other = yield* runner.run(
          command(workspace, {
            sessionId: "thread-b",
            command: 'cat "$HOME/state" 2>/dev/null || echo none',
          }),
        );
        // The fake runs every container on this host, so only the container count tells them apart.
        expect(other.exitCode).toBe(0);
        yield* assertHardened(engine, workspace);
      }).pipe(Effect.provide(layer));
      // Stopping T3 removes its containers.
      expect((yield* readFakeDocker(engine)).containers).toEqual({});
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const assertHardened = Effect.fn("assertHardened")(function* (engine: string, workspace: string) {
    const docker = yield* readFakeDocker(engine);
    const containers = Object.values(docker.containers);
    expect(containers).toHaveLength(2);
    const args = containers[0]?.args ?? [];
    for (const flag of [
      "--read-only",
      "--init",
      "no-new-privileges=true",
      "ALL",
      "65532:65532",
      `type=bind,source=${workspace},target=${workspace}`,
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain("--privileged");
    const invocations = yield* readDockerInvocations(engine);
    expect(invocations.some((call) => call.join(" ").includes(TOKEN))).toBe(false);
    expect(invocations.filter((call) => call.includes("create"))).toHaveLength(2);
  });

  it.live("destroys the containers that received a revoked value", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace } = yield* harness();
      yield* writeFakeDocker(engine, { built: true });
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        yield* runner.run(command(workspace, { command: "true", itemIds: new Set(["kept"]) }));
        yield* runner.run(
          command(workspace, {
            sessionId: "thread-b",
            command: "true",
            itemIds: new Set(["revoked"]),
          }),
        );
        expect(Object.keys((yield* readFakeDocker(engine)).containers)).toHaveLength(2);
        yield* runner.retire((holder) => holder.itemIds.has("revoked"));
        const left = Object.values((yield* readFakeDocker(engine)).containers);
        expect(left).toHaveLength(1);
        expect(left[0]?.labels["dev.t3.secure.session"]).toBe(
          NodeCrypto.createHash("sha256").update("thread-a").digest("hex"),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends what a command left running in the background once it exits", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace } = yield* harness();
      yield* writeFakeDocker(engine, { built: true });
      const fileSystem = yield* FileSystem.FileSystem;
      const pidFile = NodePath.join(workspace, "background.pid");
      const output = yield* Effect.gen(function* () {
        return yield* (yield* DockerRunner.DockerRunner).run(
          command(workspace, { command: `sleep 60 > /dev/null 2>&1 & echo $! > '${pidFile}'` }),
        );
      }).pipe(Effect.provide(layer));
      expect(output.exitCode).toBe(0);
      const pid = Number((yield* fileSystem.readFileString(pidFile)).trim());
      assert(Number.isSafeInteger(pid) && pid > 1);
      expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("never starts a command whose stop arrived before the executor did", () =>
    Effect.gen(function* () {
      const { layout, workspace } = yield* harness();
      const fileSystem = yield* FileSystem.FileSystem;
      const executionId = "a".repeat(24);
      const marker = NodePath.join(workspace, "ran");
      yield* Effect.sync(() =>
        NodeChildProcess.execFileSync(
          process.execPath,
          ["-e", GUEST_TERMINATOR_SOURCE, layout.executions, executionId],
          { stdio: "ignore" },
        ),
      );
      const frame = {
        version: 1,
        executionId,
        layout,
        command: `touch '${marker}'`,
        cwd: workspace,
        env: {},
        sshKeys: [],
        sshFiles: {},
        git: null,
        done: "t3-secure-done:test\n",
      };
      const result = yield* Effect.sync(() =>
        NodeChildProcess.spawnSync(process.execPath, ["-e", GUEST_EXECUTOR_SOURCE], {
          input: JSON.stringify(frame),
          encoding: "utf8",
        }),
      );
      expect(result.status).toBe(125);
      expect(result.stderr).toContain("t3-secure-executor:cancelled");
      expect(yield* fileSystem.exists(marker)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails a command whose Docker client lost the executor, and destroys its container", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace } = yield* harness();
      yield* writeFakeDocker(engine, { built: true });
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        yield* runner.run(command(workspace, { command: "true" }));
        expect(Object.keys((yield* readFakeDocker(engine)).containers)).toHaveLength(1);
        yield* writeFakeDocker(engine, { dropExec: true });
        const error = yield* runner.run(command(workspace, { command: "true" })).pipe(Effect.flip);
        expect(error.stage).toBe("runner");
        expect((yield* readFakeDocker(engine)).containers).toEqual({});
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("destroys the container when a command making a value is stopped", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace } = yield* harness();
      yield* writeFakeDocker(engine, { built: true });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        yield* runner.run(command(workspace, { command: "true" }));
        const started = yield* fileSystem.watch(workspace).pipe(
          Stream.filter((event) => event.path.endsWith("started")),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const making = yield* runner
          .run(
            command(workspace, {
              generates: true,
              command: 'echo minted > "$HOME/minted"; touch started; sleep 60',
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(started);
        yield* Fiber.interrupt(making);
        expect((yield* readFakeDocker(engine)).containers).toEqual({});
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("destroys the container after every command that creates a credential", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace } = yield* harness();
      yield* writeFakeDocker(engine, { built: true });
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        for (const run of [
          { command: 'echo minted > "$HOME/minted"; echo minted', timeout: Duration.seconds(30) },
          { command: 'echo minted > "$HOME/minted"; exit 1', timeout: Duration.seconds(30) },
          { command: 'echo minted > "$HOME/minted"; sleep 60', timeout: Duration.seconds(1) },
        ]) {
          yield* runner.run(command(workspace, { command: "true" }));
          expect(Object.keys((yield* readFakeDocker(engine)).containers)).toHaveLength(1);
          yield* runner.run(command(workspace, { ...run, generates: true }));
          expect((yield* readFakeDocker(engine)).containers).toEqual({});
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("runs nothing under a container's name until a failed removal succeeds", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace } = yield* harness();
      yield* writeFakeDocker(engine, { built: true });
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        yield* runner.run(command(workspace, { command: "true" }));
        yield* writeFakeDocker(engine, { failRm: true });
        yield* runner.retire(() => true);
        expect(Object.keys((yield* readFakeDocker(engine)).containers)).toHaveLength(1);
        const blocked = yield* runner
          .run(command(workspace, { command: "true" }))
          .pipe(Effect.flip);
        expect(blocked.stage).toBe("runner");
        yield* writeFakeDocker(engine, { failRm: false });
        const later = yield* runner.run(command(workspace, { command: "echo fresh" }));
        expect(text(later.stdout.bytes)).toBe("fresh\n");
        const invocations = yield* readDockerInvocations(engine);
        expect(invocations.filter((call) => call.includes("create"))).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("replaces, never adopts, a container under its name that it didn't make", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace } = yield* harness();
      yield* writeFakeDocker(engine, { built: true });
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        yield* runner.run(command(workspace, { command: "true" }));
        const entry = Object.entries((yield* readFakeDocker(engine)).containers)[0];
        assert(entry !== undefined);
        const [name, container] = entry;
        yield* writeFakeDocker(engine, {
          containers: { [name]: { ...container, id: "someone-else" } },
        });
        yield* runner.run(command(workspace, { command: "true" }));
        const replaced = (yield* readFakeDocker(engine)).containers[name];
        expect(replaced?.id).not.toBe("someone-else");
        const invocations = yield* readDockerInvocations(engine);
        expect(invocations.filter((call) => call.includes("create"))).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("lets a container left by a crashed T3 lapse when it can't be removed", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace, stateDir } = yield* harness();
      const fileSystem = yield* FileSystem.FileSystem;
      const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
      const scope = sha256(stateDir).slice(0, 16);
      const name = `t3-secure-${scope.slice(0, 10)}-${sha256(`${sha256("thread-a")}\0${sha256(workspace)}`).slice(0, 20)}`;
      const heartbeat = NodePath.join(stateDir, "fork", "secure-runner", "heartbeats", name);
      yield* fileSystem.makeDirectory(NodePath.dirname(heartbeat), { recursive: true });
      yield* fileSystem.writeFileString(heartbeat, "");
      yield* writeFakeDocker(engine, {
        built: true,
        failRm: true,
        containers: {
          [name]: {
            id: "left-by-a-crash",
            image: DockerRunner.RUNNER_IMAGE,
            labels: {},
            mounts: [],
            running: true,
            args: [],
          },
        },
      });
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        const error = yield* runner.run(command(workspace, { command: "true" })).pipe(Effect.flip);
        expect(error.stage).toBe("runner");
        // Its keepalive exits once the heartbeat file is gone.
        expect(yield* fileSystem.exists(heartbeat)).toBe(false);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends a timed-out command with everything it started", () =>
    Effect.gen(function* () {
      const { engine, layer, workspace } = yield* harness();
      yield* writeFakeDocker(engine, { built: true });
      const fileSystem = yield* FileSystem.FileSystem;
      const pidFile = NodePath.join(workspace, "background.pid");
      const output = yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        return yield* runner.run(
          command(workspace, {
            command: `sleep 60 & echo $! > '${pidFile}'; echo started; sleep 60`,
            timeout: Duration.seconds(2),
          }),
        );
      }).pipe(Effect.provide(layer));
      expect(output.timedOut).toBe(true);
      expect(text(output.stdout.bytes)).toBe("started\n");
      const pid = Number((yield* fileSystem.readFileString(pidFile)).trim());
      assert(Number.isSafeInteger(pid) && pid > 1);
      expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("mounts the workspace at /workspace on Windows and copies SSH host files in", () =>
    Effect.gen(function* () {
      const { engine, layer, root, workspace } = yield* harness({ platform: "win32" });
      yield* writeFakeDocker(engine, {
        endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine",
        built: true,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(NodePath.join(root, ".ssh"), { recursive: true });
      yield* fileSystem.writeFileString(NodePath.join(root, ".ssh", "known_hosts"), "host key\n");
      yield* fileSystem.writeFileString(NodePath.join(root, ".ssh", "id_ed25519"), "private\n");
      yield* Effect.gen(function* () {
        const runner = yield* DockerRunner.DockerRunner;
        const output = yield* runner.run(
          command(workspace, { command: 'cat "$HOME/.ssh/known_hosts"; ls "$HOME/.ssh"' }),
        );
        expect(text(output.stdout.bytes)).toBe("host key\nknown_hosts\n");
        // The executor's completion code isn't the command's output.
        expect(text(output.stderr.bytes)).toBe("");
        const [container] = Object.values((yield* readFakeDocker(engine)).containers);
        expect(container?.args).toContain(`type=bind,source=${workspace},target=/workspace`);
      }).pipe(Effect.provide(layer));
      const [frame] = yield* readDockerFrames(engine);
      expect(frame?.cwd).toBe("/workspace");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("removes containers an earlier T3 left behind, once it starts on Windows", () =>
    Effect.gen(function* () {
      const { engine, layer, stateDir } = yield* harness({ platform: "win32" });
      const scope = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
      const leftover = {
        image: DockerRunner.RUNNER_IMAGE,
        labels: { "dev.t3.secure.managed": "true", "dev.t3.secure.scope": scope },
        mounts: [],
        running: false,
        args: [],
      };
      yield* writeFakeDocker(engine, {
        endpoint: "npipe:////./pipe/docker_engine",
        built: true,
        containers: {
          leftover,
          unrelated: { ...leftover, labels: { "dev.t3.secure.managed": "true" } },
        },
      });
      yield* Effect.gen(function* () {
        // Retiring waits for the startup sweep, which holds the container lock until it's done.
        yield* (yield* DockerRunner.DockerRunner).retire(() => false);
        expect(Object.keys((yield* readFakeDocker(engine)).containers)).toEqual(["unrelated"]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

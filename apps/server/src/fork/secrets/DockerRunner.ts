// @effect-diagnostics nodeBuiltinImport:off - container names hash their session and folder synchronously.
/**
 * Runs `secure_bash` commands in Linux containers through a local Docker
 * engine, as Forge did on Windows, where nono can't run.
 *
 * Each session (a thread and the subagents it delegated to) gets one
 * long-lived container per workspace, so its home folder and installed tools
 * carry over from command to command. Values reach the container only inside
 * one command's stdin frame. A container is destroyed when the vault locks, a
 * value it received is revoked, it sits idle, or T3 stops; if T3 is killed, a
 * heartbeat it stops touching ends the container within seconds.
 *
 * The container mounts only the workspace (and a linked worktree's shared git
 * directory). It runs as an unprivileged user with every capability dropped,
 * a read-only root, and no Docker socket. Like nono, this guards against
 * careless commands, not hostile ones.
 */
import type { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../../config.ts";
import { collectBounded } from "./boundedOutput.ts";
import {
  GUEST_EXECUTOR_SOURCE,
  GUEST_HEARTBEAT_PATH,
  GUEST_KEEPALIVE_SOURCE,
  GUEST_TERMINATOR_SOURCE,
} from "./dockerGuest.ts";
import {
  normalizeSshPrivateKey,
  SECURE_EXEC_MAX_STREAM_BYTES,
  SecureExecError,
  type SecureExecOutput,
} from "./SecureExec.ts";

/** Bump with any change to the Dockerfile or to what the executor expects of the image. */
const RUNNER_CONTRACT = "1";
export const RUNNER_IMAGE = `t3-secure-runner:${RUNNER_CONTRACT}`;
const LABEL = "dev.t3.secure";
const RUN_AS = "65532:65532";
const IDLE_AFTER = Duration.hours(1);
const HEARTBEAT_EVERY = Duration.seconds(4);
// Docker Desktop on Windows can take a few seconds per control call.
const CONTROL_TIMEOUT = Duration.seconds(30);
const BUILD_TIMEOUT = Duration.minutes(20);
const TERMINATE_TIMEOUT = Duration.seconds(20);
const STATUS_TTL_MS = 5_000;
const FORCE_KILL_AFTER = Duration.seconds(3);
const CONTROL_OUTPUT_BYTES = 4 * 1024 * 1024;
const EXECUTOR_FAILURE = "t3-secure-executor:";
const EXECUTOR_DONE = "t3-secure-done:";
// Past this many distinct values, a container's output can't be filtered for all it received.
const MAX_REMEMBERED_VALUES = 256;
const GATE_PERMITS = 1024;
// Host keys and aliases follow the command in, as nono lets them through; private keys don't.
const COPIED_SSH_FILES = ["known_hosts", "config"];
const MAX_SSH_FILE_BYTES = 256 * 1024;

/**
 * The runner image, from the same pinned base and tools as Forge's. The fixed
 * user exists in the image, so OpenSSH and other tools that look up the
 * current user work without running as root.
 */
const RUNNER_DOCKERFILE = `FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90
LABEL ${LABEL}.runner-contract="${RUNNER_CONTRACT}"
ENV COREPACK_HOME=/usr/local/share/corepack
RUN apt-get update \\
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      bash build-essential ca-certificates curl git jq openssh-client postgresql-client python3 rsync \\
    && rm -rf /var/lib/apt/lists/* \\
    && groupadd --gid 65532 t3 \\
    && useradd --uid 65532 --gid 65532 --home-dir /tmp/t3-home --no-create-home --shell /bin/bash t3 \\
    && printf '%s\\n' '#!/bin/sh' 'case "$T3_ASKPASS_VAR" in ""|[0-9]*|*[!A-Za-z0-9_]*) exit 64;; esac' 'exec printenv "$T3_ASKPASS_VAR"' > /usr/local/bin/t3-askpass \\
    && chmod 0555 /usr/local/bin/t3-askpass \\
    && corepack enable pnpm \\
    && corepack install --global pnpm@10.30.1 \\
    && chmod -R a+rX "$COREPACK_HOME" \\
    && for tool in bash cc curl git jq node npm pnpm psql python3 rsync script ssh ssh-agent ssh-add; do \\
      command -v "$tool" >/dev/null || exit 1; \\
    done
`;

/** Where the executor keeps things; tests replace it to run the executor on the host. */
export interface GuestLayout {
  readonly executions: string;
  readonly temp: string;
  readonly home: string;
  readonly askpass: string;
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
}

const RUNNER_LAYOUT: GuestLayout = {
  executions: "/run/t3-secure/executions",
  temp: "/tmp/t3-secure",
  home: "/tmp/t3-home",
  askpass: "/usr/local/bin/t3-askpass",
  path: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  env: { COREPACK_HOME: "/usr/local/share/corepack", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
};

export const GuestLayoutOverride = Context.Reference<GuestLayout | null>(
  "t3/fork/secrets/DockerRunner/GuestLayoutOverride",
  { defaultValue: () => null },
);

export type DockerStatus =
  | { readonly state: "docker_missing" }
  | { readonly state: "engine_unavailable" }
  | { readonly state: "runner_missing"; readonly serverVersion: string }
  | { readonly state: "ready"; readonly serverVersion: string };

export class DockerRunnerError extends Schema.TaggedError<DockerRunnerError>()(
  "DockerRunnerError",
  { reason: Schema.Literals(["engine_unavailable", "build_failed"]) },
) {}

/** What a container has received, so revoking one of its values can retire it. */
export interface ContainerHolder {
  readonly projectId: ProjectId;
  readonly itemIds: ReadonlySet<string>;
  readonly usesVault: boolean;
}

export interface DockerRunInput extends ContainerHolder {
  /** The thread that owns the container: the caller, or the thread that delegated to it. */
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly deliveries: Readonly<Record<string, string>>;
  readonly sshKeys: ReadonlyArray<string>;
  readonly timeout: Duration.Duration;
  /**
   * Set for `save_secret`'s commands, which create a credential. One can leave it anywhere in the
   * container, printed or not, so the command has the container to itself and the container is
   * destroyed when it ends.
   */
  readonly generates?: boolean;
}

export interface DockerRunOutput extends SecureExecOutput {
  /**
   * Every value the container has received, this command's included. Its home
   * folder outlives a command, so a later one can print an earlier value.
   */
  readonly delivered: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export class DockerRunner extends Context.Service<
  DockerRunner,
  {
    /** Cached for a few seconds unless `force`. */
    readonly status: (force: boolean) => Effect.Effect<DockerStatus>;
    /** Builds the runner image in the local engine. */
    readonly installRunner: Effect.Effect<DockerStatus, DockerRunnerError>;
    readonly run: (input: DockerRunInput) => Effect.Effect<DockerRunOutput, SecureExecError>;
    /** Destroys every container whose holder matches, ending the commands in it. */
    readonly retire: (matches: (holder: ContainerHolder) => boolean) => Effect.Effect<void>;
  }
>()("t3/fork/secrets/DockerRunner") {}

interface Container {
  readonly name: string;
  readonly holder: {
    readonly projectId: ProjectId;
    readonly itemIds: Set<string>;
    usesVault: boolean;
  };
  active: number;
  lastUsed: number;
  /** Value to alias, for every value delivered to the container. */
  readonly delivered: Map<string, string>;
  /** Commands share it; one that creates a credential takes it whole. */
  readonly gate: Semaphore.Semaphore;
  readonly heartbeat: Fiber.Fiber<unknown, unknown>;
  /**
   * Docker's id for the container, which a replacement under the same name doesn't share, so a
   * command reserved before a replacement can't reach it.
   */
  id: string | null;
  /** Set once destroyed; a command still waiting on its gate then fails. */
  retired: boolean;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const DOCKER_VARIABLES = [
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "PATH",
  "ProgramData",
  "ProgramFiles",
  "ProgramW6432",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_RUNTIME_DIR",
];
const WINDOWS_ENGINES = new Set([
  "npipe:////./pipe/docker_engine",
  "npipe:////./pipe/dockerdesktoplinuxengine",
]);

/** Secrets travel to the engine through the exec's stdin, so only a local engine is accepted. */
const isLocalEngine = (endpoint: string, platform: NodeJS.Platform) =>
  platform === "win32"
    ? WINDOWS_ENGINES.has(endpoint.toLowerCase())
    : /^unix:\/\/\/[^\0%?#\n]+$/.test(endpoint);

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const layout = (yield* GuestLayoutOverride) ?? RUNNER_LAYOUT;
  const scope = sha256(config.stateDir).slice(0, 16);
  const heartbeats = path.join(config.stateDir, "fork", "secure-runner", "heartbeats");
  const host = yield* Ref.make<{ readonly executable: string; readonly endpoint: string } | null>(
    null,
  );
  const cachedStatus = yield* Ref.make<{
    readonly status: DockerStatus;
    readonly at: number;
  } | null>(null);
  const containers = new Map<string, Container>();
  const lifecycle = yield* Semaphore.make(1);
  const serviceScope = yield* Effect.scope;

  // Windows variable names are case-insensitive; `Path` is common there.
  const hostVariable = (env: NodeJS.ProcessEnv, name: string) =>
    platform === "win32"
      ? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
      : env[name];

  const dockerEnvironment = Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    const result: Record<string, string> = {};
    for (const name of DOCKER_VARIABLES) {
      const value = hostVariable(env, name);
      if (value !== undefined) result[name] = value;
    }
    return result;
  });

  const findDocker = Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    const separator = platform === "win32" ? ";" : ":";
    const name = platform === "win32" ? "docker.exe" : "docker";
    const directories = [
      ...(hostVariable(env, "PATH") ?? "").split(separator).filter((entry) => entry.length > 0),
      ...(platform === "win32"
        ? ["C:\\Program Files\\Docker\\Docker\\resources\\bin"]
        : [
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin",
            "/Applications/Docker.app/Contents/Resources/bin",
          ]),
    ];
    for (const directory of new Set(directories)) {
      const candidate = path.join(directory, name);
      const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "File") return candidate;
    }
    return null;
  });

  /** Runs the Docker CLI; stderr is dropped, since it can echo what a command printed. */
  const docker = Effect.fn("DockerRunner.docker")(function* (
    executable: string,
    args: ReadonlyArray<string>,
    options: { readonly stdin?: Uint8Array; readonly timeout?: Duration.Duration } = {},
  ) {
    const env = yield* dockerEnvironment;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(executable, args, {
            env,
            extendEnv: false,
            stdin: options.stdin === undefined ? "ignore" : Stream.make(options.stdin),
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        );
        const [stdout] = yield* Effect.all(
          [collectBounded(handle.stdout, CONTROL_OUTPUT_BYTES), Stream.runDrain(handle.stderr)],
          { concurrency: "unbounded" },
        );
        return { exitCode: yield* handle.exitCode, stdout: new TextDecoder().decode(stdout.bytes) };
      }),
    ).pipe(
      Effect.timeoutOption(options.timeout ?? CONTROL_TIMEOUT),
      Effect.map(Option.getOrElse(() => ({ exitCode: -1, stdout: "" }))),
      Effect.catchDefect(() => Effect.succeed({ exitCode: -1, stdout: "" })),
      Effect.orElseSucceed(() => ({ exitCode: -1, stdout: "" })),
    );
  });

  /**
   * Resolves the engine once and passes it to every later call, so a changed
   * context can't redirect a command's values to another engine.
   */
  const pinnedHost = Effect.gen(function* () {
    const pinned = yield* Ref.get(host);
    if (pinned !== null) return pinned;
    const executable = yield* findDocker;
    if (executable === null) return null;
    const env = yield* HostProcess.Environment;
    let endpoint = hostVariable(env, "DOCKER_HOST") ?? "";
    if (endpoint === "") {
      const inspected = yield* docker(executable, [
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ]);
      if (inspected.exitCode !== 0) return { executable, endpoint: null };
      const parsed = Option.getOrUndefined(decodeJson(inspected.stdout.trim()));
      endpoint = typeof parsed === "string" ? parsed : "";
    }
    if (!isLocalEngine(endpoint, platform)) return { executable, endpoint: null };
    const result = { executable, endpoint };
    yield* Ref.set(host, result);
    return result;
  });

  const engine = Effect.fn("DockerRunner.engine")(function* (
    args: ReadonlyArray<string>,
    options?: { readonly stdin?: Uint8Array; readonly timeout?: Duration.Duration },
  ) {
    const pinned = yield* pinnedHost;
    if (pinned === null || pinned.endpoint === null) return { exitCode: -1, stdout: "" };
    return yield* docker(pinned.executable, ["--host", pinned.endpoint, ...args], options);
  });

  const probe: Effect.Effect<DockerStatus> = Effect.gen(function* () {
    const pinned = yield* pinnedHost;
    if (pinned === null) return { state: "docker_missing" };
    if (pinned.endpoint === null) return { state: "engine_unavailable" };
    const server = yield* engine(["version", "--format", "{{json .Server}}"]);
    const parsed = Option.getOrUndefined(decodeJson(server.stdout.trim()));
    const serverVersion = field(parsed, "Version");
    if (
      server.exitCode !== 0 ||
      field(parsed, "Os") !== "linux" ||
      typeof serverVersion !== "string"
    ) {
      return { state: "engine_unavailable" };
    }
    const image = yield* engine([
      "image",
      "inspect",
      RUNNER_IMAGE,
      "--format",
      `{{index .Config.Labels "${LABEL}.runner-contract"}}`,
    ]);
    return image.exitCode === 0 && image.stdout.trim() === RUNNER_CONTRACT
      ? { state: "ready", serverVersion }
      : { state: "runner_missing", serverVersion };
  });

  const status: DockerRunner["Service"]["status"] = Effect.fn("DockerRunner.status")(
    function* (force) {
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(cachedStatus);
      if (!force && cached !== null && now - cached.at < STATUS_TTL_MS) return cached.status;
      const latest = yield* probe;
      yield* Ref.set(cachedStatus, { status: latest, at: yield* Clock.currentTimeMillis });
      return latest;
    },
  );

  const installRunner: DockerRunner["Service"]["installRunner"] = Effect.gen(function* () {
    const before = yield* status(true);
    if (before.state === "docker_missing" || before.state === "engine_unavailable") {
      return yield* new DockerRunnerError({ reason: "engine_unavailable" });
    }
    const built = yield* engine(["build", "--quiet", "--tag", RUNNER_IMAGE, "-"], {
      stdin: new TextEncoder().encode(RUNNER_DOCKERFILE),
      timeout: BUILD_TIMEOUT,
    });
    const after = yield* status(true);
    if (built.exitCode !== 0 || after.state !== "ready") {
      return yield* new DockerRunnerError({ reason: "build_failed" });
    }
    return after;
  }).pipe(Effect.withSpan("DockerRunner.installRunner"));

  /** Whether the container is gone: removed now, or not there to begin with. */
  const removeContainer = Effect.fn("DockerRunner.removeContainer")(function* (name: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((yield* engine(["rm", "-f", "--volumes", name])).exitCode === 0) return true;
    }
    return (yield* engine(["container", "inspect", name])).exitCode !== 0;
  });

  const destroy = Effect.fn("DockerRunner.destroy")(function* (name: string) {
    const container = containers.get(name);
    containers.delete(name);
    if (container !== undefined) {
      container.retired = true;
      yield* Fiber.interrupt(container.heartbeat);
    }
    // One that survives isn't tracked anymore, so it's never reused; the next command removes it.
    yield* removeContainer(name);
    yield* fileSystem.remove(path.join(heartbeats, name)).pipe(Effect.ignore);
  });

  // Chosen under the lock, so a container still being created when this was asked isn't missed.
  const retire: DockerRunner["Service"]["retire"] = (matches) =>
    lifecycle.withPermits(1)(
      Effect.suspend(() =>
        Effect.forEach(
          [...containers.values()].filter((container) => matches(container.holder)),
          (container) => destroy(container.name),
          { discard: true },
        ),
      ),
    );

  // On Windows, a path on another drive comes back absolute rather than with `..`.
  const isWithin = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  /** A linked worktree's git directory lives in the main checkout, outside the workspace. */
  const linkedGitDirectory = Effect.fn("DockerRunner.linkedGitDirectory")(function* (
    workspace: string,
  ) {
    const dotGit = path.join(workspace, ".git");
    const info = yield* fileSystem.stat(dotGit).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return null;
    const pointer = yield* fileSystem.readFileString(dotGit).pipe(Effect.orElseSucceed(() => ""));
    const gitDirectory = /^gitdir: (.+)$/m.exec(pointer)?.[1]?.trim();
    if (gitDirectory === undefined) return null;
    const resolved = yield* fileSystem
      .realPath(path.resolve(workspace, gitDirectory))
      .pipe(Effect.orElseSucceed(() => null));
    if (resolved === null) return null;
    const common = yield* fileSystem.readFileString(path.join(resolved, "commondir")).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (common === "") return null;
    const commonDirectory = yield* fileSystem
      .realPath(path.resolve(resolved, common))
      .pipe(Effect.orElseSucceed(() => null));
    if (commonDirectory === null || !isWithin(commonDirectory, resolved)) return null;
    return isWithin(workspace, commonDirectory)
      ? null
      : { commonDirectory, gitDirectory: resolved };
  });

  const touch = (file: string) =>
    DateTime.now.pipe(
      Effect.map(DateTime.toDate),
      Effect.flatMap((now) => fileSystem.utimes(file, now, now)),
    );

  /** Starts the session's container unless it is already running, under the lifecycle lock. */
  const ensureContainer = Effect.fn("DockerRunner.ensureContainer")(function* (input: {
    readonly name: string;
    readonly sessionHash: string;
    readonly workspaceHash: string;
    readonly mounts: ReadonlyArray<string>;
    readonly workdir: string;
    readonly holder: ContainerHolder;
  }) {
    const heartbeat = path.join(heartbeats, input.name);
    const labels = {
      [`${LABEL}.managed`]: "true",
      [`${LABEL}.scope`]: scope,
      [`${LABEL}.session`]: input.sessionHash,
      [`${LABEL}.workspace`]: input.workspaceHash,
      [`${LABEL}.runner-contract`]: RUNNER_CONTRACT,
    };
    const tracked = containers.get(input.name);
    const merge = (container: Container) => {
      for (const itemId of input.holder.itemIds) container.holder.itemIds.add(itemId);
      container.holder.usesVault ||= input.holder.usesVault;
    };
    // Settled before any heartbeat is touched: one left by a crashed T3 shares the heartbeat file,
    // and touching it would keep that container, and the values in it, alive.
    const inspected = yield* engine(["container", "inspect", input.name]);
    if (inspected.exitCode === 0) {
      const listed = Option.getOrUndefined(decodeJson(inspected.stdout));
      const details = Array.isArray(listed) ? listed[0] : undefined;
      const containerConfig = field(details, "Config");
      const reusable =
        field(containerConfig, "Image") === RUNNER_IMAGE &&
        Object.entries(labels).every(
          ([key, value]) => field(field(containerConfig, "Labels"), key) === value,
        );
      const running = field(field(details, "State"), "Running") === true;
      const id = field(details, "Id");
      // Only the very container this record has tracked from the start: any other, whatever its
      // labels, may hold values no record here covers.
      const known =
        tracked !== undefined && typeof id === "string" && id !== "" && id === tracked.id;
      if (reusable && known && (running || (yield* engine(["start", id])).exitCode === 0)) {
        yield* touch(heartbeat).pipe(Effect.ignore);
        merge(tracked);
        return true;
      }
      if (!(yield* removeContainer(input.name))) {
        // Without its heartbeat file, the container ends itself within seconds.
        yield* destroy(input.name);
        return false;
      }
    }
    let container = tracked;
    if (container === undefined) {
      yield* fileSystem.makeDirectory(heartbeats, { recursive: true });
      yield* fileSystem.writeFileString(heartbeat, "");
      const fiber = yield* touch(heartbeat).pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(HEARTBEAT_EVERY)),
        Effect.forkIn(serviceScope),
      );
      container = {
        name: input.name,
        holder: { projectId: input.holder.projectId, itemIds: new Set(), usesVault: false },
        active: 0,
        lastUsed: yield* Clock.currentTimeMillis,
        delivered: new Map(),
        gate: yield* Semaphore.make(GATE_PERMITS),
        id: null,
        retired: false,
        heartbeat: fiber,
      };
      containers.set(input.name, container);
    } else {
      yield* touch(heartbeat).pipe(Effect.ignore);
    }
    merge(container);
    const tmpfsOwner = `uid=${RUN_AS.split(":")[0]},gid=${RUN_AS.split(":")[1]}`;
    const created = yield* engine([
      "create",
      "--name",
      input.name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--user",
      RUN_AS,
      "--workdir",
      input.workdir,
      "--read-only",
      "--restart",
      "no",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      "256",
      "--init",
      "--tmpfs",
      `/run/t3-secure:rw,noexec,nosuid,nodev,size=17825792,mode=0700,${tmpfsOwner}`,
      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev,size=1073741824,mode=1777",
      "--mount",
      `type=bind,source=${heartbeat},target=${GUEST_HEARTBEAT_PATH},readonly`,
      ...input.mounts.flatMap((mount) => ["--mount", mount]),
      RUNNER_IMAGE,
      "node",
      "-e",
      GUEST_KEEPALIVE_SOURCE,
    ]);
    // `docker create` prints the new container's id.
    const id = created.stdout.trim();
    if (created.exitCode !== 0 || id === "" || (yield* engine(["start", id])).exitCode !== 0) {
      yield* destroy(input.name);
      return false;
    }
    container.id = id;
    return true;
  });

  const sshFiles = Effect.gen(function* () {
    const home = yield* HostProcess.HomeDirectory;
    const files: Record<string, string> = {};
    for (const name of COPIED_SSH_FILES) {
      const file = path.join(home, ".ssh", name);
      const info = yield* fileSystem.stat(file).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      if (Number(info.value.size) > MAX_SSH_FILE_BYTES) continue;
      const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
      if (Option.isSome(text)) files[name] = text.value;
    }
    return files;
  });

  const terminate = (containerId: string, executionId: string) =>
    engine(
      [
        "exec",
        "--user",
        RUN_AS,
        containerId,
        "node",
        "-e",
        GUEST_TERMINATOR_SOURCE,
        layout.executions,
        executionId,
      ],
      { timeout: TERMINATE_TIMEOUT },
    );

  const containerName = (sessionId: string, workspace: string) => {
    const sessionHash = sha256(sessionId);
    const workspaceHash = sha256(workspace);
    const hash = sha256(`${sessionHash}\0${workspaceHash}`).slice(0, 20);
    return { name: `t3-secure-${scope.slice(0, 10)}-${hash}`, sessionHash, workspaceHash };
  };

  const rememberIn = (
    container: Container,
    values: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  ) => {
    for (const { name, value } of values) {
      if (value.length > 0 && !container.delivered.has(value)) container.delivered.set(value, name);
    }
  };

  const run: DockerRunner["Service"]["run"] = Effect.fn("DockerRunner.run")(function* (input) {
    if ((yield* status(false)).state !== "ready") {
      return yield* new SecureExecError({ stage: "runner", cause: "runner not ready" });
    }
    const workspace = yield* fileSystem
      .realPath(input.cwd)
      .pipe(Effect.mapError((cause) => new SecureExecError({ stage: "spawn", cause })));
    const linked = yield* linkedGitDirectory(workspace);
    if ([workspace, linked?.commonDirectory ?? "", heartbeats].some((dir) => dir.includes(","))) {
      return yield* new SecureExecError({
        stage: "sandbox_path",
        cause: "comma in a mounted path",
      });
    }
    // Docker Desktop on Windows mounts host folders into a Linux guest, where they need Linux paths.
    const windows = platform === "win32";
    const workdir = windows ? "/workspace" : workspace;
    const gitTarget = linked === null ? null : windows ? "/t3-git-common" : linked.commonDirectory;
    const mounts = [
      `type=bind,source=${workspace},target=${workdir}`,
      ...(linked === null || gitTarget === null
        ? []
        : [`type=bind,source=${linked.commonDirectory},target=${gitTarget}`]),
    ];
    // A worktree's `.git` file names a Windows path the guest can't follow.
    const git =
      windows && linked !== null && gitTarget !== null
        ? {
            GIT_DIR: `${gitTarget}/${path
              .relative(linked.commonDirectory, linked.gitDirectory)
              .split(path.sep)
              .join("/")}`,
            GIT_WORK_TREE: workdir,
          }
        : null;
    const { name, sessionHash, workspaceHash } = containerName(input.sessionId, workspace);

    // Reserved under the lock, so idle cleanup can't destroy a container a command is about to use.
    const reserve = lifecycle.withPermits(1)(
      ensureContainer({ name, sessionHash, workspaceHash, mounts, workdir, holder: input }).pipe(
        Effect.orElseSucceed(() => false),
        Effect.map((ready) => {
          const container = ready ? containers.get(name) : undefined;
          if (container !== undefined) container.active += 1;
          return container ?? null;
        }),
      ),
    );
    const release = (container: Container | null) =>
      container === null
        ? Effect.void
        : Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              container.active -= 1;
              container.lastUsed = now;
            }),
          );
    // A container that loses track of a command, or of the values to filter, can't be trusted.
    const discard = lifecycle.withPermits(1)(destroy(name));
    const execute = Effect.fn("DockerRunner.execute")(function* (container: Container) {
      const target = container.id;
      if (container.retired || target === null) {
        return yield* new SecureExecError({ stage: "runner", cause: "container was replaced" });
      }
      const executionId = NodeCrypto.randomBytes(12).toString("hex");
      // The executor prints this only once it has cleaned up; the command can't know it.
      const done = new TextEncoder().encode(
        `${EXECUTOR_DONE}${NodeCrypto.randomBytes(16).toString("hex")}\n`,
      );
      // Recorded before the command starts, so a concurrent one's output is filtered for these too.
      rememberIn(
        container,
        Object.entries(input.deliveries).map(([name, value]) => ({ name, value })),
      );
      const frame = new TextEncoder().encode(
        encodeJson({
          version: 1,
          executionId,
          layout,
          command: input.command,
          cwd: workdir,
          env: input.deliveries,
          sshKeys: input.sshKeys.map(normalizeSshPrivateKey),
          sshFiles: yield* sshFiles,
          git,
          done: new TextDecoder().decode(done),
        }),
      );
      const pinned = yield* pinnedHost;
      if (pinned === null || pinned.endpoint === null) {
        return yield* new SecureExecError({ stage: "runner", cause: "engine unavailable" });
      }
      const env = yield* dockerEnvironment;
      let settled = false;
      const output = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(
                pinned.executable,
                [
                  "--host",
                  pinned.endpoint,
                  "exec",
                  "-i",
                  "--user",
                  RUN_AS,
                  target,
                  "node",
                  "-e",
                  GUEST_EXECUTOR_SOURCE,
                ],
                {
                  env,
                  extendEnv: false,
                  stdin: Stream.make(frame),
                  forceKillAfter: FORCE_KILL_AFTER,
                },
              ),
            )
            .pipe(
              Effect.mapError((cause) => new SecureExecError({ stage: "spawn", cause })),
              Effect.catchDefect((cause) =>
                Effect.fail(new SecureExecError({ stage: "spawn", cause })),
              ),
            );
          // The last bytes of stderr, which hold the done code even when the output overflows.
          let tail = new Uint8Array();
          const watched = handle.stderr.pipe(
            Stream.map((chunk) => {
              const joined = new Uint8Array(tail.length + chunk.length);
              joined.set(tail);
              joined.set(chunk, tail.length);
              tail = joined.slice(Math.max(0, joined.length - done.length));
              return chunk;
            }),
          );
          const confirmed = () => Buffer.from(tail).equals(Buffer.from(done));
          const empty = { bytes: new Uint8Array(), overflow: false };
          const stdout = yield* collectBounded(handle.stdout, SECURE_EXEC_MAX_STREAM_BYTES).pipe(
            Effect.orElseSucceed(() => empty),
            Effect.forkScoped,
          );
          const stderr = yield* collectBounded(watched, SECURE_EXEC_MAX_STREAM_BYTES).pipe(
            Effect.orElseSucceed(() => empty),
            Effect.forkScoped,
          );
          const exitCode = handle.exitCode.pipe(
            Effect.map((code): number | null => code),
            Effect.orElseSucceed(() => null),
          );
          // Stopping the `docker exec` client leaves the command running in the container, so the
          // executor is told to stop it and must confirm; failing that, the container goes.
          const stopAndConfirm = Effect.gen(function* () {
            const stopped = yield* terminate(target, executionId);
            const ended = yield* exitCode.pipe(Effect.timeoutOption(Duration.seconds(10)));
            yield* Fiber.await(stderr).pipe(Effect.timeoutOption(Duration.seconds(2)));
            if (stopped.exitCode !== 0 || Option.isNone(ended) || !confirmed()) yield* discard;
          });
          const exit = yield* exitCode.pipe(
            Effect.timeoutOption(input.timeout),
            Effect.onInterrupt(() => {
              settled = true;
              return stopAndConfirm;
            }),
          );
          settled = true;
          if (Option.isNone(exit)) yield* stopAndConfirm;
          const out = yield* Fiber.join(stdout);
          const err = yield* Fiber.join(stderr);
          if (Option.isSome(exit) && !confirmed()) {
            yield* discard;
            return yield* new SecureExecError({ stage: "runner", cause: "lost the executor" });
          }
          const stderrBytes =
            !err.overflow && Buffer.from(err.bytes).subarray(-done.length).equals(Buffer.from(done))
              ? err.bytes.subarray(0, err.bytes.length - done.length)
              : err.bytes;
          const code = Option.getOrNull(exit);
          if (code === 125) {
            const text = new TextDecoder().decode(stderrBytes.subarray(0, 64));
            if (text.startsWith(EXECUTOR_FAILURE)) {
              const failure = text.slice(EXECUTOR_FAILURE.length).split("\n")[0];
              return yield* new SecureExecError({
                stage:
                  failure === "ssh-key"
                    ? "ssh_key"
                    : failure === "ssh-agent"
                      ? "ssh_agent"
                      : "spawn",
                cause: failure,
              });
            }
          }
          return {
            exitCode: code,
            timedOut: Option.isNone(exit),
            stdout: out,
            stderr: { bytes: stderrBytes, overflow: err.overflow },
          } satisfies SecureExecOutput;
        }),
      ).pipe(
        // Stopped before the command was watched: the cancel mark keeps it from starting.
        Effect.onInterrupt(() =>
          settled
            ? Effect.void
            : terminate(target, executionId).pipe(
                Effect.flatMap((stopped) => (stopped.exitCode === 0 ? Effect.void : discard)),
              ),
        ),
      );
      const delivered = [...container.delivered].map(([value, alias]) => ({
        name: alias,
        value,
      }));
      if (container.delivered.size > MAX_REMEMBERED_VALUES) yield* discard;
      return { ...output, delivered } satisfies DockerRunOutput;
    });
    return yield* Effect.acquireUseRelease(
      reserve,
      (container) =>
        container === null
          ? Ref.set(cachedStatus, null).pipe(
              Effect.andThen(
                Effect.fail(
                  new SecureExecError({ stage: "runner", cause: "container didn't start" }),
                ),
              ),
            )
          : input.generates === true
            ? container.gate.withPermits(GATE_PERMITS)(
                execute(container).pipe(Effect.ensuring(discard)),
              )
            : container.gate.withPermits(1)(execute(container)),
      release,
    );
  });

  // Containers left by an earlier T3 process hold nothing this one granted.
  const sweep = Effect.gen(function* () {
    const listed = yield* engine([
      "ps",
      "-a",
      "--filter",
      `label=${LABEL}.managed=true`,
      "--filter",
      `label=${LABEL}.scope=${scope}`,
      "--format",
      "{{.Names}}",
    ]);
    if (listed.exitCode !== 0) return;
    const names = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !containers.has(line));
    yield* Effect.forEach(names, removeContainer, { discard: true });
  });

  // Taken before forking, so the first container waits until the sweep is done.
  if (platform === "win32") {
    yield* lifecycle.take(1);
    yield* sweep.pipe(
      Effect.ignore,
      Effect.ensuring(lifecycle.release(1)),
      Effect.forkIn(serviceScope),
    );
  }

  // Chosen under the lock, so a command that just reserved a container keeps it.
  yield* lifecycle
    .withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const idle = [...containers.values()].filter(
          (container) =>
            container.active === 0 && now - container.lastUsed > Duration.toMillis(IDLE_AFTER),
        );
        yield* Effect.forEach(idle, (container) => destroy(container.name), { discard: true });
      }),
    )
    .pipe(Effect.repeat(Schedule.spaced(Duration.minutes(1))), Effect.forkIn(serviceScope));

  yield* Effect.addFinalizer(() =>
    retire(() => true).pipe(Effect.timeout(Duration.seconds(30)), Effect.ignore),
  );

  return DockerRunner.of({ status, installRunner, run, retire });
});

export const layer = Layer.effect(DockerRunner, make);

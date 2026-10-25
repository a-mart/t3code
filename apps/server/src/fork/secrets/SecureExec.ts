/**
 * Runs one `secure_bash` command on this host with secret values in its
 * environment. Each run gets a private TMPDIR and its own process group, and
 * the group is terminated when the shell exits, so no process holding a value
 * outlives the call. Output is returned raw; the caller redacts it.
 *
 * Given a nono executable, the command runs inside its sandbox instead: a
 * clean environment, an empty HOME that is deleted afterwards, writes only to
 * the workspace (with its git directories), the private TMPDIR, and the shared
 * temp folders nono's own policy allows, and none of the host's credentials.
 * This guards against careless commands, not hostile ones: the agent's
 * ordinary shell still runs unsandboxed.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectBounded, type BoundedOutput } from "./boundedOutput.ts";
import { NONO_ENVIRONMENT } from "./Nono.ts";

export const SECURE_EXEC_MAX_STREAM_BYTES = 1024 * 1024;
const FORCE_KILL_AFTER = Duration.seconds(3);
const SSH_AGENT_READY_TIMEOUT = Duration.seconds(5);

// A sandboxed command starts from these host variables only, keeping the host's tokens and agent out.
const SANDBOX_INHERITED_VARIABLES = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME"];
// nono's built-in policy denies ~/.ssh. Host keys and aliases are let through; private keys aren't.
const SANDBOX_READABLE_SSH_FILES = ["known_hosts", "config"];

// Inherited variables that would change what the shell runs or leak T3's own `bw` login.
const STRIPPED_VARIABLES: ReadonlySet<string> = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "ENV",
  "PROMPT_COMMAND",
  "SHELLOPTS",
]);
const STRIPPED_PREFIXES = ["BASH_FUNC_", "BITWARDENCLI_", "BW_"];

/**
 * Prints the variable `T3_ASKPASS_VAR` names, for programs that ask for a
 * password through an askpass helper (OpenSSH, sudo -A, git). The name is
 * checked so the helper can't be pointed at an expression.
 */
const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  'case "$T3_ASKPASS_VAR" in ""|[0-9]*|*[!A-Za-z0-9_]*) exit 64;; esac',
  'exec printenv "$T3_ASKPASS_VAR"',
  "",
].join("\n");

const secureCommandBaseEnvironment = (
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined || STRIPPED_VARIABLES.has(name)) continue;
    if (STRIPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    base[name] = value;
  }
  return base;
};

const sandboxBaseEnvironment = (
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const name of SANDBOX_INHERITED_VARIABLES) {
    const value = host[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
};

/** Keys pasted on Windows carry CRLF line endings, which `ssh-add` rejects. */
export const normalizeSshPrivateKey = (key: string): string =>
  key.includes("PRIVATE KEY-----") ? `${key.replace(/\r\n?/g, "\n").trimEnd()}\n` : key;

export class SecureExecError extends Schema.TaggedError<SecureExecError>()("SecureExecError", {
  stage: Schema.Literals([
    "temp_directory",
    "spawn",
    "ssh_agent",
    "ssh_key",
    "sandbox_path",
    "runner",
  ]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    switch (this.stage) {
      case "temp_directory":
        return "Couldn't create the command's private temporary directory.";
      case "spawn":
        return "Couldn't start the command.";
      case "ssh_agent":
        return "Couldn't start ssh-agent for the command.";
      case "ssh_key":
        return "ssh-add rejected an SSH key.";
      case "sandbox_path":
        return "The sandbox can't grant a folder whose path contains a comma.";
      case "runner":
        return "Docker couldn't run the command.";
    }
  }
}

export interface SecureExecInput {
  readonly command: string;
  readonly cwd: string;
  /** Variable name to value, added on top of the host environment. */
  readonly deliveries: Readonly<Record<string, string>>;
  /** Private keys loaded into a per-command ssh-agent. */
  readonly sshKeys: ReadonlyArray<string>;
  readonly timeout: Duration.Duration;
  /** The nono that sandboxes the command; null runs it directly on the host. */
  readonly nono: string | null;
}

export interface SecureExecOutput {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: BoundedOutput;
  readonly stderr: BoundedOutput;
}

export class SecureExec extends Context.Service<
  SecureExec,
  {
    readonly run: (input: SecureExecInput) => Effect.Effect<SecureExecOutput, SecureExecError>;
  }
>()("t3/fork/secrets/SecureExec") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** Starts an agent that lives as long as the command's scope and loads the keys into it. */
  const startSshAgent = Effect.fn("SecureExec.startSshAgent")(function* (
    directory: string,
    env: Record<string, string>,
    keys: ReadonlyArray<string>,
  ) {
    const socket = path.join(directory, "agent.sock");
    const agent = yield* spawner
      .spawn(
        ChildProcess.make("ssh-agent", ["-D", "-a", socket], {
          env,
          extendEnv: false,
          stdin: "ignore",
          stderr: "ignore",
          forceKillAfter: FORCE_KILL_AFTER,
        }),
      )
      .pipe(Effect.mapError((cause) => new SecureExecError({ stage: "ssh_agent", cause })));
    // `ssh-agent -D` prints its SSH_AUTH_SOCK line once the socket is listening.
    const ready = yield* agent.stdout.pipe(
      Stream.decodeText(),
      Stream.takeUntil((text) => text.includes("SSH_AUTH_SOCK=")),
      Stream.runDrain,
      Effect.timeoutOption(SSH_AGENT_READY_TIMEOUT),
      Effect.mapError((cause) => new SecureExecError({ stage: "ssh_agent", cause })),
    );
    if (Option.isNone(ready)) {
      return yield* new SecureExecError({ stage: "ssh_agent", cause: "ssh-agent didn't start" });
    }
    for (const key of keys) {
      const exitCode = yield* Effect.scoped(
        Effect.gen(function* () {
          const add = yield* spawner.spawn(
            ChildProcess.make("ssh-add", ["-"], {
              env: { ...env, SSH_AUTH_SOCK: socket },
              extendEnv: false,
              stdin: Stream.make(new TextEncoder().encode(normalizeSshPrivateKey(key))),
              stdout: "ignore",
              stderr: "ignore",
              forceKillAfter: FORCE_KILL_AFTER,
            }),
          );
          return yield* add.exitCode;
        }),
      ).pipe(Effect.mapError((cause) => new SecureExecError({ stage: "ssh_key", cause })));
      if (exitCode !== 0) {
        return yield* new SecureExecError({
          stage: "ssh_key",
          cause: `ssh-add exited ${exitCode}`,
        });
      }
    }
    return socket;
  });

  const isWithin = (child: string, parent: string) =>
    child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

  /**
   * The repository around `cwd`, which must be a real path, that git writes to:
   * its top level and, when the git directory lives elsewhere (a linked
   * worktree, a submodule, or a symlinked `.git`), that directory too.
   */
  const repositoryDirectories = Effect.fn("SecureExec.repositoryDirectories")(function* (
    cwd: string,
  ) {
    for (let directory = cwd; ; directory = path.dirname(directory)) {
      const dotGit = path.join(directory, ".git");
      const info = yield* fileSystem.stat(dotGit).pipe(Effect.option);
      if (Option.isSome(info)) {
        if (info.value.type !== "File") {
          const gitDirectory = yield* fileSystem
            .realPath(dotGit)
            .pipe(Effect.orElseSucceed(() => dotGit));
          return isWithin(gitDirectory, directory) ? [directory] : [directory, gitDirectory];
        }
        const pointer = yield* fileSystem
          .readFileString(dotGit)
          .pipe(Effect.orElseSucceed(() => ""));
        const gitDirectory = /^gitdir: (.+)$/m.exec(pointer)?.[1]?.trim();
        if (gitDirectory === undefined) return [directory];
        const resolved = path.resolve(directory, gitDirectory);
        const common = yield* fileSystem.readFileString(path.join(resolved, "commondir")).pipe(
          Effect.map((text) => text.trim()),
          Effect.orElseSucceed(() => ""),
        );
        const target = common === "" ? resolved : path.resolve(resolved, common);
        const exists = yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
        return exists ? [directory, target] : [directory];
      }
      if (path.dirname(directory) === directory) return [];
    }
  });

  /**
   * PATH folders inside the home folder, so tools installed there still run. A
   * `bin` folder brings its parent, where version managers keep what their
   * launchers load, unless that parent is shared, like `~/.local`.
   */
  const toolDirectories = Effect.fn("SecureExec.toolDirectories")(function* (
    pathVariable: string | undefined,
    home: string,
  ) {
    const shared = new Set([home, path.join(home, ".local")]);
    const directories = new Set<string>();
    for (const entry of (pathVariable ?? "").split(":")) {
      if (!path.isAbsolute(entry)) continue;
      const real = yield* fileSystem.realPath(entry).pipe(Effect.option);
      if (Option.isNone(real) || !isWithin(real.value, home)) continue;
      // nono refuses a folder grant naming a file, which would stop every command.
      const info = yield* fileSystem.stat(real.value).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") continue;
      const parent = path.dirname(real.value);
      directories.add(
        path.basename(real.value) === "bin" && !shared.has(parent) ? parent : real.value,
      );
    }
    return [...directories];
  });

  const sandboxArguments = Effect.fn("SecureExec.sandboxArguments")(function* (options: {
    readonly cwd: string;
    readonly tempDirectory: string;
    readonly pathVariable: string | undefined;
    readonly agentSocket: string | null;
  }) {
    // Compared as real paths, the way nono resolves what it grants.
    const real = (directory: string) =>
      fileSystem.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
    const home = yield* real(yield* HostProcess.HomeDirectory);
    // nono refuses to grant a folder that holds its own state, such as the home folder itself.
    const nonoState = path.join(home, ".local", "state", "nono");
    const grantable = (directory: string) => !isWithin(nonoState, directory);
    // Resolved first: walking up from a symlinked workspace would find the link's repository.
    const cwd = yield* real(options.cwd);
    const repository = yield* Effect.forEach(yield* repositoryDirectories(cwd), real);
    // The workspace is granted even when it isn't grantable, so nono's refusal reaches the agent.
    const writable = new Set([
      cwd,
      ...repository.filter(grantable),
      yield* real(options.tempDirectory),
    ]);
    // nono splits an --allow value at commas, so such a path would grant something else.
    if ([...writable].some((directory) => directory.includes(","))) {
      return yield* new SecureExecError({
        stage: "sandbox_path",
        cause: "comma in a granted path",
      });
    }
    const args = ["wrap", "--silent", "--no-diagnostics"];
    for (const directory of writable) args.push("--allow", directory);
    for (const directory of yield* toolDirectories(options.pathVariable, home)) {
      if (grantable(directory)) args.push("--read", directory);
    }
    for (const name of SANDBOX_READABLE_SSH_FILES) {
      const file = path.join(home, ".ssh", name);
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        args.push("--read-file", file, "--bypass-protection", file);
      }
    }
    if (options.agentSocket !== null) args.push("--allow-unix-socket", options.agentSocket);
    return args;
  });

  const run: SecureExec["Service"]["run"] = Effect.fn("SecureExec.run")(function* (input) {
    const host = yield* HostProcess.Environment;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Acquired before any process, so it is removed after they are gone.
        const tempDirectory = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3-secure-" })
          .pipe(
            Effect.mapError((cause) => new SecureExecError({ stage: "temp_directory", cause })),
          );
        const askpass = path.join(tempDirectory, "t3-askpass");
        yield* fileSystem
          .writeFileString(askpass, ASKPASS_SCRIPT, { mode: 0o700 })
          .pipe(
            Effect.mapError((cause) => new SecureExecError({ stage: "temp_directory", cause })),
          );
        const base =
          input.nono === null ? secureCommandBaseEnvironment(host) : sandboxBaseEnvironment(host);
        const sshAuthSock =
          input.sshKeys.length === 0
            ? null
            : yield* startSshAgent(tempDirectory, base, input.sshKeys);
        const env: Record<string, string> = {
          ...base,
          TMPDIR: tempDirectory,
          TMP: tempDirectory,
          TEMP: tempDirectory,
          T3_ASKPASS: askpass,
          ...(sshAuthSock === null ? {} : { SSH_AUTH_SOCK: sshAuthSock }),
          ...input.deliveries,
        };
        const shell = ["--noprofile", "--norc", "-c", input.command];
        let launch: {
          readonly executable: string;
          readonly args: ReadonlyArray<string>;
          readonly env: Record<string, string>;
        } = { executable: "/bin/bash", args: shell, env };
        if (input.nono !== null) {
          const home = path.join(tempDirectory, "home");
          yield* fileSystem
            .makeDirectory(home, { mode: 0o700 })
            .pipe(
              Effect.mapError((cause) => new SecureExecError({ stage: "temp_directory", cause })),
            );
          const sandbox = yield* sandboxArguments({
            cwd: input.cwd,
            tempDirectory,
            pathVariable: base.PATH,
            agentSocket: sshAuthSock,
          });
          // nono reads its policy against the real HOME and won't keep its state inside a grant,
          // so the command gets its own HOME only once inside the sandbox.
          launch = {
            executable: input.nono,
            args: [...sandbox, "--", "/usr/bin/env", `HOME=${home}`, "/bin/bash", ...shell],
            env: { ...env, HOME: yield* HostProcess.HomeDirectory, ...NONO_ENVIRONMENT },
          };
        }
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(launch.executable, launch.args, {
              cwd: input.cwd,
              env: launch.env,
              extendEnv: false,
              stdin: "ignore",
              forceKillAfter: FORCE_KILL_AFTER,
            }),
          )
          .pipe(
            Effect.mapError((cause) => new SecureExecError({ stage: "spawn", cause })),
            Effect.catchDefect((cause) =>
              Effect.fail(new SecureExecError({ stage: "spawn", cause })),
            ),
          );
        const empty = { bytes: new Uint8Array(), overflow: false } satisfies BoundedOutput;
        const stdout = yield* collectBounded(handle.stdout, SECURE_EXEC_MAX_STREAM_BYTES).pipe(
          Effect.orElseSucceed(() => empty),
          Effect.forkScoped,
        );
        const stderr = yield* collectBounded(handle.stderr, SECURE_EXEC_MAX_STREAM_BYTES).pipe(
          Effect.orElseSucceed(() => empty),
          Effect.forkScoped,
        );
        const exit = yield* handle.exitCode.pipe(
          // A signal exit fails `exitCode`; it reports as no exit code.
          Effect.map((code): number | null => code),
          Effect.orElseSucceed(() => null),
          Effect.timeoutOption(input.timeout),
        );
        // Background children would hold the pipes open; end the whole group first.
        yield* handle.kill({ forceKillAfter: FORCE_KILL_AFTER }).pipe(Effect.ignore);
        return {
          exitCode: Option.getOrNull(exit),
          timedOut: Option.isNone(exit),
          stdout: yield* Fiber.join(stdout),
          stderr: yield* Fiber.join(stderr),
        } satisfies SecureExecOutput;
      }),
    );
  });

  return SecureExec.of({ run });
});

export const layer = Layer.effect(SecureExec, make);

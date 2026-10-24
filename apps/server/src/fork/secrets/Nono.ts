/**
 * Finds, checks, and installs nono (github.com/nolabs-ai/nono), the sandbox
 * secret-backed commands run in while Settings → Secrets → "Run secret
 * commands in a sandbox" is on.
 *
 * A nono counts only once it has applied a sandbox on this host: Linux needs a
 * kernel with Landlock, so a copy can be present and still unable to sandbox.
 */
import { ForkSecretsError, type ForkSecretsFailureReason } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ManagedBinary from "../managedBinary.ts";
import { collectBounded } from "./boundedOutput.ts";

const VERSION_OUTPUT = /^nono (\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)\s*$/;
const PROBE_TIMEOUT = Duration.seconds(15);

/** Without it, nono checks GitHub for updates on every command. */
export const NONO_ENVIRONMENT: Readonly<Record<string, string>> = { NONO_NO_UPDATE_CHECK: "1" };

// What nono 0.80.0 strips from a sandboxed command's environment, from
// crates/nono-cli/src/exec_strategy/env_sanitization.rs. Recheck when the pin moves.
const DROPPED_VARIABLES: ReadonlySet<string> = new Set([
  "BASH_ENV",
  "CDPATH",
  "DOTNET_STARTUP_HOOKS",
  "ENV",
  "GEM_HOME",
  "GEM_PATH",
  "GLOBIGNORE",
  "GOFLAGS",
  "IFS",
  "JAVA_TOOL_OPTIONS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "OP_CONNECT_HOST",
  "OP_CONNECT_TOKEN",
  "OP_SERVICE_ACCOUNT_TOKEN",
  "PERL5LIB",
  "PERL5OPT",
  "PROMPT_COMMAND",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "_JAVA_OPTIONS",
]);
const DROPPED_PREFIXES = ["BASH_FUNC_", "DYLD_", "LD_", "NONO_", "OP_SESSION_"];

/** Whether nono removes `name` from a sandboxed command's environment. */
export const nonoDropsVariable = (name: string) =>
  DROPPED_VARIABLES.has(name) || DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix));

/**
 * The official release T3 installs. Pinned, with GitHub's SHA-256 digests, so
 * a new nono reaches hosts only through a reviewed change here.
 */
export const MANAGED_NONO_VERSION = "0.80.0";

const official = (target: string, bytes: number, sha256: string): ManagedBinary.PinnedRelease => ({
  version: MANAGED_NONO_VERSION,
  url: `https://github.com/nolabs-ai/nono/releases/download/v${MANAGED_NONO_VERSION}/nono-v${MANAGED_NONO_VERSION}-${target}.tar.gz`,
  bytes,
  sha256,
});

const OFFICIAL_RELEASES: Readonly<Partial<Record<string, ManagedBinary.PinnedRelease>>> = {
  "darwin-arm64": official(
    "aarch64-apple-darwin",
    10_472_131,
    "ae824167b3d90531b830429ba92b7781379b1c2d79f9b11fdd88b0fd267e4e32",
  ),
  "darwin-x64": official(
    "x86_64-apple-darwin",
    11_767_123,
    "b354e674e6b4643ad5c572d148ae367bb0c5c103410fbc22923c5593a6f7d0b2",
  ),
  "linux-arm64": official(
    "aarch64-unknown-linux-gnu",
    11_837_252,
    "d2a24c8c37714f85c829b5586ffd81fc2acf336c95372d881ba62140884f22cb",
  ),
  "linux-x64": official(
    "x86_64-unknown-linux-gnu",
    12_873_206,
    "6da665b61999570c10dffc7da78828fe1fb7f3cac53319e505cebecaef17037f",
  ),
};

/** Replaces the official release, for tests that install from a local archive. */
export const ManagedNonoReleaseOverride = Context.Reference<ManagedBinary.PinnedRelease | null>(
  "t3/fork/secrets/Nono/ManagedNonoReleaseOverride",
  { defaultValue: () => null },
);

export interface NonoExecutable {
  readonly path: string;
  readonly version: string;
  /** Whether this is the copy T3 installed. */
  readonly managed: boolean;
}

export class Nono extends Context.Service<
  Nono,
  {
    /** The version `install` provides here; null where nono has no build for this platform. */
    readonly installVersion: string | null;
    /** T3's copy, else one found on this host, that applies a sandbox here; null when none does. */
    readonly find: Effect.Effect<NonoExecutable | null>;
    /** Downloads, verifies, and installs the pinned official nono, replacing an older copy. */
    readonly install: Effect.Effect<NonoExecutable, ForkSecretsError>;
  }
>()("t3/fork/secrets/Nono") {}

const failure = (reason: ForkSecretsFailureReason) => new ForkSecretsError({ reason });

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const installServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
  >();
  const platform = yield* HostProcess.Platform;
  const managedPath = path.join(config.stateDir, "fork", "bin", "nono");
  const release =
    (yield* ManagedNonoReleaseOverride) ??
    OFFICIAL_RELEASES[`${platform}-${yield* HostProcess.Architecture}`] ??
    null;
  // A check runs nono twice, so its result is kept until the file changes.
  const checked = yield* Ref.make(
    new Map<string, { readonly identity: string; readonly version: string | null }>(),
  );

  /** Exit code and stdout, or null when it didn't start or finish in time. */
  const runProbe = (executable: string, args: ReadonlyArray<string>, cwd: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(executable, args, {
            cwd,
            // nono expands `~` in its built-in policy from HOME, so it gets the real one.
            env: {
              PATH: "/usr/bin:/bin",
              HOME: yield* HostProcess.HomeDirectory,
              ...NONO_ENVIRONMENT,
            },
            extendEnv: false,
            stdin: "ignore",
            stderr: "ignore",
            forceKillAfter: Duration.seconds(2),
          }),
        );
        const stdout = yield* collectBounded(handle.stdout, 4096);
        return { stdout, exitCode: yield* handle.exitCode };
      }),
    ).pipe(
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.map(Option.getOrNull),
      Effect.catchDefect(() => Effect.succeed(null)),
      Effect.orElseSucceed(() => null),
    );

  const probeVersion = (executable: string) =>
    runProbe(executable, ["--version"], path.dirname(executable)).pipe(
      Effect.map((result) =>
        result === null || result.exitCode !== 0 || result.stdout.overflow
          ? null
          : (VERSION_OUTPUT.exec(new TextDecoder().decode(result.stdout.bytes))?.[1] ?? null),
      ),
    );

  /** Whether `executable` applies a sandbox here the way commands use it. */
  const appliesSandbox = (executable: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-nono-check-" });
        const result = yield* runProbe(
          executable,
          ["wrap", "--silent", "--no-diagnostics", "--allow", directory, "--", "/usr/bin/true"],
          directory,
        );
        return result?.exitCode === 0;
      }),
    ).pipe(Effect.orElseSucceed(() => false));

  const inspect = Effect.fn("Nono.inspect")(function* (candidate: string) {
    const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File" || (info.value.mode & 0o111) === 0) {
      return null;
    }
    const realPath = yield* fileSystem
      .realPath(candidate)
      .pipe(Effect.orElseSucceed(() => candidate));
    const identity = `${info.value.size}:${Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0}`;
    const cached = (yield* Ref.get(checked)).get(realPath);
    let version = cached?.identity === identity ? cached.version : null;
    if (cached?.identity !== identity) {
      version = yield* probeVersion(realPath);
      if (version !== null && !(yield* appliesSandbox(realPath))) version = null;
      yield* Ref.update(checked, (current) =>
        new Map(current).set(realPath, { identity, version }),
      );
    }
    return version === null ? null : { path: realPath, version };
  });

  const find: Nono["Service"]["find"] = Effect.gen(function* () {
    if (platform === "win32") return null;
    const managed = yield* inspect(managedPath);
    if (managed !== null) return { ...managed, managed: true };
    // The desktop app starts the server with the login shell's PATH.
    const host = yield* HostProcess.Environment;
    const directories = (host.PATH ?? "").split(":").filter((entry) => path.isAbsolute(entry));
    for (const directory of new Set(directories)) {
      const found = yield* inspect(path.join(directory, "nono"));
      if (found !== null) return { ...found, managed: false };
    }
    return null;
  }).pipe(Effect.withSpan("Nono.find"));

  const install: Nono["Service"]["install"] = Effect.gen(function* () {
    if (release === null) return yield* failure("sandbox_install_unsupported");
    // The release archives hold one regular file named `nono`.
    yield* ManagedBinary.installPinnedRelease({
      release,
      target: managedPath,
      extract: ManagedBinary.singleFileTarGz("nono"),
      probeVersion,
    }).pipe(
      Effect.provide(installServices),
      Effect.mapError(() => failure("sandbox_install_failed")),
    );
    const installed = yield* inspect(managedPath);
    // Installed, but this host can't apply the sandbox, such as Linux without Landlock.
    if (installed === null) return yield* failure("sandbox_unavailable");
    return { ...installed, managed: true };
  }).pipe(Effect.withSpan("Nono.install"));

  return Nono.of({ installVersion: release?.version ?? null, find, install });
});

export const layer = Layer.effect(Nono, make);

/**
 * Drives the official Bitwarden Password Manager CLI (`bw`) on this host, and
 * installs a pinned copy of it on request.
 *
 * T3 keeps its own `bw` login in `<stateDir>/bitwarden-cli`, separate from any
 * personal `bw` setup: every unlock replaces the login's one session, so two
 * apps sharing a login would keep locking each other out. Secrets reach `bw`
 * only through environment variables (`--passwordenv`, `BW_SESSION`) or stdin,
 * never through arguments. `bw` stderr can echo item contents, so it is drained
 * and discarded, and failures carry only a fixed reason.
 */
import {
  ForkSecretsError,
  type ForkSecretKind,
  type ForkSecretsFailureReason,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ManagedBinary from "../managedBinary.ts";
import { collectBounded } from "./boundedOutput.ts";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const LOCAL_TIMEOUT = Duration.seconds(30);
// Sign-in and sync talk to the Bitwarden server.
const NETWORK_TIMEOUT = Duration.seconds(90);
const ID_PATTERN = /^[0-9a-fA-F-]{16,128}$/;
const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d+(?:[-+.][0-9A-Za-z.-]+)?$/;
const MAX_TEXT_LENGTH = 1024;
const SYSTEM_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"];

/**
 * The official release T3 installs. Pinned, with GitHub's SHA-256 digests, so
 * a new `bw` reaches hosts only through a reviewed change here.
 */
export const MANAGED_CLI_VERSION = "2026.10.0";

const official = (file: string, bytes: number, sha256: string): ManagedBinary.PinnedRelease => ({
  version: MANAGED_CLI_VERSION,
  url: `https://github.com/bitwarden/clients/releases/download/cli-v${MANAGED_CLI_VERSION}/${file}`,
  bytes,
  sha256,
});

const OFFICIAL_RELEASES: Readonly<Partial<Record<string, ManagedBinary.PinnedRelease>>> = {
  "darwin-arm64": official(
    `bw-macos-arm64-${MANAGED_CLI_VERSION}.zip`,
    41_866_176,
    "062c880508678b8d936ab2522a3a1e92d60f52b5c534e71406e9b47329e95207",
  ),
  "darwin-x64": official(
    `bw-macos-${MANAGED_CLI_VERSION}.zip`,
    44_139_200,
    "39602a597ca63127c22ee3844546f3fe06079e4f67be7b9a7ea4e30ede8721d0",
  ),
  "linux-arm64": official(
    `bw-linux-arm64-${MANAGED_CLI_VERSION}.zip`,
    44_318_274,
    "2fe9d8a18dc4c35ea2f9e3e42a4021f14f129ef47e80b6cea1e3b34176f1583a",
  ),
  "linux-x64": official(
    `bw-linux-${MANAGED_CLI_VERSION}.zip`,
    45_806_876,
    "269b67559caab860d1737f7554b32bdb8be9285d5689fee55193c137a0df9973",
  ),
  "win32-x64": official(
    `bw-windows-${MANAGED_CLI_VERSION}.zip`,
    39_075_364,
    "7b4528962fa1dccc6fdb9ddbec57981004bb6146dedbb5c4c2637756376818e7",
  ),
};

/** Replaces the official release, for tests that install from a local archive. */
export const ManagedCliReleaseOverride = Context.Reference<ManagedBinary.PinnedRelease | null>(
  "t3/fork/secrets/BitwardenCli/ManagedCliReleaseOverride",
  { defaultValue: () => null },
);

export interface BitwardenExecutable {
  readonly path: string;
  readonly version: string;
  /** Whether this is the copy T3 installed. */
  readonly managed: boolean;
}

export type BitwardenCliResolution =
  | { readonly _tag: "Found"; readonly executable: BitwardenExecutable }
  | { readonly _tag: "Missing" }
  /** A `bw-data` folder beside the executable overrides `BITWARDENCLI_APPDATA_DIR`. */
  | { readonly _tag: "Unusable"; readonly path: string };

export interface BitwardenAccountStatus {
  readonly state: "unauthenticated" | "locked" | "unlocked";
  readonly email: string | null;
  readonly serverUrl: string | null;
}

export interface BitwardenOrganization {
  readonly id: string;
  readonly name: string;
}

export interface BitwardenCollection {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
}

export interface BitwardenItem {
  readonly id: string;
  readonly name: string;
  readonly kind: ForkSecretKind;
  readonly username: string | null;
  readonly collectionIds: ReadonlyArray<string>;
}

export interface BitwardenSecret {
  readonly kind: ForkSecretKind;
  readonly value: Redacted.Redacted<string>;
}

export type BitwardenSession = Redacted.Redacted<string>;

export class BitwardenCli extends Context.Service<
  BitwardenCli,
  {
    readonly dataDirectory: string;
    /** The version `install` provides on this host; null where T3 can't install one. */
    readonly installVersion: string | null;
    readonly resolve: (configuredPath: string | null) => Effect.Effect<BitwardenCliResolution>;
    /** Downloads, verifies, and installs the pinned official `bw`, replacing an older copy. */
    readonly install: Effect.Effect<BitwardenExecutable, ForkSecretsError>;
    readonly status: (
      cli: BitwardenExecutable,
      session: BitwardenSession | null,
    ) => Effect.Effect<BitwardenAccountStatus, ForkSecretsError>;
    readonly configServer: (
      cli: BitwardenExecutable,
      serverUrl: string,
    ) => Effect.Effect<void, ForkSecretsError>;
    readonly unlock: (
      cli: BitwardenExecutable,
      password: Redacted.Redacted<string>,
    ) => Effect.Effect<BitwardenSession, ForkSecretsError>;
    readonly lock: (
      cli: BitwardenExecutable,
      session: BitwardenSession,
    ) => Effect.Effect<void, ForkSecretsError>;
    readonly logout: (cli: BitwardenExecutable) => Effect.Effect<void, ForkSecretsError>;
    readonly sync: (
      cli: BitwardenExecutable,
      session: BitwardenSession,
    ) => Effect.Effect<void, ForkSecretsError>;
    readonly listOrganizations: (
      cli: BitwardenExecutable,
      session: BitwardenSession,
    ) => Effect.Effect<ReadonlyArray<BitwardenOrganization>, ForkSecretsError>;
    readonly listCollections: (
      cli: BitwardenExecutable,
      session: BitwardenSession,
    ) => Effect.Effect<ReadonlyArray<BitwardenCollection>, ForkSecretsError>;
    readonly listItems: (
      cli: BitwardenExecutable,
      session: BitwardenSession,
      collectionIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<BitwardenItem>, ForkSecretsError>;
    readonly getSecret: (
      cli: BitwardenExecutable,
      session: BitwardenSession,
      input: { readonly itemId: string; readonly allowedCollectionIds: ReadonlyArray<string> },
    ) => Effect.Effect<BitwardenSecret, ForkSecretsError>;
    /** Creates a login or secure note in an organization collection and returns its id. */
    readonly createItem: (
      cli: BitwardenExecutable,
      session: BitwardenSession,
      input: {
        readonly kind: "login" | "note";
        readonly name: string;
        readonly username: string | null;
        readonly value: Redacted.Redacted<string>;
        readonly organizationId: string;
        readonly collectionId: string;
      },
    ) => Effect.Effect<string, ForkSecretsError>;
  }
>()("t3/fork/secrets/BitwardenCli") {}

const failure = (reason: ForkSecretsFailureReason) => new ForkSecretsError({ reason });

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Decode errors quote their input, and `bw` output can hold item values, so both are dropped.
const parseJson = (bytes: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => failure("bad_response"),
  }).pipe(
    Effect.flatMap((text) => decodeJson(text)),
    Effect.mapError(() => failure("bad_response")),
  );

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const optionalText = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
    ? value.slice(0, MAX_TEXT_LENGTH)
    : null;

const providerId = (value: unknown): Effect.Effect<string, ForkSecretsError> =>
  typeof value === "string" && ID_PATTERN.test(value)
    ? Effect.succeed(value)
    : Effect.fail(failure("bad_response"));

const providerIds = (value: unknown): Effect.Effect<ReadonlyArray<string>, ForkSecretsError> =>
  value === null || value === undefined
    ? Effect.succeed([])
    : Array.isArray(value)
      ? Effect.forEach(value, providerId).pipe(Effect.map((ids) => [...new Set(ids)].toSorted()))
      : Effect.fail(failure("bad_response"));

const parseArray = (bytes: Uint8Array): Effect.Effect<ReadonlyArray<unknown>, ForkSecretsError> =>
  parseJson(bytes).pipe(Effect.filterOrFail(Array.isArray, () => failure("bad_response")));

const parseRecord = (bytes: Uint8Array): Effect.Effect<Record<string, unknown>, ForkSecretsError> =>
  parseJson(bytes).pipe(
    Effect.flatMap((value) => {
      const record = asRecord(value);
      return record ? Effect.succeed(record) : Effect.fail(failure("bad_response"));
    }),
  );

const itemKind = (type: unknown): ForkSecretKind | undefined =>
  type === 1 ? "login" : type === 2 ? "note" : type === 5 ? "ssh_key" : undefined;

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const installServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
  >();
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const windows = platform === "win32";
  // npm's `bw.cmd` needs a shell to start, so Windows looks for `bw.exe` only.
  const executableName = windows ? "bw.exe" : "bw";
  const dataDirectory = path.join(config.stateDir, "bitwarden-cli");
  const managedPath = path.join(config.stateDir, "fork", "bin", executableName);
  const release =
    (yield* ManagedCliReleaseOverride) ??
    OFFICIAL_RELEASES[`${platform}-${yield* HostProcess.Architecture}`] ??
    null;
  // One `bw` at a time: concurrent runs race on the CLI's data file.
  const serial = yield* Semaphore.make(1);
  const versions = yield* Ref.make(
    new Map<string, { readonly identity: string; readonly version: string }>(),
  );

  const environment = Effect.fn("BitwardenCli.environment")(function* (
    extra: Readonly<Record<string, string>>,
  ) {
    const host = yield* HostProcess.Environment;
    const base: Record<string, string> = {};
    for (const [name, value] of Object.entries(host)) {
      if (value === undefined || name.startsWith("BW_") || name.startsWith("BITWARDENCLI_")) {
        continue;
      }
      base[name] = value;
    }
    return { ...base, BITWARDENCLI_APPDATA_DIR: dataDirectory, ...extra };
  });

  const ensureDataDirectory = fileSystem.makeDirectory(dataDirectory, { recursive: true }).pipe(
    Effect.andThen(fileSystem.chmod(dataDirectory, 0o700)),
    Effect.mapError(() => failure("persist_failed")),
  );

  const spawnCollect = (
    executable: string,
    args: ReadonlyArray<string>,
    env: Record<string, string>,
    timeout: Duration.Duration,
    stdin?: Uint8Array,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(executable, args, {
            env,
            extendEnv: false,
            stdin: stdin === undefined ? "ignore" : Stream.make(stdin),
            forceKillAfter: Duration.seconds(2),
          }),
        );
        const [stdout] = yield* Effect.all(
          [collectBounded(handle.stdout, MAX_OUTPUT_BYTES), Stream.runDrain(handle.stderr)],
          { concurrency: "unbounded" },
        );
        const exitCode = yield* handle.exitCode;
        return { stdout, exitCode };
      }),
    ).pipe(
      Effect.timeoutOption(timeout),
      // Spawn failures and signal exits carry no secret but say nothing actionable either.
      Effect.catchDefect(() => Effect.fail(failure("cli_failed"))),
      Effect.mapError(() => failure("cli_failed")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failure("timeout")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const invoke = Effect.fn("BitwardenCli.invoke")(
    function* (
      cli: BitwardenExecutable,
      args: ReadonlyArray<string>,
      options: {
        readonly onFailure: ForkSecretsFailureReason;
        readonly session?: BitwardenSession | null;
        readonly env?: Readonly<Record<string, string>>;
        readonly stdin?: Uint8Array;
        readonly timeout?: Duration.Duration;
      },
    ) {
      yield* ensureDataDirectory;
      const env = yield* environment({
        ...(options.session ? { BW_SESSION: Redacted.value(options.session) } : {}),
        ...options.env,
      });
      const result = yield* spawnCollect(
        cli.path,
        ["--nointeraction", ...args],
        env,
        options.timeout ?? LOCAL_TIMEOUT,
        options.stdin,
      );
      if (result.stdout.overflow) return yield* failure("bad_response");
      if (result.exitCode !== 0) return yield* failure(options.onFailure);
      return result.stdout.bytes;
    },
    (effect) => serial.withPermits(1)(effect),
  );

  const probeVersion = Effect.fn("BitwardenCli.probeVersion")(
    function* (executable: string) {
      const env = yield* environment({});
      const result = yield* spawnCollect(executable, ["--version"], env, Duration.seconds(15)).pipe(
        Effect.option,
      );
      if (Option.isNone(result) || result.value.exitCode !== 0) return null;
      const version = new TextDecoder().decode(result.value.stdout.bytes).trim();
      return VERSION_PATTERN.test(version) ? version : null;
    },
    (effect) => serial.withPermits(1)(effect),
  );

  const inspect = Effect.fn("BitwardenCli.inspect")(function* (candidate: string) {
    if (!path.isAbsolute(candidate)) return null;
    const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
    // Windows has no execute bit; there only `.exe` files run.
    const runnable = windows
      ? candidate.toLowerCase().endsWith(".exe")
      : Option.isSome(info) && (info.value.mode & 0o111) !== 0;
    if (Option.isNone(info) || info.value.type !== "File" || !runnable) return null;
    const realPath = yield* fileSystem
      .realPath(candidate)
      .pipe(Effect.orElseSucceed(() => candidate));
    const portable = yield* fileSystem
      .exists(path.join(path.dirname(realPath), "bw-data"))
      .pipe(Effect.orElseSucceed(() => false));
    if (portable) return { _tag: "Unusable", path: realPath } satisfies BitwardenCliResolution;
    const identity = `${info.value.size}:${Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0}`;
    const cached = (yield* Ref.get(versions)).get(realPath);
    const version = cached?.identity === identity ? cached.version : yield* probeVersion(realPath);
    if (version === null) return null;
    yield* Ref.update(versions, (current) => new Map(current).set(realPath, { identity, version }));
    return {
      _tag: "Found",
      executable: { path: realPath, version, managed: false },
    } satisfies BitwardenCliResolution;
  });

  const resolve = Effect.fn("BitwardenCli.resolve")(function* (configuredPath: string | null) {
    if (configuredPath !== null) {
      return (yield* inspect(configuredPath)) ?? ({ _tag: "Missing" } as const);
    }
    const managed = yield* inspect(managedPath);
    if (managed?._tag === "Found") {
      return { ...managed, executable: { ...managed.executable, managed: true } };
    }
    const host = yield* HostProcess.Environment;
    // Windows variable names are case-insensitive; `Path` is common there.
    const pathVariable = windows
      ? Object.entries(host).find(([name]) => name.toUpperCase() === "PATH")?.[1]
      : host.PATH;
    const directories = [
      ...(pathVariable ?? "").split(windows ? ";" : ":").filter((entry) => entry.length > 0),
      ...(windows ? [] : SYSTEM_DIRECTORIES),
    ];
    let unusable: BitwardenCliResolution | undefined;
    for (const directory of new Set(directories)) {
      const resolution = yield* inspect(path.join(directory, executableName));
      if (resolution?._tag === "Found") return resolution;
      unusable ??= resolution ?? undefined;
    }
    return unusable ?? ({ _tag: "Missing" } as const);
  });

  const status: BitwardenCli["Service"]["status"] = Effect.fn("BitwardenCli.status")(
    function* (cli, session) {
      const record = yield* parseRecord(
        yield* invoke(cli, ["status"], { onFailure: "cli_failed", session }),
      );
      const state =
        record.status === "unauthenticated" ||
        record.status === "locked" ||
        record.status === "unlocked"
          ? record.status
          : undefined;
      if (state === undefined) return yield* failure("bad_response");
      return {
        state,
        email: optionalText(record.userEmail),
        serverUrl: optionalText(record.serverUrl),
      };
    },
  );

  const unlock: BitwardenCli["Service"]["unlock"] = Effect.fn("BitwardenCli.unlock")(
    function* (cli, password) {
      if (Redacted.value(password).length === 0) return yield* failure("unlock_failed");
      const variable = `T3_BW_PASSWORD_${(yield* crypto.randomUUIDv4().pipe(Effect.orDie))
        .replaceAll("-", "")
        .toUpperCase()}`;
      const output = yield* invoke(cli, ["unlock", "--raw", "--passwordenv", variable], {
        onFailure: "unlock_failed",
        env: { [variable]: Redacted.value(password) },
      });
      const session = new TextDecoder().decode(output).trim();
      if (session.length < 16 || session.length > 4096 || /\s/.test(session)) {
        return yield* failure("bad_response");
      }
      return Redacted.make(session);
    },
  );

  const listItems: BitwardenCli["Service"]["listItems"] = Effect.fn("BitwardenCli.listItems")(
    function* (cli, session, collectionIds) {
      const wanted = new Set(collectionIds);
      const items = new Map<string, BitwardenItem>();
      for (const collectionId of wanted) {
        const entries = yield* parseArray(
          yield* invoke(cli, ["list", "items", "--collectionid", collectionId], {
            onFailure: "locked",
            session,
          }),
        );
        for (const entry of entries) {
          const record = asRecord(entry);
          if (record === undefined) return yield* failure("bad_response");
          const kind = itemKind(record.type);
          if (kind === undefined) continue;
          const id = yield* providerId(record.id);
          const itemCollections = yield* providerIds(record.collectionIds);
          if (!itemCollections.some((candidate) => wanted.has(candidate))) continue;
          items.set(id, {
            id,
            name: optionalText(record.name) ?? "Untitled item",
            kind,
            username: kind === "login" ? optionalText(asRecord(record.login)?.username) : null,
            collectionIds: itemCollections,
          });
        }
      }
      return [...items.values()].toSorted(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
    },
  );

  const getSecret: BitwardenCli["Service"]["getSecret"] = Effect.fn("BitwardenCli.getSecret")(
    function* (cli, session, input) {
      if (!ID_PATTERN.test(input.itemId)) return yield* failure("item_not_found");
      const record = yield* parseRecord(
        yield* invoke(cli, ["get", "item", input.itemId], { onFailure: "locked", session }),
      );
      const collectionIds = yield* providerIds(record.collectionIds);
      if (!collectionIds.some((id) => input.allowedCollectionIds.includes(id))) {
        return yield* failure("item_not_found");
      }
      const kind = itemKind(record.type);
      if (kind === undefined) return yield* failure("item_not_found");
      const raw =
        kind === "login"
          ? asRecord(record.login)?.password
          : kind === "note"
            ? record.notes
            : asRecord(record.sshKey)?.privateKey;
      if (typeof raw !== "string" || raw.length === 0) return yield* failure("item_empty");
      return { kind, value: Redacted.make(raw) };
    },
  );

  const install: BitwardenCli["Service"]["install"] = Effect.gen(function* () {
    if (release === null) return yield* failure("install_unsupported");
    // The release zips hold one regular file, `bw` or `bw.exe`.
    yield* ManagedBinary.installPinnedRelease({
      release,
      target: managedPath,
      extract: ManagedBinary.singleFileZip(executableName),
      probeVersion,
    }).pipe(
      Effect.provide(installServices),
      Effect.mapError(() => failure("install_failed")),
    );
    const installed = yield* inspect(managedPath);
    if (installed?._tag !== "Found") return yield* failure("install_failed");
    return { ...installed.executable, managed: true };
  }).pipe(Effect.withSpan("BitwardenCli.install"));

  return BitwardenCli.of({
    dataDirectory,
    installVersion: release?.version ?? null,
    resolve,
    install,
    status,
    configServer: Effect.fn("BitwardenCli.configServer")(function* (cli, serverUrl) {
      yield* invoke(cli, ["config", "server", serverUrl], { onFailure: "cli_failed" });
    }),
    unlock,
    lock: Effect.fn("BitwardenCli.lock")(function* (cli, session) {
      yield* invoke(cli, ["lock"], { onFailure: "cli_failed", session });
    }),
    logout: Effect.fn("BitwardenCli.logout")(function* (cli) {
      yield* invoke(cli, ["logout"], { onFailure: "cli_failed" });
    }),
    sync: Effect.fn("BitwardenCli.sync")(function* (cli, session) {
      yield* invoke(cli, ["sync"], { onFailure: "cli_failed", session, timeout: NETWORK_TIMEOUT });
    }),
    listOrganizations: Effect.fn("BitwardenCli.listOrganizations")(function* (cli, session) {
      const entries = yield* parseArray(
        yield* invoke(cli, ["list", "organizations"], { onFailure: "locked", session }),
      );
      return yield* Effect.forEach(entries, (entry) => {
        const record = asRecord(entry);
        return record === undefined
          ? Effect.fail(failure("bad_response"))
          : providerId(record.id).pipe(
              Effect.map((id) => ({ id, name: optionalText(record.name) ?? "Organization" })),
            );
      });
    }),
    listCollections: Effect.fn("BitwardenCli.listCollections")(function* (cli, session) {
      const entries = yield* parseArray(
        yield* invoke(cli, ["list", "collections"], { onFailure: "locked", session }),
      );
      const collections = yield* Effect.forEach(entries, (entry) => {
        const record = asRecord(entry);
        return record === undefined
          ? Effect.fail(failure("bad_response"))
          : Effect.all({
              id: providerId(record.id),
              organizationId: providerId(record.organizationId),
              name: Effect.succeed(optionalText(record.name) ?? "Untitled collection"),
            });
      });
      return collections.toSorted(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
    }),
    listItems,
    getSecret,
    createItem: Effect.fn("BitwardenCli.createItem")(function* (cli, session, input) {
      const value = Redacted.value(input.value);
      const item = {
        type: input.kind === "login" ? 1 : 2,
        name: input.name,
        favorite: false,
        organizationId: input.organizationId,
        collectionIds: [input.collectionId],
        ...(input.kind === "login"
          ? { notes: null, login: { username: input.username, password: value, uris: [] } }
          : { notes: value, secureNote: { type: 0 } }),
      };
      // `bw create item` reads the encoded item from stdin, keeping the value out of arguments.
      const encoded = Buffer.from(encodeJson(item), "utf8").toString("base64");
      const record = yield* parseRecord(
        yield* invoke(cli, ["create", "item"], {
          onFailure: "save_failed",
          session,
          stdin: new TextEncoder().encode(encoded),
          timeout: NETWORK_TIMEOUT,
        }),
      );
      return yield* providerId(record.id);
    }),
  });
});

export const layer = Layer.effect(BitwardenCli, make);

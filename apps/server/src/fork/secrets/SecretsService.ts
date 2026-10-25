/**
 * Owns this environment's Bitwarden connection, its secrets catalog, the
 * `secure_bash` commands running with secret values, and `save_secret`.
 *
 * The unlock session lives only in memory. Admission of a command and every
 * change that takes access away (lock, log out, ungrant, collection change)
 * run under the same lock, so a revocation either lands before a command is
 * admitted or stops it after; none can slip between the check and the start.
 */
import {
  ForkSecretsError,
  forkSecretGrantIncludes,
  isValidForkSecretAlias,
  type ForkSecretGrant,
  type ForkSecretItem,
  type ForkSecretKind,
  type ForkSecretsCollection,
  type ForkSecretsConfigureInput,
  type ForkSecretsFailureReason,
  type ForkSecretsSetCollectionsInput,
  type ForkSecretsState,
  type ForkSecretsStatus,
  type ForkSecretsUnlockInput,
  type ForkSecretsUpdateItemInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as BitwardenCli from "./BitwardenCli.ts";
import type { BoundedOutput } from "./boundedOutput.ts";
import * as Nono from "./Nono.ts";
import { makeRedactor, type Redactor } from "./Redactor.ts";
import * as SecureExec from "./SecureExec.ts";
import {
  EMPTY_SECRETS_FILE,
  loadSecretsFile,
  mergeSyncedItems,
  saveSecretsFile,
  uniqueAlias,
  type SecretsFile,
} from "./SecretsState.ts";

const DEFAULT_SERVER_URL = "https://vault.bitwarden.com";
// Written only while "Stay unlocked across restarts" is on.
const PERSISTED_SESSION_NAME = "fork-bitwarden-session";
export const MAX_SECRETS_PER_COMMAND = 16;
// Linux caps one environment string at 128 KiB.
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const RESOLUTION_BUDGET = Duration.seconds(60);
const MAX_CONCURRENT_COMMANDS = 8;
const WATCH_INTERVAL = Duration.seconds(2);
// `bw status` takes about a second, so the signed-in state is reused briefly.
const ACCOUNT_STATUS_TTL_MS = 5_000;
const DISPLAY_HEAD_CHARS = 4_000;
const DISPLAY_TAIL_CHARS = 12_000;

const SecureCommandFailureReason = Schema.Literals([
  "unsupported_host",
  "not_connected",
  "locked",
  "no_secrets",
  "unknown_secret",
  "invalid_name",
  "duplicate_secret",
  "not_granted",
  "too_many_secrets",
  "item_unavailable",
  "value_too_large",
  "value_invalid",
  "resolution_timeout",
  "redaction_budget",
  "cli_failed",
  "start_failed",
  "ssh_agent_failed",
  "ssh_key_rejected",
  "revoked",
  "stopped_locked",
  "run_stopped",
  "invalid_alias",
  "alias_taken",
  "save_not_configured",
  "value_empty",
  "value_multiline",
  "save_failed",
  "save_interrupted",
  "sandbox_unavailable",
  "sandbox_dropped_name",
  "sandbox_path_unsupported",
]);
type SecureCommandFailureReason = typeof SecureCommandFailureReason.Type;

/** Agent-facing: each message says what happened and what to do next. */
export class SecureCommandError extends Schema.TaggedError<SecureCommandError>()(
  "SecureCommandError",
  {
    reason: SecureCommandFailureReason,
    alias: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const alias = this.alias ?? "A secret";
    switch (this.reason) {
      case "unsupported_host":
        return "secure_bash runs only on macOS and Linux hosts.";
      case "not_connected":
        return "Bitwarden isn't connected on this host. Ask the user to connect it in Settings → Secrets.";
      case "locked":
        return "Bitwarden is locked. Ask the user to unlock it in Settings → Secrets, then retry.";
      case "no_secrets":
        return "Pass the secrets this command needs in secrets or secretRefs. Run commands that need none in your normal shell.";
      case "unknown_secret":
        return `No secret is named ${alias}. Call list_secrets for the aliases this project can use.`;
      case "invalid_name":
        return `${alias} can't be a variable name. Name a secretRef with capital letters, digits, and underscores, starting with a letter; shell names like PATH are reserved.`;
      case "duplicate_secret":
        return `${alias} is listed more than once in secrets.`;
      case "not_granted":
        return `${alias} isn't granted to this project. Ask the user to grant it in Settings → Secrets.`;
      case "too_many_secrets":
        return `Pass at most ${MAX_SECRETS_PER_COMMAND} secrets per command.`;
      case "item_unavailable":
        return `${alias} has no value in Bitwarden anymore. Ask the user to sync or fix the item in Settings → Secrets.`;
      case "value_too_large":
        return `${alias} is larger than 64 KiB, too large to pass in the environment.`;
      case "value_invalid":
        return `${alias} contains a NUL byte, so it can't be passed in the environment.`;
      case "resolution_timeout":
        return "Bitwarden took too long to return the secrets. Retry the command.";
      case "redaction_budget":
        return "These secrets are too large to filter from the output safely. Use fewer or smaller secrets.";
      case "cli_failed":
        return "The Bitwarden CLI failed while fetching the secrets. Retry, or ask the user to check Settings → Secrets.";
      case "start_failed":
        return "The command couldn't start on this host.";
      case "ssh_agent_failed":
        return "ssh-agent couldn't start on this host, so the SSH keys weren't loaded.";
      case "ssh_key_rejected":
        return "ssh-add couldn't load an SSH key. Ask the user to check that the Bitwarden item holds an unencrypted OpenSSH private key.";
      case "revoked":
        return "Access to a secret this command used was revoked while it ran, so it was stopped.";
      case "stopped_locked":
        return "Bitwarden was locked or signed out while the command ran, so it was stopped.";
      case "run_stopped":
        return "The thread's run ended, so the command was stopped.";
      case "invalid_alias":
        return `${alias} can't be an alias. Use capital letters, digits, and underscores, starting with a letter; shell names like PATH are reserved.`;
      case "alias_taken":
        return `A secret already uses the alias ${alias}. Pick another alias, or use that secret.`;
      case "save_not_configured":
        return "Agents can't save secrets on this host yet. Ask the user to choose a collection under Settings → Secrets → Where agents save new secrets.";
      case "value_empty":
        return "The value is empty, so nothing was saved.";
      case "value_multiline":
        return `${alias} spans more than one line, which a login password can't hold. Save it with type note.`;
      case "save_failed":
        return "Bitwarden didn't save the secret. Ask the user to check that the account T3 signs in with can edit items in the save collection.";
      case "save_interrupted":
        return "Bitwarden was locked or signed out, or the save collection changed, before the secret was stored, so nothing was saved. Retry once the user has unlocked it.";
      case "sandbox_unavailable":
        return "This host runs secret-backed commands in a sandbox, but nono isn't working here, so the command didn't run. Ask the user to check Settings → Secrets.";
      case "sandbox_dropped_name":
        return `The sandbox removes a variable named ${alias} from every command, so the command didn't run. Give a secretRef another name, or ask the user to rename the alias in Settings → Secrets.`;
      case "sandbox_path_unsupported":
        return "The sandbox can't grant a folder whose path contains a comma, so the command didn't run. Ask the user to rename the folder or turn off the sandbox in Settings → Secrets.";
    }
  }
}

type StopReason = Extract<SecureCommandFailureReason, "revoked" | "stopped_locked">;

export interface SecureCommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Whether any secret value was removed from the output. */
  readonly redacted: boolean;
}

export interface ProjectSecret {
  readonly alias: string;
  readonly kind: ForkSecretKind;
  readonly name: string;
  readonly username: string | null;
}

export interface ProjectSecrets {
  readonly bitwarden: "ready" | "locked" | "not_connected" | "unsupported_host";
  /** Whether secret-backed commands run inside nono's sandbox. */
  readonly sandboxed: boolean;
  readonly secrets: ReadonlyArray<ProjectSecret>;
}

export interface SecureCommandInput<E> {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly aliases: ReadonlyArray<string>;
  readonly command: string;
  readonly timeout: Duration.Duration;
  /** Re-checks the caller's authority under the admission lock, just before the command starts. */
  readonly authorize: Effect.Effect<void, E>;
  /** False once the caller's run has ended. */
  readonly stillLive: Effect.Effect<boolean>;
  /**
   * Values the user entered for this command alone, such as `request_secret`
   * answers. Consumed after admission, right before the command starts.
   */
  readonly oneOff?: {
    readonly names: ReadonlyArray<string>;
    readonly consume: Effect.Effect<ReadonlyArray<string>, E>;
  };
}

export interface SaveSecretInput<E> {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly alias: string;
  /** The Bitwarden item's name. */
  readonly name: string;
  readonly kind: "login" | "note";
  readonly username: string | null;
  /** A `request_secret` answer, or the stdout of a command run like `secure_bash`. */
  readonly source:
    | { readonly _tag: "Ref"; readonly consume: Effect.Effect<string, E> }
    | {
        readonly _tag: "Command";
        readonly command: string;
        readonly aliases: ReadonlyArray<string>;
        readonly timeout: Duration.Duration;
      };
  readonly authorize: Effect.Effect<void, E>;
  readonly stillLive: Effect.Effect<boolean>;
}

export interface SaveSecretResult {
  readonly saved: boolean;
  readonly alias: string | null;
  readonly collection: string | null;
  /** From a command source: how it ended and its redacted stderr. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stderr: string;
}

export class SecretsService extends Context.Service<
  SecretsService,
  {
    readonly getState: Effect.Effect<ForkSecretsState, ForkSecretsError>;
    readonly configure: (
      input: ForkSecretsConfigureInput,
    ) => Effect.Effect<ForkSecretsState, ForkSecretsError>;
    readonly unlock: (
      input: ForkSecretsUnlockInput,
    ) => Effect.Effect<ForkSecretsState, ForkSecretsError>;
    readonly lock: Effect.Effect<ForkSecretsState, ForkSecretsError>;
    readonly logout: Effect.Effect<ForkSecretsState, ForkSecretsError>;
    readonly sync: Effect.Effect<ForkSecretsState, ForkSecretsError>;
    readonly setCollections: (
      input: ForkSecretsSetCollectionsInput,
    ) => Effect.Effect<ForkSecretsState, ForkSecretsError>;
    readonly updateItem: (
      input: ForkSecretsUpdateItemInput,
    ) => Effect.Effect<ForkSecretsState, ForkSecretsError>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ProjectSecrets>;
    readonly runSecureCommand: <E>(
      input: SecureCommandInput<E>,
    ) => Effect.Effect<SecureCommandResult, SecureCommandError | E>;
    readonly installCli: Effect.Effect<ForkSecretsState, ForkSecretsError>;
    /** Installs T3's pinned nono, which the sandbox setting needs. */
    readonly installSandbox: Effect.Effect<ForkSecretsState, ForkSecretsError>;
    /** Creates a Bitwarden item from a value the agent never sees and grants it to the project. */
    readonly saveSecret: <E>(
      input: SaveSecretInput<E>,
    ) => Effect.Effect<SaveSecretResult, SecureCommandError | E>;
  }
>()("t3/fork/secrets/SecretsService") {}

interface Session {
  readonly executable: BitwardenCli.BitwardenExecutable;
  readonly key: BitwardenCli.BitwardenSession;
}

interface AccountCheck extends BitwardenCli.BitwardenAccountStatus {
  readonly checkedAt: number;
}

interface ServiceState {
  readonly file: SecretsFile;
  readonly session: Session | null;
  /** Changes whenever the session does, so values resolved under an older session are refused. */
  readonly epoch: number;
  readonly account: AccountCheck | null;
  readonly availableCollections: ReadonlyArray<ForkSecretsCollection>;
}

interface ResolvedSecrets {
  readonly selected: ReadonlyArray<ForkSecretItem>;
  readonly values: ReadonlyArray<{ readonly item: ForkSecretItem; readonly value: string }>;
  /** The session epoch the values came from; null when no Bitwarden value is used. */
  readonly epoch: number | null;
}

/** A finished command's raw output, with the values it held and their redactor. */
interface CommandRun {
  readonly output: SecureExec.SecureExecOutput;
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly redactor: Redactor;
}

interface ConfigureOutcome {
  /** A session `configure` ended because the executable changed. */
  readonly ended: Session | null;
  readonly session: Session | null;
}

interface Execution {
  readonly projectId: ProjectId;
  readonly itemIds: ReadonlySet<string>;
  /** Holds Bitwarden values, so locking or signing out stops it. */
  readonly usesVault: boolean;
  readonly stop: Deferred.Deferred<StopReason>;
}

const failure = (reason: ForkSecretsFailureReason) => new ForkSecretsError({ reason });
const commandFailure = (reason: SecureCommandFailureReason, alias?: string) =>
  new SecureCommandError({ reason, ...(alias === undefined ? {} : { alias }) });

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const collectionLabel = (collection: ForkSecretsCollection) =>
  collection.organizationName === null
    ? collection.name
    : `${collection.organizationName} / ${collection.name}`;

/** The selected collection agents save to, if saving is on. */
const saveDestination = (file: SecretsFile) =>
  file.collections.find((collection) => collection.id === file.saveCollectionId) ?? null;

const normalizeGrant = (grant: ForkSecretGrant): ForkSecretGrant =>
  grant === "all" ? "all" : [...new Set(grant)].toSorted();

const sameGrant = (left: ForkSecretGrant, right: ForkSecretGrant) =>
  left === "all" || right === "all"
    ? left === right
    : left.length === right.length && left.every((projectId, index) => right[index] === projectId);

const normalizeServerUrl = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return Effect.succeed(null);
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? Effect.succeed(`${url.origin}${url.pathname.replace(/\/+$/, "")}`)
      : Effect.fail(failure("invalid_server_url"));
  } catch {
    return Effect.fail(failure("invalid_server_url"));
  }
};

// Shown instead of a save command's stderr when its stdout, the would-be value, couldn't be read.
const UNCHECKED_STDERR =
  "[stderr withheld: the command's stdout couldn't be read, so stderr can't be checked for the new value]";

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const truncateForDisplay = (text: string) =>
  text.length <= DISPLAY_HEAD_CHARS + DISPLAY_TAIL_CHARS
    ? text
    : `${text.slice(0, DISPLAY_HEAD_CHARS)}\n[… ${text.length - DISPLAY_HEAD_CHARS - DISPLAY_TAIL_CHARS} characters omitted …]\n${text.slice(-DISPLAY_TAIL_CHARS)}`;

const presentStream = (stream: BoundedOutput, redactor: Redactor) => {
  if (stream.overflow) {
    return {
      text: `[output withheld: more than ${SecureExec.SECURE_EXEC_MAX_STREAM_BYTES / (1024 * 1024)} MiB. Rerun with less output, for example piped through \`tail -n 200\`.]`,
      redacted: false,
    };
  }
  const result = redactor.redact(stream.bytes);
  return { text: truncateForDisplay(result.text), redacted: result.redacted };
};

const make = Effect.gen(function* () {
  const cli = yield* BitwardenCli.BitwardenCli;
  const nono = yield* Nono.Nono;
  const secureExec = yield* SecureExec.SecureExec;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const platform = yield* HostProcess.Platform;
  const services = yield* Effect.context<Path.Path | Crypto.Crypto | FileSystem.FileSystem>();
  const filePath = path.join(config.stateDir, "fork", "secrets.json");
  const secureCommandsSupported = platform !== "win32";

  const state = yield* SynchronizedRef.make<ServiceState>({
    file: yield* loadSecretsFile(filePath),
    session: null,
    epoch: 0,
    account: null,
    availableCollections: [],
  });
  const executions = new Map<string, Execution>();
  const commandPermits = yield* Semaphore.make(MAX_CONCURRENT_COMMANDS);
  // Operations that read the vault and then apply what they read run one at a time, so none
  // applies a view another has replaced. Lock and logout stay outside it to revoke at once.
  const vaultPermit = yield* Semaphore.make(1);
  const exclusive = vaultPermit.withPermits(1);

  const save = (file: SecretsFile) =>
    saveSecretsFile(filePath, file).pipe(Effect.provide(services));

  const persistSession = (key: BitwardenCli.BitwardenSession | null) =>
    (key === null
      ? secretStore.remove(PERSISTED_SESSION_NAME)
      : secretStore.set(PERSISTED_SESSION_NAME, new TextEncoder().encode(Redacted.value(key)))
    ).pipe(Effect.mapError(() => failure("persist_failed")));

  /** Runs under the state lock: signals every matching command to stop. */
  const stopExecutions = (reason: StopReason, matches: (execution: Execution) => boolean) =>
    Effect.forEach(
      [...executions.values()].filter(matches),
      (execution) => Deferred.succeed(execution.stop, reason),
      { discard: true },
    );

  const resolveCli = Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(state);
    return yield* cli.resolve(current.file.cliPath);
  });

  const requireCli = Effect.gen(function* () {
    const resolution = yield* resolveCli;
    switch (resolution._tag) {
      case "Found":
        return resolution.executable;
      case "Missing":
        return yield* failure("cli_missing");
      case "Unusable":
        return yield* failure("cli_unusable");
    }
  });

  const requireSession = Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(state);
    if (current.session === null) {
      return yield* failure(
        current.account?.state === "unauthenticated" ? "unauthenticated" : "locked",
      );
    }
    return current.session;
  });

  const loadCollections = Effect.fn("SecretsService.loadCollections")(function* (session: Session) {
    const [organizations, collections] = yield* Effect.all([
      cli.listOrganizations(session.executable, session.key),
      cli.listCollections(session.executable, session.key),
    ]);
    const names = new Map(
      organizations.map((organization) => [organization.id, organization.name]),
    );
    return collections.map((collection): ForkSecretsCollection => ({
      id: collection.id,
      organizationId: collection.organizationId,
      organizationName: names.get(collection.organizationId) ?? null,
      name: collection.name,
    }));
  });

  /**
   * Applies a refreshed view of the vault: collection names, the selection
   * that is still available, and items merged by id. Commands using an item
   * that disappeared are stopped.
   */
  const applyVault = Effect.fn("SecretsService.applyVault")(function* (
    current: ServiceState,
    vault: {
      readonly available: ReadonlyArray<ForkSecretsCollection>;
      readonly selectedIds: ReadonlyArray<string>;
      readonly items: ReadonlyArray<BitwardenCli.BitwardenItem>;
      readonly syncedAt: string | null;
    },
  ) {
    const available = new Map(vault.available.map((collection) => [collection.id, collection]));
    const collections = vault.selectedIds.flatMap((id) => available.get(id) ?? []);
    const selected = new Set(collections.map((collection) => collection.id));
    const items = mergeSyncedItems(
      current.file.items,
      vault.items.filter((item) => item.collectionIds.some((id) => selected.has(id))),
    );
    const remaining = new Set(items.map((item) => item.itemId));
    const file: SecretsFile = {
      ...current.file,
      collections,
      items,
      lastSyncedAt: vault.syncedAt ?? current.file.lastSyncedAt,
      // Saving stays on only while its collection is still synced.
      saveCollectionId: selected.has(current.file.saveCollectionId ?? "")
        ? current.file.saveCollectionId
        : null,
    };
    yield* save(file);
    yield* stopExecutions("revoked", (execution) =>
      [...execution.itemIds].some((itemId) => !remaining.has(itemId)),
    );
    return { ...current, file, availableCollections: vault.available };
  });

  const accountStatus = Effect.fn("SecretsService.accountStatus")(function* (
    executable: BitwardenCli.BitwardenExecutable,
    force: boolean,
  ) {
    const current = yield* SynchronizedRef.get(state);
    const now = yield* Clock.currentTimeMillis;
    if (
      !force &&
      current.account !== null &&
      now - current.account.checkedAt < ACCOUNT_STATUS_TTL_MS
    ) {
      return current.account.state;
    }
    const status = yield* cli.status(executable, null);
    yield* SynchronizedRef.update(state, (latest) => ({
      ...latest,
      account: { ...status, checkedAt: now },
    }));
    return status.state;
  });

  const getState: SecretsService["Service"]["getState"] = Effect.gen(function* () {
    const resolution = yield* resolveCli;
    const current = yield* SynchronizedRef.get(state);
    const executable = resolution._tag === "Found" ? resolution.executable : null;
    let status: ForkSecretsStatus;
    if (resolution._tag === "Missing") status = "cli_missing";
    else if (resolution._tag === "Unusable") status = "cli_unusable";
    else if (current.session !== null) status = "ready";
    else {
      const account = yield* accountStatus(resolution.executable, false);
      status = account === "unauthenticated" ? "unauthenticated" : "locked";
    }
    const sandbox = yield* nono.find;
    const latest = yield* SynchronizedRef.get(state);
    const prefix = `BITWARDENCLI_APPDATA_DIR=${shellQuote(cli.dataDirectory)}`;
    return {
      status,
      cli: {
        path: executable?.path ?? (resolution._tag === "Unusable" ? resolution.path : null),
        version: executable?.version ?? null,
        configuredPath: latest.file.cliPath,
        managed: executable?.managed ?? false,
        installVersion: cli.installVersion,
      },
      // While locked, `bw status` names who is signed in, which may not be who last unlocked.
      account:
        status === "ready" || status === "locked"
          ? latest.account?.email
            ? { email: latest.account.email, serverUrl: latest.account.serverUrl }
            : latest.file.account
          : null,
      serverUrl: latest.file.serverUrl,
      loginCommand:
        executable === null
          ? null
          : `${prefix} ${shellQuote(executable.path)} login && ${prefix} ${shellQuote(executable.path)} lock`,
      availableCollections: latest.session === null ? [] : latest.availableCollections,
      selectedCollections: latest.file.collections,
      items: latest.file.items,
      lastSyncedAt: latest.file.lastSyncedAt,
      keepUnlocked: latest.file.keepUnlocked,
      saveCollectionId: saveDestination(latest.file)?.id ?? null,
      secureCommandsSupported,
      sandbox: {
        enabled: latest.file.sandbox,
        path: sandbox?.path ?? null,
        version: sandbox?.version ?? null,
        managed: sandbox?.managed ?? false,
        installVersion: nono.installVersion,
      },
    } satisfies ForkSecretsState;
  }).pipe(Effect.withSpan("SecretsService.getState"));

  /**
   * Unlocks, refreshes the vault view, and starts a fresh catalog for a different account.
   * `startEpoch` is read when the request arrived, so a lock or logout since then wins.
   */
  const unlockWith = Effect.fn("SecretsService.unlockWith")(function* (
    executable: BitwardenCli.BitwardenExecutable,
    password: string,
    startEpoch: number,
  ) {
    const key = yield* cli.unlock(executable, Redacted.make(password));
    yield* adoptSession({ executable, key }, startEpoch).pipe(
      // Without the key in memory, a vault left unlocked would only be reachable by whoever saw it.
      Effect.onError(() => cli.lock(executable, key).pipe(Effect.ignore)),
    );
    return yield* getState;
  });

  /** Installs a working session, refreshes the vault view, and starts fresh for another account. */
  const adoptSession = Effect.fn("SecretsService.adoptSession")(function* (
    session: Session,
    startEpoch: number,
  ) {
    const { executable, key } = session;
    const status = yield* cli.status(executable, key);
    if (status.state !== "unlocked") return yield* failure("unlock_failed");
    // Offline unlock still works from the CLI's local cache.
    const synced = yield* cli.sync(executable, key).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const available = yield* loadCollections(session);
    const before = yield* SynchronizedRef.get(state);
    const account = { email: status.email, serverUrl: status.serverUrl };
    const sameAccount =
      before.file.account === null ||
      (before.file.account.email === account.email &&
        before.file.account.serverUrl === account.serverUrl);
    const selectedIds = sameAccount
      ? before.file.collections.map((collection) => collection.id)
      : [];
    const items =
      selectedIds.length === 0 ? [] : yield* cli.listItems(executable, key, selectedIds);
    const now = DateTime.formatIso(yield* DateTime.now);
    const keepUnlocked = yield* SynchronizedRef.modifyEffect(state, (current) =>
      Effect.gen(function* () {
        // A lock or logout while this ran wins.
        if (current.epoch !== startEpoch) return yield* failure("locked");
        const base: ServiceState = sameAccount
          ? current
          : {
              ...current,
              file: {
                ...EMPTY_SECRETS_FILE,
                cliPath: current.file.cliPath,
                serverUrl: current.file.serverUrl,
                keepUnlocked: current.file.keepUnlocked,
                sandbox: current.file.sandbox,
              },
            };
        const next = yield* applyVault(
          { ...base, file: { ...base.file, account } },
          { available, selectedIds, items, syncedAt: synced ? now : null },
        );
        return [
          next.file.keepUnlocked,
          {
            ...next,
            session,
            epoch: current.epoch + 1,
            account: { ...status, checkedAt: yield* Clock.currentTimeMillis },
          },
        ] as const;
      }),
    );
    // Failing here only costs restoring the session after a restart.
    yield* persistSession(keepUnlocked ? key : null).pipe(
      Effect.catch(() => Effect.logWarning("Could not update the persisted Bitwarden session")),
    );
  });

  const configure: SecretsService["Service"]["configure"] = Effect.fn("SecretsService.configure")(
    function* (input) {
      const current = yield* SynchronizedRef.get(state);
      const patch: {
        cliPath?: string | null;
        serverUrl?: string | null;
        keepUnlocked?: boolean;
        saveCollectionId?: string | null;
        sandbox?: boolean;
      } = {};
      if (input.cliPath !== undefined) {
        const trimmed = input.cliPath?.trim() ?? "";
        const cliPath = trimmed === "" ? null : trimmed;
        if (cliPath !== null) {
          const resolution = yield* cli.resolve(cliPath);
          if (resolution._tag === "Missing") return yield* failure("invalid_cli_path");
          if (resolution._tag === "Unusable") return yield* failure("cli_unusable");
        }
        if (cliPath !== current.file.cliPath) patch.cliPath = cliPath;
      }
      if (input.serverUrl !== undefined) {
        const serverUrl = yield* normalizeServerUrl(input.serverUrl);
        if (serverUrl !== current.file.serverUrl) {
          const executable = yield* requireCli;
          if ((yield* accountStatus(executable, true)) !== "unauthenticated") {
            return yield* failure("already_authenticated");
          }
          yield* cli.configServer(executable, serverUrl ?? DEFAULT_SERVER_URL);
          patch.serverUrl = serverUrl;
        }
      }
      if (input.keepUnlocked !== undefined) patch.keepUnlocked = input.keepUnlocked;
      if (input.saveCollectionId !== undefined) {
        const id = input.saveCollectionId;
        if (id !== null && !current.file.collections.some((collection) => collection.id === id)) {
          return yield* failure("collection_not_found");
        }
        patch.saveCollectionId = id;
      }
      if (input.sandbox !== undefined) {
        // Commands run inside nono only once one works here; installing it is a separate step.
        if (input.sandbox && (yield* nono.find) === null) {
          return yield* failure("sandbox_unavailable");
        }
        patch.sandbox = input.sandbox;
      }
      const outcome = yield* SynchronizedRef.modifyEffect(
        state,
        (latest): Effect.Effect<readonly [ConfigureOutcome, ServiceState], ForkSecretsError> =>
          Effect.gen(function* () {
            const file: SecretsFile = { ...latest.file, ...patch };
            yield* save(file);
            if (patch.cliPath === undefined || latest.session === null) {
              return [
                { ended: null, session: latest.session },
                { ...latest, file },
              ];
            }
            // A different executable may not honor the old session; start locked.
            yield* stopExecutions("stopped_locked", (execution) => execution.usesVault);
            return [
              { ended: latest.session, session: null },
              { ...latest, file, session: null, epoch: latest.epoch + 1, account: null },
            ];
          }),
      );
      if (outcome.ended !== null) {
        yield* cli.lock(outcome.ended.executable, outcome.ended.key).pipe(Effect.ignore);
      }
      if (patch.keepUnlocked !== undefined || outcome.ended !== null) {
        const keepUnlocked = patch.keepUnlocked ?? current.file.keepUnlocked;
        yield* persistSession(
          keepUnlocked && outcome.session !== null ? outcome.session.key : null,
        );
      }
      return yield* getState;
    },
    exclusive,
  );

  /**
   * For a connect or unlock that waited on other vault work: null when another request already
   * unlocked (a second `bw unlock` would replace its session), and a `locked` failure when a lock
   * or logout arrived after this request did.
   */
  const stillWanted = Effect.fn("SecretsService.stillWanted")(function* (startEpoch: number) {
    const current = yield* SynchronizedRef.get(state);
    if (current.session !== null) return null;
    if (current.epoch !== startEpoch) return yield* failure("locked");
    return current;
  });

  const endSession = Effect.fn("SecretsService.endSession")(function* (
    accountState: "locked" | "unauthenticated",
  ) {
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* SynchronizedRef.modifyEffect(state, (current) =>
      Effect.gen(function* () {
        yield* stopExecutions("stopped_locked", (execution) => execution.usesVault);
        return [
          current.session,
          {
            ...current,
            session: null,
            epoch: current.epoch + 1,
            account:
              accountState === "locked" && current.account !== null
                ? { ...current.account, state: "locked", checkedAt: now }
                : { state: accountState, email: null, serverUrl: null, checkedAt: now },
            availableCollections: [],
          },
        ] as const;
      }),
    );
    // The `bw lock` or `bw logout` that follows makes a key left on disk useless.
    yield* persistSession(null).pipe(
      Effect.catch(() => Effect.logWarning("Could not remove the persisted Bitwarden session")),
    );
    return previous;
  });

  const sync: SecretsService["Service"]["sync"] = Effect.gen(function* () {
    const session = yield* requireSession;
    yield* cli.sync(session.executable, session.key);
    const available = yield* loadCollections(session);
    const before = yield* SynchronizedRef.get(state);
    const selectedIds = before.file.collections.map((collection) => collection.id);
    const items =
      selectedIds.length === 0
        ? []
        : yield* cli.listItems(session.executable, session.key, selectedIds);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* SynchronizedRef.updateEffect(state, (current) =>
      current.session === session
        ? applyVault(current, { available, selectedIds, items, syncedAt: now })
        : Effect.fail(failure("locked")),
    );
    return yield* getState;
  }).pipe(exclusive, Effect.withSpan("SecretsService.sync"));

  const setCollections: SecretsService["Service"]["setCollections"] = Effect.fn(
    "SecretsService.setCollections",
  )(function* (input) {
    const session = yield* requireSession;
    const before = yield* SynchronizedRef.get(state);
    const available =
      before.availableCollections.length > 0
        ? before.availableCollections
        : yield* loadCollections(session);
    const availableIds = new Set(available.map((collection) => collection.id));
    const selectedIds = [...new Set(input.collectionIds)];
    if (selectedIds.some((id) => !availableIds.has(id)))
      return yield* failure("collection_not_found");
    const items =
      selectedIds.length === 0
        ? []
        : yield* cli.listItems(session.executable, session.key, selectedIds);
    yield* SynchronizedRef.updateEffect(state, (current) =>
      current.session === session
        ? applyVault(current, { available, selectedIds, items, syncedAt: null })
        : Effect.fail(failure("locked")),
    );
    return yield* getState;
  }, exclusive);

  const updateItem: SecretsService["Service"]["updateItem"] = Effect.fn(
    "SecretsService.updateItem",
  )(function* (input) {
    yield* SynchronizedRef.updateEffect(state, (current) =>
      Effect.gen(function* () {
        const item = current.file.items.find((candidate) => candidate.itemId === input.itemId);
        if (item === undefined) return yield* failure("item_not_found");
        const alias = input.alias?.trim() ?? item.alias;
        if (!isValidForkSecretAlias(alias)) return yield* failure("invalid_alias");
        if (
          current.file.items.some((other) => other.itemId !== item.itemId && other.alias === alias)
        ) {
          return yield* failure("alias_taken");
        }
        const grant = input.grant === undefined ? item.grant : normalizeGrant(input.grant);
        const updated: ForkSecretItem = { ...item, alias, grant };
        const file: SecretsFile = {
          ...current.file,
          items: current.file.items.map((candidate) =>
            candidate.itemId === item.itemId ? updated : candidate,
          ),
        };
        yield* save(file);
        if (!sameGrant(item.grant, grant)) {
          yield* stopExecutions(
            "revoked",
            (execution) =>
              execution.itemIds.has(item.itemId) &&
              !forkSecretGrantIncludes(grant, execution.projectId),
          );
        }
        return { ...current, file };
      }),
    );
    return yield* getState;
  });

  const listForProject: SecretsService["Service"]["listForProject"] = Effect.fn(
    "SecretsService.listForProject",
  )(function* (projectId) {
    const current = yield* SynchronizedRef.get(state);
    return {
      bitwarden: !secureCommandsSupported
        ? "unsupported_host"
        : current.session !== null
          ? "ready"
          : current.file.account === null || current.account?.state === "unauthenticated"
            ? "not_connected"
            : "locked",
      sandboxed: current.file.sandbox,
      secrets: current.file.items
        .filter((item) => forkSecretGrantIncludes(item.grant, projectId))
        .map((item) => ({
          alias: item.alias,
          kind: item.kind,
          name: item.name,
          username: item.username,
        })),
    } satisfies ProjectSecrets;
  });

  /** A session that `bw` stopped honoring, from outside T3 or after an upgrade. */
  const dropStaleSession = (epoch: number) =>
    SynchronizedRef.update(state, (current) =>
      current.epoch === epoch
        ? {
            ...current,
            session: null,
            epoch: current.epoch + 1,
            account: null,
            availableCollections: [],
          }
        : current,
    );

  /** Count and name checks shared by `secure_bash` and `save_secret` commands. */
  const checkNames = Effect.fn("SecretsService.checkNames")(function* (
    aliases: ReadonlyArray<string>,
    oneOffNames: ReadonlyArray<string>,
  ) {
    if (aliases.length + oneOffNames.length > MAX_SECRETS_PER_COMMAND) {
      return yield* commandFailure("too_many_secrets");
    }
    const seen = new Set<string>();
    for (const name of [...aliases, ...oneOffNames]) {
      if (seen.has(name)) return yield* commandFailure("duplicate_secret", name);
      seen.add(name);
    }
    for (const name of oneOffNames) {
      if (!isValidForkSecretAlias(name)) return yield* commandFailure("invalid_name", name);
    }
  });

  /** Fetches the values behind `aliases`, which must exist and be granted to the project. */
  const resolveAliases = Effect.fn("SecretsService.resolveAliases")(function* (
    projectId: ProjectId,
    aliases: ReadonlyArray<string>,
  ): Effect.fn.Return<ResolvedSecrets, SecureCommandError> {
    // Commands that use no Bitwarden value need no session.
    if (aliases.length === 0) return { selected: [], values: [], epoch: null };
    const snapshot = yield* SynchronizedRef.get(state);
    if (snapshot.session === null) {
      return yield* commandFailure(
        snapshot.file.account === null || snapshot.account?.state === "unauthenticated"
          ? "not_connected"
          : "locked",
      );
    }
    const { session, epoch } = snapshot;
    const byAlias = new Map(snapshot.file.items.map((item) => [item.alias, item]));
    const selected: Array<ForkSecretItem> = [];
    for (const alias of aliases) {
      const item = byAlias.get(alias);
      if (item === undefined) return yield* commandFailure("unknown_secret", alias);
      if (!forkSecretGrantIncludes(item.grant, projectId)) {
        return yield* commandFailure("not_granted", alias);
      }
      selected.push(item);
    }
    const allowedCollectionIds = snapshot.file.collections.map((collection) => collection.id);

    const values = yield* Effect.forEach(selected, (item) =>
      cli
        .getSecret(session.executable, session.key, {
          itemId: item.itemId,
          allowedCollectionIds,
        })
        .pipe(
          Effect.map((secret) => ({ item, value: Redacted.value(secret.value) })),
          Effect.catchTags({
            ForkSecretsError: (error) =>
              error.reason === "locked"
                ? dropStaleSession(epoch).pipe(
                    Effect.andThen(Effect.fail(commandFailure("locked"))),
                  )
                : Effect.fail(
                    error.reason === "item_not_found" || error.reason === "item_empty"
                      ? commandFailure("item_unavailable", item.alias)
                      : error.reason === "timeout"
                        ? commandFailure("resolution_timeout")
                        : commandFailure("cli_failed"),
                  ),
          }),
        ),
    ).pipe(
      Effect.timeoutOption(RESOLUTION_BUDGET),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(commandFailure("resolution_timeout")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const checked = yield* validateValues(
      values.map(({ item, value }) => ({ name: item.alias, value })),
    );
    // A command that can't be redacted is refused before anything waits on admission.
    if (makeRedactor(checked.map(({ name, value }) => ({ label: name, value }))) === null) {
      return yield* commandFailure("redaction_budget");
    }
    return { selected, values, epoch };
  });

  const runSecureCommand = Effect.fn("SecretsService.runSecureCommand")(function* <E>(
    input: SecureCommandInput<E>,
  ): Effect.fn.Return<SecureCommandResult, SecureCommandError | E> {
    if (!secureCommandsSupported) return yield* commandFailure("unsupported_host");
    const oneOffNames = input.oneOff?.names ?? [];
    if (input.aliases.length + oneOffNames.length === 0) return yield* commandFailure("no_secrets");
    yield* checkNames(input.aliases, oneOffNames);
    const resolved = yield* resolveAliases(input.projectId, input.aliases);
    const { output, redactor } = yield* admitAndRun(input, resolved);
    const stdout = presentStream(output.stdout, redactor);
    const stderr = presentStream(output.stderr, redactor);
    return {
      exitCode: output.exitCode,
      timedOut: output.timedOut,
      stdout: stdout.text,
      stderr: stderr.text,
      redacted: stdout.redacted || stderr.redacted,
    } satisfies SecureCommandResult;
  });

  const validateValues = Effect.fn("SecretsService.validateValues")(function* (
    values: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  ) {
    for (const { name, value } of values) {
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
        return yield* commandFailure("value_too_large", name);
      }
      if (value.includes("\0")) return yield* commandFailure("value_invalid", name);
    }
    return values;
  });

  /**
   * Admits the command under the state lock, then runs it raced against
   * revocation and the end of the caller's run.
   */
  const admitAndRun = Effect.fn("SecretsService.admitAndRun")(function* <E>(
    input: SecureCommandInput<E>,
    resolved: ResolvedSecrets,
  ): Effect.fn.Return<CommandRun, SecureCommandError | E> {
    return yield* commandPermits.withPermits(1)(
      Effect.gen(function* () {
        const executionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const stop = yield* Deferred.make<StopReason>();
        yield* SynchronizedRef.updateEffect(state, (current) =>
          Effect.gen(function* () {
            if (
              resolved.epoch !== null &&
              (current.session === null || current.epoch !== resolved.epoch)
            ) {
              return yield* commandFailure("locked");
            }
            for (const item of resolved.selected) {
              const latest = current.file.items.find(
                (candidate) => candidate.itemId === item.itemId,
              );
              if (latest === undefined || !forkSecretGrantIncludes(latest.grant, input.projectId)) {
                return yield* commandFailure("not_granted", item.alias);
              }
            }
            yield* input.authorize;
            executions.set(executionId, {
              projectId: input.projectId,
              itemIds: new Set(resolved.selected.map((item) => item.itemId)),
              usesVault: resolved.epoch !== null,
              stop,
            });
            return current;
          }),
        );
        const execution = Effect.gen(function* () {
          // Read at the start, so turning the sandbox on covers commands already waiting, and
          // before one-use values are spent: with the sandbox on, nothing runs without nono.
          const sandboxed = (yield* SynchronizedRef.get(state)).file.sandbox;
          const sandbox = sandboxed ? yield* nono.find : null;
          if (sandboxed && sandbox === null) return yield* commandFailure("sandbox_unavailable");
          // nono would drop these silently, leaving the command without its credential.
          const dropped =
            sandbox === null
              ? undefined
              : [
                  ...resolved.selected.map((item) => item.alias),
                  ...(input.oneOff?.names ?? []),
                ].find(Nono.nonoDropsVariable);
          if (dropped !== undefined) return yield* commandFailure("sandbox_dropped_name", dropped);
          const oneOffValues = input.oneOff === undefined ? [] : yield* input.oneOff.consume;
          const secrets = yield* validateValues([
            ...resolved.values.map(({ item, value }) => ({ name: item.alias, value })),
            ...(input.oneOff?.names ?? []).map((name, index) => ({
              name,
              value: oneOffValues[index] ?? "",
            })),
          ]);
          const redactor = makeRedactor(secrets.map(({ name, value }) => ({ label: name, value })));
          if (redactor === null) return yield* commandFailure("redaction_budget");
          const output = yield* secureExec
            .run({
              command: input.command,
              cwd: input.cwd,
              deliveries: Object.fromEntries(secrets.map(({ name, value }) => [name, value])),
              sshKeys: resolved.values
                .filter(({ item }) => item.kind === "ssh_key")
                .map(({ value }) => value),
              timeout: input.timeout,
              nono: sandbox?.path ?? null,
            })
            .pipe(
              Effect.mapError((error) =>
                commandFailure(
                  error.stage === "ssh_key"
                    ? "ssh_key_rejected"
                    : error.stage === "ssh_agent"
                      ? "ssh_agent_failed"
                      : error.stage === "sandbox_path"
                        ? "sandbox_path_unsupported"
                        : "start_failed",
                ),
              ),
            );
          return { output, secrets, redactor } satisfies CommandRun;
        });
        const stopped = Deferred.await(stop).pipe(
          Effect.flatMap((reason) => Effect.fail(commandFailure(reason))),
        );
        const runEnded = input.stillLive.pipe(
          Effect.repeat({ until: (live) => !live, schedule: Schedule.spaced(WATCH_INTERVAL) }),
          Effect.andThen(Effect.fail(commandFailure("run_stopped"))),
        );
        return yield* Effect.raceFirst(Effect.raceFirst(execution, stopped), runEnded).pipe(
          Effect.ensuring(Effect.sync(() => executions.delete(executionId))),
        );
      }),
    );
  });

  /** A save's value: one line for a login, within the environment limits. */
  const checkSavedValue = Effect.fn("SecretsService.checkSavedValue")(function* (
    alias: string,
    kind: "login" | "note",
    value: string,
  ) {
    if (value.length === 0) return yield* commandFailure("value_empty", alias);
    yield* validateValues([{ name: alias, value }]);
    if (kind === "login" && /[\r\n]/.test(value)) {
      return yield* commandFailure("value_multiline", alias);
    }
  });

  const saveSecret = Effect.fn("SecretsService.saveSecret")(function* <E>(
    input: SaveSecretInput<E>,
  ): Effect.fn.Return<SaveSecretResult, SecureCommandError | E> {
    if (!secureCommandsSupported) return yield* commandFailure("unsupported_host");
    if (!isValidForkSecretAlias(input.alias)) {
      return yield* commandFailure("invalid_alias", input.alias);
    }
    const snapshot = yield* SynchronizedRef.get(state);
    if (snapshot.session === null) {
      return yield* commandFailure(
        snapshot.file.account === null || snapshot.account?.state === "unauthenticated"
          ? "not_connected"
          : "locked",
      );
    }
    // The save belongs to this session and collection; a lock, logout, or new choice ends it.
    const { epoch } = snapshot;
    const destinationId = saveDestination(snapshot.file)?.id ?? null;
    if (destinationId === null) return yield* commandFailure("save_not_configured");
    if (snapshot.file.items.some((item) => item.alias === input.alias)) {
      return yield* commandFailure("alias_taken", input.alias);
    }

    let generated: {
      readonly value: string;
      readonly exitCode: number;
      readonly stderr: string;
    } | null = null;
    if (input.source._tag === "Command") {
      const { command, aliases, timeout } = input.source;
      yield* checkNames(aliases, []);
      const resolved = yield* resolveAliases(input.projectId, aliases);
      if (resolved.epoch !== null && resolved.epoch !== epoch) {
        return yield* commandFailure("save_interrupted");
      }
      // Admitted under the save's session even without input secrets, so locking stops it too.
      const run = yield* admitAndRun(
        {
          projectId: input.projectId,
          cwd: input.cwd,
          aliases,
          command,
          timeout,
          authorize: input.authorize,
          stillLive: input.stillLive,
        },
        { ...resolved, epoch },
      );
      const stdout = run.output.stdout.overflow ? null : decodeUtf8(run.output.stdout.bytes);
      // The command's trailing newline isn't part of the value.
      const value = stdout?.replace(/\r?\n$/, "") ?? null;
      // Stderr is filtered for whatever stdout held, succeeded or not: a command can mint a
      // credential and fail afterwards.
      const redactor =
        value === null
          ? null
          : makeRedactor([
              ...run.secrets.map((secret) => ({ label: secret.name, value: secret.value })),
              ...(value === "" ? [] : [{ label: input.alias, value }]),
            ]);
      const stderr =
        redactor === null ? UNCHECKED_STDERR : presentStream(run.output.stderr, redactor).text;
      if (run.output.timedOut || run.output.exitCode !== 0) {
        return {
          saved: false,
          alias: null,
          collection: null,
          exitCode: run.output.exitCode,
          timedOut: run.output.timedOut,
          stderr,
        };
      }
      if (value === null) return yield* commandFailure("value_invalid", input.alias);
      yield* checkSavedValue(input.alias, input.kind, value);
      generated = { value, exitCode: 0, stderr };
    }

    const name = input.name.trim() === "" ? input.alias : input.name.trim();
    const username = input.kind === "login" ? input.username : null;
    const saved = yield* exclusive(
      Effect.gen(function* () {
        // Rechecked after waiting on other vault work, before anything is consumed or created.
        // `authorize` accepts any live run of the thread; the save belongs to the run that asked.
        yield* input.authorize;
        if (!(yield* input.stillLive)) return yield* commandFailure("run_stopped");
        const current = yield* SynchronizedRef.get(state);
        const destination = saveDestination(current.file);
        if (
          current.session === null ||
          current.epoch !== epoch ||
          destination?.id !== destinationId
        ) {
          return yield* commandFailure("save_interrupted");
        }
        let value: string;
        if (generated !== null) {
          value = generated.value;
        } else if (input.source._tag === "Ref") {
          value = yield* input.source.consume;
          yield* checkSavedValue(input.alias, input.kind, value);
        } else {
          return yield* commandFailure("value_invalid", input.alias);
        }
        const itemId = yield* cli
          .createItem(current.session.executable, current.session.key, {
            kind: input.kind,
            name,
            username,
            value: Redacted.make(value),
            organizationId: destination.organizationId,
            collectionId: destination.id,
          })
          .pipe(
            Effect.mapError((error) =>
              commandFailure(error.reason === "locked" ? "locked" : "save_failed"),
            ),
          );
        return yield* SynchronizedRef.modifyEffect(state, (latest) =>
          Effect.gen(function* () {
            // The item exists now, so a race for the alias gets a suffix instead of a failure.
            const taken = new Set(latest.file.items.map((item) => item.alias));
            const alias = taken.has(input.alias) ? uniqueAlias(input.alias, taken) : input.alias;
            const item: ForkSecretItem = {
              itemId,
              name,
              kind: input.kind,
              username,
              collectionIds: [destination.id],
              alias,
              grant: [input.projectId],
            };
            const file: SecretsFile = {
              ...latest.file,
              items: [
                ...latest.file.items.filter((other) => other.itemId !== itemId),
                item,
              ].toSorted(
                (left, right) =>
                  left.name.localeCompare(right.name) || left.itemId.localeCompare(right.itemId),
              ),
            };
            // The next successful save writes it; failing here would hide a secret that exists.
            yield* save(file).pipe(
              Effect.catch(() => Effect.logWarning("Could not record a saved secret on disk")),
            );
            return [
              { alias, collection: collectionLabel(destination) },
              { ...latest, file },
            ] as const;
          }),
        );
      }),
    );
    return {
      saved: true,
      alias: saved.alias,
      collection: saved.collection,
      exitCode: generated?.exitCode ?? null,
      timedOut: false,
      stderr: generated?.stderr ?? "",
    };
  });

  const installCli: SecretsService["Service"]["installCli"] = Effect.gen(function* () {
    const installed = yield* cli.install;
    const ended = yield* SynchronizedRef.modifyEffect(state, (current) =>
      Effect.gen(function* () {
        // A configured path would still win over the copy just installed.
        const file: SecretsFile =
          current.file.cliPath === null ? current.file : { ...current.file, cliPath: null };
        if (file !== current.file) yield* save(file);
        if (current.session === null || current.session.executable.path === installed.path) {
          return [null, { ...current, file }] as const;
        }
        // As when the path changes: another executable may not honor the session; start locked.
        yield* stopExecutions("stopped_locked", (execution) => execution.usesVault);
        return [
          current.session,
          { ...current, file, session: null, epoch: current.epoch + 1, account: null },
        ] as const;
      }),
    );
    if (ended !== null) {
      yield* cli.lock(ended.executable, ended.key).pipe(Effect.ignore);
      yield* persistSession(null).pipe(
        Effect.catch(() => Effect.logWarning("Could not remove the persisted Bitwarden session")),
      );
    }
    return yield* getState;
  }).pipe(exclusive, Effect.withSpan("SecretsService.installCli"));

  // Outside the vault lock: nono touches no Bitwarden state, and commands find it when they start.
  const installSandbox: SecretsService["Service"]["installSandbox"] = nono.install.pipe(
    Effect.andThen(getState),
    Effect.withSpan("SecretsService.installSandbox"),
  );

  // Restores a session kept across restarts. Runs in the background: it waits on `bw`.
  const restoreSession = Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(state);
    if (!current.file.keepUnlocked) return yield* persistSession(null);
    const stored = yield* secretStore.get(PERSISTED_SESSION_NAME);
    if (Option.isNone(stored)) return;
    const resolution = yield* cli.resolve(current.file.cliPath);
    if (resolution._tag !== "Found") return;
    const key = Redacted.make(new TextDecoder().decode(stored.value));
    const status = yield* cli.status(resolution.executable, key);
    if (status.state !== "unlocked") return yield* persistSession(null);
    yield* adoptSession({ executable: resolution.executable, key }, current.epoch).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          // Locked or logged out meanwhile, so the restored session must stop working too.
          if ((yield* SynchronizedRef.get(state)).epoch === current.epoch) return;
          yield* cli.lock(resolution.executable, key).pipe(Effect.ignore);
        }),
      ),
    );
  }).pipe(
    exclusive,
    Effect.catch(() => Effect.logWarning("Could not restore the kept Bitwarden session")),
    Effect.withSpan("SecretsService.restoreSession"),
  );
  yield* restoreSession.pipe(Effect.forkScoped);

  // A clean shutdown locks the vault so a leaked session key stops working.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(state);
      if (current.session === null || current.file.keepUnlocked) return;
      yield* cli
        .lock(current.session.executable, current.session.key)
        .pipe(Effect.timeout(Duration.seconds(5)), Effect.ignore);
    }),
  );

  return SecretsService.of({
    getState,
    configure,
    unlock: Effect.fn("SecretsService.unlock")(function* (input) {
      const { epoch } = yield* SynchronizedRef.get(state);
      return yield* exclusive(
        Effect.gen(function* () {
          if ((yield* stillWanted(epoch)) === null) return yield* getState;
          const executable = yield* requireCli;
          if ((yield* accountStatus(executable, true)) === "unauthenticated") {
            return yield* failure("unauthenticated");
          }
          return yield* unlockWith(executable, input.password, epoch);
        }),
      );
    }),
    lock: Effect.gen(function* () {
      const previous = yield* endSession("locked");
      if (previous !== null) {
        yield* cli.lock(previous.executable, previous.key).pipe(Effect.ignore);
      }
      return yield* getState;
    }).pipe(Effect.withSpan("SecretsService.lock")),
    logout: Effect.gen(function* () {
      yield* endSession("unauthenticated");
      const executable = yield* requireCli;
      yield* cli.logout(executable).pipe(
        // `bw logout` fails when nobody is signed in, which is the goal anyway.
        Effect.catchTags({
          ForkSecretsError: (error) =>
            cli
              .status(executable, null)
              .pipe(
                Effect.flatMap((status) =>
                  status.state === "unauthenticated" ? Effect.void : Effect.fail(error),
                ),
              ),
        }),
      );
      return yield* getState;
    }).pipe(Effect.withSpan("SecretsService.logout")),
    sync,
    setCollections,
    updateItem,
    listForProject,
    runSecureCommand,
    installCli,
    installSandbox,
    saveSecret,
  });
});

export const layer = Layer.effect(SecretsService, make);

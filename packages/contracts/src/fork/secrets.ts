import * as Schema from "effect/Schema";

import { ProjectId } from "../baseSchemas.ts";

/**
 * Bitwarden-backed secrets for agents. Item values never cross this contract:
 * snapshots carry metadata only, and the only value clients send is the
 * master password that unlocks the vault.
 */

export const ForkSecretsStatus = Schema.Literals([
  "cli_missing",
  "cli_unusable",
  "unauthenticated",
  "locked",
  "ready",
]);
export type ForkSecretsStatus = typeof ForkSecretsStatus.Type;

export const ForkSecretKind = Schema.Literals(["login", "note", "ssh_key"]);
export type ForkSecretKind = typeof ForkSecretKind.Type;

/** Projects whose agents may use a secret: none, a list, or every project. */
export const ForkSecretGrant = Schema.Union([Schema.Literal("all"), Schema.Array(ProjectId)]);
export type ForkSecretGrant = typeof ForkSecretGrant.Type;

export const ForkSecretItem = Schema.Struct({
  itemId: Schema.String,
  name: Schema.String,
  kind: ForkSecretKind,
  username: Schema.NullOr(Schema.String),
  collectionIds: Schema.Array(Schema.String),
  alias: Schema.String,
  grant: ForkSecretGrant,
});
export type ForkSecretItem = typeof ForkSecretItem.Type;

export const ForkSecretsCollection = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  organizationName: Schema.NullOr(Schema.String),
  name: Schema.String,
});
export type ForkSecretsCollection = typeof ForkSecretsCollection.Type;

export const ForkSecretsCli = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  configuredPath: Schema.NullOr(Schema.String),
  /** Whether `path` is the copy T3 installed. */
  managed: Schema.Boolean,
  /** The version T3 installs on this host's platform; null where it can't install one. */
  installVersion: Schema.NullOr(Schema.String),
});
export type ForkSecretsCli = typeof ForkSecretsCli.Type;

/** Windows hosts run every secret-backed command in a Linux container through Docker Desktop. */
export const ForkSecretsDocker = Schema.Struct({
  status: Schema.Literals(["docker_missing", "engine_unavailable", "runner_missing", "ready"]),
  serverVersion: Schema.NullOr(Schema.String),
});
export type ForkSecretsDocker = typeof ForkSecretsDocker.Type;

export const ForkSecretsSandbox = Schema.Struct({
  /** Secret-backed commands run inside nono, and none run without it while this is on. */
  enabled: Schema.Boolean,
  /** The nono T3 would use: its own copy, else one found on this host; null when none works. */
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  /** Whether `path` is the copy T3 installed. */
  managed: Schema.Boolean,
  /** The version T3 installs on this host's platform; null where it can't install one. */
  installVersion: Schema.NullOr(Schema.String),
  /** Present on hosts that sandbox with Docker instead of nono; the fields above are then unused. */
  docker: Schema.optionalKey(Schema.NullOr(ForkSecretsDocker)),
});
export type ForkSecretsSandbox = typeof ForkSecretsSandbox.Type;

export const ForkSecretsAccount = Schema.Struct({
  email: Schema.NullOr(Schema.String),
  serverUrl: Schema.NullOr(Schema.String),
});
export type ForkSecretsAccount = typeof ForkSecretsAccount.Type;

export const ForkSecretsState = Schema.Struct({
  status: ForkSecretsStatus,
  cli: ForkSecretsCli,
  account: Schema.NullOr(ForkSecretsAccount),
  /** The server `bw` signs in to; null means Bitwarden's US cloud. */
  serverUrl: Schema.NullOr(Schema.String),
  /** Signs T3's own `bw` in when run once in a terminal on the host; null without a CLI. */
  loginCommand: Schema.NullOr(Schema.String),
  /** Collections this account can see; filled only while unlocked. */
  availableCollections: Schema.Array(ForkSecretsCollection),
  selectedCollections: Schema.Array(ForkSecretsCollection),
  items: Schema.Array(ForkSecretItem),
  lastSyncedAt: Schema.NullOr(Schema.String),
  keepUnlocked: Schema.Boolean,
  /** Where `save_secret` creates items; null when agents can't save secrets. */
  saveCollectionId: Schema.NullOr(Schema.String),
  /** False on hosts from builds that couldn't run `secure_bash` on Windows. */
  secureCommandsSupported: Schema.Boolean,
  sandbox: ForkSecretsSandbox,
});
export type ForkSecretsState = typeof ForkSecretsState.Type;

export const ForkSecretsConfigureInput = Schema.Struct({
  cliPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  serverUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  keepUnlocked: Schema.optionalKey(Schema.Boolean),
  saveCollectionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Turning it on needs a working nono; see `forkSecrets.installSandbox`. */
  sandbox: Schema.optionalKey(Schema.Boolean),
});
export type ForkSecretsConfigureInput = typeof ForkSecretsConfigureInput.Type;

// A plain string: a refinement that fails would echo the value in its decode error.
export const ForkSecretsUnlockInput = Schema.Struct({
  password: Schema.String,
});
export type ForkSecretsUnlockInput = typeof ForkSecretsUnlockInput.Type;

export const ForkSecretsSetCollectionsInput = Schema.Struct({
  collectionIds: Schema.Array(Schema.String),
});
export type ForkSecretsSetCollectionsInput = typeof ForkSecretsSetCollectionsInput.Type;

export const ForkSecretsUpdateItemInput = Schema.Struct({
  itemId: Schema.String,
  alias: Schema.optionalKey(Schema.String),
  grant: Schema.optionalKey(ForkSecretGrant),
});
export type ForkSecretsUpdateItemInput = typeof ForkSecretsUpdateItemInput.Type;

const FORK_SECRETS_FAILURE_MESSAGES = {
  cli_missing: "The Bitwarden CLI (bw) isn't installed on this host.",
  cli_unusable:
    "This Bitwarden CLI keeps its data in a bw-data folder beside the executable, so T3 can't keep a separate login. Install bw another way or choose a different executable.",
  cli_failed: "The Bitwarden CLI failed. Check that bw runs on this host.",
  install_failed:
    "T3 couldn't install the Bitwarden CLI. Check that this host can reach github.com, then try again.",
  install_unsupported:
    "T3 can't install the Bitwarden CLI on this platform. Install bw yourself, then check again.",
  invalid_cli_path: "Enter the full path to the bw executable.",
  timeout: "The Bitwarden CLI took too long to respond.",
  bad_response: "The Bitwarden CLI returned output T3 couldn't read.",
  unauthenticated: "Bitwarden isn't signed in on this host.",
  already_authenticated: "Log out of Bitwarden before changing the server.",
  locked: "Bitwarden is locked. Unlock it in Settings → Secrets.",
  unlock_failed: "Bitwarden didn't unlock. Check the master password.",
  invalid_server_url: "Enter a server URL that starts with https://.",
  invalid_alias:
    "Use capital letters, digits, and underscores, starting with a letter. Reserved shell names aren't allowed.",
  alias_taken: "Another secret already uses that alias.",
  item_not_found: "That secret is no longer in the synced collections.",
  item_empty: "That Bitwarden item has no password, note, or private key to use.",
  collection_not_found: "That collection isn't available to this Bitwarden account.",
  save_failed:
    "Bitwarden didn't save the item. Check that the account can edit items in that collection.",
  sandbox_unavailable:
    "nono can't sandbox commands on this host. Install it from this page, or check that it runs here.",
  sandbox_install_failed:
    "T3 couldn't install nono. Check that this host can reach github.com, then try again.",
  sandbox_install_unsupported:
    "T3 can't install nono on this platform. Install nono yourself, then try again.",
  docker_unavailable: "Docker Desktop isn't running on this host. Start it, then check again.",
  runner_install_failed:
    "T3 couldn't build its secure runner. Check that Docker Desktop is running and can reach Docker Hub, then try again.",
  persist_failed: "T3 couldn't save the secrets settings on this host.",
} as const;

export const ForkSecretsFailureReason = Schema.Literals(
  Object.keys(FORK_SECRETS_FAILURE_MESSAGES) as Array<keyof typeof FORK_SECRETS_FAILURE_MESSAGES>,
);
export type ForkSecretsFailureReason = typeof ForkSecretsFailureReason.Type;

/** No cause: CLI failures can carry item contents, so only the reason crosses the wire. */
export class ForkSecretsError extends Schema.TaggedError<ForkSecretsError>()("ForkSecretsError", {
  reason: ForkSecretsFailureReason,
}) {
  override get message(): string {
    return FORK_SECRETS_FAILURE_MESSAGES[this.reason];
  }
}

export const FORK_SECRET_ALIAS_MAX_LENGTH = 64;
const ALIAS_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// Names the shell, the runner, or `secure_bash` itself already gives meaning to.
const RESERVED_ALIASES: ReadonlySet<string> = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "DISPLAY",
  "ENV",
  "HOME",
  "IFS",
  "LANG",
  "LOGNAME",
  "NODE_OPTIONS",
  "OLDPWD",
  "PATH",
  "PROMPT_COMMAND",
  "PS4",
  "PWD",
  "SHELL",
  "SHELLOPTS",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "SSH_AUTH_SOCK",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);
// `NONO_` variables configure the sandbox and `XDG_` ones move its config and state, so a secret
// named like either could widen it.
const RESERVED_ALIAS_PREFIXES = [
  "BASH_FUNC_",
  "BITWARDENCLI_",
  "BW_",
  "DYLD_",
  "LD_",
  "NONO_",
  "T3_",
  "XDG_",
];

export const isValidForkSecretAlias = (alias: string): boolean =>
  alias.length <= FORK_SECRET_ALIAS_MAX_LENGTH &&
  ALIAS_PATTERN.test(alias) &&
  !RESERVED_ALIASES.has(alias) &&
  !RESERVED_ALIAS_PREFIXES.some((prefix) => alias.startsWith(prefix));

/** `Prod DB (read-only)` becomes `PROD_DB_READ_ONLY`; the result may still be reserved. */
export const forkSecretAliasFromName = (name: string): string => {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const alias = /^[A-Z]/.test(words) ? words : `SECRET_${words}`.replace(/_+$/, "");
  return alias.slice(0, FORK_SECRET_ALIAS_MAX_LENGTH).replace(/_+$/, "");
};

export const forkSecretGrantIncludes = (grant: ForkSecretGrant, projectId: ProjectId): boolean =>
  grant === "all" || grant.includes(projectId);

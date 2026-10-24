/**
 * The fork's secrets catalog, persisted as JSON beside the server state
 * instead of in the database, so upstream migrations stay untouched. It holds
 * metadata only: item names, usernames, aliases, and grants.
 */
import {
  ForkSecretItem,
  ForkSecretsAccount,
  ForkSecretsCollection,
  ForkSecretsError,
  forkSecretAliasFromName,
  isValidForkSecretAlias,
  FORK_SECRET_ALIAS_MAX_LENGTH,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { BitwardenItem } from "./BitwardenCli.ts";

export const SecretsFile = Schema.Struct({
  version: Schema.Literal(1),
  cliPath: Schema.NullOr(Schema.String),
  serverUrl: Schema.NullOr(Schema.String),
  keepUnlocked: Schema.Boolean,
  /** The account the catalog belongs to; another account starts a fresh catalog. */
  account: Schema.NullOr(ForkSecretsAccount),
  collections: Schema.Array(ForkSecretsCollection),
  items: Schema.Array(ForkSecretItem),
  lastSyncedAt: Schema.NullOr(Schema.String),
  /** Where agents' `save_secret` creates items; null turns saving off. */
  saveCollectionId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** Whether secret-backed commands run inside nono. A host setting, kept across accounts. */
  sandbox: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type SecretsFile = typeof SecretsFile.Type;

export const EMPTY_SECRETS_FILE: SecretsFile = {
  version: 1,
  cliPath: null,
  serverUrl: null,
  keepUnlocked: false,
  account: null,
  collections: [],
  items: [],
  lastSyncedAt: null,
  saveCollectionId: null,
  sandbox: false,
};

const SecretsFileJson = Schema.fromJsonString(SecretsFile);
const decodeSecretsFile = Schema.decodeUnknownOption(SecretsFileJson);
const encodeSecretsFile = Schema.encodeSync(SecretsFileJson);

const withSuffix = (base: string, suffix: number) => {
  const tail = `_${suffix}`;
  return `${base.slice(0, FORK_SECRET_ALIAS_MAX_LENGTH - tail.length).replace(/_+$/, "")}${tail}`;
};

/** A valid alias for `name` that no other secret uses. */
export const uniqueAlias = (name: string, taken: ReadonlySet<string>): string => {
  const derived = forkSecretAliasFromName(name);
  const base = isValidForkSecretAlias(derived)
    ? derived
    : isValidForkSecretAlias(`SECRET_${derived}`.slice(0, FORK_SECRET_ALIAS_MAX_LENGTH))
      ? `SECRET_${derived}`.slice(0, FORK_SECRET_ALIAS_MAX_LENGTH).replace(/_+$/, "")
      : "SECRET";
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = withSuffix(base, suffix);
    if (!taken.has(candidate)) return candidate;
  }
};

/**
 * Items keep their alias and grant by Bitwarden id. New items start with no
 * grant, so syncing never gives an agent anything on its own.
 */
export const mergeSyncedItems = (
  current: ReadonlyArray<ForkSecretItem>,
  synced: ReadonlyArray<BitwardenItem>,
): ReadonlyArray<ForkSecretItem> => {
  const existing = new Map(current.map((item) => [item.itemId, item]));
  const taken = new Set(synced.flatMap((item) => existing.get(item.id)?.alias ?? []));
  return synced
    .map((item): ForkSecretItem => {
      const previous = existing.get(item.id);
      const alias = previous?.alias ?? uniqueAlias(item.name, taken);
      taken.add(alias);
      return {
        itemId: item.id,
        name: item.name,
        kind: item.kind,
        username: item.username,
        collectionIds: item.collectionIds,
        alias,
        grant: previous?.grant ?? [],
      };
    })
    .toSorted(
      (left, right) =>
        left.name.localeCompare(right.name) || left.itemId.localeCompare(right.itemId),
    );
};

export const loadSecretsFile = Effect.fn("SecretsState.load")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
  if (Option.isNone(text)) return EMPTY_SECRETS_FILE;
  const decoded = decodeSecretsFile(text.value);
  if (Option.isSome(decoded)) return decoded.value;
  // Keep the unreadable file for inspection instead of overwriting it on the next save.
  const aside = `${filePath}.corrupt-${yield* Clock.currentTimeMillis}`;
  yield* fileSystem.rename(filePath, aside).pipe(Effect.ignore);
  yield* Effect.logWarning("Moved an unreadable secrets catalog aside and started empty");
  return EMPTY_SECRETS_FILE;
});

export const saveSecretsFile = Effect.fn("SecretsState.save")(function* (
  filePath: string,
  file: SecretsFile,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.tmp`;
  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.chmod(directory, 0o700);
    yield* fileSystem.writeFileString(temporary, encodeSecretsFile(file), { mode: 0o600 });
    yield* fileSystem.rename(temporary, filePath);
  }).pipe(
    Effect.catch(() =>
      fileSystem
        .remove(temporary)
        .pipe(
          Effect.ignore,
          Effect.andThen(Effect.fail(new ForkSecretsError({ reason: "persist_failed" }))),
        ),
    ),
  );
});

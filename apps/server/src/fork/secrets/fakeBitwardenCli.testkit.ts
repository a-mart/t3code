// @effect-diagnostics nodeBuiltinImport:off - zlib's crc32 for test archives.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeZlib from "node:zlib";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A stand-in for the Bitwarden CLI. It keeps its state in the data directory
 * T3 passes through `BITWARDENCLI_APPDATA_DIR`, logs every invocation, and
 * echoes a secret on stderr when it fails, so tests can prove stderr never
 * reaches a caller.
 */
export const FAKE_BW_SCRIPT = String.raw`#!/usr/bin/env node
"use strict";
// getBuiltinModule works whether a surrounding package.json makes this file ESM or CommonJS.
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const crypto = process.getBuiltinModule("node:crypto");
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("2026.10.0\n");
  process.exit(0);
}
const dataDir = process.env.BITWARDENCLI_APPDATA_DIR;
if (!dataDir) process.exit(9);
const read = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8")); } catch { return fallback; }
};
const write = (name, value) => fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value));
const vault = read("fake-vault.json", null);
const state = read("fake-state.json", { loggedIn: false, serverUrl: "https://vault.bitwarden.com", session: null, syncs: 0 });
fs.appendFileSync(path.join(dataDir, "invocations.jsonl"), JSON.stringify({
  args: argv,
  session: process.env.BW_SESSION === undefined ? null : process.env.BW_SESSION === state.session ? "valid" : "other",
  bwVariables: Object.keys(process.env).filter((name) => name.startsWith("BW_")).sort(),
}) + "\n");
const args = argv.filter((arg) => arg !== "--nointeraction");
const unlocked = state.loggedIn && state.session !== null && process.env.BW_SESSION === state.session;
const out = (value) => {
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  process.exit(0);
};
const fail = (message) => {
  const leak = vault && vault.items[0] && vault.items[0].login ? vault.items[0].login.password : "";
  process.stderr.write(message + " " + leak);
  process.exit(1);
};
const requireUnlocked = () => { if (!unlocked) fail("Vault is locked."); };
switch (args[0]) {
  case "status":
    out({
      serverUrl: state.serverUrl,
      userEmail: state.loggedIn ? vault.email : null,
      status: !state.loggedIn ? "unauthenticated" : unlocked ? "unlocked" : "locked",
    });
    break;
  case "config":
    if (state.loggedIn) fail("Logout required before server config update.");
    write("fake-state.json", { ...state, serverUrl: args[2] });
    out("Saved setting config.");
    break;
  case "login": {
    // Stands in for a sign-in a person completes at bw's prompts, which ends unlocked.
    if (state.loggedIn) fail("You are already logged in as " + vault.email + ".");
    const session = crypto.randomBytes(32).toString("base64");
    write("fake-state.json", { ...state, loggedIn: true, session });
    out("You are logged in! export BW_SESSION=" + session);
    break;
  }
  case "unlock": {
    if (!state.loggedIn) fail("You are not logged in.");
    const variable = args[args.indexOf("--passwordenv") + 1];
    if (process.env[variable] !== vault.password) fail("Invalid master password.");
    const session = crypto.randomBytes(32).toString("base64");
    write("fake-state.json", { ...state, session });
    out(args.includes("--raw") ? session : "export BW_SESSION=" + session);
    break;
  }
  case "lock":
    write("fake-state.json", { ...state, session: null });
    out("Your vault is locked.");
    break;
  case "logout":
    if (!state.loggedIn) fail("You are not logged in.");
    write("fake-state.json", { ...state, loggedIn: false, session: null });
    out("You have logged out.");
    break;
  case "sync":
    requireUnlocked();
    write("fake-state.json", { ...state, syncs: state.syncs + 1 });
    out("Syncing complete.");
    break;
  case "list":
    requireUnlocked();
    if (args[1] === "organizations") out(vault.organizations);
    if (args[1] === "collections") out(vault.collections);
    if (args[1] === "items") {
      const id = args[args.indexOf("--collectionid") + 1];
      out(vault.items.filter((item) => (item.collectionIds || []).includes(id)));
    }
    fail("Unknown list.");
    break;
  case "get": {
    requireUnlocked();
    const item = vault.items.find((candidate) => candidate.id === args[2]);
    if (!item) fail("Not found.");
    out(item);
    break;
  }
  case "create": {
    requireUnlocked();
    if (args[1] !== "item" || args.length > 2) fail("Unknown create.");
    const input = JSON.parse(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8"));
    const collection = vault.collections.find((candidate) =>
      candidate.organizationId === input.organizationId && (input.collectionIds || []).includes(candidate.id));
    if (!collection || collection.readOnly) fail("You do not have permission to edit this.");
    const item = { id: crypto.randomUUID(), type: input.type, name: input.name,
      collectionIds: input.collectionIds, login: input.login, notes: input.notes };
    vault.items.push(item);
    write("fake-vault.json", vault);
    out({ object: "item", ...item });
    break;
  }
  default:
    fail("Unknown command.");
}
`;

export interface FakeVaultItem {
  readonly id: string;
  readonly type: 1 | 2 | 3 | 5;
  readonly name: string;
  readonly login?: { readonly username?: string | null; readonly password?: string | null };
  readonly notes?: string | null;
  readonly sshKey?: { readonly privateKey?: string | null };
  readonly collectionIds: ReadonlyArray<string>;
}

export interface FakeVault {
  readonly email: string;
  readonly password: string;
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly collections: ReadonlyArray<{
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    /** The account can read but not add items. */
    readonly readOnly?: boolean;
  }>;
  readonly items: ReadonlyArray<FakeVaultItem>;
}

export interface FakeInvocation {
  readonly args: ReadonlyArray<string>;
  readonly session: "valid" | "other" | null;
  readonly bwVariables: ReadonlyArray<string>;
}

const ORGANIZATION_ID = "0f6a2b54-6f0e-4d9c-9f5a-6b2f3c1d7e01";
export const INFRA_COLLECTION_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const BILLING_COLLECTION_ID = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
export const PROD_DB_ITEM_ID = "3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7";
const DEPLOY_TOKEN_ITEM_ID = "4f5a6b7c-8d9e-4fa0-b1c2-d3e4f5a6b7c8";
const BILLING_KEY_ITEM_ID = "5a6b7c8d-9e0f-4a1b-c2d3-e4f5a6b7c8d9";
export const PROD_DB_PASSWORD = "pR0d-db_Pa55w0rd!xK7#Lq2";
export const DEPLOY_TOKEN = "ghp_9fKx2LmQ8vNw4RtY7uZaBcDeFgHiJkL0";

export const defaultVault = (): FakeVault => ({
  email: "agent@example.com",
  password: "correct horse battery staple",
  organizations: [{ id: ORGANIZATION_ID, name: "Acme" }],
  collections: [
    { id: INFRA_COLLECTION_ID, organizationId: ORGANIZATION_ID, name: "Infra" },
    { id: BILLING_COLLECTION_ID, organizationId: ORGANIZATION_ID, name: "Billing" },
  ],
  items: [
    {
      id: PROD_DB_ITEM_ID,
      type: 1,
      name: "Prod DB",
      login: { username: "app", password: PROD_DB_PASSWORD },
      collectionIds: [INFRA_COLLECTION_ID],
    },
    {
      id: DEPLOY_TOKEN_ITEM_ID,
      type: 2,
      name: "Deploy token",
      notes: DEPLOY_TOKEN,
      collectionIds: [INFRA_COLLECTION_ID],
    },
    {
      id: BILLING_KEY_ITEM_ID,
      type: 1,
      name: "Billing API",
      login: { username: "billing", password: "bIll1ng-Ap1-k3y-Qw9Er8" },
      collectionIds: [BILLING_COLLECTION_ID],
    },
  ],
});

/** Writes the fake `bw` into `binDirectory` and its vault into T3's `bw` data directory. */
export const installFakeBitwarden = Effect.fn("installFakeBitwarden")(function* (input: {
  readonly binDirectory: string;
  readonly dataDirectory: string;
  readonly vault: FakeVault;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(input.binDirectory, { recursive: true });
  yield* fileSystem.makeDirectory(input.dataDirectory, { recursive: true });
  const executable = path.join(input.binDirectory, "bw");
  yield* fileSystem.writeFileString(executable, FAKE_BW_SCRIPT, { mode: 0o755 });
  yield* writeFakeVault(input.dataDirectory, input.vault);
  return executable;
});

export const writeFakeVault = Effect.fn("writeFakeVault")(function* (
  dataDirectory: string,
  vault: FakeVault,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(dataDirectory, "fake-vault.json"), encodeJson(vault));
});

export const readFakeVault = Effect.fn("readFakeVault")(function* (dataDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return decodeJson(
    yield* fileSystem.readFileString(path.join(dataDirectory, "fake-vault.json")),
  ) as FakeVault;
});

/** A zip of `entries`, stored uncompressed, with Unix modes like the release archives. */
export const makeZip = (
  entries: ReadonlyArray<{ readonly name: string; readonly data: Uint8Array }>,
): Uint8Array => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

export const readInvocations = Effect.fn("readInvocations")(function* (dataDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(dataDirectory, "invocations.jsonl"))
    .pipe(Effect.orElseSucceed(() => ""));
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeJson(line) as FakeInvocation);
});

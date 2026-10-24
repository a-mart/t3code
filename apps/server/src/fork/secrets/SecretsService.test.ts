// @effect-diagnostics nodeBuiltinImport:off - pinning test archives needs a synchronous digest.
import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ManagedBinary from "../managedBinary.ts";
import * as BitwardenCli from "./BitwardenCli.ts";
import {
  BILLING_COLLECTION_ID,
  DEPLOY_TOKEN,
  FAKE_BW_SCRIPT,
  makeZip,
  readFakeVault,
  INFRA_COLLECTION_ID,
  PROD_DB_ITEM_ID,
  PROD_DB_PASSWORD,
  defaultVault,
  installFakeBitwarden,
  readInvocations,
  writeFakeVault,
  type FakeVault,
} from "./fakeBitwardenCli.testkit.ts";
import * as Nono from "./Nono.ts";
import { FAKE_NONO_SCRIPT, makeTarGz, readFakeNonoRun, writeFakeNono } from "./fakeNono.testkit.ts";
import * as SecretsService from "./SecretsService.ts";
import * as SecureExec from "./SecureExec.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const httpServing = (files: ReadonlyMap<string, Uint8Array>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body = files.get(request.url);
        return HttpClientResponse.fromWeb(
          request,
          body === undefined
            ? new Response(null, { status: 404 })
            : new Response(Buffer.from(body)),
        );
      }),
    ),
  );

const noDownloads = httpServing(new Map());

// Node, for the fake `bw`, and system tools only: no nono a developer installed is found.
const hermeticPath = [
  NodePath.dirname(process.execPath),
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");
const hermeticHost = Layer.succeed(HostProcess.Environment, { ...process.env, PATH: hermeticPath });

const memorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name) => Effect.sync(() => stored.get(name) ?? new Uint8Array(32)),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layerWith = (exec: Layer.Layer<SecureExec.SecureExec, never, never>) =>
  SecretsService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(BitwardenCli.layer, Nono.layer, exec)),
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-secrets-" }),
        memorySecretStore,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer, noDownloads, hermeticHost),
    ),
  );

const layerReal = SecretsService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BitwardenCli.layer, Nono.layer, SecureExec.layer)),
  Layer.provideMerge(
    Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-secrets-" }),
      memorySecretStore,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer, noDownloads, hermeticHost),
  ),
);

type PausableOperation = "status" | "configServer" | "listCollections" | "listItems";

/** Holds the next call to one `bw` operation until the test releases it. */
class CliPause extends Context.Service<
  CliPause,
  {
    readonly arm: (operation: PausableOperation) => Effect.Effect<void>;
    readonly reached: Effect.Effect<void>;
    readonly release: Effect.Effect<void>;
  }
>()("t3/fork/secrets/SecretsService.test/CliPause") {}

const layerPausableCli = Layer.effectContext(
  Effect.gen(function* () {
    const real = yield* BitwardenCli.BitwardenCli;
    const armed = yield* Ref.make<PausableOperation | null>(null);
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const pausable = <A, E>(operation: PausableOperation, run: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const hit = yield* Ref.modify(armed, (current) =>
          current === operation ? [true, null] : [false, current],
        );
        if (hit) {
          yield* Deferred.succeed(reached, undefined);
          yield* Deferred.await(release);
        }
        return yield* run;
      });
    return Context.make(
      BitwardenCli.BitwardenCli,
      BitwardenCli.BitwardenCli.of({
        ...real,
        status: (cli, session) => pausable("status", real.status(cli, session)),
        configServer: (cli, serverUrl) =>
          pausable("configServer", real.configServer(cli, serverUrl)),
        listCollections: (cli, session) =>
          pausable("listCollections", real.listCollections(cli, session)),
        listItems: (cli, session, collectionIds) =>
          pausable("listItems", real.listItems(cli, session, collectionIds)),
      }),
    ).pipe(
      Context.add(
        CliPause,
        CliPause.of({
          arm: (operation) => Ref.set(armed, operation),
          reached: Deferred.await(reached),
          release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
        }),
      ),
    );
  }),
).pipe(Layer.provide(BitwardenCli.layer));

const layerPausable = SecretsService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(layerPausableCli, Nono.layer, SecureExec.layer)),
  Layer.provideMerge(
    Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-secrets-" }),
      memorySecretStore,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer, noDownloads, hermeticHost),
  ),
);

const secretStoreFailingRemove = Layer.effect(
  ServerSecretStore.ServerSecretStore,
  Effect.gen(function* () {
    const memory = yield* ServerSecretStore.ServerSecretStore;
    return ServerSecretStore.ServerSecretStore.of({
      ...memory,
      remove: (name) =>
        Effect.fail(new ServerSecretStore.SecretStoreRemoveError({ resource: name, cause: null })),
    });
  }),
).pipe(Layer.provide(memorySecretStore));

const layerFailingRemove = SecretsService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BitwardenCli.layer, Nono.layer, SecureExec.layer)),
  Layer.provideMerge(
    Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-secrets-" }),
      secretStoreFailingRemove,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer, noDownloads, hermeticHost),
  ),
);

const RELEASE_URL = "https://downloads.example.test/bw-test.zip";

/** Installs come from `archive`, pinned like the official release unless `release` overrides it. */
const layerInstalling = (archive: Uint8Array, release: Partial<ManagedBinary.PinnedRelease> = {}) =>
  SecretsService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(BitwardenCli.layer, Nono.layer, SecureExec.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-secrets-" }),
        memorySecretStore,
        Layer.succeed(BitwardenCli.ManagedCliReleaseOverride, {
          version: BitwardenCli.MANAGED_CLI_VERSION,
          url: RELEASE_URL,
          bytes: archive.byteLength,
          sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
          ...release,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        EffectNodeCrypto.layer,
        hermeticHost,
        httpServing(new Map([[RELEASE_URL, archive]])),
      ),
    ),
  );

const fakeCliArchive = makeZip([{ name: "bw", data: new TextEncoder().encode(FAKE_BW_SCRIPT) }]);

const NONO_RELEASE_URL = "https://downloads.example.test/nono-test.tar.gz";

/** Installs nono from `archive`, pinned like the official release unless `release` overrides it. */
const layerInstallingNono = (
  archive: Uint8Array,
  release: Partial<ManagedBinary.PinnedRelease> = {},
) =>
  SecretsService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(BitwardenCli.layer, Nono.layer, SecureExec.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-secrets-" }),
        memorySecretStore,
        Layer.succeed(Nono.ManagedNonoReleaseOverride, {
          version: Nono.MANAGED_NONO_VERSION,
          url: NONO_RELEASE_URL,
          bytes: archive.byteLength,
          sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
          ...release,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        EffectNodeCrypto.layer,
        httpServing(new Map([[NONO_RELEASE_URL, archive]])),
        hermeticHost,
      ),
    ),
  );

const fakeNonoArchive = makeTarGz([
  { name: "nono", data: new TextEncoder().encode(FAKE_NONO_SCRIPT) },
]);

// Ambient Bitwarden variables must never reach `bw` or a secure command.
const hostEnvironment = {
  ...process.env,
  PATH: hermeticPath,
  BW_SESSION: "ambient-session",
  BW_PASSWORD: "ambient-password",
  BITWARDENCLI_APPDATA_DIR: "/nonexistent/ambient-bitwarden",
};

const setup = Effect.fn("setup")(function* (vault: FakeVault = defaultVault()) {
  const secrets = yield* SecretsService.SecretsService;
  const cli = yield* BitwardenCli.BitwardenCli;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const cliPath = yield* installFakeBitwarden({
    binDirectory: path.join(config.baseDir, "fake-bin"),
    dataDirectory: cli.dataDirectory,
    vault,
  });
  yield* secrets.configure({ cliPath });
  return { secrets, dataDirectory: cli.dataDirectory, cliPath, vault };
});

const connect = Effect.fn("connect")(function* (vault: FakeVault = defaultVault()) {
  const harness = yield* setup(vault);
  const state = yield* harness.secrets.connect({
    clientId: vault.clientId,
    clientSecret: vault.clientSecret,
    password: vault.password,
  });
  return { ...harness, state };
});

const grantProdDb = Effect.fn("grantProdDb")(function* (
  secrets: SecretsService.SecretsService["Service"],
) {
  yield* secrets.setCollections({ collectionIds: [INFRA_COLLECTION_ID] });
  return yield* secrets.updateItem({ itemId: PROD_DB_ITEM_ID, grant: [projectA] });
});

const runAs = (
  secrets: SecretsService.SecretsService["Service"],
  input: {
    readonly aliases: ReadonlyArray<string>;
    readonly command: string;
    readonly projectId?: ProjectId;
    readonly cwd?: string;
    readonly authorize?: Effect.Effect<void, OrchestratorMcpFailure>;
    readonly stillLive?: Effect.Effect<boolean>;
    readonly timeout?: Duration.Duration;
    readonly oneOff?: {
      readonly names: ReadonlyArray<string>;
      readonly consume: Effect.Effect<ReadonlyArray<string>, OrchestratorMcpFailure>;
    };
  },
) =>
  secrets.runSecureCommand({
    projectId: input.projectId ?? projectA,
    cwd: input.cwd ?? process.cwd(),
    aliases: input.aliases,
    command: input.command,
    timeout: input.timeout ?? Duration.seconds(30),
    authorize: input.authorize ?? Effect.void,
    stillLive: input.stillLive ?? Effect.succeed(true),
    ...(input.oneOff === undefined ? {} : { oneOff: input.oneOff }),
  });

describe("Bitwarden connection", () => {
  it.live("connects with an API key and keeps secrets out of arguments and stray variables", () =>
    Effect.gen(function* () {
      const { state, dataDirectory, vault } = yield* connect();
      expect(state.status).toBe("ready");
      expect(state.account).toEqual({
        email: "agent@example.com",
        serverUrl: "https://vault.bitwarden.com",
      });
      expect(state.availableCollections.map((collection) => collection.name)).toEqual([
        "Billing",
        "Infra",
      ]);
      expect(state.availableCollections[0]?.organizationName).toBe("Acme");
      expect(state.loginCommand).toContain("BITWARDENCLI_APPDATA_DIR=");

      const invocations = yield* readInvocations(dataDirectory);
      const commands = invocations.map((invocation) =>
        invocation.args.find((arg) => !arg.startsWith("-")),
      );
      expect(commands).toContain("login");
      expect(commands).toContain("unlock");
      for (const invocation of invocations) {
        expect(invocation.args[0]).toBe("--nointeraction");
        const joined = invocation.args.join(" ");
        expect(joined).not.toContain(vault.password);
        expect(joined).not.toContain(vault.clientSecret);
        expect(invocation.bwVariables).not.toContain("BW_PASSWORD");
        expect(invocation.session).not.toBe("other");
        if (!invocation.args.includes("login")) {
          expect(invocation.bwVariables).not.toContain("BW_CLIENTSECRET");
        }
      }
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("stays locked after a wrong master password, and unlocks after the right one", () =>
    Effect.gen(function* () {
      const vault = defaultVault();
      const { secrets } = yield* setup(vault);
      const wrong = yield* secrets
        .connect({ clientId: vault.clientId, clientSecret: vault.clientSecret, password: "nope" })
        .pipe(Effect.flip);
      expect(wrong.reason).toBe("unlock_failed");
      expect((yield* secrets.getState).status).toBe("locked");
      const unlocked = yield* secrets.unlock({ password: vault.password });
      expect(unlocked.status).toBe("ready");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("names who is signed in while the vault is locked", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory, vault } = yield* connect();
      expect((yield* secrets.lock).account?.email).toBe(vault.email);
      yield* secrets.logout;
      yield* writeFakeVault(dataDirectory, { ...vault, email: "someone-else@example.com" });
      yield* secrets
        .connect({ clientId: vault.clientId, clientSecret: vault.clientSecret, password: "nope" })
        .pipe(Effect.flip);
      const state = yield* secrets.getState;
      expect(state.status).toBe("locked");
      expect(state.account?.email).toBe("someone-else@example.com");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("lets a lock win over an unlock that was still finishing", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory, vault } = yield* connect();
      yield* secrets.lock;
      const pause = yield* CliPause;
      yield* pause.arm("listCollections");
      const unlocking = yield* secrets
        .unlock({ password: vault.password })
        .pipe(Effect.flip, Effect.forkChild);
      yield* pause.reached;
      expect((yield* secrets.lock).status).toBe("locked");
      yield* pause.release;
      expect((yield* Fiber.join(unlocking)).reason).toBe("locked");
      expect((yield* secrets.getState).status).toBe("locked");
      // The session that unlock created was locked in `bw` as well.
      const invocations = yield* readInvocations(dataDirectory);
      expect(invocations.at(-1)).toMatchObject({
        args: ["--nointeraction", "lock"],
        session: "valid",
      });
    }).pipe(
      Effect.provide(layerPausable),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("lets a lock win over an unlock that was still checking the account", () =>
    Effect.gen(function* () {
      const { secrets, vault } = yield* connect();
      yield* secrets.lock;
      const pause = yield* CliPause;
      yield* pause.arm("status");
      const unlocking = yield* secrets
        .unlock({ password: vault.password })
        .pipe(Effect.flip, Effect.forkChild);
      yield* pause.reached;
      expect((yield* secrets.lock).status).toBe("locked");
      yield* pause.release;
      expect((yield* Fiber.join(unlocking)).reason).toBe("locked");
      expect((yield* secrets.getState).status).toBe("locked");
    }).pipe(
      Effect.provide(layerPausable),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("keeps the first unlock's session when a second unlock waited behind it", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory, vault } = yield* connect();
      yield* grantProdDb(secrets);
      yield* secrets.lock;
      const unlocksBefore = (yield* readInvocations(dataDirectory)).filter((invocation) =>
        invocation.args.includes("unlock"),
      ).length;
      const pause = yield* CliPause;
      yield* pause.arm("listCollections");
      const first = yield* secrets.unlock({ password: vault.password }).pipe(Effect.forkChild);
      yield* pause.reached;
      const second = yield* secrets
        .unlock({ password: vault.password })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* pause.release;
      expect((yield* Fiber.join(first)).status).toBe("ready");
      expect((yield* Fiber.join(second)).status).toBe("ready");
      const unlocksAfter = (yield* readInvocations(dataDirectory)).filter((invocation) =>
        invocation.args.includes("unlock"),
      ).length;
      expect(unlocksAfter - unlocksBefore).toBe(1);
      const result = yield* runAs(secrets, { aliases: ["PROD_DB"], command: "echo ok" });
      expect(result.stdout).toBe("ok\n");
    }).pipe(
      Effect.provide(layerPausable),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("lets a logout win over a sign-in that was still in progress", () =>
    Effect.gen(function* () {
      const vault = defaultVault();
      const { secrets } = yield* setup(vault);
      const pause = yield* CliPause;
      yield* pause.arm("configServer");
      const connecting = yield* secrets
        .connect({
          clientId: vault.clientId,
          clientSecret: vault.clientSecret,
          password: vault.password,
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* pause.reached;
      expect((yield* secrets.logout).status).toBe("unauthenticated");
      yield* pause.release;
      expect((yield* Fiber.join(connecting)).reason).toBe("unauthenticated");
      expect((yield* secrets.getState).status).toBe("unauthenticated");
    }).pipe(
      Effect.provide(layerPausable),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("refuses a sign-in for another server while an account is signed in", () =>
    Effect.gen(function* () {
      const { secrets, vault } = yield* connect();
      const elsewhere = {
        clientId: vault.clientId,
        clientSecret: vault.clientSecret,
        password: vault.password,
        serverUrl: "https://vault.bitwarden.eu",
      };
      expect((yield* secrets.connect(elsewhere).pipe(Effect.flip)).reason).toBe(
        "already_authenticated",
      );
      yield* secrets.lock;
      expect((yield* secrets.connect(elsewhere).pipe(Effect.flip)).reason).toBe(
        "already_authenticated",
      );
      expect((yield* secrets.getState).status).toBe("locked");
      // Naming the signed-in server, spelled out or not, still unlocks.
      const same = yield* secrets.connect({
        ...elsewhere,
        serverUrl: "https://vault.bitwarden.com",
      });
      expect(same.status).toBe("ready");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("signs in to the server the request names, not one another client chose", () =>
    Effect.gen(function* () {
      const vault = defaultVault();
      const { secrets } = yield* setup(vault);
      // Another client switched this host to a self-hosted server after this form loaded.
      yield* secrets.configure({ serverUrl: "https://vault.example.com" });
      const state = yield* secrets.connect({
        clientId: vault.clientId,
        clientSecret: vault.clientSecret,
        password: vault.password,
        serverUrl: null,
      });
      expect(state.serverUrl).toBeNull();
      expect(state.account?.serverUrl).toBe("https://vault.bitwarden.com");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("applies a collection change made during a sync after the sync", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* secrets.setCollections({
        collectionIds: [INFRA_COLLECTION_ID, BILLING_COLLECTION_ID],
      });
      const pause = yield* CliPause;
      yield* pause.arm("listItems");
      const syncing = yield* secrets.sync.pipe(Effect.forkChild);
      yield* pause.reached;
      // Started at once so, without serialization, it would reach `bw` before the sync resumes.
      const choosing = yield* secrets
        .setCollections({ collectionIds: [INFRA_COLLECTION_ID] })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* pause.release;
      yield* Fiber.join(syncing);
      yield* Fiber.join(choosing);
      const state = yield* secrets.getState;
      expect(state.selectedCollections.map((collection) => collection.id)).toEqual([
        INFRA_COLLECTION_ID,
      ]);
      expect(state.items.every((item) => item.collectionIds.includes(INFRA_COLLECTION_ID))).toBe(
        true,
      );
    }).pipe(
      Effect.provide(layerPausable),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("reports a kept session it couldn't remove when stay-unlocked turns off", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* secrets.configure({ keepUnlocked: true });
      const error = yield* secrets.configure({ keepUnlocked: false }).pipe(Effect.flip);
      expect(error.reason).toBe("persist_failed");
    }).pipe(
      Effect.provide(layerFailingRemove),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("reports a rejected API key and stays signed out", () =>
    Effect.gen(function* () {
      const vault = defaultVault();
      const { secrets } = yield* setup(vault);
      const error = yield* secrets
        .connect({ clientId: vault.clientId, clientSecret: "wrong", password: vault.password })
        .pipe(Effect.flip);
      expect(error.reason).toBe("login_failed");
      // The fake CLI echoes a secret on stderr; it must not surface anywhere.
      expect(error.message).not.toContain(PROD_DB_PASSWORD);
      expect((yield* secrets.getState).status).toBe("unauthenticated");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("locks and logs out, and refuses to change servers while signed in", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      const changing = yield* secrets
        .configure({ serverUrl: "https://vault.example.com" })
        .pipe(Effect.flip);
      expect(changing.reason).toBe("already_authenticated");
      expect((yield* secrets.lock).status).toBe("locked");
      expect((yield* secrets.logout).status).toBe("unauthenticated");
      const moved = yield* secrets.configure({ serverUrl: "https://vault.example.com/" });
      expect(moved.serverUrl).toBe("https://vault.example.com");
      const nested = yield* secrets.configure({ serverUrl: "https://example.com/bitwarden/" });
      expect(nested.serverUrl).toBe("https://example.com/bitwarden");
      const insecure = yield* secrets
        .configure({ serverUrl: "http://vault.example.com" })
        .pipe(Effect.flip);
      expect(insecure.reason).toBe("invalid_server_url");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("refuses a bw that keeps a portable bw-data folder beside it", () =>
    Effect.gen(function* () {
      const { secrets, cliPath } = yield* setup();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const portable = path.join(path.dirname(cliPath), "bw-data");
      yield* fileSystem.makeDirectory(portable);
      yield* fileSystem.writeFileString(path.join(portable, "sentinel"), "personal");
      // The version cache is keyed by the executable, so re-inspection still happens.
      const error = yield* secrets.configure({ cliPath }).pipe(Effect.flip);
      expect(error.reason).toBe("cli_unusable");
      expect(yield* fileSystem.readFileString(path.join(portable, "sentinel"))).toBe("personal");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );
});

describe("catalog", () => {
  it.live("keeps aliases and grants by item id across syncs and starts new items ungranted", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory, vault } = yield* connect();
      const selected = yield* secrets.setCollections({ collectionIds: [INFRA_COLLECTION_ID] });
      expect(selected.items.map((item) => [item.alias, item.grant])).toEqual([
        ["DEPLOY_TOKEN", []],
        ["PROD_DB", []],
      ]);
      yield* secrets.updateItem({
        itemId: PROD_DB_ITEM_ID,
        alias: "DATABASE_PASSWORD",
        grant: [projectA],
      });

      yield* writeFakeVault(dataDirectory, {
        ...vault,
        items: [
          ...vault.items.map((item) =>
            item.id === PROD_DB_ITEM_ID ? { ...item, name: "Production database" } : item,
          ),
          {
            id: "6b7c8d9e-0f1a-4b2c-93d4-e5f6a7b8c9d0",
            type: 1,
            name: "Prod DB",
            login: { username: "replica", password: "rEpl1ca-Pa55-Zx9" },
            collectionIds: [INFRA_COLLECTION_ID],
          },
        ],
      });
      const synced = yield* secrets.sync;
      const byId = new Map(synced.items.map((item) => [item.itemId, item]));
      expect(byId.get(PROD_DB_ITEM_ID)).toMatchObject({
        name: "Production database",
        alias: "DATABASE_PASSWORD",
        grant: [projectA],
      });
      expect(byId.get("6b7c8d9e-0f1a-4b2c-93d4-e5f6a7b8c9d0")).toMatchObject({
        alias: "PROD_DB",
        grant: [],
      });
      expect(synced.lastSyncedAt).not.toBeNull();
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("rejects invalid and duplicate aliases", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* secrets.setCollections({ collectionIds: [INFRA_COLLECTION_ID] });
      const reserved = yield* secrets
        .updateItem({ itemId: PROD_DB_ITEM_ID, alias: "PATH" })
        .pipe(Effect.flip);
      expect(reserved.reason).toBe("invalid_alias");
      const lower = yield* secrets
        .updateItem({ itemId: PROD_DB_ITEM_ID, alias: "prod" })
        .pipe(Effect.flip);
      expect(lower.reason).toBe("invalid_alias");
      const taken = yield* secrets
        .updateItem({ itemId: PROD_DB_ITEM_ID, alias: "DEPLOY_TOKEN" })
        .pipe(Effect.flip);
      expect(taken.reason).toBe("alias_taken");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("starts a fresh catalog when a different account signs in", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory, vault } = yield* connect();
      yield* grantProdDb(secrets);
      yield* secrets.logout;
      yield* writeFakeVault(dataDirectory, { ...vault, email: "someone-else@example.com" });
      const state = yield* secrets.connect({
        clientId: vault.clientId,
        clientSecret: vault.clientSecret,
        password: vault.password,
      });
      expect(state.account?.email).toBe("someone-else@example.com");
      expect(state.selectedCollections).toEqual([]);
      expect(state.items).toEqual([]);
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("rejects a collection the account can't see", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      const error = yield* secrets
        .setCollections({ collectionIds: ["9f9f9f9f-0000-4000-8000-000000000000"] })
        .pipe(Effect.flip);
      expect(error.reason).toBe("collection_not_found");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );
});

describe("secure commands", () => {
  it.live("delivers granted values and redacts them from both streams", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* grantProdDb(secrets);
      const result = yield* runAs(secrets, {
        aliases: ["PROD_DB"],
        command: [
          `test "$PROD_DB" = '${PROD_DB_PASSWORD}' && echo "matches"`,
          `echo "raw: $PROD_DB"`,
          `printf '%s' "$PROD_DB" | base64`,
          `printf 'err: %s\\n' "$PROD_DB" >&2`,
        ].join("\n"),
      });
      expect(result.exitCode).toBe(0);
      expect(result.redacted).toBe(true);
      expect(result.stdout).toContain("matches");
      expect(result.stdout).toContain("raw: [redacted:PROD_DB]");
      expect(result.stdout).not.toContain(PROD_DB_PASSWORD);
      expect(result.stdout).not.toContain(Buffer.from(PROD_DB_PASSWORD).toString("base64"));
      expect(result.stderr).toBe("err: [redacted:PROD_DB]\n");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("refuses secrets the project wasn't granted, and names it", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* grantProdDb(secrets);
      const other = yield* runAs(secrets, {
        aliases: ["PROD_DB"],
        command: "true",
        projectId: projectB,
      }).pipe(Effect.flip);
      expect(other).toMatchObject({
        _tag: "SecureCommandError",
        reason: "not_granted",
        alias: "PROD_DB",
      });
      const ungranted = yield* runAs(secrets, { aliases: ["DEPLOY_TOKEN"], command: "true" }).pipe(
        Effect.flip,
      );
      expect(ungranted).toMatchObject({ reason: "not_granted", alias: "DEPLOY_TOKEN" });
      const unknown = yield* runAs(secrets, { aliases: ["NOPE"], command: "true" }).pipe(
        Effect.flip,
      );
      expect(unknown).toMatchObject({ reason: "unknown_secret", alias: "NOPE" });
      const duplicate = yield* runAs(secrets, {
        aliases: ["PROD_DB", "PROD_DB"],
        command: "true",
      }).pipe(Effect.flip);
      expect(duplicate).toMatchObject({ reason: "duplicate_secret" });
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("grants to all projects reach every project, and locking refuses new commands", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* secrets.setCollections({ collectionIds: [INFRA_COLLECTION_ID] });
      const state = yield* secrets.updateItem({ itemId: PROD_DB_ITEM_ID, grant: "all" });
      expect(state.items.find((item) => item.itemId === PROD_DB_ITEM_ID)?.grant).toBe("all");
      const result = yield* runAs(secrets, {
        aliases: ["PROD_DB"],
        command: "echo ok",
        projectId: projectB,
      });
      expect(result.stdout).toBe("ok\n");
      expect(
        (yield* secrets.listForProject(projectB)).secrets.map((secret) => secret.alias),
      ).toEqual(["PROD_DB"]);
      yield* secrets.lock;
      const locked = yield* runAs(secrets, { aliases: ["PROD_DB"], command: "true" }).pipe(
        Effect.flip,
      );
      expect(locked).toMatchObject({ reason: "locked" });
      expect((yield* secrets.listForProject(projectA)).bitwarden).toBe("locked");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("drops grants when a collection is deselected", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* grantProdDb(secrets);
      yield* secrets.setCollections({ collectionIds: [BILLING_COLLECTION_ID] });
      const error = yield* runAs(secrets, { aliases: ["PROD_DB"], command: "true" }).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unknown_secret" });
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("passes the caller's authorization failure through and starts nothing", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* grantProdDb(secrets);
      const refusal = new OrchestratorMcpFailure({ code: "parent_not_active", message: "ended" });
      const error = yield* runAs(secrets, {
        aliases: ["PROD_DB"],
        command: "echo should-not-run",
        authorize: Effect.fail(refusal),
      }).pipe(Effect.flip);
      expect(error).toBe(refusal);
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );
});

describe("stopping secure commands", () => {
  /** A command that never finishes, reporting when it starts and when it is interrupted. */
  const blockingExec = Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Ref.make(false);
    const layer = Layer.succeed(
      SecureExec.SecureExec,
      SecureExec.SecureExec.of({
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Ref.set(interrupted, true)),
          ),
      }),
    );
    return { started, interrupted, layer };
  });

  it.live("stops a running command when its secret is ungranted", () =>
    Effect.gen(function* () {
      const exec = yield* blockingExec;
      yield* Effect.gen(function* () {
        const { secrets } = yield* connect();
        yield* grantProdDb(secrets);
        const running = yield* runAs(secrets, { aliases: ["PROD_DB"], command: "sleep 60" }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(exec.started);
        yield* secrets.updateItem({ itemId: PROD_DB_ITEM_ID, grant: [] });
        const exit = yield* Fiber.await(running);
        assert(Exit.isFailure(exit));
        expect(Exit.findErrorOption(exit).pipe(Option.getOrUndefined)).toMatchObject({
          reason: "revoked",
        });
        expect(yield* Ref.get(exec.interrupted)).toBe(true);
      }).pipe(Effect.provide(layerWith(exec.layer)));
    }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment)),
  );

  it.live("stops a running command when Bitwarden locks", () =>
    Effect.gen(function* () {
      const exec = yield* blockingExec;
      yield* Effect.gen(function* () {
        const { secrets } = yield* connect();
        yield* grantProdDb(secrets);
        const running = yield* runAs(secrets, { aliases: ["PROD_DB"], command: "sleep 60" }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(exec.started);
        yield* secrets.lock;
        const exit = yield* Fiber.await(running);
        expect(Exit.findErrorOption(exit).pipe(Option.getOrUndefined)).toMatchObject({
          reason: "stopped_locked",
        });
        expect(yield* Ref.get(exec.interrupted)).toBe(true);
      }).pipe(Effect.provide(layerWith(exec.layer)));
    }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment)),
  );

  it.live("leaves no process when access is revoked after admission but before start", () =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const processes = yield* Ref.make(0);
      const exec = Layer.succeed(
        SecureExec.SecureExec,
        SecureExec.SecureExec.of({
          run: () =>
            Deferred.succeed(admitted, undefined).pipe(
              Effect.andThen(Deferred.await(proceed)),
              Effect.andThen(Ref.update(processes, (count) => count + 1)),
              Effect.andThen(Effect.never),
            ),
        }),
      );
      yield* Effect.gen(function* () {
        const { secrets } = yield* connect();
        yield* grantProdDb(secrets);
        const running = yield* runAs(secrets, { aliases: ["PROD_DB"], command: "true" }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(admitted);
        yield* secrets.updateItem({ itemId: PROD_DB_ITEM_ID, grant: [projectB] });
        yield* Deferred.succeed(proceed, undefined);
        const exit = yield* Fiber.await(running);
        expect(Exit.findErrorOption(exit).pipe(Option.getOrUndefined)).toMatchObject({
          reason: "revoked",
        });
        expect(yield* Ref.get(processes)).toBe(0);
      }).pipe(Effect.provide(layerWith(exec)));
    }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment)),
  );

  it.live("stops a command once the caller's run ends", () =>
    Effect.gen(function* () {
      const exec = yield* blockingExec;
      yield* Effect.gen(function* () {
        const { secrets } = yield* connect();
        yield* grantProdDb(secrets);
        const error = yield* runAs(secrets, {
          aliases: ["PROD_DB"],
          command: "sleep 60",
          stillLive: Effect.succeed(false),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ reason: "run_stopped" });
        expect(yield* Ref.get(exec.interrupted)).toBe(true);
      }).pipe(Effect.provide(layerWith(exec.layer)));
    }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment)),
  );

  it.live("delivers the value to the real process", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* secrets.setCollections({ collectionIds: [INFRA_COLLECTION_ID] });
      yield* secrets.updateItem({ itemId: PROD_DB_ITEM_ID, grant: [projectA] });
      const state = yield* secrets.getState;
      const token = state.items.find((item) => item.alias === "DEPLOY_TOKEN");
      assert(token !== undefined);
      yield* secrets.updateItem({ itemId: token.itemId, grant: [projectA] });
      const result = yield* runAs(secrets, {
        aliases: ["DEPLOY_TOKEN"],
        command: `node -e 'process.stdout.write(JSON.stringify({ token: process.env.DEPLOY_TOKEN }))'`,
      });
      expect(result.stdout).toBe('{"token":"[redacted:DEPLOY_TOKEN]"}');
      expect(result.stdout).not.toContain(DEPLOY_TOKEN);
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );
});

describe("one-off values and SSH keys", () => {
  const SSH_ITEM_ID = "7c8d9e0f-1a2b-4c3d-94e5-f6a7b8c9d0e1";
  const SSH_KEY =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA-fake-key-material-9Qx\n-----END OPENSSH PRIVATE KEY-----\n";

  /** Records what reaches the runner without starting a process. */
  const recordingExec = Effect.gen(function* () {
    const runs = yield* Ref.make<ReadonlyArray<SecureExec.SecureExecInput>>([]);
    const layer = Layer.succeed(
      SecureExec.SecureExec,
      SecureExec.SecureExec.of({
        run: (input) =>
          Ref.update(runs, (all) => [...all, input]).pipe(
            Effect.as({
              exitCode: 0,
              timedOut: false,
              stdout: {
                bytes: new TextEncoder().encode(
                  `echo ${Object.values(input.deliveries).join(" ")}`,
                ),
                overflow: false,
              },
              stderr: { bytes: new Uint8Array(), overflow: false },
            }),
          ),
      }),
    );
    return { runs, layer };
  });

  it.live("runs a one-off value without any Bitwarden session and redacts it", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const secrets = yield* SecretsService.SecretsService;
        return yield* runAs(secrets, {
          aliases: [],
          command: 'echo "$SIGNING_KEY"',
          oneOff: { names: ["SIGNING_KEY"], consume: Effect.succeed(["s1gn-ing-K3y-Vx9Qp2"]) },
        });
      }).pipe(Effect.provide(layerReal));
      expect(result.stdout).toBe("[redacted:SIGNING_KEY]\n");
      expect(result.redacted).toBe(true);
    }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment)),
  );

  it.live("validates one-off names and refuses empty requests", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* grantProdDb(secrets);
      const consume = Effect.succeed(["value"]);
      expect(
        yield* runAs(secrets, {
          aliases: [],
          command: "true",
          oneOff: { names: ["path"], consume },
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid_name", alias: "path" });
      // nono reads these as its own options and locations, so one named like them could widen it.
      for (const name of ["NONO_ALLOW", "XDG_CONFIG_HOME"]) {
        expect(
          yield* runAs(secrets, {
            aliases: [],
            command: "true",
            oneOff: { names: [name], consume },
          }).pipe(Effect.flip),
        ).toMatchObject({ reason: "invalid_name", alias: name });
      }
      expect(
        yield* runAs(secrets, {
          aliases: ["PROD_DB"],
          command: "true",
          oneOff: { names: ["PROD_DB"], consume },
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "duplicate_secret", alias: "PROD_DB" });
      expect(
        yield* runAs(secrets, { aliases: [], command: "true" }).pipe(Effect.flip),
      ).toMatchObject({
        reason: "no_secrets",
      });
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("consumes one-off values only after the caller is authorized", () =>
    Effect.gen(function* () {
      const consumed = yield* Ref.make(0);
      const refusal = new OrchestratorMcpFailure({ code: "parent_not_active", message: "ended" });
      const error = yield* Effect.gen(function* () {
        const secrets = yield* SecretsService.SecretsService;
        return yield* runAs(secrets, {
          aliases: [],
          command: "true",
          authorize: Effect.fail(refusal),
          oneOff: {
            names: ["TOKEN"],
            consume: Ref.update(consumed, (count) => count + 1).pipe(Effect.as(["value-123456"])),
          },
        }).pipe(Effect.flip);
      }).pipe(Effect.provide(layerReal));
      expect(error).toBe(refusal);
      expect(yield* Ref.get(consumed)).toBe(0);
    }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment)),
  );

  it.live("keeps a one-off-only command running when Bitwarden locks", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const exec = Layer.succeed(
        SecureExec.SecureExec,
        SecureExec.SecureExec.of({
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                exitCode: 0,
                timedOut: false,
                stdout: { bytes: new TextEncoder().encode("done"), overflow: false },
                stderr: { bytes: new Uint8Array(), overflow: false },
              }),
            ),
        }),
      );
      yield* Effect.gen(function* () {
        const { secrets } = yield* connect();
        const running = yield* runAs(secrets, {
          aliases: [],
          command: "long",
          oneOff: { names: ["TOKEN"], consume: Effect.succeed(["value-123456"]) },
        }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* secrets.lock;
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(running)).stdout).toBe("done");
      }).pipe(Effect.provide(layerWith(exec)));
    }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment)),
  );

  it.live("hands SSH key items to the command's ssh-agent as well as its environment", () =>
    Effect.gen(function* () {
      const exec = yield* recordingExec;
      const base = defaultVault();
      const vault: FakeVault = {
        ...base,
        items: [
          ...base.items,
          {
            id: SSH_ITEM_ID,
            type: 5,
            name: "Deploy key",
            sshKey: { privateKey: SSH_KEY },
            collectionIds: [INFRA_COLLECTION_ID],
          },
        ],
      };
      yield* Effect.gen(function* () {
        const { secrets } = yield* connect(vault);
        yield* secrets.setCollections({ collectionIds: [INFRA_COLLECTION_ID] });
        const state = yield* secrets.updateItem({ itemId: SSH_ITEM_ID, grant: [projectA] });
        expect(state.items.find((item) => item.itemId === SSH_ITEM_ID)).toMatchObject({
          alias: "DEPLOY_KEY",
          kind: "ssh_key",
        });
        yield* runAs(secrets, { aliases: ["DEPLOY_KEY"], command: "ssh host true" });
        const [run] = yield* Ref.get(exec.runs);
        expect(run?.sshKeys).toEqual([SSH_KEY]);
        expect(run?.deliveries).toEqual({ DEPLOY_KEY: SSH_KEY });
      }).pipe(Effect.provide(layerWith(exec.layer)));
    }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment)),
  );
});

describe("managed Bitwarden CLI", () => {
  const managedPath = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return path.join(config.stateDir, "fork", "bin", "bw");
  });

  it.live("installs the pinned CLI from a verified archive and signs in with it", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretsService.SecretsService;
      const cli = yield* BitwardenCli.BitwardenCli;
      const fileSystem = yield* FileSystem.FileSystem;
      const vault = defaultVault();
      yield* fileSystem.makeDirectory(cli.dataDirectory, { recursive: true });
      yield* writeFakeVault(cli.dataDirectory, vault);
      const state = yield* secrets.installCli;
      expect(state.cli).toMatchObject({
        managed: true,
        version: BitwardenCli.MANAGED_CLI_VERSION,
        installVersion: BitwardenCli.MANAGED_CLI_VERSION,
      });
      expect(state.status).toBe("unauthenticated");
      const connected = yield* secrets.connect({
        clientId: vault.clientId,
        clientSecret: vault.clientSecret,
        password: vault.password,
      });
      expect(connected.status).toBe("ready");
    }).pipe(
      Effect.provide(layerInstalling(fakeCliArchive)),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("replaces a configured path with the installed copy", () =>
    Effect.gen(function* () {
      const { secrets } = yield* setup();
      expect((yield* secrets.getState).cli.configuredPath).not.toBeNull();
      const state = yield* secrets.installCli;
      expect(state.cli.configuredPath).toBeNull();
      expect(state.cli.managed).toBe(true);
    }).pipe(
      Effect.provide(layerInstalling(fakeCliArchive)),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("locks a session opened through another executable when it installs", () =>
    Effect.gen(function* () {
      const { secrets, vault } = yield* connect();
      const state = yield* secrets.installCli;
      expect(state).toMatchObject({ status: "locked", cli: { managed: true } });
      const unlocked = yield* secrets.unlock({ password: vault.password });
      expect(unlocked.status).toBe("ready");
    }).pipe(
      Effect.provide(layerInstalling(fakeCliArchive)),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("installs nothing from an archive that fails its checksum", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretsService.SecretsService;
      const fileSystem = yield* FileSystem.FileSystem;
      expect((yield* secrets.installCli.pipe(Effect.flip)).reason).toBe("install_failed");
      expect(yield* fileSystem.exists(yield* managedPath)).toBe(false);
    }).pipe(
      Effect.provide(layerInstalling(fakeCliArchive, { sha256: "0".repeat(64) })),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("installs nothing from an archive holding more than bw", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretsService.SecretsService;
      const fileSystem = yield* FileSystem.FileSystem;
      expect((yield* secrets.installCli.pipe(Effect.flip)).reason).toBe("install_failed");
      expect(yield* fileSystem.exists(yield* managedPath)).toBe(false);
    }).pipe(
      Effect.provide(
        layerInstalling(
          makeZip([
            { name: "bw", data: new TextEncoder().encode(FAKE_BW_SCRIPT) },
            { name: "postinstall.sh", data: new TextEncoder().encode("#!/bin/sh\n") },
          ]),
        ),
      ),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("installs nothing when the binary isn't the pinned version", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretsService.SecretsService;
      const fileSystem = yield* FileSystem.FileSystem;
      expect((yield* secrets.installCli.pipe(Effect.flip)).reason).toBe("install_failed");
      expect(yield* fileSystem.exists(yield* managedPath)).toBe(false);
    }).pipe(
      Effect.provide(layerInstalling(fakeCliArchive, { version: "2099.1.0" })),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );
});

describe("sandbox", () => {
  const managedNono = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return path.join(config.stateDir, "fork", "bin", "nono");
  });

  it.live("turns on only once nono works here, then runs secret commands through it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { secrets } = yield* connect();
      yield* grantProdDb(secrets);
      expect(yield* secrets.configure({ sandbox: true }).pipe(Effect.flip)).toMatchObject({
        reason: "sandbox_unavailable",
      });
      expect((yield* secrets.getState).sandbox.enabled).toBe(false);
      const nono = yield* writeFakeNono(yield* managedNono);
      const state = yield* secrets.configure({ sandbox: true });
      expect(state.sandbox).toMatchObject({
        enabled: true,
        path: yield* fileSystem.realPath(nono),
        managed: true,
        version: "0.80.0",
      });
      expect((yield* secrets.listForProject(projectA)).sandboxed).toBe(true);
      const result = yield* runAs(secrets, {
        aliases: ["PROD_DB"],
        command: 'case "$HOME" in "$TMPDIR"/*) echo "private home";; esac',
      });
      expect(result.stdout).toBe("private home\n");
      expect((yield* readFakeNonoRun(nono)).env.PROD_DB).toBe(PROD_DB_PASSWORD);
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("runs nothing while on and nono stops working, and spends no secretRef", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { secrets } = yield* connect();
      yield* grantProdDb(secrets);
      const nono = yield* writeFakeNono(yield* managedNono);
      yield* secrets.configure({ sandbox: true });
      yield* fileSystem.remove(nono);
      const consumed = yield* Ref.make(false);
      const error = yield* runAs(secrets, {
        aliases: ["PROD_DB"],
        command: "echo ran",
        oneOff: { names: ["EXTRA"], consume: Ref.set(consumed, true).pipe(Effect.as(["value"])) },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "sandbox_unavailable" });
      expect(yield* Ref.get(consumed)).toBe(false);
      yield* secrets.configure({ sandbox: false });
      expect((yield* runAs(secrets, { aliases: ["PROD_DB"], command: "echo ran" })).stdout).toBe(
        "ran\n",
      );
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("refuses names the sandbox would drop, before spending a secretRef", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* grantProdDb(secrets);
      yield* writeFakeNono(yield* managedNono);
      yield* secrets.configure({ sandbox: true });
      const consumed = yield* Ref.make(0);
      const consume = Ref.update(consumed, (count) => count + 1).pipe(Effect.as(["py-path"]));
      // nono removes these from the environment, so the command would run without them.
      expect(
        yield* runAs(secrets, {
          aliases: ["PROD_DB"],
          command: "true",
          oneOff: { names: ["PYTHONPATH"], consume },
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "sandbox_dropped_name", alias: "PYTHONPATH" });
      expect(yield* Ref.get(consumed)).toBe(0);
      yield* secrets.updateItem({ itemId: PROD_DB_ITEM_ID, alias: "OP_SERVICE_ACCOUNT_TOKEN" });
      expect(
        yield* runAs(secrets, { aliases: ["OP_SERVICE_ACCOUNT_TOKEN"], command: "true" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "sandbox_dropped_name", alias: "OP_SERVICE_ACCOUNT_TOKEN" });
      // Outside the sandbox the same names reach the command.
      yield* secrets.configure({ sandbox: false });
      const result = yield* runAs(secrets, {
        aliases: ["OP_SERVICE_ACCOUNT_TOKEN"],
        command: 'test -n "$OP_SERVICE_ACCOUNT_TOKEN" && test -n "$PYTHONPATH" && echo both',
        oneOff: { names: ["PYTHONPATH"], consume },
      });
      expect(result.stdout).toBe("both\n");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("installs the pinned nono from a verified archive", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretsService.SecretsService;
      expect((yield* secrets.getState).sandbox).toMatchObject({
        path: null,
        installVersion: Nono.MANAGED_NONO_VERSION,
      });
      const state = yield* secrets.installSandbox;
      expect(state.sandbox).toMatchObject({
        enabled: false,
        managed: true,
        version: Nono.MANAGED_NONO_VERSION,
      });
      expect((yield* secrets.configure({ sandbox: true })).sandbox.enabled).toBe(true);
    }).pipe(
      Effect.provide(layerInstallingNono(fakeNonoArchive)),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("installs nothing from an archive that fails its checksum", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretsService.SecretsService;
      const fileSystem = yield* FileSystem.FileSystem;
      expect(yield* secrets.installSandbox.pipe(Effect.flip)).toMatchObject({
        reason: "sandbox_install_failed",
      });
      expect(yield* fileSystem.exists(yield* managedNono)).toBe(false);
    }).pipe(
      Effect.provide(layerInstallingNono(fakeNonoArchive, { sha256: "0".repeat(64) })),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("installs nothing from an archive holding more than nono", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretsService.SecretsService;
      const fileSystem = yield* FileSystem.FileSystem;
      expect(yield* secrets.installSandbox.pipe(Effect.flip)).toMatchObject({
        reason: "sandbox_install_failed",
      });
      expect(yield* fileSystem.exists(yield* managedNono)).toBe(false);
    }).pipe(
      Effect.provide(
        layerInstallingNono(
          makeTarGz([
            { name: "nono", data: new TextEncoder().encode(FAKE_NONO_SCRIPT) },
            { name: "install.sh", data: new TextEncoder().encode("#!/bin/sh\n") },
          ]),
        ),
      ),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("installs nothing when the binary isn't the pinned version", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretsService.SecretsService;
      const fileSystem = yield* FileSystem.FileSystem;
      expect(yield* secrets.installSandbox.pipe(Effect.flip)).toMatchObject({
        reason: "sandbox_install_failed",
      });
      expect(yield* fileSystem.exists(yield* managedNono)).toBe(false);
    }).pipe(
      Effect.provide(layerInstallingNono(fakeNonoArchive, { version: "9.9.9" })),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );
});

describe("saving secrets", () => {
  const fromRef = (value: string) => ({ _tag: "Ref" as const, consume: Effect.succeed(value) });
  const fromCommand = (command: string, aliases: ReadonlyArray<string> = []) => ({
    _tag: "Command" as const,
    command,
    aliases,
    timeout: Duration.seconds(30),
  });

  const saveAs = (
    secrets: SecretsService.SecretsService["Service"],
    input: Partial<SecretsService.SaveSecretInput<OrchestratorMcpFailure>> &
      Pick<SecretsService.SaveSecretInput<OrchestratorMcpFailure>, "source">,
  ) =>
    secrets.saveSecret({
      projectId: projectA,
      cwd: process.cwd(),
      alias: "NEW_TOKEN",
      name: "New token",
      kind: "login",
      username: null,
      authorize: Effect.void,
      stillLive: Effect.succeed(true),
      ...input,
    });

  const allowSaving = Effect.fn("allowSaving")(function* (
    secrets: SecretsService.SecretsService["Service"],
  ) {
    yield* secrets.setCollections({ collectionIds: [INFRA_COLLECTION_ID] });
    return yield* secrets.configure({ saveCollectionId: INFRA_COLLECTION_ID });
  });

  it.live("saves a requested value as a login granted to the project", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory } = yield* connect();
      expect((yield* allowSaving(secrets)).saveCollectionId).toBe(INFRA_COLLECTION_ID);
      const value = "nT0k3n-Zx9-Qw8-Er7";
      const result = yield* saveAs(secrets, { username: "svc", source: fromRef(value) });
      expect(result).toEqual({
        saved: true,
        alias: "NEW_TOKEN",
        collection: "Acme / Infra",
        exitCode: null,
        timedOut: false,
        stderr: "",
      });
      const saved = (yield* secrets.getState).items.find((item) => item.alias === "NEW_TOKEN");
      expect(saved).toMatchObject({ name: "New token", kind: "login", username: "svc" });
      expect(saved?.grant).toEqual([projectA]);
      const stored = (yield* readFakeVault(dataDirectory)).items.find(
        (item) => item.name === "New token",
      );
      expect(stored?.login?.password).toBe(value);
      const run = yield* runAs(secrets, {
        aliases: ["NEW_TOKEN"],
        command: `test "$NEW_TOKEN" = '${value}' && echo match`,
      });
      expect(run.stdout).toBe("match\n");
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("saves a command's output as a note without returning it", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory } = yield* connect();
      yield* allowSaving(secrets);
      const value = "gEn-Val-Zx8Cv7Bn6Mq5";
      const result = yield* saveAs(secrets, {
        alias: "GENERATED",
        name: "Generated key",
        kind: "note",
        source: fromCommand(`printf '%s\\n' '${value}'; echo "made ${value}" >&2`),
      });
      expect(result).toMatchObject({ saved: true, alias: "GENERATED", exitCode: 0 });
      expect(result.stderr).toBe("made [redacted:GENERATED]\n");
      const stored = (yield* readFakeVault(dataDirectory)).items.find(
        (item) => item.name === "Generated key",
      );
      expect(stored?.notes).toBe(value);
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("saves nothing when the command fails, and shows why", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory } = yield* connect();
      yield* allowSaving(secrets);
      const itemsBefore = (yield* readFakeVault(dataDirectory)).items.length;
      const result = yield* saveAs(secrets, {
        source: fromCommand("echo partial; echo oops >&2; exit 3"),
      });
      expect(result).toEqual({
        saved: false,
        alias: null,
        collection: null,
        exitCode: 3,
        timedOut: false,
        stderr: "oops\n",
      });
      expect((yield* readFakeVault(dataDirectory)).items.length).toBe(itemsBefore);
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("filters a minted value from stderr when the command fails afterwards", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory } = yield* connect();
      yield* allowSaving(secrets);
      const itemsBefore = (yield* readFakeVault(dataDirectory)).items.length;
      const result = yield* saveAs(secrets, {
        source: fromCommand(
          `v='gEn-Val-Zx8Cv7Bn6Mq5'; echo "$v"; echo "minted $v, then failed" >&2; exit 1`,
        ),
      });
      expect(result).toMatchObject({ saved: false, exitCode: 1 });
      expect(result.stderr).toBe("minted [redacted:NEW_TOKEN], then failed\n");
      expect((yield* readFakeVault(dataDirectory)).items.length).toBe(itemsBefore);
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("saves nothing into a vault that was logged out while the value was made", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory, vault } = yield* connect();
      yield* allowSaving(secrets);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gate = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-save-gate-" });
      const go = path.join(gate, "go");
      // Admitted at once, and it can't finish before the test creates the file.
      const saving = yield* saveAs(secrets, {
        source: fromCommand(
          `while [ ! -e '${go}' ]; do sleep 0.05; done; echo 'gEn-Val-Zx8Cv7Bn6Mq5'`,
        ),
      }).pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* secrets.logout;
      yield* secrets.connect({
        clientId: vault.clientId,
        clientSecret: vault.clientSecret,
        password: vault.password,
      });
      yield* secrets.setCollections({ collectionIds: [BILLING_COLLECTION_ID] });
      yield* secrets.configure({ saveCollectionId: BILLING_COLLECTION_ID });
      const itemsBefore = (yield* readFakeVault(dataDirectory)).items.length;
      yield* fileSystem.writeFileString(go, "");
      const outcome = yield* Fiber.join(saving);
      assert(outcome._tag === "Failure");
      expect((yield* readFakeVault(dataDirectory)).items.length).toBe(itemsBefore);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("rechecks the caller after waiting on other vault work, before using its answer", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory } = yield* connect();
      yield* allowSaving(secrets);
      const pause = yield* CliPause;
      const stopped = yield* Ref.make(false);
      const consumed = yield* Ref.make(0);
      yield* pause.arm("listItems");
      const syncing = yield* secrets.sync.pipe(Effect.forkChild);
      yield* pause.reached;
      const saving = yield* saveAs(secrets, {
        source: {
          _tag: "Ref",
          consume: Ref.update(consumed, (count) => count + 1).pipe(Effect.as("nT0k3n-Zx9-Qw8-Er7")),
        },
        authorize: Effect.flatMap(Ref.get(stopped), (isStopped) =>
          isStopped
            ? Effect.fail(
                new OrchestratorMcpFailure({ code: "parent_not_active", message: "run ended" }),
              )
            : Effect.void,
        ),
      }).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      // The caller's run ends while its save waits behind the sync.
      yield* Ref.set(stopped, true);
      yield* pause.release;
      yield* Fiber.join(syncing);
      expect(yield* Fiber.join(saving)).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(consumed)).toBe(0);
      expect(
        (yield* readFakeVault(dataDirectory)).items.some((item) => item.name === "New token"),
      ).toBe(false);
    }).pipe(
      Effect.provide(layerPausable),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("won't save for a run that ended while it waited, though a newer run is live", () =>
    Effect.gen(function* () {
      const { secrets, dataDirectory } = yield* connect();
      yield* allowSaving(secrets);
      const pause = yield* CliPause;
      const runEnded = yield* Ref.make(false);
      const consumed = yield* Ref.make(0);
      yield* pause.arm("listItems");
      const syncing = yield* secrets.sync.pipe(Effect.forkChild);
      yield* pause.reached;
      const saving = yield* saveAs(secrets, {
        source: {
          _tag: "Ref",
          consume: Ref.update(consumed, (count) => count + 1).pipe(Effect.as("nT0k3n-Zx9-Qw8-Er7")),
        },
        // A newer run keeps the thread live, so authorize passes; only the asking run ended.
        stillLive: Effect.map(Ref.get(runEnded), (ended) => !ended),
      }).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* Ref.set(runEnded, true);
      yield* pause.release;
      yield* Fiber.join(syncing);
      expect(yield* Fiber.join(saving)).toMatchObject({ reason: "run_stopped" });
      expect(yield* Ref.get(consumed)).toBe(0);
      expect(
        (yield* readFakeVault(dataDirectory)).items.some((item) => item.name === "New token"),
      ).toBe(false);
    }).pipe(
      Effect.provide(layerPausable),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("refuses until the user chooses where secrets are saved", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      const error = yield* saveAs(secrets, { source: fromRef("nT0k3n-Zx9-Qw8-Er7") }).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "save_not_configured" });
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("refuses an alias another secret uses, and a multi-line login", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* allowSaving(secrets);
      const taken = yield* saveAs(secrets, {
        alias: "PROD_DB",
        source: fromRef("nT0k3n-Zx9-Qw8-Er7"),
      }).pipe(Effect.flip);
      expect(taken).toMatchObject({ reason: "alias_taken" });
      const multiline = yield* saveAs(secrets, { source: fromRef("line one\nline two") }).pipe(
        Effect.flip,
      );
      expect(multiline).toMatchObject({ reason: "value_multiline" });
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("stops saving when its collection is no longer synced", () =>
    Effect.gen(function* () {
      const { secrets } = yield* connect();
      yield* allowSaving(secrets);
      const state = yield* secrets.setCollections({ collectionIds: [BILLING_COLLECTION_ID] });
      expect(state.saveCollectionId).toBeNull();
      const error = yield* saveAs(secrets, { source: fromRef("nT0k3n-Zx9-Qw8-Er7") }).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "save_not_configured" });
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );

  it.live("reports a collection Bitwarden won't let the account add to", () =>
    Effect.gen(function* () {
      const vault = defaultVault();
      const { secrets } = yield* connect({
        ...vault,
        collections: vault.collections.map((collection) =>
          collection.id === INFRA_COLLECTION_ID ? { ...collection, readOnly: true } : collection,
        ),
      });
      yield* allowSaving(secrets);
      const error = yield* saveAs(secrets, { source: fromRef("nT0k3n-Zx9-Qw8-Er7") }).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "save_failed" });
    }).pipe(
      Effect.provide(layerReal),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
    ),
  );
});

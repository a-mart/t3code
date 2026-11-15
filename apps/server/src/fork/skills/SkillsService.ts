// Each host pulls the fleet repo itself: no leader and no SSH, so hosts behind
// T3 Connect and the Windows PC work, and a host that was off catches up.
import {
  ForkSkillsError,
  forkSkillsHostNameFromLabel,
  isValidForkSkillName,
  type ForkSkillsConfigureInput,
  type ForkSkillsFile,
  type ForkSkillsInstructions,
  type ForkSkillsLibrarySkill,
  type ForkSkillsReadResult,
  type ForkSkillsState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BUILTIN_SKILL_MARKDOWN, BUILTIN_SKILL_NAME } from "./builtinSkill.ts";
import { EMPTY_OWNED, OwnedFile, reconcile, type ReconcileResult } from "./reconcile.ts";
import { parseSkillManifest } from "./skillManifest.ts";

const SYNC_INTERVAL = "15 minutes";
const GIT_TIMEOUT = "2 minutes";
const MAX_SKILL_FILES = 64;
const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_READ_FILE_BYTES = 256 * 1024;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_URL = /^(?:https:\/\/|ssh:\/\/|git@[^:]+:|file:\/\/)\S+$/;

// Common token shapes. A skill names a secret's `secure_bash` alias instead.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

const SettingsFile = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  hostName: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
});
type SettingsFile = typeof SettingsFile.Type;
const EMPTY_SETTINGS: SettingsFile = {
  version: 1,
  repository: null,
  branch: null,
  hostName: null,
  tags: [],
};

const SettingsJson = Schema.fromJsonString(SettingsFile);
const OwnedJson = Schema.fromJsonString(OwnedFile);
const encodeSettings = Schema.encodeEffect(SettingsJson);
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeOwned = Schema.encodeEffect(OwnedJson);
const decodeOwned = Schema.decodeEffect(OwnedJson);

const repositoryUrl = (repository: string) =>
  GITHUB_SHORTHAND.test(repository) ? `https://github.com/${repository}.git` : repository;

export const findSecret = (text: string) => SECRET_PATTERNS.some((pattern) => pattern.test(text));

export interface SaveSkillInput {
  readonly name: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly threadId?: string | undefined;
}

interface SyncStatus {
  readonly commit: string | null;
  readonly commitSubject: string | null;
  readonly lastSyncedAt: string | null;
  readonly syncError: string | null;
  readonly dirty: boolean;
  readonly skills: ReadonlyArray<ForkSkillsLibrarySkill>;
  readonly instructions: ForkSkillsInstructions;
}

export class SkillsService extends Context.Service<
  SkillsService,
  {
    readonly getState: Effect.Effect<ForkSkillsState>;
    readonly configure: (
      input: ForkSkillsConfigureInput,
    ) => Effect.Effect<ForkSkillsState, ForkSkillsError>;
    readonly sync: Effect.Effect<ForkSkillsState>;
    readonly saveGlobal: (input: SaveSkillInput) => Effect.Effect<ForkSkillsState, ForkSkillsError>;
    readonly deleteGlobal: (name: string) => Effect.Effect<ForkSkillsState, ForkSkillsError>;
    readonly read: (path: string) => Effect.Effect<ForkSkillsReadResult, ForkSkillsError>;
  }
>()("t3/fork/skills/SkillsService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;

  const base = path.join(config.stateDir, "fork", "skills");
  const settingsPath = path.join(base, "settings.json");
  const ownedPath = path.join(base, "owned.json");
  const libraryDir = path.join(base, "library");
  const builtinDir = path.join(base, "builtin");
  const lock = yield* Semaphore.make(1);
  const status = yield* Ref.make<SyncStatus>({
    commit: null,
    commitSubject: null,
    lastSyncedAt: null,
    syncError: null,
    dirty: false,
    skills: [],
    instructions: { content: null, sources: [], files: [] },
  });

  const defaultHostName = forkSkillsHostNameFromLabel((yield* environment.getDescriptor).label);

  const writeAtomic = Effect.fn("SkillsService.writeAtomic")(function* (
    filePath: string,
    text: string,
  ) {
    yield* fs.makeDirectory(base, { recursive: true });
    const temporary = `${filePath}.${yield* Clock.currentTimeMillis}.tmp`;
    yield* fs.writeFileString(temporary, text);
    yield* fs.rename(temporary, filePath);
  });
  const saveSettings = (settings: SettingsFile) =>
    encodeSettings(settings).pipe(
      Effect.flatMap((text) => writeAtomic(settingsPath, text)),
      Effect.mapError(() => new ForkSkillsError({ reason: "persist_failed" })),
    );
  const loadOwned = fs.readFileString(ownedPath).pipe(
    Effect.flatMap(decodeOwned),
    Effect.orElseSucceed(() => EMPTY_OWNED),
  );
  const saveOwned = (owned: OwnedFile) =>
    encodeOwned(owned).pipe(
      Effect.flatMap((text) => writeAtomic(ownedPath, text)),
      Effect.ignore,
    );

  const loadSettings = fs.readFileString(settingsPath).pipe(
    Effect.flatMap(decodeSettings),
    Effect.orElseSucceed(() => EMPTY_SETTINGS),
  );
  const hostNameOf = (settings: SettingsFile) => settings.hostName ?? defaultHostName;

  const gitFailure = (output: string) =>
    new ForkSkillsError({
      reason: "git_failed",
      detail: output.trim().split("\n").slice(-3).join(" ").slice(0, 500) || undefined,
    });
  const git = (args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}) =>
    runner
      .run({
        command: "git",
        args,
        cwd: libraryDir,
        spawnCwd: args[0] === "clone" ? base : libraryDir,
        timeout: GIT_TIMEOUT,
        env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...extraEnv },
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError((error) => gitFailure(error.message)),
        Effect.flatMap((output) =>
          Number(output.code) === 0 && !output.timedOut
            ? Effect.succeed(output.stdout.trim())
            : Effect.fail(gitFailure(output.stderr || output.stdout)),
        ),
      );

  const hostDirectories = Effect.gen(function* () {
    const claudeDirs = new Set([
      path.resolve(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude")),
    ]);
    if (Option.isSome(serverSettings)) {
      const settings = yield* serverSettings.value.getSettings.pipe(Effect.option);
      for (const instance of Object.values(
        Option.getOrUndefined(settings)?.providerInstances ?? {},
      )) {
        const homePath = (instance.config as { homePath?: unknown } | undefined)?.homePath;
        if (instance.driver === "claudeAgent" && typeof homePath === "string" && homePath.trim()) {
          claudeDirs.add(path.resolve(homePath.trim().replace(/^~(?=$|[\\/])/, home)));
        }
      }
    }
    return {
      home,
      claudeDirs: [...claudeDirs],
      codexHome: path.resolve(env.CODEX_HOME?.trim() || path.join(home, ".codex")),
      join: path.join,
    };
  });

  const cloneExists = fs
    .exists(path.join(libraryDir, ".git"))
    .pipe(Effect.orElseSucceed(() => false));

  const runReconcile = Effect.gen(function* () {
    const settings = yield* loadSettings;
    const owned = yield* loadOwned;
    const result: ReconcileResult = yield* reconcile({
      libraryDir: settings.repository !== null && (yield* cloneExists) ? libraryDir : null,
      builtinDir,
      hostName: hostNameOf(settings),
      tags: settings.tags,
      dirs: yield* hostDirectories,
      platform,
      pathEnv: env.PATH ?? env.Path ?? "",
      pathExt: env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      owned,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    yield* saveOwned(result.owned);
    yield* Ref.update(status, (current) => ({
      ...current,
      skills: result.skills,
      instructions: result.instructions,
    }));
    if (result.linksChanged && Option.isSome(providers)) {
      yield* Effect.forkDetach(providers.value.refresh().pipe(Effect.ignore));
    }
  });

  const readCommit = git(["log", "-1", "--format=%h%x1f%s"]).pipe(
    Effect.map((line) => {
      const [commit, subject] = line.split("\x1f");
      return { commit: commit || null, commitSubject: subject ?? null };
    }),
    Effect.orElseSucceed(() => ({ commit: null, commitSubject: null })),
  );

  const isDirty = Effect.gen(function* () {
    const changes = yield* git(["status", "--porcelain"]);
    const ahead = yield* git(["rev-list", "--count", "@{u}..HEAD"]).pipe(
      Effect.orElseSucceed(() => "0"),
    );
    return changes.length > 0 || ahead !== "0";
  });

  /** Clone or fast-forward. Failures land in the state, so a bad network never breaks the server. */
  const pull = Effect.gen(function* () {
    const settings = yield* loadSettings;
    if (settings.repository === null) {
      yield* Ref.update(status, (current) => ({
        ...current,
        commit: null,
        commitSubject: null,
        syncError: null,
        dirty: false,
      }));
      return;
    }
    const url = repositoryUrl(settings.repository);
    const attempt = Effect.gen(function* () {
      if (yield* cloneExists) {
        const remote = yield* git(["remote", "get-url", "origin"]).pipe(
          Effect.orElseSucceed(() => ""),
        );
        if (remote !== url) yield* fs.remove(libraryDir, { recursive: true }).pipe(Effect.ignore);
      }
      if (!(yield* cloneExists)) {
        yield* fs.remove(libraryDir, { recursive: true }).pipe(Effect.ignore);
        yield* fs.makeDirectory(base, { recursive: true }).pipe(Effect.ignore);
        yield* git([
          "clone",
          ...(settings.branch ? ["--branch", settings.branch] : []),
          url,
          libraryDir,
        ]);
        return false;
      }
      if (yield* isDirty) return true;
      yield* git(["pull", "--ff-only", "--quiet"]);
      return false;
    });
    const outcome = yield* attempt.pipe(Effect.result);
    const now = DateTime.formatIso(yield* DateTime.now);
    const commit = yield* readCommit;
    yield* Ref.update(status, (current) =>
      outcome._tag === "Success"
        ? {
            ...current,
            ...commit,
            dirty: outcome.success,
            lastSyncedAt: outcome.success ? current.lastSyncedAt : now,
            syncError: outcome.success
              ? "The clone has local changes, so it isn't pulling. Commit or discard them."
              : null,
          }
        : { ...current, ...commit, syncError: outcome.failure.message },
    );
  });

  const getState: Effect.Effect<ForkSkillsState> = Effect.gen(function* () {
    const settings = yield* loadSettings;
    const current = yield* Ref.get(status);
    return {
      repository: settings.repository,
      branch: settings.branch,
      hostName: hostNameOf(settings),
      defaultHostName,
      tags: settings.tags,
      ...current,
    };
  });

  const sync = lock
    .withPermits(1)(pull.pipe(Effect.andThen(runReconcile)))
    .pipe(Effect.andThen(getState), Effect.withSpan("SkillsService.sync"));

  const configure = Effect.fn("SkillsService.configure")(function* (
    input: ForkSkillsConfigureInput,
  ) {
    const current = yield* loadSettings;
    const repository =
      input.repository === undefined ? current.repository : input.repository?.trim() || null;
    if (repository !== null && !GITHUB_SHORTHAND.test(repository) && !GIT_URL.test(repository)) {
      return yield* new ForkSkillsError({ reason: "invalid_repository" });
    }
    const hostName =
      input.hostName === undefined
        ? current.hostName
        : input.hostName?.trim().toLowerCase() || null;
    if (hostName !== null && !isValidForkSkillName(hostName)) {
      return yield* new ForkSkillsError({ reason: "invalid_host_name" });
    }
    const tags =
      input.tags === undefined
        ? current.tags
        : [...new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
    if (!tags.every((tag) => TAG_PATTERN.test(tag))) {
      return yield* new ForkSkillsError({ reason: "invalid_tag" });
    }
    const next: SettingsFile = {
      version: 1,
      repository,
      branch: input.branch === undefined ? current.branch : input.branch?.trim() || null,
      hostName,
      tags,
    };
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* saveSettings(next);
        if (next.repository !== current.repository || next.branch !== current.branch) {
          yield* fs.remove(libraryDir, { recursive: true }).pipe(Effect.ignore);
        }
      }),
    );
    return yield* sync;
  });

  const commitAndPush = Effect.fn("SkillsService.commitAndPush")(function* (
    message: ReadonlyArray<string>,
  ) {
    const identity = yield* git(["config", "user.email"]).pipe(Effect.orElseSucceed(() => ""));
    const hostName = hostNameOf(yield* loadSettings);
    const authorEnv: Record<string, string> =
      identity.length > 0
        ? {}
        : {
            GIT_AUTHOR_NAME: `T3 Code (${hostName})`,
            GIT_AUTHOR_EMAIL: `t3code@${hostName}.invalid`,
            GIT_COMMITTER_NAME: `T3 Code (${hostName})`,
            GIT_COMMITTER_EMAIL: `t3code@${hostName}.invalid`,
          };
    yield* git(["commit", "--quiet", ...message.flatMap((line) => ["-m", line])], authorEnv);
    const pushed = yield* git(["push", "--quiet"]).pipe(
      Effect.catch(() =>
        git(["pull", "--rebase", "--quiet"], authorEnv).pipe(
          Effect.andThen(git(["push", "--quiet"])),
        ),
      ),
      Effect.result,
    );
    if (pushed._tag === "Failure") {
      // Leave the clone clean, matching the remote, so later pulls keep working.
      yield* git(["rebase", "--abort"]).pipe(Effect.ignore);
      yield* git(["reset", "--hard", "--quiet", "@{u}"]).pipe(Effect.ignore);
      return yield* pushed.failure;
    }
  });

  /** Pulls first, so a save lands on the newest commit. */
  const prepareClone = Effect.gen(function* () {
    const settings = yield* loadSettings;
    if (settings.repository === null)
      return yield* new ForkSkillsError({ reason: "not_configured" });
    yield* pull;
    if (!(yield* cloneExists)) {
      return yield* new ForkSkillsError({
        reason: "git_failed",
        detail: (yield* Ref.get(status)).syncError ?? undefined,
      });
    }
    if (yield* isDirty) return yield* new ForkSkillsError({ reason: "dirty" });
    return hostNameOf(settings);
  });

  const validateFiles = Effect.fn("SkillsService.validateFiles")(function* (input: SaveSkillInput) {
    if (!isValidForkSkillName(input.name)) {
      return yield* new ForkSkillsError({ reason: "invalid_name" });
    }
    if (input.name === BUILTIN_SKILL_NAME) {
      return yield* new ForkSkillsError({ reason: "reserved_name" });
    }
    const bytes = input.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    if (input.files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
      return yield* new ForkSkillsError({ reason: "too_large" });
    }
    const seen = new Set<string>();
    for (const file of input.files) {
      const segments = file.path.split("/");
      const valid =
        file.path.length > 0 &&
        !file.path.includes("\\") &&
        !file.path.includes("\0") &&
        segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
        segments[0] !== ".git";
      if (!valid || seen.has(file.path)) {
        return yield* new ForkSkillsError({ reason: "invalid_path", detail: file.path });
      }
      seen.add(file.path);
      if (findSecret(file.content)) {
        return yield* new ForkSkillsError({ reason: "secret_detected", detail: file.path });
      }
    }
    const skillFile = input.files.find((file) => file.path === "SKILL.md");
    const parsed = skillFile ? parseSkillManifest(skillFile.content, input.name) : null;
    if (parsed === null || !parsed.ok) {
      return yield* new ForkSkillsError({
        reason: "invalid_skill",
        detail: parsed?.ok === false ? parsed.reason : undefined,
      });
    }
  });

  const saveGlobal = Effect.fn("SkillsService.saveGlobal")(function* (input: SaveSkillInput) {
    yield* validateFiles(input);
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const hostName = yield* prepareClone;
        const relative = `skills/${input.name}`;
        const dir = path.join(libraryDir, "skills", input.name);
        const existed = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
        yield* Effect.gen(function* () {
          yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
          for (const file of input.files) {
            const target = path.join(dir, ...file.path.split("/"));
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.writeFileString(target, file.content);
          }
        }).pipe(Effect.mapError(() => new ForkSkillsError({ reason: "persist_failed" })));
        yield* git(["add", "--all", "--", relative]);
        const staged = yield* git(["diff", "--cached", "--name-only"]);
        if (staged.length === 0) return;
        yield* commitAndPush([
          `${existed ? "Update" : "Add"} skill ${input.name}`,
          input.threadId
            ? `Saved by an agent on ${hostName} in T3 thread ${input.threadId}.`
            : `Saved on ${hostName}.`,
        ]).pipe(
          Effect.tapError(() => git(["reset", "--hard", "--quiet", "@{u}"]).pipe(Effect.ignore)),
        );
        yield* pull;
      }),
    );
    yield* lock.withPermits(1)(runReconcile);
    return yield* getState;
  });

  const deleteGlobal = Effect.fn("SkillsService.deleteGlobal")(function* (name: string) {
    if (!isValidForkSkillName(name)) return yield* new ForkSkillsError({ reason: "invalid_name" });
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const hostName = yield* prepareClone;
        const dir = path.join(libraryDir, "skills", name);
        if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* new ForkSkillsError({ reason: "not_found" });
        }
        yield* git(["rm", "-r", "--quiet", "--", `skills/${name}`]);
        yield* commitAndPush([`Remove skill ${name}`, `Removed in Settings on ${hostName}.`]);
        yield* pull;
      }),
    );
    yield* lock.withPermits(1)(runReconcile);
    return yield* getState;
  });

  /** Skill folders T3 may show: its own, and those a provider on this host loads. */
  const readableRoots = Effect.gen(function* () {
    const folders = new Set<string>();
    if (Option.isSome(providers)) {
      for (const provider of yield* providers.value.getProviders) {
        const skills = [
          ...(provider.skills ?? []),
          ...(provider.workspaceSnapshots ?? []).flatMap((snapshot) => snapshot.skills ?? []),
        ];
        for (const skill of skills) {
          folders.add(
            path.resolve(
              path.basename(skill.path) === "SKILL.md" ? path.dirname(skill.path) : skill.path,
            ),
          );
        }
      }
    }
    return folders;
  });

  const read = Effect.fn("SkillsService.read")(function* (requested: string) {
    const resolved = path.resolve(
      path.basename(requested) === "SKILL.md" ? path.dirname(requested) : requested,
    );
    // Through links too: a provider folder's entry for a global skill is a link into the clone.
    const real = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
    const resolvedReal = yield* real(resolved);
    const inside = (root: string) => {
      const relative = path.relative(root, resolvedReal);
      return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
    };
    const allowed =
      inside(yield* real(path.join(libraryDir, "skills"))) ||
      inside(yield* real(builtinDir)) ||
      (yield* readableRoots).has(resolved);
    if (!allowed) return yield* new ForkSkillsError({ reason: "read_denied" });
    const files: Array<ForkSkillsFile> = [];
    const walk: (dir: string, prefix: string) => Effect.Effect<void> = Effect.fn(
      "SkillsService.readTree",
    )(function* (dir: string, prefix: string) {
      const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries.toSorted()) {
        if (files.length >= MAX_SKILL_FILES || entry === ".git") continue;
        const full = path.join(dir, entry);
        const relative = prefix ? `${prefix}/${entry}` : entry;
        const info = yield* fs.stat(full).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        if (info.value.type === "Directory") {
          yield* walk(full, relative);
          continue;
        }
        const size = Number(info.value.size);
        const bytes =
          size <= MAX_READ_FILE_BYTES
            ? yield* fs.readFile(full).pipe(Effect.option)
            : Option.none();
        const text =
          Option.isSome(bytes) && !bytes.value.includes(0)
            ? new TextDecoder("utf-8", { fatal: false }).decode(bytes.value)
            : null;
        files.push({ path: relative, content: text, bytes: size });
      }
    });
    yield* walk(resolved, "");
    if (!files.some((file) => file.path === "SKILL.md")) {
      return yield* new ForkSkillsError({ reason: "read_denied" });
    }
    files.sort((left, right) =>
      left.path === "SKILL.md"
        ? -1
        : right.path === "SKILL.md"
          ? 1
          : left.path.localeCompare(right.path),
    );
    return { path: resolved, files } satisfies ForkSkillsReadResult;
  });

  yield* Effect.gen(function* () {
    const dir = path.join(builtinDir, BUILTIN_SKILL_NAME);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "SKILL.md"), BUILTIN_SKILL_MARKDOWN);
  }).pipe(Effect.catch((error) => Effect.logWarning("Couldn't write T3's built-in skill", error)));

  yield* sync.pipe(
    Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
    Effect.catchCause((cause) => Effect.logWarning("Skills sync stopped", cause)),
    Effect.forkScoped,
  );

  return SkillsService.of({ getState, configure, sync, saveGlobal, deleteGlobal, read });
});

export const layer = Layer.effect(SkillsService, make).pipe(Layer.provide(ProcessRunner.layer));

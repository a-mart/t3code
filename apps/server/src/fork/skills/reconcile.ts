// @effect-diagnostics nodeBuiltinImport:off - Windows junctions need fs.symlink's type argument, and hashes are synchronous.
import type {
  ForkSkillConflict,
  ForkSkillsInstructionFile,
  ForkSkillsInstructions,
  ForkSkillsLibrarySkill,
  ForkSkillSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { hostSkipReason, parseSkillManifest } from "./skillManifest.ts";
import {
  instructionTargets,
  KNOWN_SKILL_PROVIDERS,
  skillRoots,
  type HostSkillDirectories,
} from "./skillTargets.ts";

/** What T3 created on this host, so it only ever changes or removes its own. */
export const OwnedFile = Schema.Struct({
  version: Schema.Literal(1),
  links: Schema.Array(Schema.Struct({ path: Schema.String, target: Schema.String })),
  files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
});
export type OwnedFile = typeof OwnedFile.Type;
export const EMPTY_OWNED: OwnedFile = { version: 1, links: [], files: [] };

export interface ReconcileInput {
  /** The clone, or null when no repository is set up. */
  readonly libraryDir: string | null;
  readonly builtinDir: string;
  readonly hostName: string;
  readonly tags: ReadonlyArray<string>;
  readonly dirs: HostSkillDirectories;
  readonly platform: NodeJS.Platform;
  readonly pathEnv: string;
  readonly pathExt: string;
  readonly owned: OwnedFile;
}

export interface ReconcileResult {
  readonly owned: OwnedFile;
  readonly skills: ReadonlyArray<ForkSkillsLibrarySkill>;
  readonly instructions: ForkSkillsInstructions;
  /** Links were added or removed, so provider skill lists are stale. */
  readonly linksChanged: boolean;
}

const MAX_COMPARE_FILES = 512;
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

interface Candidate {
  readonly folder: string;
  readonly dir: string;
  readonly source: ForkSkillSource;
}

const listSkillFolders = Effect.fnUntraced(function* (root: string, source: ForkSkillSource) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
  const candidates: Array<Candidate> = [];
  for (const folder of entries.toSorted()) {
    if (folder.startsWith(".")) continue;
    const dir = path.join(root, folder);
    const info = yield* fs.stat(dir).pipe(Effect.option);
    if (info._tag === "Some" && info.value.type === "Directory") {
      candidates.push({ folder, dir, source });
    }
  }
  return candidates;
});

const findCommand = Effect.fnUntraced(function* (
  command: string,
  input: Pick<ReconcileInput, "platform" | "pathEnv" | "pathExt">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (command.includes("/") || command.includes("\\")) return false;
  const directories = input.pathEnv.split(input.platform === "win32" ? ";" : ":").filter(Boolean);
  const suffixes =
    input.platform === "win32" ? ["", ...input.pathExt.split(";").filter(Boolean)] : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const info = yield* fs.stat(path.join(directory, command + suffix)).pipe(Effect.option);
      if (info._tag === "Some" && info.value.type === "File") return true;
    }
  }
  return false;
});

/** Relative path → content hash for every file under `dir`, following links; null past the cap. */
const treeHashes = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hashes = new Map<string, string>();
  const walk: (current: string, prefix: string) => Effect.Effect<boolean> = Effect.fn(
    "ForkSkills.hashTree",
  )(function* (current: string, prefix: string) {
    const entries = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const full = path.join(current, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const info = yield* fs.stat(full).pipe(Effect.option);
      if (info._tag === "None") continue;
      if (info.value.type === "Directory") {
        if (!(yield* walk(full, relative))) return false;
      } else {
        if (hashes.size >= MAX_COMPARE_FILES) return false;
        const bytes = yield* fs.readFile(full).pipe(Effect.option);
        if (bytes._tag === "None") return false;
        hashes.set(relative, NodeCrypto.createHash("sha256").update(bytes.value).digest("hex"));
      }
    }
    return true;
  });
  return (yield* walk(dir, "")) ? hashes : null;
});

const sameTree = Effect.fnUntraced(function* (left: string, right: string) {
  const [a, b] = [yield* treeHashes(left), yield* treeHashes(right)];
  if (a === null || b === null || a.size !== b.size) return false;
  for (const [file, hash] of a) if (b.get(file) !== hash) return false;
  return true;
});

class LinkError extends Schema.TaggedError<LinkError>()("LinkError", { cause: Schema.Defect() }) {}

const createLink = (target: string, linkPath: string, platform: NodeJS.Platform) =>
  // Junctions need no admin rights or Developer Mode on Windows.
  Effect.tryPromise({
    try: () => NodeFSP.symlink(target, linkPath, platform === "win32" ? "junction" : "dir"),
    catch: (cause) => new LinkError({ cause }),
  });

const readLinkTarget = (linkPath: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.readlink(linkPath),
    catch: (cause) => new LinkError({ cause }),
  }).pipe(Effect.option);

const samePath = (path: Path.Path, left: string, right: string) =>
  path.resolve(left).replace(/[\\/]+$/, "") === path.resolve(right).replace(/[\\/]+$/, "");

/**
 * Makes this host's skill links and instruction files match the repo. It
 * changes only what `owned` lists, and takes over an existing folder or file
 * only when it's empty or already matches; anything else is a conflict.
 */
export const reconcile = Effect.fn("ForkSkills.reconcile")(function* (input: ReconcileInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const builtins = yield* listSkillFolders(input.builtinDir, "builtin");
  const library =
    input.libraryDir === null
      ? []
      : yield* listSkillFolders(path.join(input.libraryDir, "skills"), "library");
  const builtinNames = new Set(builtins.map((candidate) => candidate.folder));

  const ownedLinks = new Map(input.owned.links.map((link) => [link.path, link.target]));
  const nextLinks = new Map<string, string>();
  const skills: Array<ForkSkillsLibrarySkill> = [];
  let linksChanged = false;

  for (const candidate of [...builtins, ...library]) {
    const base = {
      name: candidate.folder,
      description: "",
      source: candidate.source,
      path: candidate.dir,
      hosts: null,
      providers: null,
      requires: [],
      userInvocationOnly: false,
      links: [],
      conflicts: [],
    } satisfies Partial<ForkSkillsLibrarySkill>;
    if (candidate.source === "library" && builtinNames.has(candidate.folder)) {
      skills.push({
        ...base,
        status: "invalid",
        reason: "That name belongs to T3's built-in skill.",
      });
      continue;
    }
    const text = yield* fs.readFileString(path.join(candidate.dir, "SKILL.md")).pipe(Effect.option);
    if (text._tag === "None") {
      skills.push({ ...base, status: "invalid", reason: "The folder has no SKILL.md." });
      continue;
    }
    const parsed = parseSkillManifest(text.value, candidate.folder);
    if (!parsed.ok) {
      skills.push({ ...base, status: "invalid", reason: parsed.reason });
      continue;
    }
    const manifest = parsed.manifest;
    const described = {
      ...base,
      description: manifest.description,
      hosts: manifest.hosts,
      providers: manifest.providers,
      requires: manifest.requires,
      userInvocationOnly: manifest.userInvocationOnly,
    };
    const hostReason = hostSkipReason(manifest.hosts, input.hostName, input.tags);
    if (hostReason !== null) {
      skills.push({ ...described, status: "skipped", reason: hostReason });
      continue;
    }
    const missing: Array<string> = [];
    for (const command of manifest.requires) {
      if (!(yield* findCommand(command, input))) missing.push(command);
    }
    if (missing.length > 0) {
      skills.push({ ...described, status: "skipped", reason: `Needs ${missing.join(", ")}.` });
      continue;
    }
    const roots = [];
    for (const root of skillRoots(manifest.providers, input.dirs)) {
      if (
        root.whenExists === null ||
        (yield* fs.exists(root.whenExists).pipe(Effect.orElseSucceed(() => false)))
      ) {
        roots.push(root.root);
      }
    }
    if (roots.length === 0) {
      const unknown = (manifest.providers ?? []).filter((p) => !KNOWN_SKILL_PROVIDERS.has(p));
      skills.push({
        ...described,
        status: "skipped",
        reason:
          unknown.length > 0
            ? `T3 has no skill folder for ${unknown.join(", ")}.`
            : "None of its providers are set up on this host.",
      });
      continue;
    }

    const links: Array<string> = [];
    const conflicts: Array<ForkSkillConflict> = [];
    for (const root of roots) {
      const linkPath = path.join(root, candidate.folder);
      const existing = yield* fs.lstat(linkPath).pipe(Effect.option);
      if (existing._tag === "Some") {
        const isLink = existing.value.type === "SymbolicLink";
        const current = isLink ? yield* readLinkTarget(linkPath) : null;
        const pointsHere =
          current !== null &&
          current._tag === "Some" &&
          samePath(path, current.value, candidate.dir);
        if (pointsHere && ownedLinks.has(linkPath)) {
          nextLinks.set(linkPath, candidate.dir);
          links.push(linkPath);
          continue;
        }
        // Ours but stale, or someone else's copy of exactly this skill: replace it.
        const replaceable =
          (isLink && ownedLinks.has(linkPath)) || (yield* sameTree(linkPath, candidate.dir));
        if (!replaceable) {
          conflicts.push({ path: linkPath, reason: "exists" });
          continue;
        }
        yield* fs
          .remove(linkPath, { recursive: !isLink })
          .pipe(Effect.orElseSucceed(() => undefined));
      } else {
        yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.ignore);
      }
      const created = yield* createLink(candidate.dir, linkPath, input.platform).pipe(
        Effect.option,
      );
      if (created._tag === "None") {
        conflicts.push({ path: linkPath, reason: "exists" });
        continue;
      }
      linksChanged = true;
      nextLinks.set(linkPath, candidate.dir);
      links.push(linkPath);
    }
    skills.push({
      ...described,
      status: conflicts.length > 0 && links.length === 0 ? "conflict" : "linked",
      reason: null,
      links,
      conflicts,
    });
  }

  // Remove links T3 made for skills that left the repo or no longer apply here.
  for (const [linkPath, target] of ownedLinks) {
    if (nextLinks.has(linkPath)) continue;
    const info = yield* fs.lstat(linkPath).pipe(Effect.option);
    if (info._tag === "Some" && info.value.type === "SymbolicLink") {
      const current = yield* readLinkTarget(linkPath);
      if (current._tag === "Some" && samePath(path, current.value, target)) {
        yield* fs.remove(linkPath).pipe(Effect.ignore);
        linksChanged = true;
      }
    }
  }

  const instructions = yield* reconcileInstructions(input);
  return {
    owned: {
      version: 1,
      links: [...nextLinks].map(([p, target]) => ({ path: p, target })),
      files: instructions.ownedFiles,
    },
    skills,
    instructions: instructions.state,
    linksChanged,
  } satisfies ReconcileResult;
});

const reconcileInstructions = Effect.fnUntraced(function* (input: ReconcileInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sources: Array<string> = [];
  const parts: Array<string> = [];
  if (input.libraryDir !== null) {
    for (const relative of ["instructions/AGENTS.md", `instructions/hosts/${input.hostName}.md`]) {
      const text = yield* fs
        .readFileString(path.join(input.libraryDir, ...relative.split("/")))
        .pipe(Effect.option);
      if (text._tag === "Some" && text.value.trim().length > 0) {
        sources.push(relative);
        parts.push(text.value.trim());
      }
    }
  }
  // With nothing to write, T3 stops managing the files and leaves them as they are.
  if (parts.length === 0) {
    return {
      ownedFiles: [] as OwnedFile["files"],
      state: { content: null, sources, files: [] } satisfies ForkSkillsInstructions,
    };
  }
  const content = `${parts.join("\n\n")}\n`;
  const contentHash = sha256(content);
  const owned = new Map(input.owned.files.map((file) => [file.path, file.sha256]));
  const ownedFiles: Array<OwnedFile["files"][number]> = [];
  const files: Array<ForkSkillsInstructionFile> = [];
  for (const target of instructionTargets(input.dirs)) {
    if (
      target.whenExists !== null &&
      !(yield* fs.exists(target.whenExists).pipe(Effect.orElseSucceed(() => false)))
    ) {
      continue;
    }
    const current = yield* fs.readFileString(target.root).pipe(Effect.option);
    const currentHash = current._tag === "Some" ? sha256(current.value) : null;
    const ownedHash = owned.get(target.root);
    const conflict: ForkSkillConflict | null =
      currentHash === null || currentHash === contentHash
        ? null
        : ownedHash !== undefined
          ? currentHash === ownedHash
            ? null
            : { path: target.root, reason: "changed" }
          : current._tag === "Some" && current.value.trim().length === 0
            ? null
            : { path: target.root, reason: "exists" };
    if (conflict !== null) {
      files.push({ path: target.root, status: "conflict", conflict });
      // Keep the old hash, so the file is still ours once the local edit is undone.
      if (ownedHash !== undefined) ownedFiles.push({ path: target.root, sha256: ownedHash });
      continue;
    }
    if (currentHash !== contentHash) {
      const wrote = yield* fs.writeFileString(target.root, content).pipe(Effect.option);
      if (wrote._tag === "None") {
        files.push({
          path: target.root,
          status: "conflict",
          conflict: { path: target.root, reason: "exists" },
        });
        continue;
      }
    }
    ownedFiles.push({ path: target.root, sha256: contentHash });
    files.push({ path: target.root, status: "written", conflict: null });
  }
  return { ownedFiles, state: { content, sources, files } satisfies ForkSkillsInstructions };
});

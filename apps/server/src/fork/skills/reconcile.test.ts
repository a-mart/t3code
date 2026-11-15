import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { EMPTY_OWNED, reconcile, type OwnedFile, type ReconcileInput } from "./reconcile.ts";

const skill = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Does ${name} things.\n${extra}---\n\nSteps.\n`;

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-skills-" });
  const home = path.join(root, "home");
  const library = path.join(root, "library");
  const builtin = path.join(root, "builtin");
  const bin = path.join(root, "bin");
  for (const dir of [path.join(home, ".claude"), library, builtin, bin]) {
    yield* fs.makeDirectory(dir, { recursive: true });
  }
  const write = (relative: string, text: string) =>
    Effect.gen(function* () {
      const target = path.join(root, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, text);
    });
  const input = (owned: OwnedFile, overrides: Partial<ReconcileInput> = {}): ReconcileInput => ({
    libraryDir: library,
    builtinDir: builtin,
    hostName: "mac",
    tags: ["gpu"],
    dirs: {
      home,
      claudeDirs: [path.join(home, ".claude")],
      codexHome: path.join(home, ".codex"),
      join: path.join,
    },
    platform: "darwin",
    pathEnv: bin,
    pathExt: "",
    owned,
    ...overrides,
  });
  return { fs, path, root, home, library, write, input };
});

describe("ForkSkills reconcile", () => {
  it.effect("links each applicable skill into the folders providers read, and only there", () =>
    Effect.gen(function* () {
      const { fs, path, home, library, write, input } = yield* setup;
      yield* write("builtin/t3-skills/SKILL.md", skill("t3-skills"));
      yield* write("library/skills/everywhere/SKILL.md", skill("everywhere"));
      yield* write("library/skills/mac-only/SKILL.md", skill("mac-only", "hosts: [mac]\n"));
      yield* write("library/skills/dev1-only/SKILL.md", skill("dev1-only", "hosts: dev1\n"));
      yield* write("library/skills/gpu/SKILL.md", skill("gpu", "hosts: [tag:gpu]\n"));
      yield* write(
        "library/skills/needs-tool/SKILL.md",
        skill("needs-tool", "requires: [present, absent]\n"),
      );
      yield* write(
        "library/skills/has-tool/SKILL.md",
        skill("has-tool", "metadata:\n  requires: present\n"),
      );
      yield* write(
        "library/skills/claude-only/SKILL.md",
        skill("claude-only", "providers: [claude]\n"),
      );
      yield* write(
        "library/skills/opencode/SKILL.md",
        skill("opencode", "providers: [opencode]\n"),
      );
      yield* write("library/skills/broken/SKILL.md", "no frontmatter");
      yield* write("library/skills/t3-skills/SKILL.md", skill("t3-skills"));
      yield* write("bin/present", "#!/bin/sh\n");

      const result = yield* reconcile(input(EMPTY_OWNED));
      const byName = new Map(result.skills.map((entry) => [entry.name + entry.source, entry]));
      const agents = path.join(home, ".agents", "skills");
      const claude = path.join(home, ".claude", "skills");

      expect(byName.get("everywherelibrary")?.links).toEqual([
        path.join(agents, "everywhere"),
        path.join(claude, "everywhere"),
      ]);
      expect(byName.get("t3-skillsbuiltin")?.status).toBe("linked");
      expect(byName.get("t3-skillslibrary")?.status).toBe("invalid");
      expect(byName.get("mac-onlylibrary")?.status).toBe("linked");
      expect(byName.get("dev1-onlylibrary")).toMatchObject({
        status: "skipped",
        reason: "Limited to dev1.",
      });
      expect(byName.get("gpulibrary")?.status).toBe("linked");
      expect(byName.get("needs-toollibrary")).toMatchObject({
        status: "skipped",
        reason: "Needs absent.",
      });
      expect(byName.get("has-toollibrary")?.status).toBe("linked");
      expect(byName.get("claude-onlylibrary")?.links).toEqual([path.join(claude, "claude-only")]);
      expect(byName.get("opencodelibrary")).toMatchObject({
        status: "skipped",
        reason: "T3 has no skill folder for opencode.",
      });
      expect(byName.get("brokenlibrary")?.status).toBe("invalid");
      // No ~/.gemini or ~/.codex on this host, so T3 creates neither.
      expect(yield* fs.exists(path.join(home, ".gemini"))).toBe(false);
      expect(yield* fs.exists(path.join(home, ".codex"))).toBe(false);
      expect(yield* fs.readLink(path.join(agents, "everywhere"))).toBe(
        path.join(library, "skills", "everywhere"),
      );
      expect(result.linksChanged).toBe(true);

      const again = yield* reconcile(input(result.owned));
      expect(again.linksChanged).toBe(false);
      expect(again.owned).toEqual(result.owned);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "adopts an identical copy, reports a different one, and removes only its own links",
    () =>
      Effect.gen(function* () {
        const { fs, path, home, write, input } = yield* setup;
        yield* write("library/skills/same/SKILL.md", skill("same"));
        yield* write("library/skills/different/SKILL.md", skill("different"));
        yield* write("library/skills/leaving/SKILL.md", skill("leaving"));
        yield* write("home/.claude/skills/same/SKILL.md", skill("same"));
        yield* write("home/.claude/skills/different/SKILL.md", "---\nname: different\n---\nmine\n");
        yield* write("home/.claude/skills/unmanaged/SKILL.md", skill("unmanaged"));
        const claude = path.join(home, ".claude", "skills");

        const first = yield* reconcile(input(EMPTY_OWNED));
        const byName = new Map(first.skills.map((entry) => [entry.name, entry]));
        expect((yield* fs.lstat(path.join(claude, "same"))).type).toBe("SymbolicLink");
        expect(byName.get("different")?.conflicts).toEqual([
          { path: path.join(claude, "different"), reason: "exists" },
        ]);
        expect(yield* fs.readFileString(path.join(claude, "different", "SKILL.md"))).toContain(
          "mine",
        );

        yield* fs.remove(path.join(home, "..", "library", "skills", "leaving"), {
          recursive: true,
        });
        const second = yield* reconcile(input(first.owned));
        expect(second.linksChanged).toBe(true);
        expect(yield* fs.exists(path.join(claude, "leaving"))).toBe(false);
        expect(yield* fs.exists(path.join(claude, "unmanaged", "SKILL.md"))).toBe(true);

        // Disconnecting the repo removes every link T3 made.
        const third = yield* reconcile(input(second.owned, { libraryDir: null }));
        expect(third.owned.links).toEqual([]);
        expect(yield* fs.exists(path.join(claude, "same"))).toBe(false);
        expect(yield* fs.exists(path.join(claude, "unmanaged"))).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes shared plus host instructions, adopting only empty or matching files", () =>
    Effect.gen(function* () {
      const { fs, path, home, write, input } = yield* setup;
      yield* fs.makeDirectory(path.join(home, ".codex"), { recursive: true });
      yield* write("library/instructions/AGENTS.md", "# Shared\n");
      yield* write("library/instructions/hosts/mac.md", "# Mac\n");
      yield* write("library/instructions/hosts/dev1.md", "# Dev1\n");
      yield* write("home/.codex/AGENTS.md", "   \n");
      yield* write("home/.claude/CLAUDE.md", "# My own notes\n");
      const claudeFile = path.join(home, ".claude", "CLAUDE.md");
      const codexFile = path.join(home, ".codex", "AGENTS.md");

      const first = yield* reconcile(input(EMPTY_OWNED));
      expect(first.instructions.content).toBe("# Shared\n\n# Mac\n");
      expect(first.instructions.sources).toEqual([
        "instructions/AGENTS.md",
        "instructions/hosts/mac.md",
      ]);
      expect(yield* fs.readFileString(codexFile)).toBe("# Shared\n\n# Mac\n");
      expect(first.instructions.files).toContainEqual({
        path: claudeFile,
        status: "conflict",
        conflict: { path: claudeFile, reason: "exists" },
      });
      expect(yield* fs.readFileString(claudeFile)).toBe("# My own notes\n");

      // Once the host file matches, T3 owns it and keeps it current.
      yield* fs.writeFileString(claudeFile, "# Shared\n\n# Mac\n");
      const adopted = yield* reconcile(input(first.owned));
      expect(adopted.instructions.files.every((file) => file.status === "written")).toBe(true);
      yield* write("library/instructions/AGENTS.md", "# Shared v2\n");
      const second = yield* reconcile(input(adopted.owned));
      expect(yield* fs.readFileString(claudeFile)).toBe("# Shared v2\n\n# Mac\n");
      expect(yield* fs.readFileString(codexFile)).toBe("# Shared v2\n\n# Mac\n");

      // A local edit to a file T3 wrote is never overwritten.
      yield* fs.writeFileString(codexFile, "# Edited here\n");
      yield* write("library/instructions/AGENTS.md", "# Shared v3\n");
      const third = yield* reconcile(input(second.owned));
      expect(yield* fs.readFileString(codexFile)).toBe("# Edited here\n");
      expect(third.instructions.files).toContainEqual({
        path: codexFile,
        status: "conflict",
        conflict: { path: codexFile, reason: "changed" },
      });
      expect(yield* fs.readFileString(claudeFile)).toBe("# Shared v3\n\n# Mac\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - fixtures drive a real bare git repo synchronously.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { SkillsService, findSecret, layer as skillsLayer } from "./SkillsService.ts";

const skill = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Does ${name} things.\n${extra}---\n\nSteps.\n`;

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

/** A bare "fleet" repo, a working clone to push other hosts' changes from, and a fake home. */
const fixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-skills-svc-"));
  const origin = NodePath.join(root, "origin.git");
  const work = NodePath.join(root, "work");
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(NodePath.join(home, ".claude"), { recursive: true });
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", origin, work);
  const writeWork = (relative: string, text: string) => {
    const target = NodePath.join(work, relative);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, text);
  };
  writeWork("skills/hello/SKILL.md", skill("hello"));
  writeWork("instructions/AGENTS.md", "# Shared\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "Seed");
  git(work, "push", "origin", "HEAD:main");
  return { root, origin, work, home, writeWork, url: `file://${origin}` };
};

const layerFor = (home: string) =>
  skillsLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-skills-" }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("skills-test"),
            label: "Adam's MacBook Pro (2)",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        }),
        Layer.succeed(HostProcess.HomeDirectory, home),
        Layer.succeed(HostProcess.Environment, { PATH: process.env.PATH ?? "" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("SkillsService", () => {
  it("recognizes common token shapes", () => {
    expect(findSecret(`token: ghp_${"a".repeat(36)}`)).toBe(true);
    expect(findSecret("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(findSecret("Use the DEPLOY_TOKEN alias with secure_bash.")).toBe(false);
  });

  it.live("clones, links, saves and deletes through the fleet repo", () => {
    const repo = fixture();
    return Effect.gen(function* () {
      const skills = yield* SkillsService;
      const config = yield* ServerConfig.ServerConfig;
      const agents = NodePath.join(repo.home, ".agents", "skills");
      const claude = NodePath.join(repo.home, ".claude", "skills");

      const configured = yield* skills.configure({ repository: repo.url, tags: ["GPU"] });
      expect(configured).toMatchObject({
        hostName: "adams-macbook-pro-2",
        tags: ["gpu"],
        commitSubject: "Seed",
        syncError: null,
        dirty: false,
      });
      expect(configured.skills.find((entry) => entry.name === "hello")?.links).toEqual([
        NodePath.join(agents, "hello"),
        NodePath.join(claude, "hello"),
      ]);
      expect(configured.skills.find((entry) => entry.name === "t3-skills")?.status).toBe("linked");
      expect(NodeFS.readFileSync(NodePath.join(repo.home, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "# Shared\n",
      );

      // Another host pushed meanwhile; the save lands on top of it.
      repo.writeWork("skills/other/SKILL.md", skill("other"));
      git(repo.work, "add", "-A");
      git(repo.work, "commit", "-m", "Add skill other");
      git(repo.work, "push", "origin", "HEAD:main");

      const saved = yield* skills.saveGlobal({
        name: "new-skill",
        files: [
          { path: "SKILL.md", content: skill("new-skill", "hosts: [tag:gpu]\n") },
          { path: "references/notes.md", content: "More.\n" },
        ],
        threadId: "thread-1",
      });
      expect(saved.commitSubject).toBe("Add skill new-skill");
      expect(git(repo.origin, "log", "--format=%s", "-3").split("\n")).toEqual([
        "Add skill new-skill",
        "Add skill other",
        "Seed",
      ]);
      expect(git(repo.origin, "log", "-1", "--format=%b")).toContain("thread-1");
      expect(NodeFS.existsSync(NodePath.join(agents, "new-skill", "references", "notes.md"))).toBe(
        true,
      );
      expect(NodeFS.existsSync(NodePath.join(agents, "other"))).toBe(true);

      const read = yield* skills.read(NodePath.join(agents, "new-skill", "SKILL.md"));
      expect(read.files.map((file) => file.path)).toEqual(["SKILL.md", "references/notes.md"]);
      const denied = yield* skills.read(NodePath.join(repo.root, "work")).pipe(Effect.flip);
      expect(denied.reason).toBe("read_denied");

      const failures = yield* Effect.forEach(
        [
          skills.saveGlobal({ name: "Bad Name", files: [{ path: "SKILL.md", content: "" }] }),
          skills.saveGlobal({
            name: "t3-skills",
            files: [{ path: "SKILL.md", content: skill("t3-skills") }],
          }),
          skills.saveGlobal({
            name: "mismatch",
            files: [{ path: "SKILL.md", content: skill("other-name") }],
          }),
          skills.saveGlobal({
            name: "leaky",
            files: [
              { path: "SKILL.md", content: skill("leaky") },
              { path: "env.txt", content: `KEY=sk-ant-${"x".repeat(40)}` },
            ],
          }),
          skills.saveGlobal({
            name: "escape",
            files: [
              { path: "SKILL.md", content: skill("escape") },
              { path: "../outside.md", content: "x" },
            ],
          }),
        ],
        (effect) => effect.pipe(Effect.flip),
      );
      expect(failures.map((failure) => failure.reason)).toEqual([
        "invalid_name",
        "reserved_name",
        "invalid_skill",
        "secret_detected",
        "invalid_path",
      ]);

      const deleted = yield* skills.deleteGlobal("hello");
      expect(deleted.skills.some((entry) => entry.name === "hello")).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(agents, "hello"))).toBe(false);
      expect(git(repo.origin, "log", "-1", "--format=%s")).toBe("Remove skill hello");

      // A clone with local changes stops pulling and refuses saves until it's fixed.
      const library = NodePath.join(config.stateDir, "fork", "skills", "library");
      NodeFS.writeFileSync(NodePath.join(library, "stray.txt"), "x");
      const dirty = yield* skills.sync;
      expect(dirty.dirty).toBe(true);
      expect(dirty.syncError).not.toBeNull();
      const refused = yield* skills
        .saveGlobal({ name: "later", files: [{ path: "SKILL.md", content: skill("later") }] })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("dirty");

      // Disconnecting removes T3's links and leaves other files alone.
      const disconnected = yield* skills.configure({ repository: null });
      expect(disconnected.repository).toBeNull();
      expect(NodeFS.existsSync(NodePath.join(agents, "new-skill"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(repo.home, ".claude", "CLAUDE.md"))).toBe(true);
    }).pipe(
      Effect.provide(layerFor(repo.home)),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(repo.root, { recursive: true, force: true })),
      ),
    );
  });
});

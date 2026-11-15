import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupOtherSkills, parseTags } from "./skillsSettings.logic";

const skill = (name: string, path: string): ServerProviderSkill => ({ name, path, enabled: true });
const provider = (
  instanceId: string,
  driver: string,
  skills: ReadonlyArray<ServerProviderSkill>,
  displayName?: string,
) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  ...(displayName ? { displayName } : {}),
  skills,
});

describe("groupOtherSkills", () => {
  it("leaves out fleet-managed skills and groups the rest by name across providers", () => {
    const managed = [
      {
        path: "/home/a/.t3/userdata/fork/skills/repo/skills/deploy",
        links: ["/home/a/.claude/skills/deploy", "/home/a/.agents/skills/deploy"],
      },
      { path: "/home/a/.t3/userdata/fork/skills/builtin/t3-skills", links: [] },
    ];
    const groups = groupOtherSkills(
      [
        provider("claude", "claudeAgent", [
          skill("deploy", "/home/a/.claude/skills/deploy/SKILL.md"),
          skill("review", "/home/a/.claude/skills/review/SKILL.md"),
          skill("plugin:lint", "/home/a/.claude/plugins/cache/lint/skills/lint"),
        ]),
        provider(
          "codex",
          "codex",
          [
            // Codex may report the link target inside the clone.
            skill("deploy", "/home/a/.t3/userdata/fork/skills/repo/skills/deploy/SKILL.md"),
            skill("t3-skills", "/home/a/.t3/userdata/fork/skills/builtin/t3-skills"),
            skill("review", "/home/a/.codex/skills/review"),
            skill("imagegen", "/home/a/.codex/skills/.system/imagegen/SKILL.md"),
          ],
          "Codex Work",
        ),
        provider("cursor", "cursor", [skill("review", "/home/a/.claude/skills/review/")]),
      ],
      managed,
    );

    expect(groups).toEqual([
      {
        name: "imagegen",
        description: null,
        bundled: true,
        locations: [{ path: "/home/a/.codex/skills/.system/imagegen", providers: ["Codex Work"] }],
      },
      {
        name: "plugin:lint",
        description: null,
        bundled: true,
        locations: [
          { path: "/home/a/.claude/plugins/cache/lint/skills/lint", providers: ["Claude"] },
        ],
      },
      {
        name: "review",
        description: null,
        bundled: false,
        locations: [
          { path: "/home/a/.claude/skills/review", providers: ["Claude", "Cursor"] },
          { path: "/home/a/.codex/skills/review", providers: ["Codex Work"] },
        ],
      },
    ]);
  });

  it("does not treat a sibling folder with a managed prefix as managed", () => {
    const groups = groupOtherSkills(
      [provider("claude", "claudeAgent", [skill("deploy-v2", "/h/.claude/skills/deploy-v2")])],
      [{ path: "/h/repo/skills/deploy", links: ["/h/.claude/skills/deploy"] }],
    );
    expect(groups.map((group) => group.name)).toEqual(["deploy-v2"]);
  });
});

describe("parseTags", () => {
  it("splits on commas and spaces and drops repeats", () => {
    expect(parseTags(" gpu, linux  gpu,,work ")).toEqual(["gpu", "linux", "work"]);
    expect(parseTags("   ")).toEqual([]);
  });
});

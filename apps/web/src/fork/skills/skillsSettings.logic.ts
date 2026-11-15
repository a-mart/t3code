import {
  PROVIDER_DISPLAY_NAMES,
  type ForkSkillsLibrarySkill,
  type ServerProvider,
} from "@t3tools/contracts";

export interface OtherSkillLocation {
  /** The skill folder, which `skillsRead` accepts. */
  readonly path: string;
  readonly providers: ReadonlyArray<string>;
}

export interface OtherSkillGroup {
  readonly name: string;
  readonly description: string | null;
  /** Plugin and system skills, which providers ship rather than the user writing them. */
  readonly bundled: boolean;
  readonly locations: ReadonlyArray<OtherSkillLocation>;
}

/** Providers report either the folder or its SKILL.md; compare folders. */
function skillFolder(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.endsWith("/SKILL.md") ? normalized.slice(0, -"/SKILL.md".length) : normalized;
}

const isAtOrInside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

function isBundledSkill(name: string, folder: string): boolean {
  return name.includes(":") || /\/(\.system|plugins)\//.test(`${folder}/`);
}

/** Skills providers on the host load that the fleet repo doesn't manage, one group per name. */
export function groupOtherSkills(
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "skills">
  >,
  managed: ReadonlyArray<Pick<ForkSkillsLibrarySkill, "path" | "links">>,
): ReadonlyArray<OtherSkillGroup> {
  const managedRoots = managed.flatMap((skill) => [skill.path, ...skill.links].map(skillFolder));
  const groups = new Map<
    string,
    { description: string | null; bundled: boolean; locations: Map<string, Set<string>> }
  >();
  for (const provider of providers) {
    const label =
      provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
    for (const skill of provider.skills) {
      const folder = skillFolder(skill.path);
      if (managedRoots.some((root) => isAtOrInside(folder, root))) continue;
      let group = groups.get(skill.name);
      if (group === undefined) {
        group = { description: null, bundled: false, locations: new Map() };
        groups.set(skill.name, group);
      }
      group.description ??= skill.description ?? skill.shortDescription ?? null;
      group.bundled ||= isBundledSkill(skill.name, folder);
      const labels = group.locations.get(folder) ?? new Set<string>();
      labels.add(label);
      group.locations.set(folder, labels);
    }
  }
  return [...groups.entries()]
    .map(([name, group]) => ({
      name,
      description: group.description,
      bundled: group.bundled,
      locations: [...group.locations.entries()]
        .map(([path, labels]) => ({ path, providers: [...labels].toSorted() }))
        .toSorted((left, right) => left.path.localeCompare(right.path)),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Comma- or space-separated tags, trimmed and without repeats. */
export function parseTags(input: string): ReadonlyArray<string> {
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    ),
  ];
}

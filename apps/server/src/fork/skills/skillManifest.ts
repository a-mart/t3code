import { isValidForkSkillName } from "@t3tools/contracts";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  readonly hosts: ReadonlyArray<string> | null;
  readonly providers: ReadonlyArray<string> | null;
  readonly requires: ReadonlyArray<string>;
  readonly userInvocationOnly: boolean;
}

export type SkillManifestResult =
  | { readonly ok: true; readonly manifest: SkillManifest }
  | { readonly ok: false; readonly reason: string };

const stringList = (value: unknown): ReadonlyArray<string> | null => {
  if (value === undefined || value === null) return null;
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [value];
  const strings = items
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
  return strings;
};

const isTrue = (value: unknown) =>
  value === true || (typeof value === "string" && /^(true|yes|on|y)$/i.test(value.trim()));

/**
 * Reads the frontmatter T3 acts on. `hosts`, `providers` and `requires` may sit
 * at the top level or under the spec's `metadata:` map, for CLIs that reject
 * unknown top-level keys.
 */
export const parseSkillManifest = (contents: string, folderName: string): SkillManifestResult => {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { ok: false, reason: "SKILL.md has no frontmatter." };
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { ok: false, reason: "SKILL.md frontmatter isn't valid YAML." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "SKILL.md frontmatter isn't valid YAML." };
  }
  const record = parsed as Record<string, unknown>;
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null
      ? (record.metadata as Record<string, unknown>)
      : {};
  const field = (key: string) => (key in record ? record[key] : metadata[key]);
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!isValidForkSkillName(folderName)) {
    return { ok: false, reason: "The folder name must use lowercase letters, digits and hyphens." };
  }
  if (name !== folderName) {
    return { ok: false, reason: `Frontmatter name must be "${folderName}", matching the folder.` };
  }
  if (description.length === 0) return { ok: false, reason: "Frontmatter needs a description." };
  const hosts = stringList(field("hosts"));
  const providers = stringList(field("providers"));
  return {
    ok: true,
    manifest: {
      name,
      description,
      hosts: hosts === null || hosts.length === 0 ? null : hosts.map((host) => host.toLowerCase()),
      providers:
        providers === null || providers.length === 0
          ? null
          : providers.map((provider) => provider.toLowerCase()),
      requires: stringList(field("requires")) ?? [],
      userInvocationOnly: isTrue(record["disable-model-invocation"]),
    },
  };
};

/** Null when the skill belongs on this host; otherwise why not. */
export const hostSkipReason = (
  hosts: ReadonlyArray<string> | null,
  hostName: string,
  tags: ReadonlyArray<string>,
): string | null => {
  if (hosts === null) return null;
  const matches = hosts.some((entry) =>
    entry.startsWith("tag:") ? tags.includes(entry.slice(4)) : entry === hostName,
  );
  return matches ? null : `Limited to ${hosts.join(", ")}.`;
};

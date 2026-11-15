import * as Schema from "effect/Schema";

/**
 * Global skills and agent instructions from one git repo (the "fleet" repo),
 * which every host's server pulls and links into its providers' folders.
 */

const FORK_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORK_SKILL_NAME_MAX_LENGTH = 64;
export const isValidForkSkillName = (name: string) =>
  name.length <= FORK_SKILL_NAME_MAX_LENGTH && FORK_SKILL_NAME_PATTERN.test(name);

/** Lowercase letters, digits and hyphens, like a skill name. */
export const forkSkillsHostNameFromLabel = (label: string) =>
  label
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FORK_SKILL_NAME_MAX_LENGTH)
    .replace(/-+$/, "") || "host";

export const ForkSkillSource = Schema.Literals(["library", "builtin"]);
export type ForkSkillSource = typeof ForkSkillSource.Type;

export const ForkSkillStatus = Schema.Literals(["linked", "skipped", "conflict", "invalid"]);
export type ForkSkillStatus = typeof ForkSkillStatus.Type;

export const ForkSkillConflict = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["exists", "changed"]),
});
export type ForkSkillConflict = typeof ForkSkillConflict.Type;

export const ForkSkillsLibrarySkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  source: ForkSkillSource,
  /** Folder in the clone or the built-in directory. */
  path: Schema.String,
  hosts: Schema.NullOr(Schema.Array(Schema.String)),
  providers: Schema.NullOr(Schema.Array(Schema.String)),
  requires: Schema.Array(Schema.String),
  userInvocationOnly: Schema.Boolean,
  status: ForkSkillStatus,
  /** Why the skill is skipped or invalid, in words for the user. */
  reason: Schema.NullOr(Schema.String),
  links: Schema.Array(Schema.String),
  conflicts: Schema.Array(ForkSkillConflict),
});
export type ForkSkillsLibrarySkill = typeof ForkSkillsLibrarySkill.Type;

export const ForkSkillsInstructionFile = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["written", "conflict"]),
  conflict: Schema.NullOr(ForkSkillConflict),
});
export type ForkSkillsInstructionFile = typeof ForkSkillsInstructionFile.Type;

export const ForkSkillsInstructions = Schema.Struct({
  /** The combined text T3 writes on this host; null when the repo has none for it. */
  content: Schema.NullOr(Schema.String),
  /** Repo files the content came from, such as `instructions/hosts/mac.md`. */
  sources: Schema.Array(Schema.String),
  files: Schema.Array(ForkSkillsInstructionFile),
});
export type ForkSkillsInstructions = typeof ForkSkillsInstructions.Type;

export const ForkSkillsState = Schema.Struct({
  repository: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  hostName: Schema.String,
  /** What `hostName` falls back to: this environment's label as a slug. */
  defaultHostName: Schema.String,
  tags: Schema.Array(Schema.String),
  commit: Schema.NullOr(Schema.String),
  commitSubject: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
  syncError: Schema.NullOr(Schema.String),
  /** The clone has uncommitted or unpushed changes, so pulls stop until it's fixed. */
  dirty: Schema.Boolean,
  skills: Schema.Array(ForkSkillsLibrarySkill),
  instructions: ForkSkillsInstructions,
});
export type ForkSkillsState = typeof ForkSkillsState.Type;

export const ForkSkillsConfigureInput = Schema.Struct({
  /** `owner/name` on GitHub or any git URL; null disconnects and removes T3's links. */
  repository: Schema.optionalKey(Schema.NullOr(Schema.String)),
  branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** null goes back to the default. */
  hostName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ForkSkillsConfigureInput = typeof ForkSkillsConfigureInput.Type;

export const ForkSkillsReadInput = Schema.Struct({ path: Schema.String });
export type ForkSkillsReadInput = typeof ForkSkillsReadInput.Type;

export const ForkSkillsFile = Schema.Struct({
  /** Relative to the skill folder. */
  path: Schema.String,
  /** Null for a binary or oversized file. */
  content: Schema.NullOr(Schema.String),
  bytes: Schema.Number,
});
export type ForkSkillsFile = typeof ForkSkillsFile.Type;

export const ForkSkillsReadResult = Schema.Struct({
  path: Schema.String,
  files: Schema.Array(ForkSkillsFile),
});
export type ForkSkillsReadResult = typeof ForkSkillsReadResult.Type;

export const ForkSkillsDeleteInput = Schema.Struct({ name: Schema.String });
export type ForkSkillsDeleteInput = typeof ForkSkillsDeleteInput.Type;

export const ForkSkillsFailureReason = Schema.Literals([
  "not_configured",
  "invalid_repository",
  "invalid_host_name",
  "invalid_tag",
  "invalid_name",
  "reserved_name",
  "invalid_skill",
  "invalid_path",
  "too_large",
  "secret_detected",
  "not_found",
  "read_denied",
  "dirty",
  "git_failed",
  "persist_failed",
]);
export type ForkSkillsFailureReason = typeof ForkSkillsFailureReason.Type;

const FORK_SKILLS_FAILURE_MESSAGES: Readonly<Record<ForkSkillsFailureReason, string>> = {
  not_configured: "No skills repository is set up on this host.",
  invalid_repository: "Use owner/name for a GitHub repository, or a full git URL.",
  invalid_host_name: "Host names use lowercase letters, digits and hyphens.",
  invalid_tag: "Tags use lowercase letters, digits and hyphens.",
  invalid_name: "Skill names use lowercase letters, digits and hyphens, at most 64 characters.",
  reserved_name: "That name belongs to T3's built-in skill.",
  invalid_skill: "SKILL.md needs frontmatter with a name matching the folder and a description.",
  invalid_path: "File paths must be relative and stay inside the skill folder.",
  too_large: "Skills are limited to 64 files and 1 MiB.",
  secret_detected: "A file looks like it contains a secret. Remove it and name the secret instead.",
  not_found: "No skill has that name.",
  read_denied: "That path isn't a skill on this host.",
  dirty: "The skills clone on this host has local changes. Commit or discard them first.",
  git_failed: "Git failed.",
  persist_failed: "Couldn't save the skills settings on this host.",
};

export class ForkSkillsError extends Schema.TaggedError<ForkSkillsError>()("ForkSkillsError", {
  reason: ForkSkillsFailureReason,
  /** Git's own message, for `git_failed`, or the offending file. */
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const base = FORK_SKILLS_FAILURE_MESSAGES[this.reason];
    return this.detail ? `${base} ${this.detail}` : base;
  }
}

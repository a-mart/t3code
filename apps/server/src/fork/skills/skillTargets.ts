export interface HostSkillDirectories {
  readonly home: string;
  /** Every distinct Claude config directory on this host, such as `~/.claude`. */
  readonly claudeDirs: ReadonlyArray<string>;
  /** `$CODEX_HOME`, default `~/.codex`. */
  readonly codexHome: string;
  readonly join: (...parts: ReadonlyArray<string>) => string;
}

export interface SkillRoot {
  /** The folder a skill's link goes in. */
  readonly root: string;
  /** Link only when this directory exists, so T3 doesn't create a provider's home on a host without it. */
  readonly whenExists: string | null;
}

/** Providers reading `~/.agents/skills`, verified for each. */
const AGENTS_FOLDER_PROVIDERS = new Set(["codex", "grok", "cursor", "fx"]);
export const KNOWN_SKILL_PROVIDERS = new Set([...AGENTS_FOLDER_PROVIDERS, "claude", "antigravity"]);

/**
 * Where a skill's links go. Several providers read the same folders, so a
 * provider limit only narrows the folders: Grok and Cursor also read
 * `~/.claude/skills`, and Cursor reads `~/.codex/skills`.
 */
export const skillRoots = (
  providers: ReadonlyArray<string> | null,
  dirs: HostSkillDirectories,
): ReadonlyArray<SkillRoot> => {
  const wants = (provider: string) => providers === null || providers.includes(provider);
  const roots: Array<SkillRoot> = [];
  const sharedFolder = [...AGENTS_FOLDER_PROVIDERS].some(
    (provider) => provider !== "codex" && wants(provider),
  );
  if (sharedFolder) {
    roots.push({ root: dirs.join(dirs.home, ".agents", "skills"), whenExists: null });
  } else if (wants("codex")) {
    // Codex reads both folders, so it gets one link, not two.
    roots.push({ root: dirs.join(dirs.codexHome, "skills"), whenExists: dirs.codexHome });
  }
  if (wants("claude")) {
    for (const dir of dirs.claudeDirs) {
      roots.push({ root: dirs.join(dir, "skills"), whenExists: dir });
    }
  }
  if (wants("antigravity")) {
    const gemini = dirs.join(dirs.home, ".gemini");
    roots.push({ root: dirs.join(gemini, "config", "skills"), whenExists: gemini });
  }
  return roots;
};

/** Where the combined global instructions go: Claude's CLAUDE.md and Codex's AGENTS.md. */
export const instructionTargets = (dirs: HostSkillDirectories): ReadonlyArray<SkillRoot> => [
  ...dirs.claudeDirs.map((dir) => ({ root: dirs.join(dir, "CLAUDE.md"), whenExists: dir })),
  { root: dirs.join(dirs.codexHome, "AGENTS.md"), whenExists: dirs.codexHome },
];

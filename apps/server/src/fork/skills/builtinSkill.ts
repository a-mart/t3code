export const BUILTIN_SKILL_NAME = "t3-skills";

/** Model-facing. Evals in `evals/mcp-tool-use` cover where agents put a new skill. */
export const BUILTIN_SKILL_MARKDOWN = `---
name: t3-skills
description: How to write or change an agent skill, and whether it belongs to this project, to every host (save_global_skill), or nowhere. Use when the user says "make a skill", "save this as a skill", "remember how to do this", "add a global skill", or asks to change an existing one.
---

# Writing skills

A skill is a folder with a \`SKILL.md\` that agents load when its description matches the task.

## Does it need a skill?

- A procedure with several steps, a tool's quirks, or a workflow the user repeats: a skill.
- One rule or preference ("use pnpm", "never force-push"): a line in instructions, not a skill.
- Something only true today, or about one task: neither.

## Where it goes

- **Project**: about this codebase, its build, its services. Write \`.agents/skills/<name>/SKILL.md\` in the repo. If \`.claude/skills\` doesn't exist, make it a symlink to \`../.agents/skills\` so Claude loads them too. Commit it with the work.
- **Global**: about the user, their tools, or how they work, useful in any repo. Call the \`save_global_skill\` tool. It commits to the user's fleet repo and reaches every host within 15 minutes.
- Never write into \`~/.claude/skills\`, \`~/.agents/skills\`, \`~/.codex/skills\` or other provider folders yourself. T3 manages those links.
- Global instructions and host notes live in the fleet repo's \`instructions/\` folder. Change them only when the user asks, in a checkout of that repo.

## Format

\`\`\`markdown
---
name: <name>           # lowercase, digits, hyphens; same as the folder
description: <what it does and when to use it, including the phrases the user would say>
requires: [gh]         # optional: commands it runs; hosts without them skip it
hosts: [mac]           # optional: only for an app, device or path one host has
providers: [claude]    # optional: only when it uses one provider's own tools
---

Short steps. Put long reference material in references/ and scripts in scripts/.
\`\`\`

- The description decides when the skill loads: say what it does, when to use it, and the words the user says ("full send", "set up a new box").
- Update an existing skill instead of adding a near-duplicate. Before saving a global skill, check the skills you already have for one that covers it.
- A skill may tell the agent to use another skill by name.
- A skill with side effects the user should start themselves (deploy, push, delete): add \`disable-model-invocation: true\` to the frontmatter, and an \`agents/openai.yaml\` file containing \`policy:\\n  allow_implicit_invocation: false\` for Codex.
- Never put a secret in a skill. Name the \`secure_bash\` alias it needs instead.
`;

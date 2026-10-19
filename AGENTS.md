# Agent instructions

Before editing this plugin, read `skills/creating-plugins/SKILL.md` completely. Codex discovers the same directory through `.agents/skills`; Claude discovers it through `.claude/skills` and reads these instructions through `.claude/CLAUDE.md`.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, typecheck, test, and build scripts after changes.

# Agent Instructions for Fortress Rollback

Read and follow these before making changes:

1. [`.agents/skills/fortress-development/SKILL.md`](.agents/skills/fortress-development/SKILL.md) —
   canonical project context and engineering policy.
2. [`.agents/skills/session-loop/SKILL.md`](.agents/skills/session-loop/SKILL.md) — the 3-hour,
   one-item, one-PR session contract.

Use [the question template](.agents/skills/fortress-development/assets/ask-user-question.md) when a
clarifying question is needed.

## Git and GitHub Access

Use callable VS Code Git and GitHub Pull Requests/Issues integrations first. Use local `git` for
repository work, then the connected GitHub connector/app for platform work. `gh` is a last resort.
Never print or persist credentials.

When editing `.devcontainer/**`, read [`.devcontainer/AGENTS.md`](.devcontainer/AGENTS.md) first.

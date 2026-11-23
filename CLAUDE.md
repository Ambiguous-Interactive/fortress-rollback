# Claude Instructions for Fortress Rollback

Read and follow
[`.agents/skills/fortress-development/SKILL.md`](.agents/skills/fortress-development/SKILL.md) and
[`.agents/skills/session-loop/SKILL.md`](.agents/skills/session-loop/SKILL.md) before making changes.

Use callable VS Code integrations first: the built-in VS Code Git extension for source control and
the GitHub Pull Requests and Issues (`GitHub.vscode-pull-request-github`) for GitHub operations; UI
presence alone is not callable access. If they cannot perform the operation, use local `git` for
repository work and the connected GitHub connector/app for platform work. `gh` is an absolute
fallback, allowed only when the VS Code connector, local Git, and connected GitHub connector/app are
unavailable or incapable. `gh auth status` is not a prerequisite when another supported path exists:
probe Git reads with `git ls-remote origin HEAD` and writes with `git push --dry-run origin
HEAD:<branch>`; SSH usually uses VS Code-forwarded `SSH_AUTH_SOCK` and HTTPS its credential helper.
Never print or persist credentials.

For clarifying questions, use
[`.agents/skills/fortress-development/assets/ask-user-question.md`](.agents/skills/fortress-development/assets/ask-user-question.md).

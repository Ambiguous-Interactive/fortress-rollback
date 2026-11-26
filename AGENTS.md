# Agent Instructions for Fortress Rollback

Read and follow these before making changes:

1. [`.agents/skills/fortress-development/SKILL.md`](.agents/skills/fortress-development/SKILL.md) —
   canonical project context and engineering policy.
2. [`.agents/skills/session-loop/SKILL.md`](.agents/skills/session-loop/SKILL.md) — the 180-minute,
   one-item, one-PR session contract.

Use [the question template](.agents/skills/fortress-development/assets/ask-user-question.md) when a
clarifying question is needed.

## Git and GitHub Access

Use callable VS Code integrations first: the built-in VS Code Git extension for source control and
the GitHub Pull Requests and Issues (`GitHub.vscode-pull-request-github`) for GitHub operations; UI
presence alone is not callable access. If they cannot perform the operation, use local `git` for
repository work and the connected GitHub connector/app for platform work. `gh` is an absolute
fallback, allowed only when the VS Code connector, local Git, and connected GitHub connector/app are
unavailable or incapable. `gh auth status` is not a prerequisite when another supported path exists:
probe Git reads with `git ls-remote origin HEAD` and writes with `git push --dry-run origin
HEAD:<branch>`; SSH usually uses VS Code-forwarded `SSH_AUTH_SOCK` and HTTPS its credential helper.
Never print or persist credentials.

The VS Code GitHub authentication bridge (`fortress-local.fortress-github-auth`) is the supported
connector path. Its `fortress.githubSignIn` command obtains the session through
`vscode.authentication.getSession("github", ...)` and exports it to
`~/.local/state/opencode/vscode-github-token.json` (mode 0600); the Dev Containers git credential
helper over `REMOTE_CONTAINERS_IPC` is the fallback. Resolve and validate either with
`python3 scripts/ci/vscode-github-token.py check`, which reports the source, account, and scopes
without printing the token. An absent export means no credential has been exported yet, not that the
client is signed out: reconnect the VS Code window so an extension host starts, or ask the operator to
run **Fortress: Sign in to GitHub**. Never extract tokens from process memory, secret storage, or
credential caches without explicit operator approval, and delete any approved copy at closeout.

When editing `.devcontainer/**`, read [`.devcontainer/AGENTS.md`](.devcontainer/AGENTS.md) first.

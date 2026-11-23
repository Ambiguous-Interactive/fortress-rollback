# Devcontainer Agent Contract

When editing devcontainer or tooling files, preserve these guarantees:

- Install Codex via the npm package `@openai/codex@latest` in `.devcontainer/Dockerfile`.
- Keep `.devcontainer/codex-bootstrap.sh` wired into the devcontainer create and start hooks.
- Do not commit credentials; use `codex login`, `codex login --device-auth`, or API key environment
  variables.

Run the devcontainer build and smoke checks before handoff when the image, setup hooks, or MCP
configuration changes.

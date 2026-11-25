#!/usr/bin/env python3
"""Resolve a GitHub credential through the VS Code GitHub connector.

Supported sources, in order:

1. ``vscode-bridge`` -- the ``fortress-local.fortress-github-auth`` extension export at
   ``$XDG_STATE_HOME/opencode/vscode-github-token.json`` (default
   ``~/.local/state/opencode/vscode-github-token.json``). The extension obtains the token through
   ``vscode.authentication.getSession("github", ...)`` and writes the file with mode 0600.
2. ``vscode-git-credential`` -- the VS Code Dev Containers git credential helper, reached over the
   ``REMOTE_CONTAINERS_IPC`` socket through the standard ``git credential fill`` protocol.
3. ``environment`` -- ``GITHUB_PERSONAL_ACCESS_TOKEN`` for CI and non-devcontainer runs.

The token is never printed unless the caller explicitly selects ``askpass`` (the GIT_ASKPASS
contract). ``exec`` injects it into a child process environment without printing it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GITHUB_API_USER_URL = "https://api.github.com/user"
GIT_CREDENTIAL_HOST = "github.com"
DEFAULT_TIMEOUT_SECONDS = 20.0
SIGN_IN_COMMAND = "fortress.githubSignIn"
SIGN_IN_TITLE = "Fortress: Sign in to GitHub"
EXPORT_FILE_NAME = "vscode-github-token.json"
TOKEN_SHAPE = re.compile(r"^[A-Za-z0-9_-]+$")
ASKPASS_PROMPT = re.compile(r"^(Username|Password) for '(?P<url>[^']+)':$")
VSCODE_HELPER_MARKERS = ("vscode-remote-containers-", "git-credential-helper")


class CredentialError(RuntimeError):
    """A credential could not be resolved or validated."""


def _checked_token(token: str, source: str) -> str:
    """Return a token with a safe shape, or fail without echoing it.

    GitHub tokens are URL-safe base64-ish strings. Rejecting whitespace and
    control characters keeps a malformed token out of an Authorization header, a
    subprocess environment, and diagnostic output.
    """
    if not TOKEN_SHAPE.fullmatch(token):
        raise CredentialError(f"the {source} credential contains unsupported characters")
    return token


@dataclass(frozen=True)
class Credential:
    """A GitHub credential and the supported source that produced it."""

    token: str
    source: str
    account: str | None = None
    scopes: tuple[str, ...] = ()


@dataclass(frozen=True)
class Validation:
    """The GitHub identity and scopes for a validated credential."""

    login: str
    scopes: tuple[str, ...]


def default_export_path(env: Mapping[str, str] | None = None) -> Path:
    """Return the bridge export path, honoring ``XDG_STATE_HOME``."""
    environment = os.environ if env is None else env
    state_home = environment.get("XDG_STATE_HOME", "").strip()
    base = Path(state_home) if state_home else Path.home() / ".local" / "state"
    return base / "opencode" / EXPORT_FILE_NAME


def read_bridge_export(path: Path) -> Credential | None:
    """Read the VS Code GitHub auth bridge export, or None when it is absent.

    Raises:
        CredentialError: The file exists but is unsafe, unreadable, or malformed.
    """
    try:
        with path.open("r", encoding="utf-8") as handle:
            mode = stat.S_IMODE(os.fstat(handle.fileno()).st_mode)
            if mode & 0o077:
                raise CredentialError(
                    f"{path} is accessible to other users (mode {oct(mode)}); "
                    f"run 'chmod 600 {path}'"
                )
            payload = json.load(handle)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise CredentialError(f"cannot read {path}: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise CredentialError(f"{path} is not UTF-8: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise CredentialError(f"{path} is not valid JSON: {exc.msg}") from exc

    if not isinstance(payload, dict):
        raise CredentialError(f"{path} must contain a JSON object")
    token = payload.get("accessToken")
    if not isinstance(token, str) or not token.strip():
        raise CredentialError(f"{path} has no accessToken string")
    token = _checked_token(token.strip(), "VS Code bridge")
    account = payload.get("account")
    raw_scopes = payload.get("scopes")
    scopes = (
        tuple(scope for scope in raw_scopes if isinstance(scope, str))
        if isinstance(raw_scopes, list)
        else ()
    )
    return Credential(
        token=token.strip(),
        source="vscode-bridge",
        account=account if isinstance(account, str) else None,
        scopes=scopes,
    )


def _mtime(path: Path) -> float:
    """Return a socket's modification time, treating a vanished path as oldest."""
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def find_ipc_sockets(
    env: Mapping[str, str] | None = None, tmp_root: Path | None = None
) -> list[Path]:
    """Return candidate VS Code Dev Containers IPC sockets, newest first.

    The configured socket is tried first, then every matching socket in
    modification-time order. Callers must probe each candidate because a socket
    file can outlive the client that served it.
    """
    environment = os.environ if env is None else env
    root = Path(tempfile.gettempdir()) if tmp_root is None else tmp_root
    candidates: list[Path] = []
    configured = environment.get("REMOTE_CONTAINERS_IPC", "").strip()
    if configured:
        candidate = Path(configured)
        if candidate.is_socket():
            candidates.append(candidate)
    for candidate in sorted(
        root.glob("vscode-remote-containers-ipc-*.sock"),
        key=_mtime,
        reverse=True,
    ):
        if candidate.is_socket() and candidate not in candidates:
            candidates.append(candidate)
    return candidates


def parse_git_credential(output: str) -> str | None:
    """Extract the password from ``git credential fill`` output."""
    for line in output.splitlines():
        key, separator, value = line.partition("=")
        if separator and key == "password" and value:
            return value
    return None


def _trusted_git_helpers(
    env: Mapping[str, str],
    runner: Callable[..., Any],
    timeout: float,
) -> list[str]:
    """Return only the configured Dev Containers git credential helpers."""
    try:
        completed = runner(  # noqa: S603 - fixed git subcommand, no shell
            ["git", "config", "--get-all", "credential.helper"],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=timeout,
            env=dict(env),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if completed.returncode != 0:
        return []
    return [
        helper
        for helper in completed.stdout.splitlines()
        if all(marker in helper for marker in VSCODE_HELPER_MARKERS)
    ]


def resolve_from_git_credential(
    socket_path: Path,
    *,
    env: Mapping[str, str] | None = None,
    runner: Callable[..., Any] = subprocess.run,
    helpers: Sequence[str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> Credential | None:
    """Ask only the trusted VS Code git credential helper for a credential."""
    child_env = dict(os.environ if env is None else env)
    child_env["REMOTE_CONTAINERS_IPC"] = str(socket_path)
    child_env["GIT_TERMINAL_PROMPT"] = "0"
    # An inherited askpass wrapper may be this resolver; asking git for a
    # credential must not recurse through it.
    for variable in ("GIT_ASKPASS", "SSH_ASKPASS"):
        child_env.pop(variable, None)
    trusted = (
        list(helpers)
        if helpers is not None
        else _trusted_git_helpers(child_env, runner, timeout)
    )
    if not trusted:
        return None
    command = ["git", "-c", "core.askPass=", "-c", "credential.helper="]
    for helper in trusted:
        command.extend(["-c", f"credential.helper={helper}"])
    command.extend(["credential", "fill"])
    try:
        completed = runner(  # noqa: S603 - fixed git subcommand, no shell
            command,  # noqa: S607 - git is resolved from PATH
            input=f"protocol=https\nhost={GIT_CREDENTIAL_HOST}\n\n",
            capture_output=True,
            text=True,
            timeout=timeout,
            env=child_env,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    token = parse_git_credential(completed.stdout)
    if token is None:
        return None
    return Credential(
        token=_checked_token(token, "Dev Containers helper"),
        source="vscode-git-credential",
    )


def resolve_from_environment(env: Mapping[str, str] | None = None) -> Credential | None:
    """Return the configured environment token, if any."""
    environment = os.environ if env is None else env
    token = environment.get("GITHUB_PERSONAL_ACCESS_TOKEN", "").strip()
    if not token:
        return None
    return Credential(token=_checked_token(token, "environment"), source="environment")


def resolve(
    *,
    env: Mapping[str, str] | None = None,
    export_path: Path | None = None,
    socket_path: Path | None = None,
    git_resolver: Callable[[Path], Credential | None] | None = None,
) -> Credential:
    """Resolve a GitHub credential from the supported VS Code paths.

    Raises:
        CredentialError: No supported source is available.
    """
    environment = os.environ if env is None else env
    export = default_export_path(environment) if export_path is None else export_path
    credential = read_bridge_export(export)
    if credential is not None:
        return credential

    socket = find_ipc_sockets(environment) if socket_path is None else [socket_path]
    resolver = resolve_from_git_credential if git_resolver is None else git_resolver
    for candidate in socket:
        credential = resolver(candidate)
        if credential is not None:
            return credential

    credential = resolve_from_environment(environment)
    if credential is not None:
        return credential

    raise CredentialError(
        "no VS Code GitHub connector credential found; run "
        f"'{SIGN_IN_TITLE}' in VS Code (command {SIGN_IN_COMMAND}) and retry "
        "'python3 scripts/ci/vscode-github-token.py check'. "
        f"Checked the bridge export at {export} and the Dev Containers git credential helper."
    )


def _github_user(
    credential: Credential, *, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> tuple[str, tuple[str, ...]]:
    """Return ``(login, scopes)`` for a credential from ``GET /user``."""
    request = urllib.request.Request(
        GITHUB_API_USER_URL,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {credential.token}",
            "User-Agent": "fortress-rollback-agent",
        },
    )
    try:
        with urllib.request.urlopen(  # noqa: S310 - fixed HTTPS GitHub API origin
            request, timeout=timeout
        ) as response:
            payload = json.load(response)
            raw_scopes = response.headers.get("x-oauth-scopes", "")
    except urllib.error.HTTPError as exc:
        raise CredentialError(
            f"GitHub rejected the {credential.source} credential: HTTP {exc.code}"
        ) from exc
    except urllib.error.URLError as exc:
        raise CredentialError(
            f"could not reach {GITHUB_API_USER_URL}: {exc.reason}"
        ) from exc
    except ValueError as exc:
        raise CredentialError(
            "could not validate the credential: malformed token"
        ) from exc
    except OSError as exc:
        raise CredentialError(f"could not validate the credential: {exc}") from exc

    login = payload.get("login") if isinstance(payload, dict) else None
    if not isinstance(login, str) or not login:
        raise CredentialError("GitHub returned no login for the credential")
    scopes = tuple(scope.strip() for scope in raw_scopes.split(",") if scope.strip())
    return login, scopes


def validate(
    credential: Credential,
    *,
    user_lookup: Callable[[Credential], tuple[str, tuple[str, ...]]] | None = None,
) -> Validation:
    """Validate a credential against the GitHub API.

    Raises:
        CredentialError: The token is rejected or the API is unreachable.
    """
    lookup = _github_user if user_lookup is None else user_lookup
    login, scopes = lookup(credential)
    return Validation(login=login, scopes=tuple(scopes))


def _format_credential(
    credential: Credential, validation: Validation | None = None
) -> str:
    """Format non-secret credential metadata for diagnostics."""
    scopes = validation.scopes if validation is not None else credential.scopes
    parts = [
        f"source={credential.source}",
        f"account={credential.account or '-'}",
        f"scopes={','.join(scopes) if scopes else '-'}",
    ]
    if validation is not None:
        parts.append(f"login={validation.login}")
    return " ".join(parts)


def _askpass_request(prompt: str) -> str | None:
    """Return ``username`` or ``password`` for an allowed GitHub HTTPS prompt."""
    match = ASKPASS_PROMPT.match(prompt.strip())
    if match is None:
        return None
    parsed = urllib.parse.urlsplit(match.group("url"))
    if parsed.scheme != "https" or parsed.hostname != GIT_CREDENTIAL_HOST:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port not in (None, 443):
        return None
    return match.group(1).lower()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Resolve a GitHub credential from the VS Code GitHub connector "
            "without printing the token."
        )
    )
    parser.add_argument(
        "--export",
        type=Path,
        default=None,
        help="override the VS Code auth bridge export path",
    )
    parser.add_argument(
        "--socket",
        type=Path,
        default=None,
        help="override the VS Code Dev Containers IPC socket",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "check", help="resolve and validate the credential against the GitHub API"
    )
    subparsers.add_parser(
        "describe", help="resolve the credential and print non-secret metadata"
    )
    askpass = subparsers.add_parser(
        "askpass", help="answer GitHub HTTPS GIT_ASKPASS username/password prompts"
    )
    askpass.add_argument("prompt", nargs="?", default="")
    exec_parser = subparsers.add_parser(
        "exec", help="run a command with the token in its environment"
    )
    exec_parser.add_argument("argv", nargs=argparse.REMAINDER)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the resolver CLI and return a process exit code."""
    args = _build_parser().parse_args(argv)
    resolve_kwargs: dict[str, Any] = {}
    if args.export is not None:
        resolve_kwargs["export_path"] = args.export
    if args.socket is not None:
        resolve_kwargs["socket_path"] = args.socket

    askpass_request = (
        _askpass_request(args.prompt) if args.command == "askpass" else None
    )
    try:
        if args.command == "askpass" and askpass_request is None:
            raise CredentialError(
                "askpass refuses a prompt that is not for https://github.com"
            )
        credential = resolve(**resolve_kwargs)
        if args.command == "check":
            print(_format_credential(credential, validate(credential)))
        elif args.command == "describe":
            print(_format_credential(credential))
        elif args.command == "askpass":
            if askpass_request == "username":
                sys.stdout.write("x-access-token\n")
            else:
                sys.stdout.write(f"{credential.token}\n")
        elif args.command == "exec":
            command = list(args.argv)
            if command and command[0] == "--":
                command = command[1:]
            if not command:
                raise CredentialError("exec needs a command after '--'")
            child_env = dict(os.environ)
            child_env["GITHUB_PERSONAL_ACCESS_TOKEN"] = credential.token
            try:
                completed = subprocess.run(  # noqa: S603 - caller-provided command, no shell
                    command,
                    env=child_env,
                    check=False,
                )
            except OSError as exc:
                raise CredentialError(f"cannot run {command[0]}: {exc}") from exc
            if completed.returncode < 0:
                return 128 + abs(completed.returncode)
            return completed.returncode
        else:  # pragma: no cover - argparse restricts the choices
            raise CredentialError(f"unknown command: {args.command}")
    except CredentialError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

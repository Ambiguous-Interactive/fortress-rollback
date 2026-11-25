#!/usr/bin/env python3
"""Unit tests for scripts/ci/vscode-github-token.py."""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

scripts_dir = Path(__file__).parent.parent
spec = importlib.util.spec_from_file_location(
    "vscode_github_token",
    scripts_dir / "ci" / "vscode-github-token.py",
)
assert spec is not None
assert spec.loader is not None
vscode_github_token = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = vscode_github_token
spec.loader.exec_module(vscode_github_token)

Credential = vscode_github_token.Credential
CredentialError = vscode_github_token.CredentialError
Validation = vscode_github_token.Validation
main = vscode_github_token.main
parse_git_credential = vscode_github_token.parse_git_credential
read_bridge_export = vscode_github_token.read_bridge_export
resolve = vscode_github_token.resolve
resolve_from_git_credential = vscode_github_token.resolve_from_git_credential
resolve_from_environment = vscode_github_token.resolve_from_environment
validate = vscode_github_token.validate


def _write_export(path: Path, payload: dict[str, object], mode: int = 0o600) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(mode)
    return path


def test_read_bridge_export_accepts_mode_0600_payload(tmp_path: Path) -> None:
    export = _write_export(
        tmp_path / "vscode-github-token.json",
        {
            "accessToken": "gho_example",
            "account": "wallstop",
            "scopes": ["repo", "read:user"],
        },
    )

    credential = read_bridge_export(export)

    assert credential is not None
    assert credential.token == "gho_example"
    assert credential.source == "vscode-bridge"
    assert credential.account == "wallstop"
    assert credential.scopes == ("repo", "read:user")


def test_read_bridge_export_rejects_token_with_unsupported_characters(
    tmp_path: Path,
) -> None:
    export = _write_export(
        tmp_path / "vscode-github-token.json",
        {"accessToken": "abc\nInjected: true"},
    )

    with pytest.raises(CredentialError, match="unsupported characters"):
        read_bridge_export(export)


def test_read_bridge_export_returns_none_when_absent(tmp_path: Path) -> None:
    assert read_bridge_export(tmp_path / "missing.json") is None


def test_read_bridge_export_rejects_group_or_world_readable_file(
    tmp_path: Path,
) -> None:
    export = _write_export(
        tmp_path / "vscode-github-token.json",
        {"accessToken": "gho_example"},
        mode=0o644,
    )

    with pytest.raises(CredentialError) as excinfo:
        read_bridge_export(export)

    assert "chmod 600" in str(excinfo.value)


def test_read_bridge_export_rejects_missing_access_token(tmp_path: Path) -> None:
    export = _write_export(tmp_path / "vscode-github-token.json", {"account": "x"})

    with pytest.raises(CredentialError, match="no accessToken"):
        read_bridge_export(export)


def test_read_bridge_export_rejects_invalid_json(tmp_path: Path) -> None:
    export = tmp_path / "vscode-github-token.json"
    export.write_text("{not json", encoding="utf-8")
    export.chmod(0o600)

    with pytest.raises(CredentialError, match="not valid JSON"):
        read_bridge_export(export)


def test_default_export_path_respects_xdg_state_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))

    path = vscode_github_token.default_export_path()

    assert path == tmp_path / "opencode" / "vscode-github-token.json"


def test_resolve_prefers_the_bridge_export_over_a_git_credential(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    export = _write_export(
        tmp_path / "vscode-github-token.json", {"accessToken": "bridge-token"}
    )
    called: list[Path] = []

    def git_resolver(socket_path: Path) -> Credential | None:
        called.append(socket_path)
        return Credential(token="git-token", source="vscode-git-credential")

    credential = resolve(
        env={"GITHUB_PERSONAL_ACCESS_TOKEN": "env-token"},
        export_path=export,
        socket_path=tmp_path / "example.sock",
        git_resolver=git_resolver,
    )

    assert credential.token == "bridge-token"
    assert credential.source == "vscode-bridge"
    assert called == []


def test_resolve_falls_back_to_the_git_credential_helper(
    tmp_path: Path,
) -> None:
    socket = tmp_path / "example.sock"

    def git_resolver(socket_path: Path) -> Credential | None:
        assert socket_path == socket
        return Credential(token="git-token", source="vscode-git-credential")

    credential = resolve(
        env={"GITHUB_PERSONAL_ACCESS_TOKEN": "env-token"},
        export_path=tmp_path / "missing.json",
        socket_path=socket,
        git_resolver=git_resolver,
    )

    assert credential.source == "vscode-git-credential"
    assert credential.token == "git-token"


def test_resolve_falls_back_to_the_environment(tmp_path: Path) -> None:
    credential = resolve(
        env={"GITHUB_PERSONAL_ACCESS_TOKEN": "env-token"},
        export_path=tmp_path / "missing.json",
        socket_path=None,
        git_resolver=lambda _socket: None,
    )

    assert credential.source == "environment"
    assert credential.token == "env-token"


def test_resolve_without_any_source_reports_the_sign_in_command(
    tmp_path: Path,
) -> None:
    with pytest.raises(CredentialError) as excinfo:
        resolve(
            env={},
            export_path=tmp_path / "missing.json",
            socket_path=None,
            git_resolver=lambda _socket: None,
        )

    message = str(excinfo.value)
    assert "fortress.githubSignIn" in message
    assert "Sign in to GitHub" in message
    assert "vscode-github-token.py check" in message


def test_resolve_probes_each_discovered_socket_until_one_answers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stale = tmp_path / "stale.sock"
    live = tmp_path / "live.sock"
    monkeypatch.setattr(
        vscode_github_token, "find_ipc_sockets", lambda _env: [stale, live]
    )
    probed: list[Path] = []

    def git_resolver(candidate: Path) -> Credential | None:
        probed.append(candidate)
        if candidate == live:
            return Credential(token="git-token", source="vscode-git-credential")
        return None

    credential = resolve(
        env={},
        export_path=tmp_path / "missing.json",
        git_resolver=git_resolver,
    )

    assert probed == [stale, live]
    assert credential.source == "vscode-git-credential"


def test_find_ipc_sockets_returns_real_sockets_newest_first(tmp_path: Path) -> None:
    stale = tmp_path / "vscode-remote-containers-ipc-old.sock"
    live = tmp_path / "vscode-remote-containers-ipc-new.sock"
    regular = tmp_path / "vscode-remote-containers-ipc-file.sock"
    regular.write_text("not a socket", encoding="utf-8")
    servers = [socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) for _ in range(2)]
    try:
        servers[0].bind(str(stale))
        servers[1].bind(str(live))
        os.utime(stale, (1000, 1000))
        os.utime(live, (2000, 2000))

        sockets = vscode_github_token.find_ipc_sockets({}, tmp_root=tmp_path)
    finally:
        for server in servers:
            server.close()

    assert sockets == [live, stale]
    assert regular not in sockets


def test_resolve_from_git_credential_disables_askpass_routes(
    tmp_path: Path,
) -> None:
    captured: dict[str, object] = {}

    def runner(command: list[str], **kwargs: object) -> SimpleNamespace:
        captured["command"] = command
        captured["env"] = kwargs["env"]
        return SimpleNamespace(returncode=1, stdout="")

    credential = resolve_from_git_credential(
        tmp_path / "example.sock",
        env={"GIT_ASKPASS": "wrapper", "SSH_ASKPASS": "helper"},
        runner=runner,
    )

    assert credential is None
    assert captured["command"][:4] == ["git", "-c", "core.askPass=", "credential"]
    env = captured["env"]
    assert isinstance(env, dict)
    assert "GIT_ASKPASS" not in env
    assert "SSH_ASKPASS" not in env
    assert env["GIT_TERMINAL_PROMPT"] == "0"


def test_resolve_from_environment_ignores_an_empty_token() -> None:
    assert resolve_from_environment({"GITHUB_PERSONAL_ACCESS_TOKEN": "  "}) is None


def test_parse_git_credential_reads_the_password() -> None:
    output = "protocol=https\nhost=github.com\nusername=x\npassword=secret\n"

    assert parse_git_credential(output) == "secret"


def test_parse_git_credential_rejects_a_missing_password() -> None:
    assert parse_git_credential("protocol=https\nhost=github.com\n") is None


def test_parse_git_credential_ignores_malformed_lines() -> None:
    output = "protocol=https\nalias\nfoo=bar\npassword=secret\n"

    assert parse_git_credential(output) == "secret"


def test_validate_does_not_echo_a_malformed_header_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def explode(*_args: object, **_kwargs: object) -> object:
        raise ValueError("Invalid header value b'Bearer super-secret-token'")

    monkeypatch.setattr(vscode_github_token.urllib.request, "urlopen", explode)

    with pytest.raises(CredentialError) as excinfo:
        validate(Credential(token="super-secret-token", source="vscode-bridge"))

    assert "super-secret-token" not in str(excinfo.value)


def test_validate_reports_the_login_and_scopes() -> None:
    def user_lookup(credential: Credential) -> tuple[str, tuple[str, ...]]:
        assert credential.token == "secret"
        return "wallstop", ("repo", "workflow")

    result = validate(
        Credential(token="secret", source="vscode-bridge"),
        user_lookup=user_lookup,
    )

    assert result == Validation(login="wallstop", scopes=("repo", "workflow"))


def test_main_check_prints_metadata_and_never_the_token(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    credential = Credential(
        token="super-secret",
        source="vscode-bridge",
        account="wallstop",
        scopes=("repo",),
    )
    monkeypatch.setattr(vscode_github_token, "resolve", lambda **_kwargs: credential)
    monkeypatch.setattr(
        vscode_github_token,
        "validate",
        lambda _credential: Validation(login="wallstop", scopes=("repo",)),
    )

    exit_code = main(["check"])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "super-secret" not in captured.out + captured.err
    assert "source=vscode-bridge" in captured.out
    assert "login=wallstop" in captured.out
    assert "scopes=repo" in captured.out


def test_main_askpass_prints_only_the_token(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        vscode_github_token,
        "resolve",
        lambda **_kwargs: Credential(token="super-secret", source="vscode-bridge"),
    )

    exit_code = main(["askpass", "Password for 'https://github.com':"])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.out == "super-secret\n"
    assert captured.err == ""


def test_main_askpass_returns_a_non_secret_username(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        vscode_github_token,
        "resolve",
        lambda **_kwargs: Credential(token="super-secret", source="vscode-bridge"),
    )

    exit_code = main(["askpass", "Username for 'https://github.com':"])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.out == "x-access-token\n"


def test_main_askpass_rejects_a_non_github_prompt_without_resolving(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    resolved: list[object] = []

    def resolve_spy(**_kwargs: object) -> Credential:
        resolved.append(object())
        return Credential(token="super-secret", source="vscode-bridge")

    monkeypatch.setattr(vscode_github_token, "resolve", resolve_spy)

    exit_code = main(["askpass", "Password for 'https://example.com':"])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out == ""
    assert "https://github.com" in captured.err
    assert resolved == []


def test_main_askpass_rejects_plain_http(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        vscode_github_token,
        "resolve",
        lambda **_kwargs: Credential(token="super-secret", source="vscode-bridge"),
    )

    exit_code = main(["askpass", "Password for 'http://github.com':"])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out == ""


def test_main_exec_injects_the_token_into_the_child_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> SimpleNamespace:
        captured["command"] = command
        captured["env"] = kwargs["env"]
        return SimpleNamespace(returncode=7)

    monkeypatch.setattr(
        vscode_github_token,
        "resolve",
        lambda **_kwargs: Credential(token="super-secret", source="vscode-bridge"),
    )
    monkeypatch.setattr(vscode_github_token.subprocess, "run", fake_run)

    exit_code = main(["exec", "--", "opencode", "run"])

    assert exit_code == 7
    assert captured["command"] == ["opencode", "run"]
    env = captured["env"]
    assert isinstance(env, dict)
    assert env["GITHUB_PERSONAL_ACCESS_TOKEN"] == "super-secret"


def test_main_exec_reports_a_missing_command_without_a_traceback(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        vscode_github_token,
        "resolve",
        lambda **_kwargs: Credential(token="super-secret", source="vscode-bridge"),
    )

    def missing(command: list[str], **_kwargs: object) -> SimpleNamespace:
        raise FileNotFoundError(2, "No such file or directory", command[0])

    monkeypatch.setattr(vscode_github_token.subprocess, "run", missing)

    exit_code = main(["exec", "--", "missing-command"])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "cannot run missing-command" in captured.err
    assert "Traceback" not in captured.err


def test_main_check_reports_a_missing_session_with_exit_code_one(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def fail(**_kwargs: object) -> Credential:
        raise CredentialError(
            "no VS Code GitHub connector credential found; "
            "run 'Fortress: Sign in to GitHub' in VS Code (command fortress.githubSignIn)"
        )

    monkeypatch.setattr(vscode_github_token, "resolve", fail)

    exit_code = main(["check"])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "fortress.githubSignIn" in captured.err


def test_main_check_reports_a_rejected_token_without_leaking_it(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        vscode_github_token,
        "resolve",
        lambda **_kwargs: Credential(token="super-secret", source="environment"),
    )

    def reject(_credential: Credential) -> Validation:
        raise CredentialError("GitHub rejected the credential: HTTP 401")

    monkeypatch.setattr(vscode_github_token, "validate", reject)

    exit_code = main(["check"])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "HTTP 401" in captured.err
    assert "super-secret" not in captured.out + captured.err

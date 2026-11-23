#!/usr/bin/env python3
"""Unit tests for scripts/ci/session-budget.py."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

scripts_dir = Path(__file__).parent.parent
spec = importlib.util.spec_from_file_location(
    "session_budget",
    scripts_dir / "ci" / "session-budget.py",
)
assert spec is not None
assert spec.loader is not None
session_budget = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = session_budget
spec.loader.exec_module(session_budget)

START = datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)


def test_start_writes_state_and_expiry(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"

    state = session_budget.start("session-1", 180, now=START, path=path)

    assert state["session_id"] == "session-1"
    assert state["started_at"] == "2026-11-23T12:00:00Z"
    assert state["expires_at"] == "2026-11-23T15:00:00Z"
    assert session_budget.load(path) == state


def test_repeated_start_preserves_the_deadline(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    first = session_budget.start("session-1", 180, now=START, path=path)

    second = session_budget.start(
        "session-1", 180, now=START + timedelta(minutes=60), path=path
    )

    assert second == first
    assert second["expires_at"] == "2026-11-23T15:00:00Z"


def test_start_does_not_reset_an_expired_same_session(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    first = session_budget.start("session-1", 180, now=START, path=path)

    second = session_budget.start(
        "session-1", 180, now=START + timedelta(minutes=200), path=path
    )

    assert second == first
    assert second["expires_at"] == "2026-11-23T15:00:00Z"


def test_start_rejects_another_active_session(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    with pytest.raises(
        session_budget.BudgetError, match="already has an active budget"
    ):
        session_budget.start(
            "session-2", 180, now=START + timedelta(minutes=5), path=path
        )


def test_start_replaces_an_expired_budget(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    state = session_budget.start(
        "session-2", 180, now=START + timedelta(minutes=181), path=path
    )

    assert state["session_id"] == "session-2"
    assert state["expires_at"] == "2026-11-23T18:01:00Z"


def test_concurrent_starts_create_one_budget(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    barrier = threading.Barrier(2)
    results: list[tuple[str, object]] = []

    def worker(session_id: str) -> None:
        barrier.wait()
        try:
            results.append(
                ("ok", session_budget.start(session_id, 180, now=START, path=path))
            )
        except session_budget.BudgetError as exc:
            results.append(("error", str(exc)))

    threads = [
        threading.Thread(target=worker, args=(f"session-{index}",))
        for index in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len([result for result, _ in results if result == "ok"]) == 1
    assert len([result for result, _ in results if result == "error"]) == 1


def test_concurrent_expired_replacements_leave_one_winner(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("old-session", 180, now=START, path=path)
    replacement_now = START + timedelta(minutes=181)
    barrier = threading.Barrier(2)
    results: list[tuple[str, object]] = []

    def worker(session_id: str) -> None:
        barrier.wait()
        try:
            results.append(
                (
                    "ok",
                    session_budget.start(
                        session_id, 180, now=replacement_now, path=path
                    ),
                )
            )
        except session_budget.BudgetError as exc:
            results.append(("error", str(exc)))

    threads = [
        threading.Thread(target=worker, args=(f"session-{index}",))
        for index in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len([result for result, _ in results if result == "ok"]) == 1
    assert len([result for result, _ in results if result == "error"]) == 1
    stored = session_budget.load(path)
    assert stored["session_id"] in {"session-0", "session-1"}


def test_stale_lock_is_recovered(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    lock_path = path.with_name(f".{path.name}.lock")
    lock_path.write_text("stale", encoding="utf-8")
    old = time.time() - 120
    os.utime(lock_path, (old, old))

    state = session_budget.start("session-1", 180, now=START, path=path)

    assert state["session_id"] == "session-1"
    assert not lock_path.exists()


def test_check_reports_remaining_minutes(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    state, remaining = session_budget.check(
        now=START + timedelta(minutes=60), path=path
    )

    assert state["session_id"] == "session-1"
    assert remaining == pytest.approx(120.0)


def test_check_reports_expired(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    _, remaining = session_budget.check(now=START + timedelta(minutes=181), path=path)

    assert remaining < 0


def test_check_missing_budget_fails(tmp_path: Path) -> None:
    with pytest.raises(session_budget.BudgetError, match="cannot read"):
        session_budget.check(path=tmp_path / "missing.json")


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        json.dumps([]),
        json.dumps({"session_id": "s"}),
        json.dumps(
            {
                "session_id": "s",
                "started_at": "2026-11-23T12:00:00Z",
                "expires_at": "2026-11-23T15:00:00Z",
                "minutes": 181,
            }
        ),
        json.dumps(
            {
                "session_id": "s",
                "started_at": "2026-11-23T12:00:00",
                "expires_at": "2026-11-23T15:00:00Z",
                "minutes": 180,
            }
        ),
    ],
)
def test_check_malformed_budget_fails(tmp_path: Path, payload: str) -> None:
    path = tmp_path / "budget.json"
    path.write_text(payload, encoding="utf-8")

    with pytest.raises(session_budget.BudgetError):
        session_budget.check(path=path)


def test_check_rejects_expiry_beyond_configured_minutes(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    path.write_text(
        json.dumps(
            {
                "session_id": "session-1",
                "started_at": "2026-11-23T12:00:00Z",
                "expires_at": "2026-11-24T12:00:00Z",
                "minutes": 180,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(session_budget.BudgetError, match="more than the configured"):
        session_budget.check(path=path)


def test_check_rejects_expiry_before_start(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    path.write_text(
        json.dumps(
            {
                "session_id": "session-1",
                "started_at": "2026-11-23T12:00:00Z",
                "expires_at": "2026-11-23T11:00:00Z",
                "minutes": 180,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(session_budget.BudgetError, match="must be after"):
        session_budget.check(path=path)


def test_check_invalid_utf8_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    path.write_bytes(b"\xff\xfe\x00")

    with pytest.raises(session_budget.BudgetError, match="cannot read"):
        session_budget.check(path=path)


@pytest.mark.parametrize("minutes", [0, 181])
def test_start_rejects_out_of_range_minutes(tmp_path: Path, minutes: int) -> None:
    with pytest.raises(session_budget.BudgetError, match="between"):
        session_budget.start("session-1", minutes, now=START, path=tmp_path / "b.json")


def test_start_rejects_empty_id(tmp_path: Path) -> None:
    with pytest.raises(session_budget.BudgetError, match="session id"):
        session_budget.start(" ", 180, now=START, path=tmp_path / "b.json")


def test_close_removes_state(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    assert session_budget.close(path) is True
    assert not path.exists()
    assert session_budget.close(path) is False


def test_cli_check_json_before_expiry_returns_zero(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, path=path)

    exit_code = session_budget.main(["check", "--state", str(path), "--json"])

    assert exit_code == 0
    assert json.loads(capsys.readouterr().out)["expired"] is False


def test_cli_check_reports_expired(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "budget.json"
    now = session_budget.utc_now()
    path.write_text(
        json.dumps(
            {
                "session_id": "session-1",
                "started_at": session_budget._format_time(now - timedelta(hours=2)),
                "expires_at": session_budget._format_time(now - timedelta(hours=1)),
                "minutes": 180,
            }
        ),
        encoding="utf-8",
    )

    exit_code = session_budget.main(["check", "--state", str(path), "--json"])

    assert exit_code == 2
    assert json.loads(capsys.readouterr().out)["expired"] is True


def test_cli_round_trip(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "budget.json"

    assert (
        session_budget.main(
            ["start", "--id", "session-1", "--minutes", "180", "--state", str(path)]
        )
        == 0
    )
    assert "session-1" in capsys.readouterr().out
    assert session_budget.main(["check", "--state", str(path)]) == 0
    assert "remaining" in capsys.readouterr().out
    assert session_budget.main(["close", "--state", str(path)]) == 0
    assert "budget removed" in capsys.readouterr().out

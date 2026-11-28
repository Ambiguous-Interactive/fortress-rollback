#!/usr/bin/env python3
"""Unit tests for scripts/ci/session-budget.py."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
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


def test_repeated_start_preserves_the_deadline_and_refreshes_activity(
    tmp_path: Path,
) -> None:
    path = tmp_path / "budget.json"
    first = session_budget.start("session-1", 180, now=START, path=path)

    second = session_budget.start(
        "session-1", 180, now=START + timedelta(minutes=60), path=path
    )

    assert second["started_at"] == first["started_at"]
    assert second["expires_at"] == "2026-11-23T15:00:00Z"
    assert second["updated_at"] == "2026-11-23T13:00:00Z"


def test_start_does_not_reset_an_expired_same_session(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    first = session_budget.start("session-1", 180, now=START, path=path)

    second = session_budget.start(
        "session-1", 180, now=START + timedelta(minutes=200), path=path
    )

    assert second["started_at"] == first["started_at"]
    assert second["expires_at"] == "2026-11-23T15:00:00Z"
    assert second["updated_at"] == "2026-11-23T15:20:00Z"


def test_start_same_session_tolerates_a_backward_clock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    monkeypatch.setattr(session_budget, "utc_now", lambda: START)
    first = session_budget.start("session-1", 180, now=START, path=path)

    rolled_back = START - timedelta(minutes=2)
    monkeypatch.setattr(session_budget, "utc_now", lambda: rolled_back)
    second = session_budget.start("session-1", 180, now=rolled_back, path=path)

    assert second["started_at"] == first["started_at"]
    assert second["expires_at"] == "2026-11-23T15:00:00Z"
    assert second["updated_at"] == "2026-11-23T12:00:00Z"


def test_start_rejects_a_future_timestamp_for_another_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    path.write_text(
        json.dumps(
            {
                "session_id": "session-1",
                "started_at": "2026-11-23T12:00:00Z",
                "expires_at": "2026-11-23T15:00:00Z",
                "updated_at": "2026-11-23T12:10:00Z",
                "minutes": 180,
                "max_prs": 2,
                "prs": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(session_budget, "utc_now", lambda: START)

    with pytest.raises(session_budget.BudgetError, match="future"):
        session_budget.start("session-2", 180, now=START, path=path)

    recovered = session_budget.start("session-1", 180, now=START, path=path)
    assert recovered["session_id"] == "session-1"
    assert recovered["updated_at"] == "2026-11-23T12:10:00Z"


def test_start_rejects_a_recently_active_session(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    with pytest.raises(
        session_budget.BudgetError, match="already has an active budget"
    ):
        session_budget.start(
            "session-2", 180, now=START + timedelta(minutes=1), path=path
        )


def test_start_takes_over_after_the_handoff_window(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    state = session_budget.start(
        "session-2", 180, now=START + timedelta(minutes=6), path=path
    )

    assert state["session_id"] == "session-2"
    assert state["started_at"] == "2026-11-23T12:06:00Z"


def test_start_takeover_replaces_a_recent_active_session(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    state = session_budget.start(
        "session-2",
        180,
        now=START + timedelta(minutes=1),
        takeover=True,
        path=path,
    )

    assert state["session_id"] == "session-2"


def test_start_rejects_an_invalid_handoff(tmp_path: Path) -> None:
    with pytest.raises(session_budget.BudgetError, match="handoff"):
        session_budget.start(
            "session-1",
            180,
            now=START,
            handoff=timedelta(minutes=61),
            path=tmp_path / "budget.json",
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


def test_lock_directory_is_reusable_after_a_crash(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    lock_dir.mkdir()
    owner = lock_dir / "owner"
    owner.write_text("stale", encoding="utf-8")
    old = time.time() - 120
    os.utime(owner, (old, old))

    state = session_budget.start("session-1", 180, now=START, path=path)

    assert state["session_id"] == "session-1"
    assert not lock_dir.exists()
    assert session_budget.close("session-1", path) is True


def test_lock_does_not_steal_a_live_owner(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    lock_dir.mkdir()
    (lock_dir / "owner").write_text("other", encoding="utf-8")

    with pytest.raises(session_budget.BudgetError, match="another session"):
        with session_budget._state_lock(path, timeout=0.1):
            pass

    assert lock_dir.exists()
    assert (lock_dir / "owner").read_text(encoding="utf-8") == "other"


def test_lock_retries_when_a_reaper_moves_the_directory_before_owner_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    owner = lock_dir / "owner"
    real_open = os.open
    reaped = False

    def reaping_open(
        target: str | os.PathLike[str],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal reaped
        if Path(target) == owner and not reaped:
            reaped = True
            # A reaper observed the previous stale lock and renames the
            # directory after this writer's mkdir but before its owner
            # publication. The fresh directory disappears under us.
            shutil.rmtree(lock_dir)
            raise FileNotFoundError(2, "No such file or directory", str(target))
        return real_open(target, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(session_budget.os, "open", reaping_open)

    with session_budget._state_lock(path) as fence:
        fence()
        assert owner.read_text(encoding="utf-8")

    assert reaped
    assert not lock_dir.exists()


def test_lock_owner_publication_retry_is_deadline_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    owner = lock_dir / "owner"
    real_open = os.open

    def always_reaped_open(
        target: str | os.PathLike[str],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        if Path(target) == owner:
            shutil.rmtree(lock_dir, ignore_errors=True)
            raise FileNotFoundError(2, "No such file or directory", str(target))
        return real_open(target, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(session_budget.os, "open", always_reaped_open)

    try:
        with pytest.raises(
            session_budget.BudgetError, match="cannot acquire"
        ) as excinfo:
            with session_budget._state_lock(path, timeout=0.1):
                pass
    finally:
        shutil.rmtree(lock_dir, ignore_errors=True)

    # A persistent missing directory is a filesystem failure, not contention,
    # and the carried cause names the problem.
    assert "another session" not in str(excinfo.value)
    assert "No such file or directory" in str(excinfo.value)


def test_lock_does_not_steal_a_competing_owner_after_a_reap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    owner = lock_dir / "owner"
    real_open = os.open
    reaped = False

    def competing_open(
        target: str | os.PathLike[str],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal reaped
        if Path(target) == owner and not reaped:
            reaped = True
            shutil.rmtree(lock_dir, ignore_errors=True)
            try:
                real_open(target, flags, mode, dir_fd=dir_fd)
            except FileNotFoundError as exc:
                # A competing session wins the free path before our retry.
                # The retry must wait for the live owner instead of stealing it.
                lock_dir.mkdir()
                (lock_dir / "owner").write_text("competitor", encoding="utf-8")
                raise exc
            raise AssertionError("expected the owner publication to fail")
        return real_open(target, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(session_budget.os, "open", competing_open)

    try:
        with pytest.raises(session_budget.BudgetError, match="another session"):
            with session_budget._state_lock(path, timeout=0.1):
                pass
        assert reaped
        assert (lock_dir / "owner").read_text(encoding="utf-8") == "competitor"
    finally:
        shutil.rmtree(lock_dir, ignore_errors=True)


def test_lock_recreates_a_state_directory_removed_during_acquisition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "state" / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    real_mkdir = os.mkdir
    vanished = False

    def vanishing_mkdir(
        target: str | os.PathLike[str],
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> None:
        nonlocal vanished
        if Path(target) == lock_dir and not vanished:
            vanished = True
            # A caller using a temporary state directory can tear it down
            # between our parent mkdir and the lock mkdir.
            shutil.rmtree(lock_dir.parent)
            raise FileNotFoundError(2, "No such file or directory", str(target))
        real_mkdir(target, mode, dir_fd=dir_fd)

    monkeypatch.setattr(session_budget.os, "mkdir", vanishing_mkdir)

    with session_budget._state_lock(path) as fence:
        fence()
        assert (lock_dir / "owner").is_file()

    assert vanished
    assert not lock_dir.exists()


def test_lock_reports_a_budget_error_when_the_state_directory_cannot_be_recreated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "state" / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    real_mkdir = os.mkdir
    vanished = False

    def unrecoverable_mkdir(
        target: str | os.PathLike[str],
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> None:
        nonlocal vanished
        if Path(target) == lock_dir:
            vanished = True
            shutil.rmtree(lock_dir.parent, ignore_errors=True)
            raise FileNotFoundError(2, "No such file or directory", str(target))
        if vanished:
            raise PermissionError(13, "Permission denied", str(target))
        real_mkdir(target, mode, dir_fd=dir_fd)

    monkeypatch.setattr(session_budget.os, "mkdir", unrecoverable_mkdir)

    with pytest.raises(session_budget.BudgetError, match="cannot create"):
        with session_budget._state_lock(path, timeout=0.1):
            pass


def test_lock_ownerless_dangling_path_sleeps_before_retrying(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    os.symlink(lock_dir.with_name("missing-lock-target"), lock_dir)
    clock = [0.0]
    sleeps: list[float] = []
    calls = 0

    def monotonic() -> float:
        nonlocal calls
        calls += 1
        # Without a sleep the fake clock never advances; fail instead of
        # hanging the suite.
        if calls > 1000:
            raise AssertionError("lock acquisition spun without sleeping")
        return clock[0]

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += seconds

    monkeypatch.setattr(session_budget.time, "monotonic", monotonic)
    monkeypatch.setattr(session_budget.time, "sleep", sleep)

    with pytest.raises(session_budget.BudgetError, match="cannot acquire"):
        with session_budget._state_lock(path, timeout=0.05):
            pass

    # A dangling symlink makes mkdir fail with EEXIST while both stats fail
    # with ENOENT. The retry must sleep instead of spinning on one core.
    assert sleeps
    assert clock[0] >= 0.05


def test_lock_stale_reap_rename_failure_sleeps_before_retrying(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    lock_dir.mkdir()
    owner = lock_dir / "owner"
    owner.write_text("stale", encoding="utf-8")
    old = time.time() - 120
    os.utime(owner, (old, old))
    clock = [0.0]
    sleeps: list[float] = []
    calls = 0
    real_rename = os.rename

    def monotonic() -> float:
        nonlocal calls
        calls += 1
        # Without a sleep the fake clock never advances; fail instead of
        # hanging the suite.
        if calls > 1000:
            raise AssertionError("stale-reap retry spun without sleeping")
        return clock[0]

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += seconds

    def failing_rename(
        source: str | os.PathLike[str], destination: str | os.PathLike[str]
    ) -> None:
        if Path(source) == lock_dir:
            raise PermissionError(13, "Permission denied", str(source))
        real_rename(source, destination)

    monkeypatch.setattr(session_budget.time, "monotonic", monotonic)
    monkeypatch.setattr(session_budget.time, "sleep", sleep)
    monkeypatch.setattr(session_budget.os, "rename", failing_rename)

    with pytest.raises(session_budget.BudgetError, match="cannot acquire") as excinfo:
        with session_budget._state_lock(path, timeout=0.05):
            pass

    # A persistent rename failure must back off instead of spinning on one
    # core, and the deadline error must name the carried cause.
    assert sleeps
    assert clock[0] >= 0.05
    assert "Permission denied" in str(excinfo.value)
    assert lock_dir.exists()
    assert owner.read_text(encoding="utf-8") == "stale"


def test_lock_owner_open_failure_is_a_budget_error_and_removes_its_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    owner = lock_dir / "owner"
    real_open = os.open

    def failing_open(
        target: str | os.PathLike[str],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        if Path(target) == owner:
            raise PermissionError(13, "Permission denied", str(target))
        return real_open(target, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(session_budget.os, "open", failing_open)

    with pytest.raises(
        session_budget.BudgetError, match="session budget lock owner"
    ) as excinfo:
        with session_budget._state_lock(path, timeout=0.1):
            pass

    assert str(owner) in str(excinfo.value)
    assert "Permission denied" in str(excinfo.value)
    assert not lock_dir.exists()


def test_lock_owner_write_failure_removes_the_owned_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    owner = lock_dir / "owner"
    real_fdopen = os.fdopen

    class FailingOwnerWrite:
        def __init__(self, handle: int) -> None:
            self.handle = handle

        def __enter__(self) -> "FailingOwnerWrite":
            return self

        def __exit__(self, *_args: object) -> bool:
            os.close(self.handle)
            return False

        def write(self, _data: str) -> int:
            raise OSError(28, "No space left on device")

    def failing_fdopen(
        handle: int, *args: object, **kwargs: object
    ) -> FailingOwnerWrite:
        return FailingOwnerWrite(handle)

    monkeypatch.setattr(session_budget.os, "fdopen", failing_fdopen)

    with pytest.raises(
        session_budget.BudgetError, match="session budget lock owner"
    ) as excinfo:
        with session_budget._state_lock(path, timeout=0.1):
            pass

    assert str(owner) in str(excinfo.value)
    assert "No space left on device" in str(excinfo.value)
    # A fresh empty owner must not block the next session for the whole stale
    # threshold; the directory created by this acquisition is removed.
    assert not owner.exists()
    assert not lock_dir.exists()

    monkeypatch.setattr(session_budget.os, "fdopen", real_fdopen)
    with session_budget._state_lock(path, timeout=0.1) as fence:
        fence()
    assert not lock_dir.exists()


def test_lock_owner_directory_is_a_budget_error(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    lock_dir.mkdir()
    owner = lock_dir / "owner"
    owner.mkdir()
    old = time.time() - 120
    os.utime(owner, (old, old))

    with pytest.raises(
        session_budget.BudgetError, match="cannot read the session budget lock owner"
    ) as excinfo:
        with session_budget._state_lock(path, timeout=0.1):
            pass

    # A corrupted owner entry must be actionable, not a raw traceback.
    assert str(owner) in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, OSError)
    assert lock_dir.exists()


def test_lock_corrupt_owner_bytes_are_a_budget_error(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    lock_dir.mkdir()
    owner = lock_dir / "owner"
    owner.write_bytes(b"\xff\xfe\xfd")
    old = time.time() - 120
    os.utime(owner, (old, old))

    with pytest.raises(
        session_budget.BudgetError, match="cannot read the session budget lock owner"
    ) as excinfo:
        with session_budget._state_lock(path, timeout=0.1):
            pass

    assert str(owner) in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, UnicodeError)
    assert lock_dir.exists()


def test_lock_owner_open_failure_leaves_a_replacement_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    owner = lock_dir / "owner"
    moved = lock_dir.with_name(f"{lock_dir.name}.moved")
    real_open = os.open
    real_rename = os.rename
    replaced = False

    def reaping_open(
        target: str | os.PathLike[str],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal replaced
        if Path(target) == owner and not replaced:
            replaced = True
            # A reaper moves our fresh directory and a competitor creates a
            # new lock at the same path before publishing its owner, then our
            # owner publication fails.
            real_rename(lock_dir, moved)
            lock_dir.mkdir()
            raise PermissionError(13, "Permission denied", str(target))
        return real_open(target, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(session_budget.os, "open", reaping_open)

    with pytest.raises(
        session_budget.BudgetError, match="session budget lock owner"
    ):
        with session_budget._state_lock(path, timeout=0.1):
            pass

    # Cleanup must never remove a lock directory that now belongs to another
    # writer, even when that writer has not published its owner yet.
    assert lock_dir.is_dir()
    assert not (lock_dir / "owner").exists()
    assert moved.exists()


def test_write_state_fence_rejects_a_lost_lock(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    lock_dir = path.with_name(f"{path.name}.lock")
    moved = lock_dir.with_name(f"{lock_dir.name}.moved")

    with pytest.raises(session_budget.BudgetError, match="lock was lost"):
        with session_budget._state_lock(path) as fence:
            os.rename(lock_dir, moved)
            session_budget._write_state({"session_id": "session-1"}, path, fence)

    assert moved.exists()
    shutil.rmtree(moved)


def test_claim_pr_records_one_and_two_prs(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    first = session_budget.claim_pr(101, "session-1", now=START, path=path)
    second = session_budget.claim_pr(102, "session-1", now=START, path=path)

    assert first["prs"] == [101]
    assert second["prs"] == [101, 102]


def test_claim_pr_refreshes_activity_without_moving_the_deadline(
    tmp_path: Path,
) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    state = session_budget.claim_pr(
        101, "session-1", now=START + timedelta(minutes=30), path=path
    )

    assert state["updated_at"] == "2026-11-23T12:30:00Z"
    assert state["expires_at"] == "2026-11-23T15:00:00Z"


def test_claim_pr_activity_prevents_a_handoff(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)
    session_budget.claim_pr(101, "session-1", now=START + timedelta(minutes=30), path=path)

    with pytest.raises(
        session_budget.BudgetError, match="already has an active budget"
    ):
        session_budget.start(
            "session-2", 180, now=START + timedelta(minutes=33), path=path
        )


def test_claim_pr_is_idempotent_for_the_same_number(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)
    session_budget.claim_pr(101, "session-1", now=START, path=path)

    state = session_budget.claim_pr(101, "session-1", now=START, path=path)

    assert state["prs"] == [101]


def test_claim_pr_rejects_a_third_pr(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)
    session_budget.claim_pr(101, "session-1", now=START, path=path)
    session_budget.claim_pr(102, "session-1", now=START, path=path)

    with pytest.raises(session_budget.BudgetError, match="exhausted"):
        session_budget.claim_pr(103, "session-1", now=START, path=path)


def test_claim_pr_rejects_an_expired_budget(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    with pytest.raises(session_budget.BudgetError, match="expired"):
        session_budget.claim_pr(101, "session-1", now=START + timedelta(minutes=181), path=path)


def test_check_reports_pr_budget_exhaustion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "budget.json"
    monkeypatch.setattr(session_budget, "utc_now", lambda: START)
    session_budget.start("session-1", 180, now=START, path=path)
    session_budget.claim_pr(101, "session-1", now=START, path=path)
    session_budget.claim_pr(102, "session-1", now=START, path=path)

    exit_code = session_budget.main(["check", "--state", str(path), "--json"])

    payload = json.loads(capsys.readouterr().out)
    assert exit_code == 2
    assert payload["expired"] is False
    assert payload["pr_budget_exhausted"] is True
    assert payload["prs"] == [101, 102]


def test_touch_preserves_activity_when_the_clock_moves_back(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    state = session_budget.touch(
        "session-1", now=START - timedelta(seconds=30), path=path
    )

    assert state["updated_at"] == "2026-11-23T12:00:00Z"


def test_claim_pr_preserves_activity_when_the_clock_moves_back(
    tmp_path: Path,
) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    state = session_budget.claim_pr(
        101, "session-1", now=START - timedelta(seconds=30), path=path
    )

    assert state["updated_at"] == "2026-11-23T12:00:00Z"
    assert state["prs"] == [101]


def test_claim_pr_rejects_another_session(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    with pytest.raises(session_budget.BudgetError, match="owns the budget"):
        session_budget.claim_pr(101, "session-2", now=START, path=path)


def test_claim_pr_rejects_a_boolean_number(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    with pytest.raises(session_budget.BudgetError, match="positive"):
        session_budget.claim_pr(True, "session-1", now=START, path=path)


@pytest.mark.parametrize(
    "overrides",
    [
        {"minutes": True},
        {"max_prs": True},
        {"prs": [True]},
    ],
)
def test_load_rejects_boolean_fields(tmp_path: Path, overrides: dict) -> None:
    path = tmp_path / "budget.json"
    state = {
        "session_id": "session-1",
        "started_at": "2026-11-23T12:00:00Z",
        "expires_at": "2026-11-23T15:00:00Z",
        "updated_at": "2026-11-23T12:00:00Z",
        "minutes": 180,
        "max_prs": 2,
        "prs": [],
    }
    state.update(overrides)
    path.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(session_budget.BudgetError):
        session_budget.load(path, now=START)


def test_load_rejects_boolean_minutes(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    path.write_text(
        json.dumps(
            {
                "session_id": "session-1",
                "started_at": "2026-11-23T12:00:00Z",
                "expires_at": "2026-11-23T15:00:00Z",
                "minutes": True,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(session_budget.BudgetError, match="minutes"):
        session_budget.load(path, now=START)


def test_start_rejects_a_boolean_minutes_value(tmp_path: Path) -> None:
    with pytest.raises(session_budget.BudgetError, match="integer"):
        session_budget.start(
            "session-1", True, now=START, path=tmp_path / "budget.json"
        )


def test_load_defaults_pr_fields_for_legacy_state(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    path.write_text(
        json.dumps(
            {
                "session_id": "session-1",
                "started_at": "2026-11-23T12:00:00Z",
                "expires_at": "2026-11-23T15:00:00Z",
                "minutes": 180,
            }
        ),
        encoding="utf-8",
    )

    state = session_budget.load(path)

    assert state["max_prs"] == 2
    assert state["prs"] == []
    assert state["updated_at"] == "2026-11-23T12:00:00Z"


def test_load_rejects_updated_at_before_start(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    path.write_text(
        json.dumps(
            {
                "session_id": "session-1",
                "started_at": "2026-11-23T12:00:00Z",
                "expires_at": "2026-11-23T15:00:00Z",
                "updated_at": "2026-11-23T11:00:00Z",
                "minutes": 180,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(session_budget.BudgetError, match="updated_at"):
        session_budget.load(path, now=START)


def test_load_rejects_future_updated_at(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    path.write_text(
        json.dumps(
            {
                "session_id": "session-1",
                "started_at": "2026-11-23T12:00:00Z",
                "expires_at": "2026-11-23T15:00:00Z",
                "updated_at": "2026-11-23T13:00:00Z",
                "minutes": 180,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(session_budget.BudgetError, match="future"):
        session_budget.load(path, now=START)


def test_touch_records_activity_without_moving_the_deadline(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    state = session_budget.touch(
        "session-1", now=START + timedelta(minutes=30), path=path
    )

    assert state["updated_at"] == "2026-11-23T12:30:00Z"
    assert state["started_at"] == "2026-11-23T12:00:00Z"
    assert state["expires_at"] == "2026-11-23T15:00:00Z"


def test_touch_rejects_another_session(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    with pytest.raises(session_budget.BudgetError, match="owns the budget"):
        session_budget.touch("session-2", now=START, path=path)


def test_start_rejects_invalid_max_prs(tmp_path: Path) -> None:
    with pytest.raises(session_budget.BudgetError, match="max_prs"):
        session_budget.start(
            "session-1", 180, 3, now=START, path=tmp_path / "budget.json"
        )


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

    assert session_budget.close("session-1", path) is True
    assert not path.exists()
    assert session_budget.close("session-1", path) is False


def test_close_rejects_another_session(tmp_path: Path) -> None:
    path = tmp_path / "budget.json"
    session_budget.start("session-1", 180, now=START, path=path)

    with pytest.raises(session_budget.BudgetError, match="owns the budget"):
        session_budget.close("session-2", path)

    assert path.exists()
    assert session_budget.close("session-1", path) is True


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
    assert session_budget.main(["close", "--id", "session-1", "--state", str(path)]) == 0
    assert "budget removed" in capsys.readouterr().out

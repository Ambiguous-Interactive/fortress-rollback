#!/usr/bin/env python3
"""Unit tests for scripts/ci/check-session-pr-budget.py."""

from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

scripts_dir = Path(__file__).parent.parent
spec = importlib.util.spec_from_file_location(
    "check_session_pr_budget",
    scripts_dir / "ci" / "check-session-pr-budget.py",
)
assert spec is not None
assert spec.loader is not None
check_session_pr_budget = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_session_pr_budget
spec.loader.exec_module(check_session_pr_budget)

START = datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)


def marker(started: datetime, session_id: str = "session-1") -> str:
    value = started.isoformat().replace("+00:00", "Z")
    return f"<!-- session: {session_id} started: {value} -->"


def pr(
    number: int,
    created: datetime,
    *,
    author: str = "wallstop",
    started: datetime = START,
    session_id: str = "session-1",
) -> dict:
    return {
        "number": number,
        "created_at": created.isoformat().replace("+00:00", "Z"),
        "user": {"login": author},
        "body": marker(started, session_id),
    }


def test_two_prs_in_the_window_pass() -> None:
    first = pr(101, START + timedelta(minutes=10))
    second = pr(102, START + timedelta(minutes=20))

    summary = check_session_pr_budget.evaluate_session_budget(second, [first, second])

    assert summary["prs"] == [101, 102]
    assert summary["max_prs"] == 2


def test_third_pr_in_the_window_fails() -> None:
    first = pr(101, START + timedelta(minutes=10))
    second = pr(102, START + timedelta(minutes=20))
    third = pr(103, START + timedelta(minutes=30))

    with pytest.raises(check_session_pr_budget.BudgetError, match="maximum is 2"):
        check_session_pr_budget.evaluate_session_budget(third, [first, second, third])


def test_pr_outside_the_window_is_ignored() -> None:
    old = pr(100, START - timedelta(hours=4))
    first = pr(101, START + timedelta(minutes=10))
    second = pr(102, START + timedelta(minutes=20))

    summary = check_session_pr_budget.evaluate_session_budget(
        second, [old, first, second]
    )

    assert summary["prs"] == [101, 102]


def test_other_session_ids_still_count_toward_the_limit() -> None:
    first = pr(100, START + timedelta(minutes=5), session_id="session-0")
    second = pr(101, START + timedelta(minutes=20), session_id="session-1")
    third = pr(102, START + timedelta(minutes=30), session_id="session-2")

    with pytest.raises(check_session_pr_budget.BudgetError, match="maximum is 2"):
        check_session_pr_budget.evaluate_session_budget(
            third, [first, second, third]
        )


def test_carried_over_pr_is_remarked_by_a_new_session() -> None:
    created = START + timedelta(minutes=10)
    current = pr(
        101,
        created,
        started=START + timedelta(hours=2),
        session_id="session-2",
    )

    summary = check_session_pr_budget.evaluate_session_budget(
        current, [current], now=START + timedelta(hours=2)
    )

    assert summary["session_id"] == "session-2"
    assert summary["prs"] == [101]


def test_session_start_in_the_future_fails() -> None:
    current = pr(
        101,
        START + timedelta(minutes=10),
        started=START + timedelta(hours=2),
    )

    with pytest.raises(check_session_pr_budget.BudgetError, match="future"):
        check_session_pr_budget.evaluate_session_budget(
            current, [current], now=START
        )


def test_other_authors_are_ignored() -> None:
    bot = pr(101, START + timedelta(minutes=10), author="dependabot[bot]")
    first = pr(102, START + timedelta(minutes=20))
    second = pr(103, START + timedelta(minutes=30))

    summary = check_session_pr_budget.evaluate_session_budget(
        second, [bot, first, second]
    )

    assert summary["prs"] == [102, 103]


def test_pr_opened_after_three_hours_fails() -> None:
    late = pr(101, START + timedelta(hours=3, minutes=1))

    with pytest.raises(
        check_session_pr_budget.BudgetError, match="after the session start"
    ):
        check_session_pr_budget.evaluate_session_budget(late, [late])


def test_missing_marker_fails() -> None:
    current = pr(101, START + timedelta(minutes=10))
    current["body"] = "no marker"

    with pytest.raises(check_session_pr_budget.BudgetError, match="missing"):
        check_session_pr_budget.evaluate_session_budget(current, [current])


def test_carried_over_pr_keeps_the_original_creation_time_in_the_rolling_count() -> None:
    carried = pr(
        100,
        START + timedelta(minutes=10),
        started=START + timedelta(hours=2),
        session_id="session-2",
    )
    second = pr(101, START + timedelta(minutes=20))
    third = pr(102, START + timedelta(minutes=30))

    with pytest.raises(check_session_pr_budget.BudgetError, match="maximum is 2"):
        check_session_pr_budget.evaluate_session_budget(
            third,
            [carried, second, third],
            now=START + timedelta(hours=2),
        )


def test_malformed_timestamp_fails() -> None:
    current = pr(101, START + timedelta(minutes=10))
    current["body"] = "<!-- session: session-1 started: not-a-time -->"

    with pytest.raises(check_session_pr_budget.BudgetError, match="ISO-8601"):
        check_session_pr_budget.evaluate_session_budget(current, [current])


def test_current_pr_is_counted_when_the_api_list_omits_it() -> None:
    first = pr(101, START + timedelta(minutes=10))
    second = pr(102, START + timedelta(minutes=20))

    summary = check_session_pr_budget.evaluate_session_budget(second, [first])

    assert summary["prs"] == [101, 102]


def test_invalid_window_is_rejected() -> None:
    current = pr(101, START + timedelta(minutes=10))

    with pytest.raises(check_session_pr_budget.BudgetError, match="window"):
        check_session_pr_budget.evaluate_session_budget(
            current, [current], window=timedelta(hours=4)
        )

#!/usr/bin/env python3
"""Unit tests for scripts/hooks/check-plan-hygiene.py."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

scripts_dir = Path(__file__).parent.parent
spec = importlib.util.spec_from_file_location(
    "check_plan_hygiene",
    scripts_dir / "hooks" / "check-plan-hygiene.py",
)
check_plan_hygiene = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_plan_hygiene
spec.loader.exec_module(check_plan_hygiene)

MAX_LINES = check_plan_hygiene.MAX_LINES
MAX_WORDS = check_plan_hygiene.MAX_WORDS
check_plan = check_plan_hygiene.check_plan
main = check_plan_hygiene.main


def test_active_plan_passes(tmp_path: Path) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text(
        "# Project Plan\n\n"
        "## In progress\n\n"
        "- [ ] Fix the active hypothesis. "
        "Claimed: session-1 2026-11-23T12:00Z. "
        "Expires: 2026-11-23T15:00Z. "
        "Exit: the regression passes.\n",
        encoding="utf-8",
    )

    assert check_plan(plan) == []


def test_no_in_progress_item_passes(tmp_path: Path) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text(
        "# Project Plan\n\n## In progress\n\n_None._\n",
        encoding="utf-8",
    )

    assert check_plan(plan) == []


def test_multiple_in_progress_items_fail(tmp_path: Path) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text(
        "# Project Plan\n\n"
        "## In progress\n\n"
        "- [ ] First. Claimed: s 2026-11-23T12:00Z. Expires: 2026-11-23T15:00Z. Exit: x.\n"
        "- [ ] Second. Claimed: s 2026-11-23T12:00Z. Expires: 2026-11-23T15:00Z. Exit: y.\n",
        encoding="utf-8",
    )

    issues = check_plan(plan)

    assert any("In progress has 2 items" in issue for issue in issues)


@pytest.mark.parametrize("missing", ["Claimed:", "Expires:", "Exit:"])
def test_in_progress_item_requires_claim_fields(
    tmp_path: Path, missing: str
) -> None:
    fields = {
        "Claimed:": "Claimed: session-1 2026-11-23T12:00Z.",
        "Expires:": "Expires: 2026-11-23T15:00Z.",
        "Exit:": "Exit: the regression passes.",
    }
    line = "- [ ] Fix the active hypothesis. " + " ".join(
        value for key, value in fields.items() if key != missing
    )
    plan = tmp_path / "PLAN.md"
    plan.write_text(
        f"# Project Plan\n\n## In progress\n\n{line}\n",
        encoding="utf-8",
    )

    issues = check_plan(plan)

    assert any("In progress item needs" in issue for issue in issues)


def test_claim_ttl_over_three_hours_fails(tmp_path: Path) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text(
        "# Project Plan\n\n## In progress\n\n"
        "- [ ] Fix. Claimed: session-1 2026-11-23T12:00Z. "
        "Expires: 2026-11-23T15:01Z. Exit: x.\n",
        encoding="utf-8",
    )

    issues = check_plan(plan)

    assert any("claim TTL is 181 minutes" in issue for issue in issues)


def test_claim_expiry_must_follow_claim(tmp_path: Path) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text(
        "# Project Plan\n\n## In progress\n\n"
        "- [ ] Fix. Claimed: session-1 2026-11-23T12:00Z. "
        "Expires: 2026-11-23T12:00Z. Exit: x.\n",
        encoding="utf-8",
    )

    issues = check_plan(plan)

    assert any("Expires must be after Claimed" in issue for issue in issues)


def test_claim_timestamp_requires_offset(tmp_path: Path) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text(
        "# Project Plan\n\n## In progress\n\n"
        "- [ ] Fix. Claimed: session-1 2026-11-23T12:00. "
        "Expires: 2026-11-23T15:00. Exit: x.\n",
        encoding="utf-8",
    )

    issues = check_plan(plan)

    assert any("Claimed timestamp must include a UTC offset" in issue for issue in issues)


def test_line_budget_rejects_bloated_plan(tmp_path: Path) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text("\n".join("line" for _ in range(MAX_LINES + 1)), encoding="utf-8")

    issues = check_plan(plan)

    assert len(issues) == 1
    assert f"has {MAX_LINES + 1} lines" in issues[0]


def test_word_budget_rejects_dense_plan(tmp_path: Path) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text("word " * (MAX_WORDS + 1), encoding="utf-8")

    issues = check_plan(plan)

    assert len(issues) == 1
    assert f"has {MAX_WORDS + 1} words" in issues[0]


@pytest.mark.parametrize("marker", ["-", "*", "+", "1.", "2)"])
def test_completed_task_is_rejected(tmp_path: Path, marker: str) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text(f"# Plan\n\n{marker} [x] Shipped work\n", encoding="utf-8")

    issues = check_plan(plan)

    assert len(issues) == 1
    assert "completed task belongs in a progress/session record" in issues[0]


@pytest.mark.parametrize(
    "heading",
    ["Background", "Completed Work", "Context", "History", "Research", "Status"],
)
def test_non_queue_section_is_rejected(tmp_path: Path, heading: str) -> None:
    plan = tmp_path / "PLAN.md"
    plan.write_text(f"# Plan\n\n## {heading.title()}\n", encoding="utf-8")

    issues = check_plan(plan)

    assert len(issues) == 1
    assert "is not an active queue section" in issues[0]


def test_missing_plan_fails_closed(tmp_path: Path) -> None:
    issues = check_plan(tmp_path / "PLAN.md")

    assert len(issues) == 1
    assert ":0: cannot read file:" in issues[0]


def test_hook_skips_intentionally_absent_local_plan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(check_plan_hygiene, "PLAN_PATH", tmp_path / "PLAN.md")

    assert main() == 0

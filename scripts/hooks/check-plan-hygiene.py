#!/usr/bin/env python3
"""Keep PLAN.md limited to active and ordered future work."""

from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path

PLAN_PATH = Path("PLAN.md")
MAX_LINES = 120
MAX_WORDS = 1_000
MAX_CLAIM_SECONDS = 3 * 60 * 60
ALLOWED_SECTIONS = frozenset({"future", "in progress"})
COMPLETED_TASK = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]")
HEADING = re.compile(r"^(#{2,6})\s+(.+?)\s*$")
LIST_ITEM = re.compile(r"^( {0,3})(?:[-*+]|\d+[.)])\s+")
TIMESTAMP = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?"
CLAIM = re.compile(rf"\bClaimed:\s*(\S+)\s+({TIMESTAMP})")
EXPIRES = re.compile(rf"\bExpires:\s*({TIMESTAMP})")
EXIT = re.compile(r"\bExit:\s*\S")


def _display_path(path: Path) -> str:
    """Return a repository-relative path when possible."""
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(path)


def _parse_timestamp(value: str) -> datetime | None:
    """Parse an ISO-8601 timestamp with an explicit offset."""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed


def _in_progress_items(lines: list[str]) -> list[tuple[int, str]]:
    """Return top-level list items in the `In progress` section."""
    in_progress = False
    last_indent: int | None = None
    items: list[tuple[int, str]] = []
    for line_number, line in enumerate(lines, start=1):
        heading = HEADING.match(line)
        if heading is not None and len(heading.group(1)) == 2:
            in_progress = heading.group(2).strip().casefold() == "in progress"
            last_indent = None
            continue
        if not in_progress:
            continue
        match = LIST_ITEM.match(line)
        if match is None:
            continue
        indent = len(match.group(1))
        if last_indent is not None and indent > last_indent:
            continue
        items.append((line_number, line))
        last_indent = indent
    return items


def _check_claim(path: str, line_number: int, line: str) -> list[str]:
    """Validate the claim fields on one in-progress item."""
    issues: list[str] = []
    claim = CLAIM.search(line)
    expires = EXPIRES.search(line)
    if claim is None:
        issues.append(
            f"{path}:{line_number}: In progress item needs "
            "'Claimed: <session> <ISO-8601 timestamp>'"
        )
    if expires is None:
        issues.append(
            f"{path}:{line_number}: In progress item needs "
            "'Expires: <ISO-8601 timestamp>'"
        )
    if EXIT.search(line) is None:
        issues.append(
            f"{path}:{line_number}: In progress item needs 'Exit: <falsifiable criterion>'"
        )
    if claim is None or expires is None:
        return issues

    claimed_at = _parse_timestamp(claim.group(2))
    expires_at = _parse_timestamp(expires.group(1))
    if claimed_at is None:
        issues.append(
            f"{path}:{line_number}: Claimed timestamp must include a UTC offset"
        )
    if expires_at is None:
        issues.append(
            f"{path}:{line_number}: Expires timestamp must include a UTC offset"
        )
    if claimed_at is None or expires_at is None:
        return issues

    ttl_seconds = (expires_at - claimed_at).total_seconds()
    if ttl_seconds <= 0:
        issues.append(f"{path}:{line_number}: Expires must be after Claimed")
    elif ttl_seconds > MAX_CLAIM_SECONDS:
        issues.append(
            f"{path}:{line_number}: claim TTL is {int(ttl_seconds // 60)} minutes; "
            "the maximum is 180"
        )
    return issues


def check_plan(path: Path = PLAN_PATH) -> list[str]:
    """Return actionable plan-hygiene violations."""
    display_path = _display_path(path)
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"{display_path}:0: cannot read file: {exc}"]

    lines = content.splitlines()
    issues: list[str] = []

    if len(lines) > MAX_LINES:
        issues.append(
            f"{display_path}:{MAX_LINES + 1}: PLAN.md has {len(lines)} lines; "
            f"limit active planning to {MAX_LINES} and move detail to its owner"
        )

    word_count = len(content.split())
    if word_count > MAX_WORDS:
        issues.append(
            f"{display_path}:1: PLAN.md has {word_count} words; limit active planning "
            f"to {MAX_WORDS} and move detail to its owner"
        )

    for line_number, line in enumerate(lines, start=1):
        if COMPLETED_TASK.match(line):
            issues.append(
                f"{display_path}:{line_number}: completed task belongs in a progress/session "
                "record, not PLAN.md"
            )

        heading_match = HEADING.match(line)
        if heading_match is None:
            continue
        heading_level = len(heading_match.group(1))
        heading = heading_match.group(2).strip().casefold()
        if heading_level == 2 and heading not in ALLOWED_SECTIONS:
            issues.append(
                f"{display_path}:{line_number}: '{heading_match.group(2)}' is not an active "
                "queue section; use only 'In progress' or 'Future' and move the content to "
                "progress/, an issue, documentation, or an Agent Skill"
            )

    in_progress = _in_progress_items(lines)
    if len(in_progress) > 1:
        issues.append(
            f"{display_path}:{in_progress[1][0]}: In progress has {len(in_progress)} items; "
            "one session works one item"
        )
    for line_number, line in in_progress:
        issues.extend(_check_claim(display_path, line_number, line))

    return issues


def main() -> int:
    """Validate the repository plan."""
    # PLAN.md is an intentionally ignored local agent artifact. Fresh clones and
    # release packages do not contain it, so the always-run hook is a no-op there.
    if not PLAN_PATH.exists():
        return 0
    issues = check_plan()
    for issue in issues:
        print(issue, file=sys.stderr)
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())

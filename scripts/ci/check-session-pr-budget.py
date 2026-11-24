#!/usr/bin/env python3
"""Enforce the rolling three-hour, two-PR session budget on pull requests."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

API_ROOT = "https://api.github.com"
MARKER_RE = re.compile(
    r"<!--\s*session:\s*(?P<id>[A-Za-z0-9._:-]+)\s+started:\s*"
    r"(?P<started>[0-9T:.+\-Z]+)\s*-->"
)
DEFAULT_MAX_PRS = 2
DEFAULT_WINDOW_HOURS = 3
MAX_WINDOW_HOURS = 3
PAGE_LIMIT = 100
MAX_PAGES = 10


class BudgetError(Exception):
    """A malformed PR session marker or an exceeded budget."""


def parse_timestamp(value: object, field: str) -> datetime:
    """Parse an ISO-8601 timestamp with an explicit offset."""
    if not isinstance(value, str) or not value.strip():
        raise BudgetError(f"{field} must be a non-empty ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BudgetError(
            f"{field} is not a valid ISO-8601 timestamp: {value}"
        ) from exc
    if parsed.tzinfo is None:
        raise BudgetError(f"{field} must include a UTC offset")
    return parsed.astimezone(timezone.utc)


def parse_session_marker(body: object) -> tuple[str, datetime]:
    """Return the session id and start from a PR body marker."""
    if not isinstance(body, str):
        raise BudgetError("pull request body is missing")
    match = MARKER_RE.search(body)
    if match is None:
        raise BudgetError(
            "missing '<!-- session: <id> started: <ISO-8601> -->' marker in the PR body"
        )
    return match.group("id"), parse_timestamp(match.group("started"), "session start")


def _pr_number(pr: dict[str, Any]) -> int:
    number = pr.get("number")
    if not isinstance(number, int) or number <= 0:
        raise BudgetError("pull request is missing a positive number")
    return number


def _pr_created(pr: dict[str, Any]) -> datetime:
    return parse_timestamp(pr.get("created_at"), "created_at")


def _pr_author(pr: dict[str, Any]) -> str:
    user = pr.get("user")
    login = user.get("login") if isinstance(user, dict) else None
    if not isinstance(login, str) or not login:
        raise BudgetError("pull request is missing its author login")
    return login


def evaluate_session_budget(
    pr: dict[str, Any],
    all_prs: list[dict[str, Any]],
    *,
    max_prs: int = DEFAULT_MAX_PRS,
    window: timedelta = timedelta(hours=DEFAULT_WINDOW_HOURS),
    now: datetime | None = None,
) -> dict[str, Any]:
    """Validate one PR and count every same-author PR in the rolling window."""
    if max_prs < 1:
        raise BudgetError("max_prs must be positive")
    if window <= timedelta(0) or window > timedelta(hours=MAX_WINDOW_HOURS):
        raise BudgetError(f"window must be between 0 and {MAX_WINDOW_HOURS} hours")

    created = _pr_created(pr)
    session_id, started = parse_session_marker(pr.get("body"))
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if started > current + timedelta(minutes=5):
        raise BudgetError("session start is in the future")
    # A PR carried over from an earlier session is re-marked with the new
    # session start, so `started` may legitimately be after `created`.
    if created - started > window:
        raise BudgetError(
            f"PR was opened {(created - started).total_seconds() / 3600:.2f} hours "
            f"after the session start; the maximum is {window.total_seconds() / 3600:.0f}"
        )

    author = _pr_author(pr)
    window_start = created - window
    candidates: dict[int, dict[str, Any]] = {}
    for other in all_prs:
        if _pr_author(other) != author:
            continue
        other_created = _pr_created(other)
        if window_start <= other_created <= created:
            candidates[_pr_number(other)] = other
    candidates[_pr_number(pr)] = pr
    numbers = sorted(candidates)
    if len(numbers) > max_prs:
        raise BudgetError(
            f"{len(numbers)} PRs by {author} were created in the "
            f"{window.total_seconds() / 3600:.0f}-hour window ending at the current PR: "
            f"{numbers}; the maximum is {max_prs}"
        )

    return {
        "session_id": session_id,
        "started_at": started.isoformat().replace("+00:00", "Z"),
        "author": author,
        "prs": numbers,
        "max_prs": max_prs,
    }


def _request_json(url: str, token: str) -> Any:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "fortress-rollback-session-budget",
        "Authorization": f"Bearer {token}",
    }
    request = urllib.request.Request(url, headers=headers)  # noqa: S310
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise BudgetError(f"GitHub API request failed: {exc}") from exc


def fetch_pr(repo: str, number: int, token: str) -> dict[str, Any]:
    """Fetch one pull request."""
    data = _request_json(f"{API_ROOT}/repos/{repo}/pulls/{number}", token)
    if not isinstance(data, dict):
        raise BudgetError("GitHub returned an invalid pull request payload")
    return data


def fetch_recent_prs(repo: str, since: datetime, token: str) -> list[dict[str, Any]]:
    """Fetch pull requests created at or after `since`, or fail closed."""
    collected: list[dict[str, Any]] = []
    for page in range(1, MAX_PAGES + 1):
        url = (
            f"{API_ROOT}/repos/{repo}/pulls"
            f"?state=all&sort=created&direction=desc&per_page={PAGE_LIMIT}&page={page}"
        )
        payload = _request_json(url, token)
        if not isinstance(payload, list):
            raise BudgetError("GitHub returned an invalid pull request list")
        if not payload:
            return collected
        for pr in payload:
            if not isinstance(pr, dict):
                raise BudgetError("GitHub returned a malformed pull request entry")
            if _pr_created(pr) >= since:
                collected.append(pr)
        if _pr_created(payload[-1]) < since:
            return collected
    raise BudgetError(
        f"pull request history exceeds {MAX_PAGES * PAGE_LIMIT} entries; "
        "cannot verify the rolling window"
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--pr", required=True, type=int, help="pull request number")
    parser.add_argument(
        "--max-prs", type=int, default=DEFAULT_MAX_PRS, help="maximum PRs in the window"
    )
    parser.add_argument(
        "--window-hours",
        type=int,
        default=DEFAULT_WINDOW_HOURS,
        help=f"rolling window in hours, at most {MAX_WINDOW_HOURS}",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"),
        help="GitHub token (default: GITHUB_TOKEN or GH_TOKEN)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the command-line interface."""
    args = build_parser().parse_args(argv)
    if args.repo.count("/") != 1:
        print("session-pr-budget: --repo must be owner/name", file=sys.stderr)
        return 1
    if not args.token:
        print("session-pr-budget: a GitHub token is required", file=sys.stderr)
        return 1
    try:
        window = timedelta(hours=args.window_hours)
        pr = fetch_pr(args.repo, args.pr, args.token)
        created = _pr_created(pr)
        recent = fetch_recent_prs(args.repo, created - window, args.token)
        summary = evaluate_session_budget(
            pr, recent, max_prs=args.max_prs, window=window
        )
    except BudgetError as exc:
        print(f"session-pr-budget: {exc}", file=sys.stderr)
        return 1
    print(
        f"session {summary['session_id']}: {len(summary['prs'])}/"
        f"{summary['max_prs']} PRs in the rolling "
        f"{args.window_hours}-hour window: {summary['prs']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

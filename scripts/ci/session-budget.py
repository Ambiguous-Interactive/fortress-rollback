#!/usr/bin/env python3
"""Track the wall-clock budget for one agent session."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STATE_PATH = REPO_ROOT / "progress" / ".session-budget.json"
DEFAULT_MINUTES = 180
MAX_MINUTES = 180
MIN_MINUTES = 1


class BudgetError(Exception):
    """A malformed or missing session budget."""


def utc_now() -> datetime:
    """Return the current timezone-aware UTC time."""
    return datetime.now(timezone.utc)


def _format_time(value: datetime) -> str:
    return (
        value.astimezone(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _parse_time(value: object, field: str) -> datetime:
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


def _write_state(state: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def start(
    session_id: str,
    minutes: int = DEFAULT_MINUTES,
    *,
    now: datetime | None = None,
    path: Path = DEFAULT_STATE_PATH,
) -> dict[str, Any]:
    """Create a budget for one session and return the stored state."""
    if not session_id.strip():
        raise BudgetError("session id must not be empty")
    if minutes < MIN_MINUTES or minutes > MAX_MINUTES:
        raise BudgetError(
            f"minutes must be between {MIN_MINUTES} and {MAX_MINUTES}: {minutes}"
        )
    started = (now or utc_now()).astimezone(timezone.utc)
    expires = started + timedelta(minutes=minutes)
    state = {
        "session_id": session_id.strip(),
        "started_at": _format_time(started),
        "expires_at": _format_time(expires),
        "minutes": minutes,
    }
    _write_state(state, path)
    return state


def load(path: Path = DEFAULT_STATE_PATH) -> dict[str, Any]:
    """Load and validate the stored budget."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise BudgetError(f"cannot read session budget at {path}: {exc}") from exc
    try:
        state = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BudgetError(f"session budget at {path} is not valid JSON") from exc
    if not isinstance(state, dict):
        raise BudgetError(f"session budget at {path} must be a JSON object")
    session_id = state.get("session_id")
    if not isinstance(session_id, str) or not session_id.strip():
        raise BudgetError("session_id must be a non-empty string")
    _parse_time(state.get("started_at"), "started_at")
    _parse_time(state.get("expires_at"), "expires_at")
    minutes = state.get("minutes")
    if not isinstance(minutes, int) or not MIN_MINUTES <= minutes <= MAX_MINUTES:
        raise BudgetError(
            f"minutes must be an integer between {MIN_MINUTES} and {MAX_MINUTES}"
        )
    return state


def check(
    *,
    now: datetime | None = None,
    path: Path = DEFAULT_STATE_PATH,
) -> tuple[dict[str, Any], float]:
    """Return the state and remaining minutes; negative means expired."""
    state = load(path)
    current = (now or utc_now()).astimezone(timezone.utc)
    expires = _parse_time(state["expires_at"], "expires_at")
    remaining_minutes = (expires - current).total_seconds() / 60.0
    return state, remaining_minutes


def close(path: Path = DEFAULT_STATE_PATH) -> bool:
    """Remove the stored budget; return whether a file was removed."""
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    return True


def _add_state_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--state",
        type=Path,
        default=DEFAULT_STATE_PATH,
        help="Budget state file (default: progress/.session-budget.json)",
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    start_parser = commands.add_parser("start", help="Start one session budget")
    start_parser.add_argument("--id", required=True, help="Session identifier")
    start_parser.add_argument(
        "--minutes",
        type=int,
        default=DEFAULT_MINUTES,
        help=f"Budget in minutes, at most {MAX_MINUTES} (default: {DEFAULT_MINUTES})",
    )
    _add_state_argument(start_parser)

    check_parser = commands.add_parser("check", help="Print remaining budget")
    check_parser.add_argument("--json", action="store_true", help="Emit JSON")
    _add_state_argument(check_parser)

    close_parser = commands.add_parser("close", help="Remove the stored budget")
    _add_state_argument(close_parser)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the command-line interface."""
    args = build_parser().parse_args(argv)
    try:
        if args.command == "start":
            state = start(args.id, args.minutes, path=args.state)
            print(
                f"session {state['session_id']}: {state['minutes']} minutes, "
                f"expires {state['expires_at']}"
            )
            return 0
        if args.command == "check":
            state, remaining = check(path=args.state)
            payload = {
                "session_id": state["session_id"],
                "expires_at": state["expires_at"],
                "remaining_minutes": round(remaining, 1),
                "expired": remaining <= 0,
            }
            if args.json:
                print(json.dumps(payload, sort_keys=True))
            else:
                state_label = "EXPIRED" if payload["expired"] else "remaining"
                print(
                    f"session {payload['session_id']}: {state_label} "
                    f"{abs(payload['remaining_minutes']):.1f} minutes "
                    f"(expires {payload['expires_at']})"
                )
            return 2 if payload["expired"] else 0
        if args.command == "close":
            removed = close(args.state)
            print("budget removed" if removed else "no budget to remove")
            return 0
    except BudgetError as exc:
        print(f"session-budget: {exc}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Track the wall-clock budget for one agent session."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

_fcntl: Any
_msvcrt: Any
try:
    import fcntl as _fcntl
except ImportError:  # pragma: no cover - Windows
    _fcntl = None
try:
    import msvcrt as _msvcrt
except ImportError:  # pragma: no cover - POSIX
    _msvcrt = None

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STATE_PATH = REPO_ROOT / "progress" / ".session-budget.json"
DEFAULT_MINUTES = 180
MAX_MINUTES = 180
MIN_MINUTES = 1
DEFAULT_MAX_PRS = 2
MAX_PRS_LIMIT = 2
MIN_PR_NUMBER = 1
DEFAULT_HANDOFF_MINUTES = 5
MAX_HANDOFF_MINUTES = 60
CLOCK_SKEW_SECONDS = 60


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


def _serialize(state: dict[str, Any]) -> str:
    return json.dumps(state, indent=2, sort_keys=True) + "\n"


def _write_state(state: dict[str, Any], path: Path) -> None:
    """Replace the state through a unique temporary file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as temporary:
            temporary.write(_serialize(state))
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def _create_state_exclusive(state: dict[str, Any], path: Path) -> None:
    """Create a new state file only when no other writer won the race."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as created:
            created.write(_serialize(state))
    except Exception:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise


@contextmanager
def _state_lock(path: Path, timeout: float = 1.0) -> Iterator[None]:
    """Serialize budget updates with an OS-released advisory lock."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f".{path.name}.lock")
    deadline = time.monotonic() + timeout
    with open(lock_path, "a+b") as handle:
        locked = False
        while not locked:
            try:
                if _fcntl is not None:
                    _fcntl.flock(handle.fileno(), _fcntl.LOCK_EX | _fcntl.LOCK_NB)
                elif _msvcrt is not None:
                    handle.seek(0)
                    _msvcrt.locking(handle.fileno(), _msvcrt.LK_NBLCK, 1)
                else:
                    raise BudgetError("no file-locking primitive is available")
                locked = True
            except OSError:
                if time.monotonic() >= deadline:
                    raise BudgetError(f"another session is updating {path}") from None
                time.sleep(0.01)
        try:
            yield
        finally:
            if _fcntl is not None:
                _fcntl.flock(handle.fileno(), _fcntl.LOCK_UN)
            elif _msvcrt is not None:
                handle.seek(0)
                _msvcrt.locking(handle.fileno(), _msvcrt.LK_UNLCK, 1)


def start(
    session_id: str,
    minutes: int = DEFAULT_MINUTES,
    max_prs: int = DEFAULT_MAX_PRS,
    *,
    takeover: bool = False,
    handoff: timedelta = timedelta(minutes=DEFAULT_HANDOFF_MINUTES),
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
    if max_prs < 1 or max_prs > MAX_PRS_LIMIT:
        raise BudgetError(f"max_prs must be between 1 and {MAX_PRS_LIMIT}: {max_prs}")
    if handoff <= timedelta(0) or handoff > timedelta(minutes=MAX_HANDOFF_MINUTES):
        raise BudgetError(
            f"handoff must be between 0 and {MAX_HANDOFF_MINUTES} minutes"
        )
    started = (now or utc_now()).astimezone(timezone.utc)
    session_key = session_id.strip()
    with _state_lock(path):
        return _start_locked(
            session_key, started, minutes, max_prs, takeover, handoff, path
        )


def _start_locked(
    session_key: str,
    started: datetime,
    minutes: int,
    max_prs: int,
    takeover: bool,
    handoff: timedelta,
    path: Path,
) -> dict[str, Any]:
    if path.exists():
        existing = load(path, now=started)
        if existing["session_id"] == session_key:
            return existing
        existing_expires = _parse_time(existing["expires_at"], "expires_at")
        existing_updated = _parse_time(existing["updated_at"], "updated_at")
        idle_for = started - existing_updated
        if existing_expires > started and not takeover and idle_for < handoff:
            raise BudgetError(
                f"session {existing['session_id']} already has an active budget "
                f"until {existing['expires_at']} and was active {_format_time(existing_updated)}; "
                "wait for it to go idle or pass --takeover"
            )
        state = _new_state(session_key, started, minutes, max_prs)
        _write_state(state, path)
        return state

    state = _new_state(session_key, started, minutes, max_prs)
    for _ in range(5):
        try:
            _create_state_exclusive(state, path)
            return state
        except FileExistsError:
            time.sleep(0.02)
            try:
                existing = load(path)
            except BudgetError:
                continue
            if existing["session_id"] == session_key:
                return existing
            raise BudgetError(
                f"session {existing['session_id']} already has an active budget "
                f"until {existing['expires_at']}"
            ) from None
    raise BudgetError(f"could not create a session budget at {path}")


def _new_state(
    session_id: str, started: datetime, minutes: int, max_prs: int
) -> dict[str, Any]:
    expires = started + timedelta(minutes=minutes)
    return {
        "session_id": session_id,
        "started_at": _format_time(started),
        "expires_at": _format_time(expires),
        "updated_at": _format_time(started),
        "minutes": minutes,
        "max_prs": max_prs,
        "prs": [],
    }


def load(
    path: Path = DEFAULT_STATE_PATH, *, now: datetime | None = None
) -> dict[str, Any]:
    """Load and validate the stored budget."""
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
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
    started = _parse_time(state.get("started_at"), "started_at")
    expires = _parse_time(state.get("expires_at"), "expires_at")
    minutes = state.get("minutes")
    if not isinstance(minutes, int) or not MIN_MINUTES <= minutes <= MAX_MINUTES:
        raise BudgetError(
            f"minutes must be an integer between {MIN_MINUTES} and {MAX_MINUTES}"
        )
    ttl_seconds = (expires - started).total_seconds()
    if ttl_seconds <= 0:
        raise BudgetError("expires_at must be after started_at")
    if ttl_seconds > minutes * 60:
        raise BudgetError(
            f"expires_at is more than the configured {minutes} minutes after started_at"
        )
    current = (now or utc_now()).astimezone(timezone.utc)
    updated_raw = state.get("updated_at")
    updated = started if updated_raw is None else _parse_time(updated_raw, "updated_at")
    if updated < started:
        raise BudgetError("updated_at must not precede started_at")
    if updated > current + timedelta(seconds=CLOCK_SKEW_SECONDS):
        raise BudgetError("updated_at must not be in the future")
    max_prs = state.get("max_prs", DEFAULT_MAX_PRS)
    if not isinstance(max_prs, int) or not 1 <= max_prs <= MAX_PRS_LIMIT:
        raise BudgetError(f"max_prs must be between 1 and {MAX_PRS_LIMIT}")
    prs = state.get("prs", [])
    if not isinstance(prs, list) or not all(
        isinstance(number, int) and number >= MIN_PR_NUMBER for number in prs
    ):
        raise BudgetError("prs must be a list of positive pull request numbers")
    return {
        **state,
        "updated_at": _format_time(updated),
        "max_prs": max_prs,
        "prs": sorted(set(prs)),
    }


def check(
    *,
    now: datetime | None = None,
    path: Path = DEFAULT_STATE_PATH,
) -> tuple[dict[str, Any], float]:
    """Return the state and remaining minutes; negative means expired."""
    current = (now or utc_now()).astimezone(timezone.utc)
    state = load(path, now=current)
    expires = _parse_time(state["expires_at"], "expires_at")
    remaining_minutes = (expires - current).total_seconds() / 60.0
    return state, remaining_minutes


def touch(
    session_id: str,
    *,
    now: datetime | None = None,
    path: Path = DEFAULT_STATE_PATH,
) -> dict[str, Any]:
    """Record owner activity without moving the deadline."""
    current = (now or utc_now()).astimezone(timezone.utc)
    with _state_lock(path):
        state = load(path, now=current)
        if state["session_id"] != session_id:
            raise BudgetError(
                f"session {state['session_id']} owns the budget; "
                f"{session_id} cannot record activity"
            )
        expires = _parse_time(state["expires_at"], "expires_at")
        if expires <= current:
            raise BudgetError("session budget is expired; start a new session")
        updated = {**state, "updated_at": _format_time(current)}
        _write_state(updated, path)
        return updated


def claim_pr(
    number: int,
    *,
    now: datetime | None = None,
    path: Path = DEFAULT_STATE_PATH,
) -> dict[str, Any]:
    """Record one opened PR and enforce the session PR limit."""
    if number < MIN_PR_NUMBER:
        raise BudgetError(f"pull request number must be positive: {number}")
    current = (now or utc_now()).astimezone(timezone.utc)
    with _state_lock(path):
        state = load(path, now=current)
        expires = _parse_time(state["expires_at"], "expires_at")
        if expires <= current:
            raise BudgetError("session budget is expired; start a new session")
        if number in state["prs"]:
            return state
        if len(state["prs"]) >= state["max_prs"]:
            raise BudgetError(
                f"session PR budget is exhausted: {len(state['prs'])} of "
                f"{state['max_prs']} already claimed"
            )
        updated = {
            **state,
            "prs": sorted([*state["prs"], number]),
        }
        _write_state(updated, path)
        return updated


def close(path: Path = DEFAULT_STATE_PATH) -> bool:
    """Remove the stored budget; return whether a file was removed."""
    with _state_lock(path):
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
    start_parser.add_argument(
        "--max-prs",
        type=int,
        default=DEFAULT_MAX_PRS,
        help=f"Maximum opened PRs, at most {MAX_PRS_LIMIT} (default: {DEFAULT_MAX_PRS})",
    )
    start_parser.add_argument(
        "--takeover",
        action="store_true",
        help="Take over another session's active lease",
    )
    start_parser.add_argument(
        "--handoff-minutes",
        type=int,
        default=DEFAULT_HANDOFF_MINUTES,
        help=(
            "Minutes of inactivity after which another session may take over "
            f"(default: {DEFAULT_HANDOFF_MINUTES})"
        ),
    )
    _add_state_argument(start_parser)

    check_parser = commands.add_parser("check", help="Print remaining budget")
    check_parser.add_argument("--json", action="store_true", help="Emit JSON")
    _add_state_argument(check_parser)

    touch_parser = commands.add_parser(
        "touch", help="Record activity for the owning session"
    )
    touch_parser.add_argument("--id", required=True, help="Session identifier")
    _add_state_argument(touch_parser)

    claim_parser = commands.add_parser("claim-pr", help="Record an opened pull request")
    claim_parser.add_argument("--number", type=int, required=True)
    _add_state_argument(claim_parser)

    close_parser = commands.add_parser("close", help="Remove the stored budget")
    _add_state_argument(close_parser)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the command-line interface."""
    args = build_parser().parse_args(argv)
    try:
        if args.command == "start":
            state = start(
                args.id,
                args.minutes,
                args.max_prs,
                takeover=args.takeover,
                handoff=timedelta(minutes=args.handoff_minutes),
                path=args.state,
            )
            print(
                f"session {state['session_id']}: {state['minutes']} minutes, "
                f"{state['max_prs']} PRs, expires {state['expires_at']}"
            )
            return 0
        if args.command == "check":
            state, remaining = check(path=args.state)
            prs_remaining = state["max_prs"] - len(state["prs"])
            idle_minutes = (
                utc_now() - _parse_time(state["updated_at"], "updated_at")
            ).total_seconds() / 60.0
            payload = {
                "session_id": state["session_id"],
                "expires_at": state["expires_at"],
                "updated_at": state["updated_at"],
                "idle_minutes": round(max(0.0, idle_minutes), 1),
                "remaining_minutes": round(remaining, 1),
                "expired": remaining <= 0,
                "prs": state["prs"],
                "max_prs": state["max_prs"],
                "prs_remaining": prs_remaining,
                "pr_budget_exhausted": prs_remaining <= 0,
            }
            if args.json:
                print(json.dumps(payload, sort_keys=True))
            else:
                state_label = "EXPIRED" if payload["expired"] else "remaining"
                print(
                    f"session {payload['session_id']}: {state_label} "
                    f"{abs(payload['remaining_minutes']):.1f} minutes, "
                    f"PRs {len(payload['prs'])}/{payload['max_prs']} "
                    f"(expires {payload['expires_at']})"
                )
            return 2 if payload["expired"] or payload["pr_budget_exhausted"] else 0
        if args.command == "touch":
            state = touch(args.id, path=args.state)
            print(
                f"session {state['session_id']}: activity at {state['updated_at']}, "
                f"expires {state['expires_at']}"
            )
            return 0
        if args.command == "claim-pr":
            state = claim_pr(args.number, path=args.state)
            print(
                f"session {state['session_id']}: claimed PR "
                f"#{args.number} ({len(state['prs'])}/{state['max_prs']})"
            )
            return 0
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

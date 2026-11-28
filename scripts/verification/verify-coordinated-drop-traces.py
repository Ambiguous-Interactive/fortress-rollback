#!/usr/bin/env python3
"""Validate runtime coordinated-drop NDJSON traces against TLA+ actions."""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
TLA_DIR = ROOT / "specs" / "tla"
DEFAULT_TRACE_DIR = TLA_DIR / "traces" / "coordinated-drop-v1"
DEFAULT_JAR = ROOT / ".tla-tools" / "tla2tools.jar"
PARTICIPANTS = (0, 1, 2)
AUTHORITY = 0
NONE = 2
MAX_CUT = 3
MAX_BACKFILL = 8
TRACE_FILES = ("runtime-drop.ndjson",)
HEADER_KEYS = {"schema", "trace", "expect", "description"}
STATE_KEYS = {
    "active",
    "phase",
    "localParticipant",
    "authority",
    "quorum",
    "participantCount",
    "targetCount",
    "cut",
    "digest",
    "counted",
    "provisional",
    "committed",
    "frozen",
}
PHASES = {
    None: "None",
    "Inventory": "Inventory",
    "Backfill": "Backfill",
    "Ready": "Ready",
    "Committed": "Committed",
}


class TraceError(ValueError):
    """A fail-closed trace schema, normalization, or TLC error."""


@dataclass(frozen=True)
class TraceCase:
    path: Path
    header: dict[str, Any]
    rows: tuple[dict[str, Any], ...]

    @property
    def name(self) -> str:
        return str(self.header["trace"])


def fail(message: str) -> TraceError:
    return TraceError(message)


def require_int(value: Any, label: str, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise fail(f"{label} must be an integer in {low}..{high}")
    return value


def load_trace(path: Path) -> TraceCase:
    try:
        raw_lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise fail(f"{path}: unable to read trace: {error}") from error
    records: list[dict[str, Any]] = []
    for line_number, raw in enumerate(raw_lines, start=1):
        if not raw.strip():
            raise fail(f"{path}:{line_number}: blank NDJSON line")
        try:
            record = json.loads(raw)
        except json.JSONDecodeError as error:
            raise fail(f"{path}:{line_number}: invalid JSON: {error.msg}") from error
        if not isinstance(record, dict):
            raise fail(f"{path}:{line_number}: record must be an object")
        records.append(record)
    if len(records) < 2:
        raise fail(f"{path}: trace must contain a header and at least one row")
    header = records[0]
    if set(header) != HEADER_KEYS:
        raise fail(f"{path}:1: header keys must be {sorted(HEADER_KEYS)}")
    if header.get("schema") != 1 or header.get("expect") != "accept":
        raise fail(f"{path}:1: schema must be 1 and expect must be 'accept'")
    if not isinstance(header.get("description"), str) or not header["description"].strip():
        raise fail(f"{path}:1: description must be a non-empty string")
    rows = records[1:]
    for index, row in enumerate(rows):
        if row.get("step") != index:
            raise fail(f"{path}:{index + 2}: step must equal {index}")
        if not isinstance(row.get("action"), dict) or not isinstance(row.get("state"), dict):
            raise fail(f"{path}:{index + 2}: action and state must be objects")
        if set(row["state"]) != STATE_KEYS:
            raise fail(f"{path}:{index + 2}: state keys do not match the schema")
    return TraceCase(path=path, header=header, rows=tuple(rows))


def validate_runtime_traces(cases: dict[str, TraceCase]) -> None:
    if set(cases) != set(TRACE_FILES):
        raise fail(
            "runtime trace manifest mismatch; "
            f"missing={sorted(set(TRACE_FILES) - set(cases))}, "
            f"extra={sorted(set(cases) - set(TRACE_FILES))}"
        )
    for case in cases.values():
        prepares = [
            row for row in case.rows if row["action"].get("kind") == "PrepareAdmitted"
        ]
        if not prepares:
            raise fail(f"{case.path}: trace has no prepare admission")
        first = prepares[0]["action"]
        operation = first.get("operation")
        counts = (first.get("participants"), first.get("targets"))
        if not isinstance(operation, dict) or any(
            type(count) is not int or count < 1 for count in counts
        ):
            raise fail(f"{case.path}: prepare metadata is malformed")
        for row in prepares:
            action = row["action"]
            if action.get("operation") != operation:
                raise fail(f"{case.path}: prepare rows disagree on operation identity")
            if (action.get("participants"), action.get("targets")) != counts:
                raise fail(
                    f"{case.path}: prepare rows disagree on participant/target counts"
                )
            state = row["state"]
            if (
                state["participantCount"] != counts[0]
                or state["targetCount"] != counts[1]
            ):
                raise fail(
                    f"{case.path}: prepare counts do not match the projected state"
                )
        names = {row["action"].get("kind") for row in case.rows}
        required = {
            "PrepareAdmitted",
            "PhaseChanged",
            "CutSelected",
            "DigestLocked",
            "ReadyCounted",
            "CommitApplied",
            "TargetFrozen",
            "AttemptCleared",
        }
        missing = required - names
        if missing:
            raise fail(f"{case.path}: missing required runtime events: {sorted(missing)}")
        committed_rows = [row for row in case.rows if row["state"]["committed"]]
        if not committed_rows:
            raise fail(f"{case.path}: trace never records a committed attempt")
        committed = committed_rows[-1]["state"]
        if not committed["committed"] or 3 not in {
            index for index, frozen in enumerate(committed["frozen"]) if frozen
        }:
            raise fail(f"{case.path}: committed row must commit and freeze target 3")
        if committed["cut"] is None or committed["digest"] is None:
            raise fail(f"{case.path}: committed row must carry a cut and digest")
        if case.rows[-1]["action"].get("kind") != "AttemptCleared":
            raise fail(f"{case.path}: trace must end with a cleared attempt")

        last_by_session: dict[int, dict[str, Any]] = {}
        for row in case.rows:
            session = row.get("session")
            if type(session) is int and session in PARTICIPANTS:
                last_by_session[session] = row
        for session in PARTICIPANTS:
            produced = [
                row for row in case.rows if row.get("session") == session
            ]
            if not any(row["state"]["committed"] for row in produced):
                raise fail(
                    f"{case.path}: session {session} must commit before clearing"
                )
            last_row = last_by_session.get(session)
            if last_row is None:
                raise fail(f"{case.path}: session {session} has no recorded rows")
            if last_row["action"].get("kind") != "AttemptCleared":
                raise fail(
                    f"{case.path}: session {session} must end with a cleared attempt"
                )
            state = last_row["state"]
            if (
                state["active"]
                or state["phase"] is not None
                or state["localParticipant"] != 0
                or state["authority"] != 0
                or state["quorum"] != 0
                or state["participantCount"] != 0
                or state["targetCount"] != 0
                or state["committed"]
                or state["cut"] is not None
                or state["digest"] is not None
                or any(state["counted"])
                or any(state["provisional"])
            ):
                raise fail(
                    f"{case.path}: session {session} clear projection must reset "
                    "attempt-local state"
                )
            if len(state["frozen"]) <= 3 or not state["frozen"][3]:
                raise fail(
                    f"{case.path}: session {session} clear must keep frozen target 3"
                )
        authority_ready = [
            row
            for row in case.rows
            if row["action"].get("kind") == "ReadyCounted"
            and row["state"]["localParticipant"] == AUTHORITY
        ]
        quorum = committed["quorum"]
        if len(authority_ready) < quorum:
            raise fail(
                f"{case.path}: authority trace must observe a strict-majority "
                f"Ready quorum ({len(authority_ready)} < {quorum})"
            )


def collect_digest_map(cases: dict[str, TraceCase]) -> dict[int, int]:
    digests: set[int] = set()
    for case in cases.values():
        for row in case.rows:
            value = row["state"]["digest"]
            if value is None:
                continue
            if type(value) is not int or not 0 <= value <= 2**64 - 1:
                raise fail(
                    f"{case.path}: digest must be null or a u64, found {value!r}"
                )
            digests.add(value)
    ordered = sorted(digests)
    if not ordered or len(ordered) > 2:
        raise fail(f"runtime trace must expose one or two digests, found {ordered}")
    return {digest: index for index, digest in enumerate(ordered)}


def local_digest_map(case: TraceCase, digests: dict[int, int]) -> dict[int, int]:
    """Use each reporter's recorded Ready digest as its local-history evidence."""
    local = {participant: 0 for participant in PARTICIPANTS}
    seen: dict[int, int] = {}
    for row in case.rows:
        action = row["action"]
        kind = action.get("kind")
        if kind not in {"ReadyCounted", "ReadyProvisional"}:
            continue
        participant = action.get("participant")
        if participant not in PARTICIPANTS:
            continue
        value = action.get("digest")
        if value is None or value not in digests:
            raise fail(f"{case.path}: Ready action has an unknown digest")
        digest = digests[value]
        if participant in seen and seen[participant] != digest:
            raise fail(
                f"{case.path}: participant {participant} reported conflicting local digests"
            )
        seen[participant] = digest
        local[participant] = digest
    return local


def tla_nested(mapping: dict[int, dict[int, Any]]) -> str:
    def render_row(row: dict[int, Any]) -> str:
        values = []
        for q in PARTICIPANTS:
            value = row[q]
            values.append("NONE" if value is None else str(value))
        return (
            "[q \\in PARTICIPANTS |-> CASE q = 0 -> "
            + values[0]
            + " [] q = 1 -> "
            + values[1]
            + " [] OTHER -> "
            + values[2]
            + "]"
        )

    return (
        "[p \\in PARTICIPANTS |-> CASE p = 0 -> "
        + render_row(mapping[0])
        + " [] p = 1 -> "
        + render_row(mapping[1])
        + " [] OTHER -> "
        + render_row(mapping[2])
        + "]"
    )


def render_state(state: dict[str, Any]) -> str:
    def digest(value: Any) -> str:
        return "NONE" if value is None else str(value)

    def peer_map(values: dict[int, Any], value_render: Any) -> str:
        return (
            "[p \\in PARTICIPANTS |-> CASE p = 0 -> "
            + str(value_render(values[0]))
            + " [] p = 1 -> "
            + str(value_render(values[1]))
            + " [] OTHER -> "
            + str(value_render(values[2]))
            + "]"
        )

    frozen = "{" + ", ".join(str(p) for p in state["frozen"]) + "}"
    return str(
        "[localDigest |-> "
        + peer_map(state["localDigest"], lambda value: str(value))
        + ", cutDigest |-> "
        + peer_map(state["cutDigest"], digest)
        + ", provisional |-> "
        + tla_nested(state["provisional"])
        + ", transcript |-> "
        + tla_nested(state["transcript"])
        + ", committed |-> "
        + peer_map(state["committed"], digest)
        + ", network |-> "
        + tla_nested(state["network"])
        + ", dropPhase |-> \""
        + state["dropPhase"]
        + "\", traceCut |-> "
        + str(state["traceCut"])
        + ", backfilled |-> "
        + str(state["backfilled"])
        + ", frozen |-> "
        + frozen
        + "]"
    )


def initial_model() -> dict[str, Any]:
    return {
        "localDigest": {p: 0 for p in PARTICIPANTS},
        "cutDigest": {p: None for p in PARTICIPANTS},
        "provisional": {p: {q: None for q in PARTICIPANTS} for p in PARTICIPANTS},
        "transcript": {p: {q: None for q in PARTICIPANTS} for p in PARTICIPANTS},
        "committed": {p: None for p in PARTICIPANTS},
        "network": {p: {q: None for q in PARTICIPANTS} for p in PARTICIPANTS},
        "counted": [],
        "dropPhase": "None",
        "traceCut": 0,
        "backfilled": 0,
        "frozen": [],
    }


def event_local(event: dict[str, Any]) -> int:
    """Return the participant whose local projection an event records.

    A clear resets the recorder's ``localParticipant`` field to zero, so the
    merged producer's ``session`` index attributes that row instead. Every
    other event carries the observed local participant directly.
    """
    if event["action"].get("kind") == "AttemptCleared":
        session = event.get("session")
        if type(session) is not int or session not in PARTICIPANTS:
            raise fail("AttemptCleared row must carry its producing session")
        return session
    local = event["state"]["localParticipant"]
    if type(local) is not int or local not in PARTICIPANTS:
        raise fail("event state must carry a valid local participant")
    return local


def assert_runtime_projection(
    case: TraceCase,
    event: dict[str, Any],
    model: dict[str, Any],
    digests: dict[int, int],
) -> None:
    """Compare the local modeled slice with the recorded post-event projection."""
    state = event["state"]
    local = event_local(event)
    for participant in PARTICIPANTS:
        expected_counted = bool(state["counted"][participant])
        actual_counted = model["transcript"][local][participant] is not None
        if actual_counted != expected_counted:
            raise fail(
                f"{case.path}: counted projection mismatch for local participant "
                f"{local}, reporter {participant}"
            )
        expected_provisional = bool(state["provisional"][participant])
        actual_provisional = model["provisional"][local][participant] is not None
        if actual_provisional != expected_provisional:
            raise fail(
                f"{case.path}: provisional projection mismatch for local participant "
                f"{local}, reporter {participant}"
            )
    if (model["committed"][local] is not None) != bool(state["committed"]):
        raise fail(f"{case.path}: committed projection mismatch for participant {local}")
    if event["action"].get("kind") != "DigestLocked":
        expected_digest = state["digest"]
        actual_digest = model["cutDigest"][local]
        if expected_digest is None:
            if actual_digest is not None:
                raise fail(
                    f"{case.path}: unexpected locked digest for participant {local}"
                )
        elif (
            actual_digest is None
            or actual_digest != digests[expected_digest]
        ):
            raise fail(f"{case.path}: locked digest mismatch for participant {local}")
    if state["cut"] is not None and model["traceCut"] != state["cut"]:
        raise fail(f"{case.path}: cut projection mismatch for participant {local}")
    if event["action"].get("kind") == "TargetFrozen":
        handle = event["action"].get("handle")
        if (
            type(handle) is not int
            or not 0 <= handle < len(state["frozen"])
            or not state["frozen"][handle]
        ):
            raise fail(f"{case.path}: frozen projection mismatch")


def normalize(case: TraceCase, digests: dict[int, int]) -> list[dict[str, Any]]:
    model = initial_model()
    model["localDigest"] = local_digest_map(case, digests)
    rows: list[dict[str, Any]] = [
        {"action": "Init", "state": copy.deepcopy(model)}
    ]

    def snapshot(trace_state: dict[str, Any] | None = None) -> dict[str, Any]:
        state = copy.deepcopy(model)
        if trace_state is not None:
            state["dropPhase"] = PHASES[trace_state["phase"]]
            if trace_state["cut"] is not None:
                state["traceCut"] = trace_state["cut"]
            state["backfilled"] = trace_state["backfilled"]
            state["frozen"] = [
                index for index, frozen in enumerate(trace_state["frozen"]) if frozen
            ]
        return state

    def push(action: str, peer: int | None = None, **extra: Any) -> None:
        row: dict[str, Any] = {"action": action}
        if peer is not None:
            row["peer"] = peer
        row.update(extra)
        row["state"] = snapshot()
        rows.append(row)

    def require_digest(value: Any) -> int:
        if value is None or value not in digests:
            raise fail(f"{case.path}: digest event lacks a modeled digest")
        return digests[value]

    def mark_ready(peer: int, digest: int) -> None:
        if model["transcript"][peer][peer] is not None:
            return
        model["cutDigest"][peer] = digest
        model["transcript"][peer][peer] = digest
        push("MarkReady", peer)

    def deliver(
        peer: int,
        receiver: int,
        digest: int,
        authority: bool,
        *,
        expect_counted: bool,
    ) -> None:
        existing = model["transcript"][receiver][peer]
        if existing is not None:
            if existing != digest:
                raise fail(
                    f"{case.path}: conflicting duplicate Ready digest for participant {peer}"
                )
            return
        provisional = model["provisional"][receiver][peer]
        if provisional is not None:
            if provisional != digest or model["cutDigest"][receiver] != digest:
                raise fail(f"{case.path}: provisional digest conflict for participant {peer}")
            model["transcript"][receiver][peer] = digest
            model["provisional"][receiver][peer] = None
            push("PromoteProvisional", receiver, **{"from": peer})
            return
        if model["transcript"][peer][peer] is None:
            raise fail(
                f"{case.path}: received Ready from participant {peer} "
                "before its observed MarkReady"
            )
        model["network"][peer][receiver] = digest
        push("SendReady", peer, to=receiver)
        if authority or model["cutDigest"][receiver] is not None:
            if model["cutDigest"][receiver] is None:
                model["cutDigest"][receiver] = digest
            if model["cutDigest"][receiver] != digest:
                raise fail(f"{case.path}: conflicting digest for participant {peer}")
            model["transcript"][receiver][peer] = digest
            model["provisional"][receiver][peer] = None
        elif expect_counted:
            raise fail(f"{case.path}: counted Ready without a locked digest")
        else:
            model["provisional"][receiver][peer] = digest
        model["network"][peer][receiver] = None
        push("DeliverReady", peer, to=receiver)

    for row in case.rows:
        action = row["action"]
        kind = action.get("kind")
        event = row
        local = event_local(event)
        if kind == "PrepareAdmitted":
            model["dropPhase"] = "Inventory"
            push("PrepareAdmitted", action["operation"]["coordinator"])
        elif kind == "PrepareRejected":
            push("PrepareRejected", action["operation"]["coordinator"])
        elif kind == "PhaseChanged":
            model["dropPhase"] = action["phase"]
            push("PhaseChanged", local)
        elif kind == "CutSelected":
            model["traceCut"] = action["cut"]
            push("CutSelected", local)
        elif kind == "DigestLocked":
            model["traceCut"] = action["cut"]
            push("DigestLocked", local)
        elif kind == "ReadyCounted":
            participant = action["participant"]
            digest = require_digest(action["digest"])
            if participant == local:
                if model["cutDigest"][local] is not None and model["cutDigest"][local] != digest:
                    raise fail(f"{case.path}: local MarkReady digest conflict")
                mark_ready(local, digest)
            else:
                deliver(
                    participant,
                    local,
                    digest,
                    action["authority"],
                    expect_counted=True,
                )
        elif kind == "ReadyProvisional":
            participant = action["participant"]
            digest = require_digest(action["digest"])
            if model["cutDigest"][local] is not None:
                raise fail(f"{case.path}: provisional event after a locked digest")
            deliver(participant, local, digest, False, expect_counted=False)
        elif kind == "ReadyDiscarded":
            participant = action["participant"]
            if model["provisional"][local][participant] is None:
                raise fail(f"{case.path}: discarded provisional is not present")
            model["provisional"][local][participant] = None
            push("DiscardMismatchedProvisional", local, **{"from": participant})
        elif kind == "BackfillInstalled":
            model["backfilled"] = action["installed"]
            push("BackfillInstalled", local)
        elif kind == "CommitApplied":
            digest = require_digest(event["state"]["digest"])
            if local == AUTHORITY:
                model["committed"][AUTHORITY] = digest
                push("Certify", AUTHORITY)
            else:
                if model["committed"][AUTHORITY] is None:
                    raise fail(
                        f"{case.path}: participant commit without an observed "
                        "authority certificate"
                    )
                model["committed"][local] = digest
                push("Accept", local)
        elif kind == "TargetFrozen":
            if action["handle"] not in model["frozen"]:
                model["frozen"].append(action["handle"])
            push("TargetFrozen", local)
        elif kind == "AttemptCleared":
            # The recorder resets every attempt-local projection field after a
            # committed attempt clears; committed target fences are
            # session-global and survive. The digest-gate network is not
            # observable by the recorder, so it is left unchanged.
            model["cutDigest"][local] = None
            model["provisional"][local] = {p: None for p in PARTICIPANTS}
            model["transcript"][local] = {p: None for p in PARTICIPANTS}
            model["committed"][local] = None
            model["dropPhase"] = "None"
            model["traceCut"] = 0
            model["backfilled"] = 0
            push("AttemptCleared", local)
        elif kind == "Activated":
            continue
        else:
            raise fail(f"{case.path}: unsupported action {kind!r}")
        assert_runtime_projection(case, event, model, digests)
    return rows


def render_module(name: str, rows: list[dict[str, Any]]) -> str:
    rendered = []
    for row in rows:
        fields = [f"action |-> \"{row['action']}\""]
        for key in ("peer", "to", "from"):
            if key in row:
                fields.append(f"{key} |-> {row[key]}")
        fields.append(f"state |-> {render_state(row['state'])}")
        rendered.append("    [" + ",\n     ".join(fields) + "]")
    return (
        f"---------------- MODULE {name} ----------------\n"
        "EXTENDS CoordinatedDropTrace\n\n"
        "TraceData == <<\n"
        + ",\n".join(rendered)
        + "\n>>\n\n"
        "=============================================================================\n"
    )


def render_config(fix_mode: str) -> str:
    return f"""SPECIFICATION TraceSpec

CONSTANT PARTICIPANTS = {{0, 1, 2}}
CONSTANT AUTHORITY = 0
CONSTANT FIX_MODE = "{fix_mode}"
CONSTANT MAX_CUT = 3
CONSTANT MAX_BACKFILL = 8
CONSTANT TRACE <- TraceData

INVARIANT TypeInvariant
INVARIANT TraceTypeInvariant

PROPERTY EventuallyTraceConsumed
"""


def run_tlc(
    name: str,
    rows: list[dict[str, Any]],
    jar: Path,
    fix_mode: str,
    timeout: int,
    expected_accept: bool,
) -> None:
    safe_name = re.sub(r"[^A-Za-z0-9_]", "_", name)
    fd, module_raw = tempfile.mkstemp(
        prefix=f"GeneratedCoordinatedDrop_{safe_name}_", suffix=".tla", dir=TLA_DIR
    )
    os.close(fd)
    module_path = Path(module_raw)
    module_name = module_path.stem
    config_path = module_path.with_suffix(".cfg")
    try:
        module_path.write_text(render_module(module_name, rows), encoding="utf-8")
        config_path.write_text(render_config(fix_mode), encoding="utf-8")
        with tempfile.TemporaryDirectory(prefix="coordinated_drop_states_") as metadir:
            command = [
                "java",
                "-Xmx1g",
                "-XX:+UseParallelGC",
                "-jar",
                str(jar),
                "-workers",
                "1",
                "-deadlock",
                "-lncheck",
                "final",
                "-metadir",
                metadir,
                "-config",
                str(config_path),
                str(module_path),
            ]
            started = time.monotonic()
            try:
                result = subprocess.run(
                    command,
                    cwd=TLA_DIR,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    check=False,
                )
            except subprocess.TimeoutExpired as error:
                raise fail(f"{name}: TLC timed out after {timeout}s") from error
            duration = time.monotonic() - started
            output = result.stdout.rstrip("\n") + "\n" + result.stderr.rstrip("\n")
    finally:
        module_path.unlink(missing_ok=True)
        config_path.unlink(missing_ok=True)
        for artifact in TLA_DIR.glob(f"{module_name}_TTrace_*"):
            artifact.unlink(missing_ok=True)

    tool_errors = (
        "Parsing or semantic analysis failed",
        "Fatal errors while parsing",
        "Unexpected exception",
        "Tool failed",
        "Unable to access jarfile",
    )
    if any(marker in output for marker in tool_errors):
        raise fail(
            f"{name} [{fix_mode}]: TLC tool/parse failure\n" + output[-4000:]
        )
    if "states left on queue" in output and re.search(
        r"[1-9][0-9,]* states left on queue", output
    ):
        raise fail(
            f"{name} [{fix_mode}]: TLC left states on the queue\n" + output[-4000:]
        )

    success_line = "Model checking completed. No error has been found."
    expected_failure = "Error: Temporal property EventuallyTraceConsumed was violated."
    accepted = result.returncode == 0 and success_line in output
    rejected = result.returncode == 13 and expected_failure in output
    if expected_accept and not accepted:
        raise fail(
            f"{name} [{fix_mode}]: expected TLC acceptance (exit {result.returncode})\n"
            + output[-4000:]
        )
    if not expected_accept and not rejected:
        raise fail(
            f"{name} [{fix_mode}]: expected exit 13 with the trace-consumption "
            f"violation (exit {result.returncode})\n"
            + output[-4000:]
        )
    print(f"  {name} [{fix_mode}] {'accepted' if expected_accept else 'rejected'} "
          f"in {duration:.2f}s")


def derive_digest_mutation(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Count a non-authority Ready without a locked digest."""
    prefix: list[dict[str, Any]] = []
    for row in rows:
        if row["action"] == "MarkReady" and row.get("peer") == 2:
            break
        if row["state"]["transcript"][2][2] is not None:
            break
        if row["state"]["cutDigest"][1] is not None:
            break
        prefix.append(row)
    if len(prefix) < 2:
        raise fail("runtime trace has no pre-Ready prefix to mutate")

    base = copy.deepcopy(prefix[-1])
    mark = copy.deepcopy(base)
    mark["action"] = "MarkReady"
    mark["peer"] = 2
    state = mark["state"]
    state["cutDigest"][2] = 0
    state["transcript"][2][2] = 0

    send = copy.deepcopy(mark)
    send["action"] = "SendReady"
    send["peer"] = 2
    send["to"] = 1
    state = send["state"]
    state["network"][2][1] = 0
    state["cutDigest"][1] = NONE
    state["transcript"][1][2] = NONE
    state["provisional"][1][2] = NONE

    deliver = copy.deepcopy(base)
    deliver["action"] = "DeliverReady"
    deliver["peer"] = 2
    deliver["to"] = 1
    state = deliver["state"]
    state["network"][2][1] = NONE
    state["cutDigest"][1] = 0
    state["cutDigest"][2] = 0
    state["transcript"][2][2] = 0
    state["transcript"][1][2] = 0
    state["provisional"][1][2] = NONE

    return copy.deepcopy(prefix) + [mark, send, deliver]


def produce_runtime_traces(output_dir: Path) -> None:
    environment = dict(os.environ)
    environment["FORTRESS_COORDINATED_DROP_TRACE_DIR"] = str(output_dir)
    result = subprocess.run(
        [
            "cargo",
            "test",
            "--features",
            "trace-validation",
            "--test",
            "simulation",
            "coordinated_drop_trace_validation",
            "--",
            "--nocapture",
        ],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    if result.returncode != 0:
        raise fail(
            "runtime coordinated-drop producer failed\n"
            + result.stdout[-4000:]
            + result.stderr[-2000:]
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jar", type=Path, default=DEFAULT_JAR)
    parser.add_argument("--trace-dir", type=Path, default=DEFAULT_TRACE_DIR)
    parser.add_argument("--no-produce", action="store_true")
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if not args.jar.is_file():
        print(f"error: missing TLA tools jar at {args.jar}", file=sys.stderr)
        return 1

    try:
        if args.no_produce:
            trace_dir = args.trace_dir
        else:
            temporary = tempfile.TemporaryDirectory(prefix="coordinated_drop_traces_")
            trace_dir = Path(temporary.name)
            produce_runtime_traces(trace_dir)
        cases = {
            path.name: load_trace(path)
            for path in sorted(trace_dir.glob("*.ndjson"))
        }
        validate_runtime_traces(cases)
        digests = collect_digest_map(cases)
        normalized = {
            name: normalize(case, digests) for name, case in cases.items()
        }
        for name, rows in normalized.items():
            run_tlc(name, rows, args.jar, "AuthorityLocked", args.timeout, True)
            reject = derive_digest_mutation(rows)
            run_tlc(
                f"{name}-digest-mutation",
                reject,
                args.jar,
                "AuthorityLocked",
                args.timeout,
                False,
            )
            run_tlc(
                f"{name}-digest-mutation-control",
                reject,
                args.jar,
                "ProvisionalCounts",
                args.timeout,
                True,
            )
    except TraceError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print("Coordinated-drop trace contract: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

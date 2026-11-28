#!/usr/bin/env python3
"""Fail-closed tests for the coordinated-drop trace wrapper."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

ROOT = Path(__file__).parent.parent.parent
SCRIPT = ROOT / "scripts" / "verification" / "verify-coordinated-drop-traces.py"
spec = importlib.util.spec_from_file_location("verify_coordinated_drop_traces", SCRIPT)
assert spec is not None
assert spec.loader is not None
trace_verifier = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = trace_verifier
spec.loader.exec_module(trace_verifier)


def _state(**overrides: object) -> dict[str, object]:
    state: dict[str, object] = {
        "active": False,
        "phase": None,
        "localParticipant": 0,
        "authority": 0,
        "quorum": 2,
        "participantCount": 3,
        "targetCount": 1,
        "cut": None,
        "digest": None,
        "counted": [False, False, False, False],
        "provisional": [False, False, False, False],
        "committed": False,
        "frozen": [False, False, False, False],
    }
    state.update(overrides)
    return state


def _operation() -> dict[str, int]:
    return {
        "coordinator": 0,
        "coordinatorGeneration": 0,
        "sequence": 1,
        "targetSetDigest": 11,
        "participantSetDigest": 22,
        "terminalEpoch": 0,
    }


def _case(rows: list[dict[str, Any]]) -> Any:
    return trace_verifier.TraceCase(
        path=Path("runtime-drop-p1.ndjson"),
        header={
            "schema": 1,
            "trace": "runtime-drop-p1",
            "expect": "accept",
            "description": "test",
        },
        rows=tuple(rows),
    )


def _write_trace(path: Path, rows: list[dict[str, Any]]) -> None:
    header = {
        "schema": 1,
        "trace": "runtime-drop-p1",
        "expect": "accept",
        "description": "test",
    }
    encoded = [json.dumps(header)]
    for index, row in enumerate(rows):
        encoded.append(json.dumps({"step": index, **row}))
    path.write_text("\n".join(encoded) + "\n", encoding="utf-8")


def test_manifest_requires_the_merged_runtime_trace() -> None:
    case = _case([])
    with pytest.raises(trace_verifier.TraceError, match="manifest mismatch"):
        trace_verifier.validate_runtime_traces({"runtime-drop-p1.ndjson": case})


def test_load_trace_rejects_unknown_state_key(tmp_path: Path) -> None:
    path = tmp_path / "runtime-drop-p1.ndjson"
    _write_trace(
        path,
        [
            {
                "action": {"kind": "PrepareAdmitted", "operation": _operation(),
                           "participants": 3, "targets": 1},
                "state": {**_state(), "extra": True},
            }
        ],
    )
    with pytest.raises(trace_verifier.TraceError, match="state keys"):
        trace_verifier.load_trace(path)


def test_normalize_rejects_provisional_after_lock() -> None:
    rows: list[dict[str, Any]] = [
        {
            "action": {"kind": "PrepareAdmitted", "operation": _operation(),
                       "participants": 3, "targets": 1},
            "state": _state(active=True, phase="Inventory", localParticipant=1),
        },
        {
            "action": {"kind": "PhaseChanged", "phase": "Ready"},
            "state": _state(active=True, phase="Ready"),
        },
        {
            "action": {"kind": "CutSelected", "cut": 3},
            "state": _state(active=True, phase="Ready", cut=3),
        },
        {
            "action": {"kind": "DigestLocked", "cut": 3, "digest": 7},
            "state": _state(active=True, phase="Ready", cut=3, digest=7),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 1,
                "cut": 3,
                "digest": 7,
                "authority": False,
            },
            "state": _state(
                active=True,
                phase="Ready",
                cut=3,
                digest=7,
                localParticipant=1,
                counted=[False, True, False, False],
            ),
        },
        {
            "action": {
                "kind": "ReadyProvisional",
                "participant": 2,
                "cut": 3,
                "digest": 7,
            },
            "state": _state(
                active=True,
                phase="Ready",
                cut=3,
                digest=7,
                localParticipant=1,
                counted=[False, True, False, False],
            ),
        },
    ]
    with pytest.raises(
        trace_verifier.TraceError, match="provisional event after a locked digest"
    ):
        trace_verifier.normalize(_case(rows), {7: 0})


def test_render_module_uses_the_real_ready_actions() -> None:
    rows = [
        {"action": "Init", "state": trace_verifier.initial_model()},
        {"action": "MarkReady", "peer": 0, "state": trace_verifier.initial_model()},
        {"action": "DeliverReady", "peer": 1, "to": 0,
         "state": trace_verifier.initial_model()},
    ]
    rendered = trace_verifier.render_module("Generated", rows)
    assert "EXTENDS CoordinatedDropTrace" in rendered
    assert 'action |-> "MarkReady"' in rendered
    assert 'action |-> "DeliverReady"' in rendered
    assert "peer |-> 1" in rendered
    assert "to |-> 0" in rendered


def test_run_tlc_fails_on_exit_code_drift(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        trace_verifier.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout="Model checking completed. No error has been found.",
            stderr="",
        ),
    )
    rows = [{"action": "Init", "state": trace_verifier.initial_model()}]
    with pytest.raises(trace_verifier.TraceError, match="expected exit 13"):
        trace_verifier.run_tlc(
            "drift", rows, Path("missing.jar"), "AuthorityLocked", 1, False
        )


def test_run_tlc_fails_on_a_parse_error_even_with_the_property_line(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        trace_verifier.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=13,
            stdout=(
                "Parsing or semantic analysis failed.\n"
                "Error: Temporal property EventuallyTraceConsumed was violated."
            ),
            stderr="",
        ),
    )
    rows = [{"action": "Init", "state": trace_verifier.initial_model()}]
    with pytest.raises(trace_verifier.TraceError, match="TLC tool/parse failure"):
        trace_verifier.run_tlc(
            "parse", rows, Path("missing.jar"), "AuthorityLocked", 1, False
        )


def test_normalize_rejects_participant_commit_without_authority_certificate() -> None:
    rows: list[dict[str, Any]] = [
        {
            "action": {
                "kind": "PrepareAdmitted",
                "operation": _operation(),
                "participants": 3,
                "targets": 1,
            },
            "state": _state(active=True, phase="Inventory", localParticipant=1),
        },
        {
            "action": {"kind": "PhaseChanged", "phase": "Ready"},
            "state": _state(active=True, phase="Ready", localParticipant=1),
        },
        {
            "action": {"kind": "CutSelected", "cut": 3},
            "state": _state(active=True, phase="Ready", cut=3, localParticipant=1),
        },
        {
            "action": {"kind": "DigestLocked", "cut": 3, "digest": 7},
            "state": _state(
                active=True, phase="Ready", cut=3, digest=7, localParticipant=1
            ),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 1,
                "cut": 3,
                "digest": 7,
                "authority": False,
            },
            "state": _state(
                active=True,
                phase="Ready",
                cut=3,
                digest=7,
                localParticipant=1,
                counted=[False, True, False, False],
            ),
        },
        {
            "action": {"kind": "CommitApplied", "cut": 3, "digest": 7},
            "state": _state(
                active=True,
                phase="Committed",
                cut=3,
                digest=7,
                localParticipant=1,
                counted=[False, True, False, False],
                committed=True,
            ),
        },
    ]
    with pytest.raises(
        trace_verifier.TraceError,
        match="participant commit without an observed authority certificate",
    ):
        trace_verifier.normalize(_case(rows), {7: 0})


def test_normalize_rejects_a_counted_ready_without_a_lock() -> None:
    rows: list[dict[str, Any]] = [
        {
            "action": {
                "kind": "PrepareAdmitted",
                "operation": _operation(),
                "participants": 3,
                "targets": 1,
            },
            "state": _state(active=True, phase="Inventory", localParticipant=0),
        },
        {
            "action": {"kind": "CutSelected", "cut": 3},
            "state": _state(active=True, phase="Ready", cut=3, localParticipant=0),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 1,
                "cut": 3,
                "digest": 7,
                "authority": False,
            },
            "state": _state(
                active=True,
                phase="Ready",
                cut=3,
                digest=7,
                localParticipant=1,
                counted=[False, True, False, False],
            ),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 1,
                "cut": 3,
                "digest": 7,
                "authority": False,
            },
            "state": _state(
                active=True,
                phase="Ready",
                cut=3,
                localParticipant=0,
                counted=[False, True, False, False],
            ),
        },
    ]
    with pytest.raises(
        trace_verifier.TraceError, match="counted Ready without a locked digest"
    ):
        trace_verifier.normalize(_case(rows), {7: 0})


def test_normalize_uses_promotion_for_a_provisional_that_counts() -> None:
    rows: list[dict[str, Any]] = [
        {
            "action": {
                "kind": "PrepareAdmitted",
                "operation": _operation(),
                "participants": 3,
                "targets": 1,
            },
            "state": _state(active=True, phase="Inventory", localParticipant=0),
        },
        {
            "action": {"kind": "PhaseChanged", "phase": "Ready"},
            "state": _state(active=True, phase="Ready", localParticipant=0),
        },
        {
            "action": {"kind": "CutSelected", "cut": 3},
            "state": _state(active=True, phase="Ready", cut=3, localParticipant=0),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 1,
                "cut": 3,
                "digest": 7,
                "authority": False,
            },
            "state": _state(
                active=True,
                phase="Ready",
                cut=3,
                digest=7,
                localParticipant=1,
                counted=[False, True, False, False],
            ),
        },
        {
            "action": {
                "kind": "ReadyProvisional",
                "participant": 1,
                "cut": 3,
                "digest": 7,
            },
            "state": _state(
                active=True,
                phase="Ready",
                cut=3,
                localParticipant=0,
                provisional=[False, True, False, False],
            ),
        },
        {
            "action": {"kind": "DigestLocked", "cut": 3, "digest": 7},
            "state": _state(
                active=True, phase="Ready", cut=3, digest=7, localParticipant=0,
                provisional=[False, True, False, False],
            ),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 0,
                "cut": 3,
                "digest": 7,
                "authority": True,
            },
            "state": _state(
                active=True,
                phase="Ready",
                cut=3,
                digest=7,
                localParticipant=0,
                counted=[True, False, False, False],
                provisional=[False, True, False, False],
            ),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 1,
                "cut": 3,
                "digest": 7,
                "authority": False,
            },
            "state": _state(
                active=True,
                phase="Ready",
                cut=3,
                digest=7,
                localParticipant=0,
                counted=[True, True, False, False],
            ),
        },
    ]
    normalized = trace_verifier.normalize(_case(rows), {7: 0})
    actions = [row["action"] for row in normalized]
    assert "PromoteProvisional" in actions
    promote_index = actions.index("PromoteProvisional")
    assert all(
        row["action"] != "SendReady" or row.get("to") != 0
        for row in normalized[promote_index:]
    )


def test_validate_runtime_traces_rejects_inconsistent_prepare_metadata() -> None:
    def prepare(sequence: int, local: int) -> dict[str, Any]:
        operation = _operation()
        operation["sequence"] = sequence
        return {
            "action": {
                "kind": "PrepareAdmitted",
                "operation": operation,
                "participants": 3,
                "targets": 1,
            },
            "state": _state(
                active=True,
                phase="Inventory",
                localParticipant=local,
                participantCount=3,
                targetCount=1,
            ),
        }

    case = _case([prepare(1, 0), prepare(2, 1)])
    with pytest.raises(
        trace_verifier.TraceError, match="disagree on operation identity"
    ):
        trace_verifier.validate_runtime_traces({"runtime-drop.ndjson": case})


def test_collect_digest_map_rejects_a_non_integer_digest() -> None:
    case = _case([{"action": {"kind": "PrepareAdmitted"}, "state": _state(digest=[])}])
    with pytest.raises(trace_verifier.TraceError, match="digest must be null or a u64"):
        trace_verifier.collect_digest_map({"runtime-drop.ndjson": case})


def test_local_digests_follow_each_reporters_recorded_ready() -> None:
    rows: list[dict[str, Any]] = [
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 1,
                "cut": 3,
                "digest": 8,
                "authority": False,
            },
            "state": _state(active=True, phase="Ready"),
        }
    ]
    local = trace_verifier.local_digest_map(_case(rows), {7: 0, 8: 1})
    assert local[0] == 0
    assert local[1] == 1


def test_normalize_rejects_a_conflicting_duplicate_ready_digest() -> None:
    rows: list[dict[str, Any]] = [
        {
            "action": {
                "kind": "PrepareAdmitted",
                "operation": _operation(),
                "participants": 3,
                "targets": 1,
            },
            "state": _state(active=True, phase="Inventory", localParticipant=0),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 1,
                "cut": 3,
                "digest": 7,
                "authority": False,
            },
            "state": _state(active=True, phase="Ready", localParticipant=0),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 1,
                "cut": 3,
                "digest": 8,
                "authority": False,
            },
            "state": _state(active=True, phase="Ready", localParticipant=0),
        },
    ]
    with pytest.raises(trace_verifier.TraceError, match="conflicting"):
        trace_verifier.normalize(_case(rows), {7: 0, 8: 1})


def test_normalize_rejects_a_projection_mismatch() -> None:
    rows: list[dict[str, Any]] = [
        {
            "action": {
                "kind": "PrepareAdmitted",
                "operation": _operation(),
                "participants": 3,
                "targets": 1,
            },
            "state": _state(active=True, phase="Inventory", localParticipant=0),
        },
        {
            "action": {
                "kind": "ReadyCounted",
                "participant": 0,
                "cut": 3,
                "digest": 7,
                "authority": True,
            },
            "state": _state(
                active=True,
                phase="Ready",
                localParticipant=0,
                counted=[True, False, True, False],
            ),
        },
    ]
    with pytest.raises(trace_verifier.TraceError, match="counted projection mismatch"):
        trace_verifier.normalize(_case(rows), {7: 0})


def _row(session: int, action: dict[str, Any], **state: object) -> dict[str, Any]:
    return {"session": session, "action": action, "state": _state(**state)}


def _prepare_action() -> dict[str, Any]:
    return {
        "kind": "PrepareAdmitted",
        "operation": _operation(),
        "participants": 3,
        "targets": 1,
    }


def test_normalize_clears_the_producing_sessions_committed_projection() -> None:
    counted_both = [True, True, False, False]
    counted_one = [True, False, False, False]
    rows = [
        _row(1, _prepare_action(), active=True, phase="Inventory", localParticipant=1),
        _row(
            1,
            {"kind": "PhaseChanged", "phase": "Ready"},
            active=True,
            phase="Ready",
            localParticipant=1,
        ),
        _row(
            1,
            {"kind": "CutSelected", "cut": 3},
            active=True,
            phase="Ready",
            cut=3,
            localParticipant=1,
        ),
        _row(
            1,
            {"kind": "DigestLocked", "cut": 3, "digest": 7},
            active=True,
            phase="Ready",
            cut=3,
            digest=7,
            localParticipant=1,
        ),
        _row(
            0,
            {"kind": "ReadyCounted", "participant": 0, "cut": 3,
             "digest": 7, "authority": True},
            active=True,
            phase="Ready",
            cut=3,
            digest=7,
            localParticipant=0,
            counted=counted_one,
        ),
        _row(
            1,
            {"kind": "ReadyCounted", "participant": 1, "cut": 3,
             "digest": 7, "authority": False},
            active=True,
            phase="Ready",
            cut=3,
            digest=7,
            localParticipant=1,
            counted=[False, True, False, False],
        ),
        _row(
            0,
            {"kind": "ReadyCounted", "participant": 1, "cut": 3,
             "digest": 7, "authority": False},
            active=True,
            phase="Ready",
            cut=3,
            digest=7,
            localParticipant=0,
            counted=counted_both,
        ),
        _row(
            1,
            {"kind": "ReadyCounted", "participant": 0, "cut": 3,
             "digest": 7, "authority": True},
            active=True,
            phase="Ready",
            cut=3,
            digest=7,
            localParticipant=1,
            counted=counted_both,
        ),
        _row(
            0,
            {"kind": "PhaseChanged", "phase": "Committed"},
            active=True,
            phase="Committed",
            cut=3,
            digest=7,
            localParticipant=0,
            counted=counted_both,
        ),
        _row(
            0,
            {"kind": "CommitApplied", "cut": 3, "digest": 7},
            active=True,
            phase="Committed",
            cut=3,
            digest=7,
            localParticipant=0,
            counted=counted_both,
            committed=True,
        ),
        _row(
            1,
            {"kind": "CommitApplied", "cut": 3, "digest": 7},
            active=True,
            phase="Committed",
            cut=3,
            digest=7,
            localParticipant=1,
            counted=counted_both,
            committed=True,
        ),
        _row(
            1,
            {"kind": "TargetFrozen", "handle": 3, "cut": 3},
            active=True,
            phase="Committed",
            cut=3,
            digest=7,
            localParticipant=1,
            counted=counted_both,
            committed=True,
            frozen=[False, False, False, True],
        ),
        _row(1, {"kind": "AttemptCleared"}, frozen=[False, False, False, True]),
    ]

    normalized = trace_verifier.normalize(_case(rows), {7: 0})

    assert normalized[-1]["action"] == "AttemptCleared"
    state = normalized[-1]["state"]
    assert state["committed"][1] is None
    assert state["committed"][0] == 0
    assert state["cutDigest"][1] is None
    assert state["transcript"][1] == {p: None for p in trace_verifier.PARTICIPANTS}
    assert state["provisional"][1] == {p: None for p in trace_verifier.PARTICIPANTS}
    assert state["frozen"] == [3]


def test_normalize_rejects_a_clear_without_a_producing_session() -> None:
    rows = [{"action": {"kind": "AttemptCleared"}, "state": _state()}]
    with pytest.raises(
        trace_verifier.TraceError, match="must carry its producing session"
    ):
        trace_verifier.normalize(_case(rows), {})


def test_validate_runtime_traces_requires_the_committed_clear() -> None:
    committed = dict(
        active=True,
        phase="Committed",
        cut=3,
        digest=7,
        localParticipant=0,
        committed=True,
        frozen=[False, False, False, True],
    )
    rows = [
        _row(
            0,
            _prepare_action(),
            active=True,
            phase="Inventory",
            localParticipant=0,
            participantCount=3,
            targetCount=1,
        ),
        _row(
            0,
            {"kind": "PhaseChanged", "phase": "Ready"},
            active=True,
            phase="Ready",
            localParticipant=0,
        ),
        _row(
            0,
            {"kind": "CutSelected", "cut": 3},
            active=True,
            phase="Ready",
            cut=3,
            localParticipant=0,
        ),
        _row(
            0,
            {"kind": "DigestLocked", "cut": 3, "digest": 7},
            active=True,
            phase="Ready",
            cut=3,
            digest=7,
            localParticipant=0,
        ),
        _row(
            0,
            {"kind": "ReadyCounted", "participant": 0, "cut": 3,
             "digest": 7, "authority": True},
            active=True,
            phase="Ready",
            cut=3,
            digest=7,
            localParticipant=0,
            counted=[True, False, False, False],
        ),
        _row(
            0,
            {"kind": "ReadyCounted", "participant": 1, "cut": 3,
             "digest": 7, "authority": False},
            active=True,
            phase="Ready",
            cut=3,
            digest=7,
            localParticipant=0,
            counted=[True, True, False, False],
        ),
        _row(0, {"kind": "CommitApplied", "cut": 3, "digest": 7}, **committed),
        _row(0, {"kind": "TargetFrozen", "handle": 3, "cut": 3}, **committed),
    ]
    with pytest.raises(
        trace_verifier.TraceError, match="missing required runtime events"
    ):
        trace_verifier.validate_runtime_traces(
            {"runtime-drop.ndjson": _case(rows)}
        )


def test_normalize_rejects_a_cut_selection_mismatch() -> None:
    rows: list[dict[str, Any]] = [
        {
            "action": {
                "kind": "PrepareAdmitted",
                "operation": _operation(),
                "participants": 3,
                "targets": 1,
            },
            "state": _state(active=True, phase="Inventory", localParticipant=0),
        },
        {
            "action": {"kind": "CutSelected", "cut": 2},
            "state": _state(active=True, phase="Ready", cut=3, localParticipant=0),
        },
    ]
    with pytest.raises(trace_verifier.TraceError, match="cut projection mismatch"):
        trace_verifier.normalize(_case(rows), {7: 0})

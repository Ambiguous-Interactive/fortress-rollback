# Coordinated-drop trace contract

This directory documents the runtime-to-model refinement gate for the coordinated graceful drop
tracked by [#577](https://github.com/Ambiguous-Interactive/fortress-rollback/issues/577). It pairs a
bounded runtime recorder and deterministic SimNet producer with
`specs/tla/CoordinatedDropTrace.tla` and `scripts/verification/verify-coordinated-drop-traces.py`.

## Producer

Run the complete gate with:

```bash
python3 scripts/verification/verify-coordinated-drop-traces.py
```

`verify-tla.sh CoordinatedDropTraceContract` and the full TLA suite run the same gate. The wrapper
generates the runtime trace into a temporary directory on every run, validates its exact manifest,
renders the generated TLA trace module, and runs TLC. To inspect the producer alone:

```bash
FORTRESS_COORDINATED_DROP_TRACE_DIR=/tmp/coordinated-drop-traces \
  cargo test --features trace-validation --test simulation coordinated_drop_trace_validation \
  -- --nocapture
```

It builds four synchronized sessions over deterministic channels, advances four frames with
distinct inputs, then the three survivors call `remove_player` for the fourth slot. The test merges
each survivor's newly appended events after every poll, so the NDJSON preserves the deterministic
poll order. It fails unless every survivor observes `PeerDropped`, the merged trace contains a
prepare admission, a locked digest, a counted Ready, a commit, and a frozen target fence, the
authority observes a strict-majority Ready quorum, and no recorder overflows.

The emitted files are ephemeral. The gate must generate them fresh on every run; checked-in NDJSON
would let stale output stand in for current runtime behavior.

## Projection

`CoordinatedDropTraceRecorder` takes one compact post-poll snapshot and derives ordered events from
the difference against the previous snapshot. It reserves its complete capacity before the session
starts and never allocates while the session runs. The projection is:

| Runtime observation | Trace field | Normalization or known gap |
| ------------------- | ----------- | -------------------------- |
| Attempt identity | `operation` | Coordinator, generation, sequence, target-set digest, participant-set digest, and terminal epoch are copied; addresses and raw handle lists are not recorded |
| Attempt phase | `phase` | `Inventory`, `Backfill`, `Ready`, and `Committed` are mapped directly; the fast `Inventory -> Ready` path for a two-survivor barrier is preserved |
| Selected cut | `cut` | Exact frame selected by the barrier |
| Locked digest | `digest` | Exact `u64` computed over retained target inputs at the cut |
| Counted Ready reporters | `counted`, `countedCut`, `countedDigest` | Reporter handle plus the transcript's cut and digest; the local endpoint maps this to `MarkReady` or a received `Ready` |
| Provisional Ready reporters | `provisional`, `provisionalCut`, `provisionalDigest` | Reporter handle plus the held transcript; a non-authority report before the lock stays provisional |
| Installed backfill | `backfillInstalled` | Count only; chunk bytes, donor identity, and receipt vectors stay outside the model |
| Applied commit | `committed`, `commitCut`, `commitDigest` | Local apply only; a target acknowledgement is not a survivor count |
| Frozen targets | `frozen`, `frozenCut` | Committed target fences after the barrier |

The recorder does not observe every wire delivery or every rejected peer artifact. The TLA+ trace
module reconstructs a single in-flight `Ready` message around an observed counted/provisional
transition, which keeps the model's ordered-pair network bounded. Commit quorum is never invented:
the authority's `Certify` is emitted only from the authority session's recorded Ready events, and a
participant `Accept` requires an already-observed authority certificate. A provisional reporter that
later counts is normalized to `PromoteProvisional`, not to a second delivery. A prepare rejection is
recorded explicitly when the session journals a superseded or terminal attempt.

## Known gaps

- Backfill content, donor selection, and receipt gaps are `CoordinatedPeerDrop.tla` obligations; the
  trace records only whether the local session installed a chunk.
- The coordinator-to-acting-fallback transition remains `CoordinatorFailover.tla`; the trace records
  the effective authority handle but does not re-prove failover.
- Multi-handle target endpoints are collapsed to one canonical target count. Endpoint composition
  remains a Rust-level obligation.
- The gate checks one successful three-survivor operation. Backfill-forcing loss, failover, abort,
  and repeated operations are not yet derived from runtime traces; their model obligations remain
  `CoordinatedPeerDrop.tla`, `CoordinatorFailover.tla`, and the existing Rust tests.
- The trace gate reconstructs a single in-flight Ready message for each observed transition and does
  not model duplicate retransmissions. The merged trace preserves the simulator's poll order.

## Evidence

`python3 scripts/verification/verify-coordinated-drop-traces.py` accepts the merged runtime trace,
rejects a derived non-authority-without-lock mutation under `FIX_MODE = "AuthorityLocked"`, and
accepts the same mutation under the pre-#530 `FIX_MODE = "ProvisionalCounts"` control. The control is
the red check that proves the mutation has teeth: the trace contract is not merely rejecting every
mutation.

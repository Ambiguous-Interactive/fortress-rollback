# Fortress Rollback Plan

<!-- Claim format: - [ ] <outcome>. Claimed: <session> <ISO-8601>. Expires: <ISO-8601>. Exit: <criterion>. TTL <= 180 minutes. -->

> Approved proof-drift and verification-impact queue (operator, 2026-11-26). Tracking issue: #580.
> One issue per session, one PR, 180-minute budget. Scope, evidence, red/green steps, and stop
> conditions live in each issue. Read `AGENTS.md` and the `session-loop`/`verification` skills first.

## In progress

_None._

## Future

1. [ ] #573 Model the provisional `Ready` digest gate. Exit: `CoordinatedReadyDigest` passes in `AuthorityLocked` mode; `ProvisionalCounts` is an enforced expected-fail that shows a non-authority `Ready` locking a divergent digest (the divergent-digest commit is unreachable under a strict-majority quorum and stays a documented negative result); the witness reaches promotion, discard, authority commit, and participant accept; docs and FIX_MODE prose checks pass.
2. [ ] #575 Audit proof strength and retire non-binding Z3 claims. Exit: all `z3_*` tests are classified; a mutated basis gate leaves the stale desync tests green (recorded); stale claims are removed and at least one code-linked proof is added. Depends on #572.
3. [ ] #576 Extract proofable decision kernels from `p2p_session`. Exit: at least one pure kernel (`ChecksumBasisTracker`, `ReadyTranscripts`, or `TerminalEpochTable`) is `pub(crate)` in its own module with characterization evidence and a Kani target; no public API, wire, or behavior change; full tier and preflight pass. One module per PR.
4. [ ] #577 Add coordinated-drop trace validation. Exit: a real SimNet trace is accepted by TLC; a derived mutation that drops the digest check or counts a provisional `Ready` is rejected; the handshake trace contract still passes; runtime traces stay ephemeral. Depends on #573.
5. [ ] #578 Pilot TLAPS/Apalache for unbounded coordinated-drop safety. Exit: one chosen invariant is either proved by a pinned TLAPS with no omitted obligations, or a written infeasibility record names the failed obligation and the next concrete step; no PR-gate dependency is added. Research spike; may close negative.

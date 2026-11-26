# Fortress Rollback Plan

<!-- Claim format: - [ ] <outcome>. Claimed: <session> <ISO-8601>. Expires: <ISO-8601>. Exit: <criterion>. TTL <= 180 minutes. -->

> Approved proof-drift and verification-impact queue (operator, 2026-11-26). Tracking issue: #580.
> One issue per session, one PR, 180-minute budget. Scope, evidence, red/green steps, and stop
> conditions live in each issue. Read `AGENTS.md` and the `session-loop`/`verification` skills first.

## In progress

- [ ] #572 Prove the checksum basis token over converged freeze history — split part (b), Z3 slice: retire the stale "always trigger"/"terminal" desync claims, make the comparison proof basis-aware, and correct the `formal-spec.md` SAFE-7/version header. Claimed: ses_de6fd17caffetszqvtSz73umoT 2026-11-26T17:59:10Z. Expires: 2026-11-26T20:59:10Z. Exit: both stale claims are absent from `tests/verification/z3.rs` and `docs/specs/formal-spec.md`, the basis-aware/new Z3 proofs pass with pinned z3 5.1.0, and no existing test is weakened. Part (a) extraction+Kani and `ChecksumBasis.tla` remain on #572.

## Future

1. [ ] #572 Prove the checksum basis token over converged freeze history. Exit: the extracted tracker passes the listed Kani proofs; `verify-tla.sh ChecksumBasis` passes with `BasisBlind` enforced expected-fail and a non-vacuous witness; stale Z3 "always trigger"/"terminal" claims are removed; no wire change. Highest product risk.
2. [ ] #573 Model the provisional `Ready` digest gate. Exit: `CoordinatedReadyDigest` passes in `AuthorityLocked` mode; `ProvisionalCounts` reproduces the divergent-digest commit; witness shows promotion is reachable; docs and FIX_MODE prose checks pass.
3. [ ] #574 Prove the coordinated-drop terminal epoch table invariants. Exit: the extracted table passes the listed Kani proofs; the old handles-only key fails the one-ahead case; `formal-spec.md` no longer claims "without a new model"; full tests pass.
4. [ ] #575 Audit proof strength and retire non-binding Z3 claims. Exit: all `z3_*` tests are classified; a mutated basis gate leaves the stale desync tests green (recorded); stale claims are removed and at least one code-linked proof is added. Depends on #572.
5. [ ] #576 Extract proofable decision kernels from `p2p_session`. Exit: at least one pure kernel (`ChecksumBasisTracker`, `ReadyTranscripts`, or `TerminalEpochTable`) is `pub(crate)` in its own module with characterization evidence and a Kani target; no public API, wire, or behavior change; full tier and preflight pass. One module per PR.
6. [ ] #577 Add coordinated-drop trace validation. Exit: a real SimNet trace is accepted by TLC; a derived mutation that drops the digest check or counts a provisional `Ready` is rejected; the handshake trace contract still passes; runtime traces stay ephemeral. Depends on #573.
7. [ ] #578 Pilot TLAPS/Apalache for unbounded coordinated-drop safety. Exit: one chosen invariant is either proved by a pinned TLAPS with no omitted obligations, or a written infeasibility record names the failed obligation and the next concrete step; no PR-gate dependency is added. Research spike; may close negative.

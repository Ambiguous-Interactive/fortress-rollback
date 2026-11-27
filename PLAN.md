# Fortress Rollback Plan

<!-- Claim format: - [ ] <outcome>. Claimed: <session> <ISO-8601>. Expires: <ISO-8601>. Exit: <criterion>. TTL <= 180 minutes. -->

> Approved proof-drift and verification-impact queue (operator, 2026-11-26). Tracking issue: #580.
> One issue per session, one PR, 180-minute budget. Scope, evidence, red/green steps, and stop
> conditions live in each issue. Read `AGENTS.md` and the `session-loop`/`verification` skills first.

## In progress

_None._

## Future

1. [ ] #577 Add coordinated-drop trace validation. Exit: a real SimNet trace is accepted by TLC; a derived mutation that drops the digest check or counts a provisional `Ready` is rejected; the handshake trace contract still passes; runtime traces stay ephemeral.
2. [ ] #578 Pilot TLAPS/Apalache for unbounded coordinated-drop safety. Exit: one chosen invariant is either proved by a pinned TLAPS with no omitted obligations, or a written infeasibility record names the failed obligation and the next concrete step; no PR-gate dependency is added. Research spike; may close negative.

# Task Card

> Working note for one implementer. Approvals, oracle exceptions, and size/round
> exceptions are authoritative only when a named maintainer or coordinator other
> than the implementer records their own comment or review in the tracked PR or issue.

## Outcome

One sentence describing the observable result.

## Scope

- Owned paths:
- Network hosts (if any):
- Explicit non-goals:

## Plan

1. [Step, owned paths, expected observation]
2. [Step, owned paths, expected observation]
3. [Stop condition or decision point]

## Red

- Behavior change: failing test or reproduction command:
- Observed failure and intended reason:
- Refactor: characterization or differential baseline:
- Add/upgrade: recorded baseline and owning check:

## Green

- Passing command:
- Evidence (test count, timing, artifact):

## Validation

- Fast tier: `cargo fmt --all -- --check && cargo c && cargo tf`
- Full tier: `cargo fmt --all -- --check && cargo c && cargo tfull && cargo test --doc && RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items`
- Preflight: `python3 scripts/ci/agent-preflight.py --full --auto-fix`
- WASM check when portability-sensitive: `cargo check --target wasm32-unknown-unknown --no-default-features` and `cargo check -p wasm-browser-smoke --features hot-join --target wasm32-unknown-unknown --lib --tests`
- Deep lane (Kani/Z3/feature matrix) when proofs, protocol invariants, or feature-gated code are touched.

## Gates

- [ ] Baseline recorded: commit, CI state, relevant test count/measurement.
- [ ] Behavior change: red failed for the intended reason; reverting the fix (or applying a targeted mutation) makes it fail again; boundary/e2e path when user-visible/protocol/session.
- [ ] Refactor: characterization/differential evidence; no behavior diff.
- [ ] Add/upgrade: baseline plus owning check/artifact.
- [ ] Oracle integrity: no test, fixture, grader, or check was deleted, skipped, or weakened to get green unless a named maintainer or coordinator other than the implementer approves the exception and it is recorded in the tracked PR or issue; quarantined flakes have an issue and owner.
- [ ] Security review completed for any triggered area (untrusted input, secrets, network, deps, CI, agent tooling); otherwise N/A.
- [ ] Determinism-sensitive: repeated seeded runs with state-hash/transcript comparison.
- [ ] Wire-facing allocation cites `// alloc-bound:` and has a malformed-length regression.
- [ ] Structural: no new responsibility in an already-large file; the 1,000-line threshold excludes `#[cfg(test)]`; split on API boundaries, not LOC; an obvious simplification fits the diff budget or is filed as an issue.
- [ ] Docs/changelog/design-decision updates applied where the owning policy requires; out-of-scope findings filed.
- [ ] Explain-back written and checked against the diff by a separate pass: what, why, invariants, failure modes, rollback.
- [ ] Learning candidate recorded in the progress log; promote to a skill/check on recurrence or demonstrated reuse.

## Review Budget

- Maximum review rounds: 2
- Maximum CI rounds (failed required-check cycles): 2
- Escalation owner (named maintainer/coordinator other than the implementer, or N/A):

## Stop Condition

- Stop and re-scope if two attempts at the same approach fail.
- Stop if a blocking finding cannot be fixed within the review budget.
- Stop if the change exceeds 1,000 net new lines and cannot be split or escalated.
- Stop after a third review/CI round without named sign-off recorded in the PR.
- Stop if a destructive action lacks written approval in the tracked PR or issue.
- Stop if an approval or exception exists only in this local card.

## Risks and Rollback

- Primary risk:
- Rollback command:

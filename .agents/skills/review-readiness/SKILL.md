---
name: review-readiness
description: "Review Readiness Checklist guidance for Fortress Rollback. Use when Before opening PRs, self-review, merge readiness checks."
---

# Review Readiness Checklist

Concrete gate between implementation and external review. Use this after `dev-pipeline.md` Phase 4 and before opening a PR.

---

## Quick Gate (Must Pass)

- [ ] Fast tier passes: `cargo fmt --all -- --check && cargo c && cargo tf`
- [ ] Full tier passes before handoff: `cargo fmt --all -- --check && cargo c && cargo tfull && cargo test --doc && RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items`
- [ ] WASM check passes when portability-sensitive: `cargo check --target wasm32-unknown-unknown --no-default-features` and `cargo check -p wasm-browser-smoke --features hot-join --target wasm32-unknown-unknown --lib --tests`
- [ ] Deep lane (Kani/Z3/feature matrix) run when proofs, protocol invariants, or feature-gated code are touched
- [ ] Zero-panic scan has no new production hits
- [ ] Determinism scan has no risky additions in simulation paths
- [ ] Determinism-sensitive changes repeat a seeded scenario and compare state hashes or transcripts
- [ ] Error handling is explicit (`Result`, no silent discard)
- [ ] Behavior change: red failed for the intended reason and fails on revert/targeted mutation; boundary/e2e path when user-visible/protocol/session
- [ ] Refactor: characterization/differential evidence; add/upgrade: baseline + owning check
- [ ] Oracle integrity: no test, fixture, grader, or check was deleted, skipped, or weakened to get green unless a named maintainer or coordinator other than the implementer approves the exception and it is recorded in the tracked PR/issue; quarantined flakes have an issue and owner
- [ ] Wire-facing allocation cites `// alloc-bound:` and has a malformed-length regression
- [ ] Security review completed for untrusted input, secrets, network, dependencies, CI, or agent tooling
- [ ] Independent verifier used for multi-module or high-risk changes
- [ ] Explain-back written and checked against the diff by a separate pass: what, why, invariants, failure modes, rollback
- [ ] Structural: no structural regression, no unjustified file growth (1,000-line threshold excludes `#[cfg(test)]`, split on API boundaries, not LOC); an obvious simplification fits the diff budget or is filed as an issue
- [ ] Docs/changelog/design-decision updates applied where the owning policy requires
- [ ] Agent preflight passes: `python3 scripts/ci/agent-preflight.py --full --auto-fix`

If any Must Pass check fails, return to design and reduce scope before requesting review.

---

## Commands

```bash
# Fast tier (per edit)
cargo fmt --all -- --check && cargo c && cargo tf

# Full handoff tier
cargo fmt --all -- --check && cargo c && cargo tfull && cargo test --doc && RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items

# WASM when portability-sensitive
cargo check --target wasm32-unknown-unknown --no-default-features
cargo check -p wasm-browser-smoke --features hot-join --target wasm32-unknown-unknown --lib --tests

# Zero-panic scan (production code)
rg '\.unwrap\(\)|\.expect\(|panic!\(|todo!\(|unimplemented!\(' --type rust src/

# Determinism scan
rg 'HashMap|HashSet|Instant::now|SystemTime|thread_rng|random\(\)' --type rust src/

# Changed-file + full preflight
python3 scripts/ci/agent-preflight.py --full --auto-fix
```

---

## Review Readiness Output

Use this in PR descriptions or self-review comments:

```text
Review Readiness
- Build/tests: PASS|FAIL
- WASM: PASS|FAIL|N/A
- Deep lane: PASS|FAIL|N/A
- Zero-panic: PASS|FAIL
- Determinism: PASS|FAIL
- Agent preflight: PASS|FAIL
- Error handling: PASS|FAIL
- Evidence: behavior/refactor/add-upgrade
- Oracle: PASS|FAIL
- Boundary/e2e: PASS|FAIL|N/A
- Security: PASS|FAIL|N/A
- Independent review: PASS|FAIL|N/A
- Explain-back: PASS|FAIL
- Structural: PASS|FAIL
- Docs/changelog/design: PASS|FAIL|N/A
```

---

## Anti-Patterns

- Do not replace this checklist with prose summaries only.
- Do not mark PASS without running the checks.
- Do not treat a green nextest run as full validation; doctests, rustdoc, formatting, and WASM are separate.
- Do not treat a green test as proof when the oracle was weakened or the test never failed for the intended reason.
- Do not confuse a rerun with a flake fix, or a push with a CI round.
- Do not record approvals or exceptions only in the local task card.
- Do not accept a diff you cannot explain or roll back.
- Do not treat this as a style checklist; this is correctness-first.
- Do not open PRs with known blocking failures from this gate.

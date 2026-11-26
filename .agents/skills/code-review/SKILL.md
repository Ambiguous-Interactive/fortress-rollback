---
name: code-review
description: "Code Review Guide guidance for Fortress Rollback. Use when Reviewing PRs, auditing code changes, verifying zero-panic compliance, checking determinism."
---

# Code Review Guide

Structured review for fortress-rollback. Pass 1 finds correctness and verification-integrity issues. Pass 2 finds style and improvement opportunities. Pass 3 blocks structural regressions. Fix mechanical issues directly; flag judgment calls for discussion.

---

## Pass 1: Correctness (Blocking)

### 1A. Zero-Panic Compliance

Search the diff for forbidden patterns:

```bash
rg '\.unwrap\(\)|\.expect\(|panic!\(|todo!\(|unimplemented!\(' --type rust -- src/
```

Direct indexing (`array[i]` instead of `array.get(i)`) is not caught by `clippy::indexing_slicing` because the manifest allows it. Treat it as a manual review item: verify the bound is proven or prefer `.get()`.

Every hit in production code (`src/`, excluding `#[cfg(test)]` blocks) is a blocking issue. Verify the fix uses structured error handling.

### Forbidden vs Required Pattern

```rust
// FORBIDDEN
let val = map.get(&key).unwrap();

// REQUIRED
let val = map.get(&key).ok_or(FortressError::InternalErrorStructured {
    kind: InternalErrorKind::Custom("key not found in map"),
})?;
```

### 1B. Determinism Violations

Check for non-deterministic patterns in any code that runs during simulation:

| Pattern | Grep | Fix |
|---------|------|-----|
| HashMap iteration | `rg 'HashMap' --type rust src/` | `BTreeMap` or sort before use |
| System time | `rg 'Instant::now\|SystemTime' --type rust src/` | Frame counters |
| Thread-local RNG | `rg 'thread_rng\|random\(\)' --type rust src/` | Seeded RNG (`rand_pcg` or `rand_chacha`) |
| Pointer-based ordering | `rg 'as \*const\|addr\(\)' --type rust src/` | Stable IDs |
| Unordered iteration | `rg '\.par_iter\(\)' --type rust src/` | Sequential or collect+sort |

For determinism-sensitive changes, require a repeated seeded run with a state-hash or transcript comparison, not only a static grep.

### 1C. Error Handling Completeness

For every new `match` on `FortressError` or its sub-enums:

- Verify all variants are handled (no silent `_ =>` on `#[non_exhaustive]` enums that drops new cases)
- Verify structured variants are preferred over legacy string variants
- Verify `Result` values are propagated with `?`, not discarded with `let _ =`

### 1D. Enum Exhaustiveness

When a PR adds a new variant to any enum, search for all `match` sites:

```bash
rg 'match.*error|match.*kind|match.*reason|match.*state' --type rust src/
```

Every `_ =>` arm on a non-`#[non_exhaustive]` enum is suspicious. Adding a variant should cause compile errors at all match sites.

### 1E. State Consistency

For changes to `SyncLayer`, `P2PSession`, or `InputQueue`:

- Does the operation succeed completely or leave state unchanged?
- Could a partial failure corrupt the circular buffer in `SavedStates`?
- Is `Frame` arithmetic using `try_add`/`try_sub` (not raw `+`/`-`)?

### 1F. Adversarial Escalation Decision

Escalate using [adversarial-handoff.md](../adversarial-handoff/SKILL.md) when changes touch high-risk areas:

- Untrusted network input handling
- Frame arithmetic/rollback bounds
- Save/load state integrity
- Determinism-critical logic
- Wire-format or protocol compatibility
- Security-sensitive runtime behavior (auth/identity, secrets, network egress)

For supply-chain, CI, or agent-tooling changes, use
[dependency-management.md](../dependency-management/SKILL.md),
[github-actions.md](../github-actions/SKILL.md), and
[ci-debugging.md](../ci-debugging/SKILL.md) instead. For agent permissions, use
OWASP Agentic guidance; for the preflight check, run
`scripts/ci/agent-preflight.py`.

If triggered, complete adversarial handoff before final merge approval.

### 1G. Verification Integrity

Tests are evidence only when they can fail for the right reason. Check the test diff before trusting a green run:

- Did the change delete, skip, weaken, or rewrite a test, fixture, grader, or check to get green? Require a named maintainer or coordinator other than the implementer to approve the exception, with the evidence recorded in the tracked PR or issue; a quarantined flake needs an issue and owner.
- Does the new test fail on the pre-fix code (revert or targeted mutation), or does it pass before and after?
- Are expected values derived independently, or copied from the implementation's output?
- Do user-visible and protocol/session changes have a boundary or end-to-end path, not only unit tests?
- For refactors and rewrites, is there characterization or differential evidence that behavior did not change?
- Did `python3 scripts/verification/model-impact.py affected --base "${BASE_REF:-origin/main}"` flag a mapped component (set `BASE_REF` to the PR's actual base branch)? If so, is there a spec/proof/test update or a named maintainer waiver, and does the rendered table in `docs/specs/spec-divergences.md` match the manifest?
- Does every new or changed proof have a **RED mutation** (the proof fails when the guard is wrong) or a **non-vacuity witness** (the branch is reachable)? A witness shows reachability only; it does not demonstrate that a wrong guard fails. Is the proof labeled `code_linked`, `model_only`, `bounded`, or `witness_only` rather than presented as a code proof?
- Are "always", "terminal", "no false negatives", or "without a new model" claims still true for the current production behavior?

A test that cannot fail is not evidence. A rerun is not a fix for a flaky test.

---

## Pass 2: Quality (Non-Blocking)

### 2A. API Design

- Are new public types/functions documented with `///` and examples?
- Do new structs use `#[must_use]` where appropriate?
- Are new error variants structured (enum-based, not string-based)?
- Does the change follow the Builder pattern for configuration?

### 2B. Performance on Hot Path

Code in `advance_frame`, `SyncLayer::advance_frame`, input queues, and protocol handling is hot path:

- No allocations (no `String`, `Vec::new()`, `format!()`)
- No `clone()` where a reference suffices
- Prefer `SmallVec` over `Vec` for bounded collections

Classify a `clone()` by its receiver before flagging it. Cloning a range or a
cloneable iterator adapter snapshots traversal state; it does not clone the
backing collection or its elements. This can be necessary when a consuming,
short-circuiting adapter such as `any()` is followed by a full second pass. Make
intent explicit by constructing two fresh ranges/iterators when that is clearer.
For independent aggregates such as `min()` and `max()`, prefer one `fold()` pass
when it remains readable. If a repeated predicate memoizes or records state,
verify and document that the second pass is side-effect-idempotent rather than
calling it pure.

### 2C. Test Coverage

- Does the PR include tests for new functionality?
- Are error paths tested, not just happy paths?
- For bug fixes: is there a regression test that would have caught it?
- Naming convention: `what_condition_expected_behavior`

### 2D. Documentation Staleness

When public API changes, verify these are updated:

```bash
rg 'old_function_name|OldTypeName' --type rust --type md
```

Check: rustdoc, CHANGELOG.md, docs/user-guide.md, examples/. If a public API or behavior is misstated, escalate to Pass 1 (blocking); purely internal staleness is non-blocking.

### 2E. Design Decision Log Coverage

If the PR introduces a major architectural or behavior choice, verify a corresponding entry exists per [design-decisions.md](../design-decisions/SKILL.md).

---

## Pass 3: Structural Quality (Blocking on Regression)

Review with the ambition of a code-judo move: keep behavior, delete complexity. A working change that leaves the surrounding design messier is not approved.

- Is there a reframing that deletes a whole branch, helper, mode, flag, layer, or special case? If an obvious alternative fits the diff budget, request it; otherwise file an issue with evidence.
- Did the diff add ad-hoc conditionals or feature checks to unrelated flows? Push the logic into a state machine, policy, dedicated module, or the canonical layer.
- Is the logic reusing the existing helper, or is it a bespoke near-duplicate? Are boundaries leaking implementation details?
- Is the abstraction earning its keep, or is it a thin wrapper, identity helper, needless cast, or optionality that hides the invariant?
- Are related state updates atomic? If partial progress is intentional, is the intermediate state explicit and tested?
- Did a file cross 1,000 lines (excluding `#[cfg(test)]`), or did a new responsibility land in an already-large file without a module boundary? Split on API boundaries, not LOC.
- Does the refactor actually reduce the number of concepts a reader must hold, or does it merely move complexity around?

A structural regression, unjustified file growth, boundary leak, or missed obvious simplification that fits the diff budget is blocking. A merely stylistic preference is non-blocking. If the structural fix is out of scope, require an issue with evidence instead of normalizing the mess.

---

## Fortress-Specific Checks

### Frame Arithmetic

All frame math must use checked operations:

```rust
// FORBIDDEN: can overflow silently
let next = current_frame + offset;

// REQUIRED: returns FortressError::FrameArithmeticOverflow on overflow
let next = current_frame.try_add(offset)?;
```

### Serialization Compatibility

Changes to `Message`, network protocol types (`InputBytes`, `codec`), or serialized types risk wire-protocol breakage. Verify:

- Serde attributes are preserved
- New fields have defaults for backward compatibility
- Wire format tests exist

### Config Validation

New `SessionBuilder` parameters must validate at build time:

```rust
// REQUIRED: validate in builder, not at runtime
if fps == 0 {
    return Err(InvalidRequestKind::ZeroFps.into());
}
```

---

## Review Output Format

Structure findings as:

```
## Critical (must fix before merge)
- [file:line] Description citing specific code

## Structural (must fix before merge)
- [file:line] Regression or missed simplification, with the concrete alternative

## Suggestions (non-blocking)
- [file:line] Description with proposed alternative

## Verified
- Zero-panic compliance: PASS/FAIL (N hits found)
- Determinism: PASS/FAIL
- Error handling: PASS/FAIL
- Verification integrity: PASS/FAIL (revert/mutation check, oracle diff)
- Tests included: YES/NO
- Boundary/e2e path: YES/NO/N/A
- Design decision log: YES/NO/N/A
- Structural quality: PASS/FAIL
- Adversarial escalation required: YES/NO
```

---

## Checklist

- [ ] No `unwrap`/`expect`/`panic!`/`todo!` in production code
- [ ] No `HashMap` iteration in simulation paths
- [ ] No `Instant::now()` in game logic
- [ ] All `match` arms exhaustive (no silent `_ =>`)
- [ ] Frame arithmetic uses checked operations
- [ ] New public items have rustdoc with examples
- [ ] Error variants are structured, not string-based
- [ ] Tests cover both happy path and error cases
- [ ] Verification integrity: no oracle weakened; new test fails on revert or targeted mutation
- [ ] User-visible/protocol change has a boundary or end-to-end path
- [ ] No structural regression or unjustified file growth (1,000-line threshold excludes `#[cfg(test)]`); obvious simplification fits the diff budget or is filed
- [ ] `cargo doc --no-deps` passes (no broken doc links)
- [ ] CHANGELOG updated if pub/user-observable change
- [ ] `cargo c && cargo tf` passes

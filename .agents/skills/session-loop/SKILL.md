---
name: session-loop
description: "Run one agentic work session from triage to a merged green PR. Use when starting or coordinating a coding session, choosing unblocked work, auditing recent PR feedback, enforcing the 3-hour budget, or closing out with a synced repository. Do NOT use for feature design or deep code review; load dev-pipeline, code-review, or the owning area skill."
---

# Session Loop

One session = one item = one open authored PR, driven to a green merge or a clean handoff.

## Authority

A session needs an approved item: a `PLAN.md` `Future` entry approved by a named maintainer or
coordinator, a maintainer comment/review on the issue or PR, or a red `main` that the session is
fixing forward. Labels alone are not approval. If the approval is missing, triage and stop; do not
implement speculative work.

The user's prompt can approve an item for the current session. Record that approval in the tracked
PR or issue; a local task card is not an approval record.

## Clock

The clock starts at the first user message and stops at 180 minutes. It is wall clock, not active
time. Reserve the last 30 minutes for closeout.

| Window | Phase | Gate |
| --- | --- | --- |
| 0–20 | Sync and triage | Git synced; main CI state; open PRs; open issues; 5-day feedback audit; candidate queue |
| 20–40 | Deep analysis (only if no work) or task card | At most three evidence-backed findings; pick one; claim it |
| 40–130 | Implement red to green | Failing test or repro first; fast tier; checkpoint at 120 |
| 130–150 | Full validation and open PR | Full tier, preflight, triggered lanes; one PR |
| 150–165 | Review and merge cycle | At most two review rounds and two CI rounds; merge queue |
| 165–180 | Closeout | PLAN, progress log, git sync, branch cleanup, handoff |

Cutoffs:

- Do not open a PR after T+150.
- Do not start a merge attempt after T+165.
- If a cutoff is missed, commit session-owned changes as a WIP commit, push the branch, write the
  handoff, and stop. Preserve unrelated user changes. The next session finishes the PR before
  starting new work.

If the OpenCode session-budget plugin is active, it emits the clock and interrupts at 180 minutes.
After the limit it allows only an explicit read-only tool allowlist; unknown and custom tools are
blocked. If the tool guard cannot register, it removes mutating tools from the model request and
refuses new prompts. In other harnesses, run `scripts/ci/session-budget.py start`, `check`, and
`close` at the same boundaries. Do not rely on writing files after 180 minutes; write the handoff by
165.

## Step 1: Sync and triage

```bash
git fetch --prune origin
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
```

Confirm the worktree is clean and local `main` matches `origin/main`. Preserve unrelated user
changes; do not stash, reset, or overwrite them without asking.

Triage in this order:

1. Red `main` at HEAD or caused by a recent merge.
2. Open authored PRs from previous sessions, then unresolved review threads from PRs updated in the
   last five days.
3. Approved `PLAN.md` or maintainer-approved issues.
4. Correctness, consistency, or CAP findings with evidence.
5. Missing test, simulation, or determinism coverage for a real failure mode.
6. Cross-platform gaps.
7. Performance or allocation issues with a benchmark.
8. Documentation, changelog, skills, or CI quality.

## Step 2: Pick one item

Pick the highest-priority **unblocked** item. One item per session; related follow-ups are allowed
only when they share the same root cause and files and keep the diff under about 400 net lines.

Blocked means: waiting on a maintainer decision, missing credentials, a red dependency that is not
this session's item, or an approval that exists only in a local note. File or update the issue and
choose the next item; do not start speculative work.

### Second PR exception

A second PR may be opened only when all of these hold:

- The first PR is **merged**, not merely green.
- At least 60 minutes remain in the 180-minute clock, which means the first merged by T+120.
- The second item is independent, unblocked, and has its own task card.
- The session still has one open authored PR at a time.

Maximum two opened PRs per session. Merging an already-open green PR from a previous session does
not count. The exception is optional; closeout quality comes first.

## Step 3: Deep analysis (only if no work)

Timebox to 30 minutes. Look for evidence, not a wish list:

- **Correctness:** frame arithmetic, overflow, replay, checksum basis, terminal epochs, membership.
- **CAP/PACELC:** split-brain, quorum loss, coordinator isolation, fail-closed behavior, liveness,
  observability.
- **Tests:** missing boundary, property, deterministic simulation, or mutation coverage; shrink
  determinism; N-player, hot-join, spectator, and heal paths.
- **Cross-platform:** the trigger table below.
- **Performance:** per-poll work, clones, unbounded journals, allocation bounds; require a benchmark.

Output at most three findings. Each needs file/line, a concrete failure mode, a repro or benchmark,
and a falsifiable acceptance criterion. File issues for the ones not picked. If nothing is found,
record the negative results and stop; do not invent work.

## Step 4: Task card and claim

Use [`assets/task-card.md`](../fortress-development/assets/task-card.md) and the session card at
[`assets/session-card.md`](assets/session-card.md). The task card is a working note, not an
approval.

Claim the item where other sessions can see it:

- Comment on the issue with a marker, the session ID, the start time, and the expiry (start + 3
  hours).
- If the item is approved queue work, add one `PLAN.md` `In progress` entry with `Claimed:`,
  `Expires:`, and `Exit:` fields.
- Do not claim an issue with an open PR or an active, unexpired claim by another session.

A claim older than three hours is expired. Comment that the claim expired, take it over, and record
the takeover in the progress log.

Record the baseline before editing: commit, main CI state, relevant test count, benchmark, mutation
report, and the exact command used.

## Step 5: Implement red to green

- Write the failing test or repro first. Record the command and the failure, and confirm it fails
  for the intended reason.
- For a refactor, record characterization or differential evidence first.
- For an add/upgrade, record the baseline and the owning check.
- Implement the smallest change that addresses the class, not just the example.
- Run the fast tier after edits:

```bash
cargo fmt --all -- --check
cargo c
cargo tf
```

- Checkpoint at 120 minutes. If the change is not green, re-scope or hand off; do not start a third
  attempt at the same approach.

Keep behavior changes and refactors separate. Commit small, coherent commits once green. Record red
evidence before the fix.

## Step 6: Green PR cycle

Before opening the PR, run the full tier and the owning checks:

```bash
cargo fmt --all -- --check
cargo tfull
cargo test --doc
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items
python3 scripts/ci/agent-preflight.py --full --auto-fix
```

Add the WASM or deep lane when the trigger table requires it. Do not open a PR with a known failing
required check.

The PR must state the goal, evidence, risks, rollback, and the item link, and fill
`.github/PULL_REQUEST_TEMPLATE.md`. Do not check boxes for checks that were not run.

Review and CI budget:

- At most two review rounds and two CI rounds.
- Fix Critical and Major findings; record Minor findings as issues unless they affect correctness.
- Poll checks at 10-minute intervals, not with a watch loop.
- Twenty minutes of total CI wait per session. If the budget is exhausted, hand off the open PR.

## Main CI policy

The PR head and the merge queue are the gate. Main CI is post-merge verification, not a session
blocker.

- At session start, check the latest `main` runs. A red `main` caused by a recent merge is the
  session's item.
- After merge, do not poll `main`. Record "main CI pending" in the progress log. End the session
  unless the second-PR exception applies and is used.
- The next session checks `main` first. If it is red, it becomes that session's only item.
- A cancelled job is not green. Classify it as infrastructure, timeout, or a real failure before
  calling it a flake.

## Five-day feedback audit

Run this every session, even when other work is available.

1. List every PR updated in the last five days, merged and open.
2. Fetch unresolved, non-outdated review threads plus issue comments after the last review. Ignore
   bot receipts and comments that are already answered.
3. Verify each finding against current `HEAD`; a merged PR may already contain the fix.
4. Classify: fixed, still valid, or obsolete. Reply with evidence and resolve fixed and obsolete
   threads.
5. Fix at most one still-valid item this session. File the rest as issues with file/line, a failure
   mode, and a repro.
6. If the fix is a follow-up PR, run the same audit on its feedback before merge.

A green merge is not proof that feedback was addressed. Unresolved threads and post-merge comments
are the source of truth.

## CAP and PACELC gate

Classify the operation before changing protocol or session behavior:

| Operation | Posture | Rule |
| --- | --- | --- |
| Membership and confirmation | PC/EC | Fail closed; strict-majority certificate; document the availability cost |
| Input exchange | AP/EL | Rollback reconciles; predict within bounds |
| Telemetry and presentation | PA/EL | Stale data is acceptable; never affects simulation |

If the posture changes, add a row to [`docs/specs/consensus-posture.md`](../../../docs/specs/consensus-posture.md)
and test the partition matrix: minority, majority without authority, isolated coordinator, fallback
takeover, heal, split view, delayed and duplicated control messages.

## Cross-platform gate

| Change touches | Must run |
| --- | --- |
| Wire, hash, serialization | s390x big-endian codec and replay; wasm32 codec; native golden |
| Floats, schedule, time | aarch64 and i686; wasm; injected `TestClock`; no `mul_add` unless proven bit-identical |
| Sessions, hot-join, membership | wasm browser; Godot native and Emscripten, threaded and non-threaded |
| Performance or allocation | Native benchmark and wasm size/benchmark; allocation-contract check |
| Docs or CI only | Owning checks: `actionlint`, links, markdownlint |

Rust specifies `mul_add` as a single-rounded fused operation; a software fallback still implements
the fused result. Do not assume a separate `a*b + c` expression produces the same bits, because
compilers may contract it, and do not assume transcendentals are shared across targets. `sqrt` is
correctly rounded, not mathematically exact. Keep the repository's `mul_add` restriction until each
target has pinned evidence. Record which lanes ran; do not claim a lane that was skipped.

## Step 7: Closeout

1. Remove the `PLAN.md` `In progress` entry in the same change that finishes the work.
2. Write `progress/session-<id>-<brief>.md` with baseline, hypothesis, red and green evidence,
   decisions, negative results, timings, PR and CI rounds, main CI state, and residual risk.
3. Sync the repository:

```bash
git fetch --prune origin
git checkout main
git pull --ff-only
git rev-list --left-right --count origin/main...HEAD
git status --porcelain
```

Expect `0 0` and an empty status. Delete local and remote feature branches after merge.
4. If a PR remains open, push the branch, name the PR in the handoff, and leave the claim expiry
   visible. The next session finishes it first.
5. Do not start new work after T+180.

## Metrics

Record per session:

- wall time and phase timings
- PRs opened and merged
- review rounds, CI rounds, and CI wait minutes
- unresolved review threads older than five days
- main CI state at start and end
- tests added, mutation or coverage delta
- context size: `GOAL.md` words, skill count and words, always-on description words

Evaluate a policy change over five sessions. Keep it only if it reduces stale threads or red `main`
without a comparable loss of merged work; otherwise adjust or revert.

## Plan hygiene

`PLAN.md` is an execution queue, not an archive. Keep only approved `In progress` and ordered
`Future` items. Each item needs an outcome and a falsifiable exit criterion. Remove completed items
in the same change that finishes them. Never commit `GOAL.md` or `progress/`.

`In progress` holds at most one item:

```text
- [ ] #548 Split the Windows Miri misc lane. Claimed: session-20261123-1200 2026-11-23T12:00Z. Expires: 2026-11-23T15:00Z. Exit: cold-cache merge-queue run completes without cancellation.
```

Run `python3 scripts/hooks/check-plan-hygiene.py` before handoff.

## Anti-patterns

- Starting a second item while the first is red or blocked.
- Waiting on post-merge main CI.
- Opening a PR before local full validation.
- Fixing unrelated feedback threads in one PR to save a session.
- Drive-by refactors outside the task card.
- Calling a cancelled or skipped check green.
- Reporting a policy or benchmark win without the command, counts, and environment.

## References

- Project policy: [`fortress-development`](../fortress-development/SKILL.md)
- Pipeline phases: [`dev-pipeline`](../dev-pipeline/SKILL.md)
- Review gates: [`review-readiness`](../review-readiness/SKILL.md), [`code-review`](../code-review/SKILL.md)
- High-risk review: [`adversarial-review`](../adversarial-review/SKILL.md), [`adversarial-handoff`](../adversarial-handoff/SKILL.md)
- Testing: [`testing`](../testing/SKILL.md), [`mutation-testing`](../mutation-testing/SKILL.md), [`dst`](../dst/SKILL.md)
- Determinism and portability: [`determinism`](../determinism/SKILL.md), [`cross-platform`](../cross-platform/SKILL.md), [`wasm`](../wasm/SKILL.md)
- Consensus posture: [`docs/specs/consensus-posture.md`](../../../docs/specs/consensus-posture.md)

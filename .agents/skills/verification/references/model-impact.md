# Model-Impact Gate and Proof Strength

This reference supports the `verification` skill. It explains the executable code-to-model link,
the drift taxonomy the gate enforces, and the proof-strength labels reviewers need.

## Why the gate exists

The repository has a strong TLA+/Kani/Z3 suite, but a zero-context session could not tell which
proofs a change affected. An audit of two weeks of production fixes found 27/29 `fix`/`perf`
commits touched a source file named in the TLA code-to-model table while only 3/29 changed a
`.tla` file. The mapping was prose, so missing model updates and stale scope claims were invisible
at review time.

The manifest and `scripts/verification/model-impact.py` replace the prose-only link with:

- **paths** -- production files a component owns;
- **symbols** -- `path::name` definitions used to map a hunk to a component;
- **specs** / **tla_checks** -- TLA+ files and the registered `verify-tla.sh` check names;
- **kani** / **z3** / **tests** -- executable artifacts that must exist and be registered;
- **status** -- `modeled`, `bounded`, `unmodeled`, or `stale`;
- **residuals** -- known scope gaps with an expiry date;
- **waivers** -- named, time-boxed approval to change mapped code without a model update.

## Commands

```bash
# Validate the manifest, registrations, artifact existence, residual dates, and table.
python3 scripts/verification/model-impact.py check

# Map a diff (default origin/main) to components and exact verification commands.
python3 scripts/verification/model-impact.py affected --base origin/main

# Print drift without failing (local exploration only; CI uses the failing form).
python3 scripts/verification/model-impact.py affected --base origin/main --advisory

# Regenerate or verify the generated table in docs/specs/spec-divergences.md.
python3 scripts/verification/model-impact.py render
python3 scripts/verification/model-impact.py render --check
```

`check` fails closed on a missing path, spec, Kani harness, Z3 proof, Rust test, unregistered TLA
check, expired residual `review_by`, expired waiver, or a stale generated table. Symbol regex
mismatches are advisory because method-level Rust parsing is out of scope for the first pass.

## Drift taxonomy

| Drift | Example | Gate behavior |
| --- | --- | --- |
| Missing artifact | Manifest names a deleted spec or test | `check` fails |
| Registration drift | New `#[kani::proof]` not in `verify-kani.sh` | `check` fails |
| Stale scope | `stale` component changed; no spec/proof update | `affected` fails |
| Unmodeled change | `unmodeled` component changed; no update | `affected` fails |
| Symbol drift | Mapped `fn` body changed | `affected` fails unless a mapped spec/proof/test changed |
| Path-only drift | Changed file has no mapped symbol | `affected` fails (file-level fallback) |
| Waived change | Named approver + unexpired `expires` | `affected` passes, prints the waiver |
| Table drift | Manifest changed, generated block not rendered | `check` and `render --check` fail |

A change to test code alone does not trigger a symbol-mapped component: the gate compares the
changed line numbers with the mapped function's line range. A file-level mapping with no symbols
is intentionally coarser and flags any change to that file.

## Proof-strength levels

Every proof or model claim must be labeled; do not present a model check as a code proof.

| Level | Meaning | Evidence required |
| --- | --- | --- |
| `code_linked` | Proves the actual Rust guard/function | Kani on the production function, or a differential test that fails on a targeted mutation |
| `model_only` | Proves an abstract model of the algorithm | Label it; state the refinement gap to production |
| `bounded` | Proves a small configuration only | State the bound and the scope argument for larger inputs |
| `witness_only` | Demonstrates reachability/non-vacuity | Show the witness; do not count it as a safety proof |
| `tautology` | Restates its premise or the implementation | Retire it or convert it to a mutation-checked test |

Rules:

1. **Verify what executes.** A proof over a copied or re-implemented predicate is `model_only`.
   Extract the pure kernel and prove the real function, or record the gap in `residuals`.
2. **Every new proof needs a control.** Add a RED mutation (remove the guard, flip the condition)
   or a non-vacuity witness. A proof that stays green under the mutation is not evidence.
3. **No overclaim.** Remove words like "always", "terminal", or "without a new model" unless the
   model actually covers the current production behavior.
4. **Keep the summary honest.** Counts and labels in the PR body and docs must match the artifacts.

## Status semantics

- `modeled` -- the listed model/proofs cover the mapped behavior; a change needs an update.
- `bounded` -- the model covers a stated bound; a change at production scale needs an update.
- `unmodeled` -- no model/proof exists yet; a change needs a mapped spec/proof/test update or a waiver.
- `stale` -- a model exists but predates current behavior; a change needs the model update, a
  mapped spec/proof/test update, or a waiver.

The gate accepts any mapped spec/proof/test edit or an active waiver. Status is a review signal
that decides what the reviewer should demand, not a separate enforcement branch. `unmodeled` and
`stale` are deliberate debt markers, not passing grades. The residual `review_by` date forces
re-triage; an expired date fails `check`.

## Waivers

A waiver is an explicit, reviewable exception, not a bypass:

```toml
[[waiver]]
component = "checksum-basis"
reason = "wire-only refactor; no semantic change to the basis token"
approver = "named-maintainer"
expires = "2026-12-15"
```

- The approver must be a named maintainer or coordinator other than the implementer.
- Record the approval in the tracked PR or issue; the manifest entry is not the approval.
- Keep the expiry short. An expired waiver no longer suppresses drift and `check` fails.
- Prefer updating the model/proof or narrowing the mapping over adding a waiver.

## Wiring

- PR template: `Verification Impact` (`none` / `updated: <spec>` / `waived: <reason + approver>`)
  and the RED-mutation/non-vacuity checkbox.
- Task card: `## Model Impact` records the components and the proof control.
- Agent preflight runs `model-impact.py check` when `src/` or `specs/` changes.
- CI verification runs `check`, `render --check`, and `affected --base <PR base>` in the fast
  `pull_request` job; the full TLA/Kani suite stays on merge queue, main, and the nightly schedule.

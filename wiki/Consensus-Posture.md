<!-- SYNC: This wiki page is generated from docs/specs/consensus-posture.md. Edit docs source. -->

<p align="center">
  <img src="assets/logo-small.svg" alt="Fortress Rollback" width="64">
</p>

# Consensus Posture and Literature Review

**Status:** Proposed decision
**Scope:** Coordinated graceful-drop certificates and membership changes
**Issues:** #510, #516, #519

## Why this document exists

Fortress Rollback does not run consensus on every frame. Deterministic peers exchange
inputs and roll back locally; a membership change is the only operation that needs an
agreement decision, because two peers must never certify different successor histories
for the same removed target.

This document records the study requested in #510: which ideas from Paxos, Raft, and
modern consensus systems apply to that single decision, which do not, and why the
current protocol remains the chosen design. It is an architecture and CAP record, not a
new protocol. The normative behavior stays in
[api-contracts.md](API-Contracts), [formal-spec.md](Formal-Specification), and the
TLA+ models under `specs/tla/`.

## The workload

The removal path solves a **single-decree** problem:

- The value is one certificate: `(operation, cut, participant set, target generation)`.
- Removals and reactivations are rare, operator- or timeout-driven, and serialized.
- The participant set is derived from the agreed membership epoch, never from local
  reachability.
- A commit requires a strict majority of the survivor participant set (the agreed epoch
  minus the target handles), and a target is frozen at the certified cut before the
  certificate is applied.
- The protocol must be deterministic and replayable: the same bytes and schedule must
  produce the same trace on native, ARM, 32-bit, and WASM targets.
- There is no replicated log, no throughput target, no disk, and no trusted clock.

The last four constraints matter more than raw consensus throughput. They rule out
several otherwise excellent general-purpose designs before any performance comparison.

## Current design in one paragraph

The **lowest participant** is the deterministic coordinator. It admits one operation at
a time, collects inventory receipts from a strict-majority quorum, chooses a
non-retracting cut, distributes a bounded backfill, and applies a commit only after a
strict-majority ready quorum. If the coordinator is silent for a full grace, the
**second-lowest participant** may act as the fallback; that choice is deterministic, not
reachability-based, and the acting authority never exceeds the quorum or cut rules. A
per-operation **sequence**, target/participant digests, coordinator generation, and a
monotone **terminal epoch** fence stale and replayed artifacts. A peer that cannot
satisfy the rules stays fail-closed rather than inventing a certificate.

The safety argument is quorum intersection plus one stable ready transcript per peer,
modeled in `CoordinatorFailover.tla` and `CoordinatorSplitView.tla`. The epoch is an
admission guard, not agreed state: it removes stale transitions but never admits an
operation that the participant, generation, or quorum rules would reject. The
argument is recorded in [formal-spec.md](Formal-Specification#safe-12-coordinated-graceful-drop-history-immutability).

## Sources reviewed

The study used primary papers and the project's own models. The 30-minute research box
covered the first six sources; the remaining sources were checked for a specific claim.

| Source | Core idea | Relevance |
| --- | --- | --- |
| Lamport, *Paxos Made Simple* (2001) | Ballots, promises, and quorum intersection for one value | Direct: the terminal epoch is a ballot-like fence; strict-majority quorum is the same safety argument |
| Ongaro & Ousterhout, *In Search of an Understandable Consensus Algorithm* (USENIX ATC 2014) | Deterministic leader, terms, log matching, joint consensus, one-at-a-time membership change | Direct: deterministic authority, monotone identity, serialized membership change |
| Ongaro, *Consensus: Bridging Theory and Practice* (Stanford 2014, §4 and §9.6) | Single-server changes need overlapping majorities; Pre-Vote prevents term inflation on rejoin | Direct: the serialization rule and the silence-gated fallback are the analogous choices |
| Howard, Malkhi, & Spiegelman, *Flexible Paxos* (OPODIS 2016) | Quorums may be disjoint within one phase; every phase-1 quorum must intersect every phase-2 quorum | Not applicable: this protocol has one decision phase and no leader-election phase to separate |
| Liskov & Cowling, *Viewstamped Replication Revisited* (MIT-CSAIL-TR-2012-021) | Primary/backup views, view change, reconfiguration, recovery | Direct: fallback takeover is a bounded view change; the new authority must gather quorum evidence before choosing |
| Chandra, Griesemer, & Redstone, *Paxos Made Live* (PODC 2007) | Practical gaps: durability, membership, snapshots, epochs, operational failure modes | Direct: validates keeping the protocol small, bounded, and backed by models and tests |
| Tennage et al., *QuePaxa* (SOSP 2023) | Leaderless asynchronous core, randomized hedging, timeout-free liveness | Not applicable: rare one-shot decisions, determinism, and review budget dominate; no measured throughput problem |
| Moraru, Andersen, & Kaminsky, *EPaxos* (SOSP 2013) | Dependency ordering for commutative commands | Not applicable: one target, one decision, no command stream |
| Corbett et al., *Spanner* (OSDI 2012) | Time-based leases with bounded clock uncertainty | Not applicable: peer clocks are untrusted and the simulation must replay exactly |
| Dwork, Lynch, & Stockmeyer, *Consensus in the Presence of Partial Synchrony* (JACM 1988) | Safety under asynchrony; liveness only under partial synchrony | Direct: justifies fail-closed safety and bounded-time liveness |

## Decision matrix

| Concept | Decision | Rationale |
| --- | --- | --- |
| Strict-majority quorum over an agreed membership epoch | **Keep** | Two certificates cannot both complete; the denominator cannot shrink in a split view. This is the CAP safety core. |
| Deterministic coordinator and deterministic fallback | **Keep** | Reproducible traces, no election RNG, no reachability-dependent leader. |
| Monotone terminal epoch (ballot-like fence) | **Keep** | Closes the bounded-history replay hole from #516 after exact history is evicted. It is already modeled as an admission guard. |
| Sequence + target/participant digests + coordinator generation | **Keep** | Binds an operation to one target set and one agreed era; survives hot-join reactivation. |
| Serialized membership changes | **Keep** | This is the project's substitute for joint consensus: one change at a time keeps each certificate's survivor quorum (targets excluded) intersecting the next era's quorum without a second configuration phase. |
| Bounded coordinator-silence grace | **Keep** | A deterministic, replayable CheckQuorum/Pre-Vote analogue. It releases a silent coordinator only after a full window and never bypasses quorum. |
| Randomized election timeouts | **Reject** | Randomization improves liveness under dueling leaders, but this protocol has no elections and no throughput pressure; it would make seeded traces less reproducible. |
| Leaderless or pipelined consensus (QuePaxa, EPaxos, Multi-Paxos) | **Reject** | Removals are rare; the extra machinery would enlarge the review and test surface for no measured removal-latency gain. |
| Flexible Paxos phase separation | **Reject** | There is no separate leader-election phase to make smaller; relaxing the single-phase quorum would weaken the split-view safety argument. |
| Joint consensus for concurrent changes | **Reject for now** | Serialization already gives the required overlap. Joint consensus is the fallback if concurrent removals ever become a measured requirement. |
| Time-based leases (Spanner-style) | **Reject** | Requires bounded clock uncertainty that P2P peers cannot provide; `Instant` is only a local liveness timer, never a safety assumption. |
| Witness or learner role | **Defer** | A non-voting witness could improve availability in a 3-player removal, but it adds a new trust/membership role and is not needed by the current failure envelope. |

## What the current protocol already borrows

- **Paxos ballot fencing**: the terminal epoch is a monotone admission fence. An
  authority admits only its next epoch; a stale or future proposal is answered with the
  next acceptable value, and a participant discards an epoch below its own. This is the
  same "do not accept an older ballot" rule, narrowed to one operation family.
- **Raft leader identity and term**: the coordinator is deterministic, and the
  coordinator generation is the term-like era. A rejoin starts a fresh era, so a stale
  prepare cannot reopen an old operation.
- **Raft membership-change safety**: one change at a time and a strict majority of the
  agreed set. The certificate quorum is a strict majority of the survivors (targets
  excluded), so the next era's quorum intersects it; the project additionally binds the
  participant-set digest into the operation so a split view cannot derive two different
  denominators.
- **VR view change**: a fallback must collect quorum evidence before it chooses, and a
  conflicting cut cannot be applied. The fallback is a bounded, deterministic view
  change, not an election.
- **Paxos Made Live epochs and operational lessons**: the implementation records an
  explicit epoch, bounds every journal, validates every decoder field, and treats
  failure artifacts as peer-scoped unless an authority produced them.
- **Partial synchrony**: safety never depends on a timeout. The two-second operation
  deadline and one-second grace only decide when to stop waiting; a timeout cannot
  create a second certificate.

## CAP posture

Membership is **CP** by design:

- **Consistency**: a certificate requires a strict majority of the survivor participant
  set (the agreed epoch minus the target handles), so a minority cannot fork the
  confirmed history. A split-view heal that finds two incompatible cuts fails closed.
- **Availability**: a reachable strict majority can certify a removal only when a
  permitted authority is also reachable: the deterministic coordinator, or the
  second-lowest fallback after the bounded coordinator grace. A minority, a majority
  without a reachable authority, or a majority that cannot assemble the required
  reports and backfill does not certify. The grace never authorizes any other
  participant.
- **Partition tolerance**: the network may drop, duplicate, reorder, or delay any
  message. The protocol never assumes a bound to preserve safety; it only uses time to
  decide when to stop waiting.

This is the correct trade-off for a game whose confirmed inputs are the shared history.
Choosing availability on both sides of a partition would let each side freeze a different
cut for the same target, and the replay/desync defect would be unrecoverable. The
project's fail-closed state is therefore a feature, not an error path that should be
papered over.

The terminal epoch does not change the CAP posture. It is local admission state scoped
to one authority and target set; it cannot mint a certificate, and it is not imported by
hot-join. A peer that missed every prepare and abort can still accept a delayed prepare
and then time out; that residual case is documented and remains fail-closed.

## Follow-ups and evidence

- The models remain authoritative for the cut/quorum argument:
  `specs/tla/CoordinatorFailover.tla`, `CoordinatorFailoverCompeting.tla`,
  `CoordinatorSplitView.tla`, and `CoordinatedPeerDrop.tla`.
- Runtime evidence for the epoch guard lives in the focused session tests
  (`evicted_terminal_prepare_is_rejected_by_the_terminal_epoch`,
  `stale_terminal_epoch_prepare_is_rejected_at_a_participant`,
  `stale_coordinator_generation_abort_cannot_reset_a_newer_epoch`, and the
  fallback-authority table) plus `wire_golden_v6` and the cross-architecture replay
  digests.
- Cross-platform coverage is intentionally split: native and QEMU lanes prove the
  arithmetic and trace identity, the browser/Godot probes prove the WASM and Emscripten
  runtime path. A future probe for the terminal-epoch replay guard in those runtimes is
  a test-only enhancement, not a protocol change.
- Coordinate the next review of this decision with any measured coordinator-loss
  removal-latency regression. The first response is a data-gathering simulation row, not
  a new consensus protocol.

## References

1. Leslie Lamport. *Paxos Made Simple*. ACM SIGACT News 32(4), 2001.
   <https://lamport.azurewebsites.net/pubs/paxos-simple.pdf>
2. Diego Ongaro and John Ousterhout. *In Search of an Understandable Consensus
   Algorithm*. USENIX ATC 2014.
   <https://www.usenix.org/system/files/conference/atc14/atc14-paper-ongaro.pdf>
3. Diego Ongaro. *Consensus: Bridging Theory and Practice*. PhD dissertation, Stanford
   University, 2014. <https://web.stanford.edu/~ouster/cgi-bin/papers/OngaroPhD.pdf>
4. Heidi Howard, Dahlia Malkhi, and Alexander Spiegelman. *Flexible Paxos: Quorum
   Intersection Revisited*. OPODIS 2016. <https://doi.org/10.4230/LIPIcs.OPODIS.2016.25>
5. Barbara Liskov and James Cowling. *Viewstamped Replication Revisited*.
   MIT-CSAIL-TR-2012-021, 2012. <https://pmg.csail.mit.edu/papers/vr-revisited.pdf>
6. Tushar D. Chandra, Robert Griesemer, and Joshua Redstone. *Paxos Made Live: An
   Engineering Perspective*. PODC 2007. <https://doi.org/10.1145/1281100.1281103>
7. Pasindu Tennage et al. *QuePaxa: Escaping the Tyranny of Timeouts in Consensus*.
   SOSP 2023. <https://doi.org/10.1145/3600006.3613150>
8. Iulian Moraru, David G. Andersen, and Michael Kaminsky. *There Is More Consensus in
   Egalitarian Parliaments*. SOSP 2013. <https://doi.org/10.1145/2517349.2517350>
9. James C. Corbett et al. *Spanner: Google's Globally-Distributed Database*. OSDI 2012.
   <https://research.google/pubs/pub39966/>
10. Cynthia Dwork, Nancy Lynch, and Larry Stockmeyer. *Consensus in the Presence of
    Partial Synchrony*. JACM 35(2), 1988. <https://doi.org/10.1145/42282.42283>

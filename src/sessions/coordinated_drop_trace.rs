//! Bounded runtime events for coordinated-drop trace validation.
//!
//! This module is compiled only for the opt-in `trace-validation` feature. It
//! does not observe individual wire deliveries: the session publishes one
//! compact post-poll snapshot, and `CoordinatedDropTraceRecorder` derives the
//! ordered observable transitions from the difference against the previous
//! snapshot. The recorder reserves its complete capacity on activation and
//! never allocates while the session is running.
//!
//! The projection is deliberately narrow. It records the operation identity,
//! attempt phase, selected cut, locked digest, counted and provisional Ready
//! reporters, installed backfill progress, applied commit, and committed target
//! fences. It does not expose endpoint addresses, receipt vectors, raw input
//! bytes, or the full multithreaded session state.

use crate::network::messages::DropOperationId;
use crate::sessions::coordinated_drop::CoordinatedDropPhase;
use crate::{FortressError, Frame};

/// Number of player handles representable by protocol v1.
pub(crate) const COORDINATED_DROP_TRACE_PLAYERS: usize = 256;

/// Maximum logical records one session recorder may reserve.
pub const MAX_COORDINATED_DROP_TRACE_EVENTS: usize = 256;

/// Stable public projection of one coordinated-drop operation identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoordinatedDropTraceOperation {
    /// Smallest player handle owned by the coordinating endpoint.
    pub coordinator: u16,
    /// Connected-era generation of the coordinator when the attempt opened.
    pub coordinator_generation: u16,
    /// Coordinator-local monotonic operation sequence.
    pub sequence: u32,
    /// Digest of the canonical target list.
    pub target_set_digest: u64,
    /// Digest of the canonical participant set.
    pub participant_set_digest: u64,
    /// Authority-minted terminal-attempt epoch.
    pub terminal_epoch: u32,
}

impl From<DropOperationId> for CoordinatedDropTraceOperation {
    fn from(value: DropOperationId) -> Self {
        Self {
            coordinator: value.coordinator,
            coordinator_generation: value.coordinator_generation,
            sequence: value.sequence,
            target_set_digest: value.target_set_digest,
            participant_set_digest: value.participant_set_digest,
            terminal_epoch: value.terminal_epoch,
        }
    }
}

/// Bounded phase projection for one coordinated-drop attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordinatedDropTracePhase {
    /// Inventory reports are being collected.
    Inventory,
    /// The selected cut is being backfilled.
    Backfill,
    /// Participants are reporting Ready for the selected cut.
    Ready,
    /// The certificate was applied.
    Committed,
}

impl From<CoordinatedDropPhase> for CoordinatedDropTracePhase {
    fn from(value: CoordinatedDropPhase) -> Self {
        match value {
            CoordinatedDropPhase::Inventory => Self::Inventory,
            CoordinatedDropPhase::Backfill => Self::Backfill,
            CoordinatedDropPhase::Ready => Self::Ready,
            CoordinatedDropPhase::Committed => Self::Committed,
        }
    }
}

/// One observable coordinated-drop transition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordinatedDropTraceAction {
    /// The recorder was activated before the session started polling.
    Activated,
    /// A prepare opened or was admitted for one operation.
    PrepareAdmitted {
        operation: CoordinatedDropTraceOperation,
        participants: u16,
        targets: u16,
    },
    /// A prepare was rejected as superseded or terminal.
    PrepareRejected {
        operation: CoordinatedDropTraceOperation,
        targets: u16,
    },
    /// The attempt advanced to another phase.
    PhaseChanged { phase: CoordinatedDropTracePhase },
    /// The attempt selected a cut frame.
    CutSelected { cut: Frame },
    /// The attempt locked the cut digest.
    DigestLocked { cut: Frame, digest: u64 },
    /// One participant became counted toward the Ready quorum.
    ReadyCounted {
        participant: u16,
        cut: Frame,
        digest: u64,
        authority: bool,
    },
    /// One participant became provisional before the digest locked.
    ReadyProvisional {
        participant: u16,
        cut: Frame,
        digest: u64,
    },
    /// One provisional participant was discarded after the digest locked.
    ReadyDiscarded { participant: u16 },
    /// One more backfill chunk was installed.
    BackfillInstalled { installed: u16 },
    /// This endpoint applied a commit.
    CommitApplied { cut: Frame, digest: u64 },
    /// This endpoint committed a target fence at a cut.
    TargetFrozen { handle: u16, cut: Frame },
    /// The active attempt cleared. Attempt-local state resets, including any
    /// applied commit; the session-global committed target fences survive.
    AttemptCleared,
}

/// Fixed-size projection of the coordinated-drop state after one poll.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoordinatedDropTraceState {
    /// Whether an attempt is active.
    pub active: bool,
    /// Current operation identity, when active.
    pub operation: Option<CoordinatedDropTraceOperation>,
    /// Current attempt phase, when active.
    pub phase: Option<CoordinatedDropTracePhase>,
    /// Local participant handle for the active attempt.
    pub local_participant: u16,
    /// Effective authority handle for the active attempt.
    pub authority: u16,
    /// Strict-majority Ready quorum for the active attempt.
    pub quorum: u16,
    /// Number of participants in the active attempt.
    pub participant_count: u16,
    /// Number of target slots in the active attempt.
    pub target_count: u16,
    /// Ready reports counted toward the quorum.
    pub counted: [bool; COORDINATED_DROP_TRACE_PLAYERS],
    /// Cut carried by each counted Ready.
    pub counted_cut: [i32; COORDINATED_DROP_TRACE_PLAYERS],
    /// Digest carried by each counted Ready.
    pub counted_digest: [u64; COORDINATED_DROP_TRACE_PLAYERS],
    /// Non-authority reports held provisionally before the digest locked.
    pub provisional: [bool; COORDINATED_DROP_TRACE_PLAYERS],
    /// Cut carried by each provisional Ready.
    pub provisional_cut: [i32; COORDINATED_DROP_TRACE_PLAYERS],
    /// Digest carried by each provisional Ready.
    pub provisional_digest: [u64; COORDINATED_DROP_TRACE_PLAYERS],
    /// Selected cut, when known.
    pub cut: Option<Frame>,
    /// Locked cut digest, when known.
    pub digest: Option<u64>,
    /// Installed backfill chunks for the active attempt.
    pub backfill_installed: u16,
    /// Whether this endpoint applied the active attempt's commit.
    pub committed: bool,
    /// Handles this endpoint committed as dropped.
    pub frozen: [bool; COORDINATED_DROP_TRACE_PLAYERS],
    /// Cut at which each frozen handle was committed.
    pub frozen_cut: [i32; COORDINATED_DROP_TRACE_PLAYERS],
}

impl CoordinatedDropTraceState {
    /// Empty snapshot used before the first coordinated-drop transition.
    pub(crate) const fn empty() -> Self {
        Self {
            active: false,
            operation: None,
            phase: None,
            local_participant: 0,
            authority: 0,
            quorum: 0,
            participant_count: 0,
            target_count: 0,
            counted: [false; COORDINATED_DROP_TRACE_PLAYERS],
            counted_cut: [0; COORDINATED_DROP_TRACE_PLAYERS],
            counted_digest: [0; COORDINATED_DROP_TRACE_PLAYERS],
            provisional: [false; COORDINATED_DROP_TRACE_PLAYERS],
            provisional_cut: [0; COORDINATED_DROP_TRACE_PLAYERS],
            provisional_digest: [0; COORDINATED_DROP_TRACE_PLAYERS],
            cut: None,
            digest: None,
            backfill_installed: 0,
            committed: false,
            frozen: [false; COORDINATED_DROP_TRACE_PLAYERS],
            frozen_cut: [0; COORDINATED_DROP_TRACE_PLAYERS],
        }
    }
}

/// One recorded transition and its complete post-transition projection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoordinatedDropTraceEvent {
    /// Transition that produced this post-state.
    pub action: CoordinatedDropTraceAction,
    /// Complete local projection after the transition.
    pub state: CoordinatedDropTraceState,
}

/// Terminal failure produced when the fixed trace capacity is exhausted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoordinatedDropTraceOverflow {
    /// Configured logical record capacity.
    pub capacity: usize,
    /// Records retained before the first overflow attempt.
    pub recorded: usize,
}

/// Fixed-capacity, allocation-free-after-construction event recorder.
#[derive(Debug)]
pub(crate) struct CoordinatedDropTraceRecorder {
    events: Vec<CoordinatedDropTraceEvent>,
    capacity: usize,
    overflowed: bool,
    previous: CoordinatedDropTraceState,
}

fn reset_attempt_local(state: &mut CoordinatedDropTraceState) {
    state.active = false;
    state.operation = None;
    state.phase = None;
    state.local_participant = 0;
    state.authority = 0;
    state.quorum = 0;
    state.participant_count = 0;
    state.target_count = 0;
    state.counted = [false; COORDINATED_DROP_TRACE_PLAYERS];
    state.counted_cut = [0; COORDINATED_DROP_TRACE_PLAYERS];
    state.counted_digest = [0; COORDINATED_DROP_TRACE_PLAYERS];
    state.provisional = [false; COORDINATED_DROP_TRACE_PLAYERS];
    state.provisional_cut = [0; COORDINATED_DROP_TRACE_PLAYERS];
    state.provisional_digest = [0; COORDINATED_DROP_TRACE_PLAYERS];
    state.cut = None;
    state.digest = None;
    state.backfill_installed = 0;
    state.committed = false;
}

impl CoordinatedDropTraceRecorder {
    /// Reserve the complete logical capacity before the session starts.
    pub(crate) fn try_new(capacity: usize) -> Result<Self, FortressError> {
        let mut events = Vec::new();
        events.try_reserve_exact(capacity).map_err(|_error| {
            crate::error::allocation_failed("p2p.coordinated_drop_trace", capacity)
        })?;
        Ok(Self {
            events,
            capacity,
            overflowed: false,
            previous: CoordinatedDropTraceState::empty(),
        })
    }

    fn push(&mut self, action: CoordinatedDropTraceAction, state: &CoordinatedDropTraceState) {
        if self.overflowed {
            return;
        }
        if self.events.len() >= self.capacity {
            self.overflowed = true;
            return;
        }
        self.events.push(CoordinatedDropTraceEvent {
            action,
            state: *state,
        });
    }

    /// Record an explicit prepare rejection that changes no projected state.
    pub(crate) fn record_rejection(
        &mut self,
        operation: CoordinatedDropTraceOperation,
        targets: u16,
    ) {
        let state = self.previous;
        self.push(
            CoordinatedDropTraceAction::PrepareRejected { operation, targets },
            &state,
        );
    }

    /// Derive and record every observable transition between snapshots.
    pub(crate) fn observe(&mut self, observed: &CoordinatedDropTraceState) {
        let mut next = self.previous;

        if observed.operation != next.operation {
            // A new operation starts from an empty attempt projection and a
            // cleared operation ends it; only the session-global frozen-target
            // set survives either transition.
            reset_attempt_local(&mut next);
            if let Some(operation) = observed.operation {
                next.operation = Some(operation);
                next.active = true;
                next.local_participant = observed.local_participant;
                next.authority = observed.authority;
                next.quorum = observed.quorum;
                next.participant_count = observed.participant_count;
                next.target_count = observed.target_count;
                self.push(
                    CoordinatedDropTraceAction::PrepareAdmitted {
                        operation,
                        participants: observed.participant_count,
                        targets: observed.target_count,
                    },
                    &next,
                );
            } else {
                self.push(CoordinatedDropTraceAction::AttemptCleared, &next);
            }
        }

        if observed.phase != next.phase {
            if let Some(phase) = observed.phase {
                next.phase = Some(phase);
                self.push(CoordinatedDropTraceAction::PhaseChanged { phase }, &next);
            }
        }

        if observed.cut != next.cut {
            if let Some(cut) = observed.cut {
                next.cut = Some(cut);
                self.push(CoordinatedDropTraceAction::CutSelected { cut }, &next);
            }
        }

        if observed.digest != next.digest {
            if let (Some(cut), Some(digest)) = (observed.cut, observed.digest) {
                next.digest = Some(digest);
                self.push(
                    CoordinatedDropTraceAction::DigestLocked { cut, digest },
                    &next,
                );
            }
        }

        if observed.backfill_installed > next.backfill_installed {
            next.backfill_installed = observed.backfill_installed;
            self.push(
                CoordinatedDropTraceAction::BackfillInstalled {
                    installed: next.backfill_installed,
                },
                &next,
            );
        }

        for (participant, &is_provisional) in observed.provisional.iter().enumerate() {
            let Some(current) = next.provisional.get(participant).copied() else {
                continue;
            };
            if !is_provisional || current {
                continue;
            }
            let Some(slot) = next.provisional.get_mut(participant) else {
                continue;
            };
            *slot = true;
            let cut = observed
                .provisional_cut
                .get(participant)
                .copied()
                .unwrap_or_default();
            let digest = observed
                .provisional_digest
                .get(participant)
                .copied()
                .unwrap_or_default();
            if let Some(value) = next.provisional_cut.get_mut(participant) {
                *value = cut;
            }
            if let Some(value) = next.provisional_digest.get_mut(participant) {
                *value = digest;
            }
            self.push(
                CoordinatedDropTraceAction::ReadyProvisional {
                    participant: u16::try_from(participant).unwrap_or(u16::MAX),
                    cut: Frame::new(cut),
                    digest,
                },
                &next,
            );
        }

        for (participant, &is_counted) in observed.counted.iter().enumerate() {
            let Some(current) = next.counted.get(participant).copied() else {
                continue;
            };
            if !is_counted || current {
                continue;
            }
            let Some(slot) = next.counted.get_mut(participant) else {
                continue;
            };
            *slot = true;
            let cut = observed
                .counted_cut
                .get(participant)
                .copied()
                .unwrap_or_default();
            let digest = observed
                .counted_digest
                .get(participant)
                .copied()
                .unwrap_or_default();
            if let Some(value) = next.counted_cut.get_mut(participant) {
                *value = cut;
            }
            if let Some(value) = next.counted_digest.get_mut(participant) {
                *value = digest;
            }
            if let Some(value) = next.provisional.get_mut(participant) {
                *value = false;
            }
            let handle = u16::try_from(participant).unwrap_or(u16::MAX);
            self.push(
                CoordinatedDropTraceAction::ReadyCounted {
                    participant: handle,
                    cut: Frame::new(cut),
                    digest,
                    authority: handle == observed.authority,
                },
                &next,
            );
        }

        for (participant, &is_provisional) in observed.provisional.iter().enumerate() {
            let Some(current) = next.provisional.get(participant).copied() else {
                continue;
            };
            if !current || is_provisional {
                continue;
            }
            let Some(slot) = next.provisional.get_mut(participant) else {
                continue;
            };
            *slot = false;
            self.push(
                CoordinatedDropTraceAction::ReadyDiscarded {
                    participant: u16::try_from(participant).unwrap_or(u16::MAX),
                },
                &next,
            );
        }

        if observed.committed && !next.committed {
            next.committed = true;
            if let (Some(cut), Some(digest)) = (observed.cut, observed.digest) {
                self.push(
                    CoordinatedDropTraceAction::CommitApplied { cut, digest },
                    &next,
                );
            }
        }

        for (handle, &is_frozen) in observed.frozen.iter().enumerate() {
            let Some(current) = next.frozen.get(handle).copied() else {
                continue;
            };
            if !is_frozen || current {
                continue;
            }
            let Some(slot) = next.frozen.get_mut(handle) else {
                continue;
            };
            *slot = true;
            let cut = observed.frozen_cut.get(handle).copied().unwrap_or_default();
            if let Some(value) = next.frozen_cut.get_mut(handle) {
                *value = cut;
            }
            self.push(
                CoordinatedDropTraceAction::TargetFrozen {
                    handle: u16::try_from(handle).unwrap_or(u16::MAX),
                    cut: Frame::new(cut),
                },
                &next,
            );
        }

        self.previous = next;
    }

    /// The complete recorded trace, or a terminal overflow error.
    pub(crate) fn result(
        &self,
    ) -> Result<&[CoordinatedDropTraceEvent], CoordinatedDropTraceOverflow> {
        if self.overflowed {
            return Err(CoordinatedDropTraceOverflow {
                capacity: self.capacity,
                recorded: self.events.len(),
            });
        }
        Ok(&self.events)
    }
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn operation() -> CoordinatedDropTraceOperation {
        CoordinatedDropTraceOperation {
            coordinator: 0,
            coordinator_generation: 0,
            sequence: 1,
            target_set_digest: 11,
            participant_set_digest: 22,
            terminal_epoch: 0,
        }
    }

    fn active_state() -> CoordinatedDropTraceState {
        let mut state = CoordinatedDropTraceState::empty();
        state.active = true;
        state.operation = Some(operation());
        state.phase = Some(CoordinatedDropTracePhase::Inventory);
        state.local_participant = 0;
        state.authority = 0;
        state.quorum = 2;
        state.participant_count = 2;
        state.target_count = 1;
        state
    }

    #[test]
    fn recorder_derives_ordered_observable_transitions() {
        let mut recorder = CoordinatedDropTraceRecorder::try_new(16).unwrap();
        recorder.observe(&active_state());

        let mut ready = active_state();
        ready.phase = Some(CoordinatedDropTracePhase::Ready);
        ready.cut = Some(Frame::new(3));
        recorder.observe(&ready);

        let mut locked = ready;
        locked.digest = Some(7);
        recorder.observe(&locked);

        let mut counted = locked;
        counted.counted[0] = true;
        counted.counted_cut[0] = 3;
        counted.counted_digest[0] = 7;
        recorder.observe(&counted);

        let mut provisional = counted;
        provisional.provisional[1] = true;
        provisional.provisional_cut[1] = 3;
        provisional.provisional_digest[1] = 7;
        recorder.observe(&provisional);

        let mut promoted = provisional;
        promoted.counted[1] = true;
        promoted.counted_cut[1] = 3;
        promoted.counted_digest[1] = 7;
        promoted.provisional[1] = false;
        recorder.observe(&promoted);

        let mut committed = promoted;
        committed.phase = Some(CoordinatedDropTracePhase::Committed);
        committed.committed = true;
        committed.frozen[2] = true;
        committed.frozen_cut[2] = 3;
        recorder.observe(&committed);

        let actions: Vec<_> = recorder
            .result()
            .unwrap()
            .iter()
            .map(|event| event.action)
            .collect();
        assert!(matches!(
            actions[0],
            CoordinatedDropTraceAction::PrepareAdmitted { .. }
        ));
        assert!(actions.contains(&CoordinatedDropTraceAction::PhaseChanged {
            phase: CoordinatedDropTracePhase::Ready
        }));
        assert!(actions.contains(&CoordinatedDropTraceAction::CutSelected { cut: Frame::new(3) }));
        assert!(actions.contains(&CoordinatedDropTraceAction::DigestLocked {
            cut: Frame::new(3),
            digest: 7
        }));
        assert!(actions.contains(&CoordinatedDropTraceAction::ReadyCounted {
            participant: 0,
            cut: Frame::new(3),
            digest: 7,
            authority: true
        }));
        assert!(
            actions.contains(&CoordinatedDropTraceAction::ReadyProvisional {
                participant: 1,
                cut: Frame::new(3),
                digest: 7
            })
        );
        assert!(actions.contains(&CoordinatedDropTraceAction::ReadyCounted {
            participant: 1,
            cut: Frame::new(3),
            digest: 7,
            authority: false
        }));
        assert!(
            actions.contains(&CoordinatedDropTraceAction::CommitApplied {
                cut: Frame::new(3),
                digest: 7
            })
        );
        assert!(actions.contains(&CoordinatedDropTraceAction::TargetFrozen {
            handle: 2,
            cut: Frame::new(3)
        }));
    }

    #[test]
    fn recorder_overflow_is_terminal() {
        let mut recorder = CoordinatedDropTraceRecorder::try_new(1).unwrap();
        recorder.observe(&active_state());
        let mut ready = active_state();
        ready.phase = Some(CoordinatedDropTracePhase::Ready);
        recorder.observe(&ready);

        assert_eq!(
            recorder.result().unwrap_err(),
            CoordinatedDropTraceOverflow {
                capacity: 1,
                recorded: 1,
            }
        );
    }

    #[test]
    fn recorder_records_rejection_without_changing_state() {
        let mut recorder = CoordinatedDropTraceRecorder::try_new(2).unwrap();
        recorder.record_rejection(operation(), 1);
        let trace = recorder.result().unwrap();
        assert_eq!(trace.len(), 1);
        assert!(matches!(
            trace[0].action,
            CoordinatedDropTraceAction::PrepareRejected { targets: 1, .. }
        ));
        assert!(!trace[0].state.active);
    }
    #[test]
    fn recorder_clears_attempt_local_state_but_keeps_frozen_targets() {
        let mut recorder = CoordinatedDropTraceRecorder::try_new(16).unwrap();
        let mut active = active_state();
        active.phase = Some(CoordinatedDropTracePhase::Committed);
        active.cut = Some(Frame::new(3));
        active.digest = Some(7);
        active.counted[0] = true;
        active.committed = true;
        active.frozen[3] = true;
        active.frozen_cut[3] = 3;
        recorder.observe(&active);

        recorder.observe(&CoordinatedDropTraceState::empty());

        let trace = recorder.result().unwrap();
        let event = trace.last().expect("clear transition is recorded");
        assert_eq!(event.action, CoordinatedDropTraceAction::AttemptCleared);
        assert!(!event.state.active);
        assert_eq!(event.state.operation, None);
        assert_eq!(event.state.phase, None);
        assert_eq!(event.state.local_participant, 0);
        assert_eq!(event.state.authority, 0);
        assert_eq!(event.state.quorum, 0);
        assert_eq!(event.state.participant_count, 0);
        assert_eq!(event.state.target_count, 0);
        assert_eq!(event.state.cut, None);
        assert_eq!(event.state.digest, None);
        assert_eq!(event.state.backfill_installed, 0);
        assert!(!event.state.committed);
        assert!(!event.state.counted.iter().any(|counted| *counted));
        assert!(!event.state.provisional.iter().any(|held| *held));
        assert!(event.state.frozen[3]);
        assert_eq!(event.state.frozen_cut[3], 3);
    }

    #[test]
    fn recorder_resets_attempt_local_state_for_a_new_operation() {
        let mut recorder = CoordinatedDropTraceRecorder::try_new(16).unwrap();
        let mut first = active_state();
        first.phase = Some(CoordinatedDropTracePhase::Committed);
        first.cut = Some(Frame::new(3));
        first.digest = Some(7);
        first.counted[0] = true;
        first.committed = true;
        first.frozen[3] = true;
        first.frozen_cut[3] = 3;
        recorder.observe(&first);

        let mut second = active_state();
        second.operation = Some(CoordinatedDropTraceOperation {
            sequence: 2,
            ..operation()
        });
        second.frozen = first.frozen;
        second.frozen_cut = first.frozen_cut;
        recorder.observe(&second);

        let trace = recorder.result().unwrap();
        let event = trace
            .iter()
            .find(|event| {
                matches!(
                    event.action,
                    CoordinatedDropTraceAction::PrepareAdmitted { operation, .. }
                        if operation.sequence == 2
                )
            })
            .expect("second operation admission is recorded");
        let state = event.state;
        assert_eq!(state.cut, None);
        assert_eq!(state.digest, None);
        assert!(!state.committed);
        assert!(!state.counted.iter().any(|counted| *counted));
        assert!(state.frozen[3]);
    }
}

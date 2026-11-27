//! Coordinated-drop state model and pure transition kernels.
//!
//! A coordinated graceful drop is a barrier: one authority selects a cut,
//! survivors agree on the digest of the dropped slots' confirmed history at
//! that cut, a donor backfills any survivor that fell behind, and a strict
//! majority of the agreed participants commits the removal. `p2p_session`
//! owns the message handling and the decision engine; this module owns the
//! state the decisions operate on and the pure transitions that do not need a
//! session.
//!
//! Every collection here is bounded by the roster or by the participant set
//! for one attempt. The bounded journals are deliberate: they keep a
//! retransmitted or replayed artifact recognizable without letting a peer grow
//! session memory, and each insertion site documents its bound. The
//! terminal-attempt epochs delegate their unbounded-safe replay guard to
//! [`TerminalEpochTable`](crate::sessions::terminal_epoch::TerminalEpochTable).
//!
//! Extracted from `p2p_session` in phase 4 of #576. The module is `pub(crate)`
//! and changes no public API, wire format, or behavior.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::network::messages::{
    DropAbortReason, DropBackfill, DropCommit, DropOperationId, DropPrepare, DropReport, DropTarget,
};
use crate::sessions::ready_transcripts::ReadyTranscripts;
use crate::sessions::terminal_epoch::TerminalEpochTable;
use crate::Frame;
use crate::PlayerHandle;

#[allow(dead_code)] // consumed incrementally by the D14 session state machine below
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) enum CoordinatedDropPhase {
    Inventory,
    Backfill,
    Ready,
    Committed,
}

/// Which donor path produced the currently locked backfill grid.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) enum BackfillGridSource {
    /// A start-of-attempt inventory report names a donor covering the range.
    Inventory,
    /// A participant announced its current retained range.
    Announced,
}

/// One in-flight D14 graceful-drop barrier.
///
/// All collections are bounded by `num_players`; backfill payloads retain their
/// separate wire/queue bounds. The target endpoint is not a participant, so an
/// explicit removal can complete after the departing process stops polling.
#[derive(Debug)]
pub(crate) struct CoordinatedDropAttempt<A> {
    pub(crate) operation: DropOperationId,
    pub(crate) target_addr: A,
    pub(crate) targets: Vec<DropTarget>,
    pub(crate) participants: Vec<u16>,
    /// Strict majority of `participants` required for the coordinator to pick a
    /// cut and for any node to adopt a commit. Fixed at operation start.
    pub(crate) quorum: usize,
    pub(crate) local_participant: u16,
    pub(crate) held_at: Frame,
    pub(crate) phase: CoordinatedDropPhase,
    pub(crate) reports: BTreeMap<u16, DropReport>,
    /// Locked digest plus provisional and counted Ready transcripts.
    ///
    /// The typestate in [`ReadyTranscripts`] keeps a pre-digest non-authority
    /// report provisional: it never counts until an authority or independently
    /// verified local history locks the digest (#529). Bounded by the
    /// participant set.
    pub(crate) ready: ReadyTranscripts,
    pub(crate) committed_acks: BTreeSet<u16>,
    pub(crate) cut: Option<Frame>,
    pub(crate) pending_commit: Option<DropCommit>,
    pub(crate) backfill_chunks: BTreeMap<u16, DropBackfill>,
    pub(crate) relayed_backfill: BTreeMap<u16, DropBackfill>,
    pub(crate) next_backfill_chunk: u16,
    pub(crate) expected_backfill_chunks: Option<u16>,
    /// Chunk-grid start agreed by the first accepted chunk. Every later chunk
    /// must share it so chunks from donors with different ranges can never be
    /// interleaved into one operation.
    pub(crate) expected_backfill_start: Option<Frame>,
    /// Which donor path owns the locked grid. An inventory donor takes
    /// precedence over a current-history announcement, so a late inventory
    /// report can reset the announced grid and install its canonical layout.
    pub(crate) backfill_grid_source: Option<BackfillGridSource>,
    /// Participant that produced every chunk of the locked grid. Once set, a
    /// chunk naming any other donor is discarded, so two donors that happen to
    /// share a layout cannot interleave chunks into one range.
    pub(crate) backfill_donor: Option<u16>,
    /// Participants that announced their CURRENT retained history can serve a
    /// backfill range after the start-of-attempt inventory was taken. Bounded
    /// by `num_players`.
    pub(crate) donor_announcements: BTreeMap<u16, DonorAnnouncement>,
    /// Acting coordinator after the deterministic coordinator has been silent
    /// for [`COORDINATED_DROP_FALLBACK_GRACE`]. `None` means the deterministic
    /// lowest participant still owns cut selection.
    pub(crate) acting_coordinator: Option<u16>,
    /// Most recent message from the deterministic coordinator for this
    /// operation. Kept on the attempt itself so the bounded cross-operation
    /// journal cannot evict the evidence and make an alive coordinator look
    /// silent.
    pub(crate) coordinator_heard_at: Option<web_time::Instant>,
    pub(crate) started_at: web_time::Instant,
    pub(crate) last_broadcast_at: web_time::Instant,
}

/// A non-coordinator prepare retained while the deterministic coordinator is
/// silent. After [`COORDINATED_DROP_FALLBACK_GRACE`] the lowest remaining
/// participant may admit it as acting coordinator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FallbackDropPrepare {
    pub(crate) prepare: DropPrepare,
    pub(crate) first_seen_at: web_time::Instant,
    /// Coordinator-heard evidence captured when the candidate was retained.
    /// A later coordinator message clears the candidate.
    pub(crate) coordinator_heard_at: Option<web_time::Instant>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) struct CoordinatedDropFence {
    pub(crate) operation: DropOperationId,
    pub(crate) target_generation: u16,
    pub(crate) cut: Frame,
}

/// A committed drop whose target endpoint may still be running.
///
/// The survivor disconnects the target endpoint locally as soon as the
/// certificate is applied, but a live process at that address can only learn
/// its own removal by receiving the commit. Drop-control datagrams are queued
/// once and are not reliable, so the certificate is retransmitted into the
/// endpoint's bounded shutdown window until the target acknowledges it, the
/// retry window elapses, or the endpoint finishes shutting down.
#[derive(Debug)]
pub(crate) struct PendingTargetCommit<A> {
    pub(crate) commit: DropCommit,
    pub(crate) addr: A,
    /// Connection id learned from the target before its endpoint was
    /// disconnected. Direct retransmissions carry it so the live target's
    /// endpoint accepts them, while a hot-join replacement at the same address
    /// (a different connection id) ignores them.
    pub(crate) conn_id: u32,
    pub(crate) deadline: web_time::Instant,
    pub(crate) acked: bool,
}

/// How long a committed certificate is retransmitted to a removed target.
///
/// Delivery stays best effort: the survivors stop after this window (or at
/// endpoint shutdown, whichever comes first) and never wait for an
/// acknowledgement to freeze their own history. A target that never
/// acknowledges is bounded by its own peer-disconnect timeout instead.
pub(crate) const COORDINATED_DROP_COMMIT_RETRY_WINDOW: web_time::Duration =
    web_time::Duration::from_secs(1);

/// How long a non-coordinator waits after the most recent deterministic
/// coordinator message before the lowest remaining survivor may act as
/// coordinator.
///
/// The operation deadline is two seconds, so this leaves one second for the
/// fallback prepare/report/cut/ready/commit exchange. A reachable coordinator's
/// prepare or report normally arrives within one RTT and refreshes the window;
/// the grace only releases a coordinator that has been silent for a full
/// second, whether it was never heard or disappeared after speaking. It never
/// bypasses quorum, and a later coordinator message still fails closed on a
/// conflicting cut.
pub(crate) const COORDINATED_DROP_FALLBACK_GRACE: web_time::Duration =
    web_time::Duration::from_secs(1);

/// One participant's announcement that it can currently serve a drop backfill.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) struct DonorAnnouncement {
    pub(crate) start_frame: Frame,
    pub(crate) chunk_count: u16,
    /// Digest of every target input at the operation's certified cut, computed
    /// from the donor's current retained history.
    pub(crate) cut_digest: u64,
}

/// Canonical chunk layout for one coordinated-drop backfill range.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) struct CoordinatedDropBackfillPlan {
    pub(crate) input_width: usize,
    pub(crate) frame_width: usize,
    pub(crate) frames_per_chunk: usize,
    pub(crate) frame_count: usize,
    pub(crate) chunk_count: u16,
}

/// A prepare this endpoint rejected as superseded by its active operation.
///
/// The rejection is retained so retransmitted reports for the losing operation
/// are answered with a fresh `Superseded` abort. Aborts are best-effort; without
/// this journal the original rejecter stops retransmitting as soon as the losing
/// sender observes its abort, and a participant that missed it can only time out
/// and fail closed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RejectedDropOperation {
    pub(crate) operation: DropOperationId,
    pub(crate) targets: Vec<DropTarget>,
}

/// A prepare held until the active committed certificate clears.
///
/// The original admission source is retained with the prepare so re-admission
/// after the deferred phase still validates the same authority. Recomputing the
/// source as the coordinator at dequeue time would let an intermediate
/// participant admit a prepare the coordinator never forwarded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeferredDropPrepare {
    pub(crate) prepare: DropPrepare,
    pub(crate) source: Option<u16>,
}

/// One unseen committed certificate awaiting corroboration from another
/// endpoint. A certificate carries no participant set or signature, so the
/// only evidence an uninvolved receiver can check is agreement from more than
/// one endpoint; a single peer must not be able to halt a live session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UnseenCommitEvidence {
    pub(crate) commit: DropCommit,
    pub(crate) sources: BTreeSet<u16>,
}

/// One exact terminal operation identity retained for a target handle.
///
/// Sequences are generation-local per target set and a lower sequence can
/// still be a live higher-priority attempt, so only an exact identity match is
/// treated as a replay. The coordinator generation participates so a rejoined
/// coordinator is not blocked by its predecessor's terminal history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TerminalTargetWatermark {
    pub(crate) target_set_digest: u64,
    pub(crate) participant_set_digest: u64,
    pub(crate) coordinator_generation: u16,
    pub(crate) generation: u16,
    pub(crate) sequence: u32,
    pub(crate) terminal_epoch: u32,
}

/// One authority-generation-scoped, monotone terminal-attempt epoch for a
/// canonical target handle set.
///
/// The epoch is an unbounded-safe replay guard: `next` is the only epoch the
/// authority will accept for this handle set and generation. Admission
/// consumes it and advances it, so an operation from an older epoch can never
/// reopen an attempt even after the bounded exact-identity window has evicted
/// it (issue #516).
///
/// Epochs are scoped to the operation's named coordinator identity. A new
/// coordinator generation, or a coordinator change after a removal, starts a
/// fresh epoch space; the older generation's artifacts are rejected by the
/// per-prepare coordinator-generation fence. Target-generation changes carry
/// `next` forward for the same handle set, so a reactivated slot cannot reuse
/// an old epoch. The state machine lives in [`TerminalEpochTable`](crate::sessions::terminal_epoch::TerminalEpochTable).
#[derive(Debug)]
pub(crate) struct CoordinatedDropState<A> {
    pub(crate) active: Option<CoordinatedDropAttempt<A>>,
    pub(crate) queued: std::collections::BTreeSet<PlayerHandle>,
    /// Queued handles whose request came from the automatic timeout path.
    /// Explicit `remove_player` requests in the same queue must not be gated
    /// by the automatic survivor-majority pre-check.
    pub(crate) queued_automatic: std::collections::BTreeSet<PlayerHandle>,
    pub(crate) deferred_prepares: VecDeque<DeferredDropPrepare>,
    /// At most one non-coordinator prepare waiting for the failover grace.
    pub(crate) fallback_prepare: Option<FallbackDropPrepare>,
    /// Most recent time each deterministic-coordinator operation was heard.
    /// A coordinator report may arrive before its prepare, and a coordinator
    /// that speaks once and then disappears must still release the fallback
    /// after a full silence window. Bounded by `num_players`.
    pub(crate) coordinator_heard_operations: VecDeque<(DropOperationId, web_time::Instant)>,
    pub(crate) committed: BTreeMap<PlayerHandle, CoordinatedDropFence>,
    /// Canonical connected-era generation retained after a dropped slot
    /// successfully rejoins. Unlike spectator epochs, this advances exactly
    /// once per committed drop and once per committed reactivation.
    pub(crate) membership_generations: BTreeMap<PlayerHandle, u16>,
    /// Slots certified dropped in the current era that have not reactivated.
    /// Bounded by `num_players`. A fresh hot-join snapshot imports this set so
    /// its membership epoch matches the existing survivors' (a locally
    /// observed disconnect status is not authoritative membership).
    pub(crate) certified_dropped: std::collections::BTreeSet<PlayerHandle>,
    pub(crate) closed: VecDeque<DropOperationId>,
    /// Exact terminal operation identities per target handle.
    ///
    /// A target's history survives operations for other targets. The exact
    /// identity includes the coordinator generation and sequence, so a rejoined
    /// coordinator and a concurrent lower sequence are not blocked. Bounded by
    /// two entries per player per handle. This is a secondary fast-path guard:
    /// the authority-scoped terminal-epoch map below is the unbounded-safe
    /// replay boundary (issue #516).
    pub(crate) terminal_targets: BTreeMap<u16, VecDeque<TerminalTargetWatermark>>,
    /// Authority-scoped monotone terminal-attempt epochs, keyed by the
    /// canonical target handle set plus the coordinator generation. At most two
    /// acceptable generations per remote endpoint, so the map is bounded by
    /// twice the roster (`alloc-bound` at insertion).
    pub(crate) terminal_epochs: TerminalEpochTable,
    /// Recently rejected superseded prepares, bounded to one per player.
    pub(crate) rejected: VecDeque<RejectedDropOperation>,
    /// Targets of an uncertified attempt that a failed-closed session abandoned.
    /// Their ordinary disconnect gossip stays shielded (no legacy
    /// `PeerDropped` without a certificate); bounded by `num_players`.
    pub(crate) halted_targets: std::collections::BTreeSet<PlayerHandle>,
    /// Certified removals still being delivered to their (possibly live) target
    /// endpoint. Bounded by `num_players`: only applied commits insert here and
    /// a committed target set contains at most one entry per player.
    pub(crate) retiring: BTreeMap<PlayerHandle, PendingTargetCommit<A>>,
    /// Unseen certificates seen from one endpoint and awaiting corroboration
    /// from another. Bounded by `num_players`.
    pub(crate) unseen_commits: VecDeque<UnseenCommitEvidence>,
    /// Highest cut already applied for one (coordinator, coordinator
    /// generation, target-set digest, participant-set digest) identity.
    /// Retained after the operation leaves the bounded closed journal so a
    /// delayed duplicate cannot be mistaken for a new removal certificate.
    /// Bounded by `num_players`.
    pub(crate) closed_commit_cuts: VecDeque<((u16, u16, u64, u64), Frame)>,
    /// Most recent applied certificates. A participant that missed the commit
    /// burst retries its Ready report after the active attempt is gone; a
    /// closed participant answers that retry with the stored certificate so
    /// quorum completion cannot strand the last witness. Bounded by
    /// `num_players`.
    pub(crate) closed_commits: VecDeque<DropCommit>,
}

impl<A> Default for CoordinatedDropState<A> {
    fn default() -> Self {
        Self {
            active: None,
            queued: std::collections::BTreeSet::new(),
            queued_automatic: std::collections::BTreeSet::new(),
            deferred_prepares: VecDeque::new(),
            fallback_prepare: None,
            coordinator_heard_operations: VecDeque::new(),
            committed: BTreeMap::new(),
            membership_generations: BTreeMap::new(),
            certified_dropped: std::collections::BTreeSet::new(),
            closed: VecDeque::new(),
            terminal_targets: BTreeMap::new(),
            terminal_epochs: TerminalEpochTable::default(),
            rejected: VecDeque::new(),
            halted_targets: std::collections::BTreeSet::new(),
            retiring: BTreeMap::new(),
            unseen_commits: VecDeque::new(),
            closed_commit_cuts: VecDeque::new(),
            closed_commits: VecDeque::new(),
        }
    }
}
impl<A> CoordinatedDropAttempt<A> {
    /// The participant that owns cut selection for this attempt.
    ///
    /// An adopted acting coordinator replaces the deterministic coordinator
    /// only after its failover grace; otherwise the lowest participant (the
    /// first entry in the canonical participant list) owns the cut.
    pub(crate) fn effective_coordinator(&self) -> Option<u16> {
        effective_coordinator(self.acting_coordinator, self.participants.first().copied())
    }
}

/// The deterministic acting coordinator after the coordinator's failover
/// grace: the lowest remaining participant.
///
/// `participants` is the canonical ascending list agreed for the operation, so
/// entry one is the first survivor after the coordinator. The fallback is
/// deliberately distinct from the deterministic coordinator: an alive
/// coordinator keeps priority until it has been silent for the whole grace.
pub(crate) fn fallback_coordinator(participants: &[u16]) -> Option<u16> {
    participants.get(1).copied()
}

/// Which participant owns cut selection, given the adopted acting coordinator
/// (if any) and the deterministic coordinator (if any).
///
/// The acting fallback wins because its adoption already required the
/// deterministic coordinator to be silent for the full grace. Keeping this a
/// pure two-option kernel lets the precedence be machine-checked.
pub(crate) const fn effective_coordinator(
    acting: Option<u16>,
    deterministic: Option<u16>,
) -> Option<u16> {
    match acting {
        Some(coordinator) => Some(coordinator),
        None => deterministic,
    }
}

/// Drops the buffered chunks and grid locks for an attempt so a new (or
/// lower-handle) donor's grid can be accepted.
///
/// Installed values remain and are still subject to the normal overlap
/// validation; only the uninstalled grid identity is cleared.
pub(crate) fn reset_backfill_grid<A>(active: &mut CoordinatedDropAttempt<A>) {
    active.backfill_chunks.clear();
    active.relayed_backfill.clear();
    active.next_backfill_chunk = 0;
    active.expected_backfill_chunks = None;
    active.expected_backfill_start = None;
    active.backfill_grid_source = None;
    active.backfill_donor = None;
}

/// Computes the canonical chunk layout for `[start, cut]` across a backfill
/// range of `target_count` fixed-width target inputs.
///
/// Shared by the donor announcement and the chunk sender so both sides agree
/// on the exact chunk count a chunk set must have. `input_width` is the
/// encoded width of one target input; the caller derives it from `Config`.
///
/// Backfill payloads are capped at 1 KiB per chunk. Every multiplication and
/// addition is checked, and a layout that cannot be represented by the
/// `u16` chunk index fails closed with [`DropAbortReason::ResourceLimit`].
pub(crate) fn backfill_plan(
    input_width: usize,
    target_count: usize,
    start: Frame,
    cut: Frame,
) -> Result<CoordinatedDropBackfillPlan, DropAbortReason> {
    let frame_width = input_width
        .checked_mul(target_count)
        .filter(|width| *width > 0)
        .ok_or(DropAbortReason::ResourceLimit)?;
    const BACKFILL_BYTES_PER_CHUNK: usize = 1_024;
    let frames_per_chunk = (BACKFILL_BYTES_PER_CHUNK / frame_width).max(1);
    let frame_count = usize::try_from(
        start
            .distance_to(cut)
            .ok_or(DropAbortReason::MissingHistory)?,
    )
    .ok()
    .and_then(|distance| distance.checked_add(1))
    .ok_or(DropAbortReason::ResourceLimit)?;
    let chunk_count_usize = frame_count
        .checked_add(frames_per_chunk.saturating_sub(1))
        .map(|value| value / frames_per_chunk)
        .ok_or(DropAbortReason::ResourceLimit)?;
    let chunk_count =
        u16::try_from(chunk_count_usize).map_err(|_error| DropAbortReason::ResourceLimit)?;
    Ok(CoordinatedDropBackfillPlan {
        input_width,
        frame_width,
        frames_per_chunk,
        frame_count,
        chunk_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_coordinator_is_the_first_survivor_after_the_coordinator() {
        assert_eq!(fallback_coordinator(&[0, 1, 2]), Some(1));
        assert_eq!(fallback_coordinator(&[3, 7]), Some(7));
        assert_eq!(fallback_coordinator(&[3]), None);
        assert_eq!(fallback_coordinator(&[]), None);
    }

    #[test]
    fn effective_coordinator_prefers_the_acting_authority() {
        assert_eq!(effective_coordinator(Some(2), Some(0)), Some(2));
        assert_eq!(effective_coordinator(None, Some(0)), Some(0));
        assert_eq!(effective_coordinator(Some(2), None), Some(2));
        assert_eq!(effective_coordinator(None, None), None);
    }

    #[test]
    fn backfill_plan_uses_one_kib_chunks_and_counts_the_inclusive_range() {
        let plan = backfill_plan(4, 1, Frame::new(0), Frame::new(9))
            .expect("a short range fits the chunk bound");
        assert_eq!(plan.input_width, 4);
        assert_eq!(plan.frame_width, 4);
        assert_eq!(plan.frames_per_chunk, 256);
        assert_eq!(plan.frame_count, 10);
        assert_eq!(plan.chunk_count, 1);
    }

    #[test]
    fn backfill_plan_splits_a_wide_frame_into_single_frame_chunks() {
        let plan = backfill_plan(1_024, 1, Frame::new(0), Frame::new(9))
            .expect("a wide input still fits the chunk index");
        assert_eq!(plan.frames_per_chunk, 1);
        assert_eq!(plan.frame_count, 10);
        assert_eq!(plan.chunk_count, 10);
    }

    #[test]
    fn backfill_plan_rejects_a_zero_width_frame() {
        assert_eq!(
            backfill_plan(0, 1, Frame::new(0), Frame::new(0)),
            Err(DropAbortReason::ResourceLimit)
        );
        assert_eq!(
            backfill_plan(4, 0, Frame::new(0), Frame::new(0)),
            Err(DropAbortReason::ResourceLimit)
        );
    }

    fn attempt_with_buffered_grid() -> CoordinatedDropAttempt<()> {
        let operation = DropOperationId {
            coordinator: 0,
            coordinator_generation: 0,
            sequence: 1,
            target_set_digest: 0,
            participant_set_digest: 0,
            terminal_epoch: 0,
        };
        let chunk = DropBackfill {
            operation,
            donor: 1,
            range_start: Frame::new(0),
            chunk_index: 1,
            chunk_count: 2,
            start_frame: Frame::new(128),
            frame_count: 1,
            bytes: vec![0],
        };
        let now = web_time::Instant::now();
        CoordinatedDropAttempt {
            operation,
            target_addr: (),
            targets: Vec::new(),
            participants: vec![0, 1, 2],
            quorum: 2,
            local_participant: 0,
            held_at: Frame::new(127),
            phase: CoordinatedDropPhase::Backfill,
            reports: BTreeMap::new(),
            ready: ReadyTranscripts::default(),
            committed_acks: BTreeSet::new(),
            cut: Some(Frame::new(127)),
            pending_commit: None,
            backfill_chunks: BTreeMap::from([(1, chunk.clone())]),
            relayed_backfill: BTreeMap::from([(1, chunk)]),
            next_backfill_chunk: 2,
            expected_backfill_chunks: Some(2),
            expected_backfill_start: Some(Frame::new(0)),
            backfill_grid_source: Some(BackfillGridSource::Announced),
            backfill_donor: Some(1),
            donor_announcements: BTreeMap::new(),
            acting_coordinator: Some(2),
            coordinator_heard_at: None,
            started_at: now,
            last_broadcast_at: now,
        }
    }

    #[test]
    fn reset_backfill_grid_clears_only_the_uninstalled_grid_identity() {
        let mut attempt = attempt_with_buffered_grid();
        reset_backfill_grid(&mut attempt);

        assert!(attempt.backfill_chunks.is_empty());
        assert!(attempt.relayed_backfill.is_empty());
        assert_eq!(attempt.next_backfill_chunk, 0);
        assert_eq!(attempt.expected_backfill_chunks, None);
        assert_eq!(attempt.expected_backfill_start, None);
        assert_eq!(attempt.backfill_grid_source, None);
        assert_eq!(attempt.backfill_donor, None);
        assert_eq!(attempt.operation.sequence, 1);
        assert_eq!(attempt.cut, Some(Frame::new(127)));
        assert_eq!(attempt.participants, vec![0, 1, 2]);
        assert_eq!(attempt.acting_coordinator, Some(2));
    }

    #[test]
    fn backfill_plan_rejects_a_range_that_ends_before_it_starts() {
        assert_eq!(
            backfill_plan(4, 1, Frame::new(9), Frame::new(0)),
            Err(DropAbortReason::ResourceLimit)
        );
    }
}

#[cfg(kani)]
#[cfg_attr(any(), mutants::skip)]
mod kani_proofs {
    use super::*;

    /// The failover authority is never the deterministic coordinator: with at
    /// least two participants the fallback is exactly the second entry, and a
    /// lone participant has no fallback.
    ///
    /// The participant list is canonical and duplicate-free (each roster slot
    /// appears once), so the two symbolic participants are assumed distinct.
    /// That is the premise under which "never the coordinator" is meaningful.
    #[kani::proof]
    fn proof_coordinated_drop_fallback_is_not_the_coordinator() {
        let coordinator: u16 = kani::any();
        let fallback: u16 = kani::any();
        kani::assume(coordinator != fallback);

        assert_eq!(
            fallback_coordinator(&[coordinator, fallback]),
            Some(fallback)
        );
        assert_ne!(
            fallback_coordinator(&[coordinator, fallback]),
            Some(coordinator)
        );
        assert_eq!(fallback_coordinator(&[coordinator]), None);
    }

    /// An adopted acting coordinator always wins over the deterministic one;
    /// without an adoption the deterministic coordinator is unchanged.
    #[kani::proof]
    fn proof_coordinated_drop_effective_coordinator_precedence() {
        let acting: Option<u16> = kani::any();
        let deterministic: Option<u16> = kani::any();

        let effective = effective_coordinator(acting, deterministic);
        match acting {
            Some(coordinator) => assert_eq!(effective, Some(coordinator)),
            None => assert_eq!(effective, deterministic),
        }
    }

    /// Every frame in `[start, cut]` is covered by the planned chunk grid, the
    /// chunk index fits the wire `u16`, and the frame width is exactly
    /// `input_width * target_count`. These are the bounded-allocation
    /// obligations of the donor and sender.
    #[kani::proof]
    fn proof_coordinated_drop_backfill_plan_covers_every_frame() {
        let input_width: usize = kani::any();
        let target_count: usize = kani::any();
        let start: i32 = kani::any();
        let cut: i32 = kani::any();
        kani::assume((1..=64).contains(&input_width));
        kani::assume((1..=8).contains(&target_count));
        kani::assume((0..=4096).contains(&start));
        kani::assume((start..=4096).contains(&cut));

        let plan = backfill_plan(
            input_width,
            target_count,
            Frame::new(start),
            Frame::new(cut),
        )
        .expect("bounded inputs fit the plan");
        assert!(plan.frames_per_chunk > 0);
        assert!(plan.chunk_count > 0);
        assert_eq!(plan.frame_width, input_width * target_count);
        assert_eq!(
            plan.frame_count,
            usize::try_from(cut - start).expect("non-negative") + 1
        );
        let covered = u64::from(plan.chunk_count)
            * u64::try_from(plan.frames_per_chunk).expect("frames per chunk fits u64");
        assert!(
            covered >= u64::try_from(plan.frame_count).expect("frame count fits"),
            "the chunk grid covers every frame in the inclusive range"
        );
    }
}

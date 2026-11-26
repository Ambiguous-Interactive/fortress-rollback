//! Converged checksum-basis token tracker.
//!
//! A dropped slot's confirmed history converges to one freeze boundary: the
//! first frame whose confirmed input repeats the slot's frozen value. Survivors
//! that reach the same frozen history through different intermediate detection
//! floors must derive the same basis token, or their checksum reports stay
//! incomparable forever (the #562 false negative). The tracker keys one term per
//! slot and replaces that term when the boundary converges lower, so the token
//! is a pure function of the converged per-slot boundaries.
//!
//! The tracker also stores the per-frame token attached to local checksum
//! history entries and the adopted hot-join fold base/floor. The surrounding
//! session owns the remote report queues and the comparison gate.

use std::collections::BTreeMap;
use std::hash::Hasher;

#[cfg(any(feature = "hot-join", kani))]
use crate::network::messages::ChecksumBasis;
#[cfg(feature = "hot-join")]
use crate::network::messages::MAX_CHECKSUM_BASIS_EVENTS;
use crate::{Frame, PlayerHandle};

/// Hard bound on frozen slots representable in a hot-join snapshot basis.
///
/// A session with more simultaneously frozen slots refuses the serve rather
/// than fold per-slot terms into an identity a joiner could not update.
#[cfg(feature = "hot-join")]
pub(crate) const MAX_CHECKSUM_FREEZE_SLOTS: usize = MAX_CHECKSUM_BASIS_EVENTS;

/// Domain-separated additive term for one slot's converged freeze boundary.
///
/// A dropped slot contributes exactly one term, keyed by its handle and by the
/// first frame whose confirmed input repeats the slot's frozen value. The basis
/// token sums the terms of every slot whose boundary is at or below the frame,
/// so survivors that reach the same frozen history through different
/// intermediate detections derive the same token, while a later lower boundary
/// for any slot still changes every frame it rewrites.
pub(crate) fn checksum_freeze_floor_term(floor: Frame, handle: PlayerHandle) -> u64 {
    // Handles are bounded to the u16 player domain on the wire; u32 keeps the
    // term width-independent even if a local handle ever exceeds that domain.
    let handle = u32::try_from(handle.as_usize()).unwrap_or(u32::MAX);
    let mut hasher = crate::hash::DeterministicHasher::new();
    hasher.write(b"fortress.checksum.freeze_floor.v2");
    hasher.write(&floor.as_i32().to_le_bytes());
    hasher.write(&handle.to_le_bytes());
    hasher.finish()
}

/// Decision for one dropped slot's reported freeze boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FreezeAction {
    /// The boundary is invalid or would not move the slot's term down.
    Ignore,
    /// An adopted fold: add the term to the base and retain no per-slot entry.
    Fold,
    /// Retain this lower boundary as the slot's single term.
    Insert(Frame),
}

/// Pure transition rule for a slot's converged freeze boundary.
///
/// Boundaries only move down. An invalid boundary never orders a confirmed
/// frame; an equal or higher re-detection is idempotent; a boundary at or below
/// an adopted fold floor joins the fold base instead of the per-slot map.
pub(crate) fn freeze_action(
    existing: Option<Frame>,
    floor: Frame,
    fold_floor: Frame,
) -> FreezeAction {
    if !floor.is_valid() {
        return FreezeAction::Ignore;
    }
    if existing.is_some_and(|current| current <= floor) {
        return FreezeAction::Ignore;
    }
    if !fold_floor.is_null() && floor <= fold_floor {
        return FreezeAction::Fold;
    }
    FreezeAction::Insert(floor)
}

/// Additive token of every term at or below `frame`, plus the adopted base.
///
/// The fold is order-independent and wrapping, so the BTreeMap iteration order
/// does not affect the token. `None` means the frame predates the adopted fold
/// floor and the basis cannot be reconstructed.
fn fold_token<I>(base: u64, fold_floor: Frame, terms: I, frame: Frame) -> Option<u64>
where
    I: IntoIterator<Item = (PlayerHandle, Frame)>,
{
    if !fold_floor.is_null() && frame < fold_floor {
        return None;
    }
    let mut token = base;
    for (handle, floor) in terms {
        if floor <= frame {
            token = token.wrapping_add(checksum_freeze_floor_term(floor, handle));
        }
    }
    Some(token)
}

/// Basis state shared by the session's checksum send/compare paths.
#[derive(Debug)]
pub(crate) struct ChecksumBasisTracker {
    /// Basis token for each local checksum history entry. Missing entries
    /// default to `0` for compatibility with direct test fixtures.
    pub(crate) history_tokens: BTreeMap<Frame, Option<u64>>,
    /// Converged freeze boundary per dropped slot (`last_frame + 1`).
    pub(crate) freeze_floors: BTreeMap<PlayerHandle, Frame>,
    /// Adopted fold token (conforming hosts always send `0`).
    pub(crate) base: u64,
    /// Adopted fold floor (conforming hosts always send [`Frame::NULL`]).
    pub(crate) fold_floor: Frame,
    /// Highest reactivation frame whose freeze term was released.
    pub(crate) release_floor: Frame,
}

impl Default for ChecksumBasisTracker {
    fn default() -> Self {
        // `Frame::default()` is frame 0, not the null sentinel. The adopted
        // fold and release floors must start null, as the pre-extraction
        // session fields did; otherwise floor 0 looks adopted.
        Self {
            history_tokens: BTreeMap::new(),
            freeze_floors: BTreeMap::new(),
            base: 0,
            fold_floor: Frame::NULL,
            release_floor: Frame::NULL,
        }
    }
}

impl ChecksumBasisTracker {
    /// Drops retained per-frame tokens at or above `first_invalid`.
    ///
    /// A mismatch or pending report below the floor keeps its basis in retained
    /// history, so a genuine divergence is never masked. Reports at or above the
    /// floor describe the pre-rewrite trajectory and cannot be compared with the
    /// recomputed local checksum.
    pub(crate) fn invalidate_from(&mut self, first_invalid: Frame) {
        self.history_tokens
            .retain(|&frame, _token| frame < first_invalid);
    }

    /// Records one dropped slot's converged freeze boundary.
    ///
    /// Boundaries only move **down** for a slot. A later detection at a higher
    /// frame is idempotent because the slot is already frozen at or below that
    /// frame; retaining it as an additional term would leave two survivors that
    /// reached the same frozen history permanently incomparable, which is the
    /// #562 false negative. The slot's single term is replaced, so the basis is
    /// a pure function of the converged per-slot boundaries.
    pub(crate) fn record_freeze(&mut self, player_handle: PlayerHandle, floor: Frame) {
        let existing = self.freeze_floors.get(&player_handle).copied();
        match freeze_action(existing, floor, self.fold_floor) {
            FreezeAction::Ignore => {},
            FreezeAction::Fold => {
                // Only an adopted, non-conforming fold reaches this branch: the
                // event list must stay strictly above the fold floor. Remove the
                // superseded explicit boundary before folding the new term, or
                // the token would count both terms.
                self.freeze_floors.remove(&player_handle);
                self.base = self
                    .base
                    .wrapping_add(checksum_freeze_floor_term(floor, player_handle));
            },
            FreezeAction::Insert(boundary) => {
                self.freeze_floors.insert(player_handle, boundary);
            },
        }
    }

    /// Removes a reactivated slot's freeze boundary.
    ///
    /// Its real inputs from the activation frame onward describe a new history
    /// generation. Checksums for frames below the activation frame are
    /// suppressed afterwards by [`Self::release_floor`], so their retained
    /// tokens do not change.
    #[cfg(feature = "hot-join")]
    pub(crate) fn release(&mut self, player_handle: PlayerHandle, activation_frame: Frame) {
        if self.freeze_floors.remove(&player_handle).is_some() {
            self.release_floor = std::cmp::max(self.release_floor, activation_frame);
        }
    }

    /// Basis token stored for a local checksum history entry.
    ///
    /// Entries written before any rewrite carry `0`; direct test fixtures that
    /// insert only a checksum get the same default.
    pub(crate) fn history_token_for(&self, frame: Frame) -> Option<u64> {
        self.history_tokens.get(&frame).copied().unwrap_or(Some(0))
    }

    /// Additive token of every slot freeze boundary at or below `frame`, plus
    /// the adopted hot-join base when the frame is in its range.
    ///
    /// A slot contributes exactly one term (its converged boundary), so the
    /// same frozen history always produces the same token. A later lower
    /// boundary replaces the term and therefore invalidates comparisons for
    /// frames at or above that floor, while retained entries below it keep
    /// their previous token. `0` means no frozen history affects the frame.
    pub(crate) fn token_at(&self, frame: Frame) -> Option<u64> {
        fold_token(
            self.base,
            self.fold_floor,
            self.freeze_floors
                .iter()
                .map(|(&handle, &floor)| (handle, floor)),
            frame,
        )
    }

    /// Whether every frozen slot boundary fits the bounded snapshot basis.
    ///
    /// Conforming sessions with more simultaneously frozen slots than the wire
    /// event cap refuse the hot-join serve instead of folding identities into a
    /// token a joiner could never update (review finding on #562).
    #[cfg(feature = "hot-join")]
    pub(crate) fn is_representable(&self) -> bool {
        self.freeze_floors.len() <= MAX_CHECKSUM_FREEZE_SLOTS
    }

    /// Full bounded basis carried by a hot-join snapshot.
    #[cfg(feature = "hot-join")]
    pub(crate) fn snapshot(&self) -> ChecksumBasis {
        // alloc-bound: the per-slot freeze map is capped at
        // `MAX_CHECKSUM_FREEZE_SLOTS`.
        let mut events: Vec<(Frame, u32)> = self
            .freeze_floors
            .iter()
            .map(|(&handle, &floor)| {
                let slot = u32::try_from(handle.as_usize()).unwrap_or(u32::MAX);
                (floor, slot)
            })
            .collect();
        // Canonical wire order: ascending by (floor, slot).
        events.sort_unstable();
        ChecksumBasis {
            base: self.base,
            floor: self.fold_floor,
            events,
        }
    }

    /// Adopts a validated snapshot basis as this session's per-slot freeze map.
    ///
    /// The joining slot's own boundary is released separately: the joiner is
    /// live from the activation frame, so that entry describes only the frozen
    /// pre-activation history (stored per-frame tokens already reflect it).
    ///
    /// Folded slot identities are not carried on the wire. Terms already in the
    /// adopted `base` are therefore unknown to this session: a post-snapshot
    /// lowering or reactivation of such a slot cannot subtract the inherited
    /// term, so its token differs from pre-existing survivors at and above the
    /// fold floor and those reports stay incomparable (skipped comparisons,
    /// never a false mismatch). Terms this session folds or releases after the
    /// adoption are tracked normally. Only reachable when the host had more
    /// simultaneously frozen slots than the wire event cap before the snapshot.
    #[cfg(any(feature = "hot-join", kani))]
    pub(crate) fn adopt(&mut self, basis: &ChecksumBasis) {
        self.base = basis.base;
        self.fold_floor = basis.floor;
        // alloc-bound: `is_valid` caps `events` at MAX_CHECKSUM_BASIS_EVENTS and
        // the adoption gate validates every slot against the player count.
        self.freeze_floors = basis
            .events
            .iter()
            .filter_map(|&(floor, slot)| {
                usize::try_from(slot)
                    .ok()
                    .map(|slot| (PlayerHandle::new(slot), floor))
            })
            .collect();
    }
}

#[cfg(kani)]
#[cfg_attr(any(), mutants::skip)]
mod kani_proofs {
    use super::*;

    /// The same converged history yields one token. A survivor that froze a
    /// slot high and then converged lower ends with the same single term as a
    /// survivor that recorded the lower boundary directly; the fold is
    /// order-independent, so map iteration order cannot change the token.
    #[kani::proof]
    #[kani::unwind(64)]
    fn proof_checksum_basis_same_converged_history_same_token() {
        let low: i32 = kani::any();
        let high: i32 = kani::any();
        let frame: i32 = kani::any();
        kani::assume((0..=3).contains(&low));
        kani::assume(low < high && high <= 4);
        kani::assume(high <= frame && frame <= 4);

        assert_eq!(
            freeze_action(Some(Frame::new(high)), Frame::new(low), Frame::NULL),
            FreezeAction::Insert(Frame::new(low))
        );
        assert_eq!(
            freeze_action(Some(Frame::new(low)), Frame::new(low), Frame::NULL),
            FreezeAction::Ignore
        );

        let late = [
            (PlayerHandle::new(1), Frame::new(low)),
            (PlayerHandle::new(2), Frame::new(low)),
        ];
        let direct = [
            (PlayerHandle::new(2), Frame::new(low)),
            (PlayerHandle::new(1), Frame::new(low)),
        ];
        assert_eq!(
            fold_token(0, Frame::NULL, late, Frame::new(frame)),
            fold_token(0, Frame::NULL, direct, Frame::new(frame))
        );
    }

    /// A lower boundary replaces the slot's term instead of accumulating it.
    #[kani::proof]
    #[kani::unwind(64)]
    fn proof_checksum_basis_lower_boundary_replaces_term() {
        let low: i32 = kani::any();
        let high: i32 = kani::any();
        let frame: i32 = kani::any();
        kani::assume((0..=3).contains(&low));
        kani::assume(low < high && high <= 4);
        kani::assume(high <= frame && frame <= 4);

        assert_eq!(
            freeze_action(Some(Frame::new(high)), Frame::new(low), Frame::NULL),
            FreezeAction::Insert(Frame::new(low))
        );
        let handle = PlayerHandle::new(1);
        let low_token = fold_token(
            0,
            Frame::NULL,
            [(handle, Frame::new(low))],
            Frame::new(frame),
        );
        let high_token = fold_token(
            0,
            Frame::NULL,
            [(handle, Frame::new(high))],
            Frame::new(frame),
        );
        assert_ne!(low_token, high_token);
    }

    /// An equal or higher re-detection is idempotent: the slot's term stays.
    #[kani::proof]
    #[kani::unwind(4)]
    fn proof_checksum_basis_higher_or_equal_redetection_idempotent() {
        let low: i32 = kani::any();
        let high: i32 = kani::any();
        kani::assume((0..=3).contains(&low));
        kani::assume(low <= high && high <= 4);

        assert_eq!(
            freeze_action(Some(Frame::new(low)), Frame::new(high), Frame::NULL),
            FreezeAction::Ignore
        );
        assert_eq!(
            freeze_action(Some(Frame::new(low)), Frame::new(low), Frame::NULL),
            FreezeAction::Ignore
        );
    }

    /// A boundary above the frame does not contribute to that frame's token.
    #[kani::proof]
    #[kani::unwind(64)]
    fn proof_checksum_basis_token_unchanged_below_boundary() {
        let floor: i32 = kani::any();
        let frame: i32 = kani::any();
        kani::assume((1..=4).contains(&floor));
        kani::assume((0..floor).contains(&frame));

        let handle = PlayerHandle::new(1);
        assert_eq!(
            fold_token(
                0,
                Frame::NULL,
                [(handle, Frame::new(floor))],
                Frame::new(frame)
            ),
            Some(0)
        );
        assert_eq!(fold_token(0, Frame::NULL, [], Frame::new(frame)), Some(0));
    }

    /// Adopting a snapshot basis preserves retained per-frame tokens and the
    /// adopted base above the snapshot frame.
    ///
    /// The nonempty-event copy is covered by the Rust test
    /// `adopting_a_snapshot_basis_preserves_tokens_above_the_snapshot_frame`;
    /// the Kani budget does not support the BTreeMap collect for symbolic event
    /// lists, so this harness uses the empty map and checks the retained token
    /// and base paths.
    #[kani::proof]
    #[kani::unwind(4)]
    fn proof_checksum_basis_adopt_preserves_tokens_above_snapshot() {
        let base: u64 = kani::any();
        let fold: i32 = kani::any();
        kani::assume((0..=2).contains(&fold));

        let mut tracker = ChecksumBasisTracker::default();
        tracker.history_tokens.insert(Frame::new(3), Some(7));
        tracker.adopt(&ChecksumBasis {
            base,
            floor: Frame::new(fold),
            events: Vec::new(),
        });

        assert_eq!(tracker.history_token_for(Frame::new(3)), Some(7));
        assert_eq!(tracker.token_at(Frame::new(4)), Some(base));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lowering a slot below an adopted fold floor folds the new term and must
    /// remove the superseded explicit boundary; otherwise the token counts both
    /// terms (review finding on the extraction).
    #[test]
    fn folding_a_lowered_boundary_removes_the_explicit_slot() {
        let handle = PlayerHandle::new(1);
        let mut tracker = ChecksumBasisTracker {
            fold_floor: Frame::new(4),
            ..ChecksumBasisTracker::default()
        };
        tracker.freeze_floors.insert(handle, Frame::new(6));

        tracker.record_freeze(handle, Frame::new(3));

        assert!(
            !tracker.freeze_floors.contains_key(&handle),
            "the superseded explicit boundary must be removed"
        );
        assert_eq!(
            tracker.token_at(Frame::new(6)),
            Some(checksum_freeze_floor_term(Frame::new(3), handle)),
            "the token must count only the folded term"
        );
    }

    /// The pre-#563 token was an additive multiset of every applied rewrite
    /// floor. Two survivors that converged to the same single boundary kept
    /// different tokens forever (the #562 false negative); the converged fold
    /// must differ from that legacy multiset.
    #[test]
    fn old_additive_floor_multiset_diverges_from_converged_token() {
        let handle = PlayerHandle::new(1);
        let low = Frame::new(5);
        let high = Frame::new(9);
        let converged = fold_token(0, Frame::NULL, [(handle, low)], Frame::new(10))
            .expect("a conforming frame has a token");
        let legacy = checksum_freeze_floor_term(high, handle)
            .wrapping_add(checksum_freeze_floor_term(low, handle));
        assert_ne!(
            converged, legacy,
            "the legacy floor multiset must not equal the converged single-term token"
        );
    }
}

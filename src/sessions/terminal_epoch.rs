//! Authority-scoped terminal-attempt epoch table for coordinated drops.
//!
//! Protocol v5 carries a monotone terminal epoch in every coordinated-drop
//! operation identity. The authority admits only the epoch it expects next for
//! one canonical target handle set; a participant follows the authority and
//! discards an epoch below its own next value as a terminal replay. Admission
//! consumes the epoch, so a delayed artifact from an older attempt can never
//! reopen a terminal operation even after the bounded exact-identity window has
//! evicted it (issue #516).
//!
//! Epoch spaces are keyed by the canonical target handle set **and** the
//! coordinator generation. A participant can legitimately hold the current era
//! and the next era during a rejoin window; sharing one entry would let the
//! one-ahead era swallow the current era's guard (issue #525). Target-generation
//! changes stay in the same space because the handle set is the identity: a
//! reactivated slot must not reuse an old epoch.
//!
//! The table is bounded: at most two coordinator generations per target handle
//! set and at most twice the roster overall. Pruning runs only when a new space
//! is inserted; a live epoch is never evicted to make room, and a full table
//! refuses the operation instead of reusing an epoch.

use crate::network::messages::DropTarget;
use std::collections::BTreeMap;

/// Inclusive upper bound on the first epoch a fresh acting fallback adopts.
///
/// A fallback that hot-joined after the original coordinator's operations has
/// no local epoch state for that generation. The retained candidate is its only
/// evidence, so a bounded first epoch is adopted rather than retrying forever.
/// A value above this bound is a hostile future proposal and stays discarded.
pub(crate) const MAX_ADOPTED_EPOCH: u32 = 1_000_000;

/// Advances one epoch space's next acceptable epoch after an admitted
/// operation. The proposed value is the consumed epoch plus one.
pub(crate) fn advance_next(current: u32, proposed: u32) -> u32 {
    std::cmp::max(current, proposed)
}

/// Whether an existing coordinator generation stays acceptable when the local
/// view is `local_generation`.
///
/// The coordinator may be one generation ahead (it observed its own rejoin
/// first), so exactly the local and local+1 eras are current.
pub(crate) const fn epoch_generation_is_current(
    existing_generation: u16,
    local_generation: u16,
) -> bool {
    existing_generation == local_generation
        || existing_generation == local_generation.wrapping_add(1)
}

/// Whether a stored epoch space survives inserting a new space for the same
/// canonical target set.
///
/// A coordinator change starts a fresh space; only its own current and
/// one-ahead generations remain. This keeps at most two generations per target
/// set in the bounded table.
pub(crate) const fn epoch_space_is_retained(
    existing_coordinator: u16,
    existing_generation: u16,
    inserted_coordinator: u16,
    local_generation: u16,
) -> bool {
    existing_coordinator == inserted_coordinator
        && epoch_generation_is_current(existing_generation, local_generation)
}

/// Sorts `handles[..len]` ascending and removes duplicates in place, returning
/// the canonical length. Entries beyond the returned length are unspecified.
///
/// Target sets are bounded by the roster, so the O(len^2) insertion sort is
/// cheaper than allocating and sorting a second buffer. Only the safe subset of
/// slice operations is used, so the same function is proofable without the
/// heap.
pub(crate) fn canonicalize_handles(handles: &mut [u16], len: usize) -> usize {
    let len = len.min(handles.len());
    // Insertion sort: the first `sorted` entries are already ascending.
    for sorted in 0..len {
        let mut index = sorted;
        while index > 0 {
            let previous = handles.get(index - 1).copied();
            let current = handles.get(index).copied();
            let (Some(previous), Some(current)) = (previous, current) else {
                break;
            };
            if previous <= current {
                break;
            }
            if let Some(slot) = handles.get_mut(index - 1) {
                *slot = current;
            }
            if let Some(slot) = handles.get_mut(index) {
                *slot = previous;
            }
            index -= 1;
        }
    }
    // Compact equal neighbours: the first `write` entries stay canonical.
    if len == 0 {
        return 0;
    }
    let mut write = 1;
    for read in 1..len {
        let current = handles.get(read).copied();
        let last = handles.get(write - 1).copied();
        if let (Some(current), Some(last)) = (current, last) {
            if current != last {
                if let Some(slot) = handles.get_mut(write) {
                    *slot = current;
                }
                write += 1;
            }
        }
    }
    write
}

/// Canonical identity of one target handle set.
///
/// Handles are sorted and deduplicated, so payloads that name the same slots in
/// a different order share one epoch space. Target generations are excluded
/// deliberately: a generation change carries `next` forward for the same
/// handle set, so a reactivated slot cannot reuse an old epoch.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct CanonicalTargetSet {
    handles: Vec<u16>,
}

impl CanonicalTargetSet {
    /// Canonicalizes the handles named by one target list.
    pub(crate) fn from_targets(targets: &[DropTarget]) -> Self {
        Self::from_handles(targets.iter().map(|target| target.handle))
    }

    /// Canonicalizes an arbitrary handle order into one sorted, unique set.
    pub(crate) fn from_handles(handles: impl IntoIterator<Item = u16>) -> Self {
        // alloc-bound: one entry per target handle; a target set is validated
        // against the roster before it reaches the epoch table.
        let mut handles: Vec<u16> = handles.into_iter().collect();
        let len = handles.len();
        let canonical_len = canonicalize_handles(&mut handles, len);
        handles.truncate(canonical_len);
        Self { handles }
    }

    /// The canonical handles in ascending order.
    #[cfg(test)]
    fn as_slice(&self) -> &[u16] {
        &self.handles
    }
}

/// Identity of one authority-scoped terminal-epoch space.
///
/// The coordinator generation is part of the space: the current era and the
/// next era can coexist during a rejoin window, and neither may swallow the
/// other. The key ordering is structural, so iteration stays deterministic.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct TerminalEpochKey {
    handles: CanonicalTargetSet,
    coordinator: u16,
    coordinator_generation: u16,
}

impl TerminalEpochKey {
    fn from_targets(coordinator: u16, coordinator_generation: u16, targets: &[DropTarget]) -> Self {
        Self {
            handles: CanonicalTargetSet::from_targets(targets),
            coordinator,
            coordinator_generation,
        }
    }

    #[cfg(test)]
    fn handles(&self) -> &[u16] {
        self.handles.as_slice()
    }
}

/// One authority-generation-scoped, monotone terminal-attempt epoch.
#[derive(Clone, Debug)]
pub(crate) struct TerminalEpochEntry {
    /// Canonical target handles and the generations `next` applies to.
    targets: Vec<DropTarget>,
    /// The next acceptable terminal epoch. Never decreases for one space.
    next: u32,
}

/// The values one admitted operation contributes to the epoch table.
#[derive(Clone, Debug)]
pub(crate) struct TerminalEpochRecord {
    /// Smallest player handle owned by the coordinating endpoint.
    pub(crate) coordinator: u16,
    /// Connected-era generation of the coordinator when the attempt opened.
    pub(crate) coordinator_generation: u16,
    /// Canonical target handles belonging to the departing endpoint.
    pub(crate) targets: Vec<DropTarget>,
    /// The epoch consumed by this operation plus one.
    pub(crate) next: u32,
    /// This endpoint's current generation for the coordinating slot.
    pub(crate) local_generation: u16,
    /// The roster-derived bound on live epoch spaces.
    pub(crate) capacity: usize,
}

/// The bounded table could not grow without evicting a live epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TerminalEpochTableFull;

/// Decision for one prepare at the terminal-epoch gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EpochAdmission {
    /// The authority's exact next epoch, or a participant's at-or-above epoch.
    Admit,
    /// A fresh acting fallback adopts the retained candidate's first epoch.
    Adopt,
    /// A stale or future artifact: discard it, or answer it with `Superseded`.
    Reject,
}

/// Pure admission rule for one prepare at the terminal-epoch gate.
///
/// The authority requires exact equality. A fresh acting fallback may adopt a
/// bounded first epoch only while it has no local state for the exact space, so
/// it cannot walk an established epoch backwards or forward. A participant
/// follows the authority: an epoch below its own next value is a terminal
/// replay, while an at-or-above epoch may be admitted (the participant's state
/// can legitimately lag the authority).
pub(crate) fn epoch_admission(
    local_is_authority: bool,
    requested: u32,
    authority_next: u32,
    has_local_state: bool,
    acting_fallback: bool,
) -> EpochAdmission {
    if !local_is_authority {
        return if requested < authority_next {
            EpochAdmission::Reject
        } else {
            EpochAdmission::Admit
        };
    }
    if requested == authority_next {
        return EpochAdmission::Admit;
    }
    if acting_fallback && !has_local_state && requested <= MAX_ADOPTED_EPOCH {
        EpochAdmission::Adopt
    } else {
        EpochAdmission::Reject
    }
}

/// Authority-scoped monotone terminal-attempt epochs for coordinated drops.
///
/// The map is bounded by the roster: one authority has at most two acceptable
/// coordinator generations per target handle set, and a target handle set is
/// the fixed handle set of one remote endpoint.
#[derive(Debug, Default)]
pub(crate) struct TerminalEpochTable {
    entries: BTreeMap<TerminalEpochKey, TerminalEpochEntry>,
}

impl TerminalEpochTable {
    /// The next acceptable epoch for one authority generation and target set.
    ///
    /// Returns zero when this endpoint has no state for the exact space: a
    /// fresh coordinator generation, a new coordinator after a removal, or the
    /// first operation in the era. A different generation is a different space,
    /// not a lower value for this one.
    pub(crate) fn next(
        &self,
        coordinator: u16,
        coordinator_generation: u16,
        targets: &[DropTarget],
    ) -> u32 {
        self.entries
            .get(&TerminalEpochKey::from_targets(
                coordinator,
                coordinator_generation,
                targets,
            ))
            .map_or(0, |entry| entry.next)
    }

    /// Whether this endpoint has ever recorded an epoch in the exact space.
    pub(crate) fn has_state(
        &self,
        coordinator: u16,
        coordinator_generation: u16,
        targets: &[DropTarget],
    ) -> bool {
        self.entries.contains_key(&TerminalEpochKey::from_targets(
            coordinator,
            coordinator_generation,
            targets,
        ))
    }

    /// Records that an authority epoch was consumed by an admitted operation.
    ///
    /// The same space only advances `next`, and the target generations are
    /// refreshed so a reactivated slot carries the epoch forward. A new space
    /// first drops older coordinators and generations for the same target set,
    /// then reclaims entries whose endpoint or handle set is no longer current.
    /// The table refuses the operation rather than evicting a live epoch.
    pub(crate) fn record(
        &mut self,
        record: TerminalEpochRecord,
        target_set_is_current: impl Fn(&[DropTarget]) -> bool,
    ) -> Result<(), TerminalEpochTableFull> {
        let key = TerminalEpochKey::from_targets(
            record.coordinator,
            record.coordinator_generation,
            &record.targets,
        );
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.next = advance_next(entry.next, record.next);
            entry.targets = record.targets;
            return Ok(());
        }
        // A target set has one current coordinator and at most two acceptable
        // generations (local and local+1). Drop older coordinators and
        // generations so a long-lived session cannot fill the bounded map with
        // dead spaces. A coordinator change starts a fresh space; the
        // coordinator-generation fence rejects its predecessor's artifacts.
        let local_generation = record.local_generation;
        self.entries.retain(|existing, _entry| {
            existing.handles != key.handles
                || epoch_space_is_retained(
                    existing.coordinator,
                    existing.coordinator_generation,
                    key.coordinator,
                    local_generation,
                )
        });
        if self.entries.len() >= record.capacity {
            // A canonical target set is the fixed handle set of one remote
            // endpoint, so reclaim entries whose endpoint or handle set is no
            // longer current. The live map is then bounded by the roster;
            // twice that leaves headroom before refusing the operation rather
            // than evicting a live epoch.
            self.entries
                .retain(|_key, entry| target_set_is_current(&entry.targets));
        }
        if self.entries.len() >= record.capacity {
            return Err(TerminalEpochTableFull);
        }
        self.entries.insert(
            key,
            TerminalEpochEntry {
                targets: record.targets,
                next: record.next,
            },
        );
        Ok(())
    }

    /// The number of live epoch spaces, used to pin the roster-derived bound.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether any live space is scoped to exactly `handles`.
    #[cfg(test)]
    pub(crate) fn contains_handle_set(&self, handles: &[u16]) -> bool {
        self.entries.keys().any(|key| key.handles() == handles)
    }
}

#[cfg(kani)]
#[cfg_attr(any(), mutants::skip)]
mod kani_proofs {
    use super::*;

    /// Mirrors the coordinator and generation portion of the derived equality
    /// on [`TerminalEpochKey`].
    ///
    /// The table's key also compares the canonical handle set. The one-ahead
    /// and current eras in these proofs share that set by construction, so this
    /// kernel is the load-bearing identity rule. Constructing a real key builds
    /// a heap `Vec`, which the Kani budget cannot model; the table-level tests
    /// `current_and_one_ahead_eras_keep_separate_epochs` and
    /// `table_prunes_a_behind_era_when_the_local_view_advanced` pin the real
    /// key's derived behavior.
    fn epoch_keys_match(
        first_coordinator: u16,
        first_generation: u16,
        second_coordinator: u16,
        second_generation: u16,
    ) -> bool {
        first_coordinator == second_coordinator && first_generation == second_generation
    }

    /// The value a space holds after one lookup. A distinct key never advances
    /// another key's epoch.
    fn next_after_insertion(matched: bool, current: u32, proposed: u32) -> u32 {
        if matched {
            advance_next(current, proposed)
        } else {
            current
        }
    }

    /// Recording an epoch only advances a space; it never lowers `next`.
    #[kani::proof]
    fn proof_terminal_epoch_next_is_monotone() {
        let current: u32 = kani::any();
        let proposed: u32 = kani::any();

        let advanced = advance_next(current, proposed);
        assert!(advanced >= current, "an epoch space never moves backwards");
        assert!(
            advanced >= proposed,
            "the consumed epoch is always admitted"
        );
        assert_eq!(
            advance_next(advanced, proposed),
            advanced,
            "a duplicate proposal is idempotent"
        );
        assert_eq!(
            advance_next(advanced, current),
            advanced,
            "an older proposal cannot lower the space"
        );
        assert_eq!(
            advance_next(current, current),
            current,
            "an equal proposal keeps the value"
        );
    }

    /// The one-ahead era and the current era are distinct spaces. A one-ahead
    /// insertion must not advance the current era's next epoch (the #525
    /// regression). The old handles-only key dropped the generation, so
    /// `epoch_keys_match` returned true and the higher one-ahead epoch
    /// swallowed the current era.
    #[kani::proof]
    fn proof_terminal_epoch_one_ahead_does_not_swallow_current() {
        let coordinator: u16 = kani::any();
        let current_generation: u16 = kani::any();
        let ahead_generation = current_generation.wrapping_add(1);

        assert!(
            !epoch_keys_match(
                coordinator,
                current_generation,
                coordinator,
                ahead_generation
            ),
            "a differing generation must not share an epoch space"
        );
        assert!(
            epoch_keys_match(
                coordinator,
                current_generation,
                coordinator,
                current_generation
            ),
            "the same generation is the same space"
        );
        let other_coordinator: u16 = kani::any();
        kani::assume(other_coordinator != coordinator);
        assert!(
            !epoch_keys_match(
                coordinator,
                current_generation,
                other_coordinator,
                current_generation
            ),
            "a differing coordinator must not share an epoch space"
        );

        let current_next: u32 = kani::any();
        let ahead_next: u32 = kani::any();
        kani::assume(current_next < ahead_next);
        assert_eq!(
            next_after_insertion(
                epoch_keys_match(
                    coordinator,
                    current_generation,
                    coordinator,
                    ahead_generation
                ),
                current_next,
                ahead_next
            ),
            current_next,
            "the one-ahead era must not swallow the current era's epoch"
        );
        assert_eq!(
            next_after_insertion(
                epoch_keys_match(
                    coordinator,
                    current_generation,
                    coordinator,
                    current_generation
                ),
                current_next,
                ahead_next
            ),
            ahead_next,
            "the exact space advances monotonically"
        );
    }

    /// A retained space is always scoped to the inserted coordinator and to
    /// one of exactly two generations, so a target set holds at most two
    /// acceptable generations.
    #[kani::proof]
    fn proof_terminal_epoch_at_most_two_generations_per_target_set() {
        let local_generation: u16 = kani::any();
        let existing_coordinator: u16 = kani::any();
        let existing_generation: u16 = kani::any();
        let inserted_coordinator: u16 = kani::any();

        let retained = epoch_space_is_retained(
            existing_coordinator,
            existing_generation,
            inserted_coordinator,
            local_generation,
        );
        if retained {
            assert!(
                existing_coordinator == inserted_coordinator,
                "a coordinator change prunes the old coordinator's spaces"
            );
            assert!(
                existing_generation == local_generation
                    || existing_generation == local_generation.wrapping_add(1),
                "a retained generation is the local or the one-ahead era"
            );
        }

        // The retained set is a subset of a two-element set, so it can never
        // hold a third generation.
        assert!(epoch_generation_is_current(
            local_generation,
            local_generation
        ));
        assert!(epoch_generation_is_current(
            local_generation.wrapping_add(1),
            local_generation
        ));
        assert!(!epoch_generation_is_current(
            local_generation.wrapping_sub(1),
            local_generation
        ));
        assert!(!epoch_generation_is_current(
            local_generation.wrapping_add(2),
            local_generation
        ));

        kani::assume(existing_coordinator != inserted_coordinator);
        assert!(
            !epoch_space_is_retained(
                existing_coordinator,
                local_generation,
                inserted_coordinator,
                local_generation
            ),
            "a new coordinator retains none of the old spaces"
        );
    }

    /// A fallback adopts only while it has no local state, and only a bounded
    /// first epoch. An established space never takes the adoption path.
    #[kani::proof]
    fn proof_terminal_epoch_fallback_adoption_is_bounded_and_only_when_empty() {
        let requested: u32 = kani::any();
        let authority_next: u32 = kani::any();
        let has_local_state: bool = kani::any();
        let acting_fallback: bool = kani::any();

        let decision = epoch_admission(
            true,
            requested,
            authority_next,
            has_local_state,
            acting_fallback,
        );
        if requested == authority_next {
            assert_eq!(decision, EpochAdmission::Admit);
        } else if acting_fallback && !has_local_state && requested <= MAX_ADOPTED_EPOCH {
            assert_eq!(decision, EpochAdmission::Adopt);
        } else {
            assert_eq!(decision, EpochAdmission::Reject);
        }
        if decision == EpochAdmission::Adopt {
            assert!(
                acting_fallback && !has_local_state,
                "adoption requires a fresh acting fallback"
            );
            assert!(
                requested <= MAX_ADOPTED_EPOCH,
                "the adopted first epoch is bounded"
            );
        }
        if has_local_state || !acting_fallback {
            assert_ne!(
                decision,
                EpochAdmission::Adopt,
                "an established space never adopts"
            );
        }

        assert_eq!(
            epoch_admission(true, MAX_ADOPTED_EPOCH, 0, false, true),
            EpochAdmission::Adopt,
            "the adoption bound is inclusive"
        );
        assert_eq!(
            epoch_admission(true, MAX_ADOPTED_EPOCH.wrapping_add(1), 0, false, true),
            EpochAdmission::Reject,
            "an unbounded future proposal stays discarded"
        );
    }

    /// The canonical handle sequence is deterministic, strictly ascending, and
    /// retains every distinct input handle.
    ///
    /// `TerminalEpochTable::record` builds the key and stores the entry from the
    /// same target list, so this canonicalization is what makes an entry's
    /// targets match its key's handles for a target-generation change.
    #[kani::proof]
    #[kani::unwind(5)]
    fn proof_terminal_epoch_entry_targets_match_key_handles() {
        let first: u16 = kani::any();
        let second: u16 = kani::any();
        let third: u16 = kani::any();
        let original = [first, second, third];
        let mut canonical = original;
        let mut repeated = original;

        let length = canonicalize_handles(&mut canonical, original.len());
        let repeated_length = canonicalize_handles(&mut repeated, original.len());
        assert_eq!(length, repeated_length, "canonicalization is deterministic");

        let mut index = 0;
        while index < length {
            assert_eq!(
                canonical.get(index),
                repeated.get(index),
                "the same targets always produce the same handles"
            );
            index += 1;
        }

        index = 1;
        while index < length {
            let previous = canonical.get(index - 1).copied();
            let current = canonical.get(index).copied();
            assert!(
                matches!((previous, current), (Some(previous), Some(current)) if previous < current),
                "the canonical sequence is strictly ascending"
            );
            index += 1;
        }

        let mut input_index = 0;
        while input_index < original.len() {
            let handle = original.get(input_index).copied();
            let mut found = false;
            let mut output_index = 0;
            while output_index < length {
                if canonical.get(output_index).copied() == handle {
                    found = true;
                }
                output_index += 1;
            }
            assert!(found, "canonicalization never loses a distinct handle");
            input_index += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(handle: u16, generation: u16) -> DropTarget {
        DropTarget { handle, generation }
    }

    fn record(
        coordinator: u16,
        coordinator_generation: u16,
        targets: &[DropTarget],
        next: u32,
        local_generation: u16,
        capacity: usize,
    ) -> TerminalEpochRecord {
        TerminalEpochRecord {
            coordinator,
            coordinator_generation,
            targets: targets.to_vec(),
            next,
            local_generation,
            capacity,
        }
    }

    #[test]
    fn advance_next_keeps_the_higher_epoch() {
        assert_eq!(advance_next(0, 0), 0);
        assert_eq!(advance_next(3, 7), 7);
        assert_eq!(advance_next(7, 3), 7);
        assert_eq!(advance_next(7, 7), 7);
        assert_eq!(advance_next(0, u32::MAX), u32::MAX);
    }

    #[test]
    fn canonicalize_handles_sorts_and_deduplicates() {
        let mut unsorted = [3, 1, 2, 1];
        let length = canonicalize_handles(&mut unsorted, 4);
        assert_eq!(unsorted.get(..length), Some(&[1_u16, 2, 3][..]));

        let mut empty: [u16; 0] = [];
        assert_eq!(canonicalize_handles(&mut empty, 0), 0);

        let mut single = [7];
        assert_eq!(canonicalize_handles(&mut single, 1), 1);
        assert_eq!(single.first(), Some(&7));

        let mut duplicates = [5, 5, 5];
        assert_eq!(canonicalize_handles(&mut duplicates, 3), 1);
        assert_eq!(duplicates.first(), Some(&5));

        let mut already_sorted = [1, 2, 3];
        assert_eq!(canonicalize_handles(&mut already_sorted, 3), 3);
        assert_eq!(already_sorted, [1, 2, 3]);

        let mut descending = [4, 3, 2, 1];
        let descending_length = canonicalize_handles(&mut descending, 4);
        assert_eq!(
            descending.get(..descending_length),
            Some(&[1_u16, 2, 3, 4][..])
        );

        // A length beyond the slice is clamped instead of indexing the tail.
        let mut short = [2, 1];
        assert_eq!(canonicalize_handles(&mut short, 5), 2);
        assert_eq!(short, [1, 2]);
    }

    #[test]
    fn current_and_one_ahead_eras_keep_separate_epochs() {
        let targets = [target(4, 0)];
        let mut table = TerminalEpochTable::default();

        table
            .record(record(0, 1, &targets, 7, 0, 4), |_| true)
            .expect("the one-ahead era is admissible during a rejoin window");
        table
            .record(record(0, 0, &targets, 3, 0, 4), |_| true)
            .expect("the current era is a distinct space");

        assert_eq!(
            table.next(0, 0, &targets),
            3,
            "the one-ahead era must not swallow the current era's epoch"
        );
        assert_eq!(
            table.next(0, 1, &targets),
            7,
            "the one-ahead era keeps its own epoch"
        );
        assert_eq!(table.len(), 2);
    }

    #[test]
    fn target_order_and_duplicates_share_one_epoch_space() {
        let ordered = [target(1, 0), target(2, 0)];
        let reordered = [target(2, 0), target(1, 0), target(2, 0)];
        let mut table = TerminalEpochTable::default();

        table
            .record(record(0, 0, &ordered, 5, 0, 4), |_| true)
            .expect("the first space is admissible");

        assert_eq!(table.next(0, 0, &reordered), 5);
        assert!(table.has_state(0, 0, &reordered));
    }

    #[test]
    fn table_prunes_a_behind_era_when_the_local_view_advanced() {
        let targets = [target(4, 0)];
        let mut table = TerminalEpochTable::default();

        table
            .record(record(0, 0, &targets, 1, 0, 4), |_| true)
            .expect("seed the behind era");
        table
            .record(record(0, 1, &targets, 1, 1, 4), |_| true)
            .expect("the current era replaces the behind era");

        assert_eq!(table.next(0, 1, &targets), 1);
        assert_eq!(
            table.next(0, 0, &targets),
            0,
            "the behind era is pruned instead of lingering"
        );
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn table_never_holds_more_than_two_generations_for_one_target_set() {
        let targets = [target(4, 0)];
        let mut table = TerminalEpochTable::default();

        for generation in 0..8_u16 {
            table
                .record(record(0, generation, &targets, 1, generation, 64), |_| true)
                .expect("each current era is admissible");
            let generations = (0..=generation)
                .filter(|candidate| table.next(0, *candidate, &targets) != 0)
                .count();
            assert!(
                generations <= 2,
                "generation {generation} left {generations} live eras"
            );
        }
    }

    #[test]
    fn capacity_reclaims_stale_target_sets_before_refusing() {
        let mut table = TerminalEpochTable::default();
        for handle in 5..10_u16 {
            table
                .record(record(0, 0, &[target(handle, 0)], 1, 0, 5), |_| false)
                .expect("fixture fills the bound");
        }
        assert_eq!(table.len(), 5);

        let current = [target(4, 0)];
        table
            .record(record(0, 0, &current, 1, 0, 5), |targets| {
                targets.iter().any(|target| target.handle == 4)
            })
            .expect("a current target set is admissible after reclamation");

        assert!(!table.contains_handle_set(&[5]));
        assert_eq!(table.next(0, 0, &current), 1);
    }

    #[test]
    fn full_table_refuses_instead_of_reusing_an_epoch() {
        let mut table = TerminalEpochTable::default();
        table
            .record(record(0, 0, &[target(1, 0)], 1, 0, 1), |_| true)
            .expect("the first space fits");

        let result = table.record(record(0, 0, &[target(2, 0)], 1, 0, 1), |_| true);

        assert_eq!(result, Err(TerminalEpochTableFull));
        assert_eq!(
            table.next(0, 0, &[target(2, 0)]),
            0,
            "a refused operation records nothing"
        );
    }

    #[test]
    fn admission_requires_empty_state_for_fallback_adoption() {
        assert_eq!(
            epoch_admission(true, 3, 5, false, true),
            EpochAdmission::Adopt
        );
        assert_eq!(
            epoch_admission(true, 3, 5, true, true),
            EpochAdmission::Reject,
            "an established space never adopts"
        );
        assert_eq!(
            epoch_admission(true, 5, 5, false, true),
            EpochAdmission::Admit,
            "exact equality wins over adoption"
        );
        assert_eq!(
            epoch_admission(true, 3, 5, false, false),
            EpochAdmission::Reject
        );
        assert_eq!(
            epoch_admission(false, 4, 5, false, false),
            EpochAdmission::Reject,
            "a participant discards a below-next replay"
        );
        assert_eq!(
            epoch_admission(false, 6, 5, false, false),
            EpochAdmission::Admit,
            "a participant admits the authority's at-or-above epoch"
        );
    }
}

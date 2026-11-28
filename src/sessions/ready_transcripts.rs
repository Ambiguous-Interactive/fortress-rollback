//! Provisional and locked `Ready` transcripts for coordinated drops.
//!
//! A `Ready` report names the selected cut and the reporter's digest of its
//! confirmed history at that cut. Agreement on the frame alone does not
//! establish agreement on the history, so a non-authority report received
//! before an authority (or independently verified local history) locks the
//! digest is provisional and must not count toward the quorum (issue #529).
//!
//! The typestate makes that rule structural: `Provisional` and `Locked`
//! transcripts are distinct types, only locked transcripts live in the counted
//! set, and the counted set is private. `ReadyTranscripts::promote_matching`
//! is the single provisional-to-locked transition, and it requires the locked
//! digest. The surrounding session still owns the cut, quorum, and authority
//! decision; this module only keeps the digest and transcript bookkeeping
//! consistent with them.

use std::collections::{BTreeMap, BTreeSet};
use std::marker::PhantomData;

use crate::Frame;

/// Marker state for a transcript recorded before the digest was locked.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Provisional;

/// Marker state for a transcript recorded against the locked digest.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Locked;

/// One participant's `Ready` report. The marker type is the transcript state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ReadyTranscript<State> {
    cut: Frame,
    digest: u64,
    state: PhantomData<State>,
}

impl<State> ReadyTranscript<State> {
    const fn new(cut: Frame, digest: u64) -> Self {
        Self {
            cut,
            digest,
            state: PhantomData,
        }
    }

    /// The cut this report selected.
    pub(crate) const fn cut(&self) -> Frame {
        self.cut
    }

    /// The reporter's digest of the confirmed history at [`Self::cut`].
    pub(crate) const fn digest(&self) -> u64 {
        self.digest
    }
}

/// Whether an incoming report may count, stay provisional, or conflicts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Admission {
    /// The digest is locked (and matches) or the reporter is an authority.
    Count,
    /// The digest is unlocked and the reporter is not an authority.
    Provisional,
    /// The digest is locked to a different value.
    Conflict,
}

/// Pure admission rule for one `Ready` report.
///
/// This is the whole #529 gate: an unlocked digest accepts a report only as
/// provisional unless the reporter is an authority, and a locked digest accepts
/// only the matching value.
pub(crate) const fn ready_admission(
    locked: Option<u64>,
    reported: u64,
    authority: bool,
) -> Admission {
    match locked {
        Some(expected) if expected != reported => Admission::Conflict,
        Some(_) => Admission::Count,
        None if authority => Admission::Count,
        None => Admission::Provisional,
    }
}

/// A conflicting digest or transcript for one operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ReadyConflict;

/// The cut and digest an authority or independently verified local history
/// established for one attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LockedDigest {
    cut: Frame,
    digest: u64,
}

/// Locked cut/digest plus the provisional and counted `Ready` transcripts for
/// one coordinated-drop attempt.
///
/// Every collection is bounded by the attempt's participant set.
#[derive(Debug, Default)]
pub(crate) struct ReadyTranscripts {
    /// The selected cut and its expected digest, once established.
    lock: Option<LockedDigest>,
    /// Reports that match the locked digest, including actors that still have
    /// to be counted by a later reconciliation.
    locked: BTreeMap<u16, ReadyTranscript<Locked>>,
    /// Reports received before the digest was locked. They never count.
    provisional: BTreeMap<u16, ReadyTranscript<Provisional>>,
    /// Participants whose locked report counts toward the quorum.
    counted: BTreeSet<u16>,
}

impl ReadyTranscripts {
    /// The established digest, if any.
    pub(crate) const fn digest(&self) -> Option<u64> {
        match self.lock {
            Some(lock) => Some(lock.digest),
            None => None,
        }
    }

    /// The established cut, if any.
    #[cfg(test)]
    pub(crate) const fn locked_cut(&self) -> Option<Frame> {
        match self.lock {
            Some(lock) => Some(lock.cut),
            None => None,
        }
    }

    /// Number of participants counted toward the Ready quorum.
    pub(crate) fn count(&self) -> usize {
        self.counted.len()
    }

    /// Whether one participant counts toward the Ready quorum.
    pub(crate) fn is_counted(&self, participant: u16) -> bool {
        self.counted.contains(&participant)
    }

    /// The counted participants, for the quorum witness checks.
    pub(crate) fn counted(&self) -> &BTreeSet<u16> {
        &self.counted
    }

    /// Whether any report has been locked against the digest.
    #[cfg(test)]
    pub(crate) fn locked_is_empty(&self) -> bool {
        self.locked.is_empty()
    }

    /// Whether one participant has a locked transcript.
    #[cfg(any(test, kani))]
    pub(crate) fn has_locked_transcript(&self, participant: u16) -> bool {
        self.locked.contains_key(&participant)
    }

    /// Whether one participant's locked transcript matches this cut and digest.
    #[cfg(test)]
    pub(crate) fn transcript_matches(&self, participant: u16, cut: Frame, digest: u64) -> bool {
        self.locked
            .get(&participant)
            .is_some_and(|transcript| transcript.cut() == cut && transcript.digest() == digest)
    }

    /// Locked transcripts in participant order, for retransmission.
    pub(crate) fn locked_transcripts(&self) -> impl Iterator<Item = (u16, Frame, u64)> + '_ {
        self.locked
            .iter()
            .map(|(&participant, transcript)| (participant, transcript.cut(), transcript.digest()))
    }

    /// Provisional transcripts in participant order, for trace validation.
    #[cfg(feature = "trace-validation")]
    pub(crate) fn provisional_transcripts(&self) -> impl Iterator<Item = (u16, Frame, u64)> + '_ {
        self.provisional
            .iter()
            .map(|(&participant, transcript)| (participant, transcript.cut(), transcript.digest()))
    }

    /// Establishes the expected cut and digest, then promotes matching
    /// provisional reports.
    ///
    /// Returns whether this call locked the digest. A different already-locked
    /// cut or digest is a conflict, so a report cannot lock a digest under the
    /// wrong cut.
    pub(crate) fn lock_digest(&mut self, cut: Frame, digest: u64) -> Result<bool, ReadyConflict> {
        let newly_locked = self.establish_lock(cut, digest)?;
        self.promote_matching(cut);
        Ok(newly_locked)
    }

    /// Adopts a certified commit's cut and digest without promoting provisional
    /// reports.
    ///
    /// The commit path defers promotion until the attempt is reconciled; this
    /// preserves the pre-extraction ordering.
    pub(crate) fn adopt_digest(&mut self, cut: Frame, digest: u64) -> Result<bool, ReadyConflict> {
        self.establish_lock(cut, digest)
    }

    fn establish_lock(&mut self, cut: Frame, digest: u64) -> Result<bool, ReadyConflict> {
        match self.lock {
            Some(existing) if existing.cut != cut || existing.digest != digest => {
                Err(ReadyConflict)
            },
            Some(_) => Ok(false),
            None => {
                self.lock = Some(LockedDigest { cut, digest });
                Ok(true)
            },
        }
    }

    /// Promotes provisional reports that match the locked cut and digest and
    /// discards the rest.
    ///
    /// A mismatch is not an error: it is a peer artifact that can never count.
    /// Matching reports become locked and count toward the quorum.
    pub(crate) fn promote_matching(&mut self, cut: Frame) {
        let Some(lock) = self.lock else {
            return;
        };
        if lock.cut != cut {
            return;
        }
        let provisional = std::mem::take(&mut self.provisional);
        for (participant, transcript) in provisional {
            if transcript.cut() == lock.cut && transcript.digest() == lock.digest {
                self.locked
                    .insert(participant, ReadyTranscript::new(lock.cut, lock.digest));
                self.counted.insert(participant);
            }
        }
    }

    /// Admits one report and returns whether it is new information to relay.
    ///
    /// A non-authority report for an unlocked digest stays provisional and is
    /// never counted. A report that conflicts with the locked digest or with a
    /// participant's existing transcript returns [`ReadyConflict`]; the caller
    /// decides whether that is a peer artifact or a genuine authority conflict.
    pub(crate) fn admit(
        &mut self,
        participant: u16,
        cut: Frame,
        digest: u64,
        authority: bool,
    ) -> Result<bool, ReadyConflict> {
        // A report for another cut cannot lock or count, even if its digest
        // happens to match. The previous cut guard rejects it before any state
        // changes.
        if self.lock.is_some_and(|lock| lock.cut != cut) {
            return Err(ReadyConflict);
        }
        match ready_admission(self.digest(), digest, authority) {
            Admission::Conflict => Err(ReadyConflict),
            Admission::Count => {
                let newly_locked = if authority {
                    self.lock_digest(cut, digest)?
                } else {
                    self.promote_matching(cut);
                    false
                };
                let newly_recorded = self.count_locked(participant, cut, digest)?;
                Ok(newly_locked || newly_recorded)
            },
            Admission::Provisional => match self.provisional.get(&participant) {
                Some(existing) if existing.cut() != cut || existing.digest() != digest => {
                    Err(ReadyConflict)
                },
                Some(_) => Ok(false),
                None => {
                    self.provisional
                        .insert(participant, ReadyTranscript::new(cut, digest));
                    Ok(true)
                },
            },
        }
    }

    /// Records a locked transcript without promoting provisional reports.
    ///
    /// Used by the certified-commit path, which adopts the commit digest before
    /// the normal Ready reconciliation runs.
    pub(crate) fn record_locked(
        &mut self,
        participant: u16,
        cut: Frame,
        digest: u64,
    ) -> Result<bool, ReadyConflict> {
        self.count_locked(participant, cut, digest)
    }

    fn count_locked(
        &mut self,
        participant: u16,
        cut: Frame,
        digest: u64,
    ) -> Result<bool, ReadyConflict> {
        if self.lock != Some(LockedDigest { cut, digest }) {
            return Err(ReadyConflict);
        }
        match self.locked.get(&participant) {
            Some(existing) if existing.cut() != cut || existing.digest() != digest => {
                Err(ReadyConflict)
            },
            Some(_) => {
                self.counted.insert(participant);
                Ok(false)
            },
            None => {
                self.locked
                    .insert(participant, ReadyTranscript::new(cut, digest));
                self.counted.insert(participant);
                Ok(true)
            },
        }
    }

    /// Rebuilds the counted set from locked transcripts at `cut`.
    ///
    /// A locked transcript for a different cut is a conflict with the selected
    /// cut; a transcript for a different digest is a peer artifact and does not
    /// count.
    pub(crate) fn resync_counted(&mut self, cut: Frame) -> Result<(), ReadyConflict> {
        let Some(lock) = self.lock else {
            return Ok(());
        };
        if lock.cut != cut {
            return Err(ReadyConflict);
        }
        for (&participant, transcript) in &self.locked {
            if transcript.cut() != cut {
                return Err(ReadyConflict);
            }
            if transcript.digest() == lock.digest {
                self.counted.insert(participant);
            }
        }
        Ok(())
    }

    /// Builds arbitrary test fixtures, including the pre-extraction
    /// inconsistent shapes the regression tests pin.
    #[cfg(test)]
    pub(crate) fn from_parts(
        lock: Option<(Frame, u64)>,
        locked: impl IntoIterator<Item = (u16, Frame, u64)>,
        provisional: impl IntoIterator<Item = (u16, Frame, u64)>,
        counted: impl IntoIterator<Item = u16>,
    ) -> Self {
        Self {
            lock: lock.map(|(cut, digest)| LockedDigest { cut, digest }),
            locked: locked
                .into_iter()
                .map(|(participant, cut, digest)| (participant, ReadyTranscript::new(cut, digest)))
                .collect(),
            provisional: provisional
                .into_iter()
                .map(|(participant, cut, digest)| (participant, ReadyTranscript::new(cut, digest)))
                .collect(),
            counted: counted.into_iter().collect(),
        }
    }

    /// Overrides the lock for tests that stage a partial attempt.
    #[cfg(test)]
    pub(crate) fn set_lock_for_test(&mut self, lock: Option<(Frame, u64)>) {
        self.lock = lock.map(|(cut, digest)| LockedDigest { cut, digest });
    }
}

#[cfg(kani)]
#[cfg_attr(any(), mutants::skip)]
mod kani_proofs {
    use super::*;

    /// A count decision always has either an authority reporter or a matching
    /// lock. This is the admission rule stated without any collection state.
    #[kani::proof]
    fn proof_ready_admission_count_requires_authority_or_lock() {
        let locked: Option<u64> = kani::any();
        let reported: u64 = kani::any();
        let authority: bool = kani::any();

        match ready_admission(locked, reported, authority) {
            Admission::Count => {
                assert!(
                    authority || locked == Some(reported),
                    "only an authority or a matching lock may count"
                );
            },
            Admission::Provisional => {
                assert!(!authority, "an authority never stays provisional");
                assert!(locked.is_none(), "a locked digest never stays provisional");
            },
            Admission::Conflict => {
                assert!(
                    locked.is_some_and(|expected| expected != reported),
                    "conflict requires a differing locked digest"
                );
            },
        }
    }

    /// A non-authority report cannot lock the digest or count. The provisional
    /// map is the only state it may create.
    #[kani::proof]
    #[kani::unwind(4)]
    fn proof_ready_transcripts_provisional_never_counts() {
        let cut = Frame::new(0);
        let digest: u64 = kani::any();
        let mut ready = ReadyTranscripts::default();

        let result = ready.admit(1, cut, digest, false);

        assert!(
            result.is_ok(),
            "a fresh digest accepts a provisional report"
        );
        assert_eq!(
            ready.digest(),
            None,
            "a non-authority cannot lock the digest"
        );
        assert_eq!(ready.count(), 0, "a provisional report never counts");
        assert!(!ready.is_counted(1));
    }

    /// Promotion counts exactly the provisional reports whose digest matches
    /// the established lock; a mismatch is discarded (the #529 regression).
    ///
    /// The three BTree collections hold at most one entry here, so their drop
    /// and navigation loops unroll three times and the loop assertion fires at
    /// `#[kani::unwind(4)]`. The default bound of eight makes CBMC explore
    /// redundant deallocation paths and exceeds the per-proof timeout on CI;
    /// four keeps the same symbolic property tractable.
    #[kani::proof]
    #[kani::unwind(4)]
    fn proof_ready_transcripts_promotion_requires_matching_digest() {
        let cut = Frame::new(0);
        let provisional_digest: u64 = kani::any();
        let locked_digest: u64 = kani::any();
        let mut ready = ReadyTranscripts::default();

        assert!(ready.admit(1, cut, provisional_digest, false).is_ok());
        assert_eq!(ready.digest(), None);
        assert_eq!(ready.count(), 0);

        assert_eq!(ready.lock_digest(cut, locked_digest), Ok(true));

        assert_eq!(ready.digest(), Some(locked_digest));
        assert_eq!(
            ready.is_counted(1),
            provisional_digest == locked_digest,
            "the provisional report counts only when its digest matches the lock"
        );
        assert_eq!(
            ready.has_locked_transcript(1),
            provisional_digest == locked_digest,
            "a mismatching provisional report is discarded, not relabeled"
        );

        let other_cut = Frame::new(1);
        assert_eq!(
            ready.admit(1, other_cut, locked_digest, true),
            Err(ReadyConflict),
            "a matching digest under another cut cannot count"
        );
        assert_eq!(
            ready.count(),
            usize::from(provisional_digest == locked_digest),
            "a wrong-cut report leaves the counted set unchanged"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_authority_report_stays_provisional_until_the_digest_locks() {
        let cut = Frame::new(10);
        let mut ready = ReadyTranscripts::default();

        assert_eq!(ready.admit(3, cut, 7, false), Ok(true));
        assert_eq!(ready.digest(), None);
        assert!(!ready.is_counted(3));
        assert!(!ready.has_locked_transcript(3));

        assert_eq!(ready.lock_digest(cut, 7), Ok(true));
        assert_eq!(ready.digest(), Some(7));
        assert!(ready.is_counted(3));
        assert!(ready.transcript_matches(3, cut, 7));
    }

    #[test]
    fn mismatching_provisional_report_is_discarded_on_lock() {
        let cut = Frame::new(10);
        let mut ready = ReadyTranscripts::default();

        assert_eq!(ready.admit(3, cut, 7, false), Ok(true));
        assert_eq!(ready.lock_digest(cut, 8), Ok(true));

        assert_eq!(ready.digest(), Some(8));
        assert!(!ready.is_counted(3));
        assert!(!ready.has_locked_transcript(3));
    }

    #[test]
    fn non_authority_report_conflicts_with_a_different_locked_digest() {
        let cut = Frame::new(10);
        let mut ready = ReadyTranscripts::default();
        assert_eq!(ready.lock_digest(cut, 8), Ok(true));

        assert_eq!(ready.admit(3, cut, 7, false), Err(ReadyConflict));
        assert_eq!(ready.digest(), Some(8));
        assert!(!ready.is_counted(3));

        assert_eq!(ready.admit(0, cut, 8, true), Ok(true));
        assert!(ready.is_counted(0));
    }

    #[test]
    fn a_matching_digest_under_another_cut_is_a_conflict() {
        let cut = Frame::new(10);
        let other_cut = Frame::new(11);
        let mut ready = ReadyTranscripts::default();
        assert_eq!(ready.lock_digest(cut, 7), Ok(true));

        assert_eq!(ready.lock_digest(other_cut, 7), Err(ReadyConflict));
        assert_eq!(ready.locked_cut(), Some(cut));
        assert_eq!(ready.admit(3, other_cut, 7, true), Err(ReadyConflict));
        assert_eq!(ready.admit(3, other_cut, 7, false), Err(ReadyConflict));
        assert_eq!(ready.count(), 0);
        assert_eq!(ready.adopt_digest(other_cut, 7), Err(ReadyConflict));
        assert_eq!(ready.locked_cut(), Some(cut));
    }

    #[test]
    fn conflicting_retry_for_one_participant_is_a_conflict() {
        let cut = Frame::new(10);
        let mut ready = ReadyTranscripts::default();
        assert_eq!(ready.admit(3, cut, 7, false), Ok(true));
        assert_eq!(ready.admit(3, cut, 8, false), Err(ReadyConflict));
        assert!(!ready.is_counted(3));

        assert_eq!(ready.lock_digest(cut, 7), Ok(true));
        assert!(ready.is_counted(3));
        assert_eq!(ready.admit(3, cut, 8, false), Err(ReadyConflict));
    }

    #[test]
    fn transcript_before_the_lock_is_a_conflict_and_never_counts() {
        let cut = Frame::new(10);
        let mut ready = ReadyTranscripts::default();

        assert_eq!(ready.record_locked(3, cut, 7), Err(ReadyConflict));
        assert_eq!(ready.count(), 0);
        assert!(!ready.has_locked_transcript(3));
    }

    #[test]
    fn adopted_commit_digest_does_not_promote_provisional_reports() {
        let cut = Frame::new(10);
        let mut ready = ReadyTranscripts::default();
        assert_eq!(ready.admit(3, cut, 7, false), Ok(true));
        assert_eq!(ready.adopt_digest(cut, 7), Ok(true));
        assert_eq!(ready.digest(), Some(7));
        assert!(
            !ready.is_counted(3),
            "the commit path defers promotion to the Ready reconciliation"
        );

        assert_eq!(ready.record_locked(1, cut, 7), Ok(true));
        assert!(ready.is_counted(1));
        assert_eq!(ready.record_locked(1, cut, 7), Ok(false));
        assert_eq!(ready.count(), 1);
        assert_eq!(ready.record_locked(2, cut, 9), Err(ReadyConflict));
    }

    #[test]
    fn resync_counts_only_matching_digests_and_rejects_a_foreign_cut() {
        let cut = Frame::new(10);
        let mut ready =
            ReadyTranscripts::from_parts(Some((cut, 7)), [(1, cut, 7), (2, cut, 9)], [], []);

        assert_eq!(ready.resync_counted(cut), Ok(()));
        assert!(ready.is_counted(1));
        assert!(!ready.is_counted(2));

        assert_eq!(
            ready.resync_counted(Frame::new(11)),
            Err(ReadyConflict),
            "a locked transcript for another cut conflicts with the selected cut"
        );
    }

    #[test]
    fn locked_transcripts_are_exposed_in_participant_order() {
        let cut = Frame::new(10);
        let ready =
            ReadyTranscripts::from_parts(Some((cut, 7)), [(3, cut, 7), (1, cut, 7)], [], [1, 3]);

        assert_eq!(
            ready.locked_transcripts().collect::<Vec<_>>(),
            vec![(1, cut, 7), (3, cut, 7)]
        );
        assert_eq!(ready.count(), 2);
    }
}

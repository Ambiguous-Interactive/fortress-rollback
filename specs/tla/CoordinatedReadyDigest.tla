------------------------- MODULE CoordinatedReadyDigest -------------------------
(***************************************************************************)
(* Provisional `Ready` digest gate for the coordinated graceful drop.      *)
(*                                                                         *)
(* #529 / #530: when a cut was known but its digest was not, a             *)
(* non-authority Ready locked `cut_digest` and counted toward the          *)
(* strict-majority quorum. One peer could therefore lock a divergent       *)
(* digest before the authority's correct Ready and turn a healthy session  *)
(* into `ConflictingHistory`. Production now keeps pre-digest Ready        *)
(* reports in `provisional_ready`; only the effective authority (the       *)
(* deterministic coordinator or the adopted acting fallback) or            *)
(* independently verified local history locks the digest, a matching       *)
(* provisional is promoted, and a mismatching one is discarded.            *)
(*                                                                         *)
(* VARIABLE / ACTION MAP (issue #573 names -> model)                       *)
(*   phase, cut       -> one already-selected cut; a participant's phase    *)
(*                       is derived from `transcript` and `committed`.      *)
(*   cutDigest        -> cutDigest[p].                                      *)
(*   provisional      -> provisional[p][q].                                 *)
(*   ready            -> Ready(p), derived from transcript[p].              *)
(*   committedDigest  -> committed[p].                                      *)
(*   network          -> network[p][q].                                     *)
(*   authority        -> the AUTHORITY constant: one effective authority    *)
(*                       per run (coordinator or adopted acting fallback).  *)
(*                       The fallback transition is CoordinatorFailover.tla.*)
(*   localVerified    -> localDigest[p], the digest of independently        *)
(*                       verified local history; the model does not         *)
(*                       re-verify frames.                                  *)
(*   MarkReady        -> local lock + count self.                           *)
(*   DeliverReady     -> LockDigest for an authority (or buggy) Ready.      *)
(*   Certify/Accept   -> the coordinator's commit and a participant's       *)
(*                       certificate application.                           *)
(*                                                                         *)
(* FAITHFUL ABSTRACTION                                                    *)
(*   - One operation, one cut, already selected by the barrier. The #529   *)
(*     window is exactly `cut known, digest unknown`; prepare/backfill and *)
(*     cut selection are `CoordinatedPeerDrop.tla`.                        *)
(*   - Three participants. `AUTHORITY` is the effective authority identity *)
(*     for the whole run; the coordinator -> acting-fallback transition is *)
(*     `CoordinatorFailover.tla`.                                          *)
(*   - `localDigest[p]` is the digest of the history p independently       *)
(*     installed at the cut. Digests are not derived from frame contents;  *)
(*     the model only distinguishes "same history" from "different".       *)
(*   - Conflicts fail closed differently by sender: an authority conflict  *)
(*     aborts the attempt, while a non-authority artifact is discarded and  *)
(*     the attempt continues. Neither has a successor state here, so the    *)
(*     action is disabled. An aborted attempt cannot commit, and a          *)
(*     discarded artifact changes no lock or count, so omitting both        *)
(*     cannot hide a commit bug.                                           *)
(*   - Reports are not relayed: one Ready per ordered sender/receiver pair. *)
(*   - `ready` is derived from `transcript`, so a peer can never be both   *)
(*     counted and provisional.                                            *)
(*                                                                         *)
(* FIX_MODE                                                                 *)
(*   "AuthorityLocked"   - the #530 rule (DEFAULT; PASSES).                *)
(*   "ProvisionalCounts" - the pre-#530 rule: the first delivered Ready,   *)
(*                         from any participant, locks the digest and      *)
(*                         counts. DEMO-FAIL: LockedDigestAuthorized.      *)
(*                                                                         *)
(* PROPERTIES (FIX_MODE = "AuthorityLocked")                               *)
(*   - AtMostOneCommittedDigest: every applied commit carries one digest.  *)
(*   - CommittedHistoriesAgree: the counted quorum of a committer all      *)
(*     voted for the committed digest.                                     *)
(*   - ProvisionalNeverCounts: a counted peer's transcript equals the      *)
(*     receiver's locked digest, so a mismatching provisional never        *)
(*     counts.                                                             *)
(*   - LockedDigestAuthorized: a lock is the receiver's own local digest   *)
(*     or the authority's local digest, never a third party's.             *)
(*   - ReadyAfterLock: a counted Ready implies a locked digest.            *)
(*   - ProvisionalNotCounted: a peer is never both provisional and counted.*)
(*   - CountedReadyMatchesLock (named ProvisionalNeverCounts for #573): a  *)
(*     counted transcript equals the receiver's lock, so counting a         *)
(*     mismatching Ready is impossible. The pre-lock half of "a provisional *)
(*     never counts" is structural (only the admission rule writes          *)
(*     `transcript`) and is pinned by `ProvisionalNotCounted`.              *)
(*   - WitnessGoal (witness cfg, deliberately falsifiable): a promotion,   *)
(*     a discard, an authority commit, and a participant accept are all    *)
(*     reachable.                                                          *)
(*                                                                         *)
(* No state constraints are used: every invariant above is checked over    *)
(* the unpruned reachable graph.                                           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    PARTICIPANTS,   \* Participant identities.
    AUTHORITY,      \* Effective authority identity.
    FIX_MODE        \* "AuthorityLocked" | "ProvisionalCounts".

ASSUME PARTICIPANTS = {0, 1, 2}
ASSUME AUTHORITY \in PARTICIPANTS
ASSUME FIX_MODE \in {"AuthorityLocked", "ProvisionalCounts"}

Digest == {0, 1}
NONE == 2                       \* No digest; outside `Digest`.
Digests == Digest \union {NONE}
Tags == {"promoted", "discarded", "committed", "accepted"}

Quorum == (Cardinality(PARTICIPANTS) \div 2) + 1

VARIABLES
    localDigest,   \* localDigest[p]: digest of p's installed history.
    cutDigest,     \* cutDigest[p]: digest p requires before counting a Ready.
    provisional,   \* provisional[p][q]: q's uncounted Ready digest held by p.
    transcript,    \* transcript[p][q]: q's counted Ready digest held by p.
    committed,     \* committed[p]: the digest p applied at the cut.
    network,       \* network[p][q]: in-flight Ready digest from p to q.
    witness        \* Monotone reachability tags.

vars == <<localDigest, cutDigest, provisional, transcript, committed, network,
          witness>>

Ready(p) == {q \in PARTICIPANTS : transcript[p][q] # NONE}

Init ==
    /\ \E f \in [PARTICIPANTS -> Digest]:
         \* WLOG the authority names the good history; every other peer is
         \* either converged (0) or divergent (1).
         /\ f[AUTHORITY] = 0
         /\ localDigest = f
    /\ cutDigest = [p \in PARTICIPANTS |-> NONE]
    /\ provisional = [p \in PARTICIPANTS |-> [q \in PARTICIPANTS |-> NONE]]
    /\ transcript = [p \in PARTICIPANTS |-> [q \in PARTICIPANTS |-> NONE]]
    /\ committed = [p \in PARTICIPANTS |-> NONE]
    /\ network = [p \in PARTICIPANTS |-> [q \in PARTICIPANTS |-> NONE]]
    /\ witness = {}

(***************************************************************************)
(* Independently installed local history is an authoritative digest source *)
(* (`coordinated_drop_mark_ready`): it locks the receiver's own digest and  *)
(* counts the local participant. A lock that already disagrees with the     *)
(* local digest is a genuine conflict, so production aborts; the action is  *)
(* disabled here.                                                          *)
(***************************************************************************)
MarkReady(p) ==
    /\ transcript[p][p] = NONE
    /\ (cutDigest[p] = NONE \/ cutDigest[p] = localDigest[p])
    /\ cutDigest' = [cutDigest EXCEPT ![p] = localDigest[p]]
    /\ transcript' = [transcript EXCEPT ![p][p] = localDigest[p]]
    /\ UNCHANGED <<localDigest, provisional, committed, network, witness>>

SendReady(p, q) ==
    /\ p # q
    /\ transcript[p][p] # NONE
    /\ network[p][q] = NONE
    /\ network' = [network EXCEPT ![p][q] = transcript[p][p]]
    /\ UNCHANGED <<localDigest, cutDigest, provisional, transcript, committed,
                   witness>>

(***************************************************************************)
(* Admitting a delivered Ready. AuthorityLocked is the #530 rule: only the *)
(* effective authority locks and counts; every other Ready is provisional   *)
(* until the digest is locked, then counted only if it matches and          *)
(* discarded if it does not. ProvisionalCounts is the pre-#530 rule: the    *)
(* first delivered Ready locks and counts regardless of sender.            *)
(***************************************************************************)
DeliverReady(p, q) ==
    /\ p # q
    /\ network[p][q] # NONE
    /\ LET d == network[p][q]
       IN
       \/ /\ (FIX_MODE = "ProvisionalCounts" \/ p = AUTHORITY)
          /\ \/ /\ cutDigest[q] = NONE
                /\ cutDigest' = [cutDigest EXCEPT ![q] = d]
                /\ transcript' = [transcript EXCEPT ![q][p] = d]
                /\ UNCHANGED provisional
             \/ /\ cutDigest[q] = d
                /\ transcript' = [transcript EXCEPT ![q][p] = d]
                /\ UNCHANGED <<cutDigest, provisional>>
       \/ /\ FIX_MODE = "AuthorityLocked"
          /\ p # AUTHORITY
          /\ \/ /\ cutDigest[q] = NONE
                \* A repeat that disagrees with the held provisional is a peer
                \* artifact: production discards it and keeps state, so the
                \* action is disabled here (no lock or count changes).
                /\ (provisional[q][p] = NONE \/ provisional[q][p] = d)
                /\ provisional' = [provisional EXCEPT ![q][p] = d]
                /\ UNCHANGED <<cutDigest, transcript>>
             \/ /\ cutDigest[q] = d
                /\ transcript' = [transcript EXCEPT ![q][p] = d]
                /\ provisional' = [provisional EXCEPT ![q][p] = NONE]
                /\ UNCHANGED cutDigest
             \/ /\ cutDigest[q] # NONE
                /\ cutDigest[q] # d
                /\ provisional' = [provisional EXCEPT ![q][p] = NONE]
                /\ UNCHANGED <<cutDigest, transcript>>
    /\ network' = [network EXCEPT ![p][q] = NONE]
    /\ UNCHANGED <<localDigest, committed, witness>>

(***************************************************************************)
(* `coordinated_drop_promote_provisional_ready`: once the digest is        *)
(* locked, a matching provisional transcript counts and a mismatching one  *)
(* is dropped as a peer artifact. Modelled as separate steps; production   *)
(* promotes synchronously inside the lock action, and delaying a promotion *)
(* can only reduce the counted set, never add a vote.                      *)
(***************************************************************************)
PromoteProvisional(q, r) ==
    /\ q # r
    /\ cutDigest[q] # NONE
    /\ provisional[q][r] = cutDigest[q]
    /\ transcript' = [transcript EXCEPT ![q][r] = provisional[q][r]]
    /\ provisional' = [provisional EXCEPT ![q][r] = NONE]
    /\ witness' = witness \union {"promoted"}
    /\ UNCHANGED <<localDigest, cutDigest, committed, network>>

DiscardMismatchedProvisional(q, r) ==
    /\ q # r
    /\ cutDigest[q] # NONE
    /\ provisional[q][r] # NONE
    /\ provisional[q][r] # cutDigest[q]
    /\ provisional' = [provisional EXCEPT ![q][r] = NONE]
    /\ witness' = witness \union {"discarded"}
    /\ UNCHANGED <<localDigest, cutDigest, transcript, committed, network>>

(***************************************************************************)
(* The effective coordinator builds the certificate (`drive_coordinated_   *)
(* `drop`); `Certify` is its local apply and `Accept` is a participant      *)
(* applying the received certificate. `apply_commit` requires an exact      *)
(* digest match and a local ready quorum. Commits are single-source, which  *)
(* is why the model cannot reach two divergent commits; production adds the *)
(* strict-majority quorum contract on the certificate.                     *)
(***************************************************************************)
Certify ==
    /\ committed[AUTHORITY] = NONE
    /\ cutDigest[AUTHORITY] # NONE
    /\ transcript[AUTHORITY][AUTHORITY] # NONE
    /\ Cardinality(Ready(AUTHORITY)) >= Quorum
    /\ committed' = [committed EXCEPT ![AUTHORITY] = cutDigest[AUTHORITY]]
    /\ witness' = witness \union {"committed"}
    /\ UNCHANGED <<localDigest, cutDigest, provisional, transcript, network>>

Accept(p) ==
    /\ p # AUTHORITY
    /\ committed[p] = NONE
    /\ committed[AUTHORITY] # NONE
    /\ cutDigest[p] = committed[AUTHORITY]
    /\ transcript[p][p] # NONE
    /\ Cardinality(Ready(p)) >= Quorum
    /\ committed' = [committed EXCEPT ![p] = committed[AUTHORITY]]
    /\ witness' = witness \union {"accepted"}
    /\ UNCHANGED <<localDigest, cutDigest, provisional, transcript, network>>

Next ==
    \/ \E p \in PARTICIPANTS: MarkReady(p)
    \/ \E p, q \in PARTICIPANTS: SendReady(p, q)
    \/ \E p, q \in PARTICIPANTS: DeliverReady(p, q)
    \/ \E q, r \in PARTICIPANTS: PromoteProvisional(q, r)
    \/ \E q, r \in PARTICIPANTS: DiscardMismatchedProvisional(q, r)
    \/ Certify
    \/ \E p \in PARTICIPANTS: Accept(p)

Spec == Init /\ [][Next]_vars

TypeInvariant ==
    /\ localDigest \in [PARTICIPANTS -> Digest]
    /\ cutDigest \in [PARTICIPANTS -> Digests]
    /\ provisional \in [PARTICIPANTS -> [PARTICIPANTS -> Digests]]
    /\ transcript \in [PARTICIPANTS -> [PARTICIPANTS -> Digests]]
    /\ committed \in [PARTICIPANTS -> Digests]
    /\ network \in [PARTICIPANTS -> [PARTICIPANTS -> Digests]]
    /\ witness \subseteq Tags

ReadyAfterLock ==
    \A p \in PARTICIPANTS:
        \A r \in Ready(p): cutDigest[p] # NONE

ProvisionalNotCounted ==
    \A p, r \in PARTICIPANTS:
        provisional[p][r] # NONE => r \notin Ready(p)

AtMostOneCommittedDigest ==
    \A p, q \in PARTICIPANTS:
        committed[p] # NONE /\ committed[q] # NONE => committed[p] = committed[q]

CommittedHistoriesAgree ==
    \A p \in PARTICIPANTS:
        committed[p] # NONE =>
            \A r \in Ready(p): transcript[p][r] = committed[p]

\* Count-consistency half of "a provisional Ready never counts" (#573):
\* every counted transcript equals the receiver's lock. The pre-lock half is
\* structural (DeliverReady is the only writer of `transcript`) and is pinned
\* by `ProvisionalNotCounted`.
ProvisionalNeverCounts ==
    \A p \in PARTICIPANTS:
        \A r \in Ready(p): r # p => transcript[p][r] = cutDigest[p]

LockedDigestAuthorized ==
    \A p \in PARTICIPANTS:
        cutDigest[p] # NONE =>
            cutDigest[p] = localDigest[p] \/ cutDigest[p] = localDigest[AUTHORITY]

WitnessGoal == witness # Tags
===============================================================================

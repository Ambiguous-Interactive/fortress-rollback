------------------------- MODULE ChecksumBasis -------------------------
(***************************************************************************)
(* Converged checksum-basis token for one frozen slot (protocol v6).      *)
(*                                                                         *)
(* The token is the additive sum of one term per frozen slot boundary at   *)
(* or below the frame. Survivors that reach the same frozen history        *)
(* through different intermediate detection floors must derive the same    *)
(* token, or their checksum reports stay incomparable forever (the #562    *)
(* false negative). A report from a different basis is discarded, never    *)
(* latched, and a confirmed-history rewrite clears latches and pending     *)
(* reports at or above its floor (#532).                                   *)
(*                                                                         *)
(* FAITHFUL ABSTRACTION                                                    *)
(*   - One frozen slot; the token's per-slot term is represented by its   *)
(*     boundary value. Two peers with the same converged boundary derive   *)
(*     the same token.                                                     *)
(*   - Two peers, one history. PRE values differ before the boundary;      *)
(*     CONVERGED values are shared above it. A real divergence overwrites  *)
(*     a frame with BAD.                                                   *)
(*   - The old #562 additive multiset is the `BasisBlind` mode: every      *)
(*     recorded boundary (even one later superseded) contributes a term.  *)
(*   - Checksums are concrete integers, not hashes; the 64-bit collision   *)
(*     bound is documented on ChecksumReport::basis_token and is not      *)
(*     modeled.                                                            *)
(*                                                                         *)
(* FIX_MODE                                                                 *)
(*   "Basis"      - the v6 per-slot converged token gate (DEFAULT; PASSES).*)
(*   "BasisBlind" - the pre-#563 additive multiset: every recorded boundary *)
(*                  contributes, so converged survivors can keep different *)
(*                  tokens. DEMO-FAIL: NoPermanentFalseNegative violated.   *)
(*                                                                         *)
(* PROPERTIES (FIX_MODE = "Basis")                                        *)
(*   - NoPermanentFalseNegative: peers frozen at the same boundary derive  *)
(*     the same token at every frame at or above it.                       *)
(*   - NoFalseLatchAcrossBasis: every latched mismatch was compared on the *)
(*     same token.                                                         *)
(*   - LatchClearedAtRewrite: every latched pair carries the current       *)
(*     rewrite epoch of its frame, so a boundary change at or above it     *)
(*     retires the pair.                                                   *)
(*   - WitnessGoal (witness cfg, deliberately falsifiable): a latch, a    *)
(*     discard, and an actual rewrite clear are all reachable.             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    PEERS,        \* Two participant identities.
    MAX_FRAME,    \* Highest frame value in the bounded model.
    FIX_MODE      \* "Basis" | "BasisBlind".

ASSUME PEERS = {0, 1}
ASSUME MAX_FRAME \in Nat /\ MAX_FRAME >= 1
ASSUME FIX_MODE \in {"Basis", "BasisBlind"}

Frame == 0 .. MAX_FRAME
NONE == MAX_FRAME + 1  \* sentinel outside the frame interval
Boundary == Frame \union {NONE}
Tags == {"latched", "cleared", "discarded"}

Report == [frame: Frame, checksum: Nat, token: Nat, present: BOOLEAN]
NoReport == [frame |-> 0, checksum |-> 0, token |-> 0, present |-> FALSE]
Latch == [frame: Frame, token: Nat, epoch: Nat]

Converged(f) == 100 + f
Pre(p, f) == 10 * f + p + 1
Bad(f) == 200 + f

VARIABLES
    freeze,     \* freeze[p] = converged boundary or NONE
    terms,      \* terms[p] = every boundary recorded by p (BasisBlind)
    history,    \* history[p][f] = p's checksum for frame f
    network,    \* network[p][q] = in-flight report from p to q
    pending,    \* pending[q][p] = delivered report from p held by q
    latched,    \* latched[q][p] = set of latched mismatches against p
    epoch,      \* epoch[q][f] = q's rewrite generation for frame f
    witness     \* monotone witness tags (reachability config)

vars == <<freeze, terms, history, network, pending, latched, epoch,
          witness>>

Init ==
    /\ freeze = [p \in PEERS |-> NONE]
    /\ terms = [p \in PEERS |-> {}]
    /\ history = [p \in PEERS |-> [f \in Frame |-> Pre(p, f)]]
    /\ network = [p \in PEERS |-> [q \in PEERS |-> NoReport]]
    /\ pending = [p \in PEERS |-> [q \in PEERS |-> NoReport]]
    /\ latched = [p \in PEERS |-> [q \in PEERS |-> {}]]
    /\ epoch = [p \in PEERS |-> [f \in Frame |-> 0]]
    /\ witness = {}

(***************************************************************************)
(* The v6 token: one term for the slot's converged boundary, or the old    *)
(* additive multiset in BasisBlind (Cardinality stands in for the sum).    *)
(***************************************************************************)
Token(p, f) ==
    IF FIX_MODE = "Basis"
    THEN IF freeze[p] = NONE \/ f < freeze[p] THEN 0 ELSE 1000 + freeze[p]
    ELSE 1000 * Cardinality(terms[p])

FreezeHistory(p, b) ==
    [f \in Frame |-> IF f >= b THEN Converged(f) ELSE history[p][f]]

(***************************************************************************)
(* A boundary change is a confirmed-history rewrite: it bumps the rewrite  *)
(* generation and retires every latch/pending report at or above the new   *)
(* floor. The token below the floor is unchanged.                          *)
(***************************************************************************)
BumpEpoch(p, r) ==
    [epoch EXCEPT
        ![p] = [f \in Frame |-> IF f >= r THEN epoch[p][f] + 1
                                 ELSE epoch[p][f]]]

ClearLatches(p, r) ==
    [latched EXCEPT
        ![p] = [q \in PEERS |-> {pair \in latched[p][q]: pair.frame < r}]]

ClearPending(p, r) ==
    [pending EXCEPT
        ![p] = [q \in PEERS |-> IF pending[p][q].present
                                   /\ pending[p][q].frame >= r
                                THEN NoReport
                                ELSE pending[p][q]]]

ClearedAt(p, r) ==
    \E q \in PEERS: \E pair \in latched[p][q]: pair.frame >= r

Freeze(p) ==
    /\ freeze[p] = NONE
    /\ \E b \in Frame:
        /\ freeze' = [freeze EXCEPT ![p] = b]
        /\ terms' = [terms EXCEPT ![p] = terms[p] \union {b}]
        /\ history' = [history EXCEPT ![p] = FreezeHistory(p, b)]
        /\ epoch' = BumpEpoch(p, b)
        /\ latched' = ClearLatches(p, b)
        /\ pending' = ClearPending(p, b)
        /\ witness' = IF ClearedAt(p, b) THEN witness \union {"cleared"}
                        ELSE witness
        /\ UNCHANGED <<network>>

LowerFreeze(p) ==
    /\ freeze[p] # NONE
    /\ \E b \in Frame:
        /\ b < freeze[p]
        /\ freeze' = [freeze EXCEPT ![p] = b]
        /\ terms' = [terms EXCEPT ![p] = terms[p] \union {b}]
        /\ history' = [history EXCEPT ![p] = FreezeHistory(p, b)]
        /\ epoch' = BumpEpoch(p, b)
        /\ latched' = ClearLatches(p, b)
        /\ pending' = ClearPending(p, b)
        /\ witness' = IF ClearedAt(p, b) THEN witness \union {"cleared"}
                        ELSE witness
        /\ UNCHANGED <<network>>

Diverge(p) ==
    /\ freeze[p] # NONE
    /\ \E f \in Frame:
        /\ f >= freeze[p]
        /\ history' = [history EXCEPT ![p][f] = Bad(f)]
        /\ UNCHANGED <<freeze, terms, network, pending, latched, epoch,
                       witness>>

SendReport(p, q) ==
    /\ p # q
    /\ network[p][q].present = FALSE
    /\ \E f \in Frame:
        /\ network' = [network EXCEPT
                          ![p][q] = [frame |-> f,
                                     checksum |-> history[p][f],
                                     token |-> Token(p, f),
                                     present |-> TRUE]]
        /\ UNCHANGED <<freeze, terms, history, pending, latched, epoch,
                       witness>>

DeliverReport(p, q) ==
    /\ p # q
    /\ network[p][q].present
    /\ pending' = [pending EXCEPT ![q][p] = network[p][q]]
    /\ network' = [network EXCEPT ![p][q] = NoReport]
    /\ UNCHANGED <<freeze, terms, history, latched, epoch, witness>>

(***************************************************************************)
(* q compares p's delivered report. Basis mode admits it only on an equal  *)
(* token; a same-token checksum mismatch latches with q's current epoch.   *)
(* A different token is discarded. BasisBlind admits every report.         *)
(***************************************************************************)
Compare(q, p) ==
    /\ pending[q][p].present
    /\ LET rep == pending[q][p]
       IN
       \/ /\ (FIX_MODE = "BasisBlind" \/ rep.token = Token(q, rep.frame))
          /\ \/ /\ rep.checksum # history[q][rep.frame]
                /\ latched' = [latched EXCEPT
                                  ![q][p] = latched[q][p] \union
                                      {[frame |-> rep.frame,
                                        token |-> rep.token,
                                        epoch |-> epoch[q][rep.frame]]}]
                /\ witness' = witness \union {"latched"}
             \/ /\ rep.checksum = history[q][rep.frame]
                /\ latched' = latched
                /\ witness' = witness
          /\ pending' = [pending EXCEPT ![q][p] = NoReport]
          /\ UNCHANGED <<freeze, terms, history, network, epoch>>
       \/ /\ FIX_MODE = "Basis"
          /\ rep.token # Token(q, rep.frame)
          /\ pending' = [pending EXCEPT ![q][p] = NoReport]
          /\ witness' = witness \union {"discarded"}
          /\ UNCHANGED <<freeze, terms, history, network, latched, epoch>>

Next ==
    \E p, q \in PEERS:
        \/ Freeze(p)
        \/ LowerFreeze(p)
        \/ Diverge(p)
        \/ SendReport(p, q)
        \/ DeliverReport(p, q)
        \/ Compare(q, p)

Spec == Init /\ [][Next]_vars

TypeInvariant ==
    /\ freeze \in [PEERS -> Boundary]
    /\ terms \in [PEERS -> SUBSET Frame]
    /\ history \in [PEERS -> [Frame -> Nat]]
    /\ network \in [PEERS -> [PEERS -> Report]]
    /\ pending \in [PEERS -> [PEERS -> Report]]
    /\ latched \in [PEERS -> [PEERS -> SUBSET Latch]]
    /\ epoch \in [PEERS -> [Frame -> Nat]]
    /\ witness \subseteq Tags

ReportBound ==
    \A p, q \in PEERS:
        (IF network[p][q].present THEN 1 ELSE 0)
      + (IF pending[p][q].present THEN 1 ELSE 0) <= 1

LatchBound ==
    \A p, q \in PEERS: Cardinality(latched[p][q]) <= 1

EpochBound ==
    \A p \in PEERS: \A f \in Frame: epoch[p][f] <= 1

NoPermanentFalseNegative ==
    \A p, q \in PEERS:
        \A f \in Frame:
            (freeze[p] # NONE /\ freeze[p] = freeze[q] /\ f >= freeze[p])
                => Token(p, f) = Token(q, f)

NoFalseLatchAcrossBasis ==
    \A q, p \in PEERS:
        \A pair \in latched[q][p]:
            pair.token = Token(q, pair.frame)

LatchClearedAtRewrite ==
    \A q, p \in PEERS:
        \A pair \in latched[q][p]:
            pair.epoch = epoch[q][pair.frame]

WitnessGoal == witness # Tags
=======================================================================

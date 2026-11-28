------------------------ MODULE CoordinatedDropTrace ------------------------
(***************************************************************************)
(* Executable trace contract for the coordinated-drop refinement boundary. *)
(*                                                                         *)
(* Trace rows are produced by the opt-in `trace-validation` recorder on a  *)
(* deterministic three-peer SimNet run. Each row fixes the complete        *)
(* CoordinatedReadyDigest state plus the trace-only barrier boundary:       *)
(* phase, selected cut, installed backfill count, and frozen targets.       *)
(*                                                                         *)
(* Ready and commit rows reuse the real CoordinatedReadyDigest actions:     *)
(* MarkReady, SendReady, DeliverReady, PromoteProvisional,                 *)
(* DiscardMismatchedProvisional, Certify, and Accept. Prepare, inventory,   *)
(* backfill, and freeze are boundary events: they constrain ordering and    *)
(* the trace-only variables but leave the digest-gate state unchanged.      *)
(* Cut selection and backfill content remain CoordinatedPeerDrop.tla       *)
(* obligations; this module checks the #529/#530 digest gate and the        *)
(* commit/freeze boundary around one operation.                            *)
(***************************************************************************)

EXTENDS CoordinatedReadyDigest, Sequences

CONSTANT TRACE
CONSTANT MAX_CUT
CONSTANT MAX_BACKFILL

VARIABLES
    traceIndex,
    dropPhase,
    traceCut,
    backfilled,
    frozen

Phases == {"None", "Inventory", "Backfill", "Ready", "Committed"}
FrozenTargets == 0..3

traceVars == <<
    localDigest, cutDigest, provisional, transcript, committed, network,
    witness, traceIndex, dropPhase, traceCut, backfilled, frozen
>>

TraceStateMatches(row) ==
    /\ localDigest = row.state.localDigest
    /\ cutDigest = row.state.cutDigest
    /\ provisional = row.state.provisional
    /\ transcript = row.state.transcript
    /\ committed = row.state.committed
    /\ network = row.state.network
    /\ dropPhase = row.state.dropPhase
    /\ traceCut = row.state.traceCut
    /\ backfilled = row.state.backfilled
    /\ frozen = row.state.frozen

TraceUpdateMatches(row) ==
    /\ localDigest' = row.state.localDigest
    /\ cutDigest' = row.state.cutDigest
    /\ provisional' = row.state.provisional
    /\ transcript' = row.state.transcript
    /\ committed' = row.state.committed
    /\ network' = row.state.network

TraceOnlyUpdateMatches(row) ==
    /\ dropPhase' = row.state.dropPhase
    /\ traceCut' = row.state.traceCut
    /\ backfilled' = row.state.backfilled
    /\ frozen' = row.state.frozen

Boundary ==
    UNCHANGED <<localDigest, cutDigest, provisional, transcript, committed,
                 network, witness>>

FreezeTarget(p) ==
    /\ committed[p] # NONE
    /\ UNCHANGED <<localDigest, cutDigest, provisional, transcript, committed,
                     network, witness>>

TraceAction(row) ==
    CASE row.action = "PrepareAdmitted" -> Boundary
      [] row.action = "PrepareRejected" -> Boundary
      [] row.action = "PhaseChanged" -> Boundary
      [] row.action = "CutSelected" -> Boundary
      [] row.action = "DigestLocked" -> Boundary
      [] row.action = "BackfillInstalled" -> Boundary
      [] row.action = "TargetFrozen" -> FreezeTarget(row.peer)
      [] row.action = "AttemptCleared" -> Boundary
      [] row.action = "SendReady" -> SendReady(row.peer, row.to)
      [] row.action = "MarkReady" -> MarkReady(row.peer)
      [] row.action = "DeliverReady" -> DeliverReady(row.peer, row.to)
      [] row.action = "PromoteProvisional" ->
            PromoteProvisional(row.peer, row.from)
      [] row.action = "DiscardMismatchedProvisional" ->
            DiscardMismatchedProvisional(row.peer, row.from)
      [] row.action = "Certify" -> Certify
      [] row.action = "Accept" -> Accept(row.peer)
      [] OTHER -> FALSE

TraceInit ==
    /\ Len(TRACE) > 0
    /\ TRACE[1].action = "Init"
    /\ Init
    /\ TraceStateMatches(TRACE[1])
    /\ traceIndex = 1

TraceStep ==
    /\ traceIndex < Len(TRACE)
    /\ LET row == TRACE[traceIndex + 1] IN
       /\ TraceAction(row)
       /\ TraceUpdateMatches(row)
       /\ TraceOnlyUpdateMatches(row)
    /\ traceIndex' = traceIndex + 1

TraceDone ==
    /\ traceIndex = Len(TRACE)
    /\ UNCHANGED traceVars

TraceNext == TraceStep \/ TraceDone

TraceSpec ==
    /\ TraceInit
    /\ [][TraceNext]_traceVars
    /\ WF_traceVars(TraceStep)

TraceTypeInvariant ==
    /\ traceIndex \in 1..Len(TRACE)
    /\ dropPhase \in Phases
    /\ traceCut \in 0..MAX_CUT
    /\ backfilled \in 0..MAX_BACKFILL
    /\ frozen \subseteq FrozenTargets

EventuallyTraceConsumed == <> (traceIndex = Len(TRACE))

=============================================================================

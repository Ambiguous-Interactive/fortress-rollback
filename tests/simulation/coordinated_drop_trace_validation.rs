//! Runtime-to-TLA+ coordinated-drop trace producer over deterministic channels.

use crate::common::stubs::{GameStub, StubConfig, StubInput};
use crate::common::{create_channel_quad, TestClock, POLL_INTERVAL_DETERMINISTIC};
use fortress_rollback::__internal::{
    CoordinatedDropTraceAction, CoordinatedDropTraceEvent, CoordinatedDropTracePhase,
};
use fortress_rollback::{
    DisconnectBehavior, FortressError, P2PSession, PlayerHandle, PlayerType, ProtocolConfig,
    SessionBuilder, SessionState,
};
use web_time::Duration;

const TRACE_CAPACITY: usize = 64;
const NUM_PLAYERS: usize = 4;
const TARGET: usize = 3;

struct Sessions {
    sessions: [P2PSession<StubConfig>; NUM_PLAYERS],
    clock: TestClock,
}

fn peer_addr(handles: &[std::net::SocketAddr; NUM_PLAYERS], handle: usize) -> std::net::SocketAddr {
    handles[handle]
}

fn build_sessions() -> Result<Sessions, FortressError> {
    let clock = TestClock::new();
    let (s1, s2, s3, s4, a1, a2, a3, a4) = create_channel_quad();
    let sockets = [s1, s2, s3, s4];
    let addresses = [a1, a2, a3, a4];
    let protocol_config = ProtocolConfig {
        clock: Some(clock.as_protocol_clock()),
        ..ProtocolConfig::default()
    };
    let mut built = Vec::new();
    for (local, socket) in sockets.into_iter().enumerate() {
        let mut builder = SessionBuilder::<StubConfig>::new()
            .with_protocol_config(protocol_config.clone())
            .with_num_players(NUM_PLAYERS)?
            .with_disconnect_behavior(DisconnectBehavior::ContinueWithout)
            .with_coordinated_drop_trace_capacity(TRACE_CAPACITY)?;
        for handle in 0..NUM_PLAYERS {
            let player_type = if handle == local {
                PlayerType::Local
            } else {
                PlayerType::Remote(peer_addr(&addresses, handle))
            };
            builder = builder.add_player(player_type, PlayerHandle::new(handle))?;
        }
        built.push(builder.start_p2p_session(socket)?);
    }
    let sessions: [P2PSession<StubConfig>; NUM_PLAYERS] =
        built
            .try_into()
            .map_err(|_value: Vec<P2PSession<StubConfig>>| {
                FortressError::InternalErrorStructured {
                    kind: fortress_rollback::InternalErrorKind::Custom(
                        "trace producer built the wrong session count",
                    ),
                }
            })?;
    Ok(Sessions { sessions, clock })
}

fn synchronize(sessions: &mut Sessions) {
    for _ in 0..400 {
        for session in &mut sessions.sessions {
            session.poll_remote_clients();
        }
        if sessions
            .sessions
            .iter()
            .all(|session| session.current_state() == SessionState::Running)
        {
            for session in &mut sessions.sessions {
                let _ = session.events().collect::<Vec<_>>();
            }
            return;
        }
        sessions.clock.advance(POLL_INTERVAL_DETERMINISTIC);
    }
    panic!("four sessions failed to synchronize");
}

fn poll_all(sessions: &mut Sessions, iterations: usize) {
    for _ in 0..iterations {
        for session in &mut sessions.sessions {
            session.poll_remote_clients();
        }
        sessions.clock.advance(POLL_INTERVAL_DETERMINISTIC);
    }
}

fn advance(
    session: &mut P2PSession<StubConfig>,
    stub: &mut GameStub,
    handle: PlayerHandle,
    value: u32,
) -> Result<(), FortressError> {
    session.add_local_input(handle, StubInput { inp: value })?;
    let requests = session.advance_frame()?;
    stub.handle_requests(requests);
    Ok(())
}

fn collect(session: &P2PSession<StubConfig>) -> Vec<CoordinatedDropTraceEvent> {
    session
        .coordinated_drop_trace()
        .expect("trace recorder was enabled")
        .expect("trace recorder did not overflow")
        .to_vec()
}

#[derive(Clone, Copy, Debug)]
struct OrderedEvent {
    session: usize,
    event: CoordinatedDropTraceEvent,
}

fn collect_new(
    sessions: &Sessions,
    cursors: &mut [usize; NUM_PLAYERS],
    ordered: &mut Vec<OrderedEvent>,
) {
    for (session_index, (session, cursor)) in
        sessions.sessions.iter().zip(cursors.iter_mut()).enumerate()
    {
        let trace = session
            .coordinated_drop_trace()
            .expect("trace recorder was enabled")
            .expect("trace recorder did not overflow");
        assert!(*cursor <= trace.len(), "trace cursor must remain monotonic");
        ordered.extend(trace[*cursor..].iter().copied().map(|event| OrderedEvent {
            session: session_index,
            event,
        }));
        *cursor = trace.len();
    }
}

#[test]
fn export_runtime_coordinated_drop_traces_for_tlc() {
    let mut sessions = build_sessions().expect("four-player sessions build");
    synchronize(&mut sessions);
    let mut stubs: [GameStub; NUM_PLAYERS] = std::array::from_fn(|_| GameStub::new());
    let mut cursors = [0_usize; NUM_PLAYERS];
    let mut ordered = Vec::new();
    collect_new(&sessions, &mut cursors, &mut ordered);

    for value in 0..4_u32 {
        poll_all(&mut sessions, 3);
        collect_new(&sessions, &mut cursors, &mut ordered);
        for handle in 0..NUM_PLAYERS {
            advance(
                &mut sessions.sessions[handle],
                &mut stubs[handle],
                PlayerHandle::new(handle),
                value + u32::try_from(handle).unwrap_or(0) * 100,
            )
            .expect("peer advances");
        }
    }
    poll_all(&mut sessions, 6);
    collect_new(&sessions, &mut cursors, &mut ordered);

    // Three survivors request the same target removal. The target stops
    // advancing so the barrier can commit without its participation.
    for session in sessions.sessions.iter_mut().take(TARGET) {
        session
            .remove_player(PlayerHandle::new(TARGET))
            .expect("survivor removes the target");
    }
    collect_new(&sessions, &mut cursors, &mut ordered);

    let mut dropped = 0_u8;
    for _ in 0..160 {
        for (handle, session) in sessions.sessions.iter_mut().enumerate() {
            session.poll_remote_clients();
            if session
                .events()
                .any(|event| matches!(event, fortress_rollback::FortressEvent::PeerDropped { .. }))
            {
                dropped |= 1 << handle;
            }
        }
        collect_new(&sessions, &mut cursors, &mut ordered);
        sessions.clock.advance(Duration::from_millis(1));
        if dropped == 0b0111 {
            break;
        }
    }
    assert_eq!(dropped, 0b0111, "all survivors must commit the removal");
    collect_new(&sessions, &mut cursors, &mut ordered);

    let traces: [Vec<CoordinatedDropTraceEvent>; TARGET] =
        std::array::from_fn(|handle| collect(&sessions.sessions[handle]));
    for (handle, trace) in traces.iter().enumerate() {
        assert!(
            !trace.is_empty(),
            "survivor {handle} trace must contain events"
        );
        assert!(trace.iter().any(|event| matches!(
            event.action,
            CoordinatedDropTraceAction::PrepareAdmitted { .. }
        )));
        assert!(trace.iter().any(|event| matches!(
            event.action,
            CoordinatedDropTraceAction::DigestLocked { .. }
        )));
        assert!(trace.iter().any(|event| matches!(
            event.action,
            CoordinatedDropTraceAction::CommitApplied { .. }
        )));
        assert!(trace.iter().any(|event| matches!(
            event.action,
            CoordinatedDropTraceAction::TargetFrozen { handle: 3, .. }
        )));
        assert!(trace.iter().any(|event| matches!(
            event.action,
            CoordinatedDropTraceAction::PhaseChanged {
                phase: CoordinatedDropTracePhase::Committed
            }
        )));
    }
    assert!(
        traces.iter().flatten().any(|event| matches!(
            event.action,
            CoordinatedDropTraceAction::ReadyCounted { .. }
        )),
        "at least one participant must count a Ready"
    );

    let Ok(output_dir) = std::env::var("FORTRESS_COORDINATED_DROP_TRACE_DIR") else {
        return;
    };
    let output_dir = std::path::Path::new(&output_dir);
    assert!(output_dir.is_dir(), "trace output directory exists");
    write_trace(&output_dir.join("runtime-drop.ndjson"), &ordered);
}

fn write_trace(path: &std::path::Path, events: &[OrderedEvent]) {
    let mut encoded = String::new();
    encoded.push_str(
        &serde_json::json!({
            "schema": 1,
            "trace": "runtime-drop",
            "expect": "accept",
            "description": "Merged runtime SimNet coordinated drop from three survivors.",
        })
        .to_string(),
    );
    encoded.push('\n');
    for (step, ordered) in events.iter().enumerate() {
        let event = ordered.event;
        encoded.push_str(
            &serde_json::json!({
                "step": step,
                "session": ordered.session,
                "action": trace_action_json(event.action),
                "state": {
                    "active": event.state.active,
                    "phase": event.state.phase.map(trace_phase),
                    "localParticipant": event.state.local_participant,
                    "authority": event.state.authority,
                    "quorum": event.state.quorum,
                    "participantCount": event.state.participant_count,
                    "targetCount": event.state.target_count,
                    "cut": event.state.cut.map(fortress_rollback::Frame::as_i32),
                    "digest": event.state.digest,
                    "counted": event.state.counted.to_vec(),
                    "provisional": event.state.provisional.to_vec(),
                    "committed": event.state.committed,
                    "frozen": event.state.frozen.to_vec(),
                },
            })
            .to_string(),
        );
        encoded.push('\n');
    }
    std::fs::write(path, encoded).expect("coordinated-drop trace is written");
}

fn trace_phase(phase: CoordinatedDropTracePhase) -> &'static str {
    match phase {
        CoordinatedDropTracePhase::Inventory => "Inventory",
        CoordinatedDropTracePhase::Backfill => "Backfill",
        CoordinatedDropTracePhase::Ready => "Ready",
        CoordinatedDropTracePhase::Committed => "Committed",
    }
}

fn trace_action_json(action: CoordinatedDropTraceAction) -> serde_json::Value {
    match action {
        CoordinatedDropTraceAction::Activated => serde_json::json!({"kind": "Activated"}),
        CoordinatedDropTraceAction::PrepareAdmitted {
            operation,
            participants,
            targets,
        } => serde_json::json!({
            "kind": "PrepareAdmitted",
            "operation": trace_operation(operation),
            "participants": participants,
            "targets": targets,
        }),
        CoordinatedDropTraceAction::PrepareRejected { operation, targets } => {
            serde_json::json!({
                "kind": "PrepareRejected",
                "operation": trace_operation(operation),
                "targets": targets,
            })
        },
        CoordinatedDropTraceAction::PhaseChanged { phase } => {
            serde_json::json!({"kind": "PhaseChanged", "phase": trace_phase(phase)})
        },
        CoordinatedDropTraceAction::CutSelected { cut } => {
            serde_json::json!({"kind": "CutSelected", "cut": cut.as_i32()})
        },
        CoordinatedDropTraceAction::DigestLocked { cut, digest } => {
            serde_json::json!({"kind": "DigestLocked", "cut": cut.as_i32(), "digest": digest})
        },
        CoordinatedDropTraceAction::ReadyCounted {
            participant,
            cut,
            digest,
            authority,
        } => serde_json::json!({
            "kind": "ReadyCounted",
            "participant": participant,
            "cut": cut.as_i32(),
            "digest": digest,
            "authority": authority,
        }),
        CoordinatedDropTraceAction::ReadyProvisional {
            participant,
            cut,
            digest,
        } => serde_json::json!({
            "kind": "ReadyProvisional",
            "participant": participant,
            "cut": cut.as_i32(),
            "digest": digest,
        }),
        CoordinatedDropTraceAction::ReadyDiscarded { participant } => {
            serde_json::json!({"kind": "ReadyDiscarded", "participant": participant})
        },
        CoordinatedDropTraceAction::BackfillInstalled { installed } => {
            serde_json::json!({"kind": "BackfillInstalled", "installed": installed})
        },
        CoordinatedDropTraceAction::CommitApplied { cut, digest } => {
            serde_json::json!({"kind": "CommitApplied", "cut": cut.as_i32(), "digest": digest})
        },
        CoordinatedDropTraceAction::TargetFrozen { handle, cut } => {
            serde_json::json!({"kind": "TargetFrozen", "handle": handle, "cut": cut.as_i32()})
        },
        CoordinatedDropTraceAction::AttemptCleared => {
            serde_json::json!({"kind": "AttemptCleared"})
        },
    }
}

fn trace_operation(
    operation: fortress_rollback::__internal::CoordinatedDropTraceOperation,
) -> serde_json::Value {
    serde_json::json!({
        "coordinator": operation.coordinator,
        "coordinatorGeneration": operation.coordinator_generation,
        "sequence": operation.sequence,
        "targetSetDigest": operation.target_set_digest,
        "participantSetDigest": operation.participant_set_digest,
        "terminalEpoch": operation.terminal_epoch,
    })
}

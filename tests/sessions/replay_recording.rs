//! Replay recording fidelity across rollback corrections, and the checksum
//! evidence that desync detection consumes.
//!
//! A live session must publish and record its *confirmed* history, not the
//! speculative one. When a remote misprediction is repaired the affected frames
//! are re-simulated, so any checksum captured before the correction requests
//! execute is stale. Two user-visible failures follow from that:
//!
//! - A replay recorded by a correctly-played session reports
//!   [`FortressEvent::ReplayDesync`] on its own decoded playback.
//! - A stale local checksum sent to a peer triggers a false
//!   [`FortressEvent::DesyncDetected`] once the peer's canonical checksum arrives.

// In tests: panic/unwrap/expect/etc. are appropriate.
#![allow(
    clippy::panic,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing
)]

use crate::common::stubs::{GameStub, StubConfig, StubInput};
use crate::common::{
    poll_with_advance, synchronize_sessions_deterministic, BlockedLinks, FilterSocket, SyncConfig,
    TestClock,
};
use fortress_rollback::sessions::replay_session::ReplaySession;
use fortress_rollback::{
    DesyncDetection, FortressError, FortressEvent, FortressRequest, Frame, InvalidRequestKind,
    P2PSession, PlayerHandle, PlayerType, ProtocolConfig, SaveMode, SessionBuilder,
};
use std::net::SocketAddr;

fn protocol_config(clock: &TestClock) -> ProtocolConfig {
    ProtocolConfig {
        clock: Some(clock.as_protocol_clock()),
        ..ProtocolConfig::default()
    }
}

fn drive_lockstep(
    sess1: &mut fortress_rollback::P2PSession<StubConfig>,
    sess2: &mut fortress_rollback::P2PSession<StubConfig>,
    stub1: &mut GameStub,
    stub2: &mut GameStub,
    clock: &TestClock,
    from: u32,
    to: u32,
) -> Result<(), FortressError> {
    for i in from..to {
        sess1.add_local_input(PlayerHandle::new(0), StubInput { inp: 7 * i + 1 })?;
        sess2.add_local_input(PlayerHandle::new(1), StubInput { inp: 13 * i + 2 })?;
        poll_with_advance(sess1, sess2, clock, 3);
        stub1.handle_requests(sess1.advance_frame()?);
        stub2.handle_requests(sess2.advance_frame()?);
        poll_with_advance(sess1, sess2, clock, 2);
    }
    Ok(())
}

/// Plays a recorded replay through a fresh session with checksum validation and
/// returns every frame that reported a replay desync.
fn replay_desync_frames(replay: fortress_rollback::replay::Replay<StubInput>) -> Vec<Frame> {
    let mut session = ReplaySession::<StubConfig>::new_with_validation(replay)
        .expect("recorded replay validates");
    let mut stub = GameStub::new();
    let mut desyncs = Vec::new();

    loop {
        let advanced = match session.advance_frame() {
            Ok(requests) => {
                stub.handle_requests(requests);
                true
            },
            Err(FortressError::InvalidFrameStructured { .. }) => false,
            Err(error) => panic!("unexpected replay error: {error:?}"),
        };
        for event in session.events() {
            if let FortressEvent::ReplayDesync { frame, .. } = event {
                desyncs.push(frame);
            }
        }
        if !advanced {
            break;
        }
    }
    desyncs.sort_unstable();
    desyncs
}

struct BurstRun {
    sess1: fortress_rollback::P2PSession<StubConfig>,
    events: Vec<FortressEvent<StubConfig>>,
}

/// Drives a two-peer session where peer 1's whole input backlog is withheld and
/// then restored at once. Peer 0 therefore predicts a run of peer 1 rows and
/// then repairs them all in a single `advance_frame`, so `confirmed_frame` jumps
/// across the entire wrong suffix while the correction is still only queued as
/// requests.
fn run_correction_burst(
    save_mode: SaveMode,
    recording: bool,
    desync: DesyncDetection,
) -> Result<BurstRun, FortressError> {
    let clock = TestClock::new();
    let (s1, s2, a1, a2, links) = channel_pair();

    let mut sess1 = SessionBuilder::<StubConfig>::new()
        .with_protocol_config(protocol_config(&clock))
        .add_player(PlayerType::Local, PlayerHandle::new(0))?
        .add_player(PlayerType::Remote(a2), PlayerHandle::new(1))?
        .with_input_delay(0)?
        .with_save_mode(save_mode)
        .with_desync_detection_mode(desync)
        .with_recording(recording)
        .start_p2p_session(s1)?;

    let mut sess2 = SessionBuilder::<StubConfig>::new()
        .with_protocol_config(protocol_config(&clock))
        .add_player(PlayerType::Remote(a1), PlayerHandle::new(0))?
        .add_player(PlayerType::Local, PlayerHandle::new(1))?
        .with_input_delay(0)?
        .with_save_mode(save_mode)
        .with_desync_detection_mode(desync)
        .start_p2p_session(s2)?;

    synchronize_sessions_deterministic(&mut sess1, &mut sess2, &clock, &SyncConfig::default())
        .expect("sessions synchronize");

    let mut stub1 = GameStub::new();
    let mut stub2 = GameStub::new();
    let mut events = Vec::new();

    // Agree on a confirmed prefix, then take peer 1's traffic away from the
    // recorder so peer 0 keeps running on predicted rows.
    drive_lockstep(&mut sess1, &mut sess2, &mut stub1, &mut stub2, &clock, 0, 5)?;
    links.block(a2, a1);

    for i in 5..12 {
        sess1.add_local_input(PlayerHandle::new(0), StubInput { inp: 7 * i + 1 })?;
        sess2.add_local_input(PlayerHandle::new(1), StubInput { inp: 13 * i + 2 })?;
        stub1.handle_requests(sess1.advance_frame()?);
        stub2.handle_requests(sess2.advance_frame()?);
        events.extend(sess1.events());
        events.extend(sess2.events());
        poll_with_advance(&mut sess1, &mut sess2, &clock, 3);
    }

    // Restore the link: retransmissions deliver the withheld rows at once.
    links.unblock(a2, a1);
    poll_with_advance(&mut sess1, &mut sess2, &clock, 40);

    drive_lockstep(
        &mut sess1, &mut sess2, &mut stub1, &mut stub2, &clock, 12, 20,
    )?;
    poll_with_advance(&mut sess1, &mut sess2, &clock, 40);
    events.extend(sess1.events());
    events.extend(sess2.events());

    Ok(BurstRun { sess1, events })
}

#[test]
fn recorded_replay_of_corrected_session_plays_back_without_desync() -> Result<(), FortressError> {
    for save_mode in [SaveMode::EveryFrame, SaveMode::Sparse] {
        let mut run = run_correction_burst(save_mode, true, DesyncDetection::Off)?;
        let rollbacks = run.sess1.metrics().rollback_count;
        let replay = run.sess1.take_replay()?;
        replay.validate()?;
        let recorded_checksums = replay
            .checksums
            .iter()
            .filter(|checksum| checksum.is_some())
            .count();
        assert!(
            rollbacks > 0,
            "[{save_mode}] the witness must actually repair mispredictions"
        );
        assert!(
            recorded_checksums > 0,
            "[{save_mode}] the recording must contain checksums"
        );

        // Positive control: the playback harness must report a desync when a
        // recorded checksum is wrong, so the green result below is meaningful.
        let mut corrupted = replay.clone();
        let first = corrupted
            .checksums
            .iter_mut()
            .find(|checksum| checksum.is_some())
            .expect("a recorded checksum exists");
        *first = Some(first.unwrap_or(0) ^ 0xFFFF);
        assert!(
            !replay_desync_frames(corrupted).is_empty(),
            "[{save_mode}] the playback harness must detect a corrupted checksum"
        );

        assert_eq!(
            replay_desync_frames(replay),
            Vec::<Frame>::new(),
            "[{save_mode}] a replay of a correctly played-out session must not report ReplayDesync"
        );
    }
    Ok(())
}

#[test]
fn correction_burst_does_not_report_desync_detected() -> Result<(), FortressError> {
    let run = run_correction_burst(
        SaveMode::EveryFrame,
        false,
        DesyncDetection::On { interval: 4 },
    )?;
    assert!(
        run.sess1.metrics().rollback_count > 0,
        "the witness must actually repair mispredictions"
    );
    assert!(
        run.sess1.metrics().checksums_compared > 0,
        "the witness must actually compare scheduled confirmations, otherwise the check is vacuous"
    );
    let reported: Vec<Frame> = run
        .events
        .iter()
        .filter_map(|event| match event {
            FortressEvent::DesyncDetected { frame, .. } => Some(*frame),
            _ => None,
        })
        .collect();
    assert_eq!(
        reported,
        Vec::<Frame>::new(),
        "repairing mispredictions must not be reported as a peer desync"
    );
    Ok(())
}

/// A two-peer recording pair with directionally blockable delivery.
struct RecoveryPair {
    clock: TestClock,
    sess1: P2PSession<StubConfig>,
    sess2: P2PSession<StubConfig>,
    stub1: GameStub,
    stub2: GameStub,
    links: BlockedLinks,
    a1: SocketAddr,
    a2: SocketAddr,
}

fn build_recovery_pair(save_mode: SaveMode) -> Result<RecoveryPair, FortressError> {
    let clock = TestClock::new();
    let (s1, s2, a1, a2, links) = channel_pair();

    let mut sess1 = SessionBuilder::<StubConfig>::new()
        .with_protocol_config(protocol_config(&clock))
        .add_player(PlayerType::Local, PlayerHandle::new(0))?
        .add_player(PlayerType::Remote(a2), PlayerHandle::new(1))?
        .with_input_delay(0)?
        .with_save_mode(save_mode)
        .with_recording(true)
        .start_p2p_session(s1)?;

    let mut sess2 = SessionBuilder::<StubConfig>::new()
        .with_protocol_config(protocol_config(&clock))
        .add_player(PlayerType::Remote(a1), PlayerHandle::new(0))?
        .add_player(PlayerType::Local, PlayerHandle::new(1))?
        .with_input_delay(0)?
        .with_save_mode(save_mode)
        .with_recording(true)
        .start_p2p_session(s2)?;

    synchronize_sessions_deterministic(&mut sess1, &mut sess2, &clock, &SyncConfig::default())?;

    Ok(RecoveryPair {
        clock,
        sess1,
        sess2,
        stub1: GameStub::new(),
        stub2: GameStub::new(),
        links,
        a1,
        a2,
    })
}

impl RecoveryPair {
    fn local_input(player: u8, frame: u32) -> StubInput {
        match player {
            0 => StubInput { inp: 7 * frame + 1 },
            _ => StubInput {
                inp: 13 * frame + 2,
            },
        }
    }

    fn advance(&mut self, frame: u32) -> Result<(), FortressError> {
        self.sess1
            .add_local_input(PlayerHandle::new(0), Self::local_input(0, frame))?;
        self.sess2
            .add_local_input(PlayerHandle::new(1), Self::local_input(1, frame))?;
        self.stub1.handle_requests(self.sess1.advance_frame()?);
        self.stub2.handle_requests(self.sess2.advance_frame()?);
        poll_with_advance(&mut self.sess1, &mut self.sess2, &self.clock, 3);
        Ok(())
    }

    /// Withholds peer 1's traffic from peer 0, so only peer 0 predicts the
    /// delayed row while peer 1 receives and records it normally.
    fn block_peer1_to_peer0(&self) {
        self.links.block(self.a2, self.a1);
    }

    fn unblock_peer1_to_peer0(&self) {
        self.links.unblock(self.a2, self.a1);
    }

    fn settle(&mut self) {
        poll_with_advance(&mut self.sess1, &mut self.sess2, &self.clock, 40);
    }
}

/// Once local input stops at boundary 257, the withheld original frame 256
/// arrives but `advance_frame` refuses before it can build the correction
/// requests. `recover_confirmed_inputs` repairs and records the row instead.
#[test]
fn recover_confirmed_inputs_finalizes_withheld_confirmed_frame() -> Result<(), FortressError> {
    for save_mode in [SaveMode::EveryFrame, SaveMode::Sparse] {
        recover_finalizes_withheld_confirmed_frame(save_mode)?;
    }
    Ok(())
}

fn recover_finalizes_withheld_confirmed_frame(save_mode: SaveMode) -> Result<(), FortressError> {
    let mut pair = build_recovery_pair(save_mode)?;
    for frame in 0..256 {
        pair.advance(frame)?;
    }

    // Withhold peer 1's frame-256 row from peer 0. Both peers advance to
    // boundary 257; peer 1 records the row, while peer 0 only predicts it.
    pair.block_peer1_to_peer0();
    pair.advance(256)?;
    assert_eq!(pair.sess1.current_frame(), Frame::new(257));
    assert_eq!(pair.sess2.current_frame(), Frame::new(257));

    // The original 256 row now arrives, but there is no local input for 257.
    pair.unblock_peer1_to_peer0();
    pair.settle();
    assert_eq!(
        pair.sess1.confirmed_frame(),
        Frame::new(256),
        "the withheld row must be received and confirmed"
    );

    // The recovery call repairs the already-received confirmed row at the
    // existing boundary: the correction loads and re-simulates 256 only.
    let correction = pair.sess1.recover_confirmed_inputs()?;
    let mut saw_load = false;
    let mut saw_resimulation = false;
    for request in &correction {
        match request {
            FortressRequest::LoadGameState { frame, .. } => {
                assert!(
                    *frame <= Frame::new(256),
                    "[{save_mode}] correction must load at or before the withheld row, got {frame:?}"
                );
                saw_load = true;
            },
            FortressRequest::AdvanceFrame { .. } => {
                saw_resimulation = true;
            },
            FortressRequest::SaveGameState { .. } => {},
        }
    }
    assert!(
        saw_load && saw_resimulation,
        "recovery must return the ordered correction requests, got {correction:?}"
    );
    pair.stub1.handle_requests(correction);
    assert_eq!(
        pair.sess1.current_frame(),
        Frame::new(257),
        "recovery must not advance past the existing boundary"
    );

    // A repeated call is safe: it neither advances nor repeats the rollback.
    let repeated = pair.sess1.recover_confirmed_inputs()?;
    assert!(
        repeated
            .iter()
            .all(|request| matches!(request, FortressRequest::SaveGameState { .. })),
        "a repeated recovery must not load or advance again, got {repeated:?}"
    );
    pair.stub1.handle_requests(repeated);
    assert_eq!(pair.sess1.current_frame(), Frame::new(257));

    // Plain advance still requires the local sample that the game stopped
    // producing; recovery is the supported path for that state.
    let error = pair
        .sess1
        .advance_frame()
        .expect_err("advance_frame must refuse without local input for 257");
    assert!(
        matches!(
            error,
            FortressError::InvalidRequestStructured {
                kind: InvalidRequestKind::MissingLocalInput
            }
        ),
        "expected MissingLocalInput, got {error:?}"
    );

    let replay = pair.sess1.take_replay()?;
    assert_eq!(
        replay.total_frames(),
        257,
        "the finalized prefix must include the recovered row"
    );
    assert_eq!(
        replay.metadata.skipped_frames, 0,
        "the recovered row must be a real row, not a skipped placeholder"
    );
    let bytes = replay.to_bytes().expect("replay serializes");
    let decoded =
        fortress_rollback::replay::Replay::<StubInput>::from_bytes(&bytes).expect("replay decodes");
    assert_eq!(
        decoded.frames[256],
        vec![
            RecoveryPair::local_input(0, 256),
            RecoveryPair::local_input(1, 256)
        ],
        "the decoded finalized prefix must carry the original row 256"
    );
    assert_eq!(
        replay_desync_frames(decoded),
        Vec::<Frame>::new(),
        "the finalized replay must play back against the corrected states"
    );

    // The receiving peer is at the same boundary and its confirmed fold also
    // lagged the advance, so it takes the same recovery step; both asymmetric
    // endpoints then export the complete history.
    let peer1_correction = pair.sess2.recover_confirmed_inputs()?;
    pair.stub2.handle_requests(peer1_correction);
    assert_eq!(pair.sess2.current_frame(), Frame::new(257));
    let peer1_replay = pair.sess2.take_replay()?;
    assert_eq!(
        peer1_replay.total_frames(),
        257,
        "the receiving peer must export the same finalized prefix"
    );
    assert_eq!(
        replay_desync_frames(peer1_replay),
        Vec::<Frame>::new(),
        "both finalized replays must validate"
    );
    Ok(())
}

/// A neutral control: the delayed row matches the prediction, so recovery must
/// record it without fabricating a rollback.
#[test]
fn recover_confirmed_inputs_records_prediction_matching_row_without_rollback(
) -> Result<(), FortressError> {
    let mut pair = build_recovery_pair(SaveMode::EveryFrame)?;
    for frame in 0..256 {
        pair.advance(frame)?;
    }

    pair.block_peer1_to_peer0();
    // Peer 1 repeats its frame-255 input at frame 256, which is exactly what
    // peer 0's RepeatLastConfirmed prediction produces.
    pair.sess1
        .add_local_input(PlayerHandle::new(0), RecoveryPair::local_input(0, 256))?;
    pair.sess2
        .add_local_input(PlayerHandle::new(1), RecoveryPair::local_input(1, 255))?;
    pair.stub1.handle_requests(pair.sess1.advance_frame()?);
    pair.stub2.handle_requests(pair.sess2.advance_frame()?);
    poll_with_advance(&mut pair.sess1, &mut pair.sess2, &pair.clock, 3);

    pair.unblock_peer1_to_peer0();
    pair.settle();
    assert_eq!(pair.sess1.confirmed_frame(), Frame::new(256));
    let rollbacks_before = pair.sess1.metrics().rollback_count;

    let requests = pair.sess1.recover_confirmed_inputs()?;
    assert!(
        requests
            .iter()
            .all(|request| matches!(request, FortressRequest::SaveGameState { .. })),
        "a matching prediction needs no correction, got {requests:?}"
    );
    pair.stub1.handle_requests(requests);
    assert_eq!(
        pair.sess1.metrics().rollback_count,
        rollbacks_before,
        "recovery must not fabricate a rollback for a matching row"
    );

    let replay = pair.sess1.take_replay()?;
    assert_eq!(
        replay.total_frames(),
        257,
        "the matching confirmed row must still be recorded"
    );
    assert_eq!(replay.metadata.skipped_frames, 0);
    assert_eq!(replay_desync_frames(replay), Vec::<Frame>::new());
    Ok(())
}

/// The row that never arrives must stay out of the exported prefix; recovery
/// may not invent a placeholder for it.
#[test]
fn recover_confirmed_inputs_does_not_invent_the_withheld_row() -> Result<(), FortressError> {
    let mut pair = build_recovery_pair(SaveMode::EveryFrame)?;
    for frame in 0..256 {
        pair.advance(frame)?;
    }

    pair.block_peer1_to_peer0();
    pair.advance(256)?;
    assert_eq!(
        pair.sess1.confirmed_frame(),
        Frame::new(255),
        "the still-withheld row cannot advance confirmation"
    );

    let requests = pair.sess1.recover_confirmed_inputs()?;
    assert!(
        requests
            .iter()
            .all(|request| matches!(request, FortressRequest::SaveGameState { .. })),
        "an unavailable row needs no correction, got {requests:?}"
    );
    pair.stub1.handle_requests(requests);

    let replay = pair.sess1.take_replay()?;
    assert_eq!(
        replay.total_frames(),
        256,
        "the unavailable row must stay out of the replay"
    );
    assert_eq!(
        replay.metadata.skipped_frames, 0,
        "the unavailable row must not be replaced by a placeholder"
    );
    let bytes = replay.to_bytes().expect("replay serializes");
    let decoded =
        fortress_rollback::replay::Replay::<StubInput>::from_bytes(&bytes).expect("replay decodes");
    assert_eq!(decoded.frames.len(), 256);
    assert_eq!(
        decoded.frames[255],
        vec![
            RecoveryPair::local_input(0, 255),
            RecoveryPair::local_input(1, 255)
        ],
        "the last row must be the last row that actually arrived"
    );
    assert_eq!(replay_desync_frames(decoded), Vec::<Frame>::new());
    Ok(())
}

/// Builds a connected pair of directionally-blockable channel sockets.
fn channel_pair() -> (
    FilterSocket,
    FilterSocket,
    std::net::SocketAddr,
    std::net::SocketAddr,
    BlockedLinks,
) {
    let (s1, s2, a1, a2) = crate::common::create_channel_pair();
    let links = BlockedLinks::new();
    (
        FilterSocket::new(s1, links.clone()),
        FilterSocket::new(s2, links.clone()),
        a1,
        a2,
        links,
    )
}

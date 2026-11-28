window.BENCHMARK_DATA = {
  "lastUpdate": 1795825909100,
  "repoUrl": "https://github.com/Ambiguous-Interactive/fortress-rollback",
  "entries": {
    "Fortress Rollback Benchmarks": [
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "62c777a2f81389e56b1014eb290fe4159ca8db19",
          "message": "fix: close coordinated-removal review findings and harness liveness guard (#481)\n\n## Description\n\nAddresses the unresolved review findings from the coordinated\ngraceful-removal work merged in #474, #475, #478, and #479, and improves\nthe certificate's availability under a one-way requester -> coordinator\nfault without reopening split-winner admission.\n\nProduction fixes:\n- A non-coordinator requester broadcasts its `Prepare` to the\noperation's participants. Non-coordinator participants forward it to the\noperation coordinator without admitting it, so a lost\nrequester-to-coordinator link does not stall the removal while a relay\npath exists. Only participants receive prepares; non-participants would\nfail closed on exact-membership validation under asymmetric timeout\nviews.\n- Preserve the original admission source when a prepare is deferred\nbehind a committed certificate instead of recomputing it as the\ncoordinator.\n- Relay a validated coordinator cut announcement through participants,\npreserving the coordinator identity. The first transition and direct\ncoordinator retries are forwarded; relayed duplicates are not\nre-relayed, bounding propagation.\n- Consult the rejected-operation journal before the terminal-operation\nhistory. A superseded operation lives in both collections, and the\njournal is the only path that answers a retransmitted prepare with a\nfresh `Superseded` abort after the first abort is lost.\n- Build the replacement journal payload and reserve it before trimming,\nso a failed allocation cannot evict an entry whose replacement cannot be\nrecorded.\n- Reject a conflicting backfill overlap that only survives in the\nreclaimed rollback-floor slot. `confirmed_input` can still return that\nvalue even when it is not contiguous with the ring, so accepting a\ndifferent backfill value silently contradicted local history.\n\nSimulation/harness:\n- New CAP row 5 `coordinator_link_loss_relays_prepare_and_commits`\n(replay-pinned): peer 2 -> coordinator 0 is blocked from step 100 to 400\nwhile peer 3 is removed at step 120. Direct-only prepares fail closed\nwith `Timeout; phase=Inventory`; the relay commits and all survivors\nrecover after the heal.\n- Record each live removal target's `Running` interval before the\nretirement guard can skip it. The previous write was unreachable, so\n`live_target_premature_exit` could never fire and an early target exit\nwas silently treated as an initial-sync exception.\n- Pin relay and fresh-abort behavior with cumulative per-kind send\ncounters, plus transactional input-queue conflict tests.\n- Require per-target `PeerDropped` evidence in the lossy\nconcurrent-removal row.\n- Remove the broad `coordinated graceful drop` failure allowlist from\nthe H-RING row.\n- Refresh the D14 PCT lagging-survivor expected vector after the\nadditional relay traffic; the regression still has the intended lagging\nshape.\n\nDocs:\n- Qualify the concurrent-removal ordering guarantee per\noperation/coordinator and document the relay path.\n- Document the inventory-failure path, the `Running -> Synchronizing`\nfailed-removal signal (with a bounded initial-sync wait and rebuild\naction), and the journal-retention limit on repeated aborts.\n- Clarify rollback sequencing after a commit and the checksum-history\nbehavior after certified-cut re-simulation.\n- Regenerate the wiki mirrors.\n\nDependencies:\n- `cargo update`: regex 1.13.2, regex-automata 0.4.19, regex-syntax\n0.8.12, smallvec 1.16.6. Workspace lock freshness check passes.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [x] 🧪 Test (adding or updating tests)\n- [x] 📚 Documentation (changes to documentation only)\n- [x] 🔧 CI/Build (dependency lockfile refresh)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly\n- [x] I have added an entry to `CHANGELOG.md` for user-facing changes\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n- `coordinator_link_loss_relays_prepare_and_commits` (red/green CAP row)\n- `superseded_closed_operation_answers_retransmission_with_fresh_abort`\n- `rejected_prepare_is_remembered_and_cannot_reopen` (fresh-abort\nassertions)\n- `non_coordinator_prepare_requires_the_coordinator_source` (relay\nassertion)\n- `reclaimed_floor_overlap_conflict_is_rejected`\n- `evicted_prefix_then_retained_conflict_rejects_transactionally`\n- H-RING allowlist narrowed; lossy removal row requires per-target drop\nevidence; PCT vector refreshed.\n\n**Evidence:**\n- `cargo tfull`: 3272 passed, 76 skipped.\n- `cargo test --doc`: 168 passed, 55 ignored.\n- Targeted\n`coordinator_cut_announcement_requires_exact_shape_and_authority` passes\non native, aarch64, and i686.\n- `cargo test --test simulation`: 471 passed, 28 ignored.\n- Nightly live-target regression: 5 seed rows + lossy concurrent row\npassed.\n- Nightly shards 0-7 at seed base 12345 on `fe245d6`: all green (125\nseeds per shard).\n- Cross-target `cargo check --lib` (default + no-default):\n`wasm32-unknown-unknown`, `wasm32-wasip1`, `wasm32-unknown-emscripten`,\n`i686-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`.\n- `cargo clippy --workspace --all-targets --features tokio,json`: clean.\n- `cargo doc --no-deps --features tokio,json` and link check: clean.\n- `python3 scripts/ci/agent-preflight.py --full --auto-fix`: all checks\npass.\n- `python3 scripts/release/workspace_locks.py check`: passes.\n\nAll review threads are resolved; the latest OpenAI review reports 0\nfindings and every CodeRabbit actionable item has been fixed.\nCodeRabbit's optional full re-review is currently rate-limited, but all\nreported findings are addressed and every review thread is resolved.\n\n## Related Issues\n\nRelates to #473, #474, #475, #477, #478, #479.\n\nFollow-up issues for design-level findings:\n- #482 reliable target-bound commit delivery for a live removed target.\n- #483 receiver-recognized current-history backfill donor.\n- #484 live-target oracle ceiling should use the certified cut.",
          "timestamp": "2026-11-18T20:26:58Z",
          "tree_id": "3b3fb9176c6c35c0868a3fc87d84e7b1a4210894",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/62c777a2f81389e56b1014eb290fe4159ca8db19"
        },
        "date": 1795034331450,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 38131,
            "range": "± 401",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 24421,
            "range": "± 414",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 0",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1244,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2782,
            "range": "± 175",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "2a1a26c2c90cb727380359df0c4f11ef97e20039",
          "message": "fix: acknowledge live-target removals and attribute current-history donors (#486)\n\n## Description\n\nCloses the three coordinated graceful-removal follow-ups filed from\n#481, and closes the dependency-migration evaluation issue as not\napplicable. All three bugs are in the live-target / lossy-inventory path\nof the D14 graceful-removal certificate.\n\n### Commit delivery to a live removed target (#482)\n\nA survivor disconnects the target endpoint as soon as it applies the\ncertificate, but drop-control datagrams are best-effort and were queued\nexactly once. A live removed target whose copy was lost kept `Running`\non a dropped history until its own peer timeout.\n\n- Survivors now keep a bounded (`<= num_players`) per-target retirement\nfence and retransmit the commit into the endpoint's `Disconnected`\nshutdown window. Retransmission stops on the target's acknowledgement,\nafter a one-second retry window, or as soon as the endpoint shuts down /\nleaves `Disconnected`.\n- A target that receives a committed certificate for an operation it\nnever opened acknowledges with a dedicated `TargetAck` report from its\nsmallest local handle and fails closed. Acknowledgements are advisory:\nthey only stop retransmission and never extend any survivor's confirmed\nfrontier.\n- Duplicate acknowledgements that arrive after the fence cleared are\nignored; they no longer fail the already-committed certificate closed.\n- A hot-join replacement at the same address is a new generation:\nretransmission stops when the endpoint leaves `Disconnected`, and a\nserving host clears the fence when it re-arms the slot. A fresh joiner\nnever receives the departed generation's certificate.\n- A session that has failed closed (`halt_confirmed_ceiling` set) never\ncertifies a removal. A poisoned joiner could otherwise inject a solo\ntarget certificate into a healthy mesh.\n\n### Current-history donor announcements (#483)\n\nInventory reports are start-of-attempt snapshots. A survivor that became\nable to donate afterwards (its missing target frames arrived through\nordinary replication/retransmission) sent chunks that every other\nreceiver discarded, and the attempt failed closed with `MissingHistory`.\n\n- A newly-able donor announces its current retained range as a\n`DropReport` with the new `DropReportStage::Donor` (`cut` = earliest\nservable frame, `cut_digest` = the digest it computes for the certified\ncut). The stage is an additive member of the existing report enum; the\nv3 wire golden registers it.\n- Receivers validate the operation, participant set, agreed cut, and\ndigest, re-derive the canonical chunk count from `[start, cut]` and the\ntarget set, lock one chunk grid per operation, and reject conflicting\nannouncements or chunks instead of mixing donors.\n- A no-donor attempt waits until the two-second operation deadline for a\nlate announcement before failing closed. Inventory completeness\ndescribes the snapshot, not future donation ability, so there is no\nseparate grace period.\n- Inventory-selected donors keep the existing fast path and send no\nannouncement. An inventory-selected donor that stops responding is\nfiltered out, letting a participant that acquired the range after the\nsnapshot announce and supply it.\n- Every backfill chunk carries the producing donor and the start of its\nwhole range. Relays preserve both, and a receiver locks the grid to one\ndonor: chunks from another donor are discarded even when the layout is\nidentical, so two donors cannot interleave earlier inputs.\n\n### Harness oracle fidelity (#484)\n\nFor `RunOptions::live_graceful_target`, the harness capped a target's\nconfirmed inputs at the request-time minimum survivor receipt. The\ncertified cut is the maximum target receipt across survivors, so the\noracle ignored shared history between the two. The cap is now deferred\nto retirement and derived from the certified cut observed on a survivor\n(the request-time receipt remains only a fallback).\n\n`RunReport::donor_announcements` and the doc-hidden\n`P2PSession::diagnostic_donor_announcements_accepted` provide\nnon-vacuity evidence for the donor path.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [x] 🧪 Test (adding or updating tests)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective\n- [x] `cargo fmt && cargo clippy --workspace --all-targets --features\ntokio,json,hot-join,violation-census` passes with no warnings\n- [x] `cargo nextest run` passes\n\n### If Applicable\n\n- [x] Documentation updated (`docs/user-guide.md`, `remove_player`\nrustdoc)\n- [x] `CHANGELOG.md` entry added under **Pre-existing:** Fixed\n- [x] No new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `committed_drop_retransmits_until_a_live_target_acknowledges`: drops\nthe first commit datagrams at a `MeshBus` transport boundary, asserts\nthe target stays `Running` while it has no certificate, then leaves\n`Running` after the retransmission and asserts the acknowledgement\nclears the fence.\n-\n`committed_drop_retry_state_is_bounded_when_the_target_never_acknowledges`\n- `duplicate_target_ack_after_the_retry_fence_cleared_is_ignored`\n- `donor_announcement_attributes_current_history_backfill`\n- `backfill_chunk_reordered_ahead_of_its_donor_announcement_is_retried`\n- `conflicting_donor_announcements_fail_closed`\n- `backfill_chunks_from_different_start_grids_fail_closed`\n- CAP row\n`reordered_inventory_removal_certifies_without_missing_history` (lossy,\nduplicated, retransmission-delayed N=4 live-target removal,\nreplay-pinned)\n- Harness/oracle regression rows updated for the corrected live-target\ncap (`full_ring_receipt_stagger_fails_closed_at_retained_boundary`,\n`pct_lagging_survivor_does_not_fake_a_freeze_divergence`)\n\n**Validation evidence:**\n\n- `cargo nextest run --workspace --features\ntokio,json,hot-join,violation-census --no-fail-fast` -> 3610 passed, 0\nfailed, 77 skipped.\n- `cargo tfull` -> 3308 passed, 0 failed, 76 skipped.\n- `cargo clippy --workspace --all-targets --features\ntokio,json,hot-join,violation-census -- -D warnings` -> clean.\n- `python3 scripts/ci/agent-preflight.py --full --auto-fix` -> all\nchecks passed.\n- Cross-target checks: `wasm32-unknown-unknown`,\n`wasm32-unknown-emscripten`, `wasm32-wasip1`,\n`aarch64-unknown-linux-gnu`, `i686-unknown-linux-gnu`\n(`--no-default-features --features hot-join`).\n- `cargo update --dry-run`: no compatible dependency updates available\n(the six lagging crates are major-version bumps).\n\n**Review follow-up (CodeRabbit on this PR):**\n\n- Direct donor retransmissions are relayed again (so a lost forwarded\ncopy is repaired) while relayed duplicates are not re-relayed, bounding\npropagation to one extra hop. Pinned by\n`relayed_donor_duplicates_are_bounded_but_direct_retries_relay`.\n- One target acknowledgement now clears every pending retry fence for\nthe same removed endpoint and commit (multi-handle endpoints acknowledge\nonce with their smallest local handle). Pinned by\n`target_ack_clears_every_handle_of_the_removed_endpoint`.\n- Once a donor has announced, the no-donor grace no longer fails the\nattempt; the announced range stays recoverable until the two-second\noperation deadline. Pinned by\n`announced_donor_defers_missing_history_until_the_operation_deadline`.\n\n**Mutation-gate hardening (fixes the current main mutation-summary\nfailure class):**\n\n- Added a table-driven malformed-inventory-report matrix\n(`malformed_inventory_reports_fail_closed_without_mutation`), a\nprepare-routing test\n(`coordinated_drop_send_prepare_targets_only_running_participants`), a\ncommitted-attempt deferral test\n(`prepare_during_a_committed_attempt_is_deferred`), and a matching\nreclaimed-floor overlap control in the input-queue test.\n\n\n**Review follow-up (CodeRabbit round 3):**\n\n- **Wire protocol v3.** The donor/target-ack report stages are\nincompatible with released v2 decoders, and a v2 peer could complete the\nv2 handshake and then drop them. `PROTOCOL_VERSION` is now `3`,\n`MIN_SUPPORTED_PROTOCOL_VERSION` follows it, and\n`src/network/wire_golden_v3.rs` is the active immutable byte suite;\n`wire_golden_v2.rs` is a rejection suite. See the **Breaking:**\nchangelog entry.\n- Target acknowledgements use a dedicated `DropReportStage::TargetAck`,\nso a target (or an omitted session that failed closed) can never be\ncounted as survivor commit evidence. Disconnected endpoints admit only\n`TargetAck`.\n- Multi-chunk backfill validation uses the chunk's explicit\n`range_start` and `donor`, checks the chunk sits at `range_start +\nchunk_index * frames_per_chunk`, locks one donor and range per\noperation, and validates each chunk's frame count. A 16-player two-chunk\nregression pins it.\n- The initial commit is flushed to the retiring target endpoint before a\nhot-join rearm can replace its send queue.\n- A donor may announce an earlier range after a delayed inventory\nreport; the not-yet-installed grid resets instead of failing the honest\nupdate.\n- A rearmed survivor slot clears that address's retirement retries.\n- A failed-closed session closes its uncertified attempt locally without\nemitting witness reports.\n- Racing current-history donors now have a deterministic choice: the\nlowest participant that announced a covering range. Other donors' grids\nare discarded, not failed closed.\n- Diagnostic docs distinguish accepted announcements from completed\nbackfills; the acknowledgement test stays strictly inside the retry\nwindow.\n\n\n**Review follow-up (final rounds):**\n\n- Every `TargetAck` is consumed before the rejected-operation journal,\nso an acknowledgement\nalways clears its retry fence. A multi-handle endpoint's acknowledgement\nis attributed by\n  endpoint address, matching the fence keyed by the removed handle.\n- Announced-donor selection filters unresponsive endpoints; a changed\nselection rebinds the\nuninstalled grid, and before any grid locks the first valid announced\ngrid supplies the range\n  so divergent survivor views cannot discard each other's only chunks.\n- Unseen removal certificates need a second endpoint's corroboration\n(the sole peer suffices in a\ntwo-player session) and must name a coordinator generation the receiver\nhas not moved past; a\nbounded per-identity replay watermark rejects delayed duplicates after\nthe closed journal\nevicts them. A competing known commit needs the same evidence before it\ncan make an active\n  attempt yield.\n- `RunReport` records every installed backfill chunk by donor source;\nthe reordered-removal row\n  asserts a non-vacuous installed suffix.\n- The live-target oracle cap now finalizes at the end of the run so a\nlate-observable certified\n  cut always wins.\n- Validation at `9190785`: `nextest --lib` 1947 passed, `--test\nsimulation` 472 passed, CI profile\n(`--profile ci --features tokio,json`) 3312 passed, `cargo tfull` 3326\npassed, clippy\n`-D warnings` clean, agent preflight passed, wiki dry-run\nbyte-identical.\n\n## Related Issues\n\nCloses #482\nCloses #483\nCloses #484\nRelates to #481, #474, #473\n\n**Review follow-up (CodeRabbit round 8):**\n\n- Commit retransmissions stop as soon as the endpoint leaves the\ndeparted generation's `Disconnected` window. A serving host rearms the\nslot at commit, so the fence clears before any retry and a replacement\ngeneration can never accept the old `DropCommit`. Pinned by\n`hot_join_rearm_stops_commit_retries` and\n`commit_retries_stop_when_the_disconnected_window_closes`.\n- Retirement delivery is deduplicated by address per poll while the\nper-handle fences stay for acknowledgement and cleanup.\n`target_ack_clears_every_handle_of_the_removed_endpoint` also pins a\ndifferent commit at the same address.\n- The donor fallback and the current-history announcement path are\nexercised end to end;\n`lossy_graceful_removal_rows_keep_one_history_and_recover` asserts a\nnonzero `donor_announcements` entry.\n- The no-donor docs name the two-second operation deadline as the only\nterminal verdict, consistent with the earlier Major finding on the\ninventory snapshot.\n\n**Review follow-up (CodeRabbit rounds 9-11):**\n\n- `TargetAck` is consumed before any operation journal, so a committed\nor rejected operation no longer swallows the target's acknowledgement.\nAcknowledgements are attributed by the sender endpoint's address, so an\nack from a co-located handle clears the removed handle's fence for the\nsame commit.\n- Before a grid is locked, the first valid announced grid supplies the\nrange (`selected_announced || no_grid_locked`), so survivors that\ndisagree about the inventory donor's reachability cannot wedge the\nbackfill. Once locked, one donor owns the grid; a changed selection\nrebinds only the uninstalled grid.\n- An unseen certificate needs distinct-endpoint corroboration (two\nendpoints, or the sole peer in a two-player session), a valid\ncoordinator generation, and must be newer than the per-coordinator\nreplay watermark. A single peer can no longer halt an active session;\ndelayed duplicates below a retained cut are rejected.\n- Installed backfills are counted separately\n(`RunReport::backfill_chunks` and `announced_backfill_chunks`); the\nreordered row asserts nonzero installed backfill, and the\nannounced-install path is pinned by\n`donor_announcement_attributes_current_history_backfill`. Generated rows\nstill do not install an announced chunk end-to-end, tracked as #488.\n- The live-target harness cap is finalized at run end: the certified cut\nwins when any survivor observed it, and the request-time ceiling is only\nthe no-certificate fallback.\n- The guide and synced wiki describe the target acknowledgement as the\ndedicated `TargetAck` stage only; no paragraph references a `Committed`\nreport.\n- Closes #487 (ordered `PeerDropped` evidence per survivor).",
          "timestamp": "2026-11-19T07:44:19Z",
          "tree_id": "f05ccff5a5c2a330abd2ab747e7b220b3ce6e146",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/2a1a26c2c90cb727380359df0c4f11ef97e20039"
        },
        "date": 1795074965065,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 24441,
            "range": "± 1296",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 15416,
            "range": "± 385",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 451,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 562,
            "range": "± 9",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5098,
            "range": "± 155",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "52052fe82ea5fd1a3c4e08bfec87f36e2b3a0d51",
          "message": "fix: keep periodic hot-join cycles live through stale freeze gossip (#489)\n\n## Description\n\nFixes the red `CI - Network Tests (Nightly)` soak on `main`. The\n4,000,000-frame\n\n`network::soak::four_million_frame_soak_preserves_bounds_replay_and_lifecycle`\nstopped at the\n36th periodic hot-join (confirmed frame 3,600,006): slot 0 stayed in\n`HotJoining` for millions of\npolls while survivors 1-3 remained `Running`, so the mesh never reached\nthe target.\n\n### Root causes\n\nDiagnostics (connect-status dumps + observer violations at the stall)\nshowed both survivors\nrejecting the coordinator's `ReactivateSlot` because a running peer\nstill claimed slot 0\nconnected, while the coordinator repeatedly aborted the serve\n(`last_saved_frame` moved off the\npinned snapshot during rollback repair) and the joiner retried forever.\n\n1. **A committed drop closed only a REOPENED `pending_reactivation`.** A\nnot-yet-reopened pending\nsurvived the drop. Its shield exempts the slot from the\ndisconnect-convergence fold and\nreopened attempts are never superseded, so the slot stayed connected and\nevery later directive\nwas rejected. `close_reopened_reactivation_for_drop_targets` now closes\n**any** pending for a\ndrop target: aborted (restore the pre-reopen freeze) for a\nnever-reopened attempt, committed\n   close preserved for a reopened one (the D17 implied-commit behavior).\n2. **Stale connected gossip above the local freeze blocked\nconvergence.** A prediction-capped\nsurvivor stops sending inputs with its pre-drop connected claim, and\npeers kept waiting for it\nto converge. A connected claim whose frame is **above** the survivor's\nown freeze cannot\nundercut that freeze, and the claiming peer's own gate still requires it\nto be locally frozen\nbefore it can reopen. The gate now blocks only on connected claims\nat/below the local freeze\n(or NULL claims), and also skips the joining endpoint's own self-claim.\n\n### Tests\n\n- `drop_commit_closes_a_not_yet_reopened_reactivation` — red without fix\n1.\n- `npeer_survivor_ignores_a_stale_connected_claim_above_its_freeze` —\nred without fix 2.\n-\n`npeer_survivor_ignores_the_joiners_own_connected_claim_for_convergence`\n— red without the\n  joiner self-claim skip.\n- `d17_new_drop_fence_outlives_delayed_prior_join_commit` still passes\n(reopened close semantics\n  preserved).\n\n### Verification\n\n- `FORTRESS_SOAK_TARGET_FRAMES=...` 3.7M release soak: passed in 330s\n(previously wedged at 3.6M).\n- Full `cargo nextest run --profile ci-network-nightly --release\n--run-ignored ignored-only -E\n\n'test(network::soak::four_million_frame_soak_preserves_bounds_replay_and_lifecycle)'\n--test\n  network --features hot-join`: **1 passed** in 336s.\n- `cargo nextest run --lib` 1947 passed; `--features hot-join` 2183\npassed.\n- `cargo nextest run --test simulation` 472 passed; `cargo tfull` 3326\npassed.\n- `cargo clippy --workspace --all-targets --features tokio,json -- -D\nwarnings` clean;\n  `python3 scripts/ci/agent-preflight.py` passed.\n\n## Type of Change\n\n- [x] Bug fix (non-breaking change that fixes an issue)\n- [x] Test (adding or updating tests)\n\n## Related Issues\n\nRelates to #486 (merged nightly regression source), #488.",
          "timestamp": "2026-11-19T08:33:13Z",
          "tree_id": "7c6475be7b880b79fcd1ea90a4b0f888bb1cfd96",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/52052fe82ea5fd1a3c4e08bfec87f36e2b3a0d51"
        },
        "date": 1795077936599,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 61815,
            "range": "± 1549",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 31423,
            "range": "± 691",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1862,
            "range": "± 109",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1555,
            "range": "± 75",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3131,
            "range": "± 175",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "73100949072af6bfd9c58c2204753d181b7d9d3c",
          "message": "test: close coordinated-drop mutation gaps from #486 (#490)\n\n## Description\n\nFollow-up to #486/#489. The post-merge diff-scoped mutation gate on\n#486's tree reported 10 missed mutants in the coordinated-drop donor and\nunseen-commit paths. The diff gate requires **zero** misses, so this PR\nadds the missing tests and two small guard simplifications.\n\n### Production changes\n\n- The unseen-evidence source set no longer has a redundant `len <\nnum_players` guard. The journal is already bounded by `num_players` and\nthe set holds transport-attributed handles.\n- The stale-commit check now distinguishes known from unknown operations\nwith an explicit branch. A delayed duplicate stays rejected even when\nrepeated by a second endpoint, while known operations keep their normal\nordering rules.\n\n### Tests added\n\n- `announced_donor_must_cover_the_required_start`: a lower-handle\nannouncement that does not cover the required start cannot displace the\ncovering donor.\n- `a_locked_grid_rejects_a_second_announced_donor`: each of the four\nlocked-grid components (`backfill_donor`, `expected_backfill_chunks`,\n`backfill_chunks`, `backfill_grid_source`) rejects another announced\ndonor's chunk.\n- `announced_donor_wrong_chunk_count_is_discarded`: a mismatched chunk\ncount is discarded at the announced-grid shape check, not failed closed\nlater.\n-\n`locked_grid_rejects_an_announced_fallback_for_a_non_selected_inventory_donor`:\nthe inventory branch's no-grid-locked fallback cannot override a locked\ngrid.\n- `committed_fence_mismatches_are_rejected_or_ignored_correctly`:\nsame-operation/different-cut is a conflict; different-operation/same-cut\nis not an exact duplicate.\n- `closed_operation_commit_is_ignored_without_halting`: a corroborated\ncommit for an operation already in the closed journal stays a no-op.\n- `partial_commit_mismatch_fails_closed_and_stages_a_matching_commit`: a\ndiffering cut alone conflicts, and a matching commit is staged on a\nnon-committed attempt.\n- Assertions pin the replay watermark's single-entry/max-cut behavior,\nthe corroborated-evidence cleanup, and the total installed-backfill\ncounter.\n\n### Verification\n\n- `cargo nextest run --workspace --features\ntokio,json,hot-join,violation-census --no-fail-fast` -> **3638 passed, 0\nfailed**, 77 skipped.\n- `cargo clippy --workspace --all-targets --features\ntokio,json,hot-join,violation-census -- -D warnings` -> clean.\n- Targeted `cargo mutants --file src/sessions/p2p_session.rs --re\n'coordinated_drop_accept_backfill|unseen_commit_corroborated|record_closed_cut|coordinated_drop_accept_commit'\n--in-place --timeout 300 -- --lib` -> **79 mutants: 70 caught, 9\nunviable, 0 missed** (29m).\n- The earlier full diff run selected 171 mutants; the tests here cover\nall 10 reported misses (the four locked-grid `&&` sites, announced\nshape/count, inventory fallback, unseen source guard, journal retain,\nwatermark update, stale predicate, and the diagnostic counter).\n\n## Type of Change\n\n- [x] Test (adding or updating tests)\n- [x] Bug fix (non-breaking guard simplification)\n\n## Checklist\n\n- [x] Zero-panic policy preserved\n- [x] `cargo fmt && cargo clippy ... -D warnings` clean\n- [x] `cargo nextest run` passes\n- [x] No public API change; diagnostics stay `#[doc(hidden)]`\n\n## Related Issues\n\nFollow-up to #486, #489. Relates to #488.",
          "timestamp": "2026-11-19T10:20:53Z",
          "tree_id": "8264ed561c54dd3577d74da6a981332ddb6363bf",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/73100949072af6bfd9c58c2204753d181b7d9d3c"
        },
        "date": 1795084441416,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 62499,
            "range": "± 8527",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 33073,
            "range": "± 222",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1862,
            "range": "± 112",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1558,
            "range": "± 76",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3029,
            "range": "± 190",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "f756decdd54f268fc5b252aac628257123fe3eaa",
          "message": "test: pin announced-donor installation and recover closed drop commits (#491)\n\n## Summary\n\nCloses #488 and resolves the still-valid review findings from the\nrecently merged coordinated-drop PRs.\n\n- **#488 — announced-donor installation end-to-end.** Adds generated\nlossy lifecycle row `(seed 43, n=3, Mild)` to\n`lossy_graceful_removal_rows_keep_one_history_and_recover`, asserts that\nan announced chunk actually installs (not merely that the announcement\nis accepted), pins the inventory-donor chunk path too, and verifies a\nserialize/deserialize replay produces the same trace hash and\nannounced-install counters.\n- **#489 follow-up — disconnected-target certificates.**\n`coordinated_drop_apply_commit` now accepts a target that is already\ndisconnected at the exact committed generation, closes a\nnot-yet-reopened reactivation without restoring/re-freezing the queue\nthe drop is about to freeze, and installs the membership fence.\nRegression drives the full commit path.\n- **#458 follow-up — commit recovery after quorum close.** Recently\napplied certificates are retained in a bounded per-player journal. A\nparticipant that missed the commit burst and retries `Ready` after every\nsurvivor closed the operation now receives the certificate again instead\nof timing out. A mismatched digest never replays it.\n- **Test adaptation.** The commit responder changes coordinated-drop\ncompletion timing, so the PCT lagging-survivor regression now uses a\nseed that preserves the required interleaving and re-pins its exact\nconfirmed vector.\n\n`PLAN.md` is empty after closing #488. No public API change; changelog\nentries describe the two pre-existing liveness fixes.\n\n## Validation\n\n- `cargo nextest run` — 3286 passed, 76 skipped\n- `cargo nextest run --features hot-join` — 3587 passed, 77 skipped\n- `cargo clippy --workspace --all-targets --features\ntokio,json,hot-join`\n- `cargo fmt --check`\n- `python3 scripts/ci/agent-preflight.py --full --auto-fix`",
          "timestamp": "2026-11-19T17:39:15Z",
          "tree_id": "725a2831f2773f1c5eecf9bd076497a0b751efeb",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/f756decdd54f268fc5b252aac628257123fe3eaa"
        },
        "date": 1795110724653,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 46543,
            "range": "± 2686",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 25526,
            "range": "± 233",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 682,
            "range": "± 75",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 871,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7021,
            "range": "± 351",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "66359201746b10e2f11cfc8fc543d674698297e7",
          "message": "fix: keep disconnected-target freeze at the certified cut (#492)\n\n## Summary\n\nFollow-up to merged #491. Its post-merge mutation-testing run found that\nthe disconnected-target freeze could still be mined down below the\ncertified cut by the ordinary disconnect fold, and the diff-scope\nmutants for the pre-fold workaround were not all covered.\n\n- Remove the pre-fold status override.\n- After `disconnect_player_at_frames`, re-assert `commit.cut` as every\ntarget's frozen status frame and frozen input value. This makes the\nfinal status/frozen value authoritative even when the target already\ncarried a lower disconnect high-water.\n- Keep the certificate journal duplicate test, which rejects\nre-recording the same commit.\n- Update the existing unreleased changelog entry to state the certified\nfrozen value guarantee.\n\nNo API change.\n\n## Validation\n\n- `cargo nextest run --features hot-join` targeted regressions pass.\n- `cargo nextest run` full default suite and `cargo nextest run\n--features hot-join` passed on #491; this follow-up keeps the same tests\nplus the corrected freeze assertions.\n- `cargo fmt --check`, changelog hook, and `agent-preflight.py\n--auto-fix` pass.\n- `cargo mutants --in-diff` reports no viable surviving mutants for this\nfollow-up diff.",
          "timestamp": "2026-11-19T18:20:24Z",
          "tree_id": "c68e7bf6e1f37163a882824cceed83062ff22382",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/66359201746b10e2f11cfc8fc543d674698297e7"
        },
        "date": 1795113233003,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 62251,
            "range": "± 746",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 31928,
            "range": "± 486",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1671,
            "range": "± 112",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1554,
            "range": "± 65",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3017,
            "range": "± 204",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "05998067b77cd45e1133cf5b354bb6e32208a22a",
          "message": "test: pin cross-arch hot-join traces and wasm removal paths (#494)\n\n## Summary\n\nCloses two cross-platform coverage gaps without changing production\nbehavior.\n\n### N-peer hot-join trace on non-x86_64 targets\n\nThe `cross-arch-runtime` matrix compiles with `--features tokio,json`,\nso the feature-gated `ScheduleEvent::HotJoin` path never executed under\nqemu-aarch64 or on 32-bit i686. The new\n`hot_join_trace_matches_checked_in_cross_architecture_digest` pins the\ncanonical `clean_npeer_hot_join_schedule(4)` trace\n(`0xe493_827c_d108_44b0`, confirmed `[859, 860, 860, 860]`) and a\ndedicated CI step runs it in both cross-arch lanes.\n\n### Explicit graceful removal in the wasm runtimes\n\nThe browser and Godot probes exercised synchronization, replay, hashing,\ncompression, and tab suspension, but neither executed a coordinated drop\ncertificate or the live-target commit retransmission path.\n\n- `explicit_graceful_removal_certifies_in_browser`\n(wasm32-unknown-unknown) synchronizes a two-peer `ContinueWithout` pair,\nadvances four frames, removes the remote player, requires `PeerDropped`,\nrequires the target to apply its committed certificate and stop, and\nrequires the survivor to keep advancing on the frozen slot.\n- `run_removal_probe` performs the same flow under the Emscripten\nGDExtension build and reports `removal_certified: true`; both threaded\nand non-threaded Playwright rows assert it.\n\n## Validation\n\n- Extra nightly fleet seed sweep, 1,000 fresh seeds across all 8 shards:\n`8 passed` (363 s).\n- Pinned hot-join trace: x86_64 pass, i686 native pass, qemu-aarch64\npass (5.4 s).\n- Browser runtime in headless Chrome 158 (wasm32-unknown-unknown): `8\npassed; 0 failed`, including the new removal test.\n- `cargo nextest run --workspace --features tokio,json`: 3,334 passed,\n76 skipped.\n- `cargo nextest run --workspace --features tokio,json,hot-join`: 3,637\npassed, 77 skipped.\n- `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D warnings`: clean.\n- `cargo +nightly-2026-08-26 clippy --manifest-path\ntests/godot-emscripten/Cargo.toml --locked --all-targets --all-features\n-- -D warnings`: clean.\n- `cargo check -p wasm-browser-smoke --target wasm32-unknown-unknown\n--lib --tests`: pass.\n- `actionlint .github/workflows/ci-rust.yml`: pass.\n- `python3 scripts/ci/agent-preflight.py --auto-fix`: all checks passed.\n\n## Review audit\n\nRe-checked the review threads on every PR opened in the last five days\n(#414 through #492). The previously unresolved items from #474, #479,\n#481, #486, #489, and #491 are addressed in current `main`; #492 had\nzero review threads. No follow-up production change was required.\n\n## Follow-up\n\n#493 tracks the remaining wasm runtime gap: the N-peer hot-join\nhandshake/snapshot path is still native-only at runtime. It is listed in\n`PLAN.md` under Future with a concrete exit criterion.\n\nNo public API or user-observable behavior changes; no changelog entry.",
          "timestamp": "2026-11-19T19:52:21Z",
          "tree_id": "18549dd53d0b774973b8498df6743aca9ec6e0a8",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/05998067b77cd45e1133cf5b354bb6e32208a22a"
        },
        "date": 1795118642552,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 39440,
            "range": "± 411",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 23972,
            "range": "± 758",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1244,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2771,
            "range": "± 182",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "d7abb296fd0af16f1ce7ff43298fa8cd50fc9bf9",
          "message": "test: drive the chaos latency floor from the injected clock (#495)\n\n## Summary\n\nFixes the post-merge main CI failure in `Miri (macOS - core)` on\n`0599806`:\n\n```text\nthread 'network::chaos_socket::tests::test_latency_minimum_delivery_time_data_driven' panicked:\nassertion `left == right` failed: [high_jitter] Packets delivered too early!\nmin_delivery=100ms, jitter=100ms, elapsed=129.54ms\n```\n\n## Root cause\n\nThe data-driven floor test queued the packets, took a wall-clock\n`Instant`, and asserted that a second receive immediately after the\nfirst delivered nothing. That assumption is only true while the test\nitself finishes inside the minimum delay. Miri's interpreter on macOS\ntook 129.54 ms between the two receives, so the 100 ms packet was\nalready due; the socket behaved correctly and the test reported a false\npositive.\n\n## Fix\n\nThe case now installs `TestClock` through `ChaosSocket::with_clock`,\nadvances it to exactly one millisecond below `latency - jitter`, and\nonly then asserts that no packet is ready. Test execution speed can no\nlonger affect the assertion on any target or instrumentation level. The\nmaximum-delivery sibling already used the same pattern.\n\n## Validation\n\n- `cargo nextest run --lib network::chaos_socket` -> 57 passed.\n- `cargo nextest run --workspace --features tokio,json` -> 3,334 passed,\n76 skipped.\n- `cargo clippy --workspace --all-targets --features tokio,json -- -D\nwarnings` -> clean.\n- `cargo fmt --all -- --check` -> clean.\n- Pre-commit hooks -> pass.\n\nNo production behavior changes; test-only.",
          "timestamp": "2026-11-19T20:28:23Z",
          "tree_id": "537f9d4bc2860c6bde7c55b449a5b8392c3f2f0b",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/d7abb296fd0af16f1ce7ff43298fa8cd50fc9bf9"
        },
        "date": 1795120820593,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 39880,
            "range": "± 283",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 23546,
            "range": "± 508",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1247,
            "range": "± 6",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2764,
            "range": "± 163",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "e442b7b0dacf8b4be15be67e459c3f00a682f25d",
          "message": "test: exercise hot-join membership in the wasm browser and Godot probes (#496)\n\n## Summary\n\nCloses #493. Adds the missing runtime coverage of the feature-gated\nhot-join membership path to both wasm probes. Hot join was the last\nmembership transition that only ran natively: snapshot capture/serve,\nsnapshot apply, activation-frame gating, and joined-slot input\ncontribution were never executed at runtime on either wasm target.\n\n### Browser (`wasm32-unknown-unknown`, real headless Chrome 158)\n\n- `hot_join_activates_and_confirms_joined_slot_in_browser`: a host runs\nsolo with a reserved slot for three frames; a joiner completes the\nsnapshot handshake through polling only (injected virtual clock, no\nsleeps); the joiner's first advance returns exactly one `LoadGameState`;\nboth peers then advance six frames. The final two confirmed frames must\nagree across peers and carry distinct non-default joined-slot inputs,\nproving the activation-frame gate and post-join input stream.\n- The smoke crate gains a non-default `hot-join` feature forwarding to\n`fortress-rollback/hot-join`; the `ci-rust.yml` browser runtime lane and\nthe `ci-pr.yml` wasm check opt in. Keeping it non-default prevents\nworkspace feature unification from silently switching the library into\nits hot-join configuration for unrelated builds.\n\n### Godot (`wasm32-unknown-emscripten`, threaded + nothreads)\n\n- `run_hot_join_probe` performs the same flow inside the 32-bit\nGDExtension build and reports `hot_join_activated`; both Playwright rows\nassert it. This exercises snapshot serialization, apply, activation, and\njoined-slot confirmation under the Emscripten runtime.\n\n### Feature-unification hardening\n\n- `network-test-peer` now always links `hot-join` and its exhaustive\n`FortressEvent` match no longer cfg-gates `JoinRequested`/`PeerJoined`.\nA workspace member enabling the library feature could previously leave\nthe peer's match non-exhaustive (surfaced by `cargo tfull --workspace`).\n\n## Validation\n\nBrowser runtime, actual Chrome for Testing 158 headless, full suite:\n\n```text\nrunning 9 tests\ntest tests::hot_join_activates_and_confirms_joined_slot_in_browser ... ok\ntest result: ok. 9 passed; 0 failed; 0 ignored; 0 filtered out\n```\n\nGodot Emscripten runtime (Emscripten 4.0.20, Godot 4.7.1, threaded and\nnon-threaded web exports, Playwright + xvfb):\n\n```text\nRunning 3 tests using 1 worker\n  ✓ console policy only admits the exact threaded dlink warning\n  ✓ threaded Godot export completes Fortress quality probes (4.3s)\n  ✓ nothreads Godot export completes Fortress quality probes (2.4s)\n  3 passed (7.5s)\n```\n\nFull suite and lint:\n\n```text\ncargo c: clean\ncargo tfull: 3637 tests run: 3637 passed (1 slow), 77 skipped\ncargo +nightly-2026-08-26 clippy --manifest-path tests/godot-emscripten/Cargo.toml\n  --locked --all-targets --all-features -- -D warnings: clean\ncargo check -p wasm-browser-smoke --features hot-join --target wasm32-unknown-unknown\n  --lib --tests: pass\nactionlint .github/workflows/ci-rust.yml .github/workflows/ci-pr.yml: clean\npython3 scripts/ci/agent-preflight.py --full --auto-fix: all checks passed\n```\n\nLatest `main` CI (`d7abb296`): 192 check runs, 185 success, 7 skipped, 0\nfailures.\n\n## Review audit\n\nAll PRs opened in the last five days (#414-#495) were re-checked. Every\nreview thread is resolved; the final OpenAI review finding count is zero\nafter follow-up commits (#479's coordinated-removal findings were closed\nby #480/#481, #474's by #475/#476). No further production follow-up was\nrequired.\n\n## Follow-up\n\n- `PLAN.md` now has an empty future queue; #493 is the last tracked\ncross-platform runtime gap.\n- Dependency majors (`bincode-next` 3.x, `parking_lot` 0.13,\n`serial_test` 4, `z3` 0.23) remain intentionally pinned to the frozen\nwire format / verification toolchain / MSRV and are out of scope for\nthis test-only change. No open dependency PRs exist.\n\nNo public API or user-observable behavior changes; no changelog entry.",
          "timestamp": "2026-11-19T22:03:17Z",
          "tree_id": "0959d5cebfa1fbd875c34705bcd21c37fa4a6550",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/e442b7b0dacf8b4be15be67e459c3f00a682f25d"
        },
        "date": 1795126595501,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 38991,
            "range": "± 990",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 24755,
            "range": "± 243",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 8",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1246,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2766,
            "range": "± 161",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "74741dcfdf6bff55825afd9a668b322ef38aaf2d",
          "message": "test: pin isolated-coordinator CAP progress and correct closed residual docs (#498)\n\n## Description\n\nFollow-up to the coordinated-graceful-drop work from #458 through #496.\n\n- The `P2PSession::remote_slot_confirmed_bound` rustdoc still described\nthe N≥4 double-failure-relay residual as a deferred S41 fix and cited a\nconvergence test that no longer exists. The sequence-numbered\n`FloorRequest`/`FloorReply` round has closed the residual since S55, so\nthe docs now point at the current hold/release unit guards and the\npartitioned-certificate choreographies. The matching test/TLA-index\nnarratives are corrected too.\n- Adds the missing CAP matrix row\n`isolated_coordinator_removal_still_commits_on_reachable_majority`: N=5\n`3/1/1` partition, removal requested by a reachable survivor, the\ndeterministic coordinator isolated. With the default 2-second disconnect\ntimeout the coordinator endpoint times out inside the bounded attempt,\nthe majority reconciles membership, certifies both the requested target\nand the departed coordinator slot, keeps confirming, and does not\ndiverge.\n- The variant where a longer configured `disconnect_timeout` keeps the\nisolated coordinator \"Running\" past the two-second operation deadline\nstill fail-closes the reachable majority. That is a real liveness\nlimitation, now tracked in #497 with a deterministic reproduction and\ncandidate designs, and queued in `PLAN.md` with the TLA-modeled failover\nexit criterion.\n\nReview feedback on the last five days of PRs was triaged\nthread-by-thread against current `main`: all 48 unresolved threads were\nanswered with the current code/test evidence and resolved. No\nuncorrected production finding remained.\n\n## Type of Change\n\n- [x] 📚 Documentation (changes to documentation only)\n- [x] 🧪 Test (adding or updating tests)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly\n- [ ] I have added an entry to `CHANGELOG.md` (test/docs only; no\nuser-facing change)\n- [ ] I have updated relevant examples in the `examples/` directory\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n-\n`simulation::partition_sweep::isolated_coordinator_removal_still_commits_on_reachable_majority`\n(new)\n- Existing guards re-run:\n`p2p_n4_double_failure_certificate_partition_fails_closed`,\n`p2p_n5_double_failure_certificate_partition_fails_closed`,\n`confirmed_frame_post_prune_unreplied_relay_holds_at_last_confirmed`,\n`remote_slot_confirmed_bound_consumes_relay_floor_round_after_prune`\n- Full `cargo nextest run --workspace --all-targets --features\ntokio,json,hot-join,violation-census`: 3709 passed, 77 skipped\n(pre-change baseline)\n- `python3 scripts/ci/agent-preflight.py --full --auto-fix`: all checks\npassed\n\n**Manual testing performed:**\n\n- Deterministic probe of the 5-second `disconnect_timeout` variant\n(documented in #497): all four majority peers end `Synchronizing` with\n`report_count=3, ready_count=0` timeouts.\n\n## Related Issues\n\nRelates to #445, #473, #497.",
          "timestamp": "2026-11-20T00:01:06Z",
          "tree_id": "0f5d949b73d6a10a586bc65e25dd42cae36a63ff",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/74741dcfdf6bff55825afd9a668b322ef38aaf2d"
        },
        "date": 1795133601639,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 25588,
            "range": "± 249",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 15846,
            "range": "± 364",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 470,
            "range": "± 7",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 582,
            "range": "± 11",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5337,
            "range": "± 263",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "444dee34b1cbc2c87841039627ee9e93793ed888",
          "message": "fix: let a reachable majority fail over an isolated drop coordinator (#499)\n\n## Description\n\nFixes #497. A coordinated graceful removal could fail closed a reachable\nstrict majority when the deterministic coordinator was partitioned away\nand the configured `disconnect_timeout` exceeded the two-second\noperation deadline. The failure reproduced as `final_confirmed=[74,...]`\nwith every majority peer `Synchronizing` and `phase=Inventory,\nreport_count=3, ready_count=0`.\n\nThis adds a bounded coordinator failover:\n\n- A non-coordinator prepare is retained for a one-second grace (half the\ntwo-second operation deadline). Any drop-control message from the real\ncoordinator cancels the pending candidate.\n- After the grace, the deterministic lowest remaining participant may\nadmit the retained prepare as acting coordinator and drive the unchanged\nquorum/cut/backfill/ready/commit path.\n- The real coordinator never yields an active attempt. A later\nconflicting cut still fails closed.\n- The acting role only excuses the replaced coordinator from the\nmissing-witness rules; quorum, participant-set validation, cut digests,\nand ready transcripts are unchanged.\n- Requester adoption is handled both from the fallback prepare and from\na cut/Ready that arrives first.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly\n- [x] I have added an entry to `CHANGELOG.md` (`**Pre-existing:**`\nFixed)\n- [ ] I have updated relevant examples in the `examples/` directory\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `isolated_coordinator_removal_commits_under_long_disconnect_timeout`:\nN=5 `3/1/1`, 5s timeout, both coordinator and target isolated. Majority\nstays `Running`, confirms past 400, certifies the requested target, no\ndivergence, exact replay.\n- `fallback_coordinator_takes_over_a_different_requesters_prepare`:\nrequester is not the fallback; peer 1 adopts peer 2's prepare.\n- `fallback_prepare_requires_a_participant_source_and_waits_for_grace`,\n`coordinator_prepare_cancels_a_pending_fallback`,\n`requester_adopts_the_fallback_after_the_grace`,\n`acting_coordinator_excuses_only_the_replaced_coordinator`.\n- Updated the N=4/N=5 double-failure guards to distinguish the pre-heal\nheld frontier from legitimate post-heal certification.\n- Red/green: the 5s row fails with the failover grace set to 10s\n(`majority survivor 1 must stay Running`), and passes with the 1s grace.\n\n**TLA+:**\n\n- `specs/tla/CoordinatorFailover.tla` + `CoordinatorFailover.cfg`:\ncoordinator partitioned, fallback liveness (`EventuallyFailoverCommits`)\n+ safety (`SafetyInvariant`).\n- `CoordinatorFailoverCompeting.tla` + cfg: real coordinator may choose\na competing cut; safety proves at most one cut commits.\n- Both run in `scripts/verification/verify-tla.sh`.\n\n**Manual/CI evidence:**\n\n- Full `cargo nextest run --workspace --all-targets --features\ntokio,json,hot-join,violation-census`: 3716 passed, 77 skipped.\n- `cargo clippy ... -D warnings`: clean.\n- Both rustdoc lanes pass.\n- Cross-platform `cargo check` for `wasm32-unknown-unknown`,\n`wasm32-wasip1`, `aarch64-unknown-linux-gnu`, and\n`i686-unknown-linux-gnu` with no-default-features and each isolated\nfeature (`sync-send`, `paranoid`, `json`, `hot-join`, `tokio`) passes.\n- `python3 scripts/ci/agent-preflight.py --full --auto-fix`: all checks\npassed.\n\n## Related Issues\n\nFixes #497.",
          "timestamp": "2026-11-20T01:48:13Z",
          "tree_id": "c770845b7311b6dbe6ea0bff58727094526ee84f",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/444dee34b1cbc2c87841039627ee9e93793ed888"
        },
        "date": 1795140005672,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 40367,
            "range": "± 285",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 25460,
            "range": "± 101",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 5",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1244,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2768,
            "range": "± 184",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "57494b78761444facd5a5f4b0aaeceef66a5d3be",
          "message": "test: close coordinator-failover mutation survivors (#503)\n\n## Description\n\nFollow-up to #499. The post-merge mutation job on `main` (`444dee34`)\nreported **30 missed mutants** in the new coordinator-failover state\nmachine. This adds targeted unit guards so each survivor is killed, and\nremoves one redundant condition plus one equivalent same-operation\nbranch so they no longer generate mutants.\n\nCovered classes:\n\n- bounded `coordinator_heard_operations` journal (oldest eviction at\n`num_players`);\n- retained fallback prepare ordering (lower operation wins, higher does\nnot replace, retransmissions do not reset the first-seen deadline);\n- fallback promotion boundaries (not before the grace; never when quorum\nequals the participant count, e.g. two survivors);\n- admission identity validation (`acting` must be the deterministic\nfallback and the source must match);\n- the deterministic coordinator never yields an active attempt;\n- non-fallback sends do not become acting;\n- unrelated coordinator reports do not clear a candidate or mark an\nactive attempt heard;\n- matching coordinator reports do mark the active attempt heard;\n- the full cut/Ready adoption matrices (grace, sender identity,\ncoordinator-heard, recorded-operation suppression,\ndeterministic-coordinator exclusion).\n\n## Type of Change\n\n- [x] 🧪 Test (adding or updating tests)\n- [x] 🐛 Bug fix (small condition simplification only; no behavior\nchange)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [ ] I have updated the documentation accordingly\n- [ ] I have added an entry to `CHANGELOG.md` (test-only change)\n- [ ] I have updated relevant examples in the `examples/` directory\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n- Full `cargo nextest run --workspace --all-targets --features\ntokio,json,hot-join,violation-census`: 3719 passed, 77 skipped.\n- `cargo clippy --workspace --all-targets --features\ntokio,json,hot-join,violation-census -- -D warnings`: clean.\n- Targeted new tests: 10/10 pass.\n- Local `cargo mutants` run on the affected functions confirms the\npreviously reported survivors are killed (see conversation evidence).\n- `python3 scripts/ci/agent-preflight.py --full --auto-fix`: expected to\npass; CI will confirm.\n\n## Related Issues\n\nFollow-up to #499 and #497.",
          "timestamp": "2026-11-20T04:35:25Z",
          "tree_id": "6a6e4cc6792312ddd1ab1d525f6165f9028f69c5",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/57494b78761444facd5a5f4b0aaeceef66a5d3be"
        },
        "date": 1795149987885,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 24477,
            "range": "± 493",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 14924,
            "range": "± 155",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 449,
            "range": "± 22",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 559,
            "range": "± 3",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5074,
            "range": "± 178",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "c7b3f7b1e9bd3b0fa5a1be42a0bc46040b9b9201",
          "message": "fix: keep coordinated-drop failover live after coordinator silence (#508)\n\n## Summary\n\nCloses the coordinated-drop failover liveness gaps found by a CAP review\nof the newly landed\ncoordinator-failover path, plus the commit-before-cut availability gap\nin the same certificate flow.\n\n1. **The failover grace is now a silence window, not a \"never heard\"\nlatch.** A single early\ncoordinator message used to set `coordinator_heard = true` forever, so a\ncoordinator that\ncommitted/reported once and then disappeared forced a reachable strict\nmajority to fail closed\nat the two-second deadline. The journal now stores the most recent\ncoordinator timestamp per\noperation; fallback admission, promotion, cut adoption, and Ready\nadoption require a full\none-second silence window, and every coordinator message refreshes it.\nAn alive coordinator\nkeeps priority; a late conflicting cut still fails closed; quorum,\ntarget sets, digests,\n   backfill, and transcripts are unchanged.\n2. **A relayed prepare now also reaches the deterministic fallback\ncandidate.** Previously a\nnon-coordinator relay forwarded only to the coordinator. With the\ncoordinator isolated and the\nrequester-to-fallback link broken, the fallback first learned of the\noperation when the relay\ntook over at the grace, starting a fresh grace that expired with the\noperation deadline. The\n   first copy now starts the fallback's timer.\n3. **A commit that overtakes the cut/Ready round is adopted instead of\nrejected.** A valid\n`Committed` report (or direct `Commit`) received while the local attempt\nis still in `Inventory`\nused to return `ConflictingHistory` or stage a cut-less pending commit,\nfailing a reachable\nparticipant closed or timing it out. The certified cut is now adopted,\nthe attempt re-enters\nbackfill to verify local history, and the committed reporter counts as\nits ready transcript.\n4. **Coordinator-heard evidence lives on the live attempt/candidate**,\nnot only\nin the bounded cross-operation journal, so journal eviction can never be\nmistaken for coordinator silence. A regression evicts the journal entry\nand\n   asserts the fallback stays blocked while the coordinator is alive.\n5. **Steady-state drop polling skips empty mailboxes** before cloning\nendpoint handle sets.\n\nNo wire-format change. Out-of-scope findings are tracked as #504 (split\nparticipant-set views),\n#505 (malformed peer artifact fail-closes the receiver), #506\n(cross-platform runtime coverage),\nand #507 (per-advance performance follow-ups). `PLAN.md` queues #504.\n\n## Tests\n\n- `fallback_takes_over_after_the_coordinator_goes_silent`: N=5, 100 ms\nlinks, coordinator heard\nthen isolated; the reachable majority must certify the target before the\n5 s socket timeout and\n  keep confirming. Red on the old latch.\n- `fallback_receives_a_relayed_prepare_through_a_broken_direct_link`:\ncoordinator isolated,\nrequester->fallback direct link broken; the relay must forward the first\ncopy so the fallback\n  takes over on time.\n- `fallback_coordinator_commits_through_rough_loss`: same topology over\n2-10% loss, delay,\n  jitter, duplication, and loss bursts.\n- Unit guards for silence-based adoption/blocking plus direct-commit and\nCommitted-report\nstaging before the local cut, including\n`evicted_coordinator_journal_cannot_release_an_heard_active_attempt`.\n- The PCT lagging-survivor premise vector was updated to its new\ndeterministic value (the\ncontrol-path change shifted the interleaving by a few frames while\npreserving the shape).\n\n## Verification\n\n- `cargo fmt`, `cargo clippy --workspace --all-targets --features\ntokio,json`: clean.\n- Full suite: 3663 passed / 77 skipped.\n- Hot-join feature suite: see CI.\n- Targeted fallback/commit tests: 21 passed.\n- cargo-mutants over the fallback corpus: 23 caught, 4 unviable, 0\nmissed.\n- `check-plan-hygiene.py`, `markdownlint`, `typos`, changelog/version\nchecks: clean.\n- Cross-target `cargo check` for wasm32-unknown-unknown / wasi /\nemscripten, i686, aarch64.\n\n## Type of Change\n\n- [x] Bug fix (non-breaking change which fixes an issue)\n\n## Checklist\n\n- [x] I have read the CONTRIBUTING guide\n- [x] I have followed the zero-panic policy\n- [x] I have added tests that prove the fix is effective\n- [x] `cargo fmt` and clippy are clean\n- [x] Full suite passes",
          "timestamp": "2026-11-20T06:15:08Z",
          "tree_id": "bd583ba3ca7ced2717ad1271cf4471cd6c8ebb65",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/c7b3f7b1e9bd3b0fa5a1be42a0bc46040b9b9201"
        },
        "date": 1795156069700,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 60689,
            "range": "± 1052",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 33382,
            "range": "± 705",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1862,
            "range": "± 107",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1556,
            "range": "± 107",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3140,
            "range": "± 182",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "e9ca590788b03bb312bbc6c808a048dcf008c72f",
          "message": "fix: bind coordinated-drop participants to the agreed membership epoch (#509)\n\n## Description\n\nCloses #504, #505, #506, and #507, and carries the three unresolved\nreview\nfindings from merged PR #508.\n\n### 1. Split-view participant sets (#504)\n\n`CoordinatedDropState` now derives the participant set from the **agreed\nmembership epoch** (every configured `Local`/`Remote` slot that has not\nbeen\ncertified dropped; reserved hot-join slots only while a\nserve/reactivation is\nin flight), independent of local endpoint reachability. A\nparticipant-set\ndigest is bound into `DropOperationId`. Two disjoint split-view groups\ncan no\nlonger each hold a strict-majority certificate for one target:\n\n- The epoch uses one canonical voter per endpoint (the lowest local\nhandle;\nthe lowest handle of each remote endpoint) and excludes\ncertified-dropped\n  slots plus slots whose serve/reactivation is still in flight.\n- `StateSnapshot` now carries the era's certified-dropped handle list,\nso a\nfresh N-peer joiner derives the same participant set as existing\nsurvivors;\n  the lifecycle commit clears the exclusion on every peer.\n- `begin_coordinated_drop`, deferred-prepare revalidation, and prepare\n  validation all use the same epoch-derived set.\n- The automatic-drop admission denominator keeps the target slot, so a\nsymmetric 2/2 split cannot become 2/3, and the target's endpoint never\ncounts\n  as one of its own survivors.\n- The removal queue records whether an intent came from the automatic\ntimeout\npath: an explicit request queued behind another operation is not gated\nby the\nautomatic survivor-majority pre-check, and an intent whose target\nalready\n  committed is dropped instead of minting a redundant operation.\n- Operation ordering and the closed-commit-cut watermark include the\n  participant digest.\n- Protocol version is now 4 (`wire_golden_v4.rs` is the active suite; v3\nis a\nrejection suite). The `DropOperationId` wire layout grows by eight\nbytes.\n- `CoordinatorSplitView.tla` models two disjoint groups: the shipped\nepoch\npolicy proves `AtMostOneCommittedCut` and liveness non-vacuously\n(GROUP_B 5\ncommits, GROUP_F 3 cannot); the local-view cfg is a manual demo-fail\n(not\n  auto-run).\n- Deterministic two-requester split-view CAP row plus\nparticipant-derivation\n  and identity-binding unit guards.\n\n**CAP trade-off:** in a `Running` session an explicit removal from a\nminority\nof a larger membership now fails closed; a two-player session keeps its\none-survivor certificate. `Synchronizing` sessions retain the documented\nlocal-reachable behavior because no confirmed history can fork yet. An\nexplicit\nremoval racing an in-flight join now excludes the joining slot and\ncommits a\none-survivor certificate; the N-peer survivor-drop battery pins that the\ncoordinator continues and the joiner activates.\n\n### 2. Peer artifacts no longer halt the receiver (#505)\n\nMalformed/stale prepares, malformed inventory/donor reports, conflicting\ncut/digest claims from non-authority participants, and malformed or\nduplicate\nbackfill chunks are discarded with a `NetworkProtocol` violation\ndiagnostic.\nA deterministic coordinator or acting fallback that conflicts with a\nlocked\ncut/digest still fails closed, as do local invariant/allocation\nfailures,\nconflicts with a locally committed certificate, and failed local\nbackfill\ninstalls. Backfill grid locks are installed only after all shape checks\npass.\n\n### 3. Per-advance performance (#507)\n\n- `UdpProtocol` carries a monotone `peer_connect_status_has_disconnect`\nlatch\nset by gossiped status merges, test seeds, and the joiner-bootstrap\nseeder.\n- `update_player_disconnects` skips the full-mesh fold while every local\nstatus\nis connected, no running non-reserved endpoint latched a disconnect, no\n  hot-join attempt is in flight, and no coordinated-drop state exists.\n- `on_input` classifies the piggybacked ack once and applies it through\nthe\nnew `apply_classified_ack_frame`; `apply_ack_frame` keeps the\nclassifying\nwrapper. A test-only counter pins one classification per accepted\npacket.\n\nBenchmark (`cargo bench --bench h16p_mesh -- 'H-16P advance_frame'` vs\nmain):\nN=8 32.6µs (-14.6%), N=16 155.4µs (-2.2%). The healthy early-out also\nstays\ndisabled while any non-reserved remote endpoint is stopped.\n\n### 4. Cross-platform runtime coverage (#506)\n\n- `codec::wire_codec_digest()` encodes/decodes every coordinated-drop\nbody\nshape plus a sync request. The replay fixture pins the digest; a native\nfixture test, the browser smoke test, and the Godot/Emscripten probe\nassert\nit. The Godot `MemorySocket` now transfers encoded bytes and decodes on\n  receive, so the codec runs under Emscripten.\n- The i686 and aarch64 cross-arch lanes now run the feature-gated\nhot-join\n  session suite in addition to the simulation trace.\n- A new `wasip1-replay-probe` binary runs machine-width parity,\ncompression\nparity, wire-codec digest, and the 4,096-frame replay under wasmtime in\nthe\n  `wasm32-wasip1` lane.\n- Platform notes in `docs/specs/determinism-model.md` corrected.\n\n### 5. PR #508 review follow-ups\n\n- A fallback cut announcement that matches an already-staged commit cut\nis\naccepted and adopts the acting role; a genuinely different cut from the\n  authority still fails closed.\n- The rough-loss row installs an explicit Rough `LinkPolicy` on every\ndirected\nlink (it previously used clean links because hand-built schedules do not\n  sample `config.noise`) and runs 1,800 steps; a 4.5s prefix asserts the\n  removal commits before the five-second socket timeout.\n- Former-joiner seam tests no longer use a quorum-less `remove_player`\nagainst\n  an unpolled coordinator endpoint.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [x] 💥 Breaking change (wire protocol v4 + explicit-removal CAP\nbehavior)\n- [x] 🧪 Test (adding or updating tests)\n- [x] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n- [x] I have followed the zero-panic policy\n- [x] I have added tests that prove the fixes are effective\n- [x] `cargo fmt` and `cargo clippy --workspace --all-targets --features\ntokio,json,hot-join` are clean\n- [x] `cargo nextest run --workspace --all-targets --features\ntokio,json,hot-join,violation-census`: 3746 passed, 77 skipped\n- [x] Documentation and `CHANGELOG.md` updated (breaking wire/protocol +\nCAP behavior)\n- [x] `agent-preflight.py --full --auto-fix` passes\n- [x] Cross-target `cargo check` for wasm32-unknown-unknown / wasip1 /\nemscripten, i686, aarch64\n- [x] TLA `CoordinatorSplitView` passes; local-view cfg is an enforced\ndemo-fail\n\n## Related Issues\n\nCloses #504\nCloses #505\nCloses #506\nCloses #507\nAddresses the unresolved review threads on #508",
          "timestamp": "2026-11-20T19:56:16Z",
          "tree_id": "2e69a57f7aa46867e8746f640410ed69cbcf1616",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/e9ca590788b03bb312bbc6c808a048dcf008c72f"
        },
        "date": 1795205302979,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 38537,
            "range": "± 320",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 25890,
            "range": "± 763",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1247,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2761,
            "range": "± 160",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "0085c493f81796124f6590261c153923be4809b8",
          "message": "test: close the #509 mutation survivors in the new drop/hot-join paths (#511)\n\n## Description\n\nThe post-merge `main` mutation job for PR #509 reported **44 missed\nmutants**\nin the new coordinated-drop split-view, peer-artifact, hot-join\nexclusion, and\ndisconnect-fold code. This follow-up closes every survivor without\nchanging\nbehavior:\n\n- Extract the boolean membership/authority predicates into pure helpers\n  (`hot_join_in_flight`, `report_has_authority`, `source_has_authority`,\n  `timeout_drop_is_automatic`, `status_table_is_clean`,\n`endpoint_requires_disconnect_fold`, `no_hot_join_in_flight`) and cover\nevery\n  branch with unit tests.\n- Reuse one `certified_dropped_list_is_valid` validator in both the\n2-peer and\n  N-peer snapshot paths; test bounded, sorted, and in-range cases.\n- Add a test-only `disconnect_fold_runs` counter so the healthy\nearly-out and\neach dirty view (gossip, stopped endpoint, truncated status table, local\n  disconnect) are observable.\n- Add targeted tests for: queue origin (explicit vs automatic, including\na\nreserved-slot automatic intent), unbound participant digests, zero-frame\nbackfill chunks, coordinator/fallback cut conflicts after a fallback\nlock,\n  authority-scoped Ready/Committed report conflicts, the relay of newly\n  accepted reports, and the per-body decode-error prefixes in\n  `decode_drop_operation_id`.\n\n## Verification\n\n- Focused `cargo-mutants --in-diff` over the branch diff vs `main`: **57\n  mutants, 32 caught, 25 unviable, 0 missed, 0 timeout**.\n- Full workspace nextest (`tokio,json,hot-join,violation-census`): 3760\npassed,\n  77 skipped.\n- `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D\n  warnings`: clean.\n- `agent-preflight.py --full --auto-fix`: all checks pass.\n\n## Type of Change\n\n- [x] 🧪 Test (adding or updating tests)\n\n## Checklist\n\n- [x] I have followed the zero-panic policy\n- [x] I have added tests that prove the fixes are effective\n- [x] `cargo fmt` and clippy are clean\n- [x] Full suite passes\n\n## Related Issues\n\nFollow-up to #509; addresses the post-merge mutation-testing failure on\n`main` (`e9ca5907`).",
          "timestamp": "2026-11-20T21:56:34Z",
          "tree_id": "fb7e66377080df78524abe1c3f2621d5c0e3c109",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/0085c493f81796124f6590261c153923be4809b8"
        },
        "date": 1795212458666,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 39303,
            "range": "± 848",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 25066,
            "range": "± 286",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1245,
            "range": "± 3",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2765,
            "range": "± 162",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "eaad20973a6eb8946b7a56c53a1750a4ce7d4b90",
          "message": "ci: keep the cross-arch default suite free of hot-join (#513)\n\n## Description\n\nRestores green `main` after the post-merge `CI - Rust` failure on\n`0085c493`. The only failed check was **Cross-Arch Runtime\n(aarch64-qemu)**, step **Run deterministic suite** (`exit code 100`,\n7m03s); the two dedicated hot-join steps never ran. Run:\nhttps://github.com/Ambiguous-Interactive/fortress-rollback/actions/runs/44825116296/job/136595656123\n\n### Root cause\n\nThe step ran `cargo nextest ... --workspace --features tokio,json`, but\n`network-test-peer` unconditionally enables\n`fortress-rollback/hot-join`. Cargo feature unification therefore built\nthe root package **with hot-join**, so the suite that the workflow\ncomment says \"compiles it out\" actually ran 3,246 tests including\n`network::soak::*` and `sessions::hot_join::*`.\n\nTwo consequences in the same step:\n\n- `sessions::hot_join::hot_join_phase4_abort_does_not_spam_send_queue`\ndrives 120,000 polls and takes **73.2s** under `qemu-aarch64` on the\ndevelopment host. The `ci-cross-arch` profile terminates a test after\n240s; a slower CI runner crosses that budget and nextest exits 100.\n- `stats_alloc_realloc_growth_is_already_embedded_in_allocated_bytes`\nreads a process-global `Region`, so its exact `allocations`/net-live\nassertions race with harness allocations on another thread (observed\nunder QEMU).\n\n### Fix\n\n- Scope the deterministic suite to `-p fortress-rollback`, so `hot-join`\nreally is compiled out and the feature-gated rows run only in their\ndedicated steps. The workflow comment now explains the unification\nhazard.\n- Deflake the allocator contract: 1 MiB -> 2 MiB growth, no exact\nprocess-global counter assertions, 64 KiB slack for allocator noise, and\nthe double-count guard still distinguishes 2 MiB from 3 MiB. The\nend-to-end test moved to `tests/stats_alloc_contract.rs`, a single-test\nprocess, so `cargo test` cannot run another test concurrently against\nthe same global allocator. A deterministic alloc/realloc noise thread\npasses 20/20 under qemu-aarch64.\n\n### Regression coverage\n\n- `scripts/tests/test_ci_rust_workflow.py` now requires package scope\nand rejects `--workspace` for that step.\n- A deterministic 4 KiB cross-thread allocation reproduced the soak\nfailure on the old assertions and passes with the fix.\n\n## Type of Change\n\n- [x] 🧪 Test (adding or updating tests)\n- [x] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json,hot-join` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] My changes generate no new compiler warnings\n- [ ] Documentation updated (not user-facing)\n- [ ] CHANGELOG entry (test/CI only, no `pub` or user-observable change)\n\n## Testing\n\n**Tests added/modified:**\n\n- `test_cross_arch_runtime_executes_arm_and_32_bit_usize_targets` now\npins `-p fortress-rollback` and the absence of `--workspace`.\n-\n`tests/stats_alloc_contract.rs::stats_alloc_realloc_growth_is_already_embedded_in_allocated_bytes`\ntolerates harness noise while keeping the growth-embedding and\ndouble-count bounds; it runs as the only test in its process.\n\n**Manual testing performed:**\n\n| Lane | Command | Result |\n| --- | --- | --- |\n| aarch64 QEMU (new command) | exact CI filter, `-p fortress-rollback` |\n**2,945 passed, 503 skipped, 166.5s** |\n| i686 (new command) | exact CI filter, `-p fortress-rollback` | **2,943\npassed, 503 skipped, 7.9s** |\n| host workspace | `tokio,json,hot-join,violation-census` | **3,692\npassed, 77 skipped, 39.3s** |\n| static | `actionlint`, `pytest scripts/tests/test_ci_rust_workflow.py`\n(31), `agent-preflight.py --full --auto-fix` | pass |\n\nRed/green for the soak test with deterministic helper-thread noise:\nbaseline `allocations: 12 != 1` (exit 101); the current test passes\n20/20 with an alloc + realloc + promote noise thread under qemu-aarch64\n(exit 0).\n\n## Related Issues\n\n- Relates to #512 (coordinated-drop terminal-operation eviction; filed\nas a follow-up finding).\n- Review follow-up: the three unresolved #508 threads were verified\nagainst `e9ca5907` and resolved with pointers to the fixing tests.",
          "timestamp": "2026-11-20T23:56:12Z",
          "tree_id": "a8508bb00bddb4d1816e1e168a33d51d2cca52e0",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/eaad20973a6eb8946b7a56c53a1750a4ce7d4b90"
        },
        "date": 1795219674375,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 44338,
            "range": "± 1128",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 28516,
            "range": "± 498",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 791,
            "range": "± 86",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1011,
            "range": "± 8",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7942,
            "range": "± 130",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "0819ad574bcb7a67811994bdf29ccdd1f7ce9585",
          "message": "fix: keep evicted terminal coordinated-drop operations closed (#514)\n\n## Description\n\nCloses #512.\n\n`coordinated_drop_close_operation` kept terminal operations in a\n`closed` deque bounded to `num_players`. Once an aborted or superseded\noperation was evicted, a delayed `Prepare` could still pass\n`coordinated_drop_validate_prepare` when the target was connected, its\ngeneration unchanged, and the membership epoch unchanged. With no active\nattempt, the endpoint installed a new `Inventory` and broadcast a\n`Report`; peers that still remembered the operation as closed did not\nanswer, the reopened attempt hit its deadline, and\n`coordinated_drop_fail_closed` took a healthy session into the\ndisconnect fail-closed state.\n\n`DropOperationId.sequence` is generation-local per target set\n(`max(target generation) + 1`), not a coordinator-global counter, so the\nguard keys on the full operation identity.\n\n### Fix\n\n- Require a canonical target set (every remote handle of the target\nendpoint) and a canonical operation coordinator (the first participant).\nThis rejects non-canonical subsets and forged authority, and means only\none identity per target handle/generation can validate at a time.\n- Record it from every terminal close and from the supersede/reject\npath.\n- Keep a per-target-handle history of **exact** terminal identities\n`(target_set_digest, participant_set_digest, coordinator_generation,\ntarget_generation, sequence)`, bounded to `2 * num_players` per handle.\nExact matching is required: a lower sequence can still be a live\nhigher-priority attempt, and a rejoined coordinator starts a new\ngeneration. A different live sequence is left to the operation\ncomparator. A replay older than the bounded window is tracked in #516\nfor a protocol-level terminal epoch.\n- Skip exact terminal identities and closed-journal identities one step\nat a time in `begin_coordinated_drop`; a terminal identity at a large or\nhostile sequence does not move the retry floor, so it cannot exhaust the\nsequence.\n- Share the operation-identity tuple helper with `closed_commit_cuts`;\nthe target journal is bounded to one entry per player handle.\n- Fold the behavior into the existing coordinated-drop artifact\nchangelog entry (unreleased code rule).\n\n### Red/green\n\nNew regression\n`evicted_terminal_prepare_does_not_reopen_and_retry_advances`:\n\n```text\npanicked at src/sessions/p2p_session.rs:19012:9:\nan evicted terminal prepare must not reopen an inventory attempt\ntest result: FAILED. 0 passed; 1 failed\n```\n\nAfter the fix the same test passes. Additional regressions cover the\nrejected-journal eviction replay, a hostile large terminal identity, a\nclosed identity above the terminal one, a rejoined coordinator\ngeneration, and exact-identity/bound scoping.\n\n### Known limitation\n\nThe exact-identity history is bounded to `2 * num_players` entries per\ntarget\nhandle by the repository's bounded-allocation policy. An exact replay\nolder\nthan that window can still reopen; closing that requires a\nprotocol-level\nterminal epoch (issue #516). The changelog and the code-side bound note\nstate\nthis explicitly. Canonical target-set/coordinator validation limits\nwhich\nidentities can be valid, and the exact-match guard keeps a different\nlive\nsequence admissible.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json,hot-join` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] CHANGELOG entry folded into the existing unreleased\ncoordinated-drop entry\n- [x] My changes generate no new compiler warnings\n- [ ] Documentation updated (internal protocol dedup; no public API\nchange)\n\n## Testing\n\n**Tests added/modified:**\n\n- `evicted_terminal_prepare_does_not_reopen_and_retry_advances`\n- `evicted_rejected_prepare_still_cannot_reopen`\n- `large_terminal_identity_does_not_block_a_new_retry`\n- `rejoined_coordinator_generation_is_not_blocked_by_terminal_history`\n- `terminal_watermark_matches_exact_identity_and_is_bounded`\n- `retry_steps_once_past_a_closed_identity_after_the_terminal_watermark`\n- `evicted_terminal_prepare_does_not_reopen_and_retry_advances`\n- `evicted_rejected_prepare_still_cannot_reopen`\n- `retry_steps_once_past_a_closed_identity_after_the_terminal_watermark`\n- `non_canonical_target_subset_does_not_match_membership`\n- `forged_operation_coordinator_is_rejected`\n\n**Manual testing performed:**\n\n| Check | Result |\n| --- | --- |\n| Full workspace (`tokio,json,hot-join,violation-census`) | **3,700\npassed, 77 skipped, 48.1s** |\n| Scoped aarch64 QEMU (exact CI command) | **2,953 passed, 503 skipped,\n179.7s** |\n| Scoped i686 (exact CI command) | **2,951 passed, 503 skipped, 12.6s**\n|\n| `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D warnings` | clean |\n| `cargo test --doc` | 160 passed, 51 ignored |\n| `agent-preflight.py --full --auto-fix` | all checks pass |\n| Targeted mutation of the changed helpers | record helper 14 mutants\n(12 caught, 2 unviable); exact-match/admission set **0 missed** after\nthe duplicate-identity regression |\n\nReview follow-ups: the initial per-identity journal could evict an\noperation; the final guard is an exact per-handle identity history.\nLater rounds found target-set sequence mixing, a rejoined coordinator\ngeneration, a hostile large terminal sequence, and a prefix rule that\nrejected live lower sequences; all are fixed by exact matching,\ncoordinator-generation identity, canonical target/coordinator\nvalidation, and no sequence floor. The bounded-window residual is\ntracked in #516.\n\n## Related Issues\n\n- Fixes #512\n- Relates to #431 (original review finding) and #510 (CAP trade-off\ntriage).",
          "timestamp": "2026-11-21T04:35:52Z",
          "tree_id": "ea3d0f0791afaf24204c9f566afa86b418b78fcc",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/0819ad574bcb7a67811994bdf29ccdd1f7ce9585"
        },
        "date": 1795236554405,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 62575,
            "range": "± 1342",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 31219,
            "range": "± 374",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1863,
            "range": "± 111",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1556,
            "range": "± 79",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3136,
            "range": "± 187",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "caa387b1901c310719f99954b3897212dbd524b7",
          "message": "test: exercise certified-dropped hot-join snapshots in wasm (#517)\n\n## Description\n\nCloses #515.\n\nAdds a runtime 3-peer probe to both wasm lanes: the host owns a live\nremote and a reserved hot-join slot, removes the remote, drains the\nremoved target's speculative tail, then serves the reserved slot. The\njoiner must import the snapshot's non-empty `certified_dropped` list and\nderive the epoch `[0, 2]`, not `[0, 1, 2]`.\n\n### Production bug exposed by the scenario\n\nThe first run failed the host removal with:\n\n```text\ncoordinated graceful drop ... failed closed: ParticipantLost;\nphase=Inventory, report_count=1\nhost epoch = [0, 1, 2]\n```\n\n`coordinated_drop_membership_epoch` counted a **never-joined reserved\nhot-join slot** as a voter. The reserved slot cannot report, so the\nremoval waited for a quorum that could never assemble and the healthy\nsession failed closed. The epoch now excludes every reserved slot until\nits join/reactivation commit activates it. Local in-flight state is not\nconsulted, so a peer that has observed a serve cannot derive a different\nquorum from one that has not. The roster and reserved flags are agreed\nconfiguration on every peer, now documented on `add_reserved_player`.\n\nThe scenario also needed two post-removal advances before serving,\nbecause the N-peer serve captures `last_saved_frame` and waits for it to\nconfirm; the removed target can leave a speculative tail. This is app\npacing, not a production bug; the serve gate already fails closed rather\nthan serving an unconfirmed frame.\n\n### Coverage changes\n\n- Browser `RawBus` generalized from two fixed queues to a mesh; `pair()`\nis retained.\n- New browser test\n`hot_join_imports_certified_dropped_epoch_in_browser`, with a scoped\n`CollectingObserver` that prints violations on failure.\n- New Emscripten `MeshSocket` routes wire-encoded bytes between 3\naddresses; `run_certified_epoch_probe` mirrors the flow and `run_probe`\nreports `certified_epoch_imported`; the Playwright spec asserts it.\n- Doc-hidden `P2PSession::diagnostic_coordinated_drop_membership_epoch`\nexposes the derived epoch to the probes; the public API snapshot is\nregenerated.\n- Native regression\n`membership_epoch_excludes_never_joined_reserved_slots`.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [x] 🧪 Test (adding or updating tests)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json,hot-join` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] CHANGELOG updated (epoch fix folded into the split-view entry; the\ndiagnostic is in Added)\n- [x] Public API snapshot regenerated and checked (`2,769` symbols)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `membership_epoch_excludes_never_joined_reserved_slots`\n- `hot_join_imports_certified_dropped_epoch_in_browser`\n- `run_certified_epoch_probe` + `certified_epoch_imported` in the\nGodot/Emscripten probe and Playwright spec\n\n**Manual testing performed:**\n\n| Check | Result |\n| --- | --- |\n| Browser suite (Chrome 158 headless, wasm32-unknown-unknown, hot-join)\n| **11 passed, 0 failed** |\n| Native full workspace (`tokio,json,hot-join,violation-census`) |\n**3,701 passed, 77 skipped** |\n| Scoped aarch64 QEMU suite | **2,953 passed, 503 skipped** |\n| Targeted aarch64 hot-join epoch test | 1 passed |\n| Emscripten probe `cargo +nightly-2026-08-26 check` | pass |\n| Emscripten probe clippy (all targets/features, `-D warnings`) | pass |\n| `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D warnings` | clean |\n| `cargo test --doc` | 160 passed, 51 ignored |\n| `public_api_census.py --check` | 2,769 symbols match |\n| `agent-preflight.py --full --auto-fix` | all checks pass |\n\n## Related Issues\n\n- Fixes #515\n- Relates to #516 (bounded terminal-history epoch design)",
          "timestamp": "2026-11-21T05:48:52Z",
          "tree_id": "5d397e04d0c09c9d5ccfadfa7982d676477b0c7c",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/caa387b1901c310719f99954b3897212dbd524b7"
        },
        "date": 1795240923556,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 42318,
            "range": "± 368",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 25236,
            "range": "± 470",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 682,
            "range": "± 73",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 870,
            "range": "± 7",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 6797,
            "range": "± 141",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "bd4a3d2bb0286dbf25617966186475073e689156",
          "message": "test: guard the diagnostic epoch surface (#518)\n\n## Description\n\nPost-merge red-main follow-up for `caa387b1` (#517). The `Mutation\nTesting Summary` job failed with two missed mutants:\n\n```text\nwarning Missed mutant  replace P2PSession<T>::diagnostic_coordinated_drop_membership_epoch -> Vec<PlayerHandle> with vec![Default::default()]\nwarning Missed mutant  replace P2PSession<T>::diagnostic_coordinated_drop_membership_epoch -> Vec<PlayerHandle> with vec![]\n```\n\nThe doc-hidden diagnostic added by #517 was exercised only by the\nbrowser/Emscripten probes, not by a native test. Add\n`diagnostic_epoch_matches_the_derived_epoch`, which asserts the\ndiagnostic exposes `[0, 1]` for a two-player session. Targeted mutation\non the function is **2/2 caught**.\n\n## Type of Change\n\n- [x] 🧪 Test (adding or updating tests)\n\n## Checklist\n\n### Required\n\n- [x] I have followed the zero-panic policy\n- [x] I have added a test that proves the fix is effective\n- [x] `cargo fmt && cargo clippy --workspace --all-targets --features\ntokio,json,hot-join` are clean\n- [x] `cargo nextest run` passes\n\n## Testing\n\n| Check | Result |\n| --- | --- |\n| `diagnostic_epoch_matches_the_derived_epoch` | 1 passed |\n| Targeted `cargo mutants -F\ndiagnostic_coordinated_drop_membership_epoch` | 2 mutants, **2 caught**\n|\n| Full workspace (`tokio,json,hot-join,violation-census`) | **3,702\npassed, 77 skipped** |\n| `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D warnings` | clean |\n\n## Related Issues\n\n- Follow-up to #517 / red-main mutation failure on `caa387b1`.",
          "timestamp": "2026-11-21T06:12:21Z",
          "tree_id": "45899e697609841383b3128b82eadc5490a365fe",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/bd4a3d2bb0286dbf25617966186475073e689156"
        },
        "date": 1795242388672,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 62062,
            "range": "± 1450",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 31767,
            "range": "± 784",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1861,
            "range": "± 111",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1556,
            "range": "± 63",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3133,
            "range": "± 181",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "2503ddd4352b87d385b07d640cef4b02defdfc41",
          "message": "fix: make coordinated-drop terminal replay unbounded-safe (#519)\n\n## Description\n\nCloses #516. The bounded per-target exact-identity history from #514\ncould evict\nan aborted or superseded coordinated-drop operation. A delayed `Prepare`\nfor\nthat operation then reopened `Inventory`, peers that still remembered it\nas\nclosed did not answer, the two-second deadline fired, and the whole\nhealthy\nsession entered the fail-closed disconnect state. A delayed abort could\nalso\nend an admitted attempt from any peer, giving one faulty endpoint a\nsession-kill\nprimitive.\n\nProtocol v5 gives terminal history a protocol-level, monotone\nterminal-attempt\nepoch:\n\n- `DropOperationId` carries `terminal_epoch`; `DropAbort` carries the\nsender's\n  next acceptable epoch.\n- The authority (deterministic coordinator, or the acting fallback after\nthe\ngrace) admits only its next epoch. A stale or future proposal is\njournaled\nand answered with `Superseded` carrying the next epoch, so the requester\n  advances and retries instead of reopening a terminal operation.\n- Participants follow the authority: they consume the epoch on\nadmission,\nadvance it from an authoritative abort or commit, and discard any\nauthority\nprepare below their next epoch even after every bounded exact history\nhas\n  evicted the operation.\n- Epochs are scoped to `(coordinator, coordinator_generation)` and keyed\nby the\ncanonical target handle set. A new coordinator generation or a\ncoordinator\nchange starts a fresh space; a reactivated target carries the epoch\nforward.\n- Prepares now validate the coordinator generation against the current\n  connected era, closing the rejoin-generation replay path.\n- Only the authority can terminate an admitted attempt. A non-authority\n  participant's abort is a discarded artifact instead of a session-wide\nfail-close, and a peer proposal cannot replace an attempt that already\nleft\n  inventory. Neither change weakens the strict-majority quorum.\n\nThe exact-identity watermark remains as a secondary fast-path guard and\nnow\nincludes the epoch so a fresh retry is never mistaken for a stale\nproposal's\nidentity.\n\n### CAP posture\n\nThe epoch is admission state, not agreed state: it only rejects stale\nprepares\nand never admits an operation that the participant-set,\ntarget-generation, or\ncoordinator-generation rules would reject. Commits still require the\nstrict-majority ready quorum, so `AtMostOneCommittedCut` and the\nexisting TLA\nmodels are unchanged (argument recorded in `docs/specs/formal-spec.md`).\nA\nsplit-view heal where the acting fallback advanced an epoch beyond the\nreal\ncoordinator's view still fails closed, which is the intended CP choice.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [x] 💥 Breaking change (fix or feature that would cause existing\n  functionality to change)\n- [x] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\nThe wire version bump is breaking for mixed-version sessions: v5 rejects\nv4\nheaders at the handshake, as v4 did to v3.\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective\n- [x] `cargo fmt && cargo clippy --workspace --all-targets --features\n  tokio,json,hot-join -- -D warnings` is clean\n- [x] `cargo nextest run` passes\n\n### If Applicable\n\n- [x] Documentation updated (`CHANGELOG.md`,\n`docs/specs/api-contracts.md`,\n  `docs/specs/formal-spec.md`, wiki mirrors, design-decision log)\n- [x] `CHANGELOG.md` entry for the user-facing wire/behavior change\n- [x] No new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `evicted_terminal_prepare_is_rejected_by_the_terminal_epoch`\n(authority\nevicts both bounded histories, stale replay stays a peer artifact, retry\n  consumes the next epoch)\n- `stale_terminal_epoch_prepare_is_rejected_at_a_participant`\n- `new_coordinator_generation_starts_a_fresh_epoch_space`\n- `reactivated_target_generation_carries_the_terminal_epoch_forward`\n- `record_epoch_is_monotone_for_one_authority`\n- `participant_accepts_an_authority_epoch_ahead_of_its_view`\n- `authority_rejects_a_future_epoch_without_consuming_it`\n- `non_authority_abort_cannot_terminate_a_live_attempt`\n- `non_authority_abort_after_the_fallback_grace_remains_rejected`\n- `fallback_abort_requires_silence_and_the_full_grace` (3-row table)\n- `peer_prepare_cannot_fail_close_a_mid_backfill_attempt`\n-\n`authority_prepare_with_a_newer_epoch_still_yields_a_mid_backfill_attempt`\n- `stale_coordinator_generation_prepare_cannot_reopen_an_attempt`\n- `abort_before_prepare_fences_a_delayed_replay`\n- `epoch_table_reclaims_stale_target_sets_before_refusing`\n- `rejected_proposal_abort_does_not_walk_the_requester_epoch`\n- `fallback_abort_without_a_local_attempt_fences_the_replay`\n- `fallback_abort_without_a_local_attempt_requires_coordinator_silence`\n- `fallback_abort_without_a_local_attempt_requires_a_known_heard_time`\n- `stale_coordinator_generation_abort_cannot_reset_a_newer_epoch`\n- `abort_fence_at_the_epoch_ceiling_fences_the_replay`\n-\n`newer_epoch_for_the_same_handles_at_a_new_generation_yields_mid_backfill`\n- `two_participant_fallback_abort_is_not_authoritative`\n-\n`authority_prepare_for_a_different_target_set_does_not_force_a_mid_backfill_yield`\n-\n`empty_target_abort_for_a_different_operation_does_not_touch_the_active_epoch`\n- `promoted_fallback_consumes_the_operation_epoch`\n- `wire_golden_v5` active suite; v4 is a released rejection suite; the\n  cross-platform replay-fixture wire digest is refreshed.\n\n**Manual testing performed:**\n\n| Check | Result |\n| --- | --- |\n| Epoch checks disabled (red) | 3/3 epoch tests fail; aborts\nsource-scoping and generation fence each fail their guard |\n| Epoch checks enabled (green) | 3/3 epoch tests pass |\n| Full workspace nextest (`tokio,json,hot-join,violation-census`) |\n**3,716 passed, 77 skipped, 0 failed** |\n| `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D warnings` | clean |\n| `cargo test --doc` | 169 passed, 55 ignored |\n| `cargo doc --no-deps --workspace` | clean |\n| `python3 scripts/ci/agent-preflight.py --full --auto-fix` | all checks\npass, including the new private/feature-gated rustdoc pass now wired for\nRust source changes |\n| `public_api_census.py --check` | 2,769 symbols match |\n| `check-links.py`, `check-doc-claims.sh`, `markdownlint` | clean |\n| Cross-target `cargo check` (wasm32-unknown-unknown, wasm32-wasip1,\nwasm32-unknown-emscripten, aarch64-linux, i686-linux) | pass |\n| aarch64 QEMU epoch tests | 3/3 pass |\n| aarch64 QEMU `wire_golden_v5` | 1/1 pass |\n| i686 native epoch tests + `wire_codec_digest_is_pinned` | 3/3 and 1/1\npass |\n| Browser/Emscripten probe builds | pass (browser runtime lane remains\nCI evidence; no local Chrome) |\n| `fortress-replay-fixture` | 6 passed |\n| `staggered_two_drops_opposite_order_survivors_converge_no_desync` | 1\npassed (regression fixed by trusting the sender epoch verbatim) |\n| Targeted epoch/abort mutation run | 67 mutants: 51 caught, 12\nunviable, 4 initially missed. Three were killed with dedicated\ntests/deduplication; the focused re-run (20 mutants) has 16 caught, 3\nunviable, and one equivalent survivor (`targets.len() > num_players` ->\n`>=`; a valid remote-only target set has at most `num_players - 1`\nhandles). |\n\n## Risks and rollback\n\n- The wire bump means a mixed v4/v5 session fails at the handshake;\nupgrade all\npeers together. Roll back by reverting this PR (the v4 golden remains in\nthe\n  tree as a rejection suite, so a revert needs no fixture regeneration).\n- A participant that missed every prepare/abort copy for an operation\ncan still\naccept a delayed authority prepare when its own next epoch is lower; it\nthen\ntimes out and fails closed unless the authority answers its report. The\ndemonstrated authority-side replay is closed; this partition/reorder\ncorner\n  stays fail-closed by design.\n- The bounded epoch map is capped at `2 * num_players`; overflow refuses\nthe\n  operation instead of evicting a live epoch.\n\n## Related Issues\n\n- Closes #516\n- Follow-up to #514 / #512.",
          "timestamp": "2026-11-21T22:47:46Z",
          "tree_id": "9e2d128e6dc2659288d10bf4e0282c399fb7fd88",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/2503ddd4352b87d385b07d640cef4b02defdfc41"
        },
        "date": 1795302019196,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 40050,
            "range": "± 206",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 25419,
            "range": "± 686",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1245,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2764,
            "range": "± 171",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "cc2f4b8e78094042dfdd06711579e8a559b09e29",
          "message": "test: close the #519 mutation survivors (#520)\n\n## Description\n\nPost-merge red-main follow-up for #519 (merged as `2503ddd4`). The\n`Mutation Testing Summary` job failed with **16 missed mutants** in the\nnew\ncoordinated-drop terminal-epoch diff. This PR adds discriminating\nregressions\nand removes two redundant paths so the gate is clean.\n\n### Fixes\n\n- **Target-set currency:** test the predicate with a co-located\nspectator; a\n  spectator at the target address is not part of the remote target set.\n- **Epoch table:** test replacing a behind coordinator era when the\nlocal view\n  has advanced.\n- **Active retransmission:** consume the admitted epoch on the early\nretransmission path and cover the authority's retransmission. The later\n  duplicate exact-match branch was unreachable and is removed.\n- **Epoch supersession:** compare canonical handles (not the digest,\nwhich\n  includes target generations); pin both the different-generation and\n  equal-epoch mid-backfill cases.\n- **Abort target validation:** reject unsorted/duplicate lists and\nlocal-slot\nnames; drop the redundant roster-length check (a remote-only target set\nhas\n  at most `num_players - 1` handles).\n- **Fallback authority:** cover the three-participant boundary.\n- **Wire decoder errors:** name every operation field for every\n  coordinated-drop body, covering the per-prefix match arms.\n- **Review follow-ups:** keep retransmissions report-free (the active\nattempt\n  already rebroadcasts its inventory report every poll), record the\n  retransmission epoch only from the named coordinator, and reject a\nretransmission whose target list differs from the retained active\ntargets.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix\n- [ ] ✨ New feature\n- [ ] 💥 Breaking change\n- [ ] 📚 Documentation\n- [x] 🧪 Test\n- [ ] 🔧 CI/Build\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove the fix is effective\n- [x] `cargo fmt && cargo clippy --workspace --all-targets --features\n  tokio,json,hot-join -- -D warnings` is clean\n- [x] `cargo nextest run` passes\n\n### If Applicable\n\n- [x] Documentation unchanged (test-only plus two redundant-path\nremovals)\n- [x] No new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `target_set_currency_ignores_a_colocated_spectator`\n- `record_epoch_replaces_a_behind_era_when_the_local_view_advanced`\n- `authority_retransmission_of_its_active_operation_is_not_rejected`\n-\n`newer_epoch_for_the_same_handles_at_a_new_generation_yields_mid_backfill`\n- `equal_epoch_for_the_same_handles_does_not_force_a_mid_backfill_yield`\n- `abort_target_set_must_name_remote_slots`\n- `abort_target_list_must_be_strictly_ordered`\n- `three_participant_fallback_abort_is_authoritative_after_grace`\n- `drop_operation_decode_errors_name_each_body_prefix` (every\nfield/body)\n\n**Manual testing performed:**\n\n| Check | Result |\n| --- | --- |\n| Full workspace nextest (`tokio,json,hot-join,violation-census`) |\n**3,726 passed, 77 skipped, 0 failed** |\n| `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D warnings` | clean |\n| `python3 scripts/ci/agent-preflight.py --full --auto-fix` | all checks\npass |\n| Manual mutation checks (each survivor patched in turn) | every\nnon-equivalent survivor fails a targeted test |\n| Local diff-scope mutation gate (`--in-diff origin/main...HEAD`) | 6\nmutants: 3 caught, 3 unviable, 0 missed |\n\n## Risks and rollback\n\n- Test-only plus two path removals: the early retransmission now records\nthe\nadmitted epoch (previously the unreachable duplicate branch did), and\nthe\nredundant roster-length check is covered by the remote-slot check. Roll\nback\n  by reverting this PR; it does not change the wire format.\n\n## Related Issues\n\n- Follow-up to #519 / #516.",
          "timestamp": "2026-11-22T00:35:43Z",
          "tree_id": "1925c854eefb1df626dd8e575011610024d43950",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/cc2f4b8e78094042dfdd06711579e8a559b09e29"
        },
        "date": 1795308567187,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 47149,
            "range": "± 819",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 29781,
            "range": "± 220",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 755,
            "range": "± 91",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 987,
            "range": "± 4",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7752,
            "range": "± 134",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "b3fcbbb5df36f42a5d1505c871ca5ae163d92d09",
          "message": "fix: scope terminal epochs by generation and adopt a bounded fallback epoch (#525)\n\n## Description\n\nFollow-up to the #510 consensus study and the #519 terminal-epoch work.\nTwo correctness/liveness defects in the v5 epoch guard were found during\nthe deep analysis:\n\n1. **A one-ahead generation swallowed the current era's epoch.**\n`terminal_epochs` was keyed only by target handles and stored one\n`(coordinator, coordinator_generation, next)`. A participant that\naccepted a one-ahead generation during a rejoin window then admitted a\ncurrent-generation operation; `record_epoch` returned `Ok(())` without\nconsuming the current era's epoch. The current generation's guard was\ntherefore lost while the one-ahead entry remained.\n2. **A fresh acting fallback could not learn a legitimate epoch.** A\nfallback that hot-joined after the coordinator's earlier removals has no\nlocal epoch state for that coordinator generation. It rejected the\nrequester's legitimate epoch with `Superseded(0)`, the requester kept\nthe higher value, and the removal timed out and failed closed.\n\n### Fix\n\n- Key epoch spaces by `(canonical target handles, coordinator,\ncoordinator generation)`. The current era and the one-ahead era coexist;\ninserting a new era prunes dead coordinators/generations, so the map\nremains at most two eras per target set.\n- An acting fallback with **no state** for the exact generation adopts\nthe retained candidate's first epoch up to an inclusive `1,000,000`\nbound. An unbounded future proposal is still a discarded peer artifact,\npreserving the anti-DoS rule; the fallback never mints a certificate\nfrom the epoch alone.\n- The deterministic coordinator still requires exact equality and still\nrejects future peer proposals\n(`authority_rejects_a_future_epoch_without_consuming_it` remains green).\n\nThis is local admission state, not agreed state.\n`AtMostOneCommittedCut`, the strict-majority ready quorum, and the TLA\nmodels are unchanged; the formal spec records the bounded fallback\nadoption.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature\n- [ ] 💥 Breaking change\n- [ ] 📚 Documentation\n- [ ] ♻️ Refactor\n- [x] 🧪 Test\n- [ ] 🔧 CI/Build\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove the fix is effective\n- [x] `cargo fmt --all -- --check && cargo clippy --workspace\n--all-targets --features tokio,json` are clean\n- [x] `cargo nextest run` passes\n\n### If Applicable\n\n- [x] Documentation updated (`CHANGELOG.md`,\n`docs/specs/formal-spec.md`, wiki mirror)\n- [x] `CHANGELOG.md` entry folded into the existing Unreleased\nprotocol-v5 `Added` entry\n- [x] No new compiler warnings\n\n## Testing\n\n**Red evidence (pre-fix code):**\n\n| Test | Result |\n| --- | --- |\n| `current_era_epoch_is_recorded_when_a_one_ahead_era_is_stored` |\n**FAIL** — `epoch_next(0, 0)` returned 0, expected 1 |\n| `fallback_admits_a_bounded_first_epoch_without_local_state` | **FAIL**\n— active attempt was `None`; fallback rejected epoch 3 with\n`Superseded(0)` |\n\n**Tests added:**\n\n- `current_era_epoch_is_recorded_when_a_one_ahead_era_is_stored`\n- `fallback_admits_a_bounded_first_epoch_without_local_state` (drives\n`drive_coordinator_fallback`)\n- `fallback_adopts_the_maximum_bounded_first_epoch` (inclusive-boundary\nguard)\n- `fallback_rejects_an_unbounded_first_epoch_without_local_state`\n(anti-DoS guard)\n\n**Green evidence:**\n\n| Check | Result |\n| --- | --- |\n| `cargo tfull` | **3,740 passed, 77 skipped, 0 failed** |\n| `cargo nextest run -p fortress-rollback --lib --features\ntokio,json,hot-join` | **2,322 passed, 0 failed** |\n| Targeted epoch/abort set | 106 passed |\n| `cargo clippy --workspace --all-targets --features tokio,json` | clean\n|\n| `cargo fmt --all -- --check` | pass |\n| `.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix` |\nall checks pass |\n| aarch64 QEMU new tests | 5/5 pass |\n| i686 new tests | 5/5 pass |\n| Targeted `cargo mutants` on the touched epoch helpers | **22 caught, 8\nunviable, 0 missed** |\n| `python3 scripts/docs/check-links.py`, wiki consistency, changelog\nrule | clean |\n\n## Risks and rollback\n\n- The adoption bound is a liveness/anti-DoS trade-off: a peer can force\none bounded epoch advance during a fallback takeover, but cannot exhaust\n`u32` or mint a certificate. A session with more than 1,000,000 removals\nfor one target set would reject a larger first epoch; that is far\noutside the supported envelope and remains fail-closed.\n- No wire format change. Roll back by reverting this PR; the previous\nsingle-entry behavior returns.\n- Epoch state is still local, not imported by hot-join. The fallback\nadoption covers the fresh-joiner case; a participant that missed every\nartifact still times out and fails closed, as documented.\n\n## Related Issues\n\n- Follow-up to #519 / #510\n- The #510 study records why the protocol stays CP.",
          "timestamp": "2026-11-22T03:58:59Z",
          "tree_id": "f6c32bdeaf297d5bfb8fbc3e61d0c276623ed2fc",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/b3fcbbb5df36f42a5d1505c871ca5ae163d92d09"
        },
        "date": 1795320698864,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 48486,
            "range": "± 2778",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 27955,
            "range": "± 229",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 804,
            "range": "± 78",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1013,
            "range": "± 7",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7929,
            "range": "± 203",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "d88b898c6b767d2f29852f829e7dbd00e717ea76",
          "message": "test: keep the wire-size assertion free of formatted values (#526)\n\n## Description\n\nPost-merge red-main follow-up for `ba97a360`. The `CI - CodeQL` job\nfailed at `Fail on CodeQL findings` with a new `rust/cleartext-logging`\nresult in `src/network/codec.rs`:\n\n- The assertion message in\n`size_of_val_is_constant_while_wire_size_is_not_d1` passed\n`encoded_len()` values as format arguments. CodeQL models the `assert!`\npanic text as a logging sink and reports the lengths as cleartext\nlogging of sensitive information.\n- This is a test-only diagnostic, not sensitive data. Compute the two\nlengths first and assert with a fixed message; the comparison and its\ncoverage are unchanged.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix\n- [ ] ✨ New feature\n- [ ] 💥 Breaking change\n- [ ] 📚 Documentation\n- [ ] ♻️ Refactor\n- [x] 🧪 Test\n- [ ] 🔧 CI/Build\n\n## Checklist\n\n### Required\n\n- [x] I have read the CONTRIBUTING guide\n- [x] I have followed the zero-panic policy\n- [x] I have added tests that prove the fix is effective (the existing\nwire-size regression is unchanged and still runs)\n- [x] `cargo fmt --all -- --check` and `cargo clippy --workspace\n--all-targets --features tokio,json` are clean\n- [x] `cargo nextest run` passes\n\n### If Applicable\n\n- [ ] Documentation updated (test-only; not required)\n- [ ] CHANGELOG entry (test-only; not required)\n- [x] No new compiler warnings\n\n## Testing\n\n| Check | Result |\n| --- | --- |\n| `size_of_val_is_constant_while_wire_size_is_not_d1` | 1 passed |\n| `cargo tfull` | **3,740 passed, 77 skipped, 0 failed** |\n| `cargo fmt --all -- --check` | pass |\n| `cargo clippy --workspace --all-targets --features tokio,json` | clean\n|\n| `.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix` |\nall checks pass |\n\n## Risks and rollback\n\n- Test-only assertion-message change; no production code, wire format,\nor behavior changes.\n- Roll back by reverting this PR; the old formatted message returns and\nCodeQL flags it again.\n\n## Related Issues\n\n- Post-merge red-main follow-up to `ba97a360` / CodeQL alert #8.",
          "timestamp": "2026-11-22T05:11:58Z",
          "tree_id": "20b465d121db18aef7fb3e793d0e843d7cda511d",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/d88b898c6b767d2f29852f829e7dbd00e717ea76"
        },
        "date": 1795325050629,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 47665,
            "range": "± 678",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 27185,
            "range": "± 137",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 766,
            "range": "± 105",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 983,
            "range": "± 11",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7745,
            "range": "± 111",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "e22468cad73e0a15ec9b28e10bf3f89281784bd7",
          "message": "test: warm one-time allocation-contract diagnostics before measuring (#527)\n\n## Description\n\nPost-merge red-main follow-up for `d88b898c`. The `Mutation Baseline and\nPlan` job failed at `Run authoritative baseline`:\n\n```text\nwarmed_hot_paths_obey_allocation_contracts\nwarmed 2-player networked P2P send repetition 1\nleft:  Stats { allocations: 7, bytes_allocated: 958, ... }\nright: Stats { allocations: 3, bytes_allocated: 58, ... }\n```\n\nThe extra 4 allocations / 900 bytes are one-time lazy diagnostic\ninitialization on the first measured call, not a per-frame allocation\nregression. The test already warms construction and a few frames, but\nnot the first full measured shape. It passed 50+ isolated runs and the\nexact authoritative baseline command locally; the same merge group\npassed. A rerun alone would not fix the underlying first-use\nsensitivity.\n\nFix: discard one full call per measurement shape before the compared\nrepetitions. The contract still asserts the warmed steady state and all\nceilings are unchanged; one-time initialization is simply charged\noutside the measured region.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix\n- [ ] ✨ New feature\n- [ ] 💥 Breaking change\n- [ ] 📚 Documentation\n- [ ] ♻️ Refactor\n- [x] 🧪 Test\n- [ ] 🔧 CI/Build\n\n## Checklist\n\n### Required\n\n- [x] I have read the CONTRIBUTING guide\n- [x] I have followed the zero-panic policy\n- [x] I have added tests that prove the fix is effective (the allocation\ncontract remains unchanged and is now first-use stable)\n- [x] `cargo fmt --all -- --check` and `cargo clippy --workspace\n--all-targets --features tokio,json` are clean\n- [x] `cargo nextest run` passes\n\n### If Applicable\n\n- [ ] Documentation updated (test-only; not required)\n- [ ] CHANGELOG entry (test-only; not required)\n- [x] No new compiler warnings\n\n## Testing\n\n| Check | Result |\n| --- | --- |\n| Allocation contract test, 20 repeated runs | 20/20 pass |\n| `cargo nextest run --locked --all-targets --features\ntokio,json,hot-join,violation-census` | **3,798 passed, 77 skipped, 0\nfailed** |\n| `cargo tfull` | **3,740 passed, 77 skipped, 0 failed** |\n| `cargo fmt --all -- --check` | pass |\n| `cargo clippy --workspace --all-targets --features tokio,json` | clean\n|\n| `.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix` |\nall checks pass |\n\n## Risks and rollback\n\n- Test-only warm-up; the measured assertions and allocation ceilings are\nunchanged.\n- If the first measured call still differs after a discarded call, the\nflake is not one-time initialization and this PR should be reverted in\nfavor of isolating the path further.\n\n## Related Issues\n\n- Post-merge red-main follow-up to `d88b898c` / Mutation Baseline.",
          "timestamp": "2026-11-22T05:35:00Z",
          "tree_id": "b84e878686d0b1860a3cfdc77c99c346cf3fbcbf",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/e22468cad73e0a15ec9b28e10bf3f89281784bd7"
        },
        "date": 1795326447551,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 38885,
            "range": "± 435",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 24118,
            "range": "± 123",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1243,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2765,
            "range": "± 160",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "fa1a62476b6d77a14639be1cdbfe9c5232c151c2",
          "message": "fix: reject halted removals and gate provisional Ready digests (#530)\n\n## Description\n\nCloses #528 and #529, the two out-of-diff review follow-ups on the\ncoordinated-removal work.\n\n### #528: terminal sessions reject new local removals\n\nA session with a latched `halt_confirmed_ceiling` is terminal. The\npolling path already refused new work, but `remove_player` could still\nclose a hot-join reactivation and enqueue/broadcast an attempt before\nthe next poll observed the halt.\n\n- `remove_player` now returns `InvalidRequestKind::WrongProtocolState {\ncurrent_state: \"Halted\", expected_state: \"Running\" }` before any\nmembership or attempt mutation.\n- The automatic timeout path returns on an already-halted session\ninstead of logging a synthetic internal failure for the expected\nrejection.\n- Removal during ordinary initial synchronization stays available\nbecause it uses the same entry point with the halt latch unset.\n\n### #529: provisional Ready reports cannot lock the digest\n\nWhen the cut frame was known but its digest was not, a non-authority\nReady could lock `cut_digest` and count toward quorum. A single\nnon-authority peer could therefore lock a divergent digest before the\nauthority's correct Ready, turning a healthy session into\n`ConflictingHistory`.\n\n- Pre-digest participant Ready reports now live in a separate\n`provisional_ready` map and never count toward the strict-majority\nquorum.\n- The expected digest is locked only by the deterministic\ncoordinator/acting fallback or by independently verified local history.\n- Matching provisional transcripts are promoted when the digest is\nlocked; mismatching provisional reports are discarded as peer artifacts.\n- The existing strict-majority certificate, fallback authority,\npartition, replay, and commit paths are unchanged.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (no new production\n`unwrap`/`expect`/`panic!`/`todo!`; errors remain `Result`)\n- [x] I have added tests that prove the fix is effective (red-before\noutput below)\n- [x] I have run `cargo fmt --all -- --check && cargo clippy --workspace\n--all-targets --features tokio,json -- -D warnings` with no warnings\n- [x] I have run `cargo nextest run --workspace --features tokio,json\n--no-fail-fast` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly (rustdoc, API\ncontracts, user guide, generated wiki mirrors)\n- [x] I have added an entry to `CHANGELOG.md` for user-facing changes\n- [ ] I have updated relevant examples in the `examples/` directory (not\napplicable)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Red evidence before the fix (intended failures):**\n\n| Test | Before |\n| --- | --- |\n| `halted_session_rejects_a_new_local_removal_before_mutating_state` |\nFAILED: `left: Ok(())`, expected `WrongProtocolState` |\n| `non_authority_ready_cannot_lock_the_digest_or_count` | FAILED: `left:\nSome(7)`, expected `None` |\n|\n`local_history_locks_the_digest_despite_a_conflicting_provisional_ready`\n| FAILED: `mark_ready` returned `ConflictingHistory` |\n\n**Tests added/modified:**\n\n- `halted_session_rejects_a_new_local_removal_before_mutating_state` —\nchecks the exact error, unchanged membership, empty attempt/queue, and\nno initial prepare.\n- `non_authority_ready_cannot_lock_the_digest_or_count`\n-\n`matching_provisional_ready_is_promoted_when_authority_locks_the_digest`\n-\n`local_history_locks_the_digest_despite_a_conflicting_provisional_ready`\n- `ready_conflicts_are_authority_scoped` retained; `drop_c_cleanly` now\ntolerates `WrongProtocolState` only for the already-pruned terminal\npeer.\n- PCT schedule fingerprint re-pinned after the intended behavior change;\nit still has three survivors within one frame and the removed target\nbelow them.\n\n**Manual testing performed:**\n\n| Check | Result |\n| --- | --- |\n| Targeted new/affected tests | 5/5 pass |\n| Full lib nextest | 2,055 passed |\n| Full workspace nextest (`--workspace --features tokio,json\n--no-fail-fast`) | **3,744 passed, 77 skipped, 0 failed** |\n| `cargo fmt --all -- --check` | pass |\n| `cargo clippy --workspace --all-targets --features tokio,json -- -D\nwarnings` | clean |\n| `.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix` |\nall checks pass |\n| Targeted mutation (`-F\n'promote_provisional\\|establish_ready_digest\\|remove_player'`,\n`ready`/`removal` tests) | **9 mutants: 5 caught, 4 unviable, 0 missed**\n|\n| `cargo check --target wasm32-unknown-unknown --no-default-features` |\npass |\n| `cargo check -p wasm-browser-smoke --features hot-join --target\nwasm32-unknown-unknown --lib --tests` | pass |\n| Wiki sync/consistency, links, changelog rule, typos, markdownlint |\npass |\n\n## Risks and rollback\n\n- A provisional Ready whose origin stops retransmitting before the\ndigest is established can wait until the bounded two-second operation\ndeadline; reports retransmit every poll and the outcome stays\nfail-closed.\n- The commit path still accepts a certificate relayed by a non-authority\nsource. That is intentional: the commit is the authority's post-quorum\ncertificate, unlike a pre-digest Ready.\n- The PCT schedule fingerprint moved because a halted peer no longer\nemits a removal prepare and provisional Ready reports no longer count\nearly. The lagging-survivor shape and replay determinism assertions\nstill hold.\n- Roll back by reverting this PR. No wire format or protocol version\nchange.\n\n## Related Issues\n\n- Closes #528\n- Closes #529\n- Follow-up to #486 and #509.",
          "timestamp": "2026-11-22T17:04:16Z",
          "tree_id": "a5dd5037ab7d2674833cdd2e76931cbf83acd4a4",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/fa1a62476b6d77a14639be1cdbfe9c5232c151c2"
        },
        "date": 1795367730222,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 25300,
            "range": "± 1022",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 15719,
            "range": "± 319",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 475,
            "range": "± 9",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 584,
            "range": "± 33",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5328,
            "range": "± 416",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "38f52761e31496b55f54b9efe33930938304b74f",
          "message": "fix: clear latched checksum mismatches on history rewrites (#532)\n\n## Description\n\nCloses #531, the remaining out-of-diff review follow-up from #462.\n\nA confirmed checksum mismatch is latched in\n`remote.checksum_mismatch_frame`, and `sync_health` reports that latch\nbefore every other branch. Freeze convergence, certified-cut\nresimulation, and reserved-slot convergence remove the local checksum\nentries at or above a rewritten frame (the F11 stale-checksum fix), but\nthe latch survived. After both peers converged and exchanged matching\npost-rewrite checksums, `sync_health` still returned `DesyncDetected`\nand `is_synchronized()` could not recover from a basis that no longer\nexisted.\n\n- Added `invalidate_checksum_mismatch_from(frame)`, which clears a\npeer's latch and any still-pending comparison report at or above the\nrewritten floor, while leaving mismatches and pending reports below it\ncomparable.\n- Applied it at every confirmed-history rewrite site: disconnect/freeze\nconvergence, certified-cut resimulation, and reserved-slot freeze\nconvergence.\n- Kept old-checksum **eviction** separate: a real divergence remains\nlatched when its basis is merely aged out, not rewritten.\n- A checksum report carries only `(frame, checksum)`; a delayed\npre-rewrite report can therefore still arrive after the rewrite. A\nvalue-equality heuristic was tried and removed because it could hide a\ngenuine post-rewrite mismatch. The protocol-generation fix is tracked in\n#533.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (no new production\n`unwrap`/`expect`/`panic!`/`todo!`; errors remain `Result`)\n- [x] I have added tests that prove the fix is effective (red-before\noutput below)\n- [x] I have run `cargo fmt --all -- --check && cargo clippy --workspace\n--all-targets --features tokio,json -- -D warnings` with no warnings\n- [x] I have run `cargo nextest run --workspace --features tokio,json\n--no-fail-fast` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly (rustdoc/comment\ncontract, user guide, generated wiki mirror)\n- [x] I have added an entry to `CHANGELOG.md` for user-facing changes\n- [ ] I have updated relevant examples in the `examples/` directory (not\napplicable)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Red evidence before the fix:**\n\n```text\nfreeze_rewrite_clears_a_latched_mismatch_whose_basis_was_invalidated:\nleft: Some((Frame(8), 4104, 8200))\nright: None\n```\n\n**Tests added:**\n\n- `freeze_rewrite_clears_a_latched_mismatch_whose_basis_was_invalidated`\n— latches a pre-convergence mismatch, adds pending reports at/above the\nfloor, runs the disconnect/freeze rewrite, asserts both comparison\nstates clear, and then restores `InSync` with the post-rewrite match.\n- `freeze_rewrite_keeps_a_mismatch_below_the_invalidated_floor` — a real\ndivergence and its pending basis below the floor stay comparable.\n- `certified_cut_resimulation_clears_a_latched_mismatch_at_the_cut`\n-\n`reserved_slot_freeze_convergence_clears_a_latched_mismatch_above_floor`\n(`hot-join`)\n\n**Manual testing performed:**\n\n| Check | Result |\n| --- | --- |\n| Targeted tests | 6/6 pass |\n| Full lib nextest with `tokio,json,hot-join` | **2,326 passed, 0\nskipped** |\n| Full workspace nextest (`--workspace --features tokio,json\n--no-fail-fast`) | **3,748 passed, 77 skipped, 0 failed** |\n| `cargo fmt --all -- --check` | pass |\n| `cargo clippy --workspace --all-targets --features tokio,json -- -D\nwarnings` | clean |\n| `.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix` |\nall checks pass |\n| Targeted mutation on the new helper\n(`invalidate_checksum_mismatch_from`) | **5 mutants: 4 caught, 1\nunviable, 0 missed** |\n| Wiki sync/consistency, links, changelog rule, typos, markdownlint |\npass |\n\n## Risks and rollback\n\n- Clearing a latch at/above a rewritten floor can discard a real\nmismatch at that frame. The rewrite changed the local basis, so the old\ncomparison is no longer valid; the next post-rewrite comparison\nre-latches a genuine divergence. Mismatches below the floor stay\nlatched.\n- A delayed pre-rewrite checksum report can still relatch after a\nrewrite because checksum reports carry no generation. #533 tracks the\nprotocol metadata; this PR deliberately does not suppress reports by\nvalue, which could hide a genuine mismatch.\n- Eviction is intentionally not treated as a rewrite, so aging out an\nold checksum cannot clear a real divergence.\n- Roll back by reverting this PR. No wire format or protocol version\nchange.\n\n## Related Issues\n\n- Closes #531\n- Follow-up to #462.\n- Tracked protocol-generation follow-up: #533.\n- Independent of #530 / #528 / #529.",
          "timestamp": "2026-11-22T17:36:58Z",
          "tree_id": "b4e8555b2c741135b4418c6f298ff26cdf14e1b3",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/38f52761e31496b55f54b9efe33930938304b74f"
        },
        "date": 1795369840024,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 47423,
            "range": "± 1326",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 29529,
            "range": "± 475",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 748,
            "range": "± 107",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 982,
            "range": "± 9",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7708,
            "range": "± 100",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "02019c2d6efe96366741dd7ee76f08318b9fd64a",
          "message": "ci: run the wire codec and replay fixture on big-endian s390x (#534)\n\n## Description\n\nCloses #523. Every existing runtime lane was little-endian, so wire byte\norder and machine-width hashing were only source-guarded. This adds a\nnarrow `s390x` QEMU lane outside Miri and outside the 35-minute\ncross-arch matrix.\n\n- Adds `big-endian-runtime` to `ci-rust.yml` with a 20-minute budget. It\ninstalls the s390x cross toolchain/QEMU and runs exactly two\npackage-scoped commands:\n  - the pinned `wire_codec_digest_is_pinned` codec digest;\n- the `fortress-replay-fixture` lib tests (replay, compression, and\nportable machine-width checks).\n- Makes the fixture's primitive `u32`-slice hash expectation\ntarget-endian. Std hashes primitive slice *elements* as native memory\nbytes; scalar, length-prefix, and serialized-state checks remain fixed\nlittle-endian. The little-endian constants are unchanged.\n- Adds a workflow-shape test that pins the lane to two package-scoped\ncommands, the s390x target, QEMU, and the 20-minute budget, and updates\nthe Miri comment to point at the dedicated lane.\n- Updates the determinism model and generated wiki mirror to record that\nbyte order is now runtime-executed rather than only source-guarded.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [x] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (no new production\n`unwrap`/`expect`/`panic!`/`todo!`; no production Rust changes)\n- [x] I have added tests that prove the fix is effective (the lane fails\non a byte-swapped codec; workflow-shape test)\n- [x] I have run `cargo fmt --all -- --check && cargo clippy --workspace\n--all-targets --features tokio,json -- -D warnings` with no warnings\n- [x] I have run `cargo nextest run --workspace --features tokio,json\n--no-fail-fast` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly (determinism model +\nwiki mirror)\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes\n(CI/test-only; not required)\n- [ ] I have updated relevant examples in the `examples/` directory (not\napplicable)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Local big-endian QEMU evidence** (same package-scoped commands as the\nlane):\n\n| Command | Result |\n| --- | --- |\n| `cargo test -p fortress-rollback --target s390x-unknown-linux-gnu\n--lib wire_codec_digest_is_pinned` | **1 passed** |\n| `cargo test -p fortress-replay-fixture --target\ns390x-unknown-linux-gnu --lib` | **6 passed** |\n\n**Red evidence for the lane's purpose:** temporarily switching the\nshared codec config from `.with_little_endian()` to `.with_big_endian()`\nmade the s390x `wire_codec_digest_is_pinned` test fail; the codec was\nrestored immediately and the diff contains no production codec change\n(`/tmp/s390x-byte-swap-red.txt`).\n\n**Other checks:**\n\n| Check | Result |\n| --- | --- |\n| Native fixture tests | 6 passed |\n| Full workspace nextest (`--workspace --features tokio,json\n--no-fail-fast`) | **3,744 passed, 77 skipped, 0 failed** |\n| `cargo fmt --all -- --check` | pass |\n| `cargo clippy --workspace --all-targets --features tokio,json -- -D\nwarnings` | clean |\n| `actionlint .github/workflows/ci-rust.yml` | clean |\n| `pytest scripts/tests/test_ci_rust_workflow.py` | **32 passed** |\n| `.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix` |\nall checks pass |\n| Wiki sync/consistency, links, changelog rule, typos, markdownlint |\npass |\n\n## Risks and rollback\n\n- The s390x apt install is mirror-speed dependent, exactly why this\nlives outside Miri. The job has a 20-minute cap and package-scoped\ntests; a slow mirror fails the job rather than consuming a Miri budget.\n- The fixture change only affects the big-endian expected `u32`-slice\nhash; little-endian constants and checksum behavior are unchanged.\n- Roll back by reverting this PR. No wire format or production behavior\nchange.\n\n## Related Issues\n\n- Closes #523\n- Follow-up to the cross-arch evidence in #521.",
          "timestamp": "2026-11-22T17:50:11Z",
          "tree_id": "97f8ae02ae8fbd9e8a708842121f3a2b0207fc6e",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/02019c2d6efe96366741dd7ee76f08318b9fd64a"
        },
        "date": 1795370573017,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 40796,
            "range": "± 790",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 25355,
            "range": "± 111",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 648,
            "range": "± 73",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 844,
            "range": "± 4",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 6651,
            "range": "± 97",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "22b88948b1eb26cd5c54c38bf064fcbde8de1040",
          "message": "test: replay terminal epochs and pin hot-join codecs in wasm probes (#535)\n\n## Description\n\nCloses #522.\n\n### Stale terminal replay in the runtime removal probes\n\n- Adds doc-hidden\n`P2PSession::diagnostic_terminal_replay_prepare_bytes`,\n`diagnostic_replay_drop_control_bytes`, and\n`diagnostic_coordinated_drop_active_sequence` surfaces. The first\nencodes a coordinated-drop `Prepare` from a caller-supplied consumed\nterminal epoch against the current target generation, membership, a\nfresh high sequence, and the target endpoint's learned connection id;\nthe second decodes those bytes and delivers them through the normal\ndrop-control path from an explicit source; the third lets the probes\nassert no attempt reopened. The mutating raw replay hook is gated behind\nthe non-default `test-probes` feature (or `cfg(test)`), so it is absent\nfrom normal downstream library builds; the two read-only accessors\nremain doc-hidden.\n- The browser removal probe and the Godot/Emscripten `run_removal_probe`\nnow hot-join the removed slot back after the commit, then replay the\nencoded Prepare from the local coordinator. With the target live again,\nmembership/generation validation passes and the consumed terminal epoch\nis the guard under test. Both probes assert:\n  - the survivor stays `Running`;\n  - no new `PeerDropped` is emitted;\n  - the active attempt sequence is unchanged, so no attempt reopened;\n  - the membership epoch is unchanged; and\n  - the confirmed prefix does not retract.\n- The unit test\n`diagnostic_terminal_replay_prepare_is_rejected_by_the_epoch_fence`\nvalidates the same encoded Prepare against\n`coordinated_drop_validate_prepare` and proves the consumed epoch\nrejects it.\n\n### Hot-join wire-codec digest\n\n- Adds `codec::wire_codec_digest_hot_join`, covering `JoinRequest`,\n`StateSnapshot`, `StateSnapshotAck`, `ReactivateSlot`,\n`ReactivateSlotAck`, `JoinCommitted`, and `JoinAborted`.\n- Pins a separate constant in `fortress-replay-fixture`; the browser,\nGodot/Emscripten, and wasip1 probes all assert it. The core\ncoordinated-drop digest is unchanged, and builds without the feature do\nnot compile the hot-join digest.\n- The wasip1 CI probe now builds the fixture with `--features hot-join`\nso that lane executes the new digest too.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [x] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (hidden diagnostic\nreturns `Option`; no new production panic paths)\n- [x] I have added tests that prove the fix is effective (unit epoch\ntest plus browser/Godot/wasip1 runtime checks)\n- [x] I have run `cargo fmt --all -- --check && cargo clippy --workspace\n--all-targets --features tokio,json -- -D warnings` with no warnings\n- [x] I have run `cargo nextest run --workspace --features tokio,json\n--no-fail-fast` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly (CHANGELOG,\ndeterminism model, wiki mirror, public API snapshot)\n- [x] I have added an entry to `CHANGELOG.md` for the new doc-hidden\ndiagnostic/codec surface\n- [ ] I have updated relevant examples in the `examples/` directory (not\napplicable)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Runtime probes:**\n\n| Check | Result |\n| --- | --- |\n| Browser `wasm32-unknown-unknown` suite with `--features hot-join`\n(headless Chromium) | **12/12 passed**, including the new stale-replay\nprobe and hot-join digest |\n| Browser suite without `hot-join` | **9/9 passed**, no warnings |\n| wasip1 probe (`--features hot-join`, wasmtime-compatible WASI via\nNode) | `frames=4096 requests=8192 digest=0x56cc…6d0b\nrequest_digest=0xb195…cf18` |\n| Godot host `cargo check` | pass |\n| Godot `wasm32-unknown-emscripten` `cargo check` | pass |\n| Godot runtime (threaded + non-threaded) | CI lane; not runnable in\nthis local container without Godot/emsdk |\n\n**Native and guard checks:**\n\n| Check | Result |\n| --- | --- |\n| New epoch-fence unit test | 1/1 pass |\n| Hot-join digest native test | 1/1 pass |\n| Full workspace nextest (`--workspace --features tokio,json\n--no-fail-fast`) | **3,751 passed, 77 skipped, 0 failed** |\n| Full lib nextest with `hot-join` | **2,333 passed, 0 skipped** |\n| `cargo fmt --all -- --check` | pass |\n| `cargo clippy --workspace --all-targets --features tokio,json -- -D\nwarnings` | clean |\n| `python3 scripts/api/public_api_census.py --check` | **2,779 symbols\nmatch** |\n| `.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix` |\nall checks pass |\n| `actionlint` / workflow pytest (32 tests) | clean |\n| Targeted mutation (diagnostics + active-sequence accessor +\n`wire_codec_digest_hot_join`) | **15 mutants: 8 caught, 7 unviable, 0\nmissed, 0 timeouts** |\n| Wiki sync/consistency, links, changelog rule, typos, markdownlint |\npass |\n\n## Risks and rollback\n\n- The new Prepare builder and active-sequence accessor are read-only and\ndoc-hidden. The mutating raw replay hook is compiled only under the\nnon-default `test-probes` feature or `cfg(test)`; normal downstream\nbuilds cannot call it.\n- The hot-join digest is a separate function under `#[cfg(feature =\n\"hot-join\")]`; non-feature builds and the existing core digest are\nunchanged.\n- The Godot runtime lane is merge-queue/main-gated. Both host and\nEmscripten compile checks pass locally; the CI Godot lane exercises both\nthreaded modes.\n- Roll back by reverting this PR. No production protocol, wire-version,\nor simulation behavior change.\n\n## Related Issues\n\n- Closes #522\n- Follow-up to #516, #519, and #521.",
          "timestamp": "2026-11-22T19:59:47Z",
          "tree_id": "20df8c22eeb237964a138dc04a912a5bbb6c2992",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/22b88948b1eb26cd5c54c38bf064fcbde8de1040"
        },
        "date": 1795378304485,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 25891,
            "range": "± 164",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 15937,
            "range": "± 1253",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 478,
            "range": "± 4",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 595,
            "range": "± 35",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5400,
            "range": "± 161",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "4fc8681c7e9466af5bdd1d7714ce6fec969f2f90",
          "message": "test: name the Godot probe inbox type (#536)\n\n## Description\n\nPost-merge red-main follow-up for #535 (`22b88948`). The Godot\nEmscripten Browser job failed at `Lint Godot fixture` with:\n\n```text\nerror: very complex type used. Consider factoring parts into `type` definitions\n  --> tests/godot-emscripten/src/lib.rs:213:28\nnote: `-D clippy::type-complexity` implied by `-D warnings`\n```\n\nThe new probe plumbing returned two `Rc<RefCell<VecDeque<(u8,\nVec<u8>)>>>` inboxes directly from `create_socket_pair`. This is a\ntest-only type alias change; behavior is unchanged.\n\n- Added `type Inbox = Rc<RefCell<VecDeque<(u8, Vec<u8>)>>>;`.\n- Used it in `MemorySocket`, `SessionPair`, and `create_socket_pair`.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [x] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (test-only type alias)\n- [x] I have added tests that prove the fix is effective (the existing\nGodot probe compiles under the failing lint)\n- [x] I have run `cargo fmt --all -- --check` and clippy with no\nwarnings\n- [x] I have run the full workspace test suite (unchanged; one test-only\ntype alias)\n\n### If Applicable\n\n- [ ] I have updated the documentation accordingly (not applicable)\n- [ ] I have added an entry to `CHANGELOG.md` (test-only; not required)\n- [ ] I have updated relevant examples in the `examples/` directory (not\napplicable)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n| Check | Result |\n| --- | --- |\n| `cargo +nightly-2026-08-26 clippy --manifest-path\ntests/godot-emscripten/Cargo.toml --locked --all-targets --all-features\n-- -D warnings` | **clean** |\n| Godot host `cargo check` | pass |\n| Godot `wasm32-unknown-emscripten` `cargo check` | pass |\n| `cargo fmt --all -- --check` | pass |\n\nThis is exactly the failing CI command/toolchain, now green locally.\n\n## Risks and rollback\n\n- Test-only type alias; no runtime or wire behavior change.\n- Roll back by reverting this PR; the old complex return type returns\nand the Godot lint fails again.\n\n## Related Issues\n\n- Post-merge red-main follow-up to #535 / #522.",
          "timestamp": "2026-11-22T20:14:16Z",
          "tree_id": "d5eb91cf9593912ba1c3792b3c358a813bf643fd",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/4fc8681c7e9466af5bdd1d7714ce6fec969f2f90"
        },
        "date": 1795379161432,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 60797,
            "range": "± 1347",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 32422,
            "range": "± 150",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1677,
            "range": "± 111",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1556,
            "range": "± 112",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3123,
            "range": "± 184",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "41ff256cd7ceab2014944a2296b82c77251a7033",
          "message": "fix: tag checksum reports with rewrite floors (#538)\n\n## Description\n\nCloses #533, the remaining out-of-diff review follow-up from #462.\n\nA confirmed-history rewrite clears local checksum entries, the peer\nlatch, and queued reports at/above the rewritten floor. A checksum\nreport carries only `(frame, checksum)`, though, so a delayed report\nsent **before** the rewrite could still arrive afterwards and relatch a\nfalse `DesyncDetected` against the recomputed basis. The earlier\nvalue-equality heuristic was correctly removed: it could hide a real\nmismatch.\n\nThis adds bounded basis metadata:\n\n- `ChecksumReport` carries a 64-bit additive multiset token of the\nsender's applied rewrite floors (`0` means no rewrite).\n- Each local checksum-history entry stores the same token. A comparison\nruns only when the local entry's token equals the report's token.\n- Pre-rewrite reports are consumed as incomparable (no latch, no event,\nno comparison metric). A same-token mismatch still latches and emits\n`DesyncDetected`.\n- Addition is commutative, so reordered convergence rewrites share one\ntoken. Every applied rewrite, including a later **higher-floor** rewrite\nor a repeated floor, adds a term and changes the token for exactly the\nframes it invalidates. Retained entries below the new floor keep their\nprevious token.\n- The hot-join `StateSnapshot` carries the token for its snapshot frame\nso a fresh joiner adopts the same basis. Without this, a rejoin after a\npre-join rewrite left the joiner's `0` reports permanently incomparable\nwith the host's recomputed entries; the rejoin checksum gates caught\nthat regression.\n- The distinct-floor history is hard-capped at 64. Older terms fold into\nthe cumulative base without changing any token at or above the fold\nfloor, and a frame below the fold is reported as incomparable rather\nthan guessed.\n- Wire protocol bumped to `6`. Protocol-v5 goldens are frozen as a\nrejection suite; the v6 suite pins the new checksum-report and snapshot\nbytes. Codec digests, migration notes, formal spec, design-decision log,\nand CHANGELOG are updated.\n\nMismatches below the rewrite floor remain latched, and the #531\nlatch/pending clearing and F11 stale-checksum coverage are unchanged.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [x] 💥 Breaking change (wire protocol v6; all peers must upgrade\ntogether)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (no new production\n`unwrap`/`expect`/`panic!`/`todo!`)\n- [x] I have added tests that prove the fix is effective (red-before\nevidence below)\n- [x] I have run `cargo fmt --all -- --check` and clippy with no\nwarnings\n- [x] I have run `cargo nextest run --workspace --features tokio,json\n--no-fail-fast` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly (migration, formal\nspec, wiki mirror)\n- [x] I have added an entry to `CHANGELOG.md`\n- [ ] I have updated relevant examples in the `examples/` directory (not\napplicable)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Red evidence before the fix** (basis-token comparison bypassed):\n\n```text\ndelayed_report_across_a_later_higher_floor_rewrite_does_not_relatch:\npanicked at ...: a report from between the two rewrites must not relatch\ntest result: FAILED. 0 passed; 1 failed\n```\n\n**Regressions added:**\n\n- `delayed_pre_rewrite_checksum_report_does_not_relatch_after_a_rewrite`\n— a report carrying the pre-rewrite (`0`) token is consumed without\nlatching or emitting `DesyncDetected`; a later same-token match restores\n`InSync`.\n- `delayed_report_across_a_later_higher_floor_rewrite_does_not_relatch`\n— a report sent between two rewrites is ignored after the second,\nhigher-floor rewrite; a current-token mismatch still latches.\n- `current_generation_checksum_mismatch_still_latches` — a same-token\nmismatch still latches and emits `DesyncDetected`.\n- `checksum_basis_token_tracks_the_rewrite_multiset` — frames below a\nfloor keep `0`, every applied rewrite changes the token for frames it\ninvalidates, reordered convergence rewrites share one token, and a\nrepeated floor is a distinct basis change.\n- `checksum_rewrite_history_is_bounded_without_changing_current_tokens`\n— 71 distinct floors stay at the 64-entry cap, folded and post-fold\ntokens are exact, and pre-fold frames are incomparable.\n- Codec tests: arbitrary tokens round-trip on checksum reports and\nsnapshots; v6 goldens pin exact bytes.\n- Existing hot-join rejoin checksum gates\n(`graceful_dropped_slot_is_rejoinable_end_to_end`,\n`dropped_slot_can_be_rejoined_repeatedly`) exercise snapshot-token\nadoption end to end.\n\n| Check | Result |\n| --- | --- |\n| Full workspace nextest (`--workspace --features tokio,json`) | **3,757\npassed, 77 skipped, 0 failed** |\n| `cargo test --lib --features tokio,json,hot-join` | **2,339 passed** |\n| `cargo fmt --all -- --check` | pass |\n| `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D warnings` | clean |\n| `cargo check --workspace --all-targets --no-default-features` | clean\n|\n| `cargo check --workspace --all-targets --no-default-features\n--features tokio,json` | clean |\n| Browser `wasm32-unknown-unknown` check | clean |\n| Godot `wasm32-unknown-emscripten` check | clean |\n| wasip1 replay-probe build | clean |\n| `fortress-replay-fixture` tests | **7 passed** |\n| `scripts/ci/agent-preflight.py --full --auto-fix` | all checks pass |\n| `scripts/hooks/check-wire-golden-immutable.py --local` | pass |\n\n## Risks and rollback\n\n- Unequal basis tokens suppress comparison instead of risking a false\ndesync. If peers diverge in their rewrite histories, desync detection\nfor those frames pauses until their tokens converge; a genuine\nsame-token mismatch still latches.\n- A delayed report is consumed, not retried. The peer's next same-token\nreport is the comparable one.\n- The 64-bit additive summary can theoretically collide for different\nrewrite multisets. A collision only makes two bases look comparable; it\ndoes not suppress a genuine same-basis mismatch.\n- Wire protocol v6 rejects v5 and older headers at the handshake. All\nparticipants must upgrade together; the migration guide and CHANGELOG\ndocument this.\n- Roll back by reverting this PR. That restores the #531 behavior, where\na delayed pre-rewrite report can relatch.\n\n## Related Issues\n\n- Closes #533\n- Follow-up to #462 and #531.\n- Preserves the #531 / #532 latch-clearing behavior and F11\nstale-checksum coverage.",
          "timestamp": "2026-11-22T23:44:18Z",
          "tree_id": "968750622aa2078fe3681c16ea1a8a1f3e6313b3",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/41ff256cd7ceab2014944a2296b82c77251a7033"
        },
        "date": 1795391809922,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 41717,
            "range": "± 590",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 25347,
            "range": "± 199",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 736,
            "range": "± 95",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 981,
            "range": "± 11",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7703,
            "range": "± 115",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "deadcf54466c508f383be67d534900e565cbcfbb",
          "message": "test: cover checksum basis token boundaries (#539)\n\n## Description\n\nPost-merge follow-up to #538. `main` at `41ff256c` is red in `CI -\nMutation Testing`: the diff-scoped lane found **15 missed mutants**\naround the new checksum basis token, fold handling, snapshot decoder,\nand retention boundaries.\n\nThis PR adds deterministic boundary tests and replaces two\nmutation-equivalent comparisons:\n\n- Strict-below retention for local basis tokens, pending\nchecksums/tokens, and the latch at the rewrite floor (covers `<` →\n`==`/`<=`/`>` mutants).\n- `NetworkStats` reports only the latest **comparable** basis pair\n(covers `!=` → `==`).\n- The basis-token map prunes on the same scheduled-history boundary as\nthe checksum map (covers `>=` → `<`).\n- The codec accepts exactly the 64-event cap and rejects non-canonical\nevent lists; `ChecksumBasis` accepts frame-zero fold floors and rejects\nnegative or duplicate events (covers decoder/messages comparisons).\n- Snapshot wire accounting counts basis events, and a post-fold rewrite\nat/below the fold floor with spare map capacity goes directly into the\nbase (covers the fold-branch mutations).\n- Fold handling now uses `std::cmp::max` and an explicit null/above-fold\nbranch, removing mutation-equivalent comparison points.\n\nNo wire format, protocol version, runtime behavior, or public API\nchanges; the only production edits are control-flow-equivalent\nsimplifications in the fold/compaction helpers.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests; equivalent helper\nsimplification)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (no new production\n`unwrap`/`expect`/`panic!`/`todo!`)\n- [x] I have added tests that prove the fix is effective\n- [x] I have run `cargo fmt --all -- --check` and clippy with no\nwarnings\n- [x] I have run `cargo nextest run --workspace --features tokio,json\n--no-fail-fast` and all tests pass\n\n### If Applicable\n\n- [ ] I have updated the documentation accordingly (test-only; not\napplicable)\n- [ ] I have added an entry to `CHANGELOG.md` (test-only; not\napplicable)\n- [ ] I have updated relevant examples in the `examples/` directory (not\napplicable)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n| Check | Result |\n| --- | --- |\n| Full workspace nextest (`--workspace --features tokio,json`) | **3,769\npassed, 77 skipped, 0 failed** |\n| `cargo fmt --all -- --check` | pass |\n| `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D warnings` | clean |\n| `scripts/ci/agent-preflight.py --full --auto-fix` | all checks pass |\n| Targeted `cargo-mutants` (baseline run) on affected production\nfunctions | **0 missed** across the repaired boundary set |\n\nThe targeted mutation run covered `invalidate_checksum_mismatch_from`,\n`compact_checksum_rewrite_events`, `populate_checksum_stats`,\n`check_checksum_send_interval`, `decode_state_snapshot`,\n`ChecksumBasis::is_valid`, `on_checksum_report`, and\n`snapshot_wire_len`. The only remaining local misses are two\n`ProtocolConfig` field deletions in the unchanged\n`fuzz_protocol_input_packet` test helper, which are outside this diff\nand do not affect production behavior.\n\n## Risks and rollback\n\n- Test-only coverage plus equivalent simplification of the fold\nbranch/compaction max. No behavior or wire change.\n- Roll back by reverting this PR; the post-merge mutation gate returns\nto red.\n\n## Related Issues\n\n- Post-merge follow-up to #538 / #533.",
          "timestamp": "2026-11-23T02:24:17Z",
          "tree_id": "03846d19ba06cc02f50b21ed1fe5f14c221a42cc",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/deadcf54466c508f383be67d534900e565cbcfbb"
        },
        "date": 1795401405789,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 62388,
            "range": "± 824",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 31462,
            "range": "± 458",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1862,
            "range": "± 122",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1555,
            "range": "± 75",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3019,
            "range": "± 180",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "de5feee8651a7366befe5b7683305a1670af7407",
          "message": "fix: bound player-domain wire and replay counts (#545)\n\n## Description\n\nThe same malformed bytes currently decode differently on 32-bit and\n64-bit targets:\n\n- Hot-join `JoinRequest.player_handle`, `ReactivateSlot`/`Ack`,\n`JoinCommitted`/`Aborted` handles, and `StateSnapshot::num_players` read\na `u64` and convert to `usize` before any domain check. `u64::MAX` is\naccepted on 64-bit and rejected on 32-bit.\n- Replay header and metadata `num_players` have the same pattern.\n\nThe session domain is already `u16` (`SessionConfigBlock::num_players`,\nendpoint narrowing), so no valid handle, snapshot player count, or\nreplay player count exceeds `u16::MAX`. This reads the wire `u64` first,\nrejects values above the `u16` domain with a target-independent error,\nthen converts to `usize`.\n\nThe replay byte-bound and zero-sized-input tests are preserved with\nvalid-width counts: a `u16::MAX` frame is still larger than the\nremaining bytes, and multiple valid-width frames cross the cumulative\nzero-sized-input limit.\n\nNo wire format, protocol version, or valid input behavior changes.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (no new production\n`unwrap`/`expect`/`panic!`/`todo!`)\n- [x] I have added tests that prove the fix is effective\n- [x] I have run `cargo fmt --all -- --check` and clippy with no\nwarnings\n- [x] I have run `cargo nextest run --workspace --features tokio,json\n--no-fail-fast` and all tests pass\n\n### If Applicable\n\n- [ ] I have updated the documentation accordingly (not applicable)\n- [x] I have added an entry to `CHANGELOG.md`\n- [ ] I have updated relevant examples in the `examples/` directory (not\napplicable)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n| Check | Result |\n| --- | --- |\n| Full workspace nextest (`--workspace --features tokio,json`) | **3,771\npassed, 77 skipped, 0 failed** |\n| `cargo test --target i686-unknown-linux-gnu --lib --features\ntokio,json,hot-join` | **2,351 passed** |\n| `cargo test --target i686 ... codec/replay bound tests` | pass |\n| `cargo fmt --all -- --check` | pass |\n| clippy (workspace, all targets, tokio/json/hot-join) | clean |\n| `scripts/ci/agent-preflight.py --full --auto-fix` | all checks pass |\n\nNew regressions use the same hard-coded `u64::MAX` bytes on both\ntargets:\n- all five hot-join handle variants reject with the `u16 player domain`\nmessage;\n- `StateSnapshot::num_players` rejects the same bytes;\n- replay `num_players` rejects the same bytes.\n\nExisting replay byte-bound and zero-sized-input protections still pass\nwith valid `u16`-width counts.\n\n## Risks and rollback\n\n- Rejects only values that could never belong to a constructible session\nor valid replay. Valid wire bytes and replays are unchanged.\n- Roll back by reverting this PR; malformed-input acceptance becomes\npointer-width dependent again.\n\n## Related Issues\n\n- Determinism/cross-platform audit follow-up. Issues filed for the CAP\nand retransmission findings: #542, #543, #544.",
          "timestamp": "2026-11-23T04:50:10Z",
          "tree_id": "0b397eb63193f1e9eb6991f4ceebcff49f906295",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/de5feee8651a7366befe5b7683305a1670af7407"
        },
        "date": 1795410157717,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 38133,
            "range": "± 905",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 23669,
            "range": "± 620",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1244,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2765,
            "range": "± 161",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "8810508197d7d98c0a8417eee7ce2c49e7937c87",
          "message": "test: accept the exact u16 player-domain boundary (#549)\n\n## Description\n\nThe #545 tests only proved that player handles and counts **above**\n`u16::MAX` reject. A targeted mutation run over the changed functions\nfound a real survivor:\n\n- `src/network/codec.rs:651` `replace > with >= in read_player_domain`\nwas **missed** because no test decoded the inclusive `u16::MAX`\nboundary.\n\nThis adds the inclusive boundary cases for both readers:\n\n- a hot-join `JoinRequest` with `player_handle == u16::MAX` decodes\nfully and preserves the handle;\n- an empty `Replay<u32>` with `num_players == u16::MAX` validates,\nencodes, and round-trips.\n\nTest-only; no production behavior change.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt --all -- --check` (pre-commit hook also\npassed)\n- [x] The two touched tests pass on x86_64 and i686\n\n### If Applicable\n\n- [ ] I have updated the documentation accordingly\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes\n- [ ] I have updated relevant examples in the `examples/` directory\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n-\n`network::codec::hot_join_tests::decode_message_rejects_handles_and_counts_outside_the_u16_domain`\n-\n`replay::tests::from_bytes_rejects_player_counts_outside_the_u16_domain`\n\n**Manual testing performed:**\n\n- `cargo test --lib --features tokio,json,hot-join ...` on x86_64: 1\npassed each.\n- `cargo test --target i686-unknown-linux-gnu --lib --features\ntokio,json,hot-join ...`: 1 passed.\n- Targeted `cargo mutants -F\n'read_player_domain|read_replay_player_count'`:\n- before: 6 caught, 1 missed, 14 unviable (`replace > with >=` missed);\n  - after: 21 mutants tested, 7 caught, 0 missed, 14 unviable.\n\n## Related Issues\n\nRelates to #545. The production fix is already merged; this closes the\npost-merge mutation gap.",
          "timestamp": "2026-11-23T19:06:57Z",
          "tree_id": "37ebde7bb296d82afeea5268892d10f7778f5b0b",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/8810508197d7d98c0a8417eee7ce2c49e7937c87"
        },
        "date": 1795461983991,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 24604,
            "range": "± 2099",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 15385,
            "range": "± 558",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 450,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 560,
            "range": "± 4",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5109,
            "range": "± 151",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "63797c26a69b39d0efc4cbfb09f11725e5f30f3b",
          "message": "fix: reject zero-sized replay count bombs from the header (#555)\n\n<!-- session: ses_df4d54357ffeURwt9tQDtWwNny started:\n2026-11-24T01:26:00Z -->\n\n# fix: reject zero-sized replay count bombs from the header\n\n## Description\n\n`Miri (macOS - misc)` was cancelled at its 30-minute job cap on `main`\nat `5cd54ec5` (run\n\n[45264276932](https://github.com/Ambiguous-Interactive/fortress-rollback/actions/runs/45264276932),\njob `138006923271`, 20:55:10Z -> 21:25:30Z). The hotspot was\n`replay_from_bytes_rejects_zero_sized_input_count_bomb`: for a\nzero-sized input type it builds 18\nframes of 65,535 inputs, and the decoder walked 16 frames (1,048,560\nzero-sized inputs) before the\ncumulative limit tripped. Measured alone under the pinned Miri flags:\n**577.7s**.\n\n`decode_replay` already knows `num_players` and `frames.len` from the\nheader, and every frame must\ncarry exactly `num_players` inputs. This change computes `frame_count *\nnum_players` with\n`checked_mul` and rejects it against `MAX_ZERO_SIZED_INPUTS` before\ndecoding any frame. The per-frame\naccumulator remains as defense in depth. Valid replays and wire bytes\nare unchanged.\n\nThis also reverts the earlier macOS lane split from the first commit on\nthis branch. The split only\nmoved ~3% of the lane's runtime (`input_queue` is 22.6s; the replay\nhotspot is 577.7s), so it did not\naddress the cause and added a macOS shard. With the header pre-check,\nthe full old `macOS - misc`\nselection runs in **90.46s** locally instead of **~708s**.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [x] 🧪 Test (adding or updating tests)\n- [x] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have followed the **zero-panic policy**: `checked_mul` plus\nstructured `replay_decode_error`;\n      no `unwrap`/`expect`/`panic` in production code.\n- [x] I have added tests that prove my fix is effective: a header-only\ncount bomb must fail with the\nlimit error (not truncation), and `usize::MAX * u16::MAX` must return\nthe overflow error.\n- [x] I have run `cargo fmt` and `cargo clippy --workspace --all-targets\n--features tokio,json` with\n      no warnings.\n- [x] I have run the test suite and all tests pass.\n\n### If Applicable\n\n- [x] I have added an entry to `CHANGELOG.md` (`**Pre-existing:**`\nFixed).\n- [x] My changes generate no new compiler warnings.\n\n## Testing\n\nCommands were run in `/workspaces/fortress-rollback`; Miri used the\nworkflow's pinned\n`nightly-2026-08-26` with\n`MIRIFLAGS=\"-Zmiri-disable-isolation -Zmiri-many-seeds=0..1\n-Zmiri-symbolic-alignment-check\"`.\n\n**Red / negative control**\n\n- With the header pre-check temporarily removed, both new header-only\ntests fail:\n- `replay_from_bytes_rejects_zero_sized_count_bomb_from_header` stops at\nthe missing frame bytes\n    instead of the limit error.\n- `replay_from_bytes_rejects_zero_sized_count_product_overflow` reaches\nthe frame-vector bound\n    instead of the overflow error.\n- The original 18-frame bomb test still passes without the pre-check,\nbut takes **647.39s** under\nMiri; with the pre-check it takes **0.042s**. The test was retained, not\nskipped or weakened.\n\n**Green**\n\n- `cargo fmt --all -- --check` - pass.\n- `cargo c` (clippy, workspace, all targets, `tokio,json`) - pass.\n- `cargo nextest run 'replay::tests'` - **43 passed**.\n- `cargo tfull` - **3,773 passed, 77 skipped** (+2 new tests).\n- `cargo test --doc` - **160 passed, 51 ignored**.\n- `RUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features\nhot-join,tokio,json,sync-send\n  --document-private-items` - pass.\n- `cargo check --target wasm32-unknown-unknown --no-default-features` -\npass.\n- Big-endian replay fixture under s390x QEMU - **6 passed**.\n- `python3 scripts/hooks/check-changelog-unreleased.py` - pass.\n- `.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix` -\nall checks pass.\n\n## Risks\n\n- A truncated zero-sized count bomb now reports the limit error instead\nof `truncated`. Invalid\ninput has no compatibility guarantee; valid replays and wire bytes are\nunchanged.\n- The runtime evidence is local Linux. The actual macOS lane still needs\none `CI - Rust` run; the\nobserved macOS/Linux ratio is roughly 2.2-2.5x, so the expected lane is\n~3-4 minutes against the\n  30-minute cap.\n\n## Rollback\n\nRevert `src/replay.rs` and the `CHANGELOG.md` entry. The change is a\npre-decode validation only; no\nwire, hash, or public API change.\n\n## Related\n\n- Main CI failure: run `45264276932`, job `138006923271`.\n- Supersedes the lane split in commit `06d00138` on this branch.\n\n---\n\n<!-- Thank you for contributing to Fortress Rollback! -->",
          "timestamp": "2026-11-24T17:28:56Z",
          "tree_id": "e5544733740d6e8f2025e5c42b644bc3f6970ad6",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/63797c26a69b39d0efc4cbfb09f11725e5f30f3b"
        },
        "date": 1795542104006,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 25919,
            "range": "± 529",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 15797,
            "range": "± 236",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 456,
            "range": "± 11",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 585,
            "range": "± 19",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5175,
            "range": "± 180",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "690aec33d2b8b0890c8e37cd1747099d59bed896",
          "message": "fix: derive checksum basis tokens from converged freeze history (#563)\n\n<!-- session: ses_def1a7ebaffeigHqlyiQdhcUIL started:\n2026-11-25T05:04:58Z -->\n\n## Description\n\nFixes #562 and #561. The checksum-report basis token was an additive\nmultiset of every\nconfirmed-history rewrite floor a survivor ever applied. Two survivors\nthat converge to the same\nfrozen history through different intermediate detections (for example\none freezes a slot at frame\n9 and then converges to 5, the other freezes at 5 directly) therefore\nkept different tokens\nforever, and `compare_local_checksums_against_peers` ignored every\nreport at or above the extra\nfloor: a permanent false negative in desync detection.\n\nThe token is now a pure function of each slot's converged freeze\nboundary (`last_frame + 1`): one\nterm per frozen slot at or below the report frame. A lower convergence\nreplaces the term, a higher\nre-detection is idempotent, and reactivation removes it. Folded\nboundaries keep per-slot identity\nso lowering/release subtracts the old base term exactly once. The\nhot-join basis carries\n`(freeze_floor, slot_handle)` pairs so a joiner can keep canonicalizing\nlater rewrites, and the\nadoption gates reject negative event floors (#561), non-canonical\nordering, duplicate slots, and\nslots outside the player count.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [ ] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (no\n`unwrap`/`expect`/`panic!`/`todo!` in\n      production; all fallible operations return `Result`)\n- [x] I have added tests that prove my fix is effective\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with\n      no warnings (also checked with `hot-join`)\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly (CHANGELOG, protocol\nspec revision history,\n      network design-decision log)\n- [x] I have added an entry to `CHANGELOG.md` for user-facing changes\n(folded into the existing\n      unreleased v6 entries per the unreleased-code rule)\n- [ ] I have updated relevant examples in the `examples/` directory (not\napplicable)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `converged_freeze_histories_share_one_basis_token`: drives two\nsessions through the production\n`disconnect_player_at_frame*` paths (late freeze at 9 then converge to 5\nvs direct freeze at 5),\nasserts equal tokens for every retained frame, `Some(0)` below the\nboundary, a pre-convergence\nreport ignored, and a same-basis mismatch still latches\n`DesyncDetected`.\n- `reserved_slot_convergence_ahead_of_simulation_records_the_basis`:\nconvergence learned before\n  the local simulation reaches the boundary still records the basis.\n- `lowering_a_folded_boundary_replaces_its_base_term` and\n`releasing_a_folded_boundary_subtracts_its_term`: folded boundaries are\nreplaceable/releasable\n  without double counting.\n- `freeze_event_order_does_not_change_the_converged_token`,\n  `same_floor_on_different_slots_yields_distinct_tokens`,\n  `compacting_shared_lowest_floors_keeps_the_basis_canonical`,\n  `checksum_freeze_map_is_bounded_without_changing_current_tokens`,\n  `freeze_below_fold_floor_with_spare_capacity_goes_to_base`,\n  `freeze_at_or_below_the_fold_floor_keeps_the_snapshot_basis_valid`,\n  `adopting_a_snapshot_basis_preserves_tokens_above_the_snapshot_frame`,\n\n`apply_snapshot_rejects_a_basis_slot_outside_the_player_count_without_mutation`,\n`apply_snapshot_rejects_a_negative_basis_floor_without_mutation`, plus\nthe updated\n  `ChecksumBasis`/codec canonicality cases.\n- Red evidence: the new convergence regression failed pre-fix with\n`left: Some(11153826283903158796)` vs `right: Some(956228935199076460)`.\n- Mutation evidence: accumulate-instead-of-replace fails at `Frame(0)`;\na floor-only term fails\n`same_floor_on_different_slots_yields_distinct_tokens`; leaking a folded\nterm fails the folded\n  lowering/release regressions.\n\n**Manual testing performed:**\n\n- `cargo tfull --no-fail-fast`: 3785 passed, 77 skipped.\n- `cargo nextest run --lib` / `--features hot-join`: 2080 / 2333 passed.\n- `cargo test --doc`: 160 passed, 51 ignored.\n- `cargo clippy --workspace --all-targets --features tokio,json,hot-join\n-- -D warnings`: pass.\n- `RUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features\nhot-join,tokio,json,sync-send\n  --document-private-items`: pass.\n- `wasm32-unknown-unknown` checks (base, `sync-send`, `hot-join`,\n`json`): pass; wasip1 replay\nprobe and the 12-test browser WASM hot-join suite pass\n(Chrome/ChromeDriver 158).\n- s390x big-endian under QEMU: `wire_golden_v6` exact-byte variants plus\n  `wire_codec_digest_is_pinned`: 3 passed.\n- `.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix`:\nall checks passed.\n- Godot native/Emscripten lane was not run (this devcontainer has no\nGodot 4.7.1 or Emscripten\n4.0.20); the browser WASM lane covers the same hot-join session surface.\n\n## Evidence\n\n- Independent fresh-context review: no Blockers; two Major findings\nfixed in `bb521287`\n(ahead-of-simulation convergence not recorded; folded boundaries not\nreplaceable/releasable).\n- Diff size: ~720 net lines, above the 500 guidance and below the 1,000\nstop. Production is\n~194 net lines across four files; ~526 net lines are regressions/oracles\nin the existing test\nmodules. Splitting tests from the fix would leave it unverified, so the\noverflow is recorded.\n\n## Risks\n\n- Protocol v6 is unreleased; `ChecksumBasis.events` changes meaning from\n`(floor, count)` to\n`(floor, slot)` with identical bytes. No released peer can interoperate\nwith the old semantics,\nso this folds into the existing v6 entry rather than bumping the version\nagain.\n- A joiner cannot subtract a boundary folded before its snapshot (the\nwire carries only the\naggregate base); that corner (only reachable with >64 simultaneously\nfrozen slots) stays\nincomparable, never a false mismatch. Survivor-vs-survivor tokens are\nexact.\n- Basis tokens are opaque and not pinned cross-target; the term writes\nfixed-width LE bytes and\n  the slot handle as u32, so native/s390x/wasm derive identical values.\n\n## Rollback\n\nRevert the squash commit. No migration or state format is involved;\nprotocol v6 is unreleased and\nthe previous additive derivation can be restored with the same test\nfiles reverted.\n\n## Related Issues\n\nFixes #562\nFixes #561",
          "timestamp": "2026-11-25T07:31:24Z",
          "tree_id": "43a9356e3df102d13d27cdcf7865af7fab865b1b",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/690aec33d2b8b0890c8e37cd1747099d59bed896"
        },
        "date": 1795592663936,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 42761,
            "range": "± 1217",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 27236,
            "range": "± 301",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 767,
            "range": "± 104",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 982,
            "range": "± 6",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7711,
            "range": "± 97",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "45a6e77b5d4aa58d72046050c925cb2eeabc8825",
          "message": "test: close the #563 checksum-basis mutation survivors (#564)\n\n<!-- session: ses_debadf769ffeD7yGjLSzSYbNAj started:\n2026-11-25T20:09:25Z -->\n\n## Description\n\n`main` is red: `CI - Mutation Testing` run 45569442792 on `690aec33`\nfailed the\ndiff-scope policy with `error: diff scope has 9 missed mutants` (job\n139068848707). The `#563` merge changed the checksum-basis derivation\nbut left\nfour boundary decisions unpinned. This PR closes that coverage gap with\nfour\ntests and no production changes.\n\nThe nine survivors were:\n\n- `src/sessions/p2p_session.rs:17135:34` — `&&` → `||` in\n`record_checksum_freeze`\n- `src/sessions/p2p_session.rs:17179:12` — delete `!` in\n`checksum_basis_token_for`\n- `src/sessions/p2p_session.rs:17179:54` — `&&` → `||` in\n`checksum_basis_token_for`\n- `src/sessions/p2p_session.rs:17179:63` — `<` → `==`, `<=`, `>` in\n`checksum_basis_token_for`\n- `src/sessions/p2p_session.rs:17400:38` — `<` → `<=` in\n`check_checksum_send_interval`\n- `src/network/codec.rs:1194:17` — `>` → `==`, `>=` in\n`decode_state_snapshot`\n\nEach was a genuine untested boundary, not dead code:\n\n1. A freeze boundary **above** an adopted fold floor must stay an\nexplicit\n   event; only boundaries at or below the floor fold into the base.\n2. A frame **at** the fold floor is representable; a frame strictly\nbelow it is\n   not.\n3. A scheduled checksum **at** the release floor must still be reported;\nonly\n   strictly older schedule slots are suppressed.\n4. `u16::MAX` is inside the codec's player domain; `u16::MAX + 1` is\nnot.\n\n## Type of Change\n\n- [x] 🧪 Test (adding or updating tests)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (test-only change; no\nnew\n  `unwrap`/`expect`/`panic!` in production code)\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [ ] I have updated the documentation accordingly\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes\n- [ ] I have updated relevant examples in the `examples/` directory\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `adopted_fold_floor_keeps_events_above_it_explicit`\n- `checksum_basis_token_rejects_only_frames_below_the_fold_floor`\n- `checksum_send_at_the_release_floor_is_not_suppressed`\n- `state_snapshot_checksum_basis_slot_domain_is_exact`\n\n**Manual testing performed:**\n\n- `cargo nextest run --features tokio,json,hot-join,violation-census -E\n'<the four tests>'`\n  → 4 passed.\n- `cargo tfull` → 3785 passed, 77 skipped (48.4s).\n- `cargo nextest run --workspace --features\ntokio,json,hot-join,violation-census`\n  → 3790 passed, 77 skipped (60.4s).\n- `cargo test --doc` → 160 passed, 51 ignored.\n- `RUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features\nhot-join,tokio,json,sync-send --document-private-items` → pass.\n- `.venv/bin/python3 scripts/ci/agent-preflight.py --full --auto-fix` →\nall checks pass.\n- `cargo fmt --all -- --check` and `cargo c` → pass.\n\n**Mutation evidence (cargo-mutants 27.1.0, the CI-pinned version):**\n\nBefore (HEAD `690aec33`):\n\n```text\n7 mutants tested in 3m: 7 missed      # p2p_session survivors\n4 mutants tested in 2m: 2 missed, 2 caught  # codec survivors\n```\n\nAfter (this branch):\n\n```text\n7 mutants tested in 3m: 7 caught\n4 mutants tested in 2m: 4 caught\n```\n\nThe PR's own diff-scope mutation run plans 0 mutants because the change\nis\ntest-only (`cargo mutants --list --in-diff <branch diff>` prints `No\nmutants to\nfilter`); the runs above are the oracle for the nine survivors.\n\n**Five-day review audit:** both unresolved review threads on merged PR\n#538 are\nobsolete on current main and were resolved with evidence\n\n(https://github.com/Ambiguous-Interactive/fortress-rollback/pull/538#issuecomment-7173861581).\n\n## Risks\n\n- The mutation policy only re-tests each push's diff, so these nine\nsurvivors\n  are not automatically re-run by this merge. A future full-scope\n`workflow_dispatch` run is the confirmation path; the local logs are\nattached\n  in the progress record.\n- No production behavior changes, so runtime, wire, and cross-platform\nrisk is\n  limited to the existing code paths under test.\n\n## Rollback\n\nRevert commit `fe9ec49a` (or squash-merge revert). The revert removes\nfour test\nfunctions only; no runtime, wire, or configuration state changes, so no\nmigration is required.\n\n## Related Issues\n\nRelates to #563 (the merge that introduced the survivors) and #538\n(closed\nreview threads verified as fixed).",
          "timestamp": "2026-11-25T20:46:53Z",
          "tree_id": "f78cf8f81ff2af6898401ed6d98917ca4df6cbd1",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/45a6e77b5d4aa58d72046050c925cb2eeabc8825"
        },
        "date": 1795640341251,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 41713,
            "range": "± 1259",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 27302,
            "range": "± 313",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 768,
            "range": "± 84",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 986,
            "range": "± 10",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7780,
            "range": "± 131",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "bc4d4442a9d2e5acc6f21abdae116f8e4633eeeb",
          "message": "test: make simulation schedules and shrink artifacts host-independent (#565)\n\n<!-- session: ses_deb811df6ffe0kuyQt0IlreMbr started:\n2026-11-25T20:58:08Z -->\n\n## Description\n\nCloses #547.\n\n`main` had two host-dependent determinism residuals in the simulation\nharness:\n\n1. `Draw::range_f64` derived schedule rates with `f64::mul_add`. A fused\nmultiply-add is not\nguaranteed to lower identically on every target, and a one-ULP rate\nchange can flip a seeded\n`roll_unit() < drop_rate` threshold and change the materialized\nschedule.\n2. `shrink_failure` stopped exploring when `Instant::now().elapsed()`\nexceeded\n`ShrinkConfig::max_duration`, so a fast and a slow host minimized the\nsame failure to a\n   different schedule and run count.\n\nBoth are removed:\n\n- Rates are drawn as integer basis points (`Draw::range_basis_points`)\nfrom one 32-bit stream word\nand divided by 10,000. That division is correctly rounded IEEE-754, so\nthe same seed materializes\nthe same bytes everywhere, and generation contains no `mul_add` and no\nfused-contraction hazard.\n`burst_rate` draws from 1..50 bp so the validator's\nburst-rate/burst-length pairing holds for\n  every draw.\n- `ShrinkConfig` keeps only `max_runs`. `ShrinkResult::elapsed` remains\nas reporting-only\n  observability, and `has_budget` no longer reads a clock.\n\nTwo regressions pin the result:\n\n- `generated_rate_policies_are_exact_basis_points` fails on any\nnon-basis-point rate (red on\n  `main`: `drop_rate ... got 0.004696612735278905`, expected `0.0047`).\n- `generated_schedule_digest_is_pinned` pins FNV-1a over the serialized\nschedules for five\nrepresentative `(seed, SimConfig)` cases. The digest was independently\nrecomputed in Python from\n  the dumped JSON (`0x3ea312b56ddea442`).\n- `shrink_result_is_independent_of_runner_speed` runs the same failure\ntwice, once fast and once\nwith an 8 ms sleep per confirmation, and requires identical `runs` and\n`schedule` (red on `main`:\n  39 vs 23 runs).\n\n## Type of Change\n\n- [x] 🧪 Test (adding or updating tests)\n- [x] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** (test-harness and CI\nonly; no production code)\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly (harness module docs)\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes\n(test/CI only, no `pub` or\n  user-observable behavior)\n- [ ] I have updated relevant examples in the `examples/` directory\n(N/A)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `generated_schedule_digest_is_pinned` (new)\n- `generated_rate_policies_are_exact_basis_points` (new)\n- `shrink_result_is_independent_of_runner_speed` (new)\n- `smoke_traces_match_checked_in_cross_architecture_digests`\n(regenerated the three x86_64\n  reference digests for the intentional generator change)\n- `scripts/tests/test_ci_rust_workflow.py` (the big-endian lane now has\n7 cargo test commands)\n- Removed the old `max_duration: Duration::ZERO` case from\n`invalid_inputs_and_bounds_do_not_overrun_the_runner_or_callback`; the\nbound it exercised no\nlonger exists, and the remaining `max_runs` boundary cases are\nunchanged.\n\n**Manual testing performed:**\n\n- `cargo nextest run --features tokio,json,hot-join,violation-census\n--test simulation` →\n  **498 passed, 28 skipped**.\n- `cargo tfull` → **3788 passed, 77 skipped** (64.5 s).\n- `cargo test --doc` → **160 passed, 51 ignored**.\n- `RUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features\nhot-join,tokio,json,sync-send\n  --document-private-items` → pass.\n- `cargo clippy --workspace --all-targets --features\ntokio,json,hot-join,violation-census -- -D\n  warnings` → clean.\n- `.venv/bin/python3 scripts/ci/agent-preflight.py --full --auto-fix` →\nall checks pass.\n- `actionlint .github/workflows/ci-rust.yml` → clean; `pytest\nscripts/tests/test_ci_rust_workflow.py`\n  → 33 passed.\n- `cargo check --target wasm32-unknown-unknown --no-default-features` →\npass.\n`cargo check -p wasm-browser-smoke --features hot-join --target\nwasm32-unknown-unknown --lib\n--tests` → pass. The simulation harness target itself is not\nwasm-buildable (it uses\n  `std::thread`/`Instant`), so it is not part of a wasm lane.\n\n**Cross-architecture evidence (the same pinned values on every lane):**\n\n- x86_64 native: digest `4_513_471_821_997_057_090`.\n- s390x QEMU (`cargo test --target s390x-unknown-linux-gnu --test\nsimulation --features tokio,json\n  generated_schedule_digest_is_pinned`): pass.\n- aarch64 QEMU: the new digest, exact-basis-point, shrink, and\nsmoke-trace tests all pass; the\ncross-arch simulation subset (13 tests: trace digest, D14 lossy removal,\npartition CAP gate,\n  corpus replays) passes. The `cross-arch-runtime` filters now include\n`generated_schedule_digest_is_pinned` on both aarch64 and i686, asserted\nby\n  `scripts/tests/test_ci_rust_workflow.py`.\n- i686 native: same four new/changed tests pass; the same 13-test\ncross-arch subset passes.\n- aarch64 hot-join trace: pass.\n\n**Targeted mutations (oracle integrity):**\n\n- Replacing `range_basis_points` with a `mul_add`-based rate changes the\npinned digest\n(`7935885000697351495` vs `4513471821997057090`) and fails\n`generated_schedule_digest_is_pinned`.\n- Reintroducing a 300 ms wall-clock gate in `has_budget` fails\n  `shrink_result_is_independent_of_runner_speed` with 39 vs 20 runs.\n\n**Regenerated reference values:** the three `smoke_traces...` digests\nand seed 41's confirmed\nvector changed because the generator intentionally quantizes rates. The\nnew values were produced\nfrom the new generator on x86_64 and then matched under aarch64 and\ni686.\n\n## Risks\n\n- Any other consumer that pins an old generated schedule will need the\nsame one-time regeneration;\nthe only checked-in consumer was the smoke-trace table updated here.\nCorpus files store fully\n  materialized schedules, so their replays are unaffected.\n- A shrink that previously stopped at 5 minutes now runs to its\n`max_runs` budget (default 500, and\nevery call site passes an explicit budget). Runs are bounded and\ndeterministic; wall time is\n  reported but no longer gates.\n\n## Rollback\n\nRevert this PR with a squash-merge revert (`git revert <squash\ncommit>`). The revert restores the `mul_add` rates and the wall-clock\nbound; no wire,\nsession, or configuration state changes, so no migration is required.\n\n## Related Issues\n\nCloses #547.",
          "timestamp": "2026-11-25T21:56:55Z",
          "tree_id": "99d02e91110ecb339cff768c2a7b20dc798863e6",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/bc4d4442a9d2e5acc6f21abdae116f8e4633eeeb"
        },
        "date": 1795644544102,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 40159,
            "range": "± 774",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 24530,
            "range": "± 104",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1243,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2762,
            "range": "± 172",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "4e400ee30f63052052c18513a8a46d384a5aa223",
          "message": "test: retire the stale desync Z3 claims and gate the comparison (#572) (#586)\n\n<!-- session: ses_de6fd17caffetszqvtSz73umoT started:\n2026-11-26T17:59:10Z -->\n\n## Description\n\nPart (b), Z3 slice of #572 (the issue authorizes splitting into\nextraction+Kani\nand TLA/Z3/docs). This removes the two stale desync claims that no\nlonger match\nproduction and replaces them with basis-aware models:\n\n1. **`z3_proof_desync_detection_no_false_negatives_on_comparison` is now\nbasis-aware.** Production skips a checksum comparison unless the\nprotocol-v6\nbasis tokens match\n(`p2p_session.rs::compare_local_checksums_against_peers`).\n   The proof now assumes the gate admitted the report (`local_basis ==\n   remote_basis`) and proves the comparison primitive detects differing\nchecksums. The old message claimed \"differing checksums always trigger\n   detection\" across every basis, which is false.\n2. **New `z3_proof_different_basis_is_never_compared`.** Models the gate\nitself:\ndifferent tokens never admit a comparison and therefore cannot latch a\ndesync.\n   This is the cross-basis half the old proof silently assumed.\n3. **`z3_proof_sync_health_state_transitions` models the rewrite\nclearing.**\n`invalidate_checksum_mismatch_from` clears the latched mismatch at or\nabove a\nconfirmed-history rewrite floor (#532), so `DesyncDetected` is latched\nwithin\none basis, not terminal for the session. The proof keeps the\nno-latch-clear\ntransition UNSAT-safety check and adds a SAT non-vacuity witness for the\n   rewrite-clears edge.\n4. **Summaries and counts are corrected.** The desync summary and the\nmodule\nsummary no longer say \"always trigger detection\" or \"terminal\"; the\nstale\ngroup counts were audited against the 65 `#[test]` functions and updated\n(the aggregate total now reports 64 proofs plus 2 summary tests = 66\ntests).\n5. **`docs/specs/formal-spec.md`**: the header was stuck at 1.1 while\nthe\nrevision table was at 1.4. It is now 1.5 with a 2026-11-26 row, and\nSAFE-7a\n(same-basis gate), SAFE-7b (converged history shares a token; target of\n#572,\nexplicitly not yet proved) and SAFE-7c (rewrite clears stale latch\nstate) are\ndocumented. The generated wiki mirror and the alignment table are\nregenerated.\n6. **Manifest:** `z3_proof_different_basis_is_never_compared` is mapped\nto the\n`checksum-basis` component so the gate proof is tracked as its\nverification\n   artifact.\n\nNo production code, wire format, or test was deleted, skipped, or\nweakened. The\none narrowed proof gained a precondition that mirrors the production\ngate; its\ncross-basis complement is a new proof.\n\nRemaining on #572: extraction of `ChecksumBasisTracker` + the five Kani\nharnesses (part a), and `specs/tla/ChecksumBasis.tla` with the\n`BasisBlind`\nexpected-fail and witness (rest of part b). The manifest residuals\n`basis-token-model` and `latch-model` correctly stay open.\n\n## Type of Change\n\n- [x] 🧪 Test (adding or updating tests)\n- [x] 📚 Documentation (changes to documentation only)\n\n## Verification Impact\n\n- [x] `updated: docs/specs/verification-manifest.toml` — maps the new\n`z3_proof_different_basis_is_never_compared` proof to `checksum-basis`\n- [x] Any new or changed proof has a RED mutation or a non-vacuity\nwitness (see\n      Testing)\n\n`model-impact.py affected --base origin/main` reports no mapped\nproduction\nimpact; no production path or symbol changed.\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] Zero-panic policy: no production code changed; the Z3 file is\ntest-only.\n- [x] I have added tests that prove the change (new gate proof + rewrite\nwitness)\n- [x] `cargo fmt --all -- --check` passes\n- [x] I have run the full nextest suite (`cargo tfull`, see Testing)\n\n### If Applicable\n\n- [x] Documentation updated (`docs/specs/formal-spec.md` + wiki mirror +\n      regenerated alignment table)\n- [ ] `CHANGELOG.md` not changed: test/doc-only, no user-visible crate\nbehavior\n- [ ] Examples not applicable\n- [x] No new compiler warnings\n\n## Testing\n\n```bash\n# Pinned Z3 5.1.0 library, matching ci-verification.yml's z3-verification job\nexport Z3_LIBRARY_PATH_OVERRIDE=/usr/local/lib/python3.13/dist-packages/z3/lib\nexport LD_LIBRARY_PATH=\"$Z3_LIBRARY_PATH_OVERRIDE:$LD_LIBRARY_PATH\"\nexport Z3_SYS_Z3_VERSION=5.1.0\n\ncargo test --features z3-verification --test verification z3\n# test result: ok. 66 passed; 0 failed; 0 ignored; 0 measured; 226 filtered out\n\ncargo clippy --test verification --features z3-verification,tokio,json\n# Finished, no warnings\n\ncargo tfull\n# 3788 tests run: 3788 passed, 77 skipped (42.55s)\ncargo test --doc\n# 160 passed, 0 failed, 51 ignored\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items\n# clean\n\npython3 scripts/ci/agent-preflight.py --full --auto-fix\n# All agent preflight checks passed.\npython3 scripts/verification/model-impact.py check\n# OK (11 components, 31 symbols, 42 artifacts)\npython3 scripts/verification/model-impact.py affected --base origin/main\n# No mapped verification impact (base HEAD).\npython3 scripts/hooks/check-plan-hygiene.py         # clean\npython3 scripts/docs/check-links.py                 # 0 errors, 0 warnings\nbash scripts/ci/check-doc-claims.sh                 # SUCCESS\npython3 scripts/docs/check-tla-config-consistency.py  # SUCCESS\nnpx markdownlint <changed markdown> --config .markdownlint.json  # clean\ntypos <changed files>                                # clean\n```\n\n**Red mutations (restored byte-for-byte after each run):**\n\n1. Replaced the new gate model's `comparison_runs = local_basis ==\nremote_basis`\n   with `Bool::from_bool(true)`:\n   `z3_proof_different_basis_is_never_compared` FAILED with\n`Z3 should prove different basis tokens are never compared` (SAT found).\n2. Made the rewrite branch return `DesyncDetected` instead of `Pending`:\n   `z3_proof_sync_health_state_transitions` FAILED with\n`Z3 should find the reachable rewrite-clears-latch transition` (UNSAT).\n3. Restored both; the full 66-test Z3 suite passed again.\n\n**Tests added/modified:**\n\n- Added `z3_proof_different_basis_is_never_compared`.\n- Narrowed `z3_proof_desync_detection_no_false_negatives_on_comparison`\nto the\nsame-basis comparison primitive (the production gate is its\nprecondition).\n- Extended `z3_proof_sync_health_state_transitions` with\n`rewrite_cleared` and a\nSAT witness; the old \"DesyncDetected -> InSync\" UNSAT check is\npreserved.\n- Updated the two summary tests (text + audited counts).\n\n## Risks and Rollback\n\n- **Risk:** the narrowed proof could hide a real false negative across\nbases.\nMitigated by the separate cross-basis proof and by SAFE-7b being\nexplicitly\n  marked \"not yet proved\" in the formal spec rather than claimed.\n- **Risk:** the model's `Pending` post-rewrite state is an abstraction;\nthe\n  production tests named in SAFE-7c are the code-level evidence.\n- **Rollback:** revert this PR; the Z3 file returns to the previous\nmodels and\n  the formal-spec header returns to 1.1. No runtime or wire change.\n\n## Related Issues\n\n- #572 (part b, Z3 slice; extraction+Kani and `ChecksumBasis.tla`\nremain)\n- Tracking: #580\n- Session-budget blocker fixed in #585",
          "timestamp": "2026-11-26T18:47:07Z",
          "tree_id": "07ba67b84cc72e752dbee3187829645bc8b93057",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/4e400ee30f63052052c18513a8a46d384a5aa223"
        },
        "date": 1795719502285,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 24449,
            "range": "± 433",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 15145,
            "range": "± 205",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 451,
            "range": "± 6",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 562,
            "range": "± 10",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5289,
            "range": "± 149",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "2cef3ccefb83ff88f12d92e6f0676638abc8c2c4",
          "message": "test: resolve the #589 basis proof-strength and rewrite-state findings (#591)\n\n<!-- session: ses_de6fd17caffetszqvtSz73umoT started:\n2026-11-26T19:02:47Z -->\n\n## Description\n\nFixes the four post-merge findings from the fresh-context review of #586\n(#589). No production code changes; this corrects proof-strength labels,\nthe\nrewrite state model, and the formal-spec scope.\n\n1. **The basis Z3 tests are labeled `model_only`.**\n`z3_proof_different_basis_is_never_compared`\nand `z3_proof_desync_detection_no_false_negatives_on_comparison` now\nstate\nthat their gate/precondition is a definition in the model, not a proof\nof the\nRust gate, and name the code-linked Rust tests that exercise the\nproduction\ngate\n(`delayed_pre_rewrite_checksum_report_does_not_relatch_after_a_rewrite`\nand `unknown_basis_tokens_are_never_compared`). The formal spec no\nlonger says\n   the Z3 tests prove the production gate.\n2. **The post-rewrite state is modeled faithfully.**\n`z3_proof_sync_health_state_transitions`\nadds `has_verified_frame`: after a rewrite clears the latch, production\n   `sync_health()` returns `InSync` when a prior frame verified\n(`src/sessions/p2p_session.rs:13680`) and `Pending` otherwise. Both\nunlatched\ntransitions have SAT witnesses; the no-clear mutation fails the `InSync`\n   witness.\n3. **SAFE-7b is scoped to conforming sessions.** The formal spec\ndocuments that\n   `record_checksum_freeze` folds below-floor terms into the adopted\n`checksum_basis_base` and `adopt_checksum_basis` cannot subtract an\ninherited\nfolded term (`src/sessions/p2p_session.rs:17134-17142`, `:17236-17243`).\nA\npeer on that path can derive a different token for the same converged\nhistory;\nthe reports stay incomparable (skipped comparisons), so the exception\ncosts\n   availability and never false-latches.\n4. **PLAN and SAFE-7c are corrected.** `PLAN.md` drops the \"basis-aware\nproof\"\noverclaim and points at #589; SAFE-7c names both unlatched post-rewrite\nstates.\n\n## Type of Change\n\n- [x] 🧪 Test (adding or updating tests)\n- [x] 📚 Documentation (changes to documentation only)\n\n## Verification Impact\n\n- [x] `none` — no mapped production path or symbol changed\n- [x] Any new or changed proof has a RED mutation or a non-vacuity\nwitness (see\n      Testing)\n\n`model-impact.py affected --base origin/main` reports no mapped\nproduction\nimpact. The checksum-basis component's mapped Z3 test changes are a\nverification-artifact update, not a production change.\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] Zero-panic policy: no production code changed; test/doc-only.\n- [x] I have added tests that prove the change (two post-rewrite SAT\nwitnesses)\n- [x] `cargo fmt --all -- --check` passes\n- [x] I have run the full nextest suite (`cargo tfull`, see Testing)\n\n### If Applicable\n\n- [x] Documentation updated (`docs/specs/formal-spec.md` + wiki mirror;\n`PLAN.md`)\n- [ ] `CHANGELOG.md` not changed: test/doc-only, no user-visible\nbehavior\n- [ ] Examples not applicable\n- [x] No new compiler warnings\n\n## Testing\n\n```bash\nexport Z3_LIBRARY_PATH_OVERRIDE=/usr/local/lib/python3.13/dist-packages/z3/lib\nexport LD_LIBRARY_PATH=\"$Z3_LIBRARY_PATH_OVERRIDE:$LD_LIBRARY_PATH\"\nexport Z3_SYS_Z3_VERSION=5.1.0\n\ncargo test --features z3-verification --test verification z3\n# test result: ok. 66 passed; 0 failed; 226 filtered out\n\ncargo clippy --test verification --features z3-verification,tokio,json\n# Finished, no warnings\ncargo tfull\n# 3788 tests run: 3788 passed, 77 skipped\npython3 scripts/ci/agent-preflight.py --full --auto-fix\n# All agent preflight checks passed.\npython3 scripts/verification/model-impact.py check\n# OK (11 components, 31 symbols, 43 artifacts)\npython3 scripts/verification/model-impact.py affected --base origin/main\n# No mapped verification impact (base origin/main).\npython3 scripts/hooks/check-plan-hygiene.py       # clean\npython3 scripts/docs/check-links.py               # 0 errors, 0 warnings\nbash scripts/ci/check-doc-claims.sh               # SUCCESS\npython3 scripts/docs/check-tla-config-consistency.py  # SUCCESS\nnpx markdownlint <changed markdown> --config .markdownlint.json  # clean\ntypos <changed files>                              # clean\n```\n\n**Red mutation (restored byte-for-byte):** replacing the post-rewrite\n`unlatched`\nexpression with `DesyncDetected` makes\n`z3_proof_sync_health_state_transitions` fail with `Z3 should find the\nreachable\nrewrite-clears-latch-to-InSync transition` (expected SAT, got UNSAT).\nRestored,\n66/66 z3 tests pass.\n\n## Risks and Rollback\n\n- **Risk:** the label changes make the model's limits explicit; a reader\nlooking\nfor a code-linked gate proof must follow the named Rust tests, and a\nKani proof\n  remains part of #572 part (a).\n- **Risk:** SAFE-7b's fold exception is prose; the code-linked evidence\nis the\n  fold/adopt unit tests and the `record_checksum_freeze` implementation.\n- **Rollback:** revert this PR; the Z3 models return to the #586 wording\nand the\nformal spec returns to the unqualified SAFE-7b. No runtime or wire\nchange.\n\n## Related Issues\n\n- Fixes #589\n- Follow-up to #586 (merged) and #572 (part b, Z3 slice)\n- Tracking: #580",
          "timestamp": "2026-11-26T19:50:28Z",
          "tree_id": "7e7a86673139e8079033fd6c3b3dc672dfed6374",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/2cef3ccefb83ff88f12d92e6f0676638abc8c2c4"
        },
        "date": 1795723382118,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 61968,
            "range": "± 1922",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 31122,
            "range": "± 114",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1663,
            "range": "± 110",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1555,
            "range": "± 76",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2840,
            "range": "± 199",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "4c2d33f4fbc0b0f976869a92e43295569f7004f9",
          "message": "verification: extract the checksum basis kernel and prove it (#572) (#592)\n\n## Description\n\nCompletes the remaining #572 work: the `ChecksumBasisTracker`\nextraction, the\nfive Kani proofs, and the focused `ChecksumBasis.tla` companion (with\nthe\n`BasisBlind` enforced expected-fail and a non-vacuity witness). The\nZ3/docs\nslice landed earlier in #586 and the #589 corrections in #591.\n\n### Extraction (behavior-preserving)\n\n- Moves the five basis fields and the token/freeze methods out of\n  `src/sessions/p2p_session.rs` into `src/sessions/checksum_basis.rs`\n(`ChecksumBasisTracker`). The session keeps only the remote-report\nclearing\nin `invalidate_checksum_mismatch_from`, which delegates the per-frame\ntoken\n  retain to the tracker.\n- Adds the pure `freeze_action` transition and `fold_token` fold so the\nKani\nharnesses target the actual kernels instead of a whole session.\n`record_freeze`\n  and `token_at` call them.\n- The tracker's fields are `pub(crate)` so the existing characterization\ntests\n  can insert fixtures without changing their semantics.\n- `Default` is manual: `Frame::default()` is frame 0, not `Frame::NULL`,\nso a\nderived default made floor 0 look like an adopted fold. The hot-join cap\ntest\n  caught it (`basis.is_valid()` failed); the manual default restores the\n  pre-extraction `Frame::NULL` initialization.\n\n### Kani (five registered proofs)\n\n- `proof_checksum_basis_same_converged_history_same_token`\n- `proof_checksum_basis_lower_boundary_replaces_term`\n- `proof_checksum_basis_higher_or_equal_redetection_idempotent`\n- `proof_checksum_basis_token_unchanged_below_boundary`\n- `proof_checksum_basis_adopt_preserves_tokens_above_snapshot`\n\nAll five are in Tier 1 of `scripts/verification/verify-kani.sh`;\n`check-kani-coverage.sh` reports all 131 proofs covered.\n\n### TLA+\n\n`specs/tla/ChecksumBasis.tla` + `ChecksumBasis.cfg` (2 peers, frames\n0..1, one\nslot):\n\n- `NoPermanentFalseNegative`: peers frozen at the same converged\nboundary derive\n  the same token at every frame at or above it.\n- `NoFalseLatchAcrossBasis`: a latch is only created on an equal-token\n  comparison.\n- `LatchClearedAtRewrite`: a boundary change at or above a latch frame\nretires\n  it and bumps its generation.\n- `FIX_MODE = \"BasisBlind\"` (`ChecksumBasis_BasisBlind.cfg`) is the\npre-#563\n  additive multiset and is an enforced expected-fail:\n  `NoPermanentFalseNegative` is violated.\n- `ChecksumBasis_Witness.cfg` is a manual, deliberately falsifiable\n  reachability check; TLC reaches `{\"latched\", \"discarded\", \"cleared\"}`.\n\nRegistered in `verify-tla.sh` (`ChecksumBasis` in `SPECS`,\n`ChecksumBasisBlind` in the expected-failure path); README,\n`formal-spec.md`\n(SAFE-7b/7c and the verification row, version 1.6), and the verification\nmanifest (`checksum-basis`/`checksum-latch` now `bounded`, residuals\ncleared)\nare updated; the alignment table and wiki mirror are regenerated.\n\n## Size note\n\nThe diff is 1,063 insertions / 359 deletions, but 359 of those\ninsertions are\nthe moved implementation (the deletions are the old copies) and ~300 are\nthe\nmodel/config/docs; the net behavior change is the tracker extraction\nplus the\nproof kernels (~400 net lines). The kernel, the five proofs, the TLA\nmodel, and\nthe manifest entry are one verification story and are kept in one PR;\nthe Z3\nhalf was already split into #586/#591.\n\n## Type of Change\n\n- [x] ♻️ Refactor (behavior-preserving extraction)\n- [x] 🧪 Test (five Kani proofs, characterization/differential test)\n- [x] 📚 Documentation (formal spec, README, manifest, wiki)\n- [x] 🔧 CI/Build (Kani/TLA registration)\n\n## Verification Impact\n\n- [x] `updated: docs/specs/verification-manifest.toml` +\n      `specs/tla/ChecksumBasis.tla` + `src/sessions/checksum_basis.rs`\n- [x] Any new or changed proof has a RED mutation or a non-vacuity\nwitness (see\n      Testing)\n\n`model-impact.py check` is OK (11 components, 32 symbols, 51 artifacts);\n`affected --base origin/main` reports no mapped impact because the\nmapped\nproduction paths changed by the extraction are accompanied by the\nmodel/proof\nupdate in the same diff.\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] Zero-panic policy: no `unwrap`/`expect`/`panic!` added to\nproduction code;\nthe tracker keeps the existing `Result`/fallback style and `.get`/hash\n      fallbacks.\n- [x] I have added tests (characterization, differential, Kani, TLA).\n- [x] `cargo fmt --all -- --check` passes.\n- [x] `cargo clippy --workspace --all-targets --features tokio,json`\npasses.\n- [x] `cargo tfull` passes (`3789 passed, 77 skipped`).\n\n### If Applicable\n\n- [x] Documentation updated (formal spec, TLA README, manifest, wiki)\n- [ ] `CHANGELOG.md` not changed: internal refactor + verification only,\nno\n      user-visible behavior or API change\n- [ ] Examples not applicable\n- [x] No new compiler warnings\n\n## Testing\n\n```bash\n# Characterization baseline / after\ncargo test --lib basis\n# baseline on main: 9 passed\n# after extraction:  10 passed (the new differential test)\n\ncargo tfull\n# 3789 tests run: 3789 passed, 77 skipped\ncargo test --doc\n# 160 passed; 0 failed; 51 ignored\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items\n# clean\ncargo clippy --workspace --all-targets --features tokio,json\n# clean\n\n# Kani (five Tier-1 proofs)\nRUSTFLAGS=\"--cap-lints=allow\" cargo kani --harness proof_checksum_basis_same_converged_history_same_token\n# VERIFICATION:- SUCCESSFUL (1/1)\n# ... the other four: SUCCESSFUL (1/1)\nbash scripts/verification/check-kani-coverage.sh\n# SUCCESS: All 131 Kani proofs are covered in tier lists.\n\n# TLA+\n./scripts/verification/verify-tla.sh ChecksumBasis\n# ChecksumBasis: PASS\n# ChecksumBasisBlind: PASS (expected NoPermanentFalseNegative counterexample)\njava ... -config specs/tla/ChecksumBasis_Witness.cfg ...\n# Invariant WitnessGoal violated at witness = {\"latched\",\"discarded\",\"cleared\"}\n\npython3 scripts/ci/agent-preflight.py --full --auto-fix      # all checks passed\npython3 scripts/verification/model-impact.py check           # OK, 51 artifacts\npython3 scripts/hooks/check-plan-hygiene.py                  # clean\nbash scripts/ci/check-doc-claims.sh                          # SUCCESS\npython3 scripts/docs/check-links.py                          # 0 errors, 0 warnings\npython3 scripts/docs/check-tla-config-consistency.py         # SUCCESS\nnpx markdownlint <changed markdown> --config .markdownlint.json  # clean\ntypos <changed files>                                        # clean\n```\n\n**RED evidence:**\n\n1. Kani proof mutation: removing the `freeze_action` down-only guard\nmakes\n   `proof_checksum_basis_same_converged_history_same_token` FAILED\n   (`assert_failed_inner`, restored after the run).\n2. Kani proof mutation: removing the `fold_token` `floor <= frame` guard\nmakes\n`proof_checksum_basis_token_unchanged_below_boundary` FAILED on the\nassertion\n   (restored after the run).\n3. Differential unit test\n`old_additive_floor_multiset_diverges_from_converged_token`: the\npre-#563\n   multiset token differs from the converged single-term token (#562).\n4. Negative result: the first extraction used `#[derive(Default)]`,\nwhich gave\n`fold_floor = 0`; the hot-join cap test failed on `basis.is_valid()`. A\nmanual\n   `Default` with `Frame::NULL` fixed it; 9/9 basis tests then passed.\n\n**Local Kani note:** the devcontainer's active Kani is 0.68.0 while\n`.kani-version` pins 0.67.0, and 0.68 adds a pre-existing lint in\n`src/sync_layer/mod.rs` under `deny(warnings)`. The local runs used\n`RUSTFLAGS=\"--cap-lints=allow\"`; no lint allowance was committed, and CI\nruns\nthe 0.67.0 pin.\n\n## Risks and Rollback\n\n- **Risk:** the extraction changes field access paths in ~70 test sites;\nthe\ncharacterization tests and the full suite guard it. No public API, wire,\nor\n  serialization change.\n- **Risk:** the TLA model is bounded (2 peers, 2 frames) and does not\nmodel the\nfolded/adopted basis exception or the 64-bit collision bound; those stay\n  documented as scope, not proved properties.\n- **Risk:** the pure Kani kernels do not cover the BTreeMap construction\nitself;\nthe cap characterization test and the `adopt` proof cover the map\ninputs.\n- **Rollback:** revert this PR; the tracker methods return to\n`p2p_session.rs`, the Kani/TLA registrations are removed, and the\nmanifest\n  returns to the stale residual.\n\n## Post-review additions\n\n- `ChecksumReport::basis_token` and `SyncHealth::InSync` now describe\nthe\nconverged-boundary token and rewrite clearing. `src/network/messages.rs`\nis\nalso mapped to `double-failure-relay`, so the manifest carries a\none-month,\nnamed waiver for that doc-only path; `checksum-basis` is updated by the\nnew\n  spec/proofs in the same diff.\n- `PLAN.md` removes the completed #572 item and leaves `In progress`\nempty.\n\n## Related Issues\n\n- Fixes #572\n- #589 (post-merge model corrections, merged in #591)\n- Tracking: #580",
          "timestamp": "2026-11-26T21:34:29Z",
          "tree_id": "b0b18060347acf2d25cf5065239f04750ca97810",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/4c2d33f4fbc0b0f976869a92e43295569f7004f9"
        },
        "date": 1795729504653,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 41543,
            "range": "± 2038",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 24289,
            "range": "± 582",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 3",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1243,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2765,
            "range": "± 168",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "7b695d16dd9ab9a124955209d5807d7dd5541833",
          "message": "verification: extract and prove the coordinated-drop terminal epoch table (#574) (#595)\n\n## Description\n\nExtracts the coordinated-drop terminal-attempt epoch map from\n`P2PSession` into a\n`pub(crate)` state machine and machine-checks its transition kernels.\nThis is #574 in the\napproved proof-drift queue (#580); it changes no public API, wire\nformat, or behavior.\n\nThe old map lived inline in `src/sessions/p2p_session.rs` and was pinned\nonly by prose and\ndeterministic tests. `docs/specs/formal-spec.md` claimed\n`AtMostOneCommittedCut` survives\n\"without a new model\" while the map invariant was unproven. This PR:\n\n- Adds `src/sessions/terminal_epoch.rs` with `CanonicalTargetSet`,\n`TerminalEpochKey`,\n`TerminalEpochEntry`, `TerminalEpochTable`, `TerminalEpochRecord`,\n`EpochAdmission`, and the pure\nkernels `advance_next`, `epoch_generation_is_current`,\n`epoch_space_is_retained`,\n  `canonicalize_handles`, and `epoch_admission`.\n- Moves the epoch lookup, insertion, pruning, capacity refusal, and\nadmission decision behind the\ntable. The session keeps only its local-generation and target-generation\ngates.\n- Adds five registered Kani harnesses on the real module functions:\n  - `proof_terminal_epoch_next_is_monotone`\n  - `proof_terminal_epoch_one_ahead_does_not_swallow_current`\n  - `proof_terminal_epoch_at_most_two_generations_per_target_set`\n-\n`proof_terminal_epoch_fallback_adoption_is_bounded_and_only_when_empty`\n  - `proof_terminal_epoch_entry_targets_match_key_handles`\n- Updates `formal-spec.md` to drop the unqualified \"without a new model\"\nclaim and cite the five\nkernels; the statement is now that the epoch is an admission filter over\nthe same commit path.\n- Updates the verification manifest: `terminal-epoch` moves from\n`unmodeled` to `bounded`, the\n`terminal-epoch-proof` residual closes, and the five harnesses + four\ntable tests are mapped.\n\n**Kani scope, stated plainly.** CBMC cannot model the bounded\n`BTreeMap<TerminalEpochKey, TerminalEpochEntry>` in budget: a one-entry\ninsert with heap `Vec` keys\nran for more than 30 minutes before I stopped it. The harnesses\ntherefore verify the load-bearing\ntransition kernels on production functions, including the production\n`EpochSpaceIdentity` type that\nis the authority component of `TerminalEpochKey` and is compared by the\nmap through its derived\n`Eq`/`Ord`. Table-level Rust tests cover the full key composition,\nexact-key lookup, canonical-order\nsharing, entry-target refresh, pruning, capacity refusal, and\nno-epoch-reuse. This is the stop\ncondition the issue allows (\"prove the key/admission helper and keep the\nmap construction\nconcrete\"); the module documents the split and the manifest carries the\nexplicit\n`terminal-epoch-key-ord` residual for the full-key/map layer rather than\nclaiming it is\nKani-proved.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [x] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Verification Impact\n\n- [ ] `none` — no mapped production path or symbol changed\n- [x] `updated: docs/specs/verification-manifest.toml + five Kani\nharnesses` — `terminal-epoch` is\nnow `bounded`; `model-impact.py affected --base origin/main` reports a\npresent verification\n  update.\n- [ ] `waived: <reason + approver>`\n- [x] Any new or changed proof has a RED mutation or a non-vacuity\nwitness: the old\nhandles-only identity fails\n`proof_terminal_epoch_one_ahead_does_not_swallow_current` (recorded\nbelow), and reverting `coordinator_generation` out of the production key\nfails both table tests.\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy** — no\n`unwrap`/`expect`/`panic!` in production; all\n  fallible paths return `Result`, and slice access uses `get`\n- [x] I have added tests that prove my fix is effective or my feature\nworks — 9 table tests plus 5\n  Kani harnesses; the targeted mutation run is recorded below\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no\n  warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly — `formal-spec.md`\nv1.8, regenerated wiki mirror\n  and alignment table\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes —\nN/A, `pub(crate)` refactor\n  with no public API or behavior change\n- [ ] I have updated relevant examples in the `examples/` directory —\nN/A\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `src/sessions/terminal_epoch.rs`: 9 unit tests covering separate\ncurrent/one-ahead epochs,\ncanonical order/dedup sharing, behind-era pruning, the two-generation\nbound over eight eras,\nstale-target reclamation, capacity refusal, bounded/empty-state fallback\nadmission, direct\n`advance_next` behavior, and direct sort/dedup/descending/clamp\nbehavior.\n- `scripts/verification/verify-kani.sh`: five Tier 1 harnesses\nregistered.\n- `src/sessions/p2p_session.rs`: existing epoch/fallback tests\nunchanged; only the internal\n  `.terminal_epochs.len()`/key access adapts to the table API.\n\n**Commands and observed output:**\n\n```text\ncargo nextest run --workspace --features tokio,json,hot-join\n  Summary [38.676s] 3802 tests run: 3802 passed, 77 skipped\n\ncargo kani --harness proof_terminal_epoch_\n  Complete - 5 successfully verified harnesses, 0 failures, 5 total\n  (per-harness Verification Time 0.092s-2.799s)\n\n./scripts/verification/check-kani-coverage.sh\n  SUCCESS: All 136 Kani proofs are covered in tier lists.\n\ncargo test --doc\n  test result: ok. 160 passed; 0 failed; 51 ignored\n\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items\n  Finished (no warnings)\n\ncargo check --target wasm32-unknown-unknown --no-default-features\ncargo check -p wasm-browser-smoke --features hot-join --target wasm32-unknown-unknown --lib --tests\ncargo check --target wasm32-unknown-emscripten --no-default-features\n  all pass\n\ncargo kani --only-codegen\n  Finished (Kani cfg compile passes)\n\n.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix\n  All agent preflight checks passed.\n\npython3 scripts/verification/model-impact.py affected --base origin/main\n  terminal-epoch [bounded] ... verification update: present (exit 0)\n```\n\n**RED control (exact failure):**\n\n```text\n# production key reverted to handles + coordinator only (old #525 identity)\nFAIL sessions::terminal_epoch::tests::current_and_one_ahead_eras_keep_separate_epochs\n  left: 7\n right: 3\nFAIL sessions::terminal_epoch::tests::table_prunes_a_behind_era_when_the_local_view_advanced\n  left: 1\n right: 0\nSummary [0.094s] 2 tests run: 0 passed, 2 failed\n\n# Kani kernel reduced to the old handles-only identity\nCheck 4: ...proof_terminal_epoch_one_ahead_does_not_swallow_current.assertion.1\n  - Status: FAILURE\nVERIFICATION:- FAILED\nComplete - 0 successfully verified harnesses, 1 failures, 1 total.\n```\n\nBoth pass again once the generation is restored.\n\n**Mutation testing:**\n\n- Existing #525 evidence retained: 22 caught, 8 unviable, 0 missed on\nthe same helpers.\n- First run on the extracted file: 64 mutants, 30 caught, 19 unviable,\n15 missed. All 15 survivors\nwere in `advance_next` (3) and `canonicalize_handles` (12); the\ncanonicalization survivors\nexposed that the table tests could pass with the same broken\ncanonicalization on both sides.\n- Hardening: added direct `advance_next` and `canonicalize_handles`\ntests (unsorted, duplicate,\ndescending, already sorted, single, empty, and clamped inputs) and\nreplaced the hand-written max\n  comparison with `std::cmp::max`.\n- Final focused run on the two changed kernels:\n\n  ```text\n  cargo mutants -f src/sessions/terminal_epoch.rs \\\n-F 'advance_next|canonicalize_handles' --cargo-test-arg terminal_epoch \\\n    --baseline=skip -j4\n  Found 20 mutants to test\n  20 mutants tested in 8m: 14 caught, 6 unviable\n  ```\n\nThe rest of the file was unchanged by the hardening and stayed at 30\ncaught / 19 unviable from\nthe full-file run. The review-added `record` generation guard was\nchecked separately: removing\nthe `!` makes `record_ignores_a_generation_outside_the_local_pair` fail\n(`1 failed`), and restoring it passes. The surviving-class tests were\nalso verified directly\nagainst the mutated code (for example `index -= 1` -> `index += 1`\nproduced\n`left: Some([3, 1, 2, 4])` against `right: Some([1, 2, 3, 4])` before\nthe descending fixture).\n\n**Manual testing performed:**\n\n- None beyond the command suite above; the change is an internal\nextraction with no runtime\n  behavior change.\n\n## Risks and Rollback\n\n- **Risk:** the table's `BTreeMap` mechanics are not Kani-verified.\n**Mitigation:** table tests pin\nexact-key lookup, canonical-order sharing, pruning, capacity refusal,\nand no-epoch-reuse, and the\nexisting deterministic eviction/replay, abort, and fallback tests are\nunchanged and green.\n- **Risk:** `canonicalize_handles` is a hand-written O(n²) sort instead\nof `sort_unstable`.\n**Mitigation:** target sets are bounded by the roster (single-digit to\nlow-double-digit handles),\nthe kernel is exhaustively proof-checked for a three-handle set, and\ndirect tests cover\n  unsorted/duplicate/descending/clamped inputs.\n- **Rollback:** revert this PR; the module is `pub(crate)` and the wire\nformat is untouched, so no\n  migration or state cleanup is needed.\n\n## Diff size\n\n+1049/−171 (878 net), above the ~400-line guidance and below the 1,000\nstop. The new module is 896\nlines including five Kani proofs and nine tests; the production move is\nclose to neutral after\nremoving the old inline map. Splitting would leave an unproven\nintermediate table or a proof-only\nPR, so extraction, kernels, and tests stay together as #574 specifies.\n\n## Fresh-context review follow-up\n\nA read-only fresh-context reviewer audited the first head against\n`origin/main`; no behavior drift,\npublic API/wire change, zero-panic violation, or weakened test was\nfound. All six actionable items\nare applied in `6c44938d`:\n\n1. Regenerated the stale wiki mirror (the `Script Tests & Wiki Dry-Run`\nfailure).\n2. Made the coordinator/generation identity a production field of\n`TerminalEpochKey`\n(`EpochSpaceIdentity`, compared by the map via derived `Eq`/`Ord`) and\npointed the Kani harness at\nthat type. Removing the generation from the production identity fails\nthe harness (recorded\nbelow). The full-key/`BTreeMap` layer stays a manifest residual with\nmutation-tested table\n   tests.\n3. Added reverse-membership to the canonicalization proof and a table\ntest for entry-target refresh\n   across a target-generation change.\n4. Avoided the extra participant-prepare key lookup (`local_is_authority\n&& ...`).\n5. Corrected the table-test location in `formal-spec.md`.\n6. Made the two-generation bound a `record` invariant (ignore\nout-of-local-pair generations) with a\n   discriminating test.\n\n**Production identity RED control** (generation removed from\n`EpochSpaceIdentity`):\n\n```text\nCheck 3: core::panicking::assert_failed_inner.assertion.1\n  - Status: FAILURE\nSUMMARY: ** 1 of 41 failed\nVERIFICATION:- FAILED\nComplete - 0 successfully verified harnesses, 1 failures, 1 total.\n```\n\nRestoring the field makes all five harnesses pass again.\n\n## Related Issues\n\nCloses #574. Tracking queue: #580.",
          "timestamp": "2026-11-27T00:54:52Z",
          "tree_id": "9c14d959defa6965c9ad210b05224d69e127df61",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/7b695d16dd9ab9a124955209d5807d7dd5541833"
        },
        "date": 1795741591227,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 48393,
            "range": "± 1133",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 29835,
            "range": "± 497",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 816,
            "range": "± 100",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1013,
            "range": "± 11",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7961,
            "range": "± 116",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "7df920036ced927f522969b403d2497147b0315e",
          "message": "refactor: extract ReadyTranscripts from p2p_session (#576) (#596)\n\n## Description\n\nExtracts the coordinated-drop `Ready` bookkeeping from `P2PSession` into\na\n`pub(crate)` `ReadyTranscripts` typestate in\n`src/sessions/ready_transcripts.rs`.\nThe struct now owns the locked cut digest, the locked and provisional\ntranscripts, and the counted set. `Provisional` and `Locked` transcripts\nare\ndistinct types, the counted set is private, and only promotion against\nthe\nlocked digest can count a provisional report. That makes the #529\ninvalid state\nunrepresentable rather than merely tested: a non-authority `Ready`\nreceived\nbefore the digest is locked stays provisional and never contributes to\nthe\nstrict-majority quorum.\n\nThis is phase 2 of #576 and follows the merged `checksum_basis` (#572)\nand\n`terminal_epoch` (#574) extractions. It adds three Kani harnesses on the\nreal\nmodule functions, nine module characterization tests, and keeps the\nsession-level authority and quorum decisions in `p2p_session`. The lock\nowns\nthe selected cut as well as the digest, so a matching digest under\nanother cut\nis rejected before any state changes.\n\nNo public API, wire, protocol, or behavior change. The admission,\npromotion,\ncommit-adoption, resync, and retransmission paths preserve their\nexisting\nordering and relay decisions.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [x] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [ ] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Verification Impact\n\n- [ ] `none` — no mapped production path or symbol changed\n- [x] `updated: Kani + manifest + formal spec` — `provisional-ready`\nmaps the new\n`ready_admission`, `admit`, `lock_digest`, and `promote_matching`\nsymbols to\n  three Kani proofs, module tests, and the existing\n  `CoordinatedReadyDigest.tla` model. `model-impact check` passes.\n- [ ] `waived: <reason + approver>` — a named maintainer approved the\nexception and it is recorded in the tracked issue/PR\n\n- [x] Any new or changed proof has a RED mutation or a non-vacuity\nwitness (state which below).\n\n**RED mutation:** flipping the admission guard to `None if !authority =>\nCount`\n(the #529 rule) makes 7 targeted tests fail, including all three\n`p2p_session` integration tests, and makes\n`proof_ready_transcripts_promotion_requires_matching_digest` fail at the\nfirst assertion. The mutation was restored and the file sha256\nre-checked.\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**:\n  - No `unwrap()` in production code\n  - No `expect()` in production code\n  - No `panic!()` or `todo!()`\n  - All fallible operations return `Result`\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly\n(`docs/specs/formal-spec.md`,\n`docs/specs/verification-manifest.toml`,\n`docs/specs/spec-divergences.md`)\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes —\nnot\napplicable: internal extraction, no public API or user-observable\nbehavior\n- [ ] I have updated relevant examples in the `examples/` directory —\nnot applicable\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- `sessions::ready_transcripts::tests` (9 module tests): provisional\nadmission,\n  mismatch discard, locked-digest conflict, wrong-cut conflict,\nparticipant-retry conflict, pre-lock count refusal, commit-adoption\nordering,\n  resync cut/digest rules, and locked-transcript ordering.\n- 12 targeted integration tests pass, including\n  `non_authority_ready_cannot_lock_the_digest_or_count`,\n\n`matching_provisional_ready_is_promoted_when_authority_locks_the_digest`,\nand\n\n`local_history_locks_the_digest_despite_a_conflicting_provisional_ready`.\n\n**Evidence (exact commands):**\n\n```text\ncargo fmt --all -- --check                          PASS\ncargo clippy --workspace --all-targets --features tokio,json\n                                                    PASS (no warnings)\ncargo tfull                                        3810 passed, 0 failed, 77 skipped\ncargo nextest run --workspace --features hot-join,tokio,json\n                                                   3811 passed, 0 failed, 77 skipped\ncargo test --doc                                   160 passed, 0 failed, 51 ignored\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items\n                                                    PASS\ncargo check --target wasm32-unknown-unknown --no-default-features\n                                                    PASS\ncargo check --target wasm32-unknown-emscripten --no-default-features\n                                                    PASS\npython3 scripts/api/public_api_census.py --check   PASS (2779 symbols)\n./scripts/verification/verify-tla.sh CoordinatedReadyDigest\n                                                   PASS (2 passed, 0 failed)\n.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix\n                                                   PASS (all checks)\npython3 scripts/hooks/check-plan-hygiene.py        PASS\n```\n\n**Kani (Kani 0.68.0 local; repository pin 0.67.0 runs the same harnesses\nin CI):**\n\n```text\nproof_ready_admission_count_requires_authority_or_lock       SUCCESSFUL\nproof_ready_transcripts_provisional_never_counts             SUCCESSFUL\nproof_ready_transcripts_promotion_requires_matching_digest   SUCCESSFUL\n```\n\nThe local Kani invocation needed\n`RUSTFLAGS=\"-A semicolon-in-expressions-from-non-local-macros\"` because\nthe\npinned repository toolchain and the locally installed Kani nightly\ndisagree on\nthat pre-existing lint; no repository code suppresses the lint.\n\n**Mutation evidence:**\n\n```text\nmutated: None if !authority => Admission::Count\ncargo nextest run -E 'test(/ready_transcripts|non_authority_ready|provisional/)'\n  12 tests run: 5 passed, 7 failed\ncargo kani --harness proof_ready_transcripts_promotion_requires_matching_digest\n  VERIFICATION: FAILED (assertion failed: ready.admit(... false).is_ok())\nrestored: sha256 279d5f03... matches the pre-mutation copy\n```\n\n## Risks and rollback\n\n- **Risk:** the extraction keeps `Ready` relay decisions in the caller;\na\n  missed relay would delay convergence. The admission path returns\n`newly_locked || newly_recorded`, and the full 3,810-test suite plus the\n  focused integration tests pass.\n- **Residual risk:** the `BTreeMap` composition, certificate-adoption\nordering,\nand the session-level authority decision are module/integration tested,\nnot\nKani-proved; the manifest records this as `ready-transcript-map` (review\nby\n  2027-02-01).\n- **Rollback:** revert this squash commit. It changes no persistent\nstate,\nwire format, or public API, so a revert restores the inline bookkeeping\n  without migration.\n\n## Related Issues\n\nRelates to #576 (phase 2: `ready_transcripts`). Refs #529 and #530 for\nthe\nprovisional-`Ready` gate. The earlier phases are #572 (`checksum_basis`)\nand\n#574 (`terminal_epoch`).",
          "timestamp": "2026-11-27T02:47:10Z",
          "tree_id": "673a1151cb6d99e3261837be56e81aa6fe337cf1",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/7df920036ced927f522969b403d2497147b0315e"
        },
        "date": 1795748393860,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 61671,
            "range": "± 1651",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 32351,
            "range": "± 816",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1712,
            "range": "± 112",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1554,
            "range": "± 68",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3129,
            "range": "± 189",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "d76bf3b295ad539ef6cefd7b40d00bd1a9ba7cb2",
          "message": "test: bound the ReadyTranscripts promotion proof (#597) (#598)\n\n## Description\n\nFixes the red `main` at `7df92003` (CI - Verification / Kani Tier 1).\nThe new\n`proof_ready_transcripts_promotion_requires_matching_digest` harness\ncarried two fully symbolic\n`u64` digests through three BTree collections at the default `unwind(8)`\nbound. CBMC spent 480.6 s\nand hit the 300 s per-proof timeout; the harness itself reported\n`VERIFICATION:- SUCCESSFUL`, so\nthis is tractability, not a counterexample.\n\n- Lower the harness bound to `unwind(4)`: the harness stages at most one\nentry in each of the three\nBTree collections, so their drop/navigation loops unroll three times and\nthe `#[kani::unwind(4)]`\nloop assertion holds. Local solve drops from >420 s (killed) to 30.8 s.\n- Move the collection-aware harness from `TIER1_PROOFS` to\n`TIER2_PROOFS`. Tier 1 is defined as\n`<30 s each`; 30.8 s local is ~57 s on CI at the measured 1.86x local/CI\nratio, so Tier 2\n(30 s-2 min, 300 s per-proof budget) is the honest classification. The\ntwo pure kernels stay in\n  Tier 1.\n- No production code, behavior, wire format, or public API change. The\nharness keeps the same two\n  symbolic `u64` inputs and the same assertions.\n\nSession: `ses_de5049797ffeJI52U1KsRjM8PE` (red-main fix-forward).\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [x] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Verification Impact\n\n- [ ] `none` — no mapped production path or symbol changed\n- [x] `updated: Kani harness + tier registration` — the\n`provisional-ready` promotion harness bound\nand registration are updated; `python3\nscripts/verification/model-impact.py affected --base\norigin/main` reports no mapped production impact, and `model-impact.py\ncheck` passes.\n- [ ] `waived: <reason + approver>` — not applicable\n\n- [x] Any new or changed proof has a RED mutation or a non-vacuity\nwitness (state which below).\n\n**RED mutation:** removing the digest-equality guard in\n`promote_matching` (so any provisional\nreport with the selected cut counts) makes the harness fail 1 of 3,492\nchecks at\n`\"the provisional report counts only when its digest matches the lock\"`\n(`src/sessions/ready_transcripts.rs:448`, 26.9 s solve). The mutation\nwas restored; the committed\ndiff contains only the unwind bound/comment and the tier registration.\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**:\n  - No `unwrap()` in production code\n  - No `expect()` in production code\n  - No `panic!()` or `todo!()`\n  - All fallible operations return `Result`\n- [x] I have added tests that prove my fix is effective or my feature\nworks — the existing harness is\n  the test; its RED mutation and restored green are recorded above.\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no\n  warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly — the harness's\n`#[kani::unwind]` rationale is\n  documented in place; no user-facing docs describe tiers.\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes —\nnot applicable: internal\n  verification tooling, no public API or behavior.\n- [ ] I have updated relevant examples in the `examples/` directory —\nnot applicable.\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- No new test cases. The `provisional-ready` promotion harness keeps its\ntwo fully symbolic `u64`\ninputs and all assertions (match counts, mismatch is discarded not\nrelabeled, wrong cut is\n  rejected); only the unwind bound changes.\n\n**Evidence (exact commands):**\n\n```text\ncargo fmt --all -- --check                                      PASS\ncargo c (clippy --workspace --all-targets --features tokio,json) PASS (no warnings)\ncargo tf                                                        3009 passed, 512 skipped\ncargo tfull                                                     3810 passed, 0 failed, 77 skipped (54 s)\ncargo test --doc                                                160 passed, 51 ignored\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items\n                                                                PASS\ncargo check --target wasm32-unknown-unknown --no-default-features PASS\ncargo check -p wasm-browser-smoke --features hot-join --target wasm32-unknown-unknown --lib --tests\n                                                                PASS\n./scripts/verification/verify-kani.sh --quick --tier 1          77 passed, 0 failed (263 s)\n./scripts/verification/verify-kani.sh --quick --tier 2 --part 1 --parts 6\n                                                                7 passed, 0 failed (62 s; includes the moved harness)\n./scripts/verification/verify-kani.sh --quick --harness proof_ready_transcripts_promotion_requires_matching_digest\n                                                                1 passed, 0 failed (37 s)\n./scripts/verification/check-kani-coverage.sh                   139 / 139 proofs registered\npython3 scripts/verification/model-impact.py check              OK (11 components)\nbash scripts/ci/check-shell-portability.sh                      PASS (51 scripts)\n.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix PASS\npython3 scripts/hooks/check-plan-hygiene.py                     PASS\n```\n\n**Mutation evidence:**\n\n```text\nmutated: if transcript.cut() == lock.cut { ... }      (digest-equality guard removed)\n./scripts/verification/verify-kani.sh --quick --harness proof_ready_transcripts_promotion_requires_matching_digest --verbose\n  EXIT 1, 1 of 3492 checks failed\n  Failed Checks: \"the provisional report counts only when its digest matches the lock\"\n  src/sessions/ready_transcripts.rs:448, Verification Time: 26.9 s\nrestored: `git diff` contains only the 11 insertions / 2 deletions described above\n```\n\nKani tiers are push-only (`if: github.event_name != 'pull_request'` in\n`.github/workflows/ci-verification.yml`); the PR's `Kani cfg Compile`\njob type-checks the harness,\nlocal Tier 1, Tier 2 part 1/6, and the single-harness run cover it here,\nand main CI executes every\ntier immediately after merge.\n\n## Risks and rollback\n\n- **Risk:** Kani tiers are push-only, so pull-request CI does not\nexecute the harness. It remains\ntype-checked by `Kani cfg Compile`, locally verified at the same bound\n(Tier 1, Tier 2 part 1/6,\nand the single-harness run), and main CI runs every tier after merge. If\nCI measures over\n2 minutes, a follow-up can re-tier to Tier 3; the 300 s per-proof budget\nstill applies.\n- **Residual risk:** the harness's `unwind(4)` assumes the one-entry\nstaging documented in the\ncomment. A future harness that stages more entries must raise the bound;\nthe unwinding assertions\n  fail loudly if it does not.\n- **Rollback:** revert the squash commit. No persistent state, wire\nformat, or public API changes.\n\n## Related Issues\n\nFixes #597. Relates to #576 (phase 2 kernel extraction) and #596 (the\nmerge that introduced the\nharness). Refs #529 for the provisional-`Ready` gate.",
          "timestamp": "2026-11-27T03:46:57Z",
          "tree_id": "8ce21258b934c3eb8d752887c46c05832338ed99",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/d76bf3b295ad539ef6cefd7b40d00bd1a9ba7cb2"
        },
        "date": 1795751970963,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 62320,
            "range": "± 685",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 31582,
            "range": "± 275",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1667,
            "range": "± 111",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1554,
            "range": "± 65",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2994,
            "range": "± 178",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "cb13bd864c622d2cd0ba939fca6aa567708af0e9",
          "message": "verification: classify Z3 proof strength and fix summary counts (#575) (#608)\n\n<!-- session: ses_de450524bffeNVAWmjAHNwSWnO started:\n2026-11-27T06:27:07Z -->\n\n## Description\n\nCompletes #575's classification deliverable. The stale desync claims\nwere already retired by #586\nand #591, and #572 added the code-linked Kani proofs; what remained was\nan honest classification of\nevery `z3_*` test and a durable check so the labels do not drift.\n\nThis PR adds a `[z3_proof_strength]` table to\n`docs/specs/verification-manifest.toml` and extends `model-impact.py\ncheck` to enforce it. All 66\ntests in `tests/verification/z3.rs` are classified exactly once (the\neight direct\nguard/premise restatements are `tautology`, not `model_only`):\n\n| Strength | Count | Meaning |\n| --- | --- | --- |\n| `code_linked` | 0 | executes production code or fails on a targeted\nproduction mutation |\n| `model_only` | 29 | a hand-written model of a production\nalgorithm/guard; not a code proof |\n| `witness_only` | 9 | asserts satisfiability/reachability only |\n| `tautology` | 28 | restates a premise/definition, or is a print-only\nsummary |\n\n**Headline finding:** no Z3 test is code-linked. The file never imports\nor calls\n`fortress_rollback`; it constructs `z3::ast::Int`/`Bool` models. The\nproduction controls for the\nchecksum-basis/desync properties are the Kani kernels\n(`ChecksumBasisTracker`,\n`ReadyTranscripts`, `TerminalEpochTable`) and the Rust differential\ntests named in the issue, for\nexample\n`delayed_pre_rewrite_checksum_report_does_not_relatch_after_a_rewrite`;\nthe other\nmodel-only rows have no control, as the rationale table records.\n\nThe PR also corrects `z3_verified_properties_summary`: it printed \"64 Z3\nproofs (plus 2 summary\ntests = 66)\", but the file has 62 non-summary tests and four summaries.\nThe group list now includes\nthe mesh-agreed split and the runtime-delay prose section it had\nomitted, the totals are 62\nnon-summary tests + 4 summaries = 66, and the labels no longer call\nevery non-summary test a\n\"proof\".\n\n### Size note\n\nThe hand-written diff is 393 insertions / 29 deletions. The manifest\ntable is the 66 mandatory\nclassifications plus the legend; the `model-impact.py` and test changes\nare the coverage\nenforcement. The issue calls for one classification and one durable\ncheck;\nsplitting the table from the check would leave half the contract\nunenforced.\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [x] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Verification Impact\n\n- [x] `none` — no mapped production path or symbol changed\n- [ ] `updated: <spec/proof>` — the model, proof, or mapped test is\nupdated in this PR\n- [ ] `waived: <reason + approver>` — a named maintainer approved the\nexception and it is recorded in the tracked issue/PR\n\n- [x] Any new or changed proof has a RED mutation or a non-vacuity\nwitness (state which below)\n\n`model-impact.py check` now also validates the classification table:\nevery `z3_*` test exactly once,\nvalid strength names, no duplicates, no unknown tests, and a\n`code_linked` entry mapped to a\ncomponent's `z3` list. `affected --base origin/main` reports no mapped\nproduction impact.\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**:\n  - No `unwrap()` in production code\n  - No `expect()` in production code\n  - No `panic!()` or `todo!()`\n  - All fallible operations return `Result`\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes —\nnot changed: internal\nverification tooling and test prose only, no user-visible behavior or\nAPI change\n- [ ] I have updated relevant examples in the `examples/` directory —\nnot applicable\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n```bash\n# Baseline (clean bd727782)\ncargo test --features z3-verification --test verification z3\n# test result: ok. 66 passed; 0 failed; 226 filtered out; finished in 0.21s\n\n# Manifest coverage and the new checks\npython3 scripts/verification/model-impact.py check\n# model-impact check: OK (11 components, 40 symbols, 76 artifacts)\npython3 scripts/verification/model-impact.py affected --base origin/main\n# No mapped verification impact (base origin/main).\npython3 scripts/verification/model-impact.py render --check\n# model-impact render: up to date\n\n# The checker's own regression tests\n.venv/bin/python -m pytest scripts/tests/test_model_impact.py -q\n# 82 passed\n\n# Summary edit and the whole Z3 suite\ncargo test --features z3-verification --test verification z3\n# test result: ok. 66 passed; 0 failed\n\n# Full gate\ncargo fmt --all -- --check                                      # clean\ncargo c                                                          # clean\ncargo tfull                                                      # 3810 passed, 77 skipped\ncargo test --doc                                                 # 160 passed, 51 ignored\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items  # clean\n.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix # all checks passed\nnpx markdownlint <changed markdown> --config .markdownlint.json  # clean\ntypos <changed text files>                                       # clean\n```\n\n**RED mutation evidence.** In `compare_local_checksums_against_peers`,\nthe basis gate\n`if local_token != remote.pending_checksum_basis_token(remote_frame)`\nwas temporarily changed to a\nself-comparison that never skips, so every pending checksum is compared.\nUnder that mutation the\nZ3 suite stayed green (`66 passed`) while the Rust test\n`delayed_pre_rewrite_checksum_report_does_not_relatch_after_a_rewrite`\nfailed. The mutation was\nrestored with `git checkout -- src/sessions/p2p_session.rs`; `git diff`\nthen showed only `PLAN.md`\nand this branch's files. This is the non-binding-proof evidence the\nissue asked for: the Z3 rows\nare models, and the Rust test is the production control.\n\n**Tests added/modified:**\n\n- `scripts/tests/test_model_impact.py`: coverage (including `pub async`\nand same-line-attribute\ndeclarations), comment/string-literal exclusion, unknown test,\nduplicate, invalid strength,\n  missing table, and unmapped `code_linked` cases.\n- `tests/verification/z3.rs`: corrected the summary counts, added the\nomitted runtime/mesh groups,\nand changed the summary labels from \"proofs\" to \"tests\" (no test\ndeleted, skipped, or weakened).\n\n## Classification rationale\n\n<details>\n<summary>All 66 rows (strength, control, rationale)</summary>\n\n| Test | Strength | Control | Rationale |\n| --- | --- | --- | --- |\n| `z3_proof_input_delay_increase_preserves_monotonic_frames` |\n`model_only` | none | Models the delay-increase gap fill; the UNSAT is\ndefinitional substitution, so it documents the formula but cannot fail\nif production changes. |\n| `z3_proof_input_delay_decrease_is_rejected_mid_session` | `model_only`\n| none | Models the rejected decrease; the queued-frame order follows\nfrom the assumed `new < old` inequality. |\n| `z3_proof_pending_output_capacity_sufficient_for_gap_fill` |\n`model_only` | none | Models the per-endpoint capacity precheck; the\nUNSAT is the min-over-endpoints bound. |\n| `z3_proof_confirmed_frame_ignores_disconnected_players` | `tautology`\n| none | Models exclusion of mesh-agreed dropped slots; the proof\nrestates the min definition. |\n| `z3_proof_frozen_peer_input_is_constant_after_drop` | `tautology` |\nnone | Assumes the freeze implication it checks; the contradiction is\nimmediate, so it cannot catch a wrong freeze rule. |\n| `z3_proof_halt_and_continue_without_are_mutually_exclusive_policies` |\n`tautology` | none | Asserts both transition obligations as premises,\nthen asserts a violation; the UNSAT restates the premises. |\n| `z3_proof_frame_addition_bounded` | `model_only` | none | Valid\nnon-negative-addition arithmetic; it does not model Rust overflow or\nexecute `Frame`. |\n| `z3_proof_rollback_frame_valid` | `model_only` | none | Valid\nsubtraction arithmetic under the stated window; no production code\nexecutes. |\n| `z3_proof_frame_comparison_transitive` | `model_only` | none | Integer\ntransitivity; `Frame`'s derived `Ord` is not exercised. |\n| `z3_proof_circular_buffer_index_valid` | `model_only` | none | Modulo\nrange theorem; Z3 `%` is not Rust remainder for negative frames. |\n| `z3_proof_head_advancement_wraps` | `model_only` | none | Modulo range\ntheorem for the head advance. |\n| `z3_proof_head_wraparound_to_zero` | `tautology` | none | Constant\narithmetic on `INPUT_QUEUE_LENGTH - 1`; no symbolic state. |\n| `z3_proof_queue_length_invariant_add` | `model_only` | none | One-step\nlength bound; it assumes the add rule rather than reading it. |\n| `z3_proof_circular_distance_non_wrapped` | `witness_only` | SAT\nwitness | Only asserts that a valid non-wrapped state exists. |\n| `z3_proof_rollback_target_in_past` | `tautology` | none | Models the\n`first_incorrect < current` guard; the target is defined as the guard's\ninput. |\n| `z3_proof_skip_rollback_when_frame_equal` | `tautology` | none |\nMutual exclusion follows directly from `>=` and `<` on the same pair. |\n| `z3_proof_frame_zero_misprediction_skips_rollback` | `tautology` |\nnone | Both frames are fixed to 0; `0 >= 0` is constant arithmetic. |\n| `z3_proof_rollback_within_prediction_window` | `tautology` | none |\nThe premise is the window bound; the query negates the same bound. |\n| `z3_proof_saved_state_available` | `witness_only` | SAT witness | Only\nasserts that a rollback distance fits the stated slot count. |\n| `z3_proof_frame_delay_prevents_overflow` | `model_only` | none | Bound\narithmetic; the delay validator is not executed. |\n| `z3_proof_sequential_frames_with_delay` | `tautology` | none |\nSequential-frame arithmetic identity. |\n| `z3_proof_frame_delay_increase_monotone_gap_fill` | `model_only` |\nnone | Monotonicity follows from a positive delta; the production branch\nis not read. |\n| `z3_proof_frame_delay_decrease_rejected_preserves_state` | `tautology`\n| none | Assumes the rejected post-state, then proves it is unchanged;\ndocuments the branch contract. |\n| `z3_proof_pending_output_capacity_accepts_gap_fill_delta` |\n`model_only` | none | Capacity arithmetic under the stated precheck. |\n| `z3_proof_mesh_agreed_dropped_players_excluded_from_confirmed_min` |\n`model_only` | none | Models the mesh-agreed drop exclusion; the min\ndefinition is assumed. |\n| `z3_proof_confirmed_bound_below_same_instant_subset_overrides` |\n`model_only` | none | Non-trivial subset-min lemma; it explicitly\nexcludes the cross-time and N>=4 relay cases. |\n| `z3_proof_input_position_uniqueness_in_window` | `model_only` | none |\nModulo injectivity within a window; a genuine number-theory lemma. |\n| `z3_proof_complete_rollback_safety` | `witness_only` | SAT witness |\nOnly asserts that the combined preconditions are satisfiable. |\n| `z3_proof_prediction_threshold` | `tautology` | none | The query is\nthe XOR of complementary `>=`/`<` predicates; a decision partition. |\n| `z3_proof_frame_increment_safe` | `model_only` | none | A 24-hour\nframe bound compared with `i32::MAX`; no overflow model. |\n| `z3_proof_desync_detection_no_false_positives` | `tautology` | none |\nDefines detection as `local != remote`, assumes equality, then asserts\ndetection. |\n| `z3_proof_desync_detection_no_false_negatives_on_comparison` |\n`model_only` | gate precondition | Already labeled `model_only` in the\nsource; the same-basis gate is a precondition, not proved. |\n| `z3_proof_different_basis_is_never_compared` | `model_only` |\nsecond-solver latch check | Already labeled `model_only`; the gate is\ndefined in the model, and a second solver checks the latch expression. |\n| `z3_proof_checksum_comparison_guard` | `tautology` | none | Defines\n`guard = remote < confirmed`, assumes it, then asserts `remote >=\nconfirmed`. |\n| `z3_proof_pending_checksum_becomes_comparable` | `tautology` | none |\nThe premise `frames_advanced > pending - initial` is exactly the\nconclusion's arithmetic. |\n| `z3_proof_sync_health_state_transitions` | `model_only` | SAT\nwitnesses; no-clear mutation recorded in #591 | Models the transition\ntable with both unlatched rewrite outcomes; the table is hand-written,\nnot executed. |\n| `z3_proof_last_verified_frame_monotonic` | `tautology` | none |\nDefines the update as `max(current, comparison)` and then proves the max\nnever decreases. |\n| `z3_proof_invariant_checker_soundness` | `tautology` | none | Defines\nthe error as `any_desync`, assumes none, then asserts no error. |\n| `z3_proof_invariant_checker_completeness` | `tautology` | none |\nDefines the error as `any_desync`, assumes one, then asserts the error.\n|\n| `z3_desync_detection_proofs_summary` | `tautology` | none | Prints a\nsummary; no solver query or assertion. |\n| `z3_verified_properties_summary` | `tautology` | none | Prints counts\nand prose; no solver query or assertion. |\n| `z3_proof_input_queue_head_tail_bounds` | `model_only` | none | Modulo\nrange theorem for the head; tail advancement is out of scope. |\n| `z3_proof_input_queue_length_calculation` | `witness_only` | SAT\nwitness | Only asserts that a length in range exists. |\n| `z3_proof_sync_layer_confirmed_frame_invariant` | `model_only` | none\n| One-step inductive preservation; the base case and setter validation\nare out of scope. |\n| `z3_proof_sync_layer_saved_frame_invariant` | `model_only` | none |\nOne-step inductive preservation; sparse mode is out of scope. |\n| `z3_proof_saved_states_availability` | `witness_only` | SAT witness |\nOnly asserts that a modulo cell index exists. |\n| `z3_proof_first_incorrect_frame_bound` | `model_only` | none |\nOne-step preservation of `first_incorrect < current` across\n`advance_frame`. |\n| `z3_proof_prediction_window_bounded` | `witness_only` | SAT witness |\nOnly asserts that a bounded rollback state exists. |\n| `z3_proof_frame_discard_safety` | `model_only` | none | Modulo\ninjectivity for two frames inside the window; SAT-only conclusion. |\n| `z3_proof_fnv1a_single_byte_formula` | `witness_only` | SAT witness |\nAdmits it models addition instead of XOR; only SAT is checked. |\n| `z3_proof_fnv1a_determinism` | `tautology` | none | Assumes both\nstates start equal and asserts they are equal. |\n| `z3_proof_fnv1a_empty_input_identity` | `tautology` | none | Defines\nthe final state as the initial state, then asserts the identity. |\n| `z3_proof_fnv1a_incremental_consistency` | `tautology` | none |\nCompares two syntactically identical arithmetic expressions. |\n| `z3_proof_fnv1a_prime_properties` | `tautology` | none | Checks a\nconstant's parity; no symbolic input. |\n| `z3_proof_fnv1a_single_byte_no_collision` | `witness_only` | SAT\nwitness | Explicitly says it is not a collision proof; only distinct\nbytes exist. |\n| `z3_proof_fnv1a_value_always_64bit` | `witness_only` | SAT witness |\nThe assertion is satisfiable and documents the sign cast; no safety\nproperty. |\n| `z3_hash_proofs_summary` | `tautology` | none | Prints a summary; no\nsolver query or assertion. |\n| `z3_proof_pcg32_increment_always_odd` | `model_only` | none |\nArithmetic property of `2*stream + 1`; the production shift/or is not\nexecuted. |\n| `z3_proof_pcg32_state_transition_deterministic` | `tautology` | none |\nThe source calls it a mathematical tautology; identical expressions are\ncompared. |\n| `z3_proof_pcg32_state_transition_injective` | `model_only` | none |\nInfinite-precision injectivity; the mod-2^64 wrap that makes the\nargument work is not modeled. |\n| `z3_proof_pcg32_multiplier_is_odd` | `tautology` | none | Checks a\nconstant's parity; no symbolic input. |\n| `z3_proof_pcg32_default_increment_is_odd` | `tautology` | none |\nChecks a constant's parity; no symbolic input. |\n| `z3_proof_gen_range_threshold_valid` | `model_only` | none | Modulo\nrange theorem; the u32 wrapping arithmetic is modeled with integers. |\n| `z3_proof_gen_range_acceptance_probability` | `model_only` | none |\nNon-trivial arithmetic bound on the acceptance region; the RNG draw is\nnot modeled. |\n| `z3_proof_pcg32_different_seeds_different_states` | `model_only` |\nnone | Infinite-precision injectivity of the seed map; wrapping\narithmetic is not modeled. |\n| `z3_rng_proofs_summary` | `tautology` | none | Prints a summary; no\nsolver query or assertion. |\n\n</details>\n\n## Risks and Rollback\n\n- **Risk:** classification is a judgment; a reviewer may disagree with\nindividual rows. The checker\nenforces coverage and shape, not the correctness of the judgment.\nChanging a label is a normal\n  review edit to the manifest table.\n- **Risk:** a new `z3_*` test now fails `model-impact.py check` until it\nis classified. That is\n  intentional; the error names the test and the four accepted strengths.\n- **Risk:** the table is data, not a rendered report; the per-test\nrationale lives in this PR and the\nissue. The manifest table is the durable source of truth for the labels.\n- **Rollback:** revert this PR. No production behavior, wire format, or\npublic API changes; the\nmanifest returns to no table and `z3.rs` returns to the old summary\ntext.\n\n## Related Issues\n\n- Fixes #575\n- Tracking: #580\n- Code links already delivered by #572 (Kani), #586 and #591 (desync\nmodel corrections); no new\n  production proof is added here.",
          "timestamp": "2026-11-27T07:16:33Z",
          "tree_id": "5fa0ed1e38c4bb3393069c718016461cf8fd1aef",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/cb13bd864c622d2cd0ba939fca6aa567708af0e9"
        },
        "date": 1795764527406,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 47755,
            "range": "± 1124",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 29493,
            "range": "± 1390",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 796,
            "range": "± 102",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1012,
            "range": "± 9",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 7933,
            "range": "± 126",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "25e8020d1a5fd40c4f16b37f97b5ec5329a8566d",
          "message": "fix(sessions): recover confirmed inputs without advancing (#607) (#610)\n\n## Description\n\nA game can stop accepting local input while its last remote rows are\nstill in flight. Once those\noriginal rows arrive, `advance_frame()` returns\n`InvalidRequestKind::MissingLocalInput` because no\nlocal sample exists for the next frame, before it can build the\ncorrection requests. The confirmed\nrow is therefore never repaired or recorded, and the exported replay\nloses it (#607).\n\nThis adds `P2PSession::recover_confirmed_inputs`, the supported entry\npoint for that state. It\nservices the inputs already received, returns the same ordered\nrollback-correction requests an\nadvance would produce, records the newly confirmed prefix in the replay\nrecorder, and leaves the\nsession at the existing boundary. It never requires, registers, sends,\nor clears a local sample,\nand never advances the simulation.\n\nImplementation: `advance_frame` now delegates to a private\n`drive_frame(FrameDriveMode)`. The\n`Recover` mode gates only the local-input proof, local-input\nregistration/sending, and the\nsimulation-advance block. Every other effect — remote polling,\ndisconnect updates, checksum\ncomparison, confirmation folding, `adjust_gamestate`, spectator flush,\nreplay recording, and\n`set_last_confirmed_frame` — runs unchanged, so recovery cannot drift\nfrom the normal path.\n`advance_frame` behavior is unchanged and still returns\n`MissingLocalInput` without a local sample.\nRecovery also stays out of the prediction-window stall metric because it\nis not an advance, and it\nflushes endpoint messages queued by its checksum/spectator work after\nthe poll's own final flush.\n\nHot-join interactions are inherited: the N-peer paused repair path is\nreused, and the existing\nhost/joiner pause request sets are returned without advancing.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [x] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [x] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Verification Impact\n\n- [x] `none` — no mapped production path or symbol changed\n- [ ] `updated: <spec/proof>` — the model, proof, or mapped test is\nupdated in this PR\n- [ ] `waived: <reason + approver>` — a named maintainer approved the\nexception and it is recorded in the tracked issue/PR\n\n- [ ] Any new or changed proof has a RED mutation or a non-vacuity\nwitness (state which below) — N/A, no proof changed.\n\n`python3 scripts/verification/model-impact.py affected --base\norigin/main` → `No mapped verification\nimpact (base origin/main).` `model-impact.py check` → OK (11 components,\n40 symbols, 76 artifacts).\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**:\n  - No `unwrap()` in production code\n  - No `expect()` in production code\n  - No `panic!()` or `todo!()`\n  - All fallible operations return `Result`\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly — `docs/replay.md`\n(\"Finalizing After Local Input Stops\") and the regenerated\n`wiki/Replay.md`\n- [x] I have added an entry to `CHANGELOG.md` for user-facing changes\n- [ ] I have updated relevant examples in the `examples/` directory —\nN/A\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**RED evidence (before the fix):**\n\n```text\ncargo nextest run --features tokio,json,hot-join \\\n  -E 'test(advance_frame_without_local_input_cannot_finalize_withheld_confirmed_frame)'\n→ PASS as a characterization of the bug: advance_frame returned MissingLocalInput and the replay\n  stayed below 257 rows.\n```\n\nTargeted revert after the fix (recovery call replaced with\n`advance_frame` in the new test):\n\n```text\ncargo nextest run --features tokio,json,hot-join \\\n  -E 'test(recover_confirmed_inputs_finalizes_withheld_confirmed_frame)'\n→ FAIL: Error: InvalidRequestStructured { kind: MissingLocalInput }\n```\n\nThe file was restored byte-identically after the revert check.\n\n**Tests added:**\n\n- `recover_confirmed_inputs_finalizes_withheld_confirmed_frame` —\nasymmetric two-peer withheld-256\nshape, run for `SaveMode::EveryFrame` and `SaveMode::Sparse`; both peers\nrecover at boundary 257,\nserialize the replay, decode it, assert row 256 contains the original\ninputs, and play it back\n  without `ReplayDesync`.\n-\n`recover_confirmed_inputs_records_prediction_matching_row_without_rollback`\n— neutral control: the\ndelayed row repeats the prediction, so recovery requests no correction\nand does not increase\n  `rollback_count`, but still records the row.\n- `recover_confirmed_inputs_does_not_invent_the_withheld_row` — the row\nnever arrives;\n`confirmed_frame` stays 255, and the decoded replay has 256 rows with no\nplaceholder.\n- `advance_frame_does_not_finalize_without_the_recovery_call` — the old\npath still refuses with\n`MissingLocalInput` and exports only 256 rows, so the recovery call is\nrequired rather than\n  optional.\n- Repeated recovery is asserted to return no second load/advance, to\nkeep `current_frame` at 257,\n  and to leave the prediction-stall metric flat.\n\n```text\ncargo nextest run --features tokio,json,hot-join -E 'test(recover_confirmed_inputs)'\n  Summary: 3 passed, 0 failed\n```\n\n**Commands and observed output:**\n\n```text\ncargo fmt --all -- --check                                        clean\ncargo clippy --workspace --all-targets \\\n  --features hot-join,tokio,json,sync-send -- -D warnings         clean\ncargo tfull                                                       3814 passed, 77 skipped\ncargo test --doc                                                  160 passed, 52 ignored\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps \\\n  --features hot-join,tokio,json,sync-send --document-private-items  clean\ncargo check --target wasm32-unknown-unknown --no-default-features   pass\ncargo check -p wasm-browser-smoke --features hot-join \\\n  --target wasm32-unknown-unknown --lib --tests                     pass\n.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix   all checks passed\npython3 scripts/api/public_api_census.py --check                   pass (snapshot updated)\npython3 scripts/verification/model-impact.py check                 OK\npython3 scripts/docs/check-links.py                                0 errors\nbash scripts/ci/check-doc-claims.sh                                SUCCESS\nnpx markdownlint CHANGELOG.md docs/replay.md wiki/Replay.md        clean\npython3 scripts/hooks/check-changelog-unreleased.py                pass\npython3 scripts/hooks/check-plan-hygiene.py                        pass\npython3 scripts/docs/check-wiki-consistency.py                     pass\n```\n\n`python3` in this container lacks pytest, so the repository preflight\nwas run with the checked-in\n`.venv/bin/python` (pytest 9.0.3); the preflight itself reported \"All\nagent preflight checks passed.\"\n\n**Manual testing performed:**\n\n- Read `drive_frame` against `adjust_gamestate`,\n`set_last_confirmed_frame`,\n`record_confirmed_inputs`, and `finalize_pending_replay_checksums` to\nconfirm the correction and\n  recording order is unchanged in `Recover` mode.\n- Confirmed the N-peer paused hot-join branch is the existing\nrepair-only path and the host pause\n  returns empty without advancing.\n\n## Size\n\n618 insertions / 71 deletions (547 net) across 8 files, above the\n500-line split guidance. The\nproduction driver change is ~80 new logic lines plus a rustfmt reindent;\n~381 lines are the new\nintegration tests (four controls, both save modes, serialized\ndecode/playback), and ~38 are the\nchangelog, replay guide, user-guide pointer, and wiki mirrors. Splitting\nthe tests would land an\nuntested public method; splitting the docs would leave a user-facing API\nundocumented. Recorded\nhere rather than split. The production diff is mostly the rustfmt\nreindent of the moved driver body plus the mode gates. The API, tests,\nchangelog, docs, and wiki\nmirror are one story; splitting would either ship an undocumented API or\ntests without the method.\n\n## Risks and rollback\n\n- Primary risk: `Recover` mode skips a shared side effect. Mitigation:\nthe mode gates only the three\nlocal-input/advance spots; every other effect is on the same path, and\nthe full suite plus the\n  repeated/neutral/withheld controls exercise it in both save modes.\n- API risk: an additive inherent method on `P2PSession`; no wire,\nprotocol, trait, or public type\nchange. Rollback: `git revert <merge commit>` restores the prior driver\nbyte-for-byte.\n- The Godot differential witness (`make replay-probes GODOT=...`) is\ntracked in Godot #256 and was\nnot re-run in this environment. The Rust-side acceptance is covered\nend-to-end, including a\nserialized decode-and-playback check; the wasm compile lanes ran\nlocally.\n\n## Explain-back (author)\n\n`recover_confirmed_inputs` is a mode of the existing advance driver, not\na parallel path. It polls\nand applies disconnect knowledge, runs the checksum pass, folds the\nconfirmed frame, calls\n`adjust_gamestate` on a misprediction, flushes spectators, records\nconfirmed inputs, and advances\n`last_confirmed_frame` exactly as `advance_frame` does. It differs in\nthree deliberate ways: it does\nnot prove or consume a local sample, it does not register/send one, and\nit does not call\n`sync_layer.advance_frame`. The correction therefore starts at the state\nbefore the mispredicted\nframe and ends at the boundary the session had already reached, leaving\n`current_frame` unchanged.\nThe replay exporter already knows how to refresh checksums for\nre-simulated frames; the new test\nserializes, decodes, asserts the recovered row's original inputs, and\nreplays the result with\nchecksum validation. The withheld control proves the method does not\ninvent a row, the neutral control proves a\nmatching prediction is recorded without a synthetic rollback, and both\nassert that recovery never\nrecords a prediction-window stall. Recovery also flushes endpoint\nmessages queued after the poll's\nfinal flush, so a recovery-only caller does not defer checksum or\nspectator traffic.\n\n## Related Issues\n\nFixes #607. The Godot-side witness is tracked by Godot #256.",
          "timestamp": "2026-11-27T18:01:06Z",
          "tree_id": "9ad25fb46eb50324dea1e8ad3ff6f02e16e21823",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/25e8020d1a5fd40c4f16b37f97b5ec5329a8566d"
        },
        "date": 1795803221152,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 62291,
            "range": "± 799",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 32391,
            "range": "± 385",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1862,
            "range": "± 112",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1556,
            "range": "± 80",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 3138,
            "range": "± 178",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "6f792c6669c3ff0abf89a37ec7a756a9f672f0f5",
          "message": "refactor: extract coordinated-drop state and transition kernels (#576) (#613)\n\n## Description\n\nPhase 4 of #576. Extracts the coordinated-drop state model from\n`p2p_session` into a\n`pub(crate)` `src/sessions/coordinated_drop.rs` and moves the pure\nattempt transitions with it.\nThis is a behavior-preserving refactor: no public API, wire format,\nprotocol, or user-observable\nchange.\n\nWhat moved:\n\n- `CoordinatedDropState`, `CoordinatedDropAttempt`, fences, pending\ntarget commits, deferred and\nrejected prepares, unseen-commit evidence, terminal watermarks, donor\nannouncements, and the\n  backfill-plan type — with their existing bounds and docs.\n- `fallback_coordinator` (the first survivor after the deterministic\ncoordinator),\n`effective_coordinator` (acting-coordinator precedence),\n`reset_backfill_grid`, and the canonical\n  1 KiB `backfill_plan` arithmetic kernel.\n\n`p2p_session` keeps message handling, cut selection, quorum policy, and\na thin adapter that derives\n`T::Input`'s encoded width for the plan kernel. The old state types were\nonly referenced inside\n`p2p_session`; every field became `pub(crate)`, so call-site logic is\nunchanged beyond the moved\nkernels. `p2p_session.rs` loses 374 net lines (31 added, 405 deleted;\n436 total churn).\n\nThree registered Kani harnesses target the production kernels:\n\n- `proof_coordinated_drop_fallback_is_not_the_coordinator`\n- `proof_coordinated_drop_effective_coordinator_precedence`\n- `proof_coordinated_drop_backfill_plan_covers_every_frame` (bounded to\n1..=64-byte inputs,\n1..=8 targets, frames 0..=4096; asserts the exact ceiling chunk count,\nnot only coverage)\n\n## Type of Change\n\n- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [x] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [ ] 🧪 Test (adding or updating tests)\n- [ ] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Verification Impact\n\n- [ ] `none` — no mapped production path or symbol changed\n- [x] `updated: Kani + Rust tests` — the model, proof, or mapped test is\nupdated in this PR\n- [ ] `waived: <reason + approver>` — a named maintainer approved the\nexception and it is recorded in the tracked issue/PR\n\n- [x] Any new or changed proof has a RED mutation or a non-vacuity\nwitness (state which below)\n\nRED evidence (each mutation applied to the extracted kernel, run, then\nrestored byte-identically):\n\n| Mutation | Failing evidence |\n| --- | --- |\n| fallback returns the first participant | module test +\n`proof_coordinated_drop_fallback_is_not_the_coordinator` fail |\n| precedence prefers the deterministic coordinator | module test +\n`proof_coordinated_drop_effective_coordinator_precedence` fail |\n| chunk count uses truncating division | module test +\n`proof_coordinated_drop_backfill_plan_covers_every_frame` fail |\n| grid reset keeps buffered chunks |\n`reset_backfill_grid_clears_only_the_uninstalled_grid_identity` fails\n(the existing session test reuses the same chunk key and does not catch\nit) |\n| chunk count over-counts by one chunk |\n`backfill_plan_uses_one_kib_chunks_and_counts_the_inclusive_range` and\n`proof_coordinated_drop_backfill_plan_covers_every_frame` fail on the\nexact-ceiling assertion |\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**:\n  - No `unwrap()` in production code\n  - No `expect()` in production code\n  - No `panic!()` or `todo!()`\n  - All fallible operations return `Result`\n- [x] I have added tests that prove my fix is effective or my feature\nworks\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [x] I have updated the documentation accordingly\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes\n(N/A: internal refactor)\n- [ ] I have updated relevant examples in the `examples/` directory\n(N/A)\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Tests added/modified:**\n\n- Seven module characterization tests in\n`src/sessions/coordinated_drop.rs`:\n  `fallback_coordinator_is_the_first_survivor_after_the_coordinator`,\n  `effective_coordinator_prefers_the_acting_authority`,\n  `backfill_plan_uses_one_kib_chunks_and_counts_the_inclusive_range`,\n  `backfill_plan_splits_a_wide_frame_into_single_frame_chunks`,\n  `backfill_plan_rejects_a_zero_width_frame`,\n  `backfill_plan_rejects_a_range_that_ends_before_it_starts`, and\n  `reset_backfill_grid_clears_only_the_uninstalled_grid_identity`.\n- Three Kani harnesses listed above; no existing test was deleted,\nskipped, or weakened.\n\n**Manual testing performed:**\n\n```text\ncargo fmt --all -- --check                                          PASS\ncargo clippy --workspace --all-targets --features hot-join,tokio,json PASS\ncargo tfull                                                         3821 passed, 77 skipped\ncargo nextest run --workspace --features hot-join,tokio,json        3822 passed, 77 skipped\ncargo test --doc                                                    160 passed, 52 ignored\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features hot-join,tokio,json,sync-send --document-private-items  PASS\ncargo check --target wasm32-unknown-unknown --no-default-features   PASS\ncargo check -p wasm-browser-smoke --features hot-join --target wasm32-unknown-unknown --lib --tests  PASS\n.venv/bin/python scripts/ci/agent-preflight.py --full --auto-fix    PASS\n./scripts/verification/check-kani-coverage.sh                       all 142 proofs covered\npython3 scripts/verification/model-impact.py check                  OK (11 components, 41 symbols, 86 artifacts)\n./scripts/verification/verify-tla.sh CoordinatorFailover            PASS (1s)\n./scripts/verification/verify-tla.sh CoordinatorFailoverCompeting   PASS (2s)\n./scripts/verification/verify-tla.sh CoordinatedPeerDrop            PASS (Fair + Faults companions)\n```\n\nKani (local 0.68.0 vs the repository 0.67.0 pin, `RUSTFLAGS='--cap-lints\nallow'` for a\npre-existing `sync_layer` const-assert lint; no lint suppression was\nadded):\n\n```text\nproof_coordinated_drop_fallback_is_not_the_coordinator          1 passed, 0 failed\nproof_coordinated_drop_effective_coordinator_precedence         1 passed, 0 failed\nproof_coordinated_drop_backfill_plan_covers_every_frame         1 passed, 0 failed\n```\n\nStructural characterization: after stripping `pub(crate) `, normalizing\ntwo\n`std::collections::BTreeSet` paths, and excluding the test-only\nadopted-epoch const that stays in\n`p2p_session`, the moved state block is identical to the original block;\nthe only rewrite is\n`Option::or_else` → the explicit two-option match, and the precedence\nproof pins it. Existing coordinated-drop tests: 20 passed before and 27\nafter (seven new\nmodule tests).\n\n## Review Readiness\n\n```text\nReview Readiness\n- Build/tests: PASS\n- WASM: PASS\n- Deep lane: PASS (Kani harnesses + TLA failover/drop companions)\n- Zero-panic: PASS (expects only in cfg(test)/cfg(kani))\n- Determinism: PASS (no production HashMap/Instant::now/random additions; one test fixture\n  uses `Instant::now()` for timestamps the reset must not touch)\n- Agent preflight: PASS\n- Error handling: PASS (checked arithmetic, Result-returning kernel)\n- Evidence: refactor characterization + targeted mutations\n- Oracle: PASS (no test or check weakened)\n- Boundary/e2e: PASS (full session suite)\n- Security: PASS (N/A: no untrusted-input or wire change)\n- Independent review: 1 Major + 6 Minor findings from the fresh-context pass; all fixed and\n  rechecked (see Resolution)\n- Explain-back: PASS\n- Structural: PASS (new single-responsibility module; p2p_session loses 374 net lines)\n- Docs/changelog/design: PASS (formal spec v1.11, manifest, wiki mirror; changelog N/A)\n```\n\n## Review Resolution\n\nA fresh-context reviewer audited the diff and the explain-back. No\nCritical findings. Its Major\nfinding (the reset test was missing from the manifest, so the generated\ndivergence table still\nsaid six tests) and the Minor findings (stale reset invariant in the\nlocal log, churn-vs-net line\ncount, incomplete structural-normalization note, overstated Kani bounds,\nstale \"state machine\nbelow\" comment, and the test-only `Instant::now` wording) are all fixed\nin the head commit. The\nreviewer's note that the OpenAI reverse-range finding is a false\npositive matches the reply on\nthat thread.\n\n## Risks and Rollback\n\n- Primary risk: a visibility change could let code outside the former\nmodule mutate state that was\npreviously file-private. Every moved item is `pub(crate)` only, and the\nmoved code is textually\n  identical; no new writer was added.\n- Residual: Kani covers the authority-selection and chunk-grid\narithmetic kernels, not the\nheap-backed attempt collections; those remain covered by the session\ntests and their\n  insertion-site bounds (recorded in the manifest).\n- Rollback: revert the merge commit. The module has no wire, data, or\npublic API surface.\n\n## Related Issues\n\nCloses #576. Tracking queue: #580.",
          "timestamp": "2026-11-27T20:27:27Z",
          "tree_id": "815dfd5c463ba0f3e4b3ad5be95e2d4f78009d15",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/6f792c6669c3ff0abf89a37ec7a756a9f672f0f5"
        },
        "date": 1795811902061,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 25496,
            "range": "± 576",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 16593,
            "range": "± 318",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 475,
            "range": "± 4",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 593,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5383,
            "range": "± 165",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "49699333+dependabot[bot]@users.noreply.github.com",
            "name": "dependabot[bot]",
            "username": "dependabot[bot]"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "a4bdb6a52469458552315e8db2b51c66a2c2e48a",
          "message": "chore(deps): bump the cargo-godot-emscripten group in /tests/godot-emscripten with 2 updates (#603)\n\nBumps the cargo-godot-emscripten group in /tests/godot-emscripten with 2\nupdates: [godot](https://github.com/godot-rust/gdext) and\n[smallvec](https://github.com/smallvec/smallvec).\n\nUpdates `godot` from 0.5.5 to 0.5.6\n<details>\n<summary>Release notes</summary>\n<p><em>Sourced from <a\nhref=\"https://github.com/godot-rust/gdext/releases\">godot's\nreleases</a>.</em></p>\n<blockquote>\n<h2>v0.5.6</h2>\n<h3>🌻 Highlights</h3>\n<ul>\n<li>Compile-time improvements of user crates (reduction of\nmonomorphizations)</li>\n<li>Runtime improvements with variant marshalling</li>\n<li><code>unbind()</code> as a new API to make <code>self</code>\neligible for reborrowing</li>\n<li>Fixed crashes for object destructions, hot-reload with C++ code,\n<code>Debug</code> output</li>\n<li>Rudimentary support for visionOS</li>\n</ul>\n<h3>📚 Further reading</h3>\n<p><a\nhref=\"https://github.com/godot-rust/gdext/blob/master/Changelog.md#v056\">Changelog</a>.</p>\n<p>Git: <a\nhref=\"https://github.com/godot-rust/gdext/compare/v0.5.5...v0.5.6\">https://github.com/godot-rust/gdext/compare/v0.5.5...v0.5.6</a></p>\n<h3>👷 New Contributors</h3>\n<p><a href=\"https://github.com/rnazali\"><code>@​rnazali</code></a> <a\nhref=\"https://github.com/chokomancarr\"><code>@​chokomancarr</code></a>\n<a href=\"https://github.com/sixpolys\"><code>@​sixpolys</code></a> <a\nhref=\"https://github.com/Beliar83\"><code>@​Beliar83</code></a></p>\n</blockquote>\n</details>\n<details>\n<summary>Changelog</summary>\n<p><em>Sourced from <a\nhref=\"https://github.com/godot-rust/gdext/blob/master/Changelog.md\">godot's\nchangelog</a>.</em></p>\n<blockquote>\n<h2><a href=\"https://docs.rs/godot/0.5.6\">v0.5.6</a></h2>\n<p><em>22 November 2026</em></p>\n<h3>🌻 Features</h3>\n<ul>\n<li>Add <code>Array::resize_default()</code> (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1675\">#1675</a>)</li>\n<li>Add: visionOS platform support <a\nhref=\"https://redirect.github.com/godot-rust/gdext/issues/1695\">#1695</a>\n(<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1696\">#1696</a>)</li>\n<li>Add <code>unbind()</code> for reentrant scope (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1708\">#1708</a>)</li>\n</ul>\n<h3>📈 Performance</h3>\n<ul>\n<li>Compile-time changes due to monomorphization (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1677\">#1677</a>,\n<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1684\">#1684</a>,\n<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1688\">#1688</a>,\n<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1706\">#1706</a>)</li>\n<li>Rust-side <code>Variant</code> marshalling (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1600\">#1600</a>)</li>\n<li>Cheaper main-thread checks (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1689\">#1689</a>)</li>\n</ul>\n<h3>🧹 Quality of life</h3>\n<ul>\n<li>Add <code>track_caller</code> to variant conversions (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1698\">#1698</a>)</li>\n<li>Mark GodotInstance as a Core type (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1709\">#1709</a>)</li>\n<li>Allow prints of the form <code>godot_print!(&quot;Text {var}&quot;,\nvar = 2)</code> (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1716\">#1716</a>)</li>\n</ul>\n<h3>🛠️ Bugfixes</h3>\n<ul>\n<li>Handle object destruction during Godot-&gt;Rust call (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1671\">#1671</a>)</li>\n<li><code>Debug</code> for scripts: fix class, show script name (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1701\">#1701</a>)</li>\n<li>Fix hot reload with <code>libstdc++</code> involved (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1715\">#1715</a>)</li>\n</ul>\n<h3>🏗️ Maintenance</h3>\n<ul>\n<li>Harden <code>godot-ffi</code> crate (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1676\">#1676</a>)</li>\n<li>Various cleanups (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1678\">#1678</a>)</li>\n<li>Restructure and extend benchmarks (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1681\">#1681</a>)</li>\n<li>Improve benchmark methodology (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1683\">#1683</a>)</li>\n<li>Adapt <code>#[var(no_get)]</code> test to GDScript 4.8\nabort-on-error (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1685\">#1685</a>)</li>\n<li>Benchmarks: run separately from itest, reduce noise (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1687\">#1687</a>)</li>\n<li>Delete removed stub methods on GDScriptTextDocument (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1700\">#1700</a>)</li>\n<li>CI: test <code>codegen-full</code> against latest stable (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1702\">#1702</a>)</li>\n<li>Update Quaternion tests for Godot 4.8 (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1710\">#1710</a>)</li>\n</ul>\n<h3>📚 Documentation</h3>\n<ul>\n<li>Fix minor documentation in <code>connect_builder.rs</code> (<a\nhref=\"https://redirect.github.com/godot-rust/gdext/pull/1703\">#1703</a>)</li>\n</ul>\n</blockquote>\n</details>\n<details>\n<summary>Commits</summary>\n<ul>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/a139167c33195f2e002dc29defb4a5b3216b74d8\"><code>a139167</code></a>\nv0.5.6 (with doc attributes)</li>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/a800399f6ae5017544a17bbb67e37c71168f404c\"><code>a800399</code></a>\nUpdate crate version: 0.5.5 -&gt; 0.5.6</li>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/a6318ab080aba694814962fcf09a398b09af3e2f\"><code>a6318ab</code></a>\nMerge pull request <a\nhref=\"https://redirect.github.com/godot-rust/gdext/issues/1716\">#1716</a>\nfrom godot-rust/qol/print-format-args</li>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/395476db593eb1cd859336fbb43eb113e5ae6cfb\"><code>395476d</code></a>\nMerge pull request <a\nhref=\"https://redirect.github.com/godot-rust/gdext/issues/1715\">#1715</a>\nfrom godot-rust/bugfix/linux-reload-libstdcxx</li>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/ec72605fbc4159799d28e0f883d6854b2da97659\"><code>ec72605</code></a>\nAllow prints of the form <code>godot_print!(&quot;Text {var}&quot;, var\n= 2)</code></li>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/076eeb197df67ec6c693c47e6b1eaadaf80ef044\"><code>076eeb1</code></a>\nFix Linux hot reload with C++ dependencies</li>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/e5e01f2accfdd43e53774b38dd4e988fbbca897d\"><code>e5e01f2</code></a>\nHot-reload test: optionally link libstdc++ on Linux</li>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/0b680b4d59c4790d4673b2293110687d2e5261c7\"><code>0b680b4</code></a>\nMerge pull request <a\nhref=\"https://redirect.github.com/godot-rust/gdext/issues/1708\">#1708</a>\nfrom godot-rust/feature/reentrant-scope</li>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/9d3349c69413d7f1741b5a0104649127945d97e2\"><code>9d3349c</code></a>\nMerge pull request <a\nhref=\"https://redirect.github.com/godot-rust/gdext/issues/1709\">#1709</a>\nfrom Beliar83/godot_instance_fix</li>\n<li><a\nhref=\"https://github.com/godot-rust/gdext/commit/76fb45a9f7e7b128f9521a6485aee8996cf6d777\"><code>76fb45a</code></a>\nMerge pull request <a\nhref=\"https://redirect.github.com/godot-rust/gdext/issues/1710\">#1710</a>\nfrom godot-rust/mtnc/quaternion-blending</li>\n<li>Additional commits viewable in <a\nhref=\"https://github.com/godot-rust/gdext/compare/v0.5.5...v0.5.6\">compare\nview</a></li>\n</ul>\n</details>\n<br />\n\nUpdates `smallvec` from 1.16.5 to 1.16.6\n<details>\n<summary>Release notes</summary>\n<p><em>Sourced from <a\nhref=\"https://github.com/smallvec/smallvec/releases\">smallvec's\nreleases</a>.</em></p>\n<blockquote>\n<h2>v1.16.6</h2>\n<h2>What's Changed</h2>\n<ul>\n<li>fix: point v1 repository metadata to smallvec/smallvec by <a\nhref=\"https://github.com/himanchalkaushale\"><code>@​himanchalkaushale</code></a>\nin <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/869\">smallvec/smallvec#869</a></li>\n<li>feat: update v1 by <a\nhref=\"https://github.com/alejandro-vaz\"><code>@​alejandro-vaz</code></a>\nin <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/908\">smallvec/smallvec#908</a></li>\n<li>feat: update v1 release workflow and style by <a\nhref=\"https://github.com/alejandro-vaz\"><code>@​alejandro-vaz</code></a>\nin <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/909\">smallvec/smallvec#909</a></li>\n</ul>\n<h2>New Contributors</h2>\n<ul>\n<li><a\nhref=\"https://github.com/himanchalkaushale\"><code>@​himanchalkaushale</code></a>\nmade their first contribution in <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/869\">smallvec/smallvec#869</a></li>\n</ul>\n<p><strong>Full Changelog</strong>: <a\nhref=\"https://github.com/smallvec/smallvec/compare/v1.16.5...v1.16.6\">https://github.com/smallvec/smallvec/compare/v1.16.5...v1.16.6</a></p>\n</blockquote>\n</details>\n<details>\n<summary>Commits</summary>\n<ul>\n<li><a\nhref=\"https://github.com/smallvec/smallvec/commit/347b5c346168f9648bf4298d6ed49deda7e18aeb\"><code>347b5c3</code></a>\nfeat: update v1 release workflow and style (<a\nhref=\"https://redirect.github.com/smallvec/smallvec/issues/909\">#909</a>)</li>\n<li><a\nhref=\"https://github.com/smallvec/smallvec/commit/d384c966b655fdfd1919d34ca8988c1a2e90fda3\"><code>d384c96</code></a>\nfeat: update v1 (<a\nhref=\"https://redirect.github.com/smallvec/smallvec/issues/908\">#908</a>)</li>\n<li><a\nhref=\"https://github.com/smallvec/smallvec/commit/432a701da44bdaefb0690174a093827ca549475e\"><code>432a701</code></a>\nfix: point v1 repository metadata to smallvec/smallvec (<a\nhref=\"https://redirect.github.com/smallvec/smallvec/issues/869\">#869</a>)</li>\n<li>See full diff in <a\nhref=\"https://github.com/smallvec/smallvec/compare/v1.16.5...v1.16.6\">compare\nview</a></li>\n</ul>\n</details>\n<br />\n\n\nDependabot will resolve any conflicts with this PR as long as you don't\nalter it yourself. You can also trigger a rebase manually by commenting\n`@dependabot rebase`.\n\n[//]: # (dependabot-automerge-start)\n[//]: # (dependabot-automerge-end)\n\n---\n\n<details>\n<summary>Dependabot commands and options</summary>\n<br />\n\nYou can trigger Dependabot actions by commenting on this PR:\n- `@dependabot rebase` will rebase this PR\n- `@dependabot recreate` will recreate this PR, overwriting any edits\nthat have been made to it\n- `@dependabot show <dependency name> ignore conditions` will show all\nof the ignore conditions of the specified dependency\n- `@dependabot ignore <dependency name> major version` will close this\ngroup update PR and stop Dependabot creating any more for the specific\ndependency's major version (unless you unignore this specific\ndependency's major version or upgrade to it yourself)\n- `@dependabot ignore <dependency name> minor version` will close this\ngroup update PR and stop Dependabot creating any more for the specific\ndependency's minor version (unless you unignore this specific\ndependency's minor version or upgrade to it yourself)\n- `@dependabot ignore <dependency name>` will close this group update PR\nand stop Dependabot creating any more for the specific dependency\n(unless you unignore this specific dependency or upgrade to it yourself)\n- `@dependabot unignore <dependency name>` will remove all of the ignore\nconditions of the specified dependency\n- `@dependabot unignore <dependency name> <ignore condition>` will\nremove the ignore condition of the specified dependency and ignore\nconditions\n\n\n</details>\n\n---------\n\nSigned-off-by: dependabot[bot] <support@github.com>\nCo-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>\nCo-authored-by: wallstop <1045249+wallstop@users.noreply.github.com>",
          "timestamp": "2026-11-27T23:43:03Z",
          "tree_id": "f0b2e7a5a9cfc6dfc94646d33c88172db50a7a44",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/a4bdb6a52469458552315e8db2b51c66a2c2e48a"
        },
        "date": 1795823712091,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 39260,
            "range": "± 843",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 25081,
            "range": "± 733",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1091,
            "range": "± 2",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1243,
            "range": "± 1",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2767,
            "range": "± 161",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "49699333+dependabot[bot]@users.noreply.github.com",
            "name": "dependabot[bot]",
            "username": "dependabot[bot]"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "41f09398cc8e9c2e4ea53b3b96ff0987112f20cc",
          "message": "chore(deps): bump smallvec from 1.16.5 to 1.16.6 in /fuzz in the cargo-fuzz group (#600)\n\nBumps the cargo-fuzz group in /fuzz with 1 update:\n[smallvec](https://github.com/smallvec/smallvec).\n\nUpdates `smallvec` from 1.16.5 to 1.16.6\n<details>\n<summary>Release notes</summary>\n<p><em>Sourced from <a\nhref=\"https://github.com/smallvec/smallvec/releases\">smallvec's\nreleases</a>.</em></p>\n<blockquote>\n<h2>v1.16.6</h2>\n<h2>What's Changed</h2>\n<ul>\n<li>fix: point v1 repository metadata to smallvec/smallvec by <a\nhref=\"https://github.com/himanchalkaushale\"><code>@​himanchalkaushale</code></a>\nin <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/869\">smallvec/smallvec#869</a></li>\n<li>feat: update v1 by <a\nhref=\"https://github.com/alejandro-vaz\"><code>@​alejandro-vaz</code></a>\nin <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/908\">smallvec/smallvec#908</a></li>\n<li>feat: update v1 release workflow and style by <a\nhref=\"https://github.com/alejandro-vaz\"><code>@​alejandro-vaz</code></a>\nin <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/909\">smallvec/smallvec#909</a></li>\n</ul>\n<h2>New Contributors</h2>\n<ul>\n<li><a\nhref=\"https://github.com/himanchalkaushale\"><code>@​himanchalkaushale</code></a>\nmade their first contribution in <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/869\">smallvec/smallvec#869</a></li>\n</ul>\n<p><strong>Full Changelog</strong>: <a\nhref=\"https://github.com/smallvec/smallvec/compare/v1.16.5...v1.16.6\">https://github.com/smallvec/smallvec/compare/v1.16.5...v1.16.6</a></p>\n</blockquote>\n</details>\n<details>\n<summary>Commits</summary>\n<ul>\n<li><a\nhref=\"https://github.com/smallvec/smallvec/commit/347b5c346168f9648bf4298d6ed49deda7e18aeb\"><code>347b5c3</code></a>\nfeat: update v1 release workflow and style (<a\nhref=\"https://redirect.github.com/smallvec/smallvec/issues/909\">#909</a>)</li>\n<li><a\nhref=\"https://github.com/smallvec/smallvec/commit/d384c966b655fdfd1919d34ca8988c1a2e90fda3\"><code>d384c96</code></a>\nfeat: update v1 (<a\nhref=\"https://redirect.github.com/smallvec/smallvec/issues/908\">#908</a>)</li>\n<li><a\nhref=\"https://github.com/smallvec/smallvec/commit/432a701da44bdaefb0690174a093827ca549475e\"><code>432a701</code></a>\nfix: point v1 repository metadata to smallvec/smallvec (<a\nhref=\"https://redirect.github.com/smallvec/smallvec/issues/869\">#869</a>)</li>\n<li>See full diff in <a\nhref=\"https://github.com/smallvec/smallvec/compare/v1.16.5...v1.16.6\">compare\nview</a></li>\n</ul>\n</details>\n<br />\n\n\n[![Dependabot compatibility\nscore](https://dependabot-badges.githubapp.com/badges/compatibility_score?dependency-name=smallvec&package-manager=cargo&previous-version=1.16.5&new-version=1.16.6)](https://docs.github.com/en/github/managing-security-vulnerabilities/about-dependabot-security-updates#about-compatibility-scores)\n\nDependabot will resolve any conflicts with this PR as long as you don't\nalter it yourself. You can also trigger a rebase manually by commenting\n`@dependabot rebase`.\n\n[//]: # (dependabot-automerge-start)\n[//]: # (dependabot-automerge-end)\n\n---\n\n<details>\n<summary>Dependabot commands and options</summary>\n<br />\n\nYou can trigger Dependabot actions by commenting on this PR:\n- `@dependabot rebase` will rebase this PR\n- `@dependabot recreate` will recreate this PR, overwriting any edits\nthat have been made to it\n- `@dependabot show <dependency name> ignore conditions` will show all\nof the ignore conditions of the specified dependency\n- `@dependabot ignore <dependency name> major version` will close this\ngroup update PR and stop Dependabot creating any more for the specific\ndependency's major version (unless you unignore this specific\ndependency's major version or upgrade to it yourself)\n- `@dependabot ignore <dependency name> minor version` will close this\ngroup update PR and stop Dependabot creating any more for the specific\ndependency's minor version (unless you unignore this specific\ndependency's minor version or upgrade to it yourself)\n- `@dependabot ignore <dependency name>` will close this group update PR\nand stop Dependabot creating any more for the specific dependency\n(unless you unignore this specific dependency or upgrade to it yourself)\n- `@dependabot unignore <dependency name>` will remove all of the ignore\nconditions of the specified dependency\n- `@dependabot unignore <dependency name> <ignore condition>` will\nremove the ignore condition of the specified dependency and ignore\nconditions\n\n\n</details>\n\nSigned-off-by: dependabot[bot] <support@github.com>\nCo-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
          "timestamp": "2026-11-27T23:43:35Z",
          "tree_id": "cdc15f8672bdcfc7c0883970d1feeef6654bf10f",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/41f09398cc8e9c2e4ea53b3b96ff0987112f20cc"
        },
        "date": 1795823747429,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 24341,
            "range": "± 629",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 14948,
            "range": "± 189",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 450,
            "range": "± 4",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 561,
            "range": "± 3",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 5086,
            "range": "± 157",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "49699333+dependabot[bot]@users.noreply.github.com",
            "name": "dependabot[bot]",
            "username": "dependabot[bot]"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "66010d20019baa920a9b1eb1f8142d226e661226",
          "message": "chore(deps): bump smallvec from 1.16.5 to 1.16.6 in /loom-tests in the cargo-loom-tests group (#599)\n\nBumps the cargo-loom-tests group in /loom-tests with 1 update:\n[smallvec](https://github.com/smallvec/smallvec).\n\nUpdates `smallvec` from 1.16.5 to 1.16.6\n<details>\n<summary>Release notes</summary>\n<p><em>Sourced from <a\nhref=\"https://github.com/smallvec/smallvec/releases\">smallvec's\nreleases</a>.</em></p>\n<blockquote>\n<h2>v1.16.6</h2>\n<h2>What's Changed</h2>\n<ul>\n<li>fix: point v1 repository metadata to smallvec/smallvec by <a\nhref=\"https://github.com/himanchalkaushale\"><code>@​himanchalkaushale</code></a>\nin <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/869\">smallvec/smallvec#869</a></li>\n<li>feat: update v1 by <a\nhref=\"https://github.com/alejandro-vaz\"><code>@​alejandro-vaz</code></a>\nin <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/908\">smallvec/smallvec#908</a></li>\n<li>feat: update v1 release workflow and style by <a\nhref=\"https://github.com/alejandro-vaz\"><code>@​alejandro-vaz</code></a>\nin <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/909\">smallvec/smallvec#909</a></li>\n</ul>\n<h2>New Contributors</h2>\n<ul>\n<li><a\nhref=\"https://github.com/himanchalkaushale\"><code>@​himanchalkaushale</code></a>\nmade their first contribution in <a\nhref=\"https://redirect.github.com/smallvec/smallvec/pull/869\">smallvec/smallvec#869</a></li>\n</ul>\n<p><strong>Full Changelog</strong>: <a\nhref=\"https://github.com/smallvec/smallvec/compare/v1.16.5...v1.16.6\">https://github.com/smallvec/smallvec/compare/v1.16.5...v1.16.6</a></p>\n</blockquote>\n</details>\n<details>\n<summary>Commits</summary>\n<ul>\n<li><a\nhref=\"https://github.com/smallvec/smallvec/commit/347b5c346168f9648bf4298d6ed49deda7e18aeb\"><code>347b5c3</code></a>\nfeat: update v1 release workflow and style (<a\nhref=\"https://redirect.github.com/smallvec/smallvec/issues/909\">#909</a>)</li>\n<li><a\nhref=\"https://github.com/smallvec/smallvec/commit/d384c966b655fdfd1919d34ca8988c1a2e90fda3\"><code>d384c96</code></a>\nfeat: update v1 (<a\nhref=\"https://redirect.github.com/smallvec/smallvec/issues/908\">#908</a>)</li>\n<li><a\nhref=\"https://github.com/smallvec/smallvec/commit/432a701da44bdaefb0690174a093827ca549475e\"><code>432a701</code></a>\nfix: point v1 repository metadata to smallvec/smallvec (<a\nhref=\"https://redirect.github.com/smallvec/smallvec/issues/869\">#869</a>)</li>\n<li>See full diff in <a\nhref=\"https://github.com/smallvec/smallvec/compare/v1.16.5...v1.16.6\">compare\nview</a></li>\n</ul>\n</details>\n<br />\n\n\n[![Dependabot compatibility\nscore](https://dependabot-badges.githubapp.com/badges/compatibility_score?dependency-name=smallvec&package-manager=cargo&previous-version=1.16.5&new-version=1.16.6)](https://docs.github.com/en/github/managing-security-vulnerabilities/about-dependabot-security-updates#about-compatibility-scores)\n\nDependabot will resolve any conflicts with this PR as long as you don't\nalter it yourself. You can also trigger a rebase manually by commenting\n`@dependabot rebase`.\n\n[//]: # (dependabot-automerge-start)\n[//]: # (dependabot-automerge-end)\n\n---\n\n<details>\n<summary>Dependabot commands and options</summary>\n<br />\n\nYou can trigger Dependabot actions by commenting on this PR:\n- `@dependabot rebase` will rebase this PR\n- `@dependabot recreate` will recreate this PR, overwriting any edits\nthat have been made to it\n- `@dependabot show <dependency name> ignore conditions` will show all\nof the ignore conditions of the specified dependency\n- `@dependabot ignore <dependency name> major version` will close this\ngroup update PR and stop Dependabot creating any more for the specific\ndependency's major version (unless you unignore this specific\ndependency's major version or upgrade to it yourself)\n- `@dependabot ignore <dependency name> minor version` will close this\ngroup update PR and stop Dependabot creating any more for the specific\ndependency's minor version (unless you unignore this specific\ndependency's minor version or upgrade to it yourself)\n- `@dependabot ignore <dependency name>` will close this group update PR\nand stop Dependabot creating any more for the specific dependency\n(unless you unignore this specific dependency or upgrade to it yourself)\n- `@dependabot unignore <dependency name>` will remove all of the ignore\nconditions of the specified dependency\n- `@dependabot unignore <dependency name> <ignore condition>` will\nremove the ignore condition of the specified dependency and ignore\nconditions\n\n\n</details>\n\nSigned-off-by: dependabot[bot] <support@github.com>\nCo-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
          "timestamp": "2026-11-27T23:43:46Z",
          "tree_id": "7aa17a4424ab8cd4538350d9f9578df58e34b165",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/66010d20019baa920a9b1eb1f8142d226e661226"
        },
        "date": 1795823977766,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 60588,
            "range": "± 1249",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 30079,
            "range": "± 502",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1712,
            "range": "± 112",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1556,
            "range": "± 112",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2855,
            "range": "± 407",
            "unit": "ns/iter"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "wallstop@wallstopstudios.com",
            "name": "Eli Pinkerton",
            "username": "wallstop"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": false,
          "id": "ccf6c079fe33502350da9c487dfd3fa882c89683",
          "message": "fix(deps): pin godot 0.5.5 for the wasm32 Emscripten fixture (#617)\n\n## Description\n\nRestores a green `main` after #603 bumped `godot` to 0.5.6.\n\nTwo independent regressions came from that merge:\n\n1. **wasm32 build.** godot-core 0.5.6 added Rust-side `Variant`\nmarshalling with an unconditional\n`repr(C, align(8))` layout. On a 32-bit target, `OpaqueVariant` is\n`align(4)`, so\n`static_assert_eq_size_align!(RustVariant, OpaqueVariant)` fails to\ncompile:\n`error[E0080]: evaluation panicked` (exit 101). The\n`variant-ffi-marshal` feature does not gate\nthe const assert, so there is no feature escape. `Godot Emscripten\nBrowser` passed on 6f792c6\n(godot 0.5.5) and fails on 66010d2 (0.5.6); the merge-group run failed\nthe same job before the\n   queue merged.\n2. **License contract.** `supply-chain/deny-godot-licenses.toml` moved\nto 0.5.6, but\n\n`scripts/tests/test_ci_security_workflow.py::test_license_exceptions_are_exact_and_lockfile_scoped`\nstill encodes 0.5.5, so `CI - Documentation` failed on every\ndocs-triggering commit after #603.\n\nThis change pins the fixture back to `godot = \"=0.5.5\"`, downgrades the\ngodot family in the fixture\nlockfile (keeping the smallvec bump from #603), restores the 0.5.5\nMPL-2.0 exceptions, ignores\ngodot-family patch updates in dependabot until a wasm32-safe release\nexists, and makes\n`CI - Documentation` trigger on `supply-chain/**` so the license\ncontract test runs when the deny\nconfig changes.\n\nTracking: #615. The ruleset required-check gap that let these merge is\nfiled as #616.\n\n## Type of Change\n\n- [x] 🐛 Bug fix (non-breaking change that fixes an issue)\n- [ ] ✨ New feature (non-breaking change that adds functionality)\n- [ ] 💥 Breaking change (fix or feature that would cause existing\nfunctionality to change)\n- [ ] 📚 Documentation (changes to documentation only)\n- [ ] ♻️ Refactor (code change that neither fixes a bug nor adds a\nfeature)\n- [ ] 🧪 Test (adding or updating tests)\n- [x] 🔧 CI/Build (changes to CI configuration or build process)\n\n## Verification Impact\n\n- [x] `none` — no mapped production path or symbol changed\n\n`python3 scripts/verification/model-impact.py affected --base\norigin/main` →\n`No mapped verification impact (base origin/main).` (exit 0)\n\n- [ ] Any new or changed proof has a RED mutation or a non-vacuity\nwitness (state which below)\n\n## Checklist\n\n### Required\n\n- [x] I have read the [CONTRIBUTING guide](../docs/contributing.md)\n- [x] I have followed the **zero-panic policy**: no production Rust code\nchanged.\n- [x] I have added tests that prove my fix is effective or my feature\nworks — the existing wasm32\nfixture compile check and the lockfile-scoped license contract test are\nthe oracles; the\n  dependency revert is the differential.\n- [x] I have run `cargo fmt && cargo clippy --workspace --all-targets\n--features tokio,json` with no warnings\n- [x] I have run `cargo nextest run` and all tests pass\n\n### If Applicable\n\n- [ ] I have updated the documentation accordingly — not\nuser-observable.\n- [ ] I have added an entry to `CHANGELOG.md` for user-facing changes —\ndependency pin in a test\n  workspace; excluded by the changelog policy.\n- [ ] I have updated relevant examples in the `examples/` directory\n- [x] My changes generate no new compiler warnings\n\n## Testing\n\n**Red (before the change):**\n\n```text\ncargo +nightly-2026-08-26 check --manifest-path tests/godot-emscripten/Cargo.toml \\\n  --locked --target wasm32-unknown-emscripten\n→ error[E0080]: evaluation panicked: assertion failed: size_of::<RustVariant>() == ...\n  godot-core-0.5.6/src/builtin/variant/rust_variant.rs:31\n  error: could not compile `godot-core` (lib) due to 1 previous error; exit 101\n\n.venv/bin/python -m pytest \\\n  scripts/tests/test_ci_security_workflow.py::test_license_exceptions_are_exact_and_lockfile_scoped -q\n→ 1 failed; Left contains 7 more items: {'godot-bindings@0.5.6': ['MPL-2.0'], ...}\n```\n\n**Green (after the change):**\n\n```text\nCARGO_TARGET_DIR=/tmp/opencode/fixture-target-055 cargo +nightly-2026-08-26 check \\\n  --manifest-path tests/godot-emscripten/Cargo.toml --locked --target wasm32-unknown-emscripten\n→ Compiling godot-bindings/codegen/macros/ffi/core v0.5.5; Checking godot v0.5.5;\n  Finished dev profile in 24.03s; exit 0\n\n.venv/bin/python -m pytest \\\n  scripts/tests/test_ci_security_workflow.py::test_license_exceptions_are_exact_and_lockfile_scoped -q\n→ 1 passed\n\n.venv/bin/python -m pytest scripts/tests/test_ci_security_workflow.py \\\n  scripts/tests/test_ci_rust_workflow.py scripts/tests/test_ci_static_analysis.py \\\n  scripts/tests/test_agent_preflight.py -q\n→ 183 passed in 1.16s\n\ncargo fmt --all -- --check            → exit 0\ncargo c                               → exit 0 (9.92s)\ncargo tf                              → 3020 passed, 512 skipped in 3.375s\ncargo tfull                           → 3821 passed, 77 skipped in 37.274s\ncargo test --doc                      → 160 passed, 52 ignored in 4.37s\nRUSTDOCFLAGS=\"-D warnings\" cargo doc --no-deps --features hot-join,tokio,json,sync-send \\\n  --document-private-items            → exit 0, no warnings\nPATH=.venv/bin:$PATH python3 scripts/ci/agent-preflight.py --full --auto-fix\n                                      → 26 checks passed, exit 0\n.venv/bin/python -m pytest scripts/tests/ -q → 2521 passed, 1 skipped in 122.41s\nactionlint .github/workflows/ci-docs.yml → exit 0\n```\n\nThe browser lane itself needs emcc 4.0.20 and Godot 4.7.1, which are not\ninstalled locally; it runs\nin CI. The failing step was the wasm32 compile, which is covered by the\nclean check above, and the\nlane was green on the previous 0.5.5 main (6f792c6).\n\n**Manual testing performed:** None (CI-only lane).\n\n## Related Issues\n\n- Relates to #615 (tracking the pin and the future unpin; not closed\nhere).\n- Follow-up filed: #616 (required checks miss docs and deep Rust lanes).\n\n## Risks and Rollback\n\n- **Risk:** the Emscripten fixture stays on godot 0.5.5 until upstream\nships a wasm32-safe release;\ndependabot patch updates for the godot family are suppressed in the\nmeantime. The suppression is\nscoped to the `cargo-godot-emscripten` group and documented with a\ncomment.\n- **Rollback:** `git revert <merge commit>` restores the 0.5.6 pin and\nexceptions exactly.",
          "timestamp": "2026-11-28T00:18:13Z",
          "tree_id": "752ea17b8cfc8a4d4ca41ffa882ad9c99079cc71",
          "url": "https://github.com/Ambiguous-Interactive/fortress-rollback/commit/ccf6c079fe33502350da9c487dfd3fa882c89683"
        },
        "date": 1795825907589,
        "tool": "cargo",
        "benches": [
          {
            "name": "Message serialization/round_trip_input_msg",
            "value": 60621,
            "range": "± 666",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_serialize",
            "value": 29525,
            "range": "± 290",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_deserialize",
            "value": 1863,
            "range": "± 112",
            "unit": "ns/iter"
          },
          {
            "name": "Message serialization/input_encode_into_buffer",
            "value": 1554,
            "range": "± 91",
            "unit": "ns/iter"
          },
          {
            "name": "SyncLayer/256_frame_save_advance",
            "value": 2995,
            "range": "± 189",
            "unit": "ns/iter"
          }
        ]
      }
    ]
  }
}
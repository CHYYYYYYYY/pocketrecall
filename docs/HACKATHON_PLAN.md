# Runnable spatial recall — 2026-10-24

The approved goal is a runnable browser simulation of glasses: real camera images → recognition → spatial memory → grounded agent retrieval → voice, alignment taps and proximity audio. Hardware streaming and model hosting may remain documented adapters. No benchmark superiority is claimed.

## Architecture and acceptance

- `lib/spatial/alignment.mjs`: estimate a similarity transform from at least three shared capture poses. Check baseline, rotation agreement and translation residual before publishing. Transform positions/depth/poses into the first map; never merge a rejected batch. Test known scale/rotation/translation, disagreement and stationary anchors.
- `lib/run-session.mjs`: select overlapping reconstruction windows; atomically publish map revisions; expose capture-bound RGB-D geometry input and fresh current-pose input. Reject wrong map, units, stale pose and mismatched capture. Existing memory remains searchable when tracking is lost.
- `lib/memory-agent.mjs`: route user language to allowlisted memory search/history, find, departure, confirmation and status tools. Deterministic commands run without model latency; optional Gemini handles natural phrasing. Responses are composed from tool results with evidence references and a persistent tool trace. Models cannot write coordinates or certify possession.
- `server.mjs`, `public/run.js`: connect text and Gemini Live audio/video to the same agent session; show its evidence/trace and localization status. Preserve the existing English visual direction and feedback controls.
- `scripts/judge-demo.mjs`, `public/assets/review/`: reproducible real-camera sample with attributed calibration. A default recorded-result replay needs no keys; an explicit live run repeats recognition with Gemini. Geometry provenance remains visible, and synthetic fixtures remain a separate mode.
- `docs/HACKATHON.md`, `docs/RELATED_WORK.md`: short judge walkthrough, architecture, adapter contracts, actual measured validation, limitations, and primary-source comparisons to EgoRecall, Ego4D VQ3D and streaming memory work.

## Execution

- [x] Write failing alignment and geometry/pose contract tests; implement conservative fusion and localization gates.
- [x] Write failing memory-agent tests for aliases, ambiguity, history, tool references and stale async responses; implement bounded tool orchestration.
- [x] Run real Gemini on attributed real frames and calibrated geometry; retain repeatable artifacts with model/sensor provenance.
- [x] Exercise no-key replay and live recognition through HTTP; verify restart, unseen-item recall, wrong-map/lost-pose behavior and voice output contracts.
- [x] Rebuild preview, run all tests/checks/smoke, inspect the browser and update concise README/handoff.
- [x] Add real LEDGER kitchen playback, progressive reference geometry, four generated speech turns, explicit voice activity boundaries and a bounded retry.

GitHub publication and CI are recorded on the implementation pull request; local verification is documented separately.

The user has authorized implementation and GitHub synchronization. Continue inline without another design approval. External reconstruction latency, hardware pose tracking and research accuracy are separate from passing integration tests.

Realtime voice was explicitly prioritized during implementation: server-only Gemini Live WebSocket, PCM AudioWorklet capture/playback, JPEG streaming, barge-in, and shared memory tools. Validation records are in VALIDATION.md.

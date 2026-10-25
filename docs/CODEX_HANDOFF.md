# PocketRecall — Codex handoff

Updated: 2026-10-25. Implementation snapshot: local commit `32f175dffa1fdc720d6db9bfd5580f7c075ad7aa`; this handoff is a subsequent documentation-only change.

**Continue from the local project. GitHub does not yet contain the current application.** The user has been building this in ChatGPT Work and wants Codex to take over implementation, validation, and repository synchronization. Do not start a replacement project or assume the remote clone is the latest source.

## 1. Product and user priorities

PocketRecall is a hackathon prototype for glasses that remember where everyday objects were last seen. There is no physical glasses device or mobile app. A webpage simulates the glasses and lets judges inspect what the system saw, remembered, and returned.

The intended demonstration:

1. Upload/play a first-person recording as a simulated continuous visual stream.
2. Recognize objects, associate observations with spatial geometry, and persist the 3D map, object history, camera pose, timestamps, and evidence images.
3. Ask “Find my keys” or “I'm heading out.” Retrieve remembered locations and guide a simulated wearer.
4. Use three cues: short spoken directions, a light tap when looking in the correct direction, and a heartbeat/thud that becomes louder as the wearer approaches.
5. Show the storage and evidence behind the answer. In the screen-free flow, the wearer should not need to keep operating the webpage after initial setup.

The user's strongest priority is the **middle layer: durable 3D spatial memory**, alongside a polished demonstration. The interface and spoken replies must be English. The user wants a distinctive, attractive page, not a generic AI dashboard. `README.md` must remain a concise English startup/demo guide.

The user has already requested Git commits and GitHub synchronization. Continue those tasks within the available permissions; do not ask for the same authorization again. Local commit success is not remote upload success.

## 2. Open and run the existing project

Local project directory on the original machine:

```text
/Users/edisonliu/Documents/Codex/2026-10-24/new-chat/pocketrecall
```

Open this directory as the Codex project so its root `AGENTS.md` is discovered. If moving to another machine, transfer the latest local repository first; the remote branch alone is incomplete.

Requires Node.js 22+. This is native JavaScript/ES modules, a Node HTTP server, browser APIs, and a Canvas-based spatial view. There is no framework build or runtime dependency installation step.

```sh
cd /Users/edisonliu/Documents/Codex/2026-10-24/new-chat/pocketrecall
npm start
```

Open `http://localhost:3000/run`. `/` opens the same console. `/desk` preserves the earlier fixed-camera interface; it is not the current presentation surface.

Other commands:

```sh
npm test
npm run check
npm run demo
npm run preview:build
```

`npm run demo` runs a command-line spatial scenario. `npm run preview:build` regenerates `public/pocketrecall-preview.html`, embedding the current frontend and synthetic assets. That standalone HTML uses browser storage; it is not a substitute for the server's durable storage or uploaded-video AI path.

An ignored `.env.local` exists on the original machine with the user's Gemini configuration. Preserve it, do not print it, and do not commit it. A working `FAL_KEY` has not been supplied in this session. Use `.env.example` for configuration names on another machine. A configured key/model is not evidence that a provider request succeeds.

## 3. Current implementation and limits

| Area | Implemented | Still needs real validation or implementation |
| --- | --- | --- |
| Run console | Video upload/playback, spatial view, object evidence cards, storage inspection/export, simulation controls, English UI | Actual browser rendering, interaction, and presentation rehearsal |
| Built-in demo | Synthetic first-person clip, timestamped detections/geometry, movement and occlusion, real storage/query/guidance code | It is not real footage or a live perception result |
| Real video | Server-side Gemini adapter for registered objects; sampled-frame ingestion | A successful request with the user's account/model and representative real footage |
| 3D reconstruction | Optional fal VGGT queue/poll/result adapter; depth and capture poses projected into a stored map | Working fal credential, live request/result compatibility, accuracy and latency |
| Spatial memory | Atomic JSON index, immutable observations, image evidence, poses, map revisions, history/search, restart recovery | Real-input end-to-end demonstration; no multi-user database service |
| Invisible UI | Speech recognition/TTS, departure checklist, spoken confirmation, proximity sound, alignment vibration/visual cue | Browser microphone service, audible behavior, and actual device haptics |
| Dataset replay | Validated annotation importer and HD-EPIC association/mask conversion utility | No actual HD-EPIC or EgoRecall clip is bundled or validated |
| Wearer/navigation | Keyboard-controlled virtual pose and relative target guidance | No physical headset tracking, obstacle avoidance, route planning, or cross-batch map alignment |

## 4. The actual data path

All three input modes converge on `RunSession`, `SpatialPipeline`, and `SpatialStore`:

| Mode | Perception and geometry source | What must remain explicit |
| --- | --- | --- |
| `demo` | Bundled synthetic video and fixture annotations | Both detections and geometry are synthetic |
| `video` | Gemini object observations; optional fal VGGT geometry | RGB-only evidence is unlocalized until real geometry exists; VGGT scale is relative |
| `recording` | Imported dataset annotations, optical camera poses, and optional reference points | Annotation replay is not our model's prediction; reference geometry is precomputed |

For an uploaded video, the browser captures a 518×518 letterboxed JPEG and sends `sessionId`, `seq`, `videoTime`, and `imageDataUrl` to `POST /api/run/frame`. Only one observation request runs at a time, followed by approximately 1.5 seconds of delay. A session accepts at most 180 frames. This is sampled recorded-video ingestion, not a hardware WebRTC/RTSP receiver.

Gemini returns object status, image boxes, and descriptions for registered categories. It does not generate world coordinates. Initial categories are Keys, Wallet, Earbuds, and Phone; registration supports up to 12 categories, with one instance per category. General object re-identification is not implemented.

With fal configured, reconstruction selects 2–8 keyframes and can auto-run every six accepted frames. Depth, intrinsics, and camera extrinsics localize image detections. Each independent batch gets its own map ID. There is no automatic alignment/fusion between batches. Relative-scale maps return `distanceRelative` and `distanceM: null`.

The spatial pipeline saves capture-bound observations and evidence, then publishes the map, poses, and observations together through one atomic memory-index update. Querying an object returns its last confirmed sighting, associated image, time, and map. An unseen object keeps its previous sighting; an unknown location remains unknown.

Typed text or browser speech goes to `POST /api/run/query`. Intent handling is bounded, deterministic matching, not an open-ended agent. Find/departure/confirmation/pause/resume/cancel/next commands are supported. The selected target and the simulated wearer pose determine guidance. The frontend turns that into speech, alignment taps, and proximity audio.

## 5. Where the memory lives

Server sessions persist beneath `.pocketrecall-data/run/<session-id>/`:

| Path | Responsibility |
| --- | --- |
| `session.json` | Session/UI state, frame metadata, reconstruction job, simulated pose, map references |
| `spatial-memory.json` | Entities, immutable observations, poses, user reports, events, map revision index |
| `maps/<sha256>.json` | Immutable point-cloud geometry, content-hash deduplication and read verification |
| `evidence/<sha256>.jpg` | Saved evidence images for Run observations |
| `frames/<id>.json` | Capture metadata linked to evidence and observations |
| `input/<id>.jpg` | Sampled input retained for reconstruction |
| `recording.json` | Original imported annotations; future records stay out of state responses and exports |

An observation links `entityId`, `mapId`, `poseRef`, `capturedAt`, position, units, and image evidence. Geometry revisions remain available. Session state references the durable map rather than duplicating its point cloud.

Preserve these invariants:

- Use the pose captured with the frame, never a later pose from model-completion time.
- Keep capture-time chronology, map identity, units, and synthetic/real provenance consistent.
- Do not infer a hidden object's current position from its last sighting.
- A simulated arrival does not confirm visual reacquisition or possession. “Got it” is a separate user report.
- Missing sparse annotations are unknown, not evidence of absence. Future frames cannot answer an earlier query.
- Do not combine independent coordinate systems or label relative units as meters.
- A failed reconstruction batch must leave the previously published memory intact. Unreferenced immutable files may remain after failure.

Inspect memory through `/api/run/export`, `/api/run/maps`, `/api/run/map/:id`, `/api/run/history/:entityId`, and `POST /api/run/search`. Search supports text, map, position/radius, capture-time cutoff, and result limit. See [SPATIAL_MEMORY.md](SPATIAL_MEMORY.md) for the exact contract and annotation schema.

## 6. File map

| Files | Role |
| --- | --- |
| `server.mjs` | Local HTTP server, Run/legacy routes, configuration, request and origin checks |
| `lib/run-session.mjs` | Session modes, ingestion, reconstruction integration, queries, checklist, simulated guidance |
| `lib/run-vision.mjs`, `lib/reconstruction.mjs` | Gemini recognition and fal VGGT adapters |
| `lib/spatial/pipeline.mjs`, `store.mjs`, `geometry.mjs` | Spatial ingestion, atomic publication, durable memory, projection and guidance math |
| `lib/recording.mjs`, `lib/hd-epic.mjs` | Annotation validation/replay and HD-EPIC conversion |
| `lib/voice-intent.mjs` | English/Chinese intent matching and checklist progression |
| `public/run.html`, `run.css`, `run.js` | Main English console, frame capture, API orchestration, voice state |
| `public/run-map.js`, `run-feedback.js` | Canvas spatial view, Web Audio, speech synthesis, vibration |
| `public/run-offline.js` | Standalone preview mode using browser storage |
| `public/assets/demo-*` | Synthetic video, poster, and detection/geometry fixture |
| `scripts/build-preview.mjs` | Generates the self-contained preview HTML |
| `scripts/convert-hd-epic.mjs` | CLI adapter for selected, calibrated dataset inputs |
| `test/*.test.mjs` | Memory, geometry, orchestration, API, frontend-state, and adapter tests |

The older `lib/memory.mjs`, `lib/vision.mjs`, `public/app.js`, and related desk files remain for `/desk` and shared helpers. Keep the Run pipeline as the main development target.

## 7. Presentation and interface expectations

Keep the current warm grey/paper, charcoal, and restrained orange direction, with footage and spatial memory prominent. Object thumbnails are actual evidence crops. Supporting controls and event details expand when needed. The existing references are Teenage Engineering's field system and Linear's interface refresh; see [RUN_DEMO.md](RUN_DEMO.md).

Suggested rehearsal: play the synthetic clip; keys move at about 8 seconds and are hidden at about 14 seconds; pause and ask “Find my keys”; enable sound; turn/approach with arrows or WASD and tilt with Q/E; inspect the saved evidence; enter “Try it with your eyes up”; say “I'm heading out” and “Got it” to progress through the checklist.

Speech recognition uses `en-US` and pauses during generated speech to avoid self-triggering. Listening ducks the heartbeat rather than removing proximity feedback. Browsers without vibration show the tap visually. These details require a real browser/audio rehearsal, not just unit tests.

## 8. Validation evidence and outstanding gaps

Last recorded validation during implementation, before this documentation-only handoff:

- 78 automated tests passed.
- 36 JavaScript modules passed syntax checks.
- 11 command-line spatial scenario checks passed.
- The generated preview's inline scripts, DOM bindings, and absence of required external JS/CSS were checked. A source/preview secret-pattern scan passed.

These results do not establish live provider accuracy, latency, browser rendering, microphone behavior, speaker output, or device vibration. Provider tests use mocks. The prior runtime could not bind localhost (`EPERM`) and could not resolve external hosts (`ENOTFOUND` / Git “Could not resolve host”). Treat those as recorded limitations of that environment; test the capabilities of the new Codex environment rather than assuming the same restriction persists.

No actual HD-EPIC/EgoRecall data has been downloaded or exercised here. The HD-EPIC converter was tested with schema fixtures. A real clip still needs corresponding annotations and verified optical camera calibration. [HACKATHON_DATA.md](HACKATHON_DATA.md) explains the intended use and remaining work. Do not make additional dataset/license/performance claims without checking their current primary sources.

## 9. Git state and the synchronization blocker

| Item | Last verified state on 2026-10-25 |
| --- | --- |
| Repository | `https://github.com/CHYYYYYYYY/pocketrecall` |
| Working branch | `codex/spatial-memory-pipeline` |
| Local implementation snapshot | `32f175dffa1fdc720d6db9bfd5580f7c075ad7aa` |
| Remote branch head, checked while preparing this handoff | `6709b386424225d45d85d6c5209e35becbd5df05` |
| Before adding the handoff | Clean local worktree; latest application and README committed locally |

Important local commits, newest first:

- `32f175d`: concise English README.
- `2fc5597`: English Run interface and editorial visual redesign.
- `6475b1b`: durable versioned 3D memory and invisible voice guidance.
- `febe699`: distinguish recorded reacquisition from simulated arrival.
- `c3c1484`: first-person video console and simulated guidance.
- `6f14809`: spatial perception/evidence/pose pipeline baseline.

Earlier remote code was uploaded through a separate workflow, so local and remote histories differ. The remote branch is missing the subsequent Run application work. Fetch and inspect both histories before merging/reconciling. Do not force-push, assume a plain push will succeed, or overwrite local work from the older remote checkout.

The previous synchronization attempts failed through both available channels:

- Local Git: HTTPS access failed with `Could not resolve host: github.com`.
- Connected GitHub tool: both Git blob creation and README Contents API update returned `403 Resource not accessible by integration`.

The repository metadata reported `push: true` for the connected account. The connector's write failure is distinct from the user's repository collaborator rights. Changing generic tool-confirmation preferences does not grant GitHub OAuth/App write scopes. No successful remote upload of the current application was verified.

On this Mac, plain `git` invoked an Xcode license prompt. The working executable was:

```sh
/Library/Developer/CommandLineTools/usr/bin/git
```

Use the available Git/authentication flow in Codex, inspect the current remote state, preserve remote history, commit any new work, push the intended branch, and verify the remote commit and files. Report actual errors if access remains blocked. Never publish `.env.local`, local memory/evidence, or credentials. Do not paste keys into the handoff or ask for the existing Gemini key again on the same machine.

## 10. Next tasks and completion criteria

1. **Establish the working baseline and Git access.** Read `AGENTS.md`, this file, and `git status`. Confirm the latest local code exists. Restore a normal authenticated GitHub sync if the environment supports it; preserve both histories and verify the upload. Git access is already requested by the user. If it remains externally blocked, continue the local product checks and report the exact blocker.
2. **Run and inspect `/run` in a real browser.** Exercise playback, upload, spatial view, object/evidence inspection, storage export, keyboard controls, voice permission flow, spoken replies, heartbeat, pause/resume, and departure confirmations. Fix concrete failures without replacing the working architecture or visual direction.
3. **Demonstrate durable memory across restart.** Observe an object moving and disappearing, retrieve its last sighting and older history, export the record, restart the server, and confirm matching map revisions, evidence, and observations are still available. Keep simulated pose/arrival separate from visual proof.
4. **Verify the real video/provider path.** Make a real Gemini call using server-only configuration; verify the chosen model is available. For real 3D, use an authorized working fal credential or the dataset replay path. A missing reconstruction credential must not silently turn real video into synthetic geometry. Record actual provider failures and measured timings.
5. **Integrate one real recording for the pitch.** Prefer a small, calibrated HD-EPIC segment if its video/annotations are accessible, or use another suitable real clip with the provider path. Preserve source identifiers, calibration, units, evidence timestamps, and replay labels. Do not download an entire dataset to obtain one demo.
6. **Finish the demo delivery.** Run checks appropriate to code changes, rebuild the standalone preview after relevant frontend changes, rehearse the 90-second flow, keep the README short, and verify the final GitHub branch contains the deliverable.

The result should let a presenter show video → persisted spatial/object memory → a spoken retrieval request → voice/tap/heartbeat guidance, with inspectable evidence and an honest distinction between real inputs, imported annotations, and simulation. A live headset, continuous SLAM, and a production mobile app are outside the current implemented scope.

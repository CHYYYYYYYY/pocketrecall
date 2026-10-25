# PocketRecall Run console

Run `npm start`, open `http://localhost:3000/run`. Install dependencies once with `npm ci` (Node 22+). The primary real-video / live-voice walkthrough is [HACKATHON.md](HACKATHON.md). Root `/` opens the same console; `/desk` preserves the original UI.

## 90-second presentation

1. Start the built-in video. The page labels the RGB video, detections and geometry as synthetic. Four objects gain image evidence and coordinates.
2. At 8 seconds the keys move. At 14 seconds a book hides them. Pause while hidden and ask “Find my keys”. The last confirmed location remains available without claiming the hidden object is still there.
3. Enable sound. Turn using ←/→, tilt using Look up / Look down, and approach using ↑. Alignment drives the haptic cue; approach increases the heartbeat gain and frequency. The virtual wearer is explicitly simulated.
4. Click an object to inspect its evidence and saved record. Open storage and export the full JSON. Ask “I’m heading out” for the last-seen checklist, which does not assert items are being carried.
5. Enter **Try it with your eyes up**. After the initial browser audio/microphone permission, say “Find my keys”, “I’m heading out”, “Got it”, “Pause” or “Continue”. A spoken confirmation is saved as a user report; the departure flow advances to the next item. Listening ducks the heartbeat instead of stopping it. Speech recognition pauses during generated speech to avoid hearing its own answer.

## Real video path

Set `GEMINI_API_KEY` in ignored `.env.local`. The Run vision adapter supports four initial object categories plus up to eight user-added labels. It requires one instance per registered category and does not solve general re-identification.

Video is decoded locally in the browser. A single request is allowed at a time, with a 1.5-second delay after completion; this is sampled-frame ingestion, not a hardware WebRTC/RTSP receiver. Each frame is padded to 518×518 for consistent detector boxes, VGGT intrinsics and depth sampling. Backwards seeking does not rewrite memory; “Start over” creates a new session. The session is capped at 180 accepted frames.

An optional publicly hosted indoor camera clip is linked from [facebook/vggt](https://huggingface.co/spaces/facebook/vggt/tree/main/examples/videos). It needs browser network/CORS access. Loading failures are visible; the app does not substitute synthetic detections for it.

### Reconstruction

Set `FAL_KEY` for the documented [fal VGGT-1B API](https://fal.ai/models/fal-ai/vggt-1b/api). Submission, queue status, prediction JSON, camera matrices and depth decoding are implemented without a client SDK. The server holds credentials. Downloaded prediction artifacts are restricted to fal-owned HTTPS media hosts, with redirects disabled and bounded sizes.

Two to eight frames are selected across the current recording. Auto-update runs every six accepted frames when enabled; it remains off operationally if no fal credential exists. A result must match the submitted frames exactly. Boxes are associated with depth samples; inverse camera extrinsics project those samples into a common reconstruction map. Sparse points and poses are saved with object observations. Every batch gets a distinct map ID because independently reconstructed coordinates are not necessarily aligned. Old-map targets require relocalization instead of giving spurious directions.

Monocular VGGT results are **relative scale**. Public responses expose `distanceRelative` and `distanceM: null` until there is a real metric calibration. The preview uses known synthetic meters and labels them as simulated. This is incremental batch reconstruction, not validated real-time SLAM.

## Persistence and API

The Node backend stores sessions under `.pocketrecall-data/run/<session-id>/`:

| File | Contents |
| --- | --- |
| `session.json` | Input frame metadata, map reference, job state, UI target and virtual pose |
| `spatial-memory.json` | Registered objects, immutable observations, capture poses, events, user reports and map revision index |
| `maps/<sha256>.json` | Immutable XYZ/color geometry, deduplicated by content hash and verified on read |
| `evidence/<sha256>.jpg` | Deduplicated evidence images |
| `frames/<id>.json` | Capture metadata bound to evidence hash |
| `input/<id>.jpg` | Original sampled input for reconstruction |
| `recording.json` | Imported dataset source package; future annotations are excluded from state/export |

| API | Purpose |
| --- | --- |
| `GET /api/run/config` | Provider names and configured booleans, no keys |
| `POST /api/run/session` | New `demo`, `video` or repeated `recording` session |
| `POST /api/run/recording` | Validate and import annotations matched to the loaded video |
| `POST /api/run/frame` | `sessionId`, `seq`, `videoTime`, `imageDataUrl` |
| `POST /api/run/query` | Text query / departure checklist |
| `POST /api/run/register` | Register an additional object label |
| `POST /api/run/reconstruct` | Start a keyframe reconstruction |
| `GET /api/run/reconstruction` | Poll and integrate the reconstruction |
| `POST /api/run/move` | Move a **simulated** wearer |
| `GET /api/run/state` | Current objects, evidence, map and guidance |
| `GET /api/run/export` | Full JSON for inspection/export |
| `GET /api/run/maps` | Durable map index with versions, units and provenance |
| `GET /api/run/map/:id` | Verified geometry, poses and observations; optional `?revision=HASH` |
| `GET /api/run/history/:entityId` | Immutable observations in capture order |
| `POST /api/run/search` | `sessionId`, optional `text`, `mapId`, `near:[x,y,z]`, `radius`, `at`, `limit` |

Session switches abort pending perception; stale results cannot write to the new session. Invalid/failed provider responses preserve earlier evidence. The local server rejects non-localhost Host headers and cross-origin mutations.

Map geometry, pose records and object observations are published together through one atomic memory-index commit for each reconstruction batch. Old geometry revisions remain readable. A new process restores maps and object history without relying on browser state. Spatial searches require an explicit map for distance calculations, and apply the requested capture-time cutoff before selecting the last sighting. Units and synthetic/real provenance cannot be mixed in one map.

See [the 3D memory contract](SPATIAL_MEMORY.md) for the exact storage and dataset replay format.

## Offline artifact

`npm run preview:build` embeds the current HTML/CSS/JS, synthetic video, manifest and shared spatial geometry into `public/pocketrecall-preview.html`. Open the file directly. This standalone presentation uses browser localStorage for the synthetic demo or an explicitly imported dataset annotation package. It does not contain credentials, call Gemini, or reconstruct uploaded real video. Browser storage limits and file-origin policies can affect persistence; the server-backed app is the durable project implementation.

Regenerate synthetic assets with `python3 scripts/generate-run-fixture.py` using Python's standard library and ffmpeg. No third-party Python package is required. The generated clip is intentionally a rendered test scene, not a real-world recording.

## Validation status

See [VALIDATION.md](VALIDATION.md) for current results. Tests distinguish fixtures, provider mocks, recorded model predictions and live API calls. The local server and browser work in the current environment. Physical microphone/speaker and glasses behavior still need hardware rehearsal.

## Current extensions

`GET /api/run/sessions` and `POST /api/run/session/open` reopen durable archives. `POST /api/run/review` starts the real TUM sample; `/review/frame` ingests exact bundled captures. `/geometry` attaches capture-bound sensor/model geometry, `/pose` accepts fresh current localization, `/agent` runs bounded memory tools, and WebSocket `/live?sessionId=…` streams duplex voice/video. See the [contracts](HACKATHON.md#adapter-contracts).

## Interface direction

The Run experience is English by default, including spoken replies and browser speech recognition (`en-US`). Chinese aliases remain accepted by the command layer. Existing default object names are migrated without changing user-defined names or observations.

The layout uses warm paper surfaces, charcoal media stages, a restrained orange accent and larger editorial type. Object thumbnails come from their actual saved evidence crops. Memory events and simulation controls expand when needed. The source and geometry provenance remain visible.

Design references: [Teenage Engineering field system](https://teenage.engineering/products/field-system) for the physical instrument character, and [Linear’s interface refresh](https://linear.app/now/behind-the-latest-design-refresh) for content hierarchy and quieter supporting controls. No third-party assets or UI code were copied.

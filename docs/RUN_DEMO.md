# PocketRecall Run console

Run `npm start`, open `http://localhost:3000/run`. No package installation is needed with Node 22+. Root `/` opens the same console; `/desk` preserves the original UI.

## 90-second presentation

1. Start the built-in video. The page labels the RGB video, detections and geometry as synthetic. Four objects gain image evidence and coordinates.
2. At 8 seconds the keys move. At 14 seconds a book hides them. Pause while hidden and ask “帮我找钥匙”. The last confirmed location remains available without claiming the hidden object is still there.
3. Enable sound. Turn using ←/→, tilt using 抬头/低头, and approach using ↑. Alignment drives the haptic cue; approach increases the heartbeat gain and frequency. The virtual wearer is explicitly simulated.
4. Click an object to inspect its evidence and saved record. Open storage and export the full JSON. Ask “我要出发了” for the last-seen checklist, which does not assert items are being carried.

## Real video path

Set `GEMINI_API_KEY` in ignored `.env.local`. The Run vision adapter supports four initial object categories plus up to eight user-added labels. It requires one instance per registered category and does not solve general re-identification.

Video is decoded locally in the browser. A single request is allowed at a time, with a 1.5-second delay after completion; this is sampled-frame ingestion, not a hardware WebRTC/RTSP receiver. Each frame is padded to 518×518 for consistent detector boxes, VGGT intrinsics and depth sampling. Backwards seeking does not rewrite memory; “重新分析” creates a new session. The session is capped at 180 accepted frames.

An optional publicly hosted indoor camera clip is linked from [facebook/vggt](https://huggingface.co/spaces/facebook/vggt/tree/main/examples/videos). It needs browser network/CORS access. Loading failures are visible; the app does not substitute synthetic detections for it.

### Reconstruction

Set `FAL_KEY` for the documented [fal VGGT-1B API](https://fal.ai/models/fal-ai/vggt-1b/api). Submission, queue status, prediction JSON, camera matrices and depth decoding are implemented without a client SDK. The server holds credentials. Downloaded prediction artifacts are restricted to fal-owned HTTPS media hosts, with redirects disabled and bounded sizes.

Two to eight frames are selected across the current recording. Auto-update runs every six accepted frames when enabled; it remains off operationally if no fal credential exists. A result must match the submitted frames exactly. Boxes are associated with depth samples; inverse camera extrinsics project those samples into a common reconstruction map. Sparse points and poses are saved with object observations. Every batch gets a distinct map ID because independently reconstructed coordinates are not necessarily aligned. Old-map targets require relocalization instead of giving spurious directions.

Monocular VGGT results are **relative scale**. Public responses expose `distanceRelative` and `distanceM: null` until there is a real metric calibration. The preview uses known synthetic meters and labels them as simulated. This is incremental batch reconstruction, not validated real-time SLAM.

## Persistence and API

The Node backend stores sessions under `.pocketrecall-data/run/<session-id>/`:

| File | Contents |
| --- | --- |
| `session.json` | Input frames, map points, job state, UI target and virtual pose |
| `spatial-memory.json` | Registered objects, immutable observations, capture poses, events |
| `evidence/<sha256>.jpg` | Deduplicated evidence images |
| `frames/<id>.json` | Capture metadata bound to evidence hash |
| `input/<id>.jpg` | Original sampled input for reconstruction |

| API | Purpose |
| --- | --- |
| `GET /api/run/config` | Provider names and configured booleans, no keys |
| `POST /api/run/session` | New `demo` or `video` session |
| `POST /api/run/frame` | `sessionId`, `seq`, `videoTime`, `imageDataUrl` |
| `POST /api/run/query` | Text query / departure checklist |
| `POST /api/run/register` | Register an additional object label |
| `POST /api/run/reconstruct` | Start a keyframe reconstruction |
| `GET /api/run/reconstruction` | Poll and integrate the reconstruction |
| `POST /api/run/move` | Move a **simulated** wearer |
| `GET /api/run/state` | Current objects, evidence, map and guidance |
| `GET /api/run/export` | Full JSON for inspection/export |

Session switches abort pending perception; stale results cannot write to the new session. Invalid/failed provider responses preserve earlier evidence. The local server rejects non-localhost Host headers and cross-origin mutations.

## Offline artifact

`npm run preview:build` embeds the current HTML/CSS/JS, synthetic video, manifest and shared spatial geometry into `public/pocketrecall-preview.html`. Open the file directly. This standalone presentation uses browser localStorage and only synthetic detections. It does not contain credentials, call Gemini, or reconstruct uploaded real video. Browser storage limits and file-origin policies can affect persistence; the server-backed app is the durable project implementation.

Regenerate synthetic assets with `python3 scripts/generate-run-fixture.py` using Python's standard library and ffmpeg. No third-party Python package is required. The generated clip is intentionally a rendered test scene, not a real-world recording.

## Validation status

Automated tests cover occlusion, movement, evidence persistence, source separation, stale-response cancellation, relative-scale geometry, feedback monotonicity, backend API contracts and frontend orchestration. Provider calls are mocked in these tests. Real browser rendering, microphone permission, physical vibration, audible speaker output and live provider latency remain unverified in the task environment. It blocks listening on localhost (`EPERM`) and outbound DNS (`ENOTFOUND`).

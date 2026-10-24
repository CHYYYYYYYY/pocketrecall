# Spatial memory pipeline

This is the v2 technical prototype: explicit registration and passive observations feed one evidence-backed entity history; measured spatial inputs place observations in a map; a current camera pose produces directions toward the last-seen area. A later visual observation can confirm reacquisition.

The existing browser desk demo remains a separate v1 experience. Its fixed-view homography and isometric illustration are not the v2 metric tracking pipeline.

## Run and verify

Requires Node.js 22 or newer; no third-party runtime dependencies.

```sh
node scripts/spatial-demo.mjs
node --test test/spatial-*.test.mjs
```

The demo uses deliberately synthetic evidence, detections, and camera poses. It validates data flow and coordinate calculations, not real-world perception accuracy, SLAM, or measured localization error. It runs directly in Node without opening a server port, using a camera, or requiring an API key.

Each run creates a new directory under `.pocketrecall-data/spatial-demo/`. Use `--out NEW_DIRECTORY` to choose another destination. Outputs are `manifest.json`, `trace.json`, `snapshot.json`, `report.json`, synthetic source frames, and persistent memory/evidence. The report has 11 assertions covering passive updates, occlusion, viewpoint changes, tracking/map failures, reacquisition, unknown objects, separate user reports, evidence, capture metadata, stale poses, and restart behavior.

Replay a prepared manifest into a new output directory:

```sh
node scripts/replay.mjs --manifest PATH_TO_MANIFEST.json --out NEW_DIRECTORY
```

The manifest has `entities` and ordered `events` arrays. Events are `{type:"frame", frame}`, `{type:"pose", pose}`, `{type:"query", entityId}`, or `{type:"user_report", report}`. Relative frame paths resolve from the manifest's directory. Queries use the latest event's virtual time; query events can override it with `at`.

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `lib/spatial/geometry.mjs` | Validate rigid poses; unproject optical depth; intersect rays with support planes; calculate camera-relative guidance |
| `lib/spatial/store.mjs` | Stable entity IDs, immutable observations, evidence hashes, capture-time history, user reports, atomic JSON persistence |
| `lib/spatial/pipeline.mjs` | Ingest frame/detection inputs, preserve evidence, choose localization method, coordinate recall and current pose |
| `lib/spatial/perception.mjs` | Optional real-image Gemini adapter; binds supported categories to registered entities without inventing geometry |
| `scripts/spatial-demo.mjs` | Generate/replay a controlled scenario and assert its expected outcomes |
| `scripts/replay.mjs` | Replay a recorded manifest through the same pipeline |
| `fixtures/spatial-demo/` | Explicitly synthetic scenario inputs and supporting evidence |
| `test/spatial-*.test.mjs` | Geometry, storage, and end-to-end pipeline regressions |

Capture, gesture recognition, cloud vision, and device tracking are adapters. They must produce the input contract below; the memory store does not infer missing sensor measurements. The existing `lib/vision.mjs` Gemini adapter can provide 2D detections, but it does not supply metric depth or camera pose.

The replay simulates user intent through explicit entity registration and active/passive frame provenance. It does not yet implement gesture recognition, streaming voice, or a task-aware background capture scheduler.

## Input contract

Entities represent individual belongings, not just categories. Register an ID such as `blue-keyring`, a human label, aliases, appearance, and priority (`explicit` or `background`). The current replay expects detections to identify registered entity IDs. General instance re-identification across arbitrary objects remains adapter work.

A frame contains:

```text
id, capturedAt, source: active | passive, synthetic, imagePath
pose?: {id, mapId, capturedAt, worldFromCamera[16], trackingState}
intrinsics?: {fx, fy, cx, cy, width, height}
detections[]:
  entityId, status: seen | not_seen, bbox?, depthM?, supportPlane?,
  uncertaintyM?, semantics?
```

`bbox` is normalized `[x0, y0, x1, y1]`, with positive extent. `not_seen` cannot invent a box or a new position. A support plane is `{normal:[nx,ny,nz], offset}`, expressed in world coordinates with equation `normal · position + offset = 0`.

Coordinate conventions are explicit:

- World positions are right-handed, in meters, with Y upward.
- Optical camera coordinates use X right, Y down, and Z forward.
- `worldFromCamera` is a **row-major** rigid 4×4 matrix: `[r00,r01,r02,tx, r10,r11,r12,ty, r20,r21,r22,tz, 0,0,0,1]`.
- `depthM` is optical-axis Z depth, not radial distance from the camera.
- Intrinsics and bounding boxes must correspond to the same image dimensions and orientation. Resizing, rotation, or cropping requires consistent calibration updates.
- Frame localization uses the frame's capture-time pose. Its timestamp must represent exactly the same instant as the frame, regardless of when a cloud response arrives. Guidance instead uses the current pose.

A pose must contain a valid rotation, translation, map ID, timezone-bearing timestamp, and `trackingState` (`tracking` or `lost`). Adapters must convert their native matrix layout and camera-axis convention before submitting it. Do not copy an AR SDK matrix blindly.

## Memory semantics

The store is a single-process JSON prototype, committed by atomic rename. It is not a concurrent database or production storage service. SQLite can replace this implementation behind the same interface later.

- Explicit registration raises the entity's priority; a later reliable passive observation still updates its last-seen position.
- Observations remain separate records. Capture time determines chronology; a delayed API response cannot regress the current view.
- `lastSeen` and `latestCheck` differ: a later `not_seen` check preserves earlier evidence without claiming the object remains there.
- Every visual observation references a non-empty evidence file within the store directory. The store records its SHA-256 hash and synthetic flag.
- `memory/frames/<frameId>.json` preserves image hash, intrinsics, capture pose, original detection/geometry inputs, and observation IDs. Image hashes bind model results to the analyzed bytes; a frame's observation batch is committed atomically.
- Position, method (`depth`, `plane`, or `unlocalized`), map ID, uncertainty, and capture-pose reference accompany the evidence. Unknown uncertainty stays unknown.
- User statements live in `userReports`; they do not become visually confirmed locations.
- Position-change events cite their supporting observation IDs. They represent changes between samples, not a continuously observed trajectory.

## Guidance and completion

Recall retrieves an entity's last confirmed observation and latest check. Valid localization and a current pose in the same map produce approximate distance, bearing, elevation, and camera-relative wording. These instructions describe the camera's orientation, not an independently measured human body or head pose.

Missing localization, lost tracking, a stale pose, or a different map produces an unavailable/relocalize response instead of a precise-looking arrow. `recall()` defaults to wall-clock evaluation and a 3-second pose freshness limit; replay passes its virtual clock. `confirmedNow` requires a matching fresh pose, a latest check that actually saw the object, and a sighting within 2 seconds of evaluation. A historical coordinate is a search area, not proof that the object is still there.

This prototype does not implement obstacle avoidance, traversable-space mapping, room-to-room route planning, or cross-session relocalization. Those must be supplied by a tracking/navigation layer before claiming whole-room navigation.

## Recorded video and device adapters

A real recording can use the same replay path after preparation:

1. Extract timestamped JPEG/PNG frames from the recording.
2. Attach detections and registered instance IDs from an appropriate vision adapter or annotation pass; preserve their provenance.
3. If available, attach synchronized intrinsics, metric depth/support planes, and camera poses exported by a device tracking SDK.
4. Replay the prepared events and inspect evidence, history, and guidance outputs.

To request Gemini detections for frames that omit `detections`, add `--vision gemini` to the replay command. Configure `GEMINI_API_KEY` in `.env.local` and supply manifest bindings such as `{"keys":"blue-keyring","wallet":"dark-wallet"}`. Supported categories are `keys`, `wallet`, and `earbuds`, with one registered instance per category. Existing detection arrays cause no API call. Optional `frame.objectGeometry[entityId]` supplies trusted `depthM`, `supportPlane`, and `uncertaintyM`; the model never supplies these measurements. Real inputs must be JPEG/PNG. API-processed frames also produce `perception.json`; ambiguous detections preserve existing memory rather than inventing a location.

Ordinary RGB video alone is insufficient input for this implementation's metric map. Without calibrated spatial measurements, keep the visual memory unlocalized. Do not substitute invented depth, identity transforms, or a generated attractive mesh and call the result measured reconstruction.

The next hardware integration should provide one aligned RGB/depth/pose source and a stable map ID. A coarse measured plane or mesh is sufficient; detailed object meshes are optional presentation assets. Real video, hardware tracking, streaming voice, gesture UX, and Gemini inference must be tested separately from the synthetic replay.

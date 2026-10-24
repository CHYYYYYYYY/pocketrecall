# PocketRecall

**A little less lost.** Short-term spatial memory for your desk: ask where an item was last seen and hear an answer backed by a timestamped image.

Built for c0mpiled-16 UCSD / No App. Daily queries are voice-driven after a one-time setup. The visual workspace is an optional evidence and demonstration surface.

## Run console v3 — video → memory → guidance

`npm start` now opens the new product console at **http://localhost:3000/run** (also `/`). The previous desk demo is retained at `/desk`.

- Upload a browser-playable MP4/MOV/WebM. It stays in the browser; square-letterboxed JPEG keyframes are sent to the local server, recognized by Gemini and stored with their original video timestamps.
- Inspect object evidence, immutable observations, camera poses and exported JSON. Ask by text or browser speech, including “帮我找钥匙” and “我要出发了”.
- Use arrow keys/WASD or buttons to simulate a wearer. Voice gives direction, alignment triggers a short haptic or screen animation, and a two-beat sound grows louder with proximity. Click **开启声音** first.
- Optional `FAL_KEY` enables `fal-ai/vggt-1b`: 2–8 keyframes per asynchronous reconstruction. Auto-update submits after every six accepted frames when no job is active. Each batch has its own map; batches are not silently fused. Uncalibrated reconstructions use **relative units**, never meters.
- A bundled 24-second **synthetic** video exercises movement, occlusion and reacquisition without credentials. Its detections/depth/poses are explicit fixtures; storage, queries and spatial guidance execute normally.
- `npm run preview:build` produces `public/pocketrecall-preview.html`: a single-file, offline interaction preview with browser storage and synthetic inputs. It contains no API keys. Uploaded real videos require the Node server and configured providers.

See [Run console details](docs/RUN_DEMO.md) and [how HD-EPIC / EgoRecall support the hackathon](docs/HACKATHON_DATA.md).

**Verification limits:** automated integration checks cover the console workflow and mocked provider contracts. In the current task sandbox, localhost bind returns `EPERM` and external DNS returns `ENOTFOUND`; real Gemini/VGGT requests and browser/device QA have not been completed. The Gemini key is stored only in ignored `.env.local`. No HD-EPIC or EgoRecall dataset is bundled yet.

## Spatial pipeline v2 — validate without a camera or API key

The new technical skeleton supports explicit entity registration, passive updates, evidence-backed 3D observations, current camera pose, and find/reacquire queries. It runs entirely from the command line; a browser server is not needed for validation.

```sh
npm run demo
npm test
npm run check
```

The demo uses **clearly synthetic images, detections, depth and camera poses** to run the actual storage, projection and guidance code. It checks active registration → passive movement → occlusion → changed viewpoint → reacquisition, and writes a trace and validation report beneath `.pocketrecall-data/`. Failure exits nonzero. This tests the integration and spatial math; it does **not** measure real-world perception or tracking accuracy.

Recorded input is accepted through `npm run replay -- --manifest <manifest.json> --out <new-output-directory>`. RGB-only recordings remain unlocalized. Metric 3D requires capture-time intrinsics plus a tracked camera pose and measured depth or a known support plane. A model is never asked to invent world coordinates.

See [the architecture and input contract](docs/SPATIAL_PIPELINE.md). The classic browser workspace at `/desk` remains the fixed-camera **v1** demo. The new `/run` console connects recorded frames to the spatial pipeline. ARKit/ARCore capture, automatic instance re-identification and the gesture UX remain adapter work.

## Run in 30 seconds

Requires **Node.js 22+**. There are **no third-party runtime dependencies** and no install/build step.

```sh
git clone https://github.com/CHYYYYYYYY/pocketrecall.git
cd pocketrecall
# If you received the demo as a patch, apply it here before starting.
npm start
```

Open **http://localhost:3000/desk** in Chrome for the classic demo described below. The labeled **Demo sandbox** works immediately without an API key. Click **Run guided demo**, then try **Where are my keys?**, **And before that?**, and **Have you seen my earbuds?**.

The guided scene places keys, moves them, and covers them. Its images and detections are explicitly **synthetic**; it exercises the same persistent memory engine and evidence/query endpoints used by the live camera. It is not a prerecorded or claimed live AI result.

## Connect real vision

Only **one API key** is required: a [Gemini API key from Google AI Studio](https://aistudio.google.com/apikey).

```sh
cp .env.example .env.local
```

Edit `.env.local` locally:

```dotenv
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.8-flash
PORT=3000
```

Use a model available to your account that supports image inputs and JSON-schema structured outputs. The default is configurable; a provider availability error is surfaced instead of silently switching to simulated data. Restart `npm start` after changing environment variables.

1. Click **Connect camera**, grant camera permission, and keep the camera fixed.
2. Position one distinct keyring, dark wallet, and white earbud case in view.
3. Optionally choose **Calibrate desk** and click the four corners in image order: top-left, top-right, bottom-right, bottom-left. The camera must face the desk from the user's side for near/far wording to match that user. Keep items close to the desk plane.
4. The server analyzes at most one frame at a time. The client waits about three seconds after each completion; actual cadence includes API/network latency. Failures back off and preserve history.
5. Click **Enable voice** once, allow the microphone, and ask naturally. The demo fixes speech-recognition language to English; typed Chinese queries are also supported.

Keys stay on the server. `.env.local`, captured images, and memory are gitignored. Do not paste secrets into source files or browser code.

Live frames are sent to Google for analysis. Browser speech recognition may also send audio to the browser vendor's recognition service; this is not an offline voice system. Stored evidence remains in `.pocketrecall-data/` on this machine. Pause stops image observations while keeping existing memories available; clear removes the session and its evidence. Restarted sessions reopen paused.

## What works

- Camera capture + real Gemini image analysis with fixed-target structured bounding boxes.
- Automatic, timestamped observations for keys, wallet, and earbuds.
- Durable JSON memory committed by atomic rename and matching PNG/JPEG evidence.
- Separate last-confirmed sighting, latest check, and observer service state.
- Optional four-corner homography calibration to a normalized desk plane.
- Responsive isometric memory view with ghosted historical positions and selectable evidence.
- Bounded event history and conversational previous-position lookup.
- Browser speech recognition + speech synthesis, with listening paused during answers and resumed afterward.
- English/Chinese object aliases, pause/resume/clear commands, and explicit unknown responses.
- Guards against late requests, old frames, clear/pause races, and mixed demo/live observations.

The spatial display is a **2.5D schematic**, not measured 3D reconstruction. Without calibration, positions and spoken directions refer to the camera image. With calibration, object-box centers are projected onto a desk plane; tall objects and perspective can introduce error. No physical height, centimeter precision, continuous trajectory, or hidden-object location is claimed. Dotted links connect observed positions only.

## 90-second demo

1. Explain the use case: you set something down while distracted and forget where.
2. Start with the keys visible; let the observation finish.
3. Move the keys, wait for the new observation, then cover them.
4. Ask **Where are my keys?**. Hear the last observed position/time and show its evidence.
5. Ask **Where were they before?**. The spatial view and evidence switch to the earlier location.
6. Ask **Are they still there?**. The system distinguishes a remembered location from current certainty.
7. Ask about the never-seen earbuds. It says there is no record.

Use real camera mode for the actual live-AI demonstration. Use the labeled sandbox for rehearsal or as an explicitly simulated fallback. The user does not need to look at or click the evidence interface between spoken queries. Browser compatibility and venue microphone/network behavior must be tested before presenting.

## Architecture

```text
Browser camera -> JPEG -> /api/observe -> Gemini structured detection
  -> schema + session/order validation -> evidence + observation memory

Speech recognition -> /api/query -> object/intent matching -> stored observation
  -> deterministic answer + exact evidence ID -> browser speech synthesis
```

The application does not use an LLM's conversation history as its database. Coordinates, timestamps, and evidence IDs are generated by code. The vision model only returns status and image boxes. Object identity is restricted to one instance of each of three target classes. Query parsing is deliberately bounded; this is not an open-ended agent.

| File | Responsibility |
| --- | --- |
| `server.mjs` | Local HTTP server, API routes, request limits, cancellation, static/evidence serving |
| `lib/vision.mjs` | Server-side Gemini adapter, response schema validation and coordinate conversion |
| `lib/memory.mjs` | Durable store, evidence lifecycle, history, query semantics, plane calibration |
| `public/app.js` | Camera, voice state machine, UI interactions, evidence selection |
| `public/scene.js` | Isometric schematic and watermarked synthetic demo images |
| `public/style.css` | Responsive visual workspace |

| API | Purpose |
| --- | --- |
| `GET /api/config` | Safe model configuration, never the secret |
| `GET /api/state` | Current session, objects, observations, events |
| `POST /api/session` | New `demo` or `live` session |
| `POST /api/observe` | Live image + capture metadata |
| `POST /api/demo/observe` | Labeled synthetic frame + detections, demo mode only |
| `POST /api/query` | Text question to evidence-backed answer |
| `POST /api/control` | `pause`, `resume`, or `clear` |
| `POST /api/calibration` | Four normalized corner points |
| `GET /api/evidence/:id` | Source image for one observation |

The service binds to loopback and accepts localhost hosts/origins. It is a single-session local prototype, not a public multi-user deployment. Move the camera only after starting a new session. Calibration adjusts the fixed-view coordinate mapping, not camera tracking.

## Verification

```sh
npm test
npm run check
```

Tests cover history after occlusion, unknown vs unsupported objects, evidence consistency, persistence, homography, invalid boxes, source isolation, stale sequences, clear/pause races, provider errors, oversized requests, and secret-safe configuration. HTTP integration tests call the real request handler without opening a port so they can run in restricted environments.

Live Gemini accuracy, microphone behavior, and latency require your API key, camera, browser, and venue network. No accuracy or latency claims have been measured yet. Sampling may miss an object that moves and disappears between observations. The application will report only the history it actually has.

## Troubleshooting

- **Gemini not configured:** check `.env.local` beside `server.mjs` and restart.
- **Model unavailable:** set `GEMINI_MODEL` to an image/structured-output model enabled for your project.
- **Quota/rate limit:** check your project's quota, wait, and resume. Existing evidence is retained.
- **Camera unavailable:** use localhost/HTTPS, allow camera access, and close other applications using it.
- **Speech unsupported:** use Chrome. Microphone permission and working network may be needed. Text input is a test fallback, not the intended No App interaction.
- **Wrong desk direction:** calibrate with the stated corner order and user-facing camera pose. Uncalibrated mode uses image directions.
- **Port already occupied:** change `PORT` in `.env.local` and restart.

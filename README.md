# PocketRecall

**A little less lost.** A voice-first spatial memory assistant. Watch a first-person video, remember where an object appeared, then find it through spoken directions, an alignment tap and a proximity heartbeat. The webpage simulates smart glasses and makes the memory inspectable.

▶ **[Concept film (1:46)](https://drive.google.com/file/d/1XA-NO-P9L9DJUAbpsXPJBeitypxOCQzd/view)** ([mp4 in repo](media/pocketrecall-concept-film.mp4)) — the product vision. Its HUD, 3D map and footage are simulated with CC0 photos ([credits](media/CREDITS.md)); the working demo is below.

▶ **[Concept film (1:46)](https://drive.google.com/file/d/1XA-NO-P9L9DJUAbpsXPJBeitypxOCQzd/view)** ([mp4 in repo](media/pocketrecall-concept-film.mp4)) — the product vision. Its HUD, 3D map and footage are simulated with CC0 photos ([credits](media/CREDITS.md)); the working demo is below.

## Run

Requires **Node.js 22+**.

```sh
git clone https://github.com/CHYYYYYYYY/pocketrecall.git
cd pocketrecall
npm ci
npm start
```

Open **http://localhost:3000/run**.

## Try it

1. Click **Watch kitchen + conversation**. The bundled real LEDGER / HD-EPIC kitchen video plays at 2× while the reference point cloud unfolds, object histories accumulate, and a generated user asks four questions about a wine glass. No microphone is needed for this guided demo.
2. With `GEMINI_API_KEY` in `.env.local`, those questions stream as real audio alongside video frames to **Gemini Live**. Answers call the actual memory tools and return spoken audio. Without a key, the demo uses explicitly labeled memory tools + browser speech. Geometry and detections are credited research replays, not a new reconstruction run.
3. To talk yourself, tap the microphone or **Try it with your eyes up**. Open **Why this answer** or an object card to inspect evidence. **Real desk** offers a second real sample with measured depth, reference camera poses, and an option to **Recognize again with Gemini**.
4. **Your memory** reopens saved sessions. **Demo** is the separate synthetic keys/wallet scenario: use arrows / WASD to move the virtual wearer, Q / E to tilt, or say **“I'm heading out”** and **“Got it”**. Sound gives a proximity heartbeat; desktop taps are visualized.

Keys stay on the server. Live sends microphone audio (generated speech in the guided demo) and video at 1 fps to Gemini; stopping it or hiding the page releases capture. Memories remain in ignored `.pocketrecall-data/`. Kitchen footage is for non-commercial research demonstration; [credits and transformations](public/assets/ledger/ATTRIBUTION.md).

## Your video and hardware

**Use your video** recognizes registered objects with Gemini. Automatic RGB-only reconstruction optionally needs `FAL_KEY`; overlapping VGGT windows are aligned into one relative-scale map. Without geometry, evidence is saved but no 3D directions are invented. RGB-D/SLAM and current-pose adapters are documented; physical glasses, general relocalization and arbitrary-room mapping are not deployed.

## Verify

```sh
npm test
npm run check
npm run smoke          # Real HTTP + new-process persistence check
npm run judge          # Real footage + recorded predictions; no key required
npm run judge:live     # Real Gemini vision + Live audio/video; consumes API quota
npm run judge:kitchen  # 41 real kitchen samples, temporal memory and restart
npm run judge:kitchen:live # Four generated speech turns through real Gemini Live
npm run preview:build  # Standalone synthetic preview
```

[Judge walkthrough & architecture](docs/HACKATHON.md) · [Validation](docs/VALIDATION.md) · [Related research](docs/RELATED_WORK.md) · [API / storage](docs/RUN_DEMO.md)

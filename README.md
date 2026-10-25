# PocketRecall

**A little less lost.** A screen-free spatial memory demo: remember where an object was last seen, then find it through voice, a light tap and a proximity heartbeat. The webpage simulates smart glasses and shows the memory behind the experience.

▶ **[Concept film (1:46)](https://drive.google.com/file/d/1XA-NO-P9L9DJUAbpsXPJBeitypxOCQzd/view)** ([mp4 in repo](media/pocketrecall-concept-film.mp4)) — the product vision. Its HUD, 3D map and footage are simulated with CC0 photos ([credits](media/CREDITS.md)); the working demo is below.

## Run

Requires **Node.js 22+**. No dependency installation or build step is needed.

```sh
git clone --branch codex/spatial-memory-pipeline https://github.com/CHYYYYYYYY/pocketrecall.git
cd pocketrecall
npm start
```

Open **http://localhost:3000/run**. The built-in demo works without API keys.

## Try the demo

1. Play the desk recording. Watch objects appear in the 3D map and memory list.
2. The keys move, then leave view. Ask **“Find my keys”** to retrieve their last observed location.
3. Enable sound and use **arrow keys / WASD** to move the simulated wearer; **Q / E** tilts the view. Alignment triggers a tap, and the heartbeat grows as you approach.
4. Choose **“Try it with your eyes up”** for voice interaction. Say **“I’m heading out”**, then **“Got it”** to confirm each item. Open an object or **“Open the record”** to inspect its evidence.

The recording, detections and geometry are synthetic; storage, retrieval and guidance execute the real code. Desktop haptics are visualized. Browser speech requires microphone access and a supported speech service.

## Use your own video

Create `.env.local` from `.env.example` if it does not already exist, fill in the relevant keys, then restart:

```dotenv
GEMINI_API_KEY=your_gemini_key
FAL_KEY=your_fal_key
```

- **Gemini** recognizes objects from sampled video frames.
- **fal VGGT** optionally reconstructs keyframes into depth, camera poses and a point cloud. Coordinates use relative scale until calibrated.
- **Import spatial data** replays a matching annotation package without model calls. See the [data format](docs/SPATIAL_MEMORY.md).

Keys stay on the server. Memories and evidence persist in `.pocketrecall-data/`. Reconstruction is batch-based; live provider performance and physical glasses integration remain unverified.

## Development

```sh
npm test               # Automated tests
npm run check          # JavaScript syntax checks
npm run demo           # Command-line spatial memory scenario
npm run preview:build  # Rebuild public/pocketrecall-preview.html
```

The standalone HTML preview uses browser storage and supports the synthetic demo and annotation replay. Uploaded-video AI processing requires the Node server.

[Demo details](docs/RUN_DEMO.md) · [Spatial memory](docs/SPATIAL_MEMORY.md) · [Dataset adapters](docs/HACKATHON_DATA.md)

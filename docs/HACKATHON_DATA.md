# Using HD-EPIC and EgoRecall for PocketRecall

Decision: prioritize **one HD-EPIC recording** for a prerecorded glasses demonstration. Use EgoRecall as a reference for time-aware retrieval and later evaluation. Keep the product contribution centered on translating remembered locations into voice, alignment haptics and proximity audio.

These are datasets/research implementations, not turnkey real-time reconstruction APIs. Their existence does not establish a complete deployed glasses product. Avoid claiming novelty for object memory itself.

## What to reuse

| Source | Available material | Role in this hackathon |
| --- | --- | --- |
| [HD-EPIC](https://hd-epic.github.io/site/) | Aria egocentric videos; kitchen digital twins; object pick-up/put-down tracks; 2D boxes and 3D locations; MP4-aligned calibration and poses | Real visual input and a known spatial reference for a reliable demo |
| [HD-EPIC annotations](https://github.com/hd-epic/hd-epic-annotations) | Associations join repeated movements of the same object; masks link frame numbers, boxes, locations and fixtures | Build last-seen history and demonstrate an object moving between surfaces |
| [EgoRecall](https://3dlg-hcvc.github.io/EgoRecall/) | Timestamped referring-expression queries, visibility history and evaluation protocols over ScanNet++ | Design “last seen / previously seen / no longer visible” tests and prevent future-frame leakage |

EgoRecall's scenes are static. It is not a benchmark of a keyring being moved or picked up. Its code is MIT-licensed, but annotation access is reviewed manually and underlying RGB-D/poses must be separately requested from ScanNet++. The annotation download does not contain the original video.

HD-EPIC offers MP4-aligned intermediate data, including device-to-world transforms and sensor-to-device calibration. A camera pose requires composing these transforms with the documented camera convention; do not treat a device pose as a camera optical pose. Its kitchen digital twins combine SLAM data with manual curation. Do not describe them as generated live by our API.

## Smallest useful data bundle

Use the [official downloader](https://github.com/hd-epic/hd-epic-downloader) to obtain one video, not the whole dataset. Keep one 60–120 second segment containing a cup, plate, or other actually annotated item that is placed, leaves view, and is encountered again. Kitchen recordings should not be relabeled as keys/wallet footage.

Pair it with:

- The relevant video entry in `scene-and-object-movements/assoc_info.json`.
- Referenced masks in `scene-and-object-movements/mask_info.json`.
- That video's aligned camera calibration and per-frame poses.
- A compact point cloud or mesh from the corresponding kitchen, if the license and distribution terms permit it.

The official schema maps an association to `name` and `tracks`; tracks contain `time_segment` and mask IDs. Each mask supplies `frame_number`, `3d_location`, `bbox`, and `fixture`. Preserve association identity, source frame numbers and the original timestamps. Do not interpolate endpoint annotations into claimed observations on every intervening frame.

Use the timestamp of a query as a hard cutoff: later frames, later placements and final ground truth cannot answer an earlier query. With prerecorded spatial metadata, map/trajectory display can reveal only the observed portion during the demo. Keep a complete reference map visually distinct if displayed.

## Presentation sequence

1. **Observe:** play real first-person footage. Show an object record forming from a timestamped frame, with a persistent evidence image.
2. **Remember:** the object moves, then leaves view. Update only from valid observations and preserve the most recent confirmed location.
3. **Ask:** the presenter says “我刚才把杯子放哪了？” Select the saved entity and show its evidence on the demo console.
4. **Guide:** use a virtual wearer to rotate toward the saved location. Produce a short haptic cue when aligned; make a quiet two-beat sound louder during approach; keep voice prompts short.
5. **Reacquire:** only label the item visually confirmed if a later frame actually shows it. Proximity alone is not confirmation.

The web page is the judges' observability surface. The product's user interaction is voice plus haptics/audio, with no screen required in the proposed glasses experience.

## Attribution and claims

Label each layer separately: `HD-EPIC recorded RGB`, `dataset-provided pose/map`, `Gemini-derived semantic observation` (only after an actual call), and `simulated wearer/haptics`. Annotations used to drive a scripted replay must say `dataset annotation replay`; they cannot be counted as our model's predictions or benchmark performance.

Both HD-EPIC data and EgoRecall annotations are published with noncommercial conditions; EgoRecall also inherits ScanNet++ access/usage terms. Attribute the authors and preserve source/clip identifiers. Check the applicable terms before distributing source videos or using them in a commercial product; a hackathon label alone does not settle the license question.

## Current integration status

The console, persistent 3D map/object store, synthetic replay, Gemini frame adapter and optional VGGT adapter are implemented. A dataset replay importer now consumes calibrated world positions and frame-aligned camera poses, and the HD-EPIC association/mask converter is covered by schema-fixture tests. **No actual HD-EPIC or EgoRecall recording is bundled or validated here.** This task environment cannot resolve external hosts from the runtime. Real data integration still needs the selected video/annotations and verified optical camera calibration. The current public sample link is a separate VGGT room clip, not HD-EPIC.

Convert a selected HD-EPIC clip with:

```sh
node scripts/convert-hd-epic.mjs \
  --associations assoc_info.json --masks mask_info.json \
  --geometry calibrated-clip.json --video-id VIDEO_ID \
  --objects ASSOCIATION_ID,ASSOCIATION_ID --out recording.json
```

`calibrated-clip.json` supplies `mapId`, `coordinateUnits:"meters"`, `cameraConvention:"opencv_optical"`, `bboxUnits:"pixels"` or `"normalized"`, `video:{name,width,height,duration,fps,startFrame}`, `poses:[{frameNumber,worldFromCamera}]` and optional `points:[[x,y,z,"#rrggbb"]]`. Frame numbers are the official source frame numbers; `startFrame` converts them into time within the clipped video. Camera matrices must be row-major 4×4, with optical camera X right / Y down / Z forward. Compose the official sensor/device transforms first; the converter deliberately rejects missing calibration instead of guessing it.

Load the clip in `/run`, then import `recording.json`. The player pauses/seeks to the annotated timestamp before capturing its evidence. The same association ID persists across movements, boxes are converted into square-letterboxed image coordinates, and no observation appears before its annotated time. Sparse endpoint annotations do not assert absence on other frames. A supplied full point cloud is labeled a precomputed reference map. See [the input contract](SPATIAL_MEMORY.md).

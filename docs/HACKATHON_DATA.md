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

The console, synthetic replay, Gemini frame adapter and optional VGGT adapter are implemented. **Neither HD-EPIC nor EgoRecall has been downloaded or integrated.** This task environment cannot resolve external hosts. Dataset support still needs the actual selected bundle, camera convention verification, a metadata importer, and replay alignment validation. The current public sample link is a separate VGGT room clip, not HD-EPIC.

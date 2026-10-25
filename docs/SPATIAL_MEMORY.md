# Durable 3D spatial memory

The middle layer is executable code in `lib/spatial/store.mjs` and `lib/spatial/pipeline.mjs`. It stores scene geometry, object identity, observed location, capture pose, time and image evidence. It uses a single-process JSON index with atomic rename; it is a hackathon implementation, not a multi-user database service.

## Stored relationships

| Record | Stable link | Meaning |
| --- | --- | --- |
| Map | `mapId` + `currentRevision` | One coordinate system with immutable units/source/provenance |
| Geometry revision | SHA-256 + `maps/<sha256>.json` | Immutable `[x,y,z,"#rrggbb"]` point cloud; hash verified on read |
| Entity | `entityId`, aliases, appearance, priority | The object instance being remembered |
| Observation | `entityId`, `mapId`, `position`, `capturedAt`, `poseRef` | One visual event; preserved rather than overwritten |
| Evidence | Image SHA-256, relative path, normalized crop | The exact image supporting that observation |
| Pose | `poseRef`, `mapId`, `capturedAt`, `worldFromCamera` | Camera geometry at image capture time |
| User report | `entityId`, `capturedAt`, `source:user_report` | Explicit speech confirmation, separate from visual facts |

A `not_seen` observation has no new location. The last confirmed sighting stays available with its original evidence. New positions generate movement events; old positions remain queryable. Later model completion times do not change observation chronology.

Point-cloud files are deduplicated by content. Revisions are not silently fused across independently reconstructed maps. `meters` and `relative` are different units; relative maps cannot return metric distances. Annotated 3D coordinates require explicit dataset provenance and a tracked capture pose. RGB-only detections remain unlocalized until geometry exists.

For a reconstruction batch, all observations, poses and the map index publish in one atomic commit. A failed batch leaves prior query results intact; unreferenced immutable evidence files may remain. Process restart reads the index and verifies point-cloud hashes. Session UI state stores map references, not its own copy of the point cloud.

## Query examples

After a session has observed objects, these same store calls back the HTTP API:

```js
store.query({ entityId: 'keys', at: '2026-10-24T20:00:10.000Z' });
store.history('keys');
store.readMap('demo-room');
store.readMap('demo-room', { revisionId: 'SHA256_FROM_MAP_INDEX' });
store.search({ text: '钥匙', mapId: 'demo-room', near: [0, 1, 2], radius: 3 });
```

Search selects the last sighting at or before `at`, within the requested map, then applies distance/radius in that map's units. It returns `meaning:last_seen_search_location`; a nearby remembered point is not proof the object remains there. `seenInLatestObservation` describes the saved recording, not current physical presence.

HTTP routes are `GET /api/run/maps`, `GET /api/run/map/:id`, `GET /api/run/history/:entityId`, and `POST /api/run/search`. POSTs include the current `sessionId`. A map request with `?revision=HASH` also cuts object/pose history off at that revision's capture time.

## Dataset recording package

This minimal **illustrative schema example** is not an actual dataset annotation. JSON cannot contain comments, so copy only the JSON if constructing a package:

```json
{
  "schemaVersion": 1,
  "provenance": "dataset_annotations",
  "source": { "dataset": "YOUR_DATASET", "videoId": "YOUR_CLIP" },
  "mapId": "room_1",
  "coordinateUnits": "meters",
  "imageSpace": "letterboxed_square",
  "video": { "name": "clip.mp4", "duration": 10, "width": 1920, "height": 1080 },
  "entities": [
    { "id": "cup_1", "label": "杯子", "aliases": ["cup"], "priority": "explicit" }
  ],
  "points": [[0, 0, 2, "#ffffff"]],
  "frames": [
    {
      "videoTime": 1,
      "worldFromCamera": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
      "detections": [
        { "entityId": "cup_1", "status": "seen", "bbox": [0.3,0.3,0.5,0.5], "worldPosition": [0,0,2] }
      ]
    },
    {
      "videoTime": 4,
      "worldFromCamera": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
      "detections": [{ "entityId": "cup_1", "status": "not_seen" }]
    }
  ]
}
```

The importer accepts 1–12 instances, 1–180 strictly increasing annotated frames and up to 25,000 reference points. Video filename, dimensions and duration must match the currently loaded clip. Camera matrices are rigid row-major world-from-camera transforms using optical X right / Y down / Z forward. Object coordinates and reference points must share their map and units.

Only publish `not_seen` when the source explicitly supports it. Missing annotations between sparse labeled frames are unknown, not absence. For HD-EPIC, the converter emits movement endpoint observations only and preserves association IDs through multiple movements.

The player seeks to an annotation time, captures the corresponding video image and submits it. The backend rejects future, duplicate and misaligned annotations. Model providers are not called in recording mode. Full reference geometry is labeled as precomputed; object memory and camera trajectories grow only as frames are ingested. Raw future annotations live in `recording.json`, excluded from state responses and memory exports.

## What remains external

Real provider accuracy and latency, optical calibration of actual HD-EPIC data, physical headset tracking and device haptics require their real inputs/hardware. The built-in synthetic recording tests the actual store, projection and guidance code. The HD-EPIC converter has schema-fixture tests; it does not download source data or derive camera calibration.

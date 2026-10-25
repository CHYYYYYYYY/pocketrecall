import { validatePose } from './spatial/geometry.mjs';

/** Dataset observations are replayed at their capture time, never as model output. */
export function validateRecording(input) {
  const value = structuredClone(input), safe = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
  const vector = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  if (value?.schemaVersion !== 1 || value.provenance !== 'dataset_annotations') throw new Error("The recording package requires schemaVersion:1 and provenance:dataset_annotations.");
  if (!value.source?.dataset || typeof value.source.dataset !== 'string' || value.source.dataset.length > 100) throw new Error("The recording package needs a dataset source.");
  if (!safe(value.mapId) || !['meters', 'relative'].includes(value.coordinateUnits)) throw new Error("The recording package needs a mapId and explicit coordinate units.");
  const v = value.video;
  if (!v || typeof v.name !== 'string' || v.name.length > 200 || !Number.isFinite(v.duration) || v.duration <= 0 || ![v.width, v.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192)) throw new Error("The recording package needs the video name, duration and dimensions.");
  if (value.imageSpace !== 'letterboxed_square') throw new Error("Convert bounding boxes to letterboxed_square coordinates.");
  if (!Array.isArray(value.entities) || !value.entities.length || value.entities.length > 12) throw new Error("The recording package must contain 1–12 object instances.");
  const ids = new Set();
  for (const e of value.entities) {
    if (!safe(e.id) || ids.has(e.id) || typeof e.label !== 'string' || !e.label.trim() || e.label.length > 60) throw new Error("The object ID or name is invalid.");
    if (e.aliases != null && !Array.isArray(e.aliases)) throw new Error("Object aliases must be an array.");
    ids.add(e.id); e.aliases = [...new Set([e.label, ...(e.aliases || [])])];
    if (e.aliases.length > 40 || e.aliases.some(a => typeof a !== 'string' || !a.trim() || a.length > 100)) throw new Error("The object aliases are invalid.");
    e.priority = e.priority === 'background' ? 'background' : 'explicit';
  }
  if (!Array.isArray(value.frames) || !value.frames.length || value.frames.length > 180) throw new Error("The recording package must contain 1–180 annotated frames.");
  let previous = -1;
  for (const [i, frame] of value.frames.entries()) {
    if (!Number.isFinite(frame.videoTime) || frame.videoTime <= previous || frame.videoTime < 0 || frame.videoTime > v.duration) throw new Error("Annotated frames must be in increasing video-time order.");
    previous = frame.videoTime;
    validatePose({ id: `annotation_${i}`, mapId: value.mapId, capturedAt: new Date(frame.videoTime * 1000).toISOString(), trackingState: 'tracking', worldFromCamera: frame.worldFromCamera });
    if (!Array.isArray(frame.detections) || !frame.detections.length) throw new Error("Each annotated frame needs observations.");
    const used = new Set();
    for (const d of frame.detections) {
      if (!ids.has(d.entityId) || used.has(d.entityId) || !['seen', 'not_seen'].includes(d.status)) throw new Error("The annotated object identity or status is invalid.");
      used.add(d.entityId);
      if (d.status === 'seen') {
        if (!vector(d.bbox, 4) || d.bbox.some(n => n < 0 || n > 1) || d.bbox[0] >= d.bbox[2] || d.bbox[1] >= d.bbox[3] || !vector(d.worldPosition, 3)) throw new Error("A visible object needs a bounding box and an annotated 3D position.");
      } else if (d.bbox != null || d.worldPosition != null) throw new Error("An unseen object cannot have a new position.");
      d.semantics = { ...d.semantics, provider: 'dataset_annotation', dataset: value.source.dataset, modelPrediction: false };
    }
  }
  value.points ||= [];
  if (!Array.isArray(value.points) || value.points.length > 25000 || value.points.some(p => !Array.isArray(p) || p.length !== 4 || !p.slice(0, 3).every(Number.isFinite) || !/^#[0-9a-f]{6}$/i.test(p[3]))) throw new Error("The reference cloud supports up to 25,000 [x,y,z,#rrggbb] points.");
  return value;
}
export function recordingFrame(recording, videoTime) {
  const frame = recording.frames.findLast(f => f.videoTime <= videoTime + .000001);
  if (!frame || !Number.isFinite(videoTime) || Math.abs(frame.videoTime - videoTime) > .08) throw new Error("The video frame is not aligned with an annotation. Seek to its timestamp.");
  return frame;
}

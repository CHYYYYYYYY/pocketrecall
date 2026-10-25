import { createHash } from 'node:crypto';
import { validateRecording } from './recording.mjs';

/** Adapt official HD-EPIC association/mask annotations. Camera calibration must
 * already be normalized into optical worldFromCamera poses; never infer axes. */
export function convertHdEpic({ associations, masks, geometry, videoId, objectIds }) {
  if (!geometry || geometry.cameraConvention !== 'opencv_optical' || geometry.coordinateUnits !== 'meters') throw new Error('Provide calibrated OpenCV optical worldFromCamera poses in meters.');
  const video = geometry.video, fps = video?.fps, start = video?.startFrame ?? 0;
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(start) || start < 0 || !['pixels', 'normalized'].includes(geometry.bboxUnits)) throw new Error('Geometry requires video.fps, startFrame and explicit bboxUnits.');
  if (!Array.isArray(geometry.poses) || !geometry.poses.length) throw new Error('Camera poses are required.');
  const poses = new Map();
  for (const p of geometry.poses) {
    if (!Number.isSafeInteger(p.frameNumber) || poses.has(p.frameNumber)) throw new Error('Camera poses need unique integer frameNumber values.');
    poses.set(p.frameNumber, p.worldFromCamera);
  }
  const groups = associations?.[videoId], annotations = masks?.[videoId];
  if (!groups || !annotations) throw new Error('Video ID is missing from the HD-EPIC annotations.');
  if (objectIds && (!Array.isArray(objectIds) || objectIds.some(k => !groups[k]))) throw new Error('Unknown association ID in object selection.');
  const selected = objectIds || Object.keys(groups), entities = [], byFrame = new Map();
  const usedMasks = new Map();
  for (const associationId of selected) {
    const group = groups[associationId];
    const entityId = `hd_${createHash('sha256').update(`${videoId}:${associationId}`).digest('hex').slice(0, 16)}`;
    let hasObservation = false;
    if (!Array.isArray(group.tracks)) throw new Error('Association tracks must be an array.');
    for (const track of group.tracks) {
      if (!Array.isArray(track.masks)) throw new Error('Track masks must be an array.');
      for (const maskId of track.masks) {
        const mask = annotations[maskId];
        if (!mask || !Number.isSafeInteger(mask.frame_number)) throw new Error(`Missing or invalid mask: ${maskId}`);
        const videoTime = (mask.frame_number - start) / fps;
        if (videoTime < 0 || videoTime > video.duration) continue;
        const owner = usedMasks.get(maskId);
        if (owner && owner !== entityId) throw new Error('One mask cannot identify two object instances.');
        if (owner) continue;
        usedMasks.set(maskId, entityId);
        if (!poses.has(mask.frame_number)) throw new Error(`Missing calibrated camera pose for frame ${mask.frame_number}.`);
        const bbox = mask.bbox;
        if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) throw new Error('Invalid annotation bbox.');
        const xyxy = geometry.bboxUnits === 'pixels' ? bbox : bbox.map((n, i) => n * (i % 2 ? video.height : video.width));
        const side = Math.max(video.width, video.height), paddingX = (side - video.width) / 2, paddingY = (side - video.height) / 2;
        const normalized = xyxy.map((n, i) => (n + (i % 2 ? paddingY : paddingX)) / side);
        const frame = byFrame.get(mask.frame_number) || { videoTime, worldFromCamera: poses.get(mask.frame_number), detections: [] };
        if (frame.detections.some(d => d.entityId === entityId)) throw new Error('Multiple masks for the same instance/frame require manual reconciliation.');
        frame.detections.push({ entityId, status: 'seen', bbox: normalized, worldPosition: mask['3d_location'], semantics: {
          associationId, trackId: String(track.track_id), maskId: String(maskId), originalFrameNumber: mask.frame_number,
          fixture: mask.fixture ?? null, annotation: 'movement_endpoint',
        } });
        byFrame.set(mask.frame_number, frame); hasObservation = true;
      }
    }
    if (hasObservation) entities.push({ id: entityId, label: String(group.name || associationId), aliases: [String(group.name || associationId)], priority: 'explicit' });
  }
  if (entities.length > 12 || byFrame.size > 180) throw new Error('Select a shorter clip or fewer association IDs (maximum 12 instances / 180 frames).');
  return validateRecording({
    schemaVersion: 1, provenance: 'dataset_annotations', source: {
      dataset: 'HD-EPIC', videoId, url: 'https://github.com/hd-epic/hd-epic-annotations',
      annotationCoverage: 'Sparse movement endpoints only; absent annotations do not mean not_seen.',
    },
    mapId: geometry.mapId, coordinateUnits: 'meters', imageSpace: 'letterboxed_square',
    video: { name: video.name, duration: video.duration, width: video.width, height: video.height },
    entities, points: geometry.points || [], frames: [...byFrame.values()].sort((a, b) => a.videoTime - b.videoTime),
  });
}

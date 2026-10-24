import { validatePose } from './spatial/geometry.mjs';

/** Dataset observations are replayed at their capture time, never as model output. */
export function validateRecording(input) {
  const value = structuredClone(input), safe = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
  const vector = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  if (value?.schemaVersion !== 1 || value.provenance !== 'dataset_annotations') throw new Error('回放包需要 schemaVersion:1 和 provenance:dataset_annotations。');
  if (!value.source?.dataset || typeof value.source.dataset !== 'string' || value.source.dataset.length > 100) throw new Error('回放包需要数据集来源。');
  if (!safe(value.mapId) || !['meters', 'relative'].includes(value.coordinateUnits)) throw new Error('回放包需要 mapId 和明确的坐标单位。');
  const v = value.video;
  if (!v || typeof v.name !== 'string' || v.name.length > 200 || !Number.isFinite(v.duration) || v.duration <= 0 || ![v.width, v.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192)) throw new Error('回放包需要视频名称、时长与尺寸。');
  if (value.imageSpace !== 'letterboxed_square') throw new Error('检测框必须转换为 letterboxed_square 坐标。');
  if (!Array.isArray(value.entities) || !value.entities.length || value.entities.length > 12) throw new Error('回放包需要 1–12 个物体实例。');
  const ids = new Set();
  for (const e of value.entities) {
    if (!safe(e.id) || ids.has(e.id) || typeof e.label !== 'string' || !e.label.trim() || e.label.length > 60) throw new Error('物体实例 ID 或名称无效。');
    if (e.aliases != null && !Array.isArray(e.aliases)) throw new Error('物体别名必须是数组。');
    ids.add(e.id); e.aliases = [...new Set([e.label, ...(e.aliases || [])])];
    if (e.aliases.length > 40 || e.aliases.some(a => typeof a !== 'string' || !a.trim() || a.length > 100)) throw new Error('物体别名无效。');
    e.priority = e.priority === 'background' ? 'background' : 'explicit';
  }
  if (!Array.isArray(value.frames) || !value.frames.length || value.frames.length > 180) throw new Error('回放包需要 1–180 个标注帧。');
  let previous = -1;
  for (const [i, frame] of value.frames.entries()) {
    if (!Number.isFinite(frame.videoTime) || frame.videoTime <= previous || frame.videoTime < 0 || frame.videoTime > v.duration) throw new Error('标注帧必须按视频时间递增。');
    previous = frame.videoTime;
    validatePose({ id: `annotation_${i}`, mapId: value.mapId, capturedAt: new Date(frame.videoTime * 1000).toISOString(), trackingState: 'tracking', worldFromCamera: frame.worldFromCamera });
    if (!Array.isArray(frame.detections) || !frame.detections.length) throw new Error('标注帧需要观测。');
    const used = new Set();
    for (const d of frame.detections) {
      if (!ids.has(d.entityId) || used.has(d.entityId) || !['seen', 'not_seen'].includes(d.status)) throw new Error('标注物体身份或状态无效。');
      used.add(d.entityId);
      if (d.status === 'seen') {
        if (!vector(d.bbox, 4) || d.bbox.some(n => n < 0 || n > 1) || d.bbox[0] >= d.bbox[2] || d.bbox[1] >= d.bbox[3] || !vector(d.worldPosition, 3)) throw new Error('可见物体需要边界框和标注 3D 位置。');
      } else if (d.bbox != null || d.worldPosition != null) throw new Error('未见到的物体不能带新位置。');
      d.semantics = { ...d.semantics, provider: 'dataset_annotation', dataset: value.source.dataset, modelPrediction: false };
    }
  }
  value.points ||= [];
  if (!Array.isArray(value.points) || value.points.length > 25000 || value.points.some(p => !Array.isArray(p) || p.length !== 4 || !p.slice(0, 3).every(Number.isFinite) || !/^#[0-9a-f]{6}$/i.test(p[3]))) throw new Error('参考点云最多 25000 个 [x,y,z,#rrggbb] 点。');
  return value;
}
export function recordingFrame(recording, videoTime) {
  const frame = recording.frames.findLast(f => f.videoTime <= videoTime + .000001);
  if (!frame || !Number.isFinite(videoTime) || Math.abs(frame.videoTime - videoTime) > .08) throw new Error('视频帧未与标注对齐，请定位到标注时刻。');
  return frame;
}

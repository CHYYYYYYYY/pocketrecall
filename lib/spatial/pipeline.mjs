import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SpatialStore } from './store.mjs';
import { validatePose, unprojectToWorld, intersectPlane, guideToTarget } from './geometry.mjs';

const clone = value => structuredClone(value);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** The input adapter supplies detections and the pose captured WITH that frame.
 * API responses may arrive later; current device pose is never used to localize old frames.
 * Real RGB-only frames are valid evidence, but remain spatially unlocalized.
 */
export class SpatialPipeline {
  constructor({ dataDir }) {
    this.dataDir = path.resolve(dataDir);
    this.store = new SpatialStore({ dataDir: this.dataDir });
    this.currentPose = null; // A restarted process must acquire a fresh pose.
  }

  register(entity) { return this.store.registerEntity(entity); }

  setPose(pose) {
    validatePose(pose);
    const saved = this.store.recordPose(pose);
    if (!this.currentPose || Date.parse(pose.capturedAt) >= Date.parse(this.currentPose.capturedAt)) this.currentPose = clone(pose);
    return saved;
  }

  ingest(frame) {
    if (!frame || !validId(frame.id) || !time(frame.capturedAt)) throw new Error('Frame requires a safe ID and capture timestamp.');
    if (!['active', 'passive'].includes(frame.source) || typeof frame.synthetic !== 'boolean') throw new Error('Frame provenance must be explicit.');
    if (!Array.isArray(frame.detections) || !frame.detections.length) throw new Error('Frame requires detections.');
    const entities = new Set(this.store.snapshot().entities.map(entity => entity.id));
    const existing = this.store.snapshot().observations;
    if (existing.some(observation => observation.frameId === frame.id)) throw new Error('Frame ID already recorded.');
    if (frame.pose) {
      validatePose(frame.pose);
      if (!validId(frame.pose.id)) throw new Error('Capture pose requires an ID.');
      if (Date.parse(frame.pose.capturedAt) !== Date.parse(frame.capturedAt)) throw new Error('Capture pose and frame timestamps must match exactly.');
    }
    const used = new Set();
    const candidates = frame.detections.map(detection => {
      if (!entities.has(detection.entityId) || used.has(detection.entityId)) throw new Error('Detection must identify one registered instance, once per frame.');
      used.add(detection.entityId);
      if (!['seen', 'not_seen'].includes(detection.status)) throw new Error('Unsupported detection status.');
      const bbox = detection.bbox ?? null;
      if (detection.status === 'seen' && (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(v => !Number.isFinite(v) || v < 0 || v > 1) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3])) throw new Error('Seen instances require normalized xyxy boxes.');
      if (detection.status === 'not_seen' && (bbox !== null || detection.depthM != null || detection.supportPlane != null)) throw new Error('Unseen instances cannot have measured positions.');
      if (detection.uncertaintyM != null && (!Number.isFinite(detection.uncertaintyM) || detection.uncertaintyM < 0)) throw new Error('Invalid spatial uncertainty.');
      if (detection.semantics != null && (typeof detection.semantics !== 'object' || Array.isArray(detection.semantics))) throw new Error('Semantics must be a JSON object.');
      let position = null, method = 'unlocalized';
      if (detection.status === 'seen' && frame.pose?.trackingState === 'tracking' && frame.intrinsics) {
        const pixel = [(bbox[0] + bbox[2]) / 2 * frame.intrinsics.width, (bbox[1] + bbox[3]) / 2 * frame.intrinsics.height];
        if (detection.depthM != null) {
          position = unprojectToWorld({ pixel, depthM: detection.depthM, intrinsics: frame.intrinsics, pose: frame.pose });
          method = 'depth';
        } else if (detection.supportPlane) {
          position = intersectPlane({ pixel, intrinsics: frame.intrinsics, pose: frame.pose, plane: detection.supportPlane });
          if (position) method = 'plane';
        }
      }
      return {
        id: `${frame.id}_${detection.entityId}`, entityId: detection.entityId,
        capturedAt: frame.capturedAt, source: frame.source, frameId: frame.id,
        evidence: { imagePath: '', crop: bbox, synthetic: frame.synthetic },
        mapId: frame.pose?.mapId ?? null, position, method,
        uncertaintyM: position ? detection.uncertaintyM ?? null : null,
        status: detection.status, poseRef: frame.pose?.id ?? null,
        semantics: clone(detection.semantics ?? {}),
      };
    });
    const source = path.resolve(frame.imagePath);
    const bytes = fs.readFileSync(source);
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Evidence must be nonempty and under 8 MB.');
    const imageSha256 = createHash('sha256').update(bytes).digest('hex');
    if(frame.imageSha256 && frame.imageSha256 !== imageSha256) throw new Error('Evidence changed after perception; image hash mismatch.');
    let extension;
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) extension = '.png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) extension = '.jpg';
    else if (frame.synthetic && /^\s*<svg[\s>]/.test(bytes.toString('utf8'))) extension = '.svg';
    else throw new Error('Real evidence must be PNG/JPEG; SVG is accepted only for labeled synthetic fixtures.');
    const relative = path.join('evidence', `${imageSha256}${extension}`);
    fs.mkdirSync(path.join(this.dataDir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(this.dataDir, relative), bytes, { flag: 'w' });
    if (frame.pose) this.setPose(frame.pose);
    const records = candidates.map(candidate => ({ ...candidate, evidence: { ...candidate.evidence, imagePath: relative } }));
    fs.mkdirSync(path.join(this.dataDir, 'frames'), { recursive:true });
    const metadata = { ...clone(frame), imagePath:relative, imageSha256, pose:frame.pose ?? null, intrinsics:frame.intrinsics ?? null, observationIds:records.map(o=>o.id) };
    const metadataPath = path.join(this.dataDir,'frames',`${frame.id}.json`);
    fs.writeFileSync(`${metadataPath}.tmp`,JSON.stringify(metadata,null,2)+'\n');
    fs.renameSync(`${metadataPath}.tmp`,metadataPath);
    const observations = this.store.addObservations(records);
    return { observations, snapshot: this.store.snapshot() };
  }

  recall(entityId, { pose = this.currentPose, at = new Date().toISOString(), maxPoseAgeMs = 3000 } = {}) {
    if (!time(at) || !Number.isFinite(maxPoseAgeMs) || maxPoseAgeMs < 0) throw new Error('Recall requires a valid evaluation time and pose freshness limit.');
    const result = this.store.query({ entityId });
    const last = result.lastSeen;
    const poseAgeMs = pose ? Date.parse(at)-Date.parse(pose.capturedAt) : null;
    const freshPose = pose && poseAgeMs >= -50 && poseAgeMs <= maxPoseAgeMs;
    let guidance = { status: 'unlocalized', distanceM: null, bearingDeg: null, elevationDeg: null, instruction: last ? 'Visual evidence exists, but a shared spatial position is unavailable.' : 'No confirmed visual observation exists.' };
    if (last?.position && pose) guidance = freshPose ? guideToTarget({ target: { mapId: last.mapId, position: last.position, uncertaintyM: last.uncertaintyM }, pose }) : { status:'relocalize', distanceM:null,bearingDeg:null,elevationDeg:null,instruction:'Current camera pose is stale or unsynchronized. Acquire a fresh pose before giving directions.' };
    const sightingAgeMs=last?Date.parse(at)-Date.parse(last.capturedAt):null;
    const confirmedNow = Boolean(last && freshPose && pose.trackingState === 'tracking' && last.mapId === pose.mapId && result.latestCheck?.id === last.id && sightingAgeMs >= 0 && sightingAgeMs <= 2000);
    return { ...result, guidance, confirmedNow, evaluatedAt:at,poseAgeMs,targetMeaning: confirmedNow ? 'recently_visually_confirmed' : 'last_seen_search_location' };
  }
}

/** Recorded-video adapters emit this same manifest after frame extraction/detection. */
export function replayManifest(manifest, { dataDir, baseDir = process.cwd() }) {
  if (!manifest || !Array.isArray(manifest.entities) || !Array.isArray(manifest.events)) throw new Error('Manifest requires entities and events arrays.');
  const pipeline = new SpatialPipeline({ dataDir });
  for (const entity of manifest.entities) pipeline.register(entity);
  const trace = [];
  let replayTime = null;
  for (const [index, event] of manifest.events.entries()) {
    let result;
    if (event.type === 'frame') { result = pipeline.ingest({ ...event.frame, imagePath: path.resolve(baseDir, event.frame.imagePath) }); replayTime=event.frame.capturedAt; }
    else if (event.type === 'pose') { result = pipeline.setPose(event.pose);replayTime=event.pose.capturedAt; }
    else if (event.type === 'query') { const at=event.at ?? replayTime;if(!at)throw new Error('Replay queries need an explicit time or an earlier timestamped event.');result = pipeline.recall(event.entityId, { ...(event.pose ? { pose:event.pose } : {}),at });replayTime=at; }
    else if (event.type === 'user_report') {result = pipeline.store.addUserReport(event.report);replayTime=event.report.capturedAt;}
    else if (event.type === 'perception_skipped') {if(event.frame.pose)pipeline.setPose(event.frame.pose);replayTime=event.frame.capturedAt;result={skippedDetections:event.frame.skippedDetections,reason:'No decisive visual observations; existing memory preserved.'};}
    else throw new Error(`Unknown replay event: ${event.type}`);
    trace.push({ index, type: event.type, label: event.label ?? null, result });
  }
  return { pipeline, trace, snapshot: pipeline.store.snapshot() };
}

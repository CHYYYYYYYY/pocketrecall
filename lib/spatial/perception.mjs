import { open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createVisionClient, validateFrameImage, VisionError } from '../vision.mjs';

const CATEGORIES = new Set(['keys', 'wallet', 'earbuds']);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);

/**
 * Real JPEG/PNG -> the same frame contract consumed by SpatialPipeline.ingest.
 * The adapter is deliberately bounded to ONE registered instance per category.
 * It does not solve general instance re-identification. Geometry must come from
 * trusted capture metadata in frame.objectGeometry[entityId], never the model.
 * skipIngest=true means no decisive observations were returned; keep memory.
 */
export async function perceiveFrame({ imagePath, frame, bindings, vision = createVisionClient(), signal }) {
  if (typeof imagePath !== 'string' || !imagePath.trim()) throw new VisionError('A local JPEG or PNG image path is required.', 400);
  if (!frame || !safeId(frame.id) || typeof frame.capturedAt !== 'string' || !Number.isFinite(Date.parse(frame.capturedAt))) throw new VisionError('Frame requires an ID and original capture timestamp.', 400);
  const source = frame.source ?? 'passive';
  if (!['active', 'passive'].includes(source)) throw new VisionError('Frame source must be active or passive.', 400);
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || !Object.keys(bindings).length) throw new VisionError('Register at least one category-to-entity binding.', 400);
  const entries = Object.entries(bindings);
  const identities = new Set();
  for (const [category, entityId] of entries) {
    if (!CATEGORIES.has(category) || !safeId(entityId) || identities.has(entityId)) throw new VisionError('Bindings require distinct entity IDs and one instance per supported category.', 400);
    identities.add(entityId);
  }
  if (!vision || typeof vision.analyzeFrame !== 'function') throw new TypeError('A vision client with analyzeFrame is required.');
  if (vision.configured === false) throw new VisionError('Gemini is not configured. Set GEMINI_API_KEY before processing real frames.', 503);
  signal?.throwIfAborted();
  // Snapshot BEFORE any asynchronous work: a moving camera or caller mutating
  // its current pose while the request is in flight must not rewrite history.
  const captured = structuredClone(frame);
  const resolvedPath = path.resolve(imagePath);
  const handle = await open(resolvedPath, 'r');
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new VisionError('Use a JPEG or PNG file under 4 MB.', 400);
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const mimeType = png ? 'image/png' : 'image/jpeg';
  const imageDataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  validateFrameImage(imageDataUrl);
  const result = await vision.analyzeFrame(imageDataUrl, { signal });
  signal?.throwIfAborted();
  if (!result?.items || typeof result.items !== 'object') throw new VisionError('Vision returned no valid observations.');
  const detections = [], skippedDetections = [];
  for (const [category, entityId] of entries) {
    const item = result.items[category];
    if (!item || !['seen', 'not_seen', 'unclear'].includes(item.status)) throw new VisionError('Vision returned an invalid target status.');
    if (item.status !== 'seen' && item.bbox != null) throw new VisionError('Vision attached a box to an unconfirmed target.');
    if (item.status === 'unclear') {
      skippedDetections.push({ category, entityId, reason: 'unclear' });
      continue;
    }
    const detection = { entityId, status: item.status, bbox: null, semantics: { category, identityAssociation: 'registered_single_instance_per_category' } };
    if (item.status === 'seen') {
      const b = item.bbox;
      if (!Array.isArray(b) || b.length !== 4 || b.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) || b[0] >= b[2] || b[1] >= b[3]) throw new VisionError('Vision returned an invalid normalized bounding box.');
      detection.bbox = [...b];
      const geometry = captured.objectGeometry?.[entityId];
      if (geometry != null) {
        if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) throw new VisionError('Sensor geometry must be an object.', 400);
        if (geometry.depthM != null) {
          if (typeof geometry.depthM !== 'number' || !Number.isFinite(geometry.depthM) || geometry.depthM <= 0) throw new VisionError('Sensor depth must be positive meters.', 400);
          detection.depthM = geometry.depthM;
        }
        if (geometry.supportPlane != null) detection.supportPlane = structuredClone(geometry.supportPlane);
        if (geometry.uncertaintyM != null) {
          if (typeof geometry.uncertaintyM !== 'number' || !Number.isFinite(geometry.uncertaintyM) || geometry.uncertaintyM < 0) throw new VisionError('Sensor uncertainty must be nonnegative meters.', 400);
          detection.uncertaintyM = geometry.uncertaintyM;
        }
      }
    }
    detections.push(detection);
  }
  return {
    ...captured, imagePath: resolvedPath, imageSha256: createHash('sha256').update(bytes).digest('hex'), source, synthetic: false, detections,
    skippedDetections, skipIngest: detections.length === 0,
    perception: { provider: 'gemini', model: vision.model ?? null, identityPolicy: 'one_registered_instance_per_category', usage: result.usage ?? null },
  };
}

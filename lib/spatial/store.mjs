import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validatePose } from './geometry.mjs';

const clone = value => structuredClone(value);
const STATES = ['seen', 'not_seen'];
const METHODS = ['depth', 'plane', 'annotation', 'unlocalized'];
const emptyState = () => ({ schemaVersion: 2, entities: [], observations: [], poses: [], userReports: [], events: [], maps: [] });

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) throw new Error(`${label} must be a stable identifier.`);
  return value;
}
function text(value, label, maximum = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${label} must be non-empty text under ${maximum} characters.`);
  return value.trim();
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('capturedAt must be an ISO timestamp with a timezone.');
  return new Date(value).toISOString();
}
function jsonValue(value, label) {
  const encoded = JSON.stringify(value, (_, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error(`${label} cannot contain non-finite numbers.`);
    if (typeof item === 'function' || typeof item === 'bigint' || typeof item === 'undefined') throw new Error(`${label} must be JSON data.`);
    return item;
  });
  if (encoded.length > 20000) throw new Error(`${label} is too large.`);
  return JSON.parse(encoded);
}
function validCrop(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length !== 4 || value.some(n => !Number.isFinite(n) || n < 0 || n > 1) || value[0] >= value[2] || value[1] >= value[3]) throw new Error('Evidence crop must be normalized [x0,y0,x1,y1].');
  return [...value];
}
function ordered(observations) {
  // Capture time, never model completion time, determines latest memory.
  return observations.map((observation, index) => ({ observation, index }))
    .sort((a, b) => Date.parse(a.observation.capturedAt) - Date.parse(b.observation.capturedAt) || a.index - b.index)
    .map(entry => entry.observation);
}

/** Single-process demo store. JSON + atomic rename; immutable observations, derived current views. */
export class SpatialStore {
  constructor({ dataDir = path.resolve('.pocketrecall-spatial') } = {}) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.realDataDir = fs.realpathSync(this.dataDir);
    this.statePath = path.join(this.dataDir, 'spatial-memory.json');
    this.state = emptyState();
    if (fs.existsSync(this.statePath)) {
      const saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (saved?.schemaVersion !== 2 || ['entities', 'observations', 'poses', 'userReports', 'events'].some(key => !Array.isArray(saved[key]))) throw new Error('Unsupported spatial memory file.');
      this.state = saved;
      this.state.maps ||= [];
      if (!Array.isArray(this.state.maps)) throw new Error('Unsupported spatial map index.');
    }
  }

  snapshot() { return clone(this.state); }

  commit(next) {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.statePath);
      this.state = next;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  entity(entityId) {
    identifier(entityId, 'entityId');
    const result = this.state.entities.find(entity => entity.id === entityId);
    if (!result) throw new Error(`Unknown entity: ${entityId}`);
    return result;
  }

  registerEntity({ id, label, aliases = [], appearance = '', priority = 'background' }) {
    identifier(id, 'Entity id');
    label = text(label, 'Entity label', 200);
    if (!Array.isArray(aliases) || aliases.length > 40) throw new Error('aliases must be an array of at most 40 names.');
    const normalizedAliases = aliases.map(alias => text(alias, 'Alias', 200));
    if (typeof appearance !== 'string' || appearance.length > 2000) throw new Error('appearance must be text under 2000 characters.');
    if (!['explicit', 'background'].includes(priority)) throw new Error('Invalid entity priority.');
    const next = clone(this.state);
    const existing = next.entities.find(entity => entity.id === id);
    const entity = {
      id, label, aliases: [...new Set([...(existing?.aliases || []), ...normalizedAliases])],
      appearance: appearance || existing?.appearance || '',
      priority: priority === 'explicit' || existing?.priority === 'explicit' ? 'explicit' : 'background',
    };
    if (existing) next.entities[next.entities.indexOf(existing)] = entity;
    else {
      next.entities.push(entity);
      next.events.push({ id: randomUUID(), type: 'entity_registered', entityId: id, capturedAt: new Date().toISOString(), observationIds: [] });
    }
    this.commit(next);
    return clone(entity);
  }

  recordPose(pose) {
    identifier(pose?.id, 'Pose id');
    validatePose(pose);
    const normalized = { id: pose.id, mapId: identifier(pose.mapId, 'mapId'), capturedAt: timestamp(pose.capturedAt), worldFromCamera: [...pose.worldFromCamera], trackingState: pose.trackingState };
    const existing = this.state.poses.find(item => item.id === normalized.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error('A recorded pose cannot be overwritten.');
      return clone(existing);
    }
    const next = clone(this.state);
    next.poses.push(normalized);
    this.commit(next);
    return clone(normalized);
  }

  evidenceRecord(evidence) {
    if (!evidence || typeof evidence.synthetic !== 'boolean') throw new Error('Visual evidence must state whether it is synthetic.');
    const supplied = text(evidence.imagePath, 'Evidence imagePath', 2000);
    const absolute = path.resolve(this.dataDir, supplied);
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(this.realDataDir + path.sep)) throw new Error('Evidence must stay inside dataDir.');
    const info = fs.statSync(real);
    if (!info.isFile() || info.size === 0) throw new Error('Evidence must reference a non-empty local file.');
    const bytes = fs.readFileSync(real);
    return { imagePath: path.relative(this.dataDir, absolute), crop: validCrop(evidence.crop), synthetic: evidence.synthetic, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  addObservation(input) {
    if (!input || typeof input !== 'object') throw new Error('Observation is required.');
    const { id, entityId, source, frameId, mapId, poseRef, status, method } = input;
    identifier(id, 'Observation id');
    this.entity(entityId);
    identifier(frameId, 'frameId');
    if (mapId != null) identifier(mapId, 'mapId');
    if (poseRef != null) identifier(poseRef, 'poseRef');
    if (!['active', 'passive'].includes(source)) throw new Error('Visual source must be active or passive.');
    if (!STATES.includes(status) || !METHODS.includes(method)) throw new Error('Invalid observation status or position method.');
    const capturedAt = timestamp(input.capturedAt);
    if (input.position != null && !Array.isArray(input.position)) throw new Error('Position must be an array.');
    const position = input.position == null ? null : [...input.position];
    if (position !== null && (position.length !== 3 || position.some(n => !Number.isFinite(n)))) throw new Error('Position must be three finite metric coordinates.');
    if ((position === null) !== (method === 'unlocalized')) throw new Error('Unlocalized observations have no position; depth/plane observations require a position.');
    if (status === 'not_seen' && position !== null) throw new Error('An unseen object cannot have a new position.');
    const uncertaintyM = input.uncertaintyM ?? null;
    if (uncertaintyM !== null && (!Number.isFinite(uncertaintyM) || uncertaintyM < 0)) throw new Error('uncertaintyM must be null or a non-negative number.');
    if (position === null && uncertaintyM !== null) throw new Error('An unlocalized observation cannot have a position uncertainty.');
    const pose = poseRef == null ? null : this.state.poses.find(item => item.id === poseRef);
    if (poseRef != null && !pose) throw new Error('Record the frame pose before its observation.');
    if (pose && (pose.mapId !== mapId || pose.capturedAt !== capturedAt)) throw new Error('Observation must reference its own capture-time pose in the same map.');
    if (position && (!pose || pose.trackingState !== 'tracking')) throw new Error('A missing or lost pose cannot support a localized observation.');
    const evidence = this.evidenceRecord(input.evidence);
    if (status === 'not_seen' && evidence.crop !== null) throw new Error('An unseen object cannot have a detection crop.');
    const semantics = jsonValue(input.semantics ?? {}, 'semantics');
    if (!semantics || Array.isArray(semantics) || typeof semantics !== 'object') throw new Error('semantics must be an object.');
    if (input.coordinateUnits != null && !['meters', 'relative'].includes(input.coordinateUnits)) throw new Error('Unsupported coordinate units.');
    const map = this.state.maps.find(item => item.id === mapId);
    if (map && input.coordinateUnits && map.units !== input.coordinateUnits) throw new Error('Observation units disagree with its spatial map.');
    if (map && position && map.units !== (input.coordinateUnits || 'meters')) throw new Error('Localized observations require the same units as their map.');
    if (map && map.synthetic !== evidence.synthetic) throw new Error('Observation provenance disagrees with its spatial map.');
    const observation = { id, entityId, capturedAt, source, frameId, evidence, mapId: mapId ?? null, position, method, uncertaintyM, status, poseRef: poseRef ?? null, semantics, ...(input.coordinateUnits ? { coordinateUnits: input.coordinateUnits } : {}) };
    const duplicate = this.state.observations.find(item => item.id === id);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(observation)) throw new Error('An observation cannot be overwritten.');
      return clone(duplicate);
    }
    const next = clone(this.state);
    next.observations.push(observation);
    // Rebuild derived visual events in capture order, including late-arriving observations.
    // This avoids recording false motion when a slower API response arrives out of order.
    next.events = next.events.filter(event => event.entityId !== entityId || event.type === 'entity_registered');
    let lastSeen = null;
    for (const item of ordered(next.observations.filter(item => item.entityId === entityId))) {
      let type = item.status === 'not_seen' ? 'not_seen' : 'seen';
      const previous = lastSeen;
      if (item.status === 'seen') {
        if (previous?.position && item.position && previous.mapId === item.mapId && Math.hypot(...item.position.map((n, i) => n - previous.position[i])) > 0.03) type = 'position_changed';
        lastSeen = item;
      }
      next.events.push({ id: `event:${item.id}`, type, entityId, capturedAt: item.capturedAt, observationIds: type === 'position_changed' ? [previous.id, item.id] : [item.id] });
    }
    this.commit(next);
    return clone(observation);
  }

  addUserReport({ entityId, capturedAt, text: reportText }) {
    this.entity(entityId);
    const report = { id: randomUUID(), entityId, capturedAt: timestamp(capturedAt), source: 'user_report', text: text(reportText, 'User report', 4000) };
    const next = clone(this.state);
    next.userReports.push(report);
    this.commit(next);
    return clone(report);
  }

  /** Validate all detections from a frame before publishing any of its memory. */
  addObservations(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 500) throw new Error('Observation batch must contain 1 to 500 observations.');
    // addObservation has no file writes except commit: evidence is read-only.
    // Stage through the same validation/event code, then publish one atomic file.
    const staged = Object.create(this);
    staged.state = clone(this.state);
    staged.commit = next => { staged.state = next; };
    const records = inputs.map(input => staged.addObservation(input));
    this.commit(staged.state);
    return records;
  }

  query({ entityId, at, mapId } = {}) {
    const entity = this.entity(entityId);
    if (mapId != null) identifier(mapId, 'Map id');
    const cutoff = at === undefined ? Infinity : Date.parse(timestamp(at));
    const history = ordered(this.state.observations.filter(item => item.entityId === entityId && (!mapId || item.mapId === mapId) && Date.parse(item.capturedAt) <= cutoff));
    return clone({ entity, lastSeen: history.findLast(item => item.status === 'seen') || null, latestCheck: history.at(-1) || null });
  }

  history(entityId) {
    this.entity(entityId);
    return clone(ordered(this.state.observations.filter(item => item.entityId === entityId)));
  }

  /** Versioned 3D maps are independent of UI sessions. Geometry is immutable and
   * content addressed; only the small index is atomically replaced. */
  saveMap({ id, units, source, synthetic, points = [], capturedAt = new Date().toISOString(), reference = false }) {
    identifier(id, 'Map id'); capturedAt = timestamp(capturedAt);
    if (!['meters', 'relative'].includes(units) || typeof synthetic !== 'boolean' || typeof source !== 'string' || !source.trim() || source.length > 200) throw new Error('Maps require explicit units, source and provenance.');
    if (!Array.isArray(points) || points.length > 100000 || points.some(p => !Array.isArray(p) || p.length !== 4 || p.slice(0, 3).some(n => !Number.isFinite(n)) || typeof p[3] !== 'string' || !/^#[0-9a-f]{6}$/i.test(p[3]))) throw new Error('Map geometry must contain at most 100000 valid XYZ/color points.');
    const prior = this.state.maps.find(m => m.id === id);
    if (prior && (prior.units !== units || prior.synthetic !== synthetic || prior.source !== source || prior.reference !== Boolean(reference))) throw new Error('Map units and provenance cannot change; create a new map.');
    const incompatible = this.state.observations.some(o => o.mapId === id && ((o.position && (o.coordinateUnits || 'meters') !== units) || (o.coordinateUnits && o.coordinateUnits !== units)));
    if (incompatible) throw new Error('Map units disagree with stored observations.');
    if (this.state.observations.some(o => o.mapId === id && o.evidence.synthetic !== synthetic)) throw new Error('Map provenance disagrees with stored observations.');
    const bytes = Buffer.from(JSON.stringify(points)); const hash = createHash('sha256').update(bytes).digest('hex');
    const directory = path.join(this.dataDir, 'maps'); fs.mkdirSync(directory, { recursive: true });
    const relative = path.join('maps', `${hash}.json`), filename = path.join(this.dataDir, relative);
    if (!fs.realpathSync(directory).startsWith(this.realDataDir + path.sep)) throw new Error('Map geometry must stay inside dataDir.');
    if (!fs.existsSync(filename)) {
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, filename); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    } else if (createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== hash) throw new Error('Spatial map checksum mismatch.');
    const revision = { id: hash, capturedAt, pointCount: points.length, geometryPath: relative, sha256: hash };
    const next = clone(this.state), record = { id, units, source, synthetic, reference: Boolean(reference), revisions: [...(prior?.revisions || [])] };
    if (!record.revisions.some(r => r.id === hash)) record.revisions.push(revision);
    if (record.revisions.length > 200) throw new Error('Map revision limit reached.');
    record.currentRevision = hash;
    const index = next.maps.findIndex(m => m.id === id); if (index < 0) next.maps.push(record); else next.maps[index] = record;
    this.commit(next); return clone(record);
  }

  readMap(mapId, { revisionId } = {}) {
    identifier(mapId, 'Map id');
    const map = this.state.maps.find(m => m.id === mapId); if (!map) throw new Error('Unknown spatial map.');
    const revision = map.revisions.find(r => r.id === (revisionId || map.currentRevision)); if (!revision) throw new Error('Unknown map revision.');
    const filename = fs.realpathSync(path.resolve(this.dataDir, revision.geometryPath));
    if (!filename.startsWith(this.realDataDir + path.sep)) throw new Error('Map geometry must stay inside dataDir.');
    const bytes = fs.readFileSync(filename);
    if (createHash('sha256').update(bytes).digest('hex') !== revision.sha256) throw new Error('Spatial map checksum mismatch.');
    return { ...clone(map), revision: clone(revision), points: JSON.parse(bytes) };
  }

  /** Last confirmed positions, filtered at capture time, with no future leakage. */
  search({ text: queryText = '', mapId, near, radius, at, limit = 50 } = {}) {
    if (typeof queryText !== 'string' || queryText.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid spatial search.');
    if (mapId != null) identifier(mapId, 'Map id');
    if (near != null && (!mapId || !Array.isArray(near) || near.length !== 3 || !near.every(Number.isFinite))) throw new Error('Nearest search requires a map ID and XYZ position.');
    if (radius != null && (near == null || !Number.isFinite(radius) || radius <= 0)) throw new Error('Radius requires a positive value and search position.');
    if (at !== undefined) timestamp(at);
    const needle = queryText.trim().toLowerCase(), results = [];
    for (const entity of this.state.entities) {
      if (needle && ![entity.label, ...entity.aliases, entity.appearance].some(s => s.toLowerCase().includes(needle))) continue;
      const q = this.query({ entityId: entity.id, at, mapId }), observation = q.lastSeen;
      if (!observation) continue;
      if (near && !observation.position) continue;
      const distance = near ? Math.hypot(...observation.position.map((n, i) => n - near[i])) : null;
      if (radius != null && distance > radius) continue;
      results.push({ ...q, distance, coordinateUnits: observation.position ? observation.coordinateUnits || this.state.maps.find(m => m.id === observation.mapId)?.units || 'meters' : null, meaning: 'last_seen_search_location', seenInLatestObservation: q.latestCheck?.id === observation.id });
    }
    if (near) results.sort((a, b) => a.distance - b.distance);
    else results.sort((a, b) => Date.parse(b.lastSeen.capturedAt) - Date.parse(a.lastSeen.capturedAt));
    return clone(results.slice(0, limit));
  }
}

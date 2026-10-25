import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpatialPipeline } from './spatial/pipeline.mjs';
import { guideToTarget, validatePose } from './spatial/geometry.mjs';
import { createRunVisionClient } from './run-vision.mjs';
import { createReconstructionClient, reconstructFrame } from './reconstruction.mjs';
import { validateFrameImage, VisionError } from './vision.mjs';
import { voiceIntent, nextChecklistTarget } from './voice-intent.mjs';
import { validateRecording, recordingFrame } from './recording.mjs';

const ENTITIES = [
  { id: 'keys', label: 'Keys', aliases: ['钥匙', 'key', 'keys', 'keyring'], priority: 'explicit' },
  { id: 'wallet', label: 'Wallet', aliases: ['钱包', 'wallet', 'cardholder'], priority: 'explicit' },
  { id: 'earbuds', label: 'Earbuds', aliases: ['耳机', 'earbuds', 'airpods'], priority: 'explicit' },
  { id: 'phone', label: 'Phone', aliases: ['手机', 'phone', 'iphone'], priority: 'background' },
];
const id = () => randomUUID().replaceAll('-', '');
const iso = () => new Date().toISOString();
const writeJson = (file, data) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); };
const clip = (n, min, max) => Math.max(min, Math.min(max, n));

function presentEvent(event) {
  if (!/[\p{Script=Han}]/u.test(event.text) || event.type === 'query') return event;
  const labels = { memory: 'Frame saved to memory.', map: 'Spatial reconstruction updated.', answer: 'Previous spoken guidance.', command: 'Previous voice command.', registered: 'An object was added to memory.', user_confirmed: 'An item was confirmed by voice.', error: 'A previous request failed. Original details are saved.' };
  return { ...event, originalText: event.text, text: labels[event.type] || event.text };
}

export class RunSession {
  constructor({ dataDir, fixturePath, vision = createRunVisionClient(), reconstruction = createReconstructionClient() }) {
    this.root = dataDir; this.fixturePath = fixturePath; this.vision = vision; this.reconstruction = reconstruction;
    fs.mkdirSync(this.root, { recursive: true }); this.controller = new AbortController();
    const active = path.join(this.root, 'active.json');
    if (fs.existsSync(active)) {
      const saved = JSON.parse(fs.readFileSync(active, 'utf8'));
      if (/^[a-f0-9]{32}$/.test(saved.id)) this.open(saved.id);
    }
    if (!this.session) this.start({ mode: 'demo', filename: "Desk study / synthetic recording" });
  }
  open(sessionId) {
    this.dir = path.join(this.root, sessionId);
    this.session = JSON.parse(fs.readFileSync(path.join(this.dir, 'session.json'), 'utf8'));
    this.pipeline = new SpatialPipeline({ dataDir: this.dir });
    if (this.session.mode !== 'recording') {
      for (const entity of this.pipeline.store.snapshot().entities) {
        const defaults = ENTITIES.find(item => item.id === entity.id);
        if (defaults && entity.label === defaults.aliases[0]) this.pipeline.register({ ...entity, label: defaults.label });
      }
      if (this.session.filename === 'PocketRecall · 合成第一视角录像') this.session.filename = 'Desk study / synthetic recording';
    }
    if (this.session.mode === 'recording') this.session.recording = validateRecording(JSON.parse(fs.readFileSync(path.join(this.dir, 'recording.json'), 'utf8')));
    if (this.session.map) {
      // Upgrade old sessions once, then read geometry from the durable map store.
      if (this.session.mode === 'demo' && this.session.map.reference == null) this.session.map.reference = true;
      if (Array.isArray(this.session.map.points) && !this.pipeline.store.snapshot().maps.some(m => m.id === this.session.map.id)) this.pipeline.store.saveMap(this.session.map);
      const geometry = this.pipeline.store.readMap(this.session.map.id);
      this.session.map = { ...this.session.map, ...geometry, poses: this.pipeline.store.snapshot().poses.filter(p => p.mapId === geometry.id) };
    }
    if (['submitting', 'processing'].includes(this.session.job?.status)) this.session.job = { ...this.session.job, status: 'failed', error: "Reconstruction was interrupted by a restart. Submit it again." };
    // A process restart never revives an in-flight recognition request.
    this.busy = null; this.pollBusy = false;
  }
  persist() {
    const { recording, map, ...session } = this.session;
    const { points, poses, ...mapReference } = map || {};
    writeJson(path.join(this.dir, 'session.json'), { ...session, map: map ? mapReference : null });
  }
  fixture() {
    if (!this._fixture) this._fixture = JSON.parse(fs.readFileSync(this.fixturePath, 'utf8'));
    return this._fixture;
  }
  config() { return { vision: { provider: 'gemini', model: this.vision.model, configured: this.vision.configured }, reconstruction: { provider: 'fal', model: this.reconstruction.model, configured: this.reconstruction.configured, mode: 'keyframe_batch', units: 'relative' }, frameIntervalMs: 1500, maxFrames: 180 }; }
  start({ mode, filename = '', recording }) {
    if (!['demo', 'video', 'recording'].includes(mode)) throw new VisionError('Choose demo, video or recording.', 400);
    if (mode === 'recording') recording = validateRecording(recording || this.session?.recording);
    else recording = undefined;
    this.controller.abort(); this.controller = new AbortController(); this.busy = null; this.pollBusy = false;
    this.dir = path.join(this.root, id()); fs.mkdirSync(this.dir, { recursive: true });
    this.session = { id: path.basename(this.dir), mode, filename: String(filename).slice(0, 200), createdAt: iso(), lastSeq: 0, lastVideoTime: -1, frames: [], map: null, job: null, events: [], targetId: null, simulatedPose: null };
    this.pipeline = new SpatialPipeline({ dataDir: this.dir });
    for (const e of recording?.entities || ENTITIES) this.pipeline.register(e);
    if (mode === 'recording') {
      this.session.recording = recording; this.session.filename = recording.video.name;
      writeJson(path.join(this.dir, 'recording.json'), recording);
      this.session.map = { id: recording.mapId, source: `dataset:${recording.source.dataset}`, units: recording.coordinateUnits, synthetic: false, reference: true, points: recording.points, poses: [], frameCount: 0, updatedAt: iso() };
      this.pipeline.store.saveMap(this.session.map);
    }
    this.persist(); writeJson(path.join(this.root, 'active.json'), { id: this.session.id });
    return this.state();
  }
  importRecording(body) {
    this.assertSession(body);
    const recording = validateRecording(body.recording), video = body.video;
    if (!video || video.name !== recording.video.name || video.width !== recording.video.width || video.height !== recording.video.height || !Number.isFinite(video.duration) || Math.abs(video.duration - recording.video.duration) > .15) throw new VisionError("The annotation package does not match the video name, dimensions or duration.", 400);
    return this.start({ mode: 'recording', recording });
  }
  assertSession(body) { if (body.sessionId !== this.session.id) throw new VisionError("The session changed. Use the current session.", 409); }
  event(type, text, extra = {}) {
    this.session.events.push({ id: id(), at: iso(), type, text, ...extra });
    this.session.events = this.session.events.slice(-60);
  }
  evidenceUrl(observation) { return observation ? `/api/run/evidence/${this.session.id}/${path.basename(observation.evidence.imagePath)}` : null; }
  state() {
    const snapshot = this.pipeline.store.snapshot();
    const objects = snapshot.entities.map(entity => {
      const q = this.pipeline.store.query({ entityId: entity.id });
      return { ...entity, lastSeen: q.lastSeen, latestCheck: q.latestCheck, evidenceUrl: this.evidenceUrl(q.lastSeen), observationCount: snapshot.observations.filter(o => o.entityId === entity.id).length };
    });
    return {
      session: { id: this.session.id, mode: this.session.mode, filename: this.session.filename, createdAt: this.session.createdAt, lastSeq: this.session.lastSeq, lastVideoTime: this.session.lastVideoTime },
      objects, frameCount: this.session.frames.length, observationCount: snapshot.observations.length, poseCount: snapshot.poses.length,
      map: this.session.map, maps: snapshot.maps, reconstruction: this.session.job,
      recording: this.session.recording ? { source: this.session.recording.source, frameTimes: this.session.recording.frames.map(f => f.videoTime), video: this.session.recording.video } : null,
      events: this.session.events.map(presentEvent), targetId: this.session.targetId, confirmedIds: this.session.confirmedIds || [], guidance: this.guidance(),
      storage: { engine: 'JSON + atomic rename', records: 'spatial-memory.json', evidence: 'evidence/<sha256>.jpg', frames: 'frames/<id>.json', geometry: 'maps/<sha256>.json', mapCount: snapshot.maps.length, durable: true }, busy: Boolean(this.busy),
    };
  }
  async ingest(body) {
    this.assertSession(body);
    if (!Number.isSafeInteger(body.seq) || body.seq <= this.session.lastSeq || !Number.isFinite(body.videoTime) || body.videoTime < 0 || body.videoTime <= this.session.lastVideoTime) throw new VisionError("This frame was already processed or is out of order. Start a new session to replay it.", 409);
    if (this.busy) throw new VisionError("The previous frame is still being processed.", 429);
    if (this.session.frames.length >= 180) throw new VisionError("This session has reached its 180-frame limit. Start a new session.", 409);
    const image = validateFrameImage(body.imageDataUrl);
    const session = this.session, controller = this.controller, pipeline = this.pipeline;
    const token = {}; this.busy = token;
    const started = performance.now();
    try {
      const frame = { id: `f_${body.seq}_${id().slice(0, 8)}`, seq: body.seq, capturedAt: new Date(Date.parse(session.createdAt) + body.videoTime * 1000).toISOString(), videoTime: body.videoTime, source: 'passive', synthetic: session.mode === 'demo', coordinateUnits: session.mode === 'demo' ? 'meters' : 'relative' };
      if (session.mode === 'demo') {
        const fixture = this.fixture();
        const sample = fixture.frames.reduce((best, f) => Math.abs(f.time - body.videoTime) < Math.abs(best.time - body.videoTime) ? f : best, fixture.frames[0]);
        frame.detections = structuredClone(sample.detections);
        frame.pose = { ...sample.pose, id: `pose_${frame.id}`, capturedAt: frame.capturedAt };
        frame.intrinsics = fixture.intrinsics;
      } else if (session.mode === 'recording') {
        const recording = session.recording, sample = recordingFrame(recording, body.videoTime);
        if (session.frames.some(f => f.annotationTime === sample.videoTime)) throw new VisionError("This annotated frame has already been saved. Continue to the next one.", 409);
        frame.annotationTime = sample.videoTime;
        frame.capturedAt = new Date(Date.parse(session.createdAt) + sample.videoTime * 1000).toISOString();
        frame.detections = structuredClone(sample.detections);
        frame.geometrySource = 'dataset_annotations'; frame.coordinateUnits = recording.coordinateUnits;
        frame.pose = { id: `pose_${frame.id}`, mapId: recording.mapId, capturedAt: frame.capturedAt, trackingState: 'tracking', worldFromCamera: sample.worldFromCamera };
      } else {
        frame.detections = (await this.vision.analyze(body.imageDataUrl, pipeline.store.snapshot().entities, { signal: controller.signal })).filter(d => d.status !== 'unclear');
      }
      if (controller.signal.aborted || this.session !== session) throw new VisionError("The previous session ended. Its response was discarded.", 409);
      fs.mkdirSync(path.join(this.dir, 'input'), { recursive: true });
      frame.imagePath = path.join(this.dir, 'input', `${frame.id}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(frame.imagePath, Buffer.from(image.data, 'base64'), { mode: 0o600 });
      let nextMap = null;
      pipeline.transaction(staged => {
        if (frame.detections.length) staged.ingest(frame);
        if (['demo', 'recording'].includes(session.mode)) {
          const geometry = session.mode === 'demo' ? { id: 'demo-room', source: 'synthetic_fixture', units: 'meters', synthetic: true, reference: true, points: this.fixture().points } : session.map;
          nextMap = { ...geometry, poses: [...session.frames.map(f => f.pose), frame.pose], updatedAt: iso(), frameCount: session.frames.length + 1 };
          const saved = staged.store.saveMap({ ...nextMap, capturedAt: frame.capturedAt });
          nextMap.currentRevision = saved.currentRevision;
        }
      });
      // Keep even ambiguous frames for 3D reconstruction without creating sightings.
      session.frames.push(frame); session.lastSeq = body.seq; session.lastVideoTime = body.videoTime;
      if (nextMap) {
        session.map = nextMap;
        if (!session.targetId) session.simulatedPose = frame.pose;
      }
      const seen = frame.detections.filter(d => d.status === 'seen');
      const elapsedMs = Math.round(performance.now() - started);
      this.event('memory', `Frame ${body.seq} · ${seen.length} ${seen.length === 1 ? 'object' : 'objects'} seen · ${frame.pose ? 'position and image saved' : 'image saved; position pending'}`, { videoTime: body.videoTime, elapsedMs, frameId: frame.id });
      this.persist();
      return { accepted: true, elapsedMs, detections: frame.detections, state: this.state() };
    } finally { if (this.busy === token) this.busy = null; }
  }
  register(body) {
    this.assertSession(body);
    if (this.busy) throw new VisionError("Wait for the current frame to finish.", 409);
    if (this.pipeline.store.snapshot().entities.length >= 12) throw new VisionError("This demo can remember up to 12 objects.", 400);
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 60) throw new VisionError("Name the object using 1–60 characters.", 400);
    this.pipeline.register({ id: `item_${id().slice(0, 8)}`, label: body.label.trim(), aliases: [body.label.trim()], priority: 'explicit' });
    this.event('registered', `Now watching for ${body.label.trim()}.`); this.persist(); return this.state();
  }
  query(body) {
    this.assertSession(body);
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 500) throw new VisionError("Enter a question to continue.", 400);
    const text = body.text.toLowerCase().trim();
    const snapshot = this.state(); let message, kind = voiceIntent(text);
    if (['pause', 'resume', 'cancel'].includes(kind)) {
      if (kind === 'cancel') { this.session.targetId = null; this.session.departureActive = false; }
      message = kind === 'pause' ? "Paused. Say “continue” when you are ready." : kind === 'resume' ? "Watching again." : "Search ended.";
      this.event('command', message); this.persist(); return { kind, message, state: this.state() };
    }
    if (kind === 'confirm') {
      const named = snapshot.objects.find(o => [o.label, ...o.aliases].some(a => text.includes(a.toLowerCase())));
      const object = named || snapshot.objects.find(o => o.id === this.session.targetId);
      if (!object) return { kind, message: "Which item? Try “I have my keys.”", state: this.state() };
      this.pipeline.store.addUserReport({ entityId: object.id, capturedAt: iso(), text: "User confirmation: " + body.text });
      this.session.confirmedIds = [...new Set([...(this.session.confirmedIds || []), object.id])];
      const next = this.session.departureActive ? nextChecklistTarget(snapshot.objects, this.session.confirmedIds) : null;
      this.session.targetId = next?.id ?? null; this.session.searchAfterSeq = this.session.lastSeq;
      if (next && this.session.map) this.session.simulatedPose = structuredClone(this.session.map.poses.at(-1));
      message = `${object.label} checked off. ` + (next ? `Next, ${next.label.toLowerCase()}. ${this.guidance()?.instruction || ''}` : this.session.departureActive ? 'Every item on your list is checked off.' : 'All set.');
      this.event('user_confirmed', message); this.persist(); return { kind, message, confirmedBy: 'user_report', checklist: snapshot.objects.filter(o => o.priority === 'explicit').map(o => ({ ...o, confirmedByUser: this.session.confirmedIds.includes(o.id) })), state: this.state() };
    }
    if (kind === 'next') {
      const next = nextChecklistTarget(snapshot.objects, this.session.confirmedIds || []);
      if (!next) return { kind, message: "Every item on your list is checked off.", state: this.state() };
      return this.query({ ...body, text: `Find ${next.label}` });
    }
    if (kind === 'departure') {
      kind = 'departure';
      this.session.departureActive = true; this.session.confirmedIds = [];
      const checklist = snapshot.objects.filter(o => o.priority === 'explicit');
      const next = nextChecklistTarget(snapshot.objects);
      this.session.targetId = next?.id ?? null; this.session.searchAfterSeq = this.session.lastSeq;
      if (next && this.session.map) this.session.simulatedPose = structuredClone(this.session.map.poses.at(-1));
      message = `Before you go: ${checklist.map(o => o.label.toLowerCase()).join(', ')}. ` + (next?.lastSeen ? `Start with ${next.label.toLowerCase()}. ${this.guidance()?.instruction || ''} Say “got it” as you pick each item up.` : 'There are no saved sightings yet. Let the video run first.');
      this.event('query', body.text); this.event('answer', message); this.persist();
      return { kind, message, checklist, state: this.state() };
    }
    const object = snapshot.objects.find(o => [o.label, ...o.aliases].some(alias => text.includes(alias.toLowerCase())));
    this.session.targetId = object?.id ?? null;
    this.session.searchAfterSeq = this.session.lastSeq;
    if (!object) message = "I do not have that item yet. Add it to memory, then keep watching.";
    else if (!object.lastSeen) message = `I have not seen your ${object.label.toLowerCase()} yet. I will keep watching.`;
    else if (!object.lastSeen.position) message = `There is a saved image of your ${object.label.toLowerCase()}, but no position yet. Open the image or build the map.`;
    else {
      const pose = this.session.map?.poses.at(-1);
      if (pose) this.session.simulatedPose = structuredClone(pose);
      message = `I last saw your ${object.label.toLowerCase()} here. ${this.guidance()?.instruction || 'Open the saved image.'}`;
    }
    this.event('query', body.text); this.event('answer', message); this.persist();
    return { kind, message, state: this.state() };
  }
  guidance() {
    if (!this.session.targetId) return null;
    const q = this.pipeline.store.query({ entityId: this.session.targetId });
    const p = this.session.simulatedPose;
    const raw = guideToTarget({ target: q.lastSeen, pose: p });
    const metric = this.session.map?.units === 'meters';
    const direction = raw.status === 'direction';
    const aligned = direction && Math.abs(raw.bearingDeg) < 12 && Math.abs(raw.elevationDeg) < 15;
    const relative = raw.distanceM;
    const observedAgain = Boolean(q.latestCheck?.status === 'seen' && this.session.searchAfterSeq != null && this.session.frames.some(f => f.seq > this.session.searchAfterSeq && f.capturedAt === q.latestCheck.capturedAt));
    let instruction = "No position yet. Keep watching or build the map.";
    if (raw.status === 'relocalize') instruction = "This memory belongs to another map. Look around to locate it again.";
    if (direction) {
      if (Math.abs(raw.bearingDeg) >= 12) instruction = `Turn ${raw.bearingDeg > 0 ? 'right' : 'left'} about ${Math.round(Math.abs(raw.bearingDeg))}°.`;
      else if (Math.abs(raw.elevationDeg) >= 15) instruction = raw.elevationDeg > 0 ? 'A little higher.' : 'A little lower.';
      else instruction = "Straight ahead. That is where you last saw it.";
      if (relative < 0.3) instruction = "You are near the last seen spot. Check for it here.";
    }
    // The interactive pose is a virtual user, not a tracked physical wearer.
    return { ...raw, distanceM: metric ? raw.distanceM : null, distanceRelative: metric ? null : relative, coordinateUnits: metric ? 'meters' : 'relative', instruction, aligned, targetId: q.entity.id, label: q.entity.label, synthetic: this.session.mode === 'demo', simulatedUser: true, videoConfirmed: observedAgain, pulse: { enabled: direction, gain: direction ? clip(0.22 / Math.max(0.2, relative), 0.025, 0.45) : 0, intervalMs: direction ? clip(350 + relative * 220, 400, 1700) : 0 }, haptic: aligned ? [25] : [], confirmed: false, evidenceUrl: this.evidenceUrl(q.lastSeen) };
  }
  move(body) {
    this.assertSession(body);
    if (!['left', 'right', 'forward', 'back', 'up', 'down', 'reset'].includes(body.action)) throw new VisionError('Unknown simulation action.', 400);
    let pose = structuredClone(this.session.simulatedPose || this.session.map?.poses.at(-1));
    if (!pose || !this.session.targetId) throw new VisionError("Choose an item with a saved position first.", 409);
    if (body.action === 'reset') pose = structuredClone(this.session.map.poses.at(-1));
    else {
      const m = pose.worldFromCamera;
      if (['forward', 'back'].includes(body.action)) {
        const step = body.action === 'forward' ? 0.12 : -0.12;
        for (let r = 0; r < 3; r++) m[r * 4 + 3] += m[r * 4 + 2] * step;
      } else {
        const angle = (['right', 'down'].includes(body.action) ? 1 : -1) * 8 * Math.PI / 180;
        const c = Math.cos(angle), s = Math.sin(angle), old = [...m];
        for (let r = 0; r < 3; r++) {
          if (['left', 'right'].includes(body.action)) { m[r * 4] = old[r * 4] * c - old[r * 4 + 2] * s; m[r * 4 + 2] = old[r * 4] * s + old[r * 4 + 2] * c; }
          else { m[r * 4 + 1] = old[r * 4 + 1] * c - old[r * 4 + 2] * s; m[r * 4 + 2] = old[r * 4 + 1] * s + old[r * 4 + 2] * c; }
        }
      }
    }
    pose.id = `sim_${id()}`; pose.capturedAt = iso(); validatePose(pose);
    this.session.simulatedPose = pose; this.persist(); return { guidance: this.guidance(), pose };
  }
  async build(body) {
    this.assertSession(body);
    if (['demo', 'recording'].includes(this.session.mode)) return this.state();
    if (!this.reconstruction.configured) throw new VisionError("Add FAL_KEY on the server to reconstruct real video. Image memory is already available.", 503);
    if (this.session.job && ['submitting', 'IN_QUEUE', 'IN_PROGRESS', 'processing'].includes(this.session.job.status)) throw new VisionError("A reconstruction is already running.", 409);
    const session = this.session, signal = this.controller.signal;
    const available = session.frames.filter(f => f.detections.length);
    if (available.length < 2) throw new VisionError("Capture at least two frames from different viewpoints first.", 400);
    const frames = available.length <= 8 ? available : Array.from({ length: 8 }, (_, i) => available[Math.round(i * (available.length - 1) / 7)]);
    session.job = { status: 'submitting', startedAt: iso(), frameIds: frames.map(f => f.id) }; this.persist();
    try {
      const images = frames.map(f => `data:image/${f.imagePath.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(f.imagePath).toString('base64')}`);
      const requestId = await this.reconstruction.submit(images, { signal });
      if (signal.aborted || this.session !== session) throw new VisionError("The session changed. Try again.", 409);
      session.job = { ...session.job, requestId, status: 'IN_QUEUE' }; this.event('map', `${frames.length} keyframes sent to VGGT. Reconstruction queued.`); this.persist(); return this.state();
    } catch (error) { if (this.session === session) { session.job.status = 'failed'; session.job.error = error.message; this.persist(); } throw error; }
  }
  async poll() {
    const session = this.session, job = session.job, signal = this.controller.signal, pipeline = this.pipeline;
    if (this.pollBusy || !job || !['IN_QUEUE', 'IN_PROGRESS'].includes(job.status)) return this.state();
    this.pollBusy = true;
    try {
      const status = await this.reconstruction.status(job.requestId, { signal });
      if (signal.aborted || this.session !== session) throw new VisionError("The session changed. Try again.", 409);
      if (status.status !== 'COMPLETED') { if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new VisionError("The reconstruction service returned an unknown job status."); job.status = status.status; this.persist(); return this.state(); }
      job.status = 'processing';
      const result = await this.reconstruction.result(job.requestId, { signal });
      const frames = job.frameIds.map(fid => session.frames.find(f => f.id === fid));
      if (result.num_frames !== frames.length || result.prediction_data?.length !== frames.length || result.extrinsics?.length !== frames.length || result.intrinsics?.length !== frames.length) throw new VisionError("The reconstruction does not match the submitted keyframes.");
      const mapId = `vggt_${id()}`;
      const outputs = [];
      for (let i = 0; i < frames.length; i++) {
        const prediction = await this.reconstruction.prediction(result.prediction_data[i].url, { signal });
        outputs.push(reconstructFrame({ frame: frames[i], prediction, extrinsic: result.extrinsics[i], intrinsic: result.intrinsics[i], mapId, id: `p_${mapId}_${i}` }));
      }
      if (signal.aborted || this.session !== session) throw new VisionError("The session changed. Try again.", 409);
      const map = { id: mapId, units: 'relative', synthetic: false, source: 'fal-ai/vggt-1b', points: outputs.flatMap(o => o.points), poses: outputs.map(o => o.pose), frameCount: frames.length, updatedAt: iso() };
      pipeline.transaction(staged => {
        for (let i = 0; i < frames.length; i++) staged.ingest({ ...frames[i], ...outputs[i], id: `r_${mapId}_${i}`, synthetic: false, coordinateUnits: 'relative' });
        const saved = staged.store.saveMap(map); map.currentRevision = saved.currentRevision;
      });
      session.map = map;
      session.simulatedPose = outputs.at(-1).pose;
      // Separate reconstructions have independent coordinates. Never silently
      // merge point clouds or guide to a target from an older coordinate map.
      job.status = 'completed'; job.completedAt = iso();
      this.event('map', `${frames.length} frames reconstructed · ${session.map.points.length} points saved · relative scale.`);
      this.persist(); return this.state();
    } catch (error) {
      if (this.session === session) { job.status = 'failed'; job.error = error.message; this.event('error', `Reconstruction stopped: ${error.message}`); this.persist(); }
      throw error;
    } finally { if (this.session === session) this.pollBusy = false; }
  }
  map(mapId, revisionId) {
    const map = this.pipeline.store.readMap(mapId, { revisionId });
    const at = revisionId ? map.revision.capturedAt : undefined;
    return { ...map, objectsAt: at || null, poses: this.pipeline.store.snapshot().poses.filter(p => p.mapId === mapId && (!at || Date.parse(p.capturedAt) <= Date.parse(at))), objects: this.pipeline.store.search({ mapId, at }) };
  }
  search(body) { this.assertSession(body); return { results: this.pipeline.store.search(body) }; }
  export() {
    const { recording, ...session } = this.session;
    return { schemaVersion: 3, session: { ...session, frames: session.frames.map(({ imagePath, ...f }) => ({ ...f, imagePath: path.relative(this.dir, imagePath) })) }, memory: this.pipeline.store.snapshot(), maps: this.pipeline.store.snapshot().maps.map(m => this.map(m.id)) };
  }
  evidence(sessionId, filename) {
    if (!/^[a-f0-9]{32}$/.test(sessionId) || !/^[a-f0-9]{64}\.(png|jpg)$/.test(filename)) throw new VisionError('Evidence not found.', 404);
    const dir = path.join(this.root, sessionId);
    if (!fs.existsSync(path.join(dir, 'session.json'))) throw new VisionError('Evidence not found.', 404);
    return path.join(dir, 'evidence', filename);
  }
  close() { this.controller.abort(); }
}

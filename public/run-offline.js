// Standalone presentation adapter. Runs only inside the generated preview file.
// It never calls an AI provider or claims to produce real-video detections.
import { guideToTarget, unprojectToWorld } from '../lib/spatial/geometry.mjs';
import { voiceIntent, nextChecklistTarget } from '../lib/voice-intent.mjs';
import { validateRecording, recordingFrame } from '../lib/recording.mjs';

function presentPreviewEvent(event) {
  if (!/[\p{Script=Han}]/u.test(event.text) || event.type === 'query') return event;
  const labels = { memory: 'Frame saved to memory.', map: 'Spatial reconstruction updated.', answer: 'Previous spoken guidance.', command: 'Previous voice command.', registered: 'An object was added to memory.', user_confirmed: 'An item was confirmed by voice.', error: 'A previous request failed. Original details are saved.' };
  return { ...event, originalText: event.text, text: labels[event.type] || event.text };
}

export class OfflineRun {
  constructor(fixture, storage = null) {
    this.fixture = fixture; this.storage = storage; this.counter = 0;
    try { this.data = JSON.parse(storage?.getItem('pocketrecall-preview-v3') || 'null'); } catch { this.data = null; }
    if (!this.data) this.start({ mode: 'demo', filename: "Desk study / synthetic recording" });
    else if (this.data.session.mode !== 'recording') {
      const defaults = { keys: ['钥匙', 'Keys'], wallet: ['钱包', 'Wallet'], earbuds: ['耳机', 'Earbuds'], phone: ['手机', 'Phone'] };
      for (const object of this.data.objects) if (object.label === defaults[object.id]?.[0]) object.label = defaults[object.id][1];
      if (this.data.session.filename === 'PocketRecall · 合成第一视角录像') this.data.session.filename = 'Desk study / synthetic recording';
      this.persist();
    }
  }
  persist() { try { this.storage?.setItem('pocketrecall-preview-v3', JSON.stringify(this.data)); this.saved = Boolean(this.storage); } catch { this.saved = false; } }
  start({ mode = 'demo', filename = '', recording }) {
    if (!['demo', 'video', 'recording'].includes(mode)) throw new Error("Unknown replay mode.");
    const pack = mode === 'recording' ? validateRecording(recording || this.data?.recordingPack) : null;
    this.data = { session: { id: crypto.randomUUID().replaceAll('-', ''), mode, filename: pack?.video.name || filename, createdAt: new Date().toISOString(), lastSeq: 0, lastVideoTime: -1 }, objects: (pack?.entities || [
      { id: 'keys', label: 'Keys', aliases: ['钥匙', 'keys', 'key'], priority: 'explicit' }, { id: 'wallet', label: 'Wallet', aliases: ['钱包', 'wallet'], priority: 'explicit' }, { id: 'earbuds', label: 'Earbuds', aliases: ['耳机', 'earbuds', 'airpods'], priority: 'explicit' }, { id: 'phone', label: 'Phone', aliases: ['手机', 'phone'], priority: 'background' },
    ]).map(o => ({ ...o, lastSeen: null, latestCheck: null, observationCount: 0 })), observations: [], poses: [], events: [], frameCount: 0, map: pack ? { id: pack.mapId, units: pack.coordinateUnits, source: `dataset_annotations:${pack.source.dataset}`, synthetic: false, reference: true, points: pack.points, poses: [], frameCount: 0 } : null, maps: [], targetId: null, simulatedPose: null, recordingPack: pack };
    this.persist(); return this.state();
  }
  event(type, text) { this.data.events.push({ id: String(++this.counter), at: new Date().toISOString(), type, text }); this.data.events = this.data.events.slice(-60); }
  state() { const { observations, recordingPack, ...data } = this.data; return structuredClone({ ...data, events: data.events.map(presentPreviewEvent), recording: recordingPack ? { source: recordingPack.source, frameTimes: recordingPack.frames.map(f => f.videoTime), video: recordingPack.video } : null, observationCount: observations.length, poseCount: this.data.poses.length, guidance: this.guidance(), reconstruction: null, storage: { durable: this.saved, engine: 'browser_localStorage', preview: true } }); }
  guidance() {
    const object = this.data.objects.find(o => o.id === this.data.targetId); if (!object) return null;
    const raw = guideToTarget({ target: object.lastSeen, pose: this.data.simulatedPose });
    const active = raw.status === 'direction', aligned = active && Math.abs(raw.bearingDeg) < 12 && Math.abs(raw.elevationDeg) < 15;
    let instruction = "No position yet. Let the video run first.";
    if (active) instruction = Math.abs(raw.bearingDeg) >= 12 ? `Turn ${raw.bearingDeg > 0 ? 'right' : 'left'} about ${Math.round(Math.abs(raw.bearingDeg))}°.` : Math.abs(raw.elevationDeg) >= 15 ? raw.elevationDeg > 0 ? 'A little higher.' : 'A little lower.' : 'Straight ahead. That is where you last saw it.';
    if (active && raw.distanceM < .3) instruction = "You are near the last seen spot. Check for it here.";
    const metric = this.data.map?.units === 'meters';
    return { ...raw, distanceM: metric ? raw.distanceM : null, distanceRelative: metric ? null : raw.distanceM, label: object.label, targetId: object.id, aligned, instruction, synthetic: this.data.session.mode === 'demo', simulatedUser: true, coordinateUnits: metric ? 'meters' : 'relative', confirmed: false, videoConfirmed: Boolean(object.latestCheck?.status === 'seen' && this.data.searchAfterSeq != null && object.latestCheck.frameId !== this.data.searchAfterFrameId && this.data.session.lastSeq > this.data.searchAfterSeq), pulse: { enabled: active, gain: active ? Math.max(.025, Math.min(.45, .22 / Math.max(.2, raw.distanceM))) : 0, intervalMs: active ? Math.max(400, Math.min(1700, 350 + raw.distanceM * 220)) : 0 }, haptic: aligned ? [25] : [] };
  }
  async frame(body) {
    const session = this.data;
    const recorded = this.data.session.mode === 'recording', pack = this.data.recordingPack;
    if (!recorded && this.data.session.mode !== 'demo') throw new Error("This preview supports synthetic recordings and imported annotations. Run the local server for real video recognition.");
    if (!Number.isFinite(body.videoTime) || !Number.isSafeInteger(body.seq) || body.videoTime < 0 || body.videoTime <= this.data.session.lastVideoTime || body.seq <= this.data.session.lastSeq) throw Object.assign(new Error("This frame was already processed or is invalid."), { status: 409 });
    if (this.data.frameCount >= 180) throw new Error("This preview has reached its 180-frame limit. Start a new replay.");
    const sample = recorded ? recordingFrame(pack, body.videoTime) : this.fixture.frames.reduce((a, b) => Math.abs(a.time - body.videoTime) < Math.abs(b.time - body.videoTime) ? a : b);
    if (recorded && (this.data.annotationTimes || []).includes(sample.videoTime)) throw Object.assign(new Error("This annotated frame has already been saved."), { status: 409 });
    const capturedAt = new Date(Date.parse(this.data.session.createdAt) + (recorded ? sample.videoTime : body.videoTime) * 1000).toISOString();
    const pose = { ...(recorded ? { worldFromCamera: sample.worldFromCamera, trackingState: 'tracking', mapId: pack.mapId } : sample.pose), id: `preview_pose_${body.seq}`, capturedAt };
    const bytes = Uint8Array.from(atob(body.imageDataUrl.split(',')[1]), c => c.charCodeAt(0));
    const hash = crypto.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('') : null;
    if (session !== this.data) throw Object.assign(new Error("The session changed. The previous frame was discarded."), { status: 409 });
    const imagePath = `browser:${hash || `frame-${body.seq}`}`;
    this.data.evidence ||= {};
    this.data.evidence[imagePath] = { sha256: hash, dataUrl: body.imageDataUrl };
    this.data.poses.push(pose);
    for (const detection of sample.detections) {
      const object = this.data.objects.find(o => o.id === detection.entityId); if (!object) continue;
      const b = detection.bbox;
      const position = detection.status === 'seen' ? recorded ? [...detection.worldPosition] : unprojectToWorld({ pixel: [(b[0] + b[2]) / 2 * 518, (b[1] + b[3]) / 2 * 518], depthM: detection.depthM, intrinsics: this.fixture.intrinsics, pose }) : null;
      const record = { id: `preview_${body.seq}_${object.id}`, entityId: object.id, capturedAt, frameId: `preview_${body.seq}`, source: 'passive', status: detection.status, position, coordinateUnits: recorded ? pack.coordinateUnits : 'meters', mapId: pose.mapId, method: position ? recorded ? 'annotation' : 'depth' : 'unlocalized', poseRef: pose.id, evidence: { imagePath, crop: b ?? null, synthetic: !recorded, sha256: hash }, semantics: detection.semantics };
      object.latestCheck = record; object.observationCount++; this.data.observations.push(record);
      if (detection.status === 'seen') { object.lastSeen = record; object.evidenceUrl = body.imageDataUrl; }
    }
    if (recorded) { this.data.annotationTimes ||= []; this.data.annotationTimes.push(sample.videoTime); }
    this.data.frameCount++; this.data.session.lastSeq = body.seq; this.data.session.lastVideoTime = body.videoTime;
    this.data.map = { id: recorded ? pack.mapId : 'demo-room', source: recorded ? `dataset:${pack.source.dataset}` : 'synthetic_fixture', synthetic: !recorded, reference: true, units: recorded ? pack.coordinateUnits : 'meters', points: recorded ? pack.points : this.fixture.points, poses: this.data.poses, frameCount: this.data.frameCount };
    if (!this.data.maps?.length) {
      const bytes = new TextEncoder().encode(JSON.stringify(this.data.map.points));
      const geometryHash = crypto.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('') : null;
      if (session !== this.data) throw Object.assign(new Error("The session changed. The previous frame was discarded."), { status: 409 });
      const { id, units, source, synthetic, reference } = this.data.map;
      this.data.maps = [{ id, units, source, synthetic, reference, currentRevision: geometryHash, revisions: [{ id: geometryHash, sha256: geometryHash, pointCount: this.data.map.points.length, capturedAt, geometryPath: 'browser:map' }] }];
    }
    if (!this.data.targetId) this.data.simulatedPose = pose;
    this.event('memory', `Frame ${body.seq} · ${sample.detections.filter(d => d.status === 'seen').length} objects seen · ${recorded ? 'annotated' : 'synthetic'} positions and images saved.`);
    this.persist(); return { accepted: true, elapsedMs: 0, detections: sample.detections, state: this.state() };
  }
  query(body) {
    const text = body.text.toLowerCase(); let message; const kind = voiceIntent(text);
    if (['pause', 'resume', 'cancel'].includes(kind)) { if (kind === 'cancel') { this.data.targetId = null; this.data.departureActive = false; } message = kind === 'pause' ? "Paused. Say “continue” when you are ready." : kind === 'resume' ? "Watching again." : "Search ended."; this.persist(); return { kind, message, state: this.state() }; }
    if (kind === 'confirm') {
      const object = this.data.objects.find(o => [o.label, ...o.aliases].some(a => text.includes(a.toLowerCase()))) || this.data.objects.find(o => o.id === this.data.targetId);
      if (!object) return { kind, message: "Which item did you pick up?", state: this.state() };
      this.data.confirmedIds = [...new Set([...(this.data.confirmedIds || []), object.id])];
      this.data.userReports ||= []; this.data.userReports.push({ entityId: object.id, source: 'user_report', text: body.text, capturedAt: new Date().toISOString() });
      const next = this.data.departureActive ? nextChecklistTarget(this.data.objects, this.data.confirmedIds) : null;
      this.data.targetId = next?.id ?? null; this.data.searchAfterSeq = this.data.session.lastSeq;
      this.data.searchAfterFrameId = next?.latestCheck?.frameId ?? null;
      if (next) this.data.simulatedPose = structuredClone(this.data.poses.at(-1));
      message = `${object.label} checked off. ` + (next ? `Next, ${next.label.toLowerCase()}. ${this.guidance()?.instruction || ''}` : this.data.departureActive ? 'Every item on your list is checked off.' : 'All set.');
      this.event('user_confirmed', message); this.persist(); return { kind, message, confirmedBy: 'user_report', checklist: this.data.departureActive ? this.data.objects.filter(o => o.priority === 'explicit').map(o => ({ ...o, confirmedByUser: this.data.confirmedIds.includes(o.id) })) : undefined, state: this.state() };
    }
    if (kind === 'next') { const next = nextChecklistTarget(this.data.objects, this.data.confirmedIds || []); return next ? this.query({ ...body, text: `Find ${next.label}` }) : { message: 'Every item on your list is checked off.', state: this.state() }; }
    if (kind === 'departure') { this.data.departureActive = true; this.data.confirmedIds = []; const checklist = this.data.objects.filter(o => o.priority === 'explicit'); const next = nextChecklistTarget(this.data.objects); this.data.targetId = next?.id ?? null; this.data.searchAfterSeq = this.data.session.lastSeq; this.data.searchAfterFrameId = next?.latestCheck?.frameId ?? null; this.data.simulatedPose = structuredClone(this.data.poses.at(-1)); message = `Before you go: ${checklist.map(o => o.label.toLowerCase()).join(', ')}. ` + (next?.lastSeen ? `Start with ${next.label.toLowerCase()}. ${this.guidance()?.instruction || ''} Say “got it” as you pick each item up.` : 'There are no saved sightings yet. Let the video run first.'); this.event('query', text); this.persist(); return { kind: 'departure', checklist, message, state: this.state() }; }
    const object = this.data.objects.find(o => [o.label, ...o.aliases].some(a => text.includes(a.toLowerCase())));
    this.data.targetId = object?.id ?? null;
    this.data.searchAfterSeq = this.data.session.lastSeq;
    this.data.searchAfterFrameId = object?.latestCheck?.frameId ?? null;
    if (!object) message = "I do not have that item in memory yet.";
    else if (!object.lastSeen) message = `I have not seen your ${object.label.toLowerCase()} yet.`;
    else { this.data.simulatedPose = structuredClone(this.data.poses.at(-1)); message = `I last saw your ${object.label.toLowerCase()} here. ${this.guidance().instruction}`; }
    this.event('query', body.text); this.event('answer', message); this.persist(); return { kind, message, state: this.state() };
  }
  move({ action }) {
    let pose = structuredClone(this.data.simulatedPose); if (!pose) throw new Error("Choose an item to find first.");
    if (action === 'reset') pose = structuredClone(this.data.poses.at(-1));
    else {
      const m = pose.worldFromCamera;
      if (['forward', 'back'].includes(action)) for (let i = 0; i < 3; i++) m[i * 4 + 3] += m[i * 4 + 2] * (action === 'forward' ? .12 : -.12);
      else {
        const angle = (['right', 'down'].includes(action) ? 1 : -1) * 8 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle), a = [...m];
        for (let i = 0; i < 3; i++) if (['left', 'right'].includes(action)) { m[i * 4] = a[i * 4] * c - a[i * 4 + 2] * s; m[i * 4 + 2] = a[i * 4] * s + a[i * 4 + 2] * c; } else { m[i * 4 + 1] = a[i * 4 + 1] * c - a[i * 4 + 2] * s; m[i * 4 + 2] = a[i * 4 + 1] * s + a[i * 4 + 2] * c; }
      }
    }
    this.data.simulatedPose = pose; this.persist(); return { guidance: this.guidance(), pose };
  }
  async request(route, body) {
    if (route === 'config') return { vision: { configured: false, provider: 'offline_preview', model: "Synthetic observations; no API calls" }, reconstruction: { configured: false, model: "Known synthetic geometry" }, frameIntervalMs: 1500, preview: true };
    if (route === 'state' || route === 'reconstruction') return this.state();
    if (route === 'session') return this.start(body);
    if (body?.sessionId !== this.data.session.id && route !== 'export') throw new Error("The session changed. Try again.");
    if (route === 'recording') {
      const pack = validateRecording(body.recording), video = body.video;
      if (!video || video.name !== pack.video.name || video.width !== pack.video.width || video.height !== pack.video.height || !Number.isFinite(video.duration) || Math.abs(video.duration - pack.video.duration) > .15) throw new Error("The annotation package does not match the uploaded video name, dimensions or duration.");
      return this.start({ mode: 'recording', recording: pack });
    }
    if (route === 'frame') return this.frame(body);
    if (route === 'query') return this.query(body);
    if (route === 'move') return this.move(body);
    if (route === 'register') {
      if (!body.label?.trim() || body.label.length > 60 || this.data.objects.length >= 12) throw new Error("Use a name up to 60 characters. This demo supports 12 objects.");
      this.data.objects.push({ id: `custom_${Date.now()}`, label: body.label.trim(), aliases: [body.label.trim()], priority: 'explicit', lastSeen: null, observationCount: 0 }); this.persist(); return this.state();
    }
    if (route === 'export') {
      const { recordingPack, ...session } = this.data;
      return { schemaVersion: 3, preview: true, session, memory: { entities: this.data.objects.map(({ lastSeen, latestCheck, evidenceUrl, ...o }) => o), observations: this.data.observations, poses: this.data.poses, maps: this.data.maps || [], userReports: this.data.userReports || [] } };
    }
    throw new Error("Run the local server to use real video recognition and VGGT.");
  }
}

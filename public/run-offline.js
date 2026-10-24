// Standalone presentation adapter. Runs only inside the generated preview file.
// It never calls an AI provider or claims to produce real-video detections.
import { guideToTarget, unprojectToWorld } from '../lib/spatial/geometry.mjs';

export class OfflineRun {
  constructor(fixture, storage = null) {
    this.fixture = fixture; this.storage = storage; this.counter = 0;
    try { this.data = JSON.parse(storage?.getItem('pocketrecall-preview-v3') || 'null'); } catch { this.data = null; }
    if (!this.data) this.start({ mode: 'demo', filename: 'PocketRecall · 合成第一视角录像' });
  }
  persist() { try { this.storage?.setItem('pocketrecall-preview-v3', JSON.stringify(this.data)); this.saved = Boolean(this.storage); } catch { this.saved = false; } }
  start({ mode = 'demo', filename = '' }) {
    this.data = { session: { id: crypto.randomUUID().replaceAll('-', ''), mode, filename, createdAt: new Date().toISOString(), lastSeq: 0, lastVideoTime: -1 }, objects: [
      { id: 'keys', label: '钥匙', aliases: ['钥匙', 'keys', 'key'], priority: 'explicit' }, { id: 'wallet', label: '钱包', aliases: ['钱包', 'wallet'], priority: 'explicit' }, { id: 'earbuds', label: '耳机', aliases: ['耳机', 'earbuds', 'airpods'], priority: 'explicit' }, { id: 'phone', label: '手机', aliases: ['手机', 'phone'], priority: 'background' },
    ].map(o => ({ ...o, lastSeen: null, latestCheck: null, observationCount: 0 })), observations: [], poses: [], events: [], frameCount: 0, map: null, targetId: null, simulatedPose: null };
    this.persist(); return this.state();
  }
  event(type, text) { this.data.events.push({ id: String(++this.counter), at: new Date().toISOString(), type, text }); this.data.events = this.data.events.slice(-60); }
  state() { return structuredClone({ ...this.data, observations: undefined, observationCount: this.data.observations.length, poseCount: this.data.poses.length, guidance: this.guidance(), reconstruction: null, storage: { durable: this.saved, engine: 'browser_localStorage', preview: true } }); }
  guidance() {
    const object = this.data.objects.find(o => o.id === this.data.targetId); if (!object) return null;
    const raw = guideToTarget({ target: object.lastSeen, pose: this.data.simulatedPose });
    const active = raw.status === 'direction', aligned = active && Math.abs(raw.bearingDeg) < 12 && Math.abs(raw.elevationDeg) < 15;
    let instruction = '还没有可用空间位置，请先观察视频。';
    if (active) instruction = Math.abs(raw.bearingDeg) >= 12 ? `向${raw.bearingDeg > 0 ? '右' : '左'}转动视角约 ${Math.round(Math.abs(raw.bearingDeg))}°。` : Math.abs(raw.elevationDeg) >= 15 ? `稍微${raw.elevationDeg > 0 ? '抬头' : '低头'}。` : '方向正确，目标最后出现的位置就在前方。';
    if (active && raw.distanceM < .3) instruction = '已接近记忆位置，请查看图像并确认物体。';
    return { ...raw, label: object.label, targetId: object.id, aligned, instruction, synthetic: true, simulatedUser: true, coordinateUnits: 'meters', confirmed: false, videoConfirmed: Boolean(object.latestCheck?.status === 'seen' && this.data.searchAfterSeq != null && this.data.session.lastSeq > this.data.searchAfterSeq), pulse: { enabled: active, gain: active ? Math.max(.025, Math.min(.45, .22 / Math.max(.2, raw.distanceM))) : 0, intervalMs: active ? Math.max(400, Math.min(1700, 350 + raw.distanceM * 220)) : 0 }, haptic: aligned ? [25] : [] };
  }
  async frame(body) {
    const session = this.data;
    if (this.data.session.mode !== 'demo') throw new Error('离线预览只处理合成录像。真实视频请运行项目服务后打开 /run。');
    if (body.videoTime <= this.data.session.lastVideoTime || body.seq <= this.data.session.lastSeq) throw Object.assign(new Error('跳过已处理的视频帧。'), { status: 409 });
    if (this.data.frameCount >= 40) throw new Error('离线预览最多保存 40 个抽样帧，请重新分析。');
    const sample = this.fixture.frames.reduce((a, b) => Math.abs(a.time - body.videoTime) < Math.abs(b.time - body.videoTime) ? a : b);
    const capturedAt = new Date(Date.parse(this.data.session.createdAt) + body.videoTime * 1000).toISOString();
    const pose = { ...sample.pose, id: `preview_pose_${body.seq}`, capturedAt }; this.data.poses.push(pose);
    const bytes = Uint8Array.from(atob(body.imageDataUrl.split(',')[1]), c => c.charCodeAt(0));
    const hash = crypto.subtle ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('') : null;
    if (session !== this.data) throw Object.assign(new Error('会话已切换，丢弃旧帧。'), { status: 409 });
    for (const detection of sample.detections) {
      const object = this.data.objects.find(o => o.id === detection.entityId); if (!object) continue;
      const b = detection.bbox;
      const position = detection.status === 'seen' ? unprojectToWorld({ pixel: [(b[0] + b[2]) / 2 * 518, (b[1] + b[3]) / 2 * 518], depthM: detection.depthM, intrinsics: this.fixture.intrinsics, pose }) : null;
      const record = { id: `preview_${body.seq}_${object.id}`, entityId: object.id, capturedAt, frameId: `preview_${body.seq}`, source: 'passive', status: detection.status, position, coordinateUnits: 'meters', mapId: 'demo-room', method: position ? 'depth' : 'unlocalized', poseRef: pose.id, evidence: { imagePath: `browser:frame-${body.seq}`, crop: b, synthetic: true, sha256: hash }, semantics: detection.semantics };
      object.latestCheck = record; object.observationCount++; this.data.observations.push(record);
      if (detection.status === 'seen') { object.lastSeen = record; object.evidenceUrl = body.imageDataUrl; }
    }
    this.data.frameCount++; this.data.session.lastSeq = body.seq; this.data.session.lastVideoTime = body.videoTime;
    this.data.map = { id: 'demo-room', source: 'synthetic_fixture', synthetic: true, units: 'meters', points: this.fixture.points, poses: this.data.poses, frameCount: this.data.frameCount };
    if (!this.data.targetId) this.data.simulatedPose = pose;
    this.event('memory', `帧 ${body.seq} → ${sample.detections.filter(d => d.status === 'seen').length} 个可见道具 → 合成坐标与证据已存储`);
    this.persist(); return { accepted: true, elapsedMs: 0, detections: sample.detections, state: this.state() };
  }
  query(body) {
    const text = body.text.toLowerCase(); let message;
    if (/出发|出门|leav/.test(text)) { const checklist = this.data.objects.filter(o => o.priority === 'explicit'); message = checklist.map(o => `${o.label}：${o.lastSeen ? '有最后出现的图像' : '尚未看到'}`).join('；') + '。请逐件确认已携带。'; this.event('query', text); this.persist(); return { kind: 'departure', checklist, message, state: this.state() }; }
    const object = this.data.objects.find(o => o.aliases.some(a => text.includes(a)));
    this.data.targetId = object?.id ?? null;
    this.data.searchAfterSeq = this.data.session.lastSeq;
    if (!object) message = '尚未记住这个物体。';
    else if (!object.lastSeen) message = `还没有看到${object.label}。`;
    else { this.data.simulatedPose = structuredClone(this.data.poses.at(-1)); message = `找到${object.label}的记忆了。${this.guidance().instruction}`; }
    this.event('query', body.text); this.event('answer', message); this.persist(); return { message, state: this.state() };
  }
  move({ action }) {
    let pose = structuredClone(this.data.simulatedPose); if (!pose) throw new Error('请先选择一个目标。');
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
    if (route === 'config') return { vision: { configured: false, provider: 'offline_preview', model: '合成检测；无 API 调用' }, reconstruction: { configured: false, model: '合成已知几何' }, frameIntervalMs: 1500, preview: true };
    if (route === 'state' || route === 'reconstruction') return this.state();
    if (route === 'session') return this.start(body);
    if (body?.sessionId !== this.data.session.id && route !== 'export') throw new Error('会话已切换。');
    if (route === 'frame') return this.frame(body);
    if (route === 'query') return this.query(body);
    if (route === 'move') return this.move(body);
    if (route === 'register') {
      if (!body.label?.trim() || body.label.length > 60 || this.data.objects.length >= 12) throw new Error('物体名称无效，或已到 12 类物体上限。');
      this.data.objects.push({ id: `custom_${Date.now()}`, label: body.label.trim(), aliases: [body.label.trim()], priority: 'explicit', lastSeen: null, observationCount: 0 }); this.persist(); return this.state();
    }
    if (route === 'export') return { schemaVersion: 3, preview: true, session: this.data, memory: { entities: this.data.objects.map(({ lastSeen, latestCheck, evidenceUrl, ...o }) => o), observations: this.data.observations, poses: this.data.poses } };
    throw new Error('这是离线交互预览。真实视频识别和 VGGT 请运行项目服务。');
  }
}

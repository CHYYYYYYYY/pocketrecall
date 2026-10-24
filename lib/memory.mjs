import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const OBJECTS = [
  { id: 'keys', name: 'Keys', description: 'Keys with a blue keyring', color: '#e7aa51' },
  { id: 'wallet', name: 'Wallet', description: 'A dark folded wallet', color: '#748b9b' },
  { id: 'earbuds', name: 'Earbuds', description: 'A white wireless earbud case', color: '#a8af99' },
];
const IDS = OBJECTS.map(o => o.id);
const STATUSES = ['seen', 'not_seen', 'unclear'];
const POSITION_CHANGE = 0.035;
const copy = value => structuredClone(value);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function freshState(mode = 'demo', generation = 0) {
  return {
    session: { id: randomUUID(), generation, mode, observerState: 'observing', startedAt: new Date().toISOString() },
    objects: OBJECTS.map(o => ({ ...o, lastSeen: null, latestCheck: null })),
    observations: [], events: [], calibration: null,
    lastProcessedSeq: -1, lastProcessedCapturedAt: null,
  };
}

function solve(matrix, vector) {
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let c = 0; c < vector.length; c++) {
    let pivot = c;
    for (let r = c + 1; r < a.length; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-10) throw new Error('Calibration points are degenerate. Use the four corners of the desk.');
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const divisor = a[c][c];
    a[c] = a[c].map(v => v / divisor);
    for (let r = 0; r < a.length; r++) {
      if (r === c) continue;
      const factor = a[r][c];
      a[r] = a[r].map((v, j) => v - factor * a[c][j]);
    }
  }
  return a.map(row => row.at(-1));
}

export function homographyFor(points) {
  if (!Array.isArray(points) || points.length !== 4 || points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) {
    throw new Error('Calibration requires four normalized {x,y} points ordered top-left, top-right, bottom-right, bottom-left.');
  }
  const cross = points.map((p, i) => {
    const q = points[(i + 1) % 4], r = points[(i + 2) % 4];
    return (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
  });
  if (cross.some(v => v <= 1e-5)) throw new Error('Calibration corners must form a clockwise, non-crossing quadrilateral.');
  const matrix = [], vector = [];
  const target = [[0, 0], [1, 0], [1, 1], [0, 1]];
  points.forEach(({ x, y }, i) => {
    const [u, v] = target[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]); vector.push(v);
  });
  return [...solve(matrix, vector), 1];
}

export function projectPoint(point, matrix) {
  const { x, y } = point;
  const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  if (Math.abs(denominator) < 1e-9) throw new Error('Point cannot be projected to the desk.');
  return { x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator, y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator };
}

function validateItems(items) {
  if (!items || typeof items !== 'object' || Array.isArray(items) || Object.keys(items).length !== 3 || IDS.some(id => !Object.hasOwn(items, id))) {
    throw new Error('Observation must contain exactly keys, wallet, and earbuds.');
  }
  for (const id of IDS) {
    const item = items[id];
    if (!item || !STATUSES.includes(item.status)) throw new Error(`Invalid observation status for ${id}.`);
    if (item.status === 'seen') {
      const b = item.bbox;
      if (!Array.isArray(b) || b.length !== 4 || b.some(n => !Number.isFinite(n) || n < 0 || n > 1) || b[0] >= b[2] || b[1] >= b[3]) {
        throw new Error(`Invalid normalized bounding box for ${id}.`);
      }
    } else if (item.bbox != null) throw new Error(`Unseen ${id} cannot have a bounding box.`);
  }
}

function decodeEvidence(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 8_000_000) throw new Error('Evidence must be a PNG/JPEG data URL under 6 MB.');
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error('Evidence must be a PNG/JPEG base64 data URL.');
  const bytes = Buffer.from(match[2], 'base64');
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!(match[1] === 'png' ? png : jpeg)) throw new Error('Evidence content does not match its image type.');
  return { bytes, extension: match[1] === 'png' ? 'png' : 'jpg' };
}

function relativeAge(timestamp, chinese) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  if (seconds < 60) return chinese ? `${seconds} 秒前` : `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return chinese ? `${minutes} 分钟前` : `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  return chinese ? new Date(timestamp).toLocaleTimeString('zh-CN') : `at ${new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function describePosition(p, chinese, deskCoordinates) {
  const side = p.x < 1 / 3 ? (chinese ? '左侧' : 'left') : p.x > 2 / 3 ? (chinese ? '右侧' : 'right') : (chinese ? '中间' : 'center');
  if (!deskCoordinates) {
    const vertical = p.y < 1 / 3 ? (chinese ? '上方' : 'upper') : p.y > 2 / 3 ? (chinese ? '下方' : 'lower') : (chinese ? '' : 'middle');
    return chinese ? `摄像头画面的${vertical}${side}` : `the ${vertical} ${side} of the camera view`;
  }
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return chinese ? '标定桌面区域以外的画面位置' : 'an image position outside the calibrated desk region';
  const depth = p.y < 1 / 3 ? (chinese ? '远端' : 'far') : p.y > 2 / 3 ? (chinese ? '近端' : 'near') : (chinese ? '' : 'middle');
  return chinese ? `桌面${depth}${side}` : `the ${depth} ${side} of the desk`;
}

/** Small durable, evidence-backed store. State transitions commit atomically. */
export class MemoryStore {
  constructor({ dataDir = path.resolve('.pocketrecall') } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.evidenceDir = path.join(this.dataDir, 'evidence');
    this.statePath = path.join(this.dataDir, 'memory.json');
    fs.mkdirSync(this.evidenceDir, { recursive: true });
    this.context = { objectId: null, observationId: null };
    if (fs.existsSync(this.statePath)) {
      const saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (saved.schemaVersion !== 1 || !saved.state?.session?.id || !Array.isArray(saved.state.objects)) throw new Error('Unsupported or damaged memory file. Preserve it and start with a different data directory.');
      this.state = saved.state;
      // A restarted process has not established a camera stream yet.
      this.state.session.observerState = 'paused';
      this.state.session.generation++;
      this._commit(this.state);
    } else this._commit(freshState());
  }

  getState() { return copy(this.state); }

  _commit(next) {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, state: next }), { mode: 0o600 });
      fs.renameSync(temporary, this.statePath);
    } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
    this.state = next;
    this._collectEvidence();
    return this.getState();
  }

  _collectEvidence() {
    const retained = new Set([
      ...this.state.observations.map(o => o.evidenceId),
      ...this.state.events.map(e => e.evidenceId),
      ...this.state.objects.map(o => o.lastSeen?.evidenceId),
    ].filter(Boolean));
    let files;
    try { files = fs.readdirSync(this.evidenceDir); } catch { return; }
    for (const name of files) {
      if (/^[0-9a-f-]+\.(png|jpg)$/.test(name) && !retained.has(name)) {
        try { fs.unlinkSync(path.join(this.evidenceDir, name)); } catch { /* Deletion can retry on the next commit. */ }
      }
    }
  }

  startSession({ mode = 'demo' } = {}) {
    if (!['demo', 'live'].includes(mode)) throw new Error('Mode must be demo or live.');
    this.context = { objectId: null, observationId: null };
    return this._commit(freshState(mode, (this.state?.session.generation ?? -1) + 1));
  }

  setCalibration(points) {
    if (points != null && !Array.isArray(points)) throw new Error('Calibration requires an array of four points.');
    const normalized = points == null ? [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] : points.map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : p);
    const matrix = homographyFor(normalized);
    const next = copy(this.state);
    next.calibration = points == null ? null : { id: randomUUID(), points: normalized, matrix, createdAt: new Date().toISOString() };
    next.session.generation++;
    // Reproject historical observations from their source image coordinates;
    // calibration is valid only for this fixed view, never for a moved camera.
    for (const observation of next.observations) {
      if (observation.bbox) {
        const b = observation.bbox;
        observation.position = projectPoint({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 }, matrix);
        observation.calibrationId = next.calibration?.id ?? null;
      }
    }
    for (const object of next.objects) {
      if (object.lastSeen) {
        const b = object.lastSeen.bbox;
        object.lastSeen.position = projectPoint({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 }, matrix);
        object.lastSeen.calibrationId = next.calibration?.id ?? null;
      }
    }
    // Event positions depend on the old view; preserve their observation references
    // and regenerate endpoints where the supporting records remain available.
    for (const event of next.events) {
      const to = next.observations.find(o => o.id === event.observationId);
      const from = next.observations.find(o => o.id === event.fromObservationId);
      if (to?.position) event.to = to.position;
      if (from?.position) event.from = from.position;
    }
    return this._commit(next);
  }

  control(action) {
    if (action === 'clear') return this.startSession({ mode: this.state.session.mode });
    const next = copy(this.state);
    if (action === 'pause') next.session.observerState = 'paused';
    else if (action === 'resume') next.session.observerState = 'observing';
    else if (action === 'interrupted') next.session.observerState = 'interrupted';
    else throw new Error('Unknown control action.');
    next.session.generation++;
    return this._commit(next);
  }

  applyObservation({ sessionId, generation, seq, capturedAt, items, evidenceDataUrl, source } = {}) {
    const reject = reason => ({ accepted: false, reason, state: this.getState() });
    if (sessionId !== this.state.session.id || generation !== this.state.session.generation) return reject('stale_session');
    if (this.state.session.observerState === 'paused') return reject('paused');
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Observation sequence must be a non-negative integer.');
    if (seq <= this.state.lastProcessedSeq) return reject('stale_sequence');
    if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) throw new Error('Observation requires a valid capture timestamp.');
    if (this.state.lastProcessedCapturedAt && Date.parse(capturedAt) < Date.parse(this.state.lastProcessedCapturedAt)) return reject('stale_capture');
    if (source && source !== this.state.session.mode && !(source === 'camera' && this.state.session.mode === 'live')) throw new Error('Observation source does not match the session mode.');
    validateItems(items);
    const evidence = decodeEvidence(evidenceDataUrl);
    const evidenceId = `${randomUUID()}.${evidence.extension}`;
    const evidenceFile = path.join(this.evidenceDir, evidenceId);
    fs.writeFileSync(evidenceFile, evidence.bytes, { mode: 0o600 });
    const next = copy(this.state);
    try {
      for (const object of next.objects) {
        const item = items[object.id];
        const b = item.status === 'seen' ? [...item.bbox] : null;
        let position = b ? { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 } : null;
        if (position && next.calibration) position = projectPoint(position, next.calibration.matrix);
        const observation = { id: randomUUID(), objectId: object.id, capturedAt, seq, status: item.status, bbox: b, position, evidenceId, source: next.session.mode, calibrationId: next.calibration?.id ?? null };
        next.observations.push(observation);
        const old = object.lastSeen;
        let eventType = null;
        if (item.status === 'seen') {
          eventType = !old ? 'first_seen' : distance(old.position, position) > POSITION_CHANGE ? 'position_changed' : object.latestCheck?.status !== 'seen' ? 'reappeared' : null;
          object.lastSeen = copy(observation);
        } else if (item.status === 'not_seen' && object.latestCheck?.status === 'seen') eventType = 'not_seen';
        if (eventType) next.events.push({ id: randomUUID(), type: eventType, objectId: object.id, capturedAt, from: old?.position ?? null, to: position, fromObservationId: old?.id ?? null, observationId: observation.id, evidenceId, source: next.session.mode });
        object.latestCheck = { status: item.status, capturedAt, seq, observationId: observation.id };
      }
      next.events = next.events.slice(-100);
      // Retain event evidence and their records when feasible; cap total records.
      let keepIds = new Set(next.events.flatMap(e => [e.observationId, e.fromObservationId]).filter(Boolean));
      // Reserve three slots for the last-confirmed observation of every object.
      // Trim the oldest event rather than leaving a retained event with missing provenance.
      while (keepIds.size > 197) {
        next.events.shift();
        keepIds = new Set(next.events.flatMap(e => [e.observationId, e.fromObservationId]).filter(Boolean));
      }
      for (const object of next.objects) if (object.lastSeen) keepIds.add(object.lastSeen.id);
      const retained = next.observations.filter(o => keepIds.has(o.id));
      const trailingCount = Math.max(0, 200 - retained.length);
      const trailing = trailingCount ? next.observations.filter(o => !keepIds.has(o.id)).slice(-trailingCount) : [];
      next.observations = [...retained, ...trailing].sort((a, b) => a.seq - b.seq).slice(-200);
      next.lastProcessedSeq = seq;
      next.lastProcessedCapturedAt = capturedAt;
      next.session.observerState = 'observing';
      this._commit(next);
      return { accepted: true, state: this.getState() };
    } catch (error) { try { fs.unlinkSync(evidenceFile); } catch {} throw error; }
  }

  evidencePath(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}\.(png|jpg)$/.test(id)) return null;
    const candidate = path.join(this.evidenceDir, id);
    return fs.existsSync(candidate) ? candidate : null;
  }

  query(text) {
    if (typeof text !== 'string' || !text.trim()) return { answer: 'I did not catch that. Which item are you looking for?', kind: 'not_understood', objectId: null, observationId: null, evidenceId: null, position: null };
    const q = text.toLowerCase().trim();
    const chinese = /[\u3400-\u9fff]/.test(q);
    const empty = { objectId: null, observationId: null, evidenceId: null, position: null };
    let action = /\b(pause|stop observing)\b|暂停观察|暂停/.test(q) ? 'pause' : /\b(resume|continue observing)\b|继续观察|恢复观察/.test(q) ? 'resume' : /\b(clear|forget everything|reset memory)\b|清空|清除记忆/.test(q) ? 'clear' : null;
    if (action) {
      this.control(action);
      const replies = { pause: ['Observation paused. You can still ask about saved memories.', '已暂停观察，你仍然可以查询已有记忆。'], resume: ['Observation resumed.', '已继续观察。'], clear: ['Session memory cleared.', '已清空本次会话记忆。'] };
      return { ...empty, answer: replies[action][chinese ? 1 : 0], kind: 'control', action };
    }
    const aliases = { keys: /\b(keys?|keyring|keychain)\b|钥匙|蓝色挂绳/, wallet: /\b(wallet|purse)\b|钱包/, earbuds: /\b(earbuds?|earphones?|airpods?|headphones?)\b|耳机/ };
    const matches = IDS.filter(id => aliases[id].test(q));
    if (matches.length > 1) return { ...empty, answer: chinese ? '请一次询问一件物品。' : 'Please ask about one item at a time.', kind: 'clarify' };
    const isPrevious = /\b(before|previous|earlier|previously)\b|之前|以前|上一次/.test(q);
    const isCurrent = /\b(still there|right now|currently|now)\b|现在|还在/.test(q);
    const followup = /\b(it|them|they|that)\b|它|那件/.test(q)
      || /^(?:and\s+|what about\s+)?(?:before|previous|previously|earlier|now|right now|still there)[?.! ]*$/.test(q)
      || /^(?:那|那么)?(?:之前|以前|现在|还在|上一次)(?:呢|吗|么)?[？?！!。 ]*$/.test(q);
    const objectId = matches[0] ?? (followup ? this.context.objectId : null);
    if (!objectId) return { ...empty, answer: chinese ? '目前支持钥匙、钱包和耳机盒。你想找哪一件？' : 'I can recall keys, a wallet, or earbuds. Which item are you looking for?', kind: 'unsupported' };
    const object = this.state.objects.find(o => o.id === objectId);
    this.context.objectId = objectId;
    if (!object.lastSeen) return { ...empty, objectId, answer: chinese ? `这次会话中还没有${{ keys: '钥匙', wallet: '钱包', earbuds: '耳机盒' }[objectId]}的明确观察记录。` : `I haven't seen your ${object.name.toLowerCase()} in this session.`, kind: 'unknown' };
    let observation = object.lastSeen;
    if (isPrevious) {
      const seen = this.state.observations.filter(o => o.objectId === objectId && o.status === 'seen');
      const cursor = matches[0] ? object.lastSeen : seen.find(o => o.id === this.context.observationId) ?? object.lastSeen;
      observation = [...seen].reverse().find(o => o.seq < cursor.seq && distance(o.position, cursor.position) > POSITION_CHANGE);
      if (!observation) return { ...empty, objectId, answer: chinese ? '没有更早的不同位置记录。' : 'I have no earlier observation at a different position.', kind: 'no_history' };
    }
    this.context.observationId = observation.id;
    const name = chinese ? { keys: '钥匙', wallet: '钱包', earbuds: '耳机盒' }[objectId] : object.name.toLowerCase();
    const age = relativeAge(observation.capturedAt, chinese);
    const deskCoordinates = observation.source === 'demo' || observation.calibrationId != null;
    const location = describePosition(observation.position, chinese, deskCoordinates);
    let answer = chinese ? `${isPrevious ? '更早一次' : '最后一次'}在${age}看到${name}，位于${location}。` : `I ${isPrevious ? 'previously' : 'last'} saw your ${name} ${age}, at ${location}.`;
    if (!deskCoordinates) answer += chinese ? '尚未标定桌面，方位仅对应摄像头画面。' : ' The desk is not calibrated, so this direction refers only to the image.';
    if (isCurrent) answer += chinese ? '这是最后观察的位置，我无法保证此刻仍在那里。' : ' That is the last observed position; I cannot guarantee it is still there now.';
    else if (!isPrevious && object.latestCheck?.status !== 'seen') answer += chinese ? '最近一次检查没有明确看到它。' : ' It was not clearly visible in the latest check.';
    if (this.state.session.observerState !== 'observing') answer += chinese ? '观察目前已暂停或中断。' : ' Observation is currently paused or interrupted.';
    return { answer, objectId, observationId: observation.id, evidenceId: observation.evidenceId, position: copy(observation.position), capturedAt: observation.capturedAt, kind: isPrevious ? 'history' : isCurrent ? 'current_check' : 'last_seen', source: observation.source };
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { OfflineRun } from '../public/run-offline.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
const fixture = JSON.parse(fs.readFileSync(new URL('../public/assets/demo-manifest.json', import.meta.url)));

async function harness({ speech = false } = {}) {
  const elements = new Map(), draws = [], timers = new Map(), windowEvents = {}, recognizers = []; let timerId = 0;
  class Element {
    constructor(id = '') { this.id = id; this.style = {}; this.dataset = {}; this.listeners = {}; this.currentTime = 0; this.duration = 24; this.videoWidth = 960; this.videoHeight = 600; this.readyState = 2; this.hidden = false; this.value = ''; this.textContent = ''; this.attrs = {}; this.width = 518; this.height = 518; this.classList = { add() {}, remove() {}, toggle() {} }; }
    set innerHTML(html) { this.html = html; for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element(match[1])); }
    get innerHTML() { return this.html || ''; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    removeEventListener(name, fn) { if (this.listeners[name] === fn) delete this.listeners[name]; }
    get currentTime() { return this._currentTime || 0; }
    set currentTime(value) { this._currentTime = value; if (this.id === 'feed') queueMicrotask(() => this.listeners.seeked?.()); }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { width: 600, height: 340 }; }
    getContext() { return new Proxy({ measureText: text => ({ width: text.length * 7 }), drawImage: source => draws.push(source.currentTime) }, { get: (t, k) => t[k] || (() => {}) }); }
    toDataURL() { return PNG; }
    pause() { this.paused = true; }
    async play() { this.paused = false; }
    load() {}
    focus() { doc.activeElement = this; this.tagName = 'BUTTON'; }
    click() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const html = fs.readFileSync(new URL('../public/run.html', import.meta.url), 'utf8');
  for (const m of html.matchAll(/id="([^"]+)"/g)) elements.set(m[1], new Element(m[1]));
  const engine = new OfflineRun(fixture);
  const doc = { getElementById: id => elements.get(id), createElement: () => new Element(), querySelectorAll: () => [], addEventListener() {}, body: new Element(), hidden: false };
  class Recognition {
    constructor() { recognizers.push(this); }
    start() { this.onstart?.(); }
    abort() { this.onend?.(); }
    stop() { this.onend?.(); }
    result(transcript) { this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal: true })] }); }
  }
  const context = vm.createContext({ console, document: doc, navigator: {}, devicePixelRatio: 1, URL, Blob, Response, Date, crypto, structuredClone, ResizeObserver: class { observe() {} }, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), window: { addEventListener(name, fn) { windowEvents[name] = fn; }, scrollTo() {}, ...(speech ? { SpeechRecognition: Recognition } : {}) },
    SpatialMap: class { setState(state) { this.state = state; } render() {} reset() {} setPose(pose) { this.pose = pose; } },
    Feedback: class { constructor() { this.enabled = false; this.context = { state: 'running', suspend() { throw new Error('Listening must not suspend heartbeat audio.'); }, resume() {} }; } update(value) { this.guidance = value; } speak(value) { this.spoken = value; } async enable() { this.enabled = true; } disable() { this.enabled = false; } cancelSpeech() { this.speaking = false; } },
    fetch: async (route, options = {}) => { try { return Response.json(await engine.request(route.slice(9), options.body ? JSON.parse(options.body) : undefined)); } catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }); } },
  });
  const source = fs.readFileSync(new URL('../public/run.js', import.meta.url), 'utf8').replace(/^import .*?;\s*$/gm, '').replace(/initialize\(\);\s*$/, 'globalThis.ready=initialize();');
  vm.runInContext(source, context); await context.ready;
  return { engine, elements, draws, timers, windowEvents, recognizers, doc, run: code => vm.runInContext(code, context) };
}

test('Run page consumes video frames, renders actual stored objects, and updates typed guidance through API calls', async () => {
  const ui = await harness(); await ui.run('processFrame()');
  assert.equal(ui.elements.get('storage-count').textContent, 4);
  assert.match(ui.elements.get('objects').innerHTML, /已保存空间位置/);
  await ui.run('ask("帮我找钥匙")');
  assert.match(ui.elements.get('answer').textContent, /钥匙/);
  assert.equal(ui.elements.get('distance-unit').textContent, 'm · 模拟距离');
  assert.equal(ui.run('state.guidance.simulatedUser'), true);
  await ui.run('move("right")'); assert.match(ui.elements.get('answer').textContent, /视角|方向|抬头|低头/);
});

test('Run page preserves out-of-view evidence, shows a departure checklist, and exposes stored JSON', async () => {
  const ui = await harness(); await ui.run('processFrame()');
  await ui.run('video.currentTime=9;processFrame()');
  await ui.run('video.currentTime=15;processFrame()');
  assert.match(ui.elements.get('objects').innerHTML, /已离开视野/);
  await ui.run('ask("我要出发了")'); assert.equal(ui.elements.get('checklist').hidden, false); assert.match(ui.elements.get('checklist').innerHTML, /逐件确认/);
  await ui.run('storage()'); assert.equal(ui.elements.get('detail-dialog').open, true); assert.match(ui.elements.get('detail-body').innerHTML, /sha256/);
  await ui.run('restart()'); assert.equal(ui.run('state.frameCount'), 0);
});

test('Run page does not imply real recognition in offline preview after choosing a user video', async () => {
  const ui = await harness(); await ui.run('loadSource({mode:"video",url:"blob:test",filename:"user.mp4"})');
  await ui.run('play()');
  assert.equal(ui.engine.state().frameCount, 0); assert.match(ui.elements.get('toast').textContent, /Gemini/);
  assert.equal(ui.run('running'), false);
});

const recording = () => ({ schemaVersion: 1, provenance: 'dataset_annotations', source: { dataset: 'fixture dataset for tests' }, mapId: 'room_test', coordinateUnits: 'meters', imageSpace: 'letterboxed_square', video: { name: 'clip.mp4', width: 960, height: 600, duration: 24 }, entities: [{ id: 'keys', label: '钥匙', aliases: ['钥匙'], priority: 'explicit' }], points: [[0, 0, 0, '#aabbcc']], frames: [1, 3, 5].map((videoTime, index) => ({ videoTime, worldFromCamera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], detections: [index === 2 ? { entityId: 'keys', status: 'not_seen' } : { entityId: 'keys', status: 'seen', bbox: [.1, .2, .3, .4], worldPosition: [index + 1, 0, 2] }] })) });

test('dataset import captures exact annotation frames, preserves moved history and does not expose future observations', async () => {
  const ui = await harness();
  await ui.run('loadSource({mode:"video",url:"blob:test",filename:"clip.mp4",file:{name:"clip.mp4"}})');
  const pack = JSON.stringify(recording());
  await ui.run(`importRecording({size:1000,text:async()=>${JSON.stringify(pack)}})`);
  assert.equal(ui.run('state.observationCount'), 0);
  assert.match(ui.elements.get('mode-badge').textContent, /数据集标注/);
  await ui.run('video.currentTime=4.2;processRecordingFrame()');
  assert.equal(ui.draws.at(-1), 1);
  assert.deepEqual(ui.engine.state().objects[0].lastSeen.position, [1, 0, 2]);
  await ui.run('video.currentTime=4.2;processRecordingFrame()');
  assert.equal(ui.draws.at(-1), 3);
  assert.deepEqual(ui.engine.state().objects[0].lastSeen.position, [2, 0, 2]);
  assert.equal(ui.engine.state().objects[0].latestCheck.status, 'seen');
  assert.equal(ui.engine.data.observations.length, 2);
  assert.equal(ui.engine.data.observations[0].method, 'annotation');
  assert.equal(ui.engine.data.observations[0].evidence.synthetic, false);
  const exported = await ui.engine.request('export');
  assert.equal(exported.session.recordingPack, undefined, 'exported memory excludes future source labels');
  assert.equal(exported.session.evidence[exported.memory.observations[0].evidence.imagePath].dataUrl, PNG);
  assert.equal(ui.engine.data.maps[0].revisions[0].sha256.length, 64);
  await ui.run('video.currentTime=5;processRecordingFrame()');
  assert.deepEqual(ui.engine.state().objects[0].lastSeen.position, [2, 0, 2]);
  assert.equal(ui.engine.state().objects[0].latestCheck.status, 'not_seen');
  await ui.run('restart()');
  assert.equal(ui.run('state.session.mode'), 'recording');
  assert.equal(ui.run('state.observationCount'), 0);
});

test('dataset import rejects mismatched video and preview recognition cannot consume future annotations', async () => {
  const engine = new OfflineRun(fixture), pack = recording();
  await assert.rejects(engine.request('recording', { sessionId: engine.state().session.id, recording: pack, video: { ...pack.video, name: 'other.mp4' } }), /不一致/);
  const state = await engine.request('recording', { sessionId: engine.state().session.id, recording: pack, video: pack.video });
  await assert.rejects(engine.frame({ sessionId: state.session.id, seq: 1, videoTime: .99, imageDataUrl: PNG }), /对齐/);
  assert.equal(engine.state().observationCount, 0);
  await engine.frame({ sessionId: state.session.id, seq: 1, videoTime: 1, imageDataUrl: PNG });
  await assert.rejects(engine.frame({ sessionId: state.session.id, seq: 2, videoTime: 1.01, imageDataUrl: PNG }), /已处理/);
  assert.equal(engine.state().observationCount, 1);
});

test('invisible voice loop keeps heartbeat audio active and resumes listening after confirmation', async () => {
  const ui = await harness({ speech: true }); await ui.run('processFrame()');
  await ui.run('enterInvisible()');
  assert.equal(ui.elements.get('app-main').inert, true);
  await ui.run('microphone()');
  assert.equal(ui.run('feedback.listening'), true);
  ui.recognizers.at(-1).result('我要出发了');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.engine.state().targetId, 'keys');
  assert.equal(ui.run('feedback.listening'), false);
  const resume = ui.timers.get(ui.run('listenTimer')); assert.equal(typeof resume, 'function'); resume();
  assert.equal(ui.run('feedback.listening'), true);
  ui.recognizers.at(-1).result('拿到了'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.engine.state().targetId, 'wallet');
  assert.equal(ui.engine.data.userReports[0].source, 'user_report');
  assert.match(ui.elements.get('checklist').innerHTML, /用户已确认/);
  await ui.run('ask("暂停")'); assert.equal(ui.run('running'), false); assert.equal(ui.run('listenWanted'), true); assert.equal(ui.run('feedback.guidance'), null);
  await ui.run('ask("继续")'); await new Promise(resolve => setImmediate(resolve)); assert.equal(ui.run('running'), true); assert.equal(ui.run('listenWanted'), true);
  const before = [...ui.engine.data.simulatedPose.worldFromCamera];
  ui.windowEvents.keydown({ key: 'ArrowRight', preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
  assert.notDeepEqual(ui.engine.data.simulatedPose.worldFromCamera, before);
  ui.windowEvents.keydown({ key: 'Escape' });
  assert.equal(ui.elements.get('invisible-view').hidden, true);
  assert.equal(ui.elements.get('app-main').inert, false);
});

test('heartbeat adapter ducks during listening without stopping and ignores stale speech completion', async () => {
  const timers = [], utterances = [], beats = [];
  const context = vm.createContext({ document: { hidden: false }, navigator: {}, Date, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, window: { speechSynthesis: { cancel() {}, speak(u) { utterances.push(u); } } } });
  vm.runInContext(fs.readFileSync(new URL('../public/run-feedback.js', import.meta.url), 'utf8').replace('export class Feedback', 'class Feedback') + '\nglobalThis.actuator = new Feedback();', context);
  const actuator = context.actuator; actuator.beat = (gain, delay) => beats.push({ gain, delay });
  actuator.enabled = true; actuator.listening = true; actuator.update({ pulse: { enabled: true, gain: .3, intervalMs: 600 } });
  timers[0](); assert.equal(beats.length, 2); assert.ok(Math.abs(beats[0].gain - .09) < .000001);
  actuator.speak('向左转', true); actuator.speak('方向正确', true);
  utterances[0].onend(); assert.equal(actuator.speaking, true);
  utterances[1].onend(); assert.equal(actuator.speaking, false);
});

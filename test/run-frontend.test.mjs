import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { OfflineRun } from '../public/run-offline.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
const fixture = JSON.parse(fs.readFileSync(new URL('../public/assets/demo-manifest.json', import.meta.url)));

async function harness() {
  const elements = new Map();
  class Element {
    constructor(id = '') { this.id = id; this.style = {}; this.dataset = {}; this.listeners = {}; this.currentTime = 0; this.duration = 24; this.videoWidth = 960; this.videoHeight = 600; this.readyState = 2; this.hidden = false; this.value = ''; this.textContent = ''; this.attrs = {}; this.width = 518; this.height = 518; this.classList = { add() {}, remove() {}, toggle() {} }; }
    set innerHTML(html) { this.html = html; for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element(match[1])); }
    get innerHTML() { return this.html || ''; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { width: 600, height: 340 }; }
    getContext() { return new Proxy({ measureText: text => ({ width: text.length * 7 }) }, { get: (t, k) => t[k] || (() => {}) }); }
    toDataURL() { return PNG; }
    pause() { this.paused = true; }
    async play() { this.paused = false; }
    load() {}
    focus() {}
    click() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const html = fs.readFileSync(new URL('../public/run.html', import.meta.url), 'utf8');
  for (const m of html.matchAll(/id="([^"]+)"/g)) elements.set(m[1], new Element(m[1]));
  const engine = new OfflineRun(fixture);
  const doc = { getElementById: id => elements.get(id), createElement: () => new Element(), querySelectorAll: () => [], addEventListener() {}, body: new Element(), hidden: false };
  const context = vm.createContext({ console, document: doc, navigator: {}, devicePixelRatio: 1, URL, Blob, Response, Date, crypto, structuredClone, ResizeObserver: class { observe() {} }, setTimeout: () => 1, clearTimeout() {}, window: { addEventListener() {}, scrollTo() {} },
    SpatialMap: class { setState(state) { this.state = state; } render() {} reset() {} setPose(pose) { this.pose = pose; } },
    Feedback: class { constructor() { this.enabled = false; } update(value) { this.guidance = value; } speak(value) { this.spoken = value; } async enable() { this.enabled = true; } disable() { this.enabled = false; } },
    fetch: async (route, options = {}) => { try { return Response.json(await engine.request(route.slice(9), options.body ? JSON.parse(options.body) : undefined)); } catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }); } },
  });
  const source = fs.readFileSync(new URL('../public/run.js', import.meta.url), 'utf8').replace(/^import .*?;\s*$/gm, '').replace(/initialize\(\);\s*$/, 'globalThis.ready=initialize();');
  vm.runInContext(source, context); await context.ready;
  return { engine, elements, run: code => vm.runInContext(code, context) };
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

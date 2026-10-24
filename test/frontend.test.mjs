import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.width = 960;
    this.height = 600;
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, on = !classes.has(value)) { on ? classes.add(value) : classes.delete(value); return on; },
    };
    const noop = () => {};
    this.context = new Proxy({ measureText: text => ({ width: text.length * 8 }) }, { get: (target, key) => key in target ? target[key] : noop });
  }
  get src() { return this.attributes.get('src'); }
  set src(value) { this.attributes.set('src', value); }
  getContext() { return this.context; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelectorAll() { return []; }
  addEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

async function harness(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pocketrecall-ui-'));
  const server = createAppServer({ dataDir, vision: { configured: false, model: 'test-model' } });
  t.after(async () => { server.emit('close'); await rm(dataDir, { recursive: true, force: true }); });
  const requestHandler = server.listeners('request')[0];
  const html = await readFile(path.join(ROOT, 'public/index.html'), 'utf8');
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new FakeElement(match[1])]));
  let timerId = 0;
  const context = vm.createContext({
    console,
    document: { getElementById: id => elements.get(id) ?? null, querySelectorAll: () => [], createElement: () => new FakeElement() },
    window: { addEventListener() {} },
    navigator: {},
    setTimeout: () => ++timerId,
    clearTimeout() {},
    setInterval: () => ++timerId,
    clearInterval() {},
    DeskScene: class { setState() {} destroy() {} },
    drawDemoFrame(canvas, step) {
      return { imageDataUrl: PNG, items: {
        keys: step === 2 ? { status: 'not_seen', bbox: null } : { status: 'seen', bbox: step === 0 ? [0.1, 0.4, 0.2, 0.5] : [0.7, 0.4, 0.8, 0.5] },
        wallet: { status: 'seen', bbox: [0.4, 0.2, 0.5, 0.3] },
        earbuds: { status: 'not_seen', bbox: null },
      } };
    },
    async fetch(route, options = {}) {
      const req = Readable.from(options.body ? [Buffer.from(options.body)] : []);
      req.method = options.method || 'GET';
      req.url = route;
      req.headers = { host: '127.0.0.1:3000', ...Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])) };
      let status = 200;
      let bytes;
      const headers = {};
      const res = {
        writableEnded: false, destroyed: false,
        setHeader(name, value) { headers[name.toLowerCase()] = value; },
        writeHead(code, values = {}) { status = code; Object.assign(headers, values); },
        end(value) { bytes = value; this.writableEnded = true; },
      };
      await requestHandler(req, res);
      return new Response(bytes, { status, headers });
    },
  });
  // Canvas rendering and speech hardware are stubbed; application orchestration,
  // real API handlers, persistent memory, queries, and DOM binding are exercised.
  const source = (await readFile(path.join(ROOT, 'public/app.js'), 'utf8'))
    .replace(/^import .*?;\s*\n/, '')
    .replace(/initialize\(\);\s*$/, 'globalThis.ready = initialize();');
  vm.runInContext(source, context, { filename: 'public/app.js' });
  await context.ready;
  return { run: code => vm.runInContext(code, context), elements, server };
}

test('actual frontend initializes a labeled demo against the real memory API', async t => {
  const ui = await harness(t);
  assert.equal(ui.run('state.session.mode'), 'demo');
  assert.match(ui.elements.get('source-note').innerHTML, /Simulated scene/);
  assert.match(ui.elements.get('object-grid').innerHTML, /Keys/);
  assert.equal(ui.run('state.objects.find(o => o.id === "keys").lastSeen.source'), 'demo');
  assert.match(ui.elements.get('evidence-img').src, /^\/api\/evidence\/.+\.png$/);
});

test('frontend move, hide, last-seen, history, and unknown queries select matching evidence', async t => {
  const ui = await harness(t);
  const firstId = ui.run('state.objects.find(o => o.id === "keys").lastSeen.id');
  await ui.run('demoStep(1)');
  const movedId = ui.run('state.objects.find(o => o.id === "keys").lastSeen.id');
  assert.notEqual(firstId, movedId);
  await ui.run('demoStep(2)');
  await ui.run('ask("Where are my keys?")');
  assert.equal(ui.run('selectedObservationId'), movedId);
  assert.match(ui.elements.get('answer-text').textContent, /right/);
  assert.match(ui.elements.get('answer-text').textContent, /not clearly visible/);
  assert.equal(ui.elements.get('evidence-img').src, '/api/evidence/' + ui.run('findEvidence().evidenceId'));
  await ui.run('ask("Previously?")');
  assert.equal(ui.run('selectedObservationId'), firstId);
  assert.match(ui.elements.get('answer-text').textContent, /left/);
  assert.equal(ui.elements.get('evidence-img').src, '/api/evidence/' + ui.run('findEvidence().evidenceId'));
  await ui.run('ask("Where are my earbuds?")');
  assert.match(ui.elements.get('answer-text').textContent, /haven.t seen/);
  assert.equal(ui.run('selectedObjectId'), 'earbuds');
  assert.equal(ui.elements.get('evidence-img').hidden, true);
});

test('frontend ignores stale state snapshots after pause and later observations', async t => {
  const ui = await harness(t);
  ui.run('globalThis.oldState = JSON.parse(JSON.stringify(state));');
  await ui.run('ask("Pause observation")');
  assert.equal(ui.run('state.session.observerState'), 'paused');
  ui.run('accept(oldState)');
  assert.equal(ui.run('state.session.observerState'), 'paused');
  await ui.run('ask("Resume observation")');
  ui.run('globalThis.beforeCapture = JSON.parse(JSON.stringify(state));');
  await ui.run('demoStep(1)');
  const seq = ui.run('state.lastProcessedSeq');
  ui.run('accept(beforeCapture)');
  assert.equal(ui.run('state.lastProcessedSeq'), seq);
});

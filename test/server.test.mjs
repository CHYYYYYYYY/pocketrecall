import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createAppServer } from '../server.mjs';
import { createVisionClient, normalizeDetections, validateFrameImage } from '../lib/vision.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
const ITEMS = {
  keys: { status: 'seen', bbox: [0.2, 0.3, 0.4, 0.5] },
  wallet: { status: 'not_seen', bbox: null },
  earbuds: { status: 'not_seen', bbox: null },
};

async function fixture(t, vision = { configured: false, model: 'test-model' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pocketrecall-http-'));
  const publicDir = path.join(root, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<h1>PocketRecall</h1>');
  await writeFile(path.join(root, '.env.local'), 'GEMINI_API_KEY=never-serve-me');
  const server = createAppServer({ dataDir: path.join(root, 'data'), publicDir, vision });
  t.after(async () => {
    server.emit('close');
    await rm(root, { recursive: true, force: true });
  });
  // Invoke the actual HTTP request handler without opening a listening socket.
  // This also runs in restricted development environments that deny bind().
  const handler = server.listeners('request')[0];
  async function request(route, options = {}) {
    const req = Readable.from(options.body ? [Buffer.from(options.body)] : []);
    req.method = options.method || 'GET';
    req.url = route;
    req.headers = { host: '127.0.0.1:3000', ...options.headers };
    const headers = {};
    let status = 200;
    let bytes;
    const res = {
      writableEnded: false,
      destroyed: false,
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      writeHead(code, values = {}) { status = code; Object.assign(headers, values); },
      end(value) { bytes = value; this.writableEnded = true; },
    };
    await handler(req, res);
    return new Response(bytes, { status, headers });
  }
  return {
    server,
    get: route => request(route),
    async post(route, body, headers = {}) {
      const response = await request(route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
  };
}

const observation = state => ({ sessionId: state.session.id, generation: state.session.generation, seq: 1, capturedAt: new Date().toISOString() });

test('vision validates image format and converts yxyx model boxes to normalized xyxy', () => {
  assert.equal(validateFrameImage(PNG).mimeType, 'image/png');
  assert.throws(() => validateFrameImage('data:image/png;base64,YmFk'), /valid PNG/);
  const result = normalizeDetections({ keys: { status: 'seen', box_2d: [300, 200, 500, 400] }, wallet: { status: 'not_seen', box_2d: null }, earbuds: { status: 'unclear', box_2d: null } });
  assert.deepEqual(result.keys.bbox, [0.2, 0.3, 0.4, 0.5]);
  assert.throws(() => normalizeDetections({ keys: { status: 'seen', box_2d: [500, 200, 300, 400] } }), /incomplete observation/);
});

test('vision does not leak provider error payloads or the API key', async () => {
  const vision = createVisionClient({ apiKey: 'test-secret-key', fetchImpl: async () => new Response('test-secret-key provider payload', { status: 403 }) });
  await assert.rejects(vision.analyzeFrame(PNG), error => !error.message.includes('test-secret-key') && /rejected access/.test(error.message));
});

test('vision adapter sends structured schema and returns real normalized response', async () => {
  let request;
  const vision = createVisionClient({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ keys: { status: 'seen', box_2d: [300, 200, 500, 400] }, wallet: { status: 'not_seen', box_2d: null }, earbuds: { status: 'not_seen', box_2d: null } }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } });
  } });
  const result = await vision.analyzeFrame(PNG);
  assert.match(request.url, /:generateContent$/);
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(result.items, ITEMS);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50 });
});

test('HTTP serves the app and exposes only safe API configuration', async t => {
  const app = await fixture(t);
  const page = await app.get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PocketRecall/);
  assert.deepEqual(await (await app.get('/api/config')).json(), { provider: 'gemini', configured: false, model: 'test-model' });
  assert.equal((await app.get('/.env.local')).status, 404);
  assert.equal((await app.get('/%2e%2e/.env.local')).status, 404);
});

test('HTTP rejects cross-origin state changes', async t => {
  const app = await fixture(t);
  const result = await app.post('/api/session', { mode: 'demo' }, { origin: 'https://unrelated.example' });
  assert.equal(result.status, 403);
});

test('Run HTTP routes persist frame evidence, query it and reject foreign sessions and origins', async t => {
  const app = await fixture(t);
  const initial = await (await app.get('/api/run/state')).json();
  const config = await (await app.get('/api/run/config')).json();
  assert.equal(Object.hasOwn(config.vision, 'apiKey'), false);
  const observed = await app.post('/api/run/frame', { sessionId: initial.session.id, seq: 1, videoTime: 0, imageDataUrl: PNG });
  assert.equal(observed.status, 200); assert.equal(observed.body.state.observationCount, 4);
  const evidence = await app.get(observed.body.state.objects[0].evidenceUrl);
  assert.equal(evidence.status, 200); assert.equal(evidence.headers.get('content-type'), 'image/png');
  const result = await app.post('/api/run/query', { sessionId: initial.session.id, text: '找钥匙' });
  assert.equal(result.status, 200); assert.equal(result.body.state.guidance.simulatedUser, true);
  assert.equal((await app.post('/api/run/move', { sessionId: 'old', action: 'forward' })).status, 409);
  assert.equal((await app.post('/api/run/session', { mode: 'demo' }, { origin: 'https://other.example' })).status, 403);
  assert.equal((await app.get('/api/run/evidence/invalid/no.png')).status, 404);
});

test('demo capture persists evidence and is excluded from live mode', async t => {
  const app = await fixture(t);
  const session = (await app.post('/api/session', { mode: 'demo' })).body;
  const result = await app.post('/api/demo/observe', { ...observation(session), items: ITEMS, evidenceDataUrl: PNG });
  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, true);
  const keys = result.body.state.objects.find(item => item.id === 'keys');
  const evidence = await app.get('/api/evidence/' + keys.lastSeen.evidenceId);
  assert.equal(evidence.status, 200);
  assert.equal(evidence.headers.get('content-type'), 'image/png');
  const live = (await app.post('/api/session', { mode: 'live' })).body;
  assert.equal((await app.post('/api/demo/observe', { ...observation(live), items: ITEMS, evidenceDataUrl: PNG })).status, 409);
  assert.equal((await app.post('/api/observe', { ...observation(live), imageDataUrl: PNG })).status, 503);
});

test('live endpoint never falls back to demo and keeps previous evidence on provider failure', async t => {
  let fail = false;
  const app = await fixture(t, { configured: true, model: 'test', async analyzeFrame() {
    if (fail) throw new Error('Network unavailable');
    return { items: ITEMS, usage: null };
  } });
  const session = (await app.post('/api/session', { mode: 'live' })).body;
  const capture = { ...observation(session), imageDataUrl: PNG };
  const first = await app.post('/api/observe', capture);
  assert.equal(first.body.accepted, true);
  const firstSeen = first.body.state.objects.find(item => item.id === 'keys').lastSeen;
  fail = true;
  await app.post('/api/observe', { ...capture, seq: 2 });
  const state = await (await app.get('/api/state')).json();
  assert.equal(state.session.observerState, 'interrupted');
  assert.equal(state.objects.find(item => item.id === 'keys').lastSeen.id, firstSeen.id);
});

test('clearing during an in-flight observation prevents old memory from returning', async t => {
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const app = await fixture(t, { configured: true, model: 'test', analyzeFrame() {
    started();
    return new Promise(resolve => { release = () => resolve({ items: ITEMS }); });
  } });
  const session = (await app.post('/api/session', { mode: 'live' })).body;
  const pending = app.post('/api/observe', { ...observation(session), imageDataUrl: PNG });
  await startedPromise;
  const duplicate = await app.post('/api/observe', { ...observation(session), seq: 2, imageDataUrl: PNG });
  assert.equal(duplicate.status, 429);
  await app.post('/api/control', { action: 'clear' });
  release();
  const stale = await pending;
  assert.equal(stale.body.accepted, false);
  const state = await (await app.get('/api/state')).json();
  assert.equal(state.objects.find(item => item.id === 'keys').lastSeen, null);
});

test('invalid metadata and oversized bodies fail before any provider call', async t => {
  let calls = 0;
  const app = await fixture(t, { configured: true, model: 'test', async analyzeFrame() { calls++; return { items: ITEMS }; } });
  const session = (await app.post('/api/session', { mode: 'live' })).body;
  const base = { ...observation(session), imageDataUrl: PNG };
  assert.equal((await app.post('/api/observe', { ...base, seq: 1.5 })).status, 400);
  assert.equal((await app.post('/api/observe', { ...base, capturedAt: new Date(Date.now() + 120000).toISOString() })).status, 400);
  assert.equal((await app.post('/api/observe', { ...base, generation: base.generation - 1 })).status, 409);
  assert.equal((await app.post('/api/observe', base, { 'content-length': String(7 * 1024 * 1024) })).status, 413);
  assert.equal(calls, 0);
  const state = await (await app.get('/api/state')).json();
  assert.equal(state.observations.length, 0);
});

test('voice pause invalidates an in-flight frame and a resumed session can observe again', async t => {
  const pending = [];
  let notify;
  let started = new Promise(resolve => { notify = resolve; });
  const app = await fixture(t, { configured: true, model: 'test', analyzeFrame(image, { signal }) {
    return new Promise(resolve => { pending.push({ signal, release: () => resolve({ items: ITEMS }) }); notify(); });
  } });
  const session = (await app.post('/api/session', { mode: 'live' })).body;
  const first = app.post('/api/observe', { ...observation(session), imageDataUrl: PNG });
  await started;
  const pause = await app.post('/api/query', { text: 'pause observation' });
  assert.equal(pause.body.action, 'pause');
  assert.equal(pending[0].signal.aborted, true);
  const pausedState = await (await app.get('/api/state')).json();
  assert.equal((await app.post('/api/observe', { ...observation(pausedState), imageDataUrl: PNG })).status, 409);
  const resumed = (await app.post('/api/control', { action: 'resume' })).body;
  started = new Promise(resolve => { notify = resolve; });
  const second = app.post('/api/observe', { ...observation(resumed), seq: 2, imageDataUrl: PNG });
  await started;
  pending[0].release();
  assert.equal((await first).body.accepted, false);
  // The old request's finally must not unlock the newer request.
  assert.equal((await app.post('/api/observe', { ...observation(resumed), seq: 3, imageDataUrl: PNG })).status, 429);
  pending[1].release();
  assert.equal((await second).body.accepted, true);
});

test('vision rejects a guessed position for an unseen object', () => {
  assert.throws(() => normalizeDetections({
    keys: { status: 'not_seen', box_2d: [100, 100, 200, 200] },
    wallet: { status: 'not_seen', box_2d: null },
    earbuds: { status: 'unclear', box_2d: null },
  }), /location to an unseen object/);
});

test('Run API exposes durable maps, point geometry, object history and time-scoped spatial search', async t => {
  const app = await fixture(t);
  const state = (await app.post('/api/run/session', { mode: 'demo' })).body;
  const sessionId = state.session.id;
  for (const [i, videoTime] of [0,9,15].entries()) {
    const response = await app.post('/api/run/frame', { sessionId, seq: i + 1, videoTime, imageDataUrl: PNG });
    assert.equal(response.status, 200);
  }
  const index = await (await app.get('/api/run/maps')).json();
  assert.equal(index.maps.length, 1); assert.equal(index.maps[0].id, 'demo-room');
  const map = await (await app.get('/api/run/map/demo-room')).json();
  assert.ok(map.points.length > 1000); assert.equal(map.poses.length, 3);
  assert.equal(map.revision.sha256.length, 64);
  const history = await (await app.get('/api/run/history/keys')).json();
  assert.equal(history.observations.length, 3); assert.equal(history.observations.at(-1).status, 'not_seen');
  const result = await app.post('/api/run/search', { sessionId, text: '钥匙', mapId: 'demo-room', near: history.observations[0].position, at: history.observations[0].capturedAt, radius: .01 });
  assert.equal(result.status, 200); assert.equal(result.body.results.length, 1);
  assert.equal(result.body.results[0].lastSeen.id, history.observations[0].id);
  assert.equal(result.body.results[0].distance, 0);
  assert.equal((await app.post('/api/run/search', { sessionId: 'stale' })).status, 409);
  const exported = await (await app.get('/api/run/export')).json();
  assert.equal(exported.maps[0].revision.sha256, map.revision.sha256);
});

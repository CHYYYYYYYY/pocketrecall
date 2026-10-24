import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RunSession } from '../lib/run-session.mjs';
import { createRunVisionClient } from '../lib/run-vision.mjs';
import { createReconstructionClient, depthRaster, invertExtrinsic, sampleDepth } from '../lib/reconstruction.mjs';
import { OfflineRun } from '../public/run-offline.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
const fixturePath = path.join(root, 'public/assets/demo-manifest.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const seen = [{ entityId: 'keys', status: 'seen', bbox: [.4, .4, .6, .6], semantics: { provider: 'test_provider' } }];
function runFixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrecall-run-'));
  const run = new RunSession({ dataDir, fixturePath, vision: { configured: false, model: 'test' }, reconstruction: { configured: false, model: 'test' }, ...options });
  t.after(() => { run.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const frame = (videoTime, seq = run.session.lastSeq + 1) => run.ingest({ sessionId: run.session.id, seq, videoTime, imageDataUrl: PNG });
  return { run, frame, dataDir };
}

test('Run replay records moved objects and preserves the last seen evidence through occlusion and restart', async t => {
  const { run, frame, dataDir } = runFixture(t);
  await frame(0); const first = run.state().objects[0].lastSeen;
  await frame(9); const moved = run.state().objects[0].lastSeen;
  assert.ok(Math.hypot(...moved.position.map((n, i) => n - first.position[i])) > 1);
  await frame(15); const hidden = run.state().objects[0];
  assert.equal(hidden.latestCheck.status, 'not_seen'); assert.equal(hidden.lastSeen.id, moved.id);
  assert.equal(run.state().observationCount, 12); assert.equal(run.state().map.points.length, fixture.points.length);
  assert.ok(fs.existsSync(path.join(run.dir, hidden.lastSeen.evidence.imagePath)));
  assert.equal(hidden.lastSeen.evidence.sha256.length, 64);
  const reopened = new RunSession({ dataDir, fixturePath });
  assert.equal(reopened.state().objects[0].lastSeen.id, moved.id); reopened.close();
  await assert.rejects(frame(9), /过期/);
  run.query({ sessionId: run.session.id, text: '找钥匙' });
  assert.equal(run.guidance().videoConfirmed, false);
  await frame(21);
  assert.equal(run.guidance().videoConfirmed, true);
  assert.equal(run.guidance().confirmed, false, 'recorded video confirmation is not physical confirmation of the simulated wearer');
});

test('virtual turning aligns haptics; moving closer increases pulse volume without claiming physical confirmation', async t => {
  const { run, frame } = runFixture(t); await frame(9);
  run.query({ sessionId: run.session.id, text: '帮我找钥匙' });
  let g = run.guidance();
  for (let i = 0; i < 40 && Math.abs(g.bearingDeg) >= 8; i++) g = run.move({ sessionId: run.session.id, action: g.bearingDeg > 0 ? 'right' : 'left' }).guidance;
  for (let i = 0; i < 20 && Math.abs(g.elevationDeg) >= 8; i++) g = run.move({ sessionId: run.session.id, action: g.elevationDeg > 0 ? 'up' : 'down' }).guidance;
  assert.equal(g.aligned, true); assert.deepEqual(g.haptic, [25]);
  const before = g; g = run.move({ sessionId: run.session.id, action: 'forward' }).guidance;
  assert.ok(g.distanceM < before.distanceM); assert.ok(g.pulse.gain > before.pulse.gain); assert.ok(g.pulse.intervalMs < before.pulse.intervalMs);
  assert.equal(g.simulatedUser, true); assert.equal(g.confirmed, false);
  const departure = run.query({ sessionId: run.session.id, text: '我要出发了' });
  assert.equal(departure.checklist.length, 3); assert.match(departure.message, /不能证明/);
});

test('real-video failures never fall back to synthetic observations', async t => {
  const { run, frame } = runFixture(t, { vision: { configured: true, model: 'test', analyze: async () => { throw new Error('provider unavailable'); } } });
  run.start({ mode: 'video', filename: 'first-person.mp4' });
  await assert.rejects(frame(0), /provider unavailable/);
  assert.equal(run.state().observationCount, 0); assert.equal(run.state().map, null); assert.equal(run.busy, null);
});

test('switching sessions while Gemini is responding cannot contaminate the new session', async t => {
  let finish;
  const { run, frame } = runFixture(t, { vision: { configured: true, model: 'test', analyze: () => new Promise(resolve => finish = resolve) } });
  run.start({ mode: 'video' }); const pending = frame(0);
  await assert.rejects(frame(1), /上一帧/);
  run.start({ mode: 'demo' }); finish(seen);
  await assert.rejects(pending, /旧会话/); assert.equal(run.state().frameCount, 0); assert.equal(run.busy, null);
});

test('RGB-only video stores evidence and semantics but cannot invent 3D directions', async t => {
  const { run, frame } = runFixture(t, { vision: { configured: true, model: 'test', analyze: async () => seen } });
  run.start({ mode: 'video' }); await frame(0);
  const last = run.state().objects[0].lastSeen;
  assert.equal(last.position, null); assert.equal(last.evidence.synthetic, false);
  const result = run.query({ sessionId: run.session.id, text: 'keys' });
  assert.equal(result.state.guidance.distanceM, null); assert.equal(result.state.guidance.pulse.enabled, false);
  await assert.rejects(run.build({ sessionId: run.session.id }), /FAL_KEY/);
});

test('voice departure confirms items explicitly and advances without overwriting visual memory', async t => {
  const { run, frame } = runFixture(t); await frame(9);
  const query = text => run.query({ sessionId: run.session.id, text });
  const before = run.pipeline.store.snapshot().observations;
  query('我要出发了');
  const first = run.session.targetId; assert.ok(first);
  assert.equal(query('暂停').kind, 'pause'); assert.equal(query('继续').kind, 'resume');
  const confirmation = query('拿到了');
  assert.equal(confirmation.confirmedBy, 'user_report');
  assert.ok(run.session.confirmedIds.includes(first)); assert.notEqual(run.session.targetId, first);
  query('拿到了'); const completed = query('拿到了');
  assert.match(completed.message, /逐件确认/); assert.equal(run.session.targetId, null);
  assert.equal(run.pipeline.store.snapshot().userReports.length, 3);
  assert.deepEqual(run.pipeline.store.snapshot().observations, before);
  assert.equal(query('取消寻找').state.guidance, null);
});

test('unrelated or ambiguous later video frames cannot reconfirm the target', async t => {
  let detections = seen;
  const { run, frame } = runFixture(t, { vision: { configured: true, analyze: async () => detections } });
  run.start({ mode: 'video' }); await frame(0, 5);
  run.query({ sessionId: run.session.id, text: '找钥匙' });
  detections = []; await frame(2, 8);
  assert.equal(run.guidance().videoConfirmed, false);
  detections = seen; await frame(4, 11);
  assert.equal(run.guidance().videoConfirmed, true);
});

test('VGGT response aligns per-frame boxes and poses, persists a relative map, and never labels unscaled distances as meters', async t => {
  const e = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], k = [[300, 0, 259], [0, 300, 259], [0, 0, 1]];
  const { run, frame } = runFixture(t, { vision: { configured: true, model: 'test', analyze: async () => seen }, reconstruction: {
    configured: true, model: 'fal-ai/vggt-1b', submit: async images => { assert.equal(images.length, 2); return 'request_1'; }, status: async () => ({ status: 'COMPLETED' }),
    result: async () => ({ num_frames: 2, prediction_data: [{ url: 'test/0' }, { url: 'test/1' }], extrinsics: [e, e], intrinsics: [k, k] }), prediction: async () => ({ depth: Array.from({ length: 20 }, () => Array(20).fill(2)) }),
  } });
  run.start({ mode: 'video' }); await frame(0); await frame(2); await run.build({ sessionId: run.session.id }); await run.poll();
  assert.equal(run.state().reconstruction.status, 'completed'); assert.equal(run.state().map.units, 'relative');
  assert.equal(run.state().objects[0].lastSeen.coordinateUnits, 'relative');
  run.query({ sessionId: run.session.id, text: '钥匙' });
  assert.equal(run.guidance().distanceM, null); assert.equal(run.guidance().distanceRelative, 2);
  assert.equal(run.state().objects[0].lastSeen.evidence.synthetic, false);
  const last = run.state().objects[0].lastSeen;
  const recall = run.pipeline.recall('keys', { at: last.capturedAt });
  assert.equal(recall.guidance.distanceM, null); assert.equal(recall.guidance.distanceRelative, 2);
  run.session.simulatedPose.mapId = 'different-map'; assert.equal(run.guidance().status, 'relocalize'); assert.equal(run.guidance().pulse.enabled, false);
});

test('invalid VGGT frame correspondence does not mutate object positions', async t => {
  const { run, frame } = runFixture(t, { vision: { configured: true, analyze: async () => seen }, reconstruction: { configured: true, submit: async () => 'id', status: async () => ({ status: 'COMPLETED' }), result: async () => ({ num_frames: 1 }) } });
  run.start({ mode: 'video' }); await frame(0); await frame(1); await run.build({ sessionId: run.session.id });
  await assert.rejects(run.poll(), /未对齐/); assert.equal(run.state().objects[0].lastSeen.position, null); assert.equal(run.session.job.status, 'failed');
});

test('VGGT depth decoding, rigid inversion, and provider URL restrictions are enforced', async () => {
  const bytes = Buffer.alloc(100 * 4); for (let i = 0; i < 100; i++) bytes.writeFloatLE(2, i * 4);
  const raster = depthRaster({ depth: { shape: [1, 10, 10, 1], dtype: 'float32', data: bytes.toString('base64') } });
  assert.equal(sampleDepth(raster, .5, .5), 2);
  const m = invertExtrinsic([[1, 0, 0, -1], [0, 1, 0, -2], [0, 0, 1, -3]]);
  assert.deepEqual([m[3], m[7], m[11]], [1, 2, 3]);
  let calls = 0;
  const client = createReconstructionClient({ apiKey: 'test-hidden', fetchImpl: async () => { calls++; return Response.json({}); } });
  await assert.rejects(client.prediction('http://127.0.0.1:3000'), /host/);
  await assert.rejects(client.prediction('https://evil.fal.media.invalid/file'), /host/); assert.equal(calls, 0);
});

test('generic Gemini perception supports registered objects, validates boxes and does not expose provider payloads', async () => {
  let request;
  const client = createRunVisionClient({ apiKey: 'hidden-test-key', fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items: [{ entityId: 'cup', status: 'seen', box_2d: [100, 200, 400, 500], description: '白色杯子' }] }) }] } }] }); } });
  const result = await client.analyze(PNG, [{ id: 'cup', label: '杯子' }]); assert.deepEqual(result[0].bbox, [.2, .1, .5, .4]);
  assert.match(request.contents[0].parts[0].text, /杯子/);
  const failed = createRunVisionClient({ apiKey: 'hidden-test-key', fetchImpl: async () => new Response('hidden-test-key', { status: 403 }) });
  await assert.rejects(failed.analyze(PNG, [{ id: 'cup', label: '杯子' }]), error => !error.message.includes('hidden-test-key'));
});

test('offline presentation executes geometry, occlusion, queries and browser persistence with explicit synthetic provenance', async () => {
  const storage = new Map(); const adapter = { setItem: (k, v) => storage.set(k, v), getItem: k => storage.get(k) };
  const engine = new OfflineRun(fixture, adapter);
  for (const [i, videoTime] of [0, 9, 15].entries()) await engine.request('frame', { sessionId: engine.data.session.id, seq: i + 1, videoTime, imageDataUrl: PNG });
  assert.equal(engine.data.objects[0].lastSeen.evidence.synthetic, true); assert.equal(engine.data.objects[0].latestCheck.status, 'not_seen');
  const result = await engine.request('query', { sessionId: engine.data.session.id, text: '找钥匙' }); assert.equal(result.state.guidance.simulatedUser, true);
  const reopened = new OfflineRun(fixture, adapter); assert.equal(reopened.state().frameCount, 3);
  assert.equal((await reopened.request('config')).vision.configured, false);
  reopened.start({ mode: 'video' }); await assert.rejects(reopened.frame({ seq: 1, videoTime: 0, imageDataUrl: PNG }), /只处理合成/);
});

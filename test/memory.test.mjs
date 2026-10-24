import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, homographyFor, projectPoint } from '../lib/memory.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=';
function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrecall-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { store: new MemoryStore({ dataDir }), dataDir };
}
function observe(store, seq, bbox = [0.1, 0.6, 0.2, 0.7], extra = {}) {
  const state = store.getState();
  return store.applyObservation({ sessionId: state.session.id, generation: state.session.generation, seq, capturedAt: new Date(Date.now() - 60_000 + seq * 100).toISOString(), evidenceDataUrl: IMAGE, source: state.session.mode, items: { keys: { status: bbox ? 'seen' : 'not_seen', bbox }, wallet: { status: 'not_seen', bbox: null }, earbuds: { status: 'unclear', bbox: null } }, ...extra });
}

test('last seen evidence survives occlusion, and unsupported differs from never seen', t => {
  const { store } = setup(t);
  observe(store, 1);
  const original = store.getState().objects[0].lastSeen;
  observe(store, 2, null);
  const state = store.getState();
  assert.equal(state.objects[0].lastSeen.id, original.id);
  assert.equal(state.objects[0].latestCheck.status, 'not_seen');
  assert.match(store.query('Where are my keys?').answer, /not clearly visible/);
  assert.equal(store.query('Where are my earbuds?').kind, 'unknown');
  assert.equal(store.query('Where is my phone?').kind, 'unsupported');
  store.query('Where are my keys?');
  assert.equal(store.query('Where is my phone now?').kind, 'unsupported');
  assert.ok(fs.existsSync(store.evidencePath(original.evidenceId)));
});

test('rejects stale sequences, stale capture times, and late responses after clear', t => {
  const { store } = setup(t);
  observe(store, 5);
  assert.equal(observe(store, 4).reason, 'stale_sequence');
  assert.equal(observe(store, 6, undefined, { capturedAt: '2020-01-01T00:00:00Z' }).reason, 'stale_capture');
  const before = store.getState().session;
  store.control('clear');
  const result = observe(store, 7, undefined, { sessionId: before.id, generation: before.generation });
  assert.equal(result.accepted, false);
  assert.equal(store.query('keys').kind, 'unknown');
});

test('pause invalidates in-flight work; resume retains history', t => {
  const { store } = setup(t);
  observe(store, 1);
  const session = store.getState().session;
  store.control('pause');
  assert.equal(observe(store, 2).reason, 'paused');
  store.control('resume');
  assert.equal(observe(store, 2, undefined, { generation: session.generation }).reason, 'stale_session');
  assert.equal(store.query('keys').kind, 'last_seen');
});

test('invalid observations cannot update memory or create evidence', t => {
  const { store, dataDir } = setup(t);
  const bad = { keys: { status: 'seen', bbox: [-1, 0, 0.5, 0.5] }, wallet: { status: 'not_seen' }, earbuds: { status: 'unclear' } };
  assert.throws(() => observe(store, 1, undefined, { items: bad }), /bounding box/);
  assert.throws(() => observe(store, 1, undefined, { evidenceDataUrl: 'data:image/png;base64,bm90aW1hZ2U=' }), /image type/);
  assert.equal(store.getState().observations.length, 0);
  assert.equal(fs.readdirSync(path.join(dataDir, 'evidence')).length, 0);
});

test('history skips repeated observations at the same location and follows conversational context', t => {
  const { store } = setup(t);
  observe(store, 1, [0.1, 0.5, 0.2, 0.6]);
  observe(store, 2, [0.4, 0.5, 0.5, 0.6]);
  observe(store, 3, [0.7, 0.5, 0.8, 0.6]);
  observe(store, 4, [0.71, 0.5, 0.81, 0.6]);
  store.query('Where are my keys?');
  const previous = store.query('Where were they before?');
  assert.equal(previous.kind, 'history');
  assert.ok(Math.abs(previous.position.x - 0.45) < 0.001);
  assert.ok(Math.abs(store.query('之前呢').position.x - 0.15) < 0.001);
  assert.equal(store.query('before?').kind, 'no_history');
});

test('homography maps four desk corners exactly and rejects crossed calibration', () => {
  const points = [{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.15 }, { x: 0.95, y: 0.9 }, { x: 0.05, y: 0.8 }];
  const h = homographyFor(points);
  const targets = [[0, 0], [1, 0], [1, 1], [0, 1]];
  points.forEach((point, i) => {
    const result = projectPoint(point, h);
    assert.ok(Math.abs(result.x - targets[i][0]) < 1e-8);
    assert.ok(Math.abs(result.y - targets[i][1]) < 1e-8);
  });
  assert.throws(() => homographyFor([points[0], points[2], points[1], points[3]]), /quadrilateral/);
});

test('memory persists across process restart, restarts paused, and evidence paths are safe', t => {
  const { store, dataDir } = setup(t);
  observe(store, 1);
  const saved = store.getState().objects[0].lastSeen;
  const restored = new MemoryStore({ dataDir });
  assert.equal(restored.getState().session.observerState, 'paused');
  assert.equal(restored.getState().objects[0].lastSeen.id, saved.id);
  assert.ok(restored.evidencePath(saved.evidenceId));
  assert.equal(restored.evidencePath('../memory.json'), null);
  restored.control('clear');
  assert.equal(restored.evidencePath(saved.evidenceId), null);
});

test('calibration invalidates in-flight observations and projects existing evidence coherently', t => {
  const { store } = setup(t);
  observe(store, 1, [0.3, 0.3, 0.4, 0.4]);
  const old = store.getState().session;
  const state = store.setCalibration([{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }]);
  assert.ok(Math.abs(state.objects[0].lastSeen.position.x - 0.25) < 1e-8);
  assert.equal(observe(store, 2, undefined, { generation: old.generation }).accepted, false);
  const reset = store.setCalibration(null);
  assert.ok(Math.abs(reset.objects[0].lastSeen.position.x - 0.35) < 1e-8);
});

test('interrupted observation can recover without deleting historical evidence', t => {
  const { store } = setup(t);
  observe(store, 1);
  store.control('interrupted');
  assert.match(store.query('keys').answer, /interrupted/);
  assert.equal(observe(store, 2).accepted, true);
  assert.equal(store.getState().session.observerState, 'observing');
});

test('live queries use image directions until calibrated, then desk directions', t => {
  const { store } = setup(t);
  store.startSession({ mode: 'live' });
  observe(store, 1, [0.15, 0.75, 0.25, 0.85]);
  const uncalibrated = store.query('Where are my keys?');
  assert.match(uncalibrated.answer, /lower left of the camera view/);
  assert.match(uncalibrated.answer, /not calibrated/);
  assert.doesNotMatch(uncalibrated.answer, /near left of the desk/);
  assert.match(store.query('钥匙在哪').answer, /摄像头画面/);
  store.setCalibration([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  const calibrated = store.query('Where are my keys?');
  assert.match(calibrated.answer, /near left of the desk/);
  assert.doesNotMatch(calibrated.answer, /not calibrated|camera view/);
  store.setCalibration(null);
  assert.match(store.query('Where are my keys?').answer, /camera view/);
});

test('a projection outside the calibrated desk keeps evidence and reports its boundary', t => {
  const { store } = setup(t);
  store.startSession({ mode: 'live' });
  store.setCalibration([{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }]);
  observe(store, 1, [.02, .3, .08, .4]);
  const answer = store.query('Where are my keys?');
  assert.ok(answer.position.x < 0);
  assert.match(answer.answer, /outside the calibrated desk region/);
  assert.doesNotMatch(answer.answer, /left of the desk/);
  assert.ok(store.evidencePath(answer.evidenceId));
  assert.match(store.query('钥匙在哪').answer, /标定桌面区域以外/);
});

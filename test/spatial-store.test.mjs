import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpatialStore } from '../lib/spatial/store.mjs';

const origin = Date.parse('2026-10-24T20:00:00.000Z');
const iso = n => new Date(origin + n * 1000).toISOString();
const matrix = [1,0,0,0, 0,-1,0,1.5, 0,0,-1,2, 0,0,0,1];
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-spatial-store-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, 'evidence'));
  fs.writeFileSync(path.join(dataDir, 'evidence', 'frame.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>SIMULATED EVIDENCE</text></svg>');
  const store = new SpatialStore({ dataDir });
  store.registerEntity({ id: 'blue-keys', label: 'Blue keyring', aliases: ['my keys'], appearance: 'Keys on a blue ring', priority: 'explicit' });
  function observation(n, overrides = {}) {
    const poseRef = `pose-${n}`;
    store.recordPose({ id: poseRef, mapId: 'desk', capturedAt: iso(n), worldFromCamera: matrix, trackingState: 'tracking' });
    return { id: `obs-${n}`, entityId: 'blue-keys', capturedAt: iso(n), source: n === 1 ? 'active' : 'passive', frameId: `frame-${n}`, evidence: { imagePath: 'evidence/frame.svg', crop: [.2,.2,.3,.3], synthetic: true }, mapId: 'desk', position: [n * .1,.75,0], method: 'depth', uncertaintyM: .04, status: 'seen', poseRef, semantics: { support: 'table' }, ...overrides };
  }
  return { store, dataDir, observation };
}

test('active priority survives passive position updates, occlusion, and user reports', t => {
  const { store, observation } = fixture(t);
  store.addObservation(observation(1));
  store.addObservation(observation(2));
  store.addObservation(observation(3, { status: 'not_seen', position: null, method: 'unlocalized', uncertaintyM: null, evidence: { imagePath: 'evidence/frame.svg', crop: null, synthetic: true } }));
  store.addUserReport({ entityId: 'blue-keys', capturedAt: iso(4), text: 'I put them in a drawer.' });
  const result = store.query({ entityId: 'blue-keys' });
  assert.equal(result.entity.priority, 'explicit');
  assert.equal(result.lastSeen.id, 'obs-2');
  assert.deepEqual(result.lastSeen.position, [.2,.75,0]);
  assert.equal(result.latestCheck.status, 'not_seen');
  assert.equal(store.snapshot().userReports.length, 1);
  assert.equal(store.snapshot().observations.length, 3);
  const change = store.snapshot().events.find(event => event.type === 'position_changed');
  assert.deepEqual(change.observationIds, ['obs-1', 'obs-2']);
});

test('late API results preserve capture chronology and as-of queries', t => {
  const { store, observation } = fixture(t);
  store.addObservation(observation(3));
  store.addObservation(observation(1));
  store.addObservation(observation(2));
  assert.equal(store.query({ entityId: 'blue-keys' }).lastSeen.id, 'obs-3');
  assert.equal(store.query({ entityId: 'blue-keys', at: iso(2) }).lastSeen.id, 'obs-2');
  assert.equal(store.query({ entityId: 'blue-keys', at: iso(0) }).lastSeen, null);
  assert.deepEqual(store.history('blue-keys').map(item => item.id), ['obs-1', 'obs-2', 'obs-3']);
  assert.deepEqual(store.snapshot().events.filter(event => event.type === 'position_changed').map(event => event.observationIds), [['obs-1','obs-2'], ['obs-2','obs-3']]);
});

test('entity aliases are extended and explicit priority is never silently demoted', t => {
  const { store } = fixture(t);
  store.registerEntity({ id: 'blue-keys', label: 'Blue keyring', aliases: ['钥匙'], priority: 'background' });
  assert.deepEqual(store.query({ entityId: 'blue-keys' }).entity.aliases, ['my keys', '钥匙']);
  assert.equal(store.query({ entityId: 'blue-keys' }).entity.priority, 'explicit');
  assert.equal(store.snapshot().entities.length, 1);
});

test('pose/frame binding, evidence existence and provenance are validated before insert', t => {
  const { store, observation, dataDir } = fixture(t);
  const good = observation(1);
  assert.throws(() => store.addObservation({ ...good, capturedAt: iso(2) }), /capture-time pose/);
  assert.throws(() => store.addObservation({ ...good, mapId: 'other-map' }), /same map/);
  assert.throws(() => store.addObservation({ ...good, evidence: { ...good.evidence, imagePath: 'missing.png' } }), /ENOENT/);
  const outside = path.join(path.dirname(dataDir), `${path.basename(dataDir)}-outside.svg`);
  fs.writeFileSync(outside, '<svg/>');
  t.after(() => fs.rmSync(outside, { force: true }));
  assert.throws(() => store.addObservation({ ...good, evidence: { ...good.evidence, imagePath: outside } }), /inside dataDir/);
  fs.symlinkSync(outside, path.join(dataDir, 'evidence', 'escape.svg'));
  assert.throws(() => store.addObservation({ ...good, evidence: { ...good.evidence, imagePath: 'evidence/escape.svg' } }), /inside dataDir/);
  assert.throws(() => store.addObservation({ ...good, position: [NaN,0,0] }), /finite metric/);
  assert.throws(() => store.addObservation({ ...good, status: 'not_seen' }), /unseen object/);
  assert.equal(store.snapshot().observations.length, 0);
  const inserted = store.addObservation(good);
  assert.equal(inserted.evidence.sha256.length, 64);
  assert.equal(inserted.evidence.imagePath, 'evidence/frame.svg');
});

test('RGB-only observations remain unlocalized without inventing pose', t => {
  const { store, observation } = fixture(t);
  const input = observation(1, { poseRef: null, mapId: null, position: null, method: 'unlocalized', uncertaintyM: null });
  const inserted = store.addObservation(input);
  assert.equal(inserted.position, null);
  assert.equal(inserted.poseRef, null);
  assert.equal(inserted.mapId, null);
  assert.equal(store.query({ entityId: 'blue-keys' }).lastSeen.id, input.id);
  const withMissingPose = { ...input, id: 'bad', method: 'depth', position: [0,.75,0] };
  assert.throws(() => store.addObservation(withMissingPose), /missing or lost pose/);
});

test('stored facts survive restart and reads cannot mutate them', t => {
  const { store, observation, dataDir } = fixture(t);
  const input = observation(1);
  store.addObservation(input);
  store.addObservation(input); // delivery retry is idempotent
  assert.equal(store.snapshot().observations.length, 1);
  assert.throws(() => store.addObservation({ ...input, position: [10,10,10] }), /cannot be overwritten/);
  const restored = new SpatialStore({ dataDir });
  const snapshot = restored.snapshot();
  snapshot.entities[0].label = 'Changed outside';
  assert.equal(restored.query({ entityId: 'blue-keys' }).entity.label, 'Blue keyring');
  assert.equal(restored.query({ entityId: 'blue-keys' }).lastSeen.id, 'obs-1');
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['evidence', 'spatial-memory.json']);
});

test('a frame batch rejects all observations when its second detection is invalid', t => {
  const { store, observation, dataDir } = fixture(t);
  store.registerEntity({ id: 'wallet', label: 'Wallet', aliases: [], priority: 'background' });
  const first = observation(1);
  const second = { ...first, id: 'wallet-obs-1', entityId: 'wallet', semantics: { invalid: NaN } };
  const before = store.snapshot();
  const diskBefore = fs.readFileSync(path.join(dataDir, 'spatial-memory.json'), 'utf8');
  assert.throws(() => store.addObservations([first, second]), /non-finite/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(fs.readFileSync(path.join(dataDir, 'spatial-memory.json'), 'utf8'), diskBefore);
  const valid = { ...second, semantics: { support: 'table' } };
  const records = store.addObservations([first, valid]);
  assert.equal(records.length, 2);
  assert.equal(store.query({ entityId: 'blue-keys' }).lastSeen.id, first.id);
  assert.equal(store.query({ entityId: 'wallet' }).lastSeen.id, valid.id);
  const restored = new SpatialStore({ dataDir });
  assert.equal(restored.snapshot().observations.length, 2);
});

test('RGB-only observations and user reports reject timezone-less timestamps', t => {
  const { store, observation } = fixture(t);
  const input = observation(1, { poseRef: null, mapId: null, position: null, method: 'unlocalized', uncertaintyM: null, capturedAt: '2026-10-24T20:00:01' });
  assert.throws(() => store.addObservation(input), /with a timezone/);
  assert.throws(() => store.addUserReport({ entityId: 'blue-keys', capturedAt: '2026-10-24T20:00:01', text: 'In the drawer.' }), /with a timezone/);
  assert.throws(() => store.query({ entityId: 'blue-keys', at: '2026-10-24T20:00:01' }), /with a timezone/);
  assert.equal(store.snapshot().observations.length, 0);
  const withOffset = { ...input, capturedAt: '2026-10-24T13:00:01-07:00' };
  assert.equal(store.addObservation(withOffset).capturedAt, '2026-10-24T20:00:01.000Z');
});

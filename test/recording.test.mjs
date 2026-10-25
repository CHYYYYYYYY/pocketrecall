import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RunSession } from '../lib/run-session.mjs';
import { validateRecording, recordingFrame } from '../lib/recording.mjs';

const fixturePath = fileURLToPath(new URL('../public/assets/demo-manifest.json', import.meta.url));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
const pose = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
export function recordingFixture() {
  return { schemaVersion: 1, provenance: 'dataset_annotations', source: { dataset: 'Unit-test annotations, not HD-EPIC data' },
    mapId: 'annotated-room', coordinateUnits: 'meters', imageSpace: 'letterboxed_square',
    video: { name: 'kitchen.mp4', duration: 10, width: 1920, height: 1080 },
    entities: [{ id: 'cup_1', label: '杯子', aliases: ['cup'], priority: 'explicit' }],
    points: [[0, 0, 2, '#ffffff']],
    frames: [
      { videoTime: 1, worldFromCamera: pose, detections: [{ entityId: 'cup_1', status: 'seen', bbox: [.3,.3,.5,.5], worldPosition: [0,0,2] }] },
      { videoTime: 4, worldFromCamera: pose, detections: [{ entityId: 'cup_1', status: 'seen', bbox: [.4,.4,.6,.6], worldPosition: [1,0,3] }] },
      { videoTime: 7, worldFromCamera: pose, detections: [{ entityId: 'cup_1', status: 'not_seen' }] },
    ],
  };
}

test('recording validation enforces identity, geometry, camera pose and temporal alignment', () => {
  const pack = validateRecording(recordingFixture());
  assert.equal(recordingFrame(pack, 1).detections[0].semantics.modelPrediction, false);
  assert.throws(() => recordingFrame(pack, .99), /not aligned/, 'future annotation cannot appear early');
  assert.throws(() => recordingFrame(pack, 2), /not aligned/);
  for (const change of [
    p => { p.frames[0].detections[0].worldPosition = [0, NaN, 1]; },
    p => { p.frames[0].detections[0].entityId = 'missing'; },
    p => { p.frames[1].videoTime = 1; },
    p => { p.frames[2].detections[0].worldPosition = [1, 2, 3]; },
    p => { p.coordinateUnits = 'unknown'; },
    p => { p.frames[0].worldFromCamera = Array(16).fill(0); },
  ]) { const bad = recordingFixture(); change(bad); assert.throws(() => validateRecording(bad)); }
});

test('dataset replay stores 3D memory progressively with evidence, history and restart recovery', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-recording-'));
  let calls = 0;
  const run = new RunSession({ dataDir, fixturePath, vision: { configured: true, analyze: () => { calls++; throw new Error('must not call model'); } }, reconstruction: { configured: false } });
  t.after(() => { run.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const pack = recordingFixture();
  assert.throws(() => run.importRecording({ sessionId: run.session.id, recording: pack, video: { ...pack.video, name: 'wrong.mp4' } }), /does not match/);
  const started = run.importRecording({ sessionId: run.session.id, recording: pack, video: pack.video });
  assert.equal(started.objects[0].lastSeen, null); assert.equal(started.map.reference, true);
  assert.equal(started.recording.frameTimes.length, 3); assert.equal(started.observationCount, 0);
  const frame = videoTime => run.ingest({ sessionId: run.session.id, seq: run.session.lastSeq + 1, videoTime, imageDataUrl: PNG });
  await assert.rejects(frame(.99), /not aligned/);
  await frame(1); const first = run.state().objects[0].lastSeen;
  assert.equal(first.method, 'annotation'); assert.equal(first.evidence.synthetic, false);
  assert.deepEqual(first.position, [0,0,2]); assert.equal(first.semantics.provider, 'dataset_annotation');
  run.query({ sessionId: run.session.id, text: '找杯子' });
  assert.equal(run.guidance().videoConfirmed, false);
  await frame(4); assert.equal(run.guidance().videoConfirmed, true);
  await frame(7); assert.equal(run.guidance().videoConfirmed, false);
  const last = run.state().objects[0]; assert.deepEqual(last.lastSeen.position, [1,0,3]); assert.equal(last.latestCheck.status, 'not_seen');
  assert.equal(run.search({ sessionId: run.session.id, mapId: pack.mapId, near: [0,0,0], at: first.capturedAt }).results[0].distance, 2);
  assert.equal(run.pipeline.store.history('cup_1').length, 3);
  const diskSession = JSON.parse(fs.readFileSync(path.join(run.dir, 'session.json'), 'utf8'));
  assert.equal(diskSession.map.points, undefined, 'geometry lives in its own durable file');
  assert.equal(diskSession.recording, undefined, 'future source annotations are not UI state');
  assert.equal(run.export().session.recording, undefined);
  const reopened = new RunSession({ dataDir, fixturePath });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.state().objects[0].lastSeen.position, [1,0,3]);
  assert.equal(reopened.state().objects[0].label, '杯子', 'imported dataset labels are user content and stay unchanged');
  assert.deepEqual(reopened.state().map.points, pack.points);
  assert.equal(reopened.map(pack.mapId).poses.length, 3);
  assert.equal(reopened.map(pack.mapId).objects[0].lastSeen.id, last.lastSeen.id);
  assert.equal(calls, 0);
  const restarted = reopened.start({ mode: 'recording' }); assert.equal(restarted.observationCount, 0); assert.equal(restarted.recording.video.name, pack.video.name);
});

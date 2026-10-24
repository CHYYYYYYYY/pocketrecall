import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SpatialPipeline, replayManifest } from '../lib/spatial/pipeline.mjs';
import { createScenario, cameraPose } from '../fixtures/spatial-demo/scenario.mjs';
import { runSpatialDemo } from '../scripts/spatial-demo.mjs';

function workspace(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pocketrecall-spatial-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function setup(t){const dir=workspace(t),manifest=createScenario(path.join(dir,'input'));const pipeline=new SpatialPipeline({dataDir:path.join(dir,'memory')});for(const entity of manifest.entities)pipeline.register(entity);return {dir,manifest,pipeline,frame:structuredClone(manifest.events[0].frame)};}

test('complete spatial scenario preserves evidence, changes guidance and reacquires',t=>{
  const dir=workspace(t);const result=runSpatialDemo(path.join(dir,'run'));
  assert.equal(result.report.passed,true);assert.equal(result.report.checks.length,11);
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'run','manifest.json'),'utf8'));
  const replay=replayManifest(manifest,{dataDir:path.join(dir,'replay'),baseDir:path.join(dir,'run')});
  assert.equal(replay.snapshot.observations.length,8);
  assert.deepEqual(replay.snapshot.observations.map(o=>o.position),result.snapshot.observations.map(o=>o.position));
});

test('RGB-only real frame remains evidence-backed and spatially unlocalized',t=>{
  const {dir,pipeline,frame}=setup(t);delete frame.pose;delete frame.intrinsics;
  frame.synthetic=false;frame.imagePath=path.join(dir,'real-frame.png');
  fs.writeFileSync(frame.imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=','base64'));
  const result=pipeline.ingest(frame);assert.ok(result.observations.every(o=>o.position===null&&o.method==='unlocalized'&&o.poseRef===null));
  const answer=pipeline.recall('keys',{at:frame.capturedAt});assert.equal(answer.guidance.status,'unlocalized');assert.equal(answer.confirmedNow,false);assert.ok(answer.lastSeen.evidence.imagePath);
});

test('capture timestamp mismatch and altered analyzed bytes fail without observations',t=>{
  const {pipeline,frame}=setup(t);frame.pose.capturedAt='2026-10-24T20:00:00.001Z';
  assert.throws(()=>pipeline.ingest(frame),/timestamps must match/);assert.equal(pipeline.store.snapshot().observations.length,0);
  frame.pose.capturedAt=frame.capturedAt;frame.imageSha256=createHash('sha256').update('different image').digest('hex');
  assert.throws(()=>pipeline.ingest(frame),/hash mismatch/);assert.equal(pipeline.store.snapshot().observations.length,0);
});

test('late perception uses capture pose, without replacing a newer current pose',t=>{
  const {pipeline,frame}=setup(t);pipeline.setPose(cameraPose('new-current-pose',25,.9));
  pipeline.ingest(frame);const last=pipeline.store.query({entityId:'keys'}).lastSeen;
  assert.deepEqual(last.position.map(x=>Math.round(x*1000)/1000),[-.45,.75,0]);
  const answer=pipeline.recall('keys',{at:'2026-10-24T20:00:25.000Z'});assert.ok(answer.guidance.bearingDeg<0);assert.equal(pipeline.currentPose.id,'new-current-pose');assert.equal(answer.confirmedNow,false);
});

test('a stale pose never confirms presence or emits directional guidance',t=>{
  const {pipeline,frame}=setup(t);pipeline.ingest(frame);
  assert.equal(pipeline.recall('keys',{at:frame.capturedAt}).confirmedNow,true);
  const stale=pipeline.recall('keys',{at:'2026-10-24T20:00:10.000Z'});assert.equal(stale.confirmedNow,false);assert.equal(stale.guidance.status,'relocalize');assert.equal(stale.guidance.distanceM,null);
});

test('a partially invalid frame cannot commit any entity observation',t=>{
  const {pipeline,frame}=setup(t);frame.detections[1].semantics='bad';
  assert.throws(()=>pipeline.ingest(frame),/Semantics/);assert.equal(pipeline.store.snapshot().observations.length,0);
});

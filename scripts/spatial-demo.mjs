import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createScenario } from '../fixtures/spatial-demo/scenario.mjs';
import { replayManifest, SpatialPipeline } from '../lib/spatial/pipeline.mjs';

export function runSpatialDemo(outputDirectory) {
  const output = path.resolve(outputDirectory);
  if (fs.existsSync(path.join(output, 'trace.json'))) throw new Error('Output already contains a replay. Choose a new --out directory; previous runs are preserved.');
  fs.mkdirSync(output, { recursive:true });
  const manifest = createScenario(path.join(output,'input-frames'));
  const { pipeline, trace, snapshot } = replayManifest(manifest, { dataDir:path.join(output,'memory') });
  const query = label => trace.find(event => event.label === label && event.type === 'query').result;
  const checks = [];
  const check = (label, fn) => { fn(); checks.push({ label, passed:true }); };
  check('passive observation updates an explicitly registered object',()=>{ const before=query('before-viewpoint-change'); assert.equal(before.entity.priority,'explicit'); assert.equal(before.lastSeen.source,'passive'); assert.deepEqual(before.lastSeen.position.map(x=>Math.round(x*1000)/1000),[.5,.75,0]); });
  check('occlusion preserves last-seen evidence',()=>{const q=query('before-viewpoint-change');assert.equal(q.latestCheck.status,'not_seen');assert.equal(q.lastSeen.frameId,'passive-move');assert.equal(q.confirmedNow,false);});
  check('same world target changes direction after camera movement',()=>{assert.ok(query('before-viewpoint-change').guidance.bearingDeg>0);assert.ok(query('after-viewpoint-change').guidance.bearingDeg<0);});
  check('lost tracking and mismatched maps suppress directions',()=>{for(const label of ['lost-tracking','wrong-map']){assert.equal(query(label).guidance.status,'relocalize');assert.equal(query(label).guidance.bearingDeg,null);}});
  check('reacquisition produces a fresh visual confirmation',()=>{assert.equal(query('reacquired').confirmedNow,true);assert.equal(query('reacquired').lastSeen.frameId,'reacquired');});
  check('never-seen item has no invented location',()=>{assert.equal(query('never-seen').lastSeen,null);assert.equal(query('never-seen').guidance.status,'unlocalized');});
  check('user reports do not overwrite visual evidence',()=>assert.equal(query('report-is-not-visual').lastSeen.frameId,'reacquired'));
  check('every observation references a real retained evidence file',()=>{for(const observation of snapshot.observations)assert.ok(fs.statSync(path.join(output,'memory',observation.evidence.imagePath)).size>0);});
  check('capture metadata preserves intrinsics, pose and position inputs',()=>{for(const observation of snapshot.observations){const frame=JSON.parse(fs.readFileSync(path.join(output,'memory','frames',`${observation.frameId}.json`),'utf8'));assert.equal(frame.pose.id,observation.poseRef);assert.ok(frame.intrinsics.fx>0);assert.ok(frame.imageSha256);assert.ok(frame.detections.some(d=>d.entityId===observation.entityId));}});
  check('stale current pose cannot produce directions or fresh confirmation',()=>{const result=pipeline.recall('keys',{at:'2026-10-24T20:05:00.000Z'});assert.equal(result.guidance.status,'relocalize');assert.equal(result.guidance.bearingDeg,null);assert.equal(result.confirmedNow,false);});
  check('memory survives reload, but current pose does not',()=>{const restored=new SpatialPipeline({dataDir:path.join(output,'memory')});assert.equal(restored.store.query({entityId:'keys'}).lastSeen.frameId,'reacquired');assert.equal(restored.recall('keys').guidance.status,'unlocalized');});
  const portableManifest = structuredClone(manifest);
  for(const event of portableManifest.events)if(event.type==='frame')event.frame.imagePath=path.relative(output,event.frame.imagePath);
  const report={passed:true,mode:'synthetic-input-real-pipeline',checks,counts:{entities:snapshot.entities.length,observations:snapshot.observations.length,events:snapshot.events.length},limitations:['No real Gemini calls','No measured camera/SLAM accuracy','No live microphone or camera','Synthetic known instance IDs; identity recognition is an adapter responsibility'],queries:trace.filter(t=>t.type==='query').map(t=>({label:t.label,...t.result}))};
  for(const [name,data] of [['manifest.json',portableManifest],['trace.json',trace],['snapshot.json',snapshot],['report.json',report]])fs.writeFileSync(path.join(output,name),JSON.stringify(data,null,2)+'\n');
  return {output,report,trace,snapshot};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);const i=args.indexOf('--out');
  if(args.length&&!(i===0&&args.length===2))throw new Error('Usage: node scripts/spatial-demo.mjs [--out DIRECTORY]');
  const output=i>=0?args[i+1]:path.join('.pocketrecall-data','spatial-demo',new Date().toISOString().replace(/[:.]/g,'-'));
  const result=runSpatialDemo(output);console.log(JSON.stringify({passed:result.report.passed,checks:result.report.checks.length,...result.report.counts,output:result.output},null,2));
}

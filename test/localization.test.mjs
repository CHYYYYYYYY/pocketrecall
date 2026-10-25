import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RunSession } from '../lib/run-session.mjs';
const image=fs.readFileSync(new URL('../public/assets/demo-poster.jpg',import.meta.url));
const imageDataUrl='data:image/jpeg;base64,'+image.toString('base64');
const pose=(time,x=0)=>({id:'sensor_pose',mapId:'room',capturedAt:time,trackingState:'tracking',worldFromCamera:[1,0,0,x,0,-1,0,0,0,0,-1,0,0,0,0,1]});
async function setup(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'pocket-local-'));
  const options={dataDir,fixturePath:new URL('../public/assets/demo-manifest.json',import.meta.url),vision:{configured:true,model:'test',analyze:async()=>[{entityId:'keys',status:'seen',bbox:[.4,.4,.6,.6],semantics:{provider:'test'}}]}};
  const run=new RunSession(options);t.after(()=>{run.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  run.start({mode:'video',filename:'real-rgb.mp4'});
  await run.ingest({sessionId:run.session.id,seq:1,videoTime:0,imageDataUrl});
  const frame=run.session.frames[0];
  const packet={sessionId:run.session.id,frameId:frame.id,imageSha256:createHash('sha256').update(image).digest('hex'),coordinateUnits:'meters',provenance:{kind:'sensor',source:'test calibrated RGB-D'},pose:pose(frame.capturedAt),intrinsics:{width:518,height:518,fx:518,fy:518,cx:259,cy:259},depth:{width:8,height:8,data:Array(64).fill(2)}};
  return {run,packet,options};
}

test('capture-bound depth creates persistent geometry and current tracked pose controls guidance',async t=>{
  const {run,packet,options}=await setup(t);
  run.attachGeometry(packet);
  assert.deepEqual(run.state().objects[0].lastSeen.position,[0,0,-2]);
  assert.equal(run.state().map.id,'room');
  run.query({sessionId:run.session.id,text:'Find keys'});
  assert.equal(run.guidance().simulatedUser,true);
  run.updatePose({sessionId:run.session.id,coordinateUnits:'meters',pose:pose(new Date().toISOString(),1)});
  assert.equal(run.guidance().simulatedUser,false);
  assert.ok(run.guidance().bearingDeg<0);
  run.query({sessionId:run.session.id,text:'Find keys'});
  assert.ok(run.guidance().bearingDeg<0,'a query must not teleport the wearer');
  const restored=new RunSession(options);t.after(()=>restored.close());
  assert.equal(restored.state().objects[0].lastSeen.position[2],-2);
  assert.equal(restored.guidance().status,'relocalize','restart requires a fresh tracked pose');
});

test('wrong image, map, units and stale tracking cannot publish misleading guidance',async t=>{
  const {run,packet}=await setup(t);
  assert.throws(()=>run.attachGeometry({...packet,imageSha256:'0'.repeat(64)}),/image|capture/i);
  assert.equal(run.state().map,null);
  run.attachGeometry(packet);
  assert.throws(()=>run.attachGeometry(packet),/already/i);
  run.query({sessionId:run.session.id,text:'Find keys'});
  assert.throws(()=>run.updatePose({sessionId:run.session.id,coordinateUnits:'relative',pose:pose(new Date().toISOString())}),/units/i);
  assert.throws(()=>run.updatePose({sessionId:run.session.id,coordinateUnits:'meters',pose:{...pose(new Date().toISOString()),mapId:'other'}}),/map/i);
  assert.throws(()=>run.updatePose({sessionId:run.session.id,coordinateUnits:'meters',pose:pose('2020-01-01T00:00:00Z')}),/fresh|stale/i);
  run.updatePose({sessionId:run.session.id,coordinateUnits:'meters',pose:{...pose(new Date().toISOString()),trackingState:'lost'}});
  assert.equal(run.guidance().status,'relocalize');
  assert.equal(run.guidance().pulse.enabled,false);
  assert.deepEqual(run.guidance().haptic,[]);
});

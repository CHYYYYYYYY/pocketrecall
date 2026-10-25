import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { perceiveFrame } from '../lib/spatial/perception.mjs';
import { createVisionClient } from '../lib/vision.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV9sAAAAASUVORK5CYII=', 'base64');
const frame = () => ({ id:'capture_1',capturedAt:'2026-10-24T12:00:00Z',source:'active',pose:{id:'pose_1',mapId:'desk_1',capturedAt:'2026-10-24T12:00:00Z',trackingState:'tracking',worldFromCamera:[1,0,0,0,0,-1,0,1.5,0,0,-1,2,0,0,0,1]},intrinsics:{fx:500,fy:500,cx:320,cy:240,width:640,height:480} });
async function fixture(t) { const dir = await mkdtemp(path.join(os.tmpdir(),'pocketrecall-perception-'));t.after(()=>rm(dir,{recursive:true,force:true}));const imagePath=path.join(dir,'frame.png');await writeFile(imagePath,png);return imagePath; }

test('real-frame adapter preserves capture metadata and only accepts sensor geometry', async t => {
  const imagePath=await fixture(t), original=frame();
  original.objectGeometry={blue_keys:{depthM:2,uncertaintyM:.05}};
  const expected=structuredClone(original);
  const controller=new AbortController();
  const vision={configured:true,model:'injected-test',async analyzeFrame(data,{signal}) {
    assert.match(data,/^data:image\/png;base64,/);assert.equal(signal,controller.signal);
    original.capturedAt='2026-10-24T12:01:00Z';original.pose.worldFromCamera[3]=10;
    return {items:{keys:{status:'seen',bbox:[.4,.5,.6,.7],depthM:999},wallet:{status:'not_seen',bbox:null},earbuds:{status:'unclear',bbox:null}}};
  }};
  const result=await perceiveFrame({imagePath,frame:original,bindings:{keys:'blue_keys',wallet:'black_wallet',earbuds:'white_case'},vision,signal:controller.signal});
  assert.equal(result.id,expected.id);assert.equal(result.capturedAt,expected.capturedAt);
  assert.deepEqual(result.pose,expected.pose);assert.deepEqual(result.intrinsics,expected.intrinsics);
  assert.equal(result.synthetic,false);assert.equal(result.source,'active');assert.equal(result.skipIngest,false);
  assert.match(result.imageSha256,/^[a-f0-9]{64}$/);
  assert.equal(result.detections[0].entityId,'blue_keys');assert.equal(result.detections[0].depthM,2);
  assert.deepEqual(result.detections[0].bbox,[.4,.5,.6,.7]);
  assert.equal(result.detections[1].status,'not_seen');assert.equal(result.detections[1].depthM,undefined);
  assert.deepEqual(result.skippedDetections,[{category:'earbuds',entityId:'white_case',reason:'unclear'}]);
});

test('all unclear detections explicitly skip ingest rather than writing false absence', async t => {
  const imagePath=await fixture(t);
  const result=await perceiveFrame({imagePath,frame:{id:'rgb_1',capturedAt:'2026-10-24T12:00:00Z'},bindings:{keys:'blue_keys'},vision:{async analyzeFrame(){return {items:{keys:{status:'unclear',bbox:null}}};}}});
  assert.equal(result.source,'passive');assert.equal(result.skipIngest,true);assert.deepEqual(result.detections,[]);
  assert.equal(result.skippedDetections[0].reason,'unclear');assert.equal(result.pose,undefined);
});

test('missing key or provider failure propagates and never produces simulated observations', async t => {
  const imagePath=await fixture(t);
  let called=false;
  await assert.rejects(perceiveFrame({imagePath,frame:frame(),bindings:{keys:'blue_keys'},vision:createVisionClient({apiKey:'',fetchImpl:async()=>{called=true;}})}),/not configured/);
  assert.equal(called,false);
  await assert.rejects(perceiveFrame({imagePath,frame:frame(),bindings:{keys:'blue_keys'},vision:{async analyzeFrame(){throw new Error('provider unavailable');}}}),/provider unavailable/);
});

test('rejects malformed images and ambiguous bindings before calling vision', async t => {
  const imagePath=await fixture(t);let calls=0;
  const vision={async analyzeFrame(){calls++;return {items:{keys:{status:'seen',bbox:[0,0,1,1]}}};}};
  await assert.rejects(perceiveFrame({imagePath,frame:frame(),bindings:{keys:'same',wallet:'same'},vision}),/distinct/);
  await writeFile(imagePath,'not a JPEG or PNG');
  await assert.rejects(perceiveFrame({imagePath,frame:frame(),bindings:{keys:'blue_keys'},vision}),/not a valid/);
  await writeFile(imagePath,Buffer.alloc(4*1024*1024+1));
  await assert.rejects(perceiveFrame({imagePath,frame:frame(),bindings:{keys:'blue_keys'},vision}),/4 MB/);
  assert.equal(calls,0);
});

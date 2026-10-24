import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePose, unprojectToWorld, intersectPlane, worldToCamera, guideToTarget } from '../lib/spatial/geometry.mjs';

const intrinsics = { fx: 500, fy: 500, cx: 320, cy: 240, width: 640, height: 480 };
const pose = (x = 0, y = 1.5, z = 2) => ({ mapId: 'desk-map', capturedAt: '2026-10-24T12:00:00Z', trackingState: 'tracking', worldFromCamera: [1,0,0,x, 0,-1,0,y, 0,0,-1,z, 0,0,0,1] });
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-9, `${a} != ${b}`);
const nearVector = (a,b) => a.forEach((v,i)=>near(v,b[i]));

test('metric projection preserves capture pose and inverts through worldToCamera', () => {
  const captured = pose(1, 1.5, 3);
  const world = unprojectToWorld({ pixel:[420,340], depthM:2, intrinsics, pose:captured });
  nearVector(world,[1.4,1.1,1]);
  nearVector(worldToCamera(world,captured),[.4,.4,2]);
  // A later camera position must not be substituted for the capture-time pose.
  nearVector(worldToCamera(world,pose(2,1.5,3)),[-.6,.4,2]);
});

test('world-space table intersection is metric and handles parallel or rear-facing rays', () => {
  const plane={normal:[0,1,0],offset:-.75};
  nearVector(intersectPlane({pixel:[320,427.5], intrinsics, pose:pose(),plane}),[0,.75,0]);
  nearVector(intersectPlane({pixel:[320,427.5], intrinsics, pose:pose(),plane:{normal:[0,4,0],offset:-3}}),[0,.75,0]);
  assert.equal(intersectPlane({pixel:[320,240],intrinsics,pose:pose(),plane}),null);
  assert.equal(intersectPlane({pixel:[320,100],intrinsics,pose:pose(),plane}),null);
});

test('guidance changes correctly across viewpoints and handles targets behind camera', () => {
  const target={mapId:'desk-map',position:[0,.75,0],uncertaintyM:null};
  const fromLeft=guideToTarget({target,pose:pose(-1)});
  const fromRight=guideToTarget({target,pose:pose(1)});
  assert.equal(fromLeft.status,'direction');
  assert.ok(fromLeft.bearingDeg>0);
  assert.ok(fromRight.bearingDeg<0);
  near(fromLeft.distanceM,fromRight.distanceM);
  assert.match(fromLeft.instruction,/camera right/);
  assert.match(fromRight.instruction,/camera left/);
  assert.ok(fromLeft.elevationDeg<0);
  assert.equal(fromLeft.uncertaintyM,null);
  assert.equal(fromLeft.distanceApproximate,true);
  assert.equal(fromLeft.requiresVisualConfirmation,true);
  const away=pose();
  away.worldFromCamera=[-1,0,0,0, 0,-1,0,1.5, 0,0,1,2, 0,0,0,1];
  assert.match(guideToTarget({target,pose:away}).instruction,/behind/);
});

test('lost tracking, map mismatch, and unmapped memories never yield directions', () => {
  const target={mapId:'desk-map',position:[0,.75,0],uncertaintyM:.1};
  for (const result of [guideToTarget({target,pose:{...pose(),trackingState:'lost'}}),guideToTarget({target,pose:{...pose(),mapId:'another-map'}})]) {
    assert.equal(result.status,'relocalize');
    assert.equal(result.distanceM,null);
    assert.equal(result.bearingDeg,null);
  }
  assert.equal(guideToTarget({target,pose:null}).status,'unlocalized');
  assert.equal(guideToTarget({target:{mapId:'desk-map',position:null},pose:pose()}).status,'unlocalized');
});

test('rejects invalid transforms, depth, image coordinates, calibration, and target geometry', () => {
  assert.equal(validatePose(pose()).mapId,'desk-map');
  for (const index of [0,5,10]) {
    const p=pose();p.worldFromCamera[index]*=2;
    assert.throws(()=>validatePose(p),/orthonormal/);
  }
  const reflection=pose();reflection.worldFromCamera[0]=-1;
  assert.throws(()=>validatePose(reflection),/right-handed/);
  const shear=pose();shear.worldFromCamera[1]=.2;
  assert.throws(()=>validatePose(shear),/orthonormal/);
  assert.throws(()=>validatePose({...pose(),capturedAt:'not-a-time'}),/timestamp/);
  assert.throws(()=>validatePose({...pose(),worldFromCamera:null}),/16 finite/);
  for(const depthM of [0,-1,NaN,Infinity,null]) assert.throws(()=>unprojectToWorld({pixel:[320,240],depthM,intrinsics,pose:pose()}),/depthM/);
  for(const pixel of [[-1,0],[640,240],[320,480],[null,0],[NaN,0]]) assert.throws(()=>unprojectToWorld({pixel,depthM:1,intrinsics,pose:pose()}));
  assert.throws(()=>unprojectToWorld({pixel:[320,240],depthM:1,intrinsics:{...intrinsics,fx:0},pose:pose()}),/focal/);
  assert.throws(()=>unprojectToWorld({pixel:[320,240],depthM:1,intrinsics,pose:{...pose(),trackingState:'lost'}}),/tracking is lost/);
  assert.throws(()=>intersectPlane({pixel:[320,240],intrinsics,pose:pose(),plane:{normal:[0,0,0],offset:0}}),/nonzero/);
  assert.throws(()=>guideToTarget({target:{mapId:'desk-map',position:[null,0,0]},pose:pose()}),/finite/);
  assert.throws(()=>guideToTarget({target:{mapId:'desk-map',position:[0,0,0],uncertaintyM:-1},pose:pose()}),/uncertainty/);
});

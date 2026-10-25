import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPoseWindows, transformOutput, selectKeyframes } from '../lib/spatial/alignment.mjs';

const pose = (x,y,z,rotation=[1,0,0,0,1,0,0,0,1]) => ({ mapId:'map', capturedAt:'2026-10-24T12:00:00Z', trackingState:'tracking', worldFromCamera:[...rotation.slice(0,3),x,...rotation.slice(3,6),y,...rotation.slice(6,9),z,0,0,0,1] });
const points = [[0,0,0],[1,0,0],[1,1,0],[1,1,2]];
const rotation = [0,0,1,0,1,0,-1,0,0];
const expected = p => [2*p[2]+10,2*p[1]-3,-2*p[0]+5];

test('shared capture poses recover scale, orientation and translation without moving remembered objects', () => {
  const pairs = points.map(p => ({ local:pose(...p), world:pose(...expected(p),rotation) }));
  const transform = alignPoseWindows(pairs);
  assert.ok(Math.abs(transform.scale-2)<1e-10);
  const out=transformOutput({pose:pose(2,3,4),points:[[2,3,4,'#ffffff']],detections:[{status:'seen',depthM:3}],intrinsics:{}},transform,'world');
  assert.deepEqual(out.points[0], [...expected([2,3,4]),'#ffffff']);
  assert.deepEqual([out.pose.worldFromCamera[3],out.pose.worldFromCamera[7],out.pose.worldFromCamera[11]],expected([2,3,4]));
  assert.equal(out.detections[0].depthM,6);
  assert.equal(out.pose.mapId,'world');
});

test('alignment rejects stationary, inconsistent and insufficient overlap', () => {
  const pairs=points.map(p=>({local:pose(...p),world:pose(...p)}));
  assert.throws(()=>alignPoseWindows(pairs.slice(0,2)),/three|overlap/i);
  assert.throws(()=>alignPoseWindows(points.map(()=>({local:pose(0,0,0),world:pose(0,0,0)}))),/baseline/i);
  pairs[3].world=pose(20,0,0);
  assert.throws(()=>alignPoseWindows(pairs),/residual|alignment/i);
  const orientations=points.map(p=>({local:pose(...p),world:pose(...p)}));
  orientations[2].world=pose(1,1,0,rotation);
  assert.throws(()=>alignPoseWindows(orientations),/rotation|orientation/i);
});

test('subsequent windows retain shared anchors and new frames, never exceed eight', () => {
  const frames=Array.from({length:15},(_,i)=>({id:`f${i}`,mappedPose:i<8?pose(i,0,0):null}));
  const selected=selectKeyframes(frames,true);
  assert.equal(selected.length,8);
  assert.equal(selected.filter(f=>f.mappedPose).length,3);
  assert.equal(selected.at(-1).id,'f14');
  assert.deepEqual(selectKeyframes(frames.slice(0,8),true),[]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { convertHdEpic } from '../lib/hd-epic.mjs';

const matrix = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
function input() {
  return {
    videoId: 'test-video',
    associations: { 'test-video': { cup: { name: 'cup', tracks: [{ track_id: 'move-1', masks: ['m1', 'm2'] }, { track_id: 'move-2', masks: ['m3'] }] } } },
    masks: { 'test-video': {
      m1: { frame_number: 60, '3d_location': [0,0,2], bbox: [200,100,400,300], fixture: 'counter' },
      m2: { frame_number: 120, '3d_location': [1,0,2], bbox: [300,100,500,300], fixture: 'counter' },
      m3: { frame_number: 180, '3d_location': [1,1,2], bbox: [300,200,500,400], fixture: 'shelf' },
    } },
    geometry: { mapId: 'room', coordinateUnits: 'meters', cameraConvention: 'opencv_optical', bboxUnits: 'pixels',
      video: { name: 'clip.mp4', width: 1000, height: 500, fps: 30, startFrame: 60, duration: 5 },
      poses: [60,120,180].map(frameNumber => ({ frameNumber, worldFromCamera: matrix })),
    },
  };
}

test('HD-EPIC conversion preserves instance identity across moves and aligns clip time and square image boxes', () => {
  const result = convertHdEpic(input());
  assert.equal(result.entities.length, 1);
  assert.deepEqual(result.frames.map(f => f.videoTime), [0,2,4]);
  assert.deepEqual(result.frames[0].detections[0].bbox, [.2,.35,.4,.55]);
  assert.deepEqual(result.frames[2].detections[0].worldPosition, [1,1,2]);
  assert.equal(new Set(result.frames.map(f => f.detections[0].entityId)).size, 1);
  assert.ok(result.frames.every(f => f.detections.every(d => d.status === 'seen')), 'sparse labels never invent occlusion');
  assert.equal(result.frames[0].detections[0].semantics.modelPrediction, false);
});

test('HD-EPIC conversion refuses missing calibration, poses, conflicting masks and unrecognized objects', () => {
  const missingCalibration = input(); delete missingCalibration.geometry.cameraConvention;
  assert.throws(() => convertHdEpic(missingCalibration), /calibrated/);
  const missingPose = input(); missingPose.geometry.poses.pop();
  assert.throws(() => convertHdEpic(missingPose), /Missing calibrated/);
  const conflicting = input(); conflicting.associations['test-video'].duplicate = conflicting.associations['test-video'].cup;
  assert.throws(() => convertHdEpic(conflicting), /two object instances/);
  assert.throws(() => convertHdEpic({ ...input(), objectIds: ['unknown'] }), /Unknown association/);
});

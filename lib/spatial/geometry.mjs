/**
 * Metric geometry shared by capture adapters and guidance.
 *
 * World coordinates: right-handed, meters, Y up. Camera optical coordinates:
 * X right, Y down, Z forward. worldFromCamera is a ROW-MAJOR 4x4 rigid matrix:
 * [r00,r01,r02,tx, r10,r11,r12,ty, r20,r21,r22,tz, 0,0,0,1].
 * An upright camera looking along world -Z has rotation diag(1,-1,-1).
 * Projection MUST use the pose captured with that image, not API response time.
 * Guidance uses the current pose and describes camera-relative directions.
 */
const EPS = 1e-8;
const RIGID_TOLERANCE = 1e-4;

function vector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || !value.every(x => typeof x === 'number' && Number.isFinite(x))) {
    throw new TypeError(`${label} must contain ${length} finite numbers.`);
  }
  return value;
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
}

export function validatePose(pose) {
  if (!pose || typeof pose !== 'object') throw new TypeError('A camera pose is required.');
  nonempty(pose.mapId, 'Pose mapId');
  if (typeof pose.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(pose.capturedAt) || !Number.isFinite(Date.parse(pose.capturedAt))) {
    throw new TypeError('Pose capturedAt must be an ISO timestamp with timezone.');
  }
  if (!['tracking', 'lost'].includes(pose.trackingState)) throw new TypeError('Pose trackingState must be tracking or lost.');
  const m = vector(pose.worldFromCamera, 16, 'worldFromCamera');
  if (Math.abs(m[12]) > EPS || Math.abs(m[13]) > EPS || Math.abs(m[14]) > EPS || Math.abs(m[15] - 1) > EPS) {
    throw new RangeError('worldFromCamera must have homogeneous last row [0,0,0,1].');
  }
  // Rotation rows must form an orthonormal right-handed basis, excluding scale,
  // shear and reflections. Never silently normalize a malformed transform.
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      let dot = 0;
      for (let k = 0; k < 3; k++) dot += m[i * 4 + k] * m[j * 4 + k];
      if (Math.abs(dot - (i === j ? 1 : 0)) > RIGID_TOLERANCE) throw new RangeError('worldFromCamera rotation must be orthonormal.');
    }
  }
  const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  if (Math.abs(determinant - 1) > RIGID_TOLERANCE) throw new RangeError('worldFromCamera must be a right-handed rigid transform.');
  return pose;
}

function trackedPose(pose) {
  validatePose(pose);
  if (pose.trackingState !== 'tracking') throw new RangeError('Cannot project while camera tracking is lost.');
  return pose.worldFromCamera;
}

function ray(pixel, intrinsics) {
  const [u, v] = vector(pixel, 2, 'pixel');
  if (!intrinsics || typeof intrinsics !== 'object') throw new TypeError('Camera intrinsics are required.');
  const { fx, fy, cx, cy, width, height } = intrinsics;
  vector([fx, fy, cx, cy, width, height], 6, 'intrinsics');
  if (fx <= 0 || fy <= 0 || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('Intrinsics require positive focal lengths and integer image dimensions.');
  }
  if (u < 0 || u >= width || v < 0 || v >= height) throw new RangeError('Pixel lies outside the calibrated image.');
  return [(u - cx) / fx, (v - cy) / fy, 1];
}

function rotate(m, p) {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[4] * p[0] + m[5] * p[1] + m[6] * p[2], m[8] * p[0] + m[9] * p[1] + m[10] * p[2]];
}

export function unprojectToWorld({ pixel, depthM, intrinsics, pose }) {
  if (typeof depthM !== 'number' || !Number.isFinite(depthM) || depthM <= 0) throw new RangeError('depthM must be positive optical-axis depth in meters.');
  const m = trackedPose(pose);
  const camera = ray(pixel, intrinsics).map(x => x * depthM);
  const world = rotate(m, camera).map((x, i) => x + m[i * 4 + 3]);
  return vector(world, 3, 'Projected world position');
}

/** Return the forward ray/plane intersection, or null when parallel/behind. */
export function intersectPlane({ pixel, intrinsics, pose, plane }) {
  const m = trackedPose(pose);
  const direction = rotate(m, ray(pixel, intrinsics));
  if (!plane || typeof plane !== 'object') throw new TypeError('A world-space plane is required.');
  const normal = vector(plane.normal, 3, 'Plane normal');
  const norm = Math.hypot(...normal);
  if (!Number.isFinite(norm) || norm < EPS || typeof plane.offset !== 'number' || !Number.isFinite(plane.offset)) throw new RangeError('Plane must have a finite nonzero normal and finite offset.');
  const n = normal.map(x => x / norm);
  const origin = [m[3], m[7], m[11]];
  const denominator = n.reduce((sum, x, i) => sum + x * direction[i], 0);
  if (Math.abs(denominator) < EPS) return null;
  const t = -(n.reduce((sum, x, i) => sum + x * origin[i], 0) + plane.offset / norm) / denominator;
  if (t <= EPS) return null;
  return vector(origin.map((x, i) => x + direction[i] * t), 3, 'Plane intersection');
}

export function worldToCamera(world, pose) {
  vector(world, 3, 'World position');
  const m = trackedPose(pose);
  const delta = world.map((x, i) => x - m[i * 4 + 3]);
  // Rigid inverse: R transpose times (world - translation).
  return vector([m[0] * delta[0] + m[4] * delta[1] + m[8] * delta[2], m[1] * delta[0] + m[5] * delta[1] + m[9] * delta[2], m[2] * delta[0] + m[6] * delta[1] + m[10] * delta[2]], 3, 'Camera position');
}

function unavailable(status, instruction) {
  return { status, distanceM: null, bearingDeg: null, elevationDeg: null, instruction, frame: 'camera', distanceApproximate: true, requiresVisualConfirmation: true };
}

export function guideToTarget({ target, pose }) {
  if (!target || target.position == null || !target.mapId) return unavailable('unlocalized', 'The last observation has no mapped position. Use its image evidence to search.');
  vector(target.position, 3, 'Target position');
  nonempty(target.mapId, 'Target mapId');
  if (target.uncertaintyM !== null && target.uncertaintyM !== undefined && (typeof target.uncertaintyM !== 'number' || !Number.isFinite(target.uncertaintyM) || target.uncertaintyM < 0)) throw new RangeError('Target uncertaintyM must be nonnegative or null.');
  if (!pose) return unavailable('unlocalized', 'Current camera pose is unavailable. Relocalize before requesting directions.');
  if (pose.trackingState === 'lost') return unavailable('relocalize', 'Camera tracking is lost. Look around to relocalize; use the saved evidence meanwhile.');
  validatePose(pose);
  if (target.mapId !== pose.mapId) return unavailable('relocalize', 'The camera and the memory use different maps. Relocalize to the saved map first.');
  const [x, y, z] = worldToCamera(target.position, pose);
  const distanceM = Math.hypot(x, y, z);
  if (!Number.isFinite(distanceM)) throw new RangeError('Target distance is outside the finite numeric range.');
  const bearingDeg = distanceM < EPS ? 0 : Math.atan2(x, z) * 180 / Math.PI;
  const elevationDeg = distanceM < EPS ? 0 : Math.atan2(-y, Math.hypot(x, z)) * 180 / Math.PI;
  let instruction;
  if (distanceM < 0.15) instruction = 'The last-seen position is close to the camera. Inspect the area and visually confirm the item.';
  else if (Math.abs(bearingDeg) > 100) instruction = `Turn the camera ${bearingDeg >= 0 ? 'right' : 'left'} toward the last-seen area behind it.`;
  else if (Math.abs(bearingDeg) > 12) instruction = `Turn the camera ${bearingDeg > 0 ? 'right' : 'left'} toward the last-seen area.`;
  else if (Math.abs(elevationDeg) > 12) instruction = `Tilt the camera ${elevationDeg > 0 ? 'up' : 'down'} toward the last-seen area.`;
  else instruction = 'The last-seen area is ahead of the camera. Look for the item and visually confirm it.';
  return { status: 'direction', distanceM, bearingDeg, elevationDeg, instruction, frame: 'camera', distanceApproximate: true, uncertaintyM: target.uncertaintyM ?? null, requiresVisualConfirmation: true };
}

import { VisionError } from './vision.mjs';
import { validatePose, unprojectToWorld } from './spatial/geometry.mjs';

const MODEL = 'fal-ai/vggt-1b';
const MAX_RESPONSE = 32 * 1024 * 1024;
async function boundedJson(response) {
  if (!response.ok) throw new VisionError(`3D 服务请求失败（HTTP ${response.status}）。`, 502);
  let count = 0;
  const parts = [];
  for await (const chunk of response.body) { count += chunk.length; if (count > MAX_RESPONSE) throw new VisionError('3D 服务返回数据过大。'); parts.push(chunk); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new VisionError('3D 服务返回了无效 JSON。'); }
}

export function invertExtrinsic(e) {
  if (!Array.isArray(e) || e.length !== 3 || e.some(row => !Array.isArray(row) || row.length !== 4 || row.some(v => !Number.isFinite(v)))) throw new VisionError('重建相机矩阵无效。');
  const m = [e[0][0], e[1][0], e[2][0], 0, e[0][1], e[1][1], e[2][1], 0, e[0][2], e[1][2], e[2][2], 0, 0, 0, 0, 1];
  for (let i = 0; i < 3; i++) m[i * 4 + 3] = -(m[i * 4] * e[0][3] + m[i * 4 + 1] * e[1][3] + m[i * 4 + 2] * e[2][3]);
  return m;
}

export function depthRaster(prediction) {
  const value = prediction.depth;
  if (Array.isArray(value)) {
    let v = value;
    while (v.length === 1 && Array.isArray(v[0]?.[0])) v = v[0];
    if (!Array.isArray(v[0])) throw new VisionError('重建深度栅格无效。');
    const height = v.length, width = v[0].length;
    const data = v.flatMap(row => row.map(n => Array.isArray(n) ? n[0] : n));
    if (width * height !== data.length || width > 2048 || height > 2048) throw new VisionError('深度栅格尺寸无效。');
    return { width, height, data };
  }
  if (!value || !Array.isArray(value.shape) || !['float32', '<f4', 'float64', '<f8'].includes(value.dtype) || typeof value.data !== 'string') throw new VisionError('VGGT 深度格式暂不支持；原始重建结果已保留。');
  const shape = value.shape.filter(v => v !== 1);
  if (shape.length !== 2 || shape.some(n => !Number.isSafeInteger(n) || n < 2 || n > 2048)) throw new VisionError('深度栅格尺寸无效。');
  const bytes = Buffer.from(value.data, 'base64'), step = /64|f8/.test(value.dtype) ? 8 : 4;
  if (bytes.length !== shape[0] * shape[1] * step) throw new VisionError('深度栅格数据长度无效。');
  return { height: shape[0], width: shape[1], data: Array.from({ length: shape[0] * shape[1] }, (_, i) => step === 4 ? bytes.readFloatLE(i * step) : bytes.readDoubleLE(i * step)) };
}

export function sampleDepth(raster, x, y) {
  const values = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const px = Math.max(0, Math.min(raster.width - 1, Math.round(x * (raster.width - 1)) + dx));
    const py = Math.max(0, Math.min(raster.height - 1, Math.round(y * (raster.height - 1)) + dy));
    const d = raster.data[py * raster.width + px];
    if (Number.isFinite(d) && d > 0 && d < 1e5) values.push(d);
  }
  values.sort((a, b) => a - b);
  return values.length >= 5 ? values[Math.floor(values.length / 2)] : null;
}

export function createReconstructionClient({ apiKey = process.env.FAL_KEY || '', fetchImpl = globalThis.fetch } = {}) {
  const request = (url, options = {}, signal) => fetchImpl(url, { ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
  const auth = { Authorization: `Key ${apiKey}`, 'content-type': 'application/json' };
  return {
    configured: Boolean(apiKey.trim()), model: MODEL,
    async submit(images, { signal } = {}) {
      if (!apiKey.trim()) throw new VisionError('尚未配置 3D 服务。请在服务端配置 FAL_KEY，使用 VGGT 重建。', 503);
      const output = await boundedJson(await request(`https://queue.fal.run/${MODEL}`, { method: 'POST', headers: auth, body: JSON.stringify({ image_urls: images, export_prediction_data: true, export_depth_maps: true, export_point_cloud: true, array_encoding: 'base64', max_points: 40000, confidence_percentile: 50 }) }, signal));
      if (typeof output.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(output.request_id)) throw new VisionError('3D 服务未返回请求 ID。');
      return output.request_id;
    },
    async status(id, { signal } = {}) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new VisionError('Invalid reconstruction request.');
      return boundedJson(await request(`https://queue.fal.run/${MODEL}/requests/${id}/status`, { headers: auth }, signal));
    },
    async result(id, { signal } = {}) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new VisionError('Invalid reconstruction request.');
      return boundedJson(await request(`https://queue.fal.run/${MODEL}/requests/${id}`, { headers: auth }, signal));
    },
    async prediction(url, { signal } = {}) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new VisionError('Invalid prediction URL.'); }
      // Only fetch provider-owned artifacts; never fetch user-supplied arbitrary URLs.
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !(parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media'))) throw new VisionError('Unsupported 3D artifact host.');
      return boundedJson(await request(parsed.href, {}, signal));
    },
  };
}

export function reconstructFrame({ frame, extrinsic, intrinsic, prediction, mapId, id }) {
  const pose = { id, mapId, capturedAt: frame.capturedAt, trackingState: 'tracking', worldFromCamera: invertExtrinsic(extrinsic) };
  validatePose(pose);
  if (!Array.isArray(intrinsic) || intrinsic.length !== 3 || intrinsic.some(r => !Array.isArray(r) || r.length !== 3 || r.some(v => !Number.isFinite(v)))) throw new VisionError('Invalid reconstruction intrinsics.');
  const intrinsics = { fx: intrinsic[0][0], fy: intrinsic[1][1], cx: intrinsic[0][2], cy: intrinsic[1][2], width: 518, height: 518 };
  const raster = depthRaster(prediction);
  // Input frames are square-letterboxed by the client before BOTH recognition
  // and reconstruction: boxes, depth, and model intrinsics share one image.
  const detections = frame.detections.map(d => {
    if (d.status !== 'seen') return d;
    const x = (d.bbox[0] + d.bbox[2]) / 2, y = (d.bbox[1] + d.bbox[3]) / 2;
    const depthM = sampleDepth(raster, x, y);
    return { ...d, ...(depthM ? { depthM } : {}), semantics: { ...d.semantics, geometrySource: MODEL, coordinateUnits: 'relative', scaleCalibrated: false } };
  });
  const points = [];
  for (let y = 0; y < raster.height; y += 12) for (let x = 0; x < raster.width; x += 12) {
    const d = raster.data[y * raster.width + x];
    if (!Number.isFinite(d) || d <= 0 || d > 1000) continue;
    const p = unprojectToWorld({ pixel: [x / raster.width * 518, y / raster.height * 518], depthM: d, intrinsics, pose });
    points.push([...p.map(n => Math.round(n * 10000) / 10000), '#6ab6a3']);
  }
  return { pose, intrinsics, detections, points };
}

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { validatePose, unprojectToWorld } from './geometry.mjs';
import { sampleDepth } from '../reconstruction.mjs';

/** RGB-D/SLAM adapters bind geometry to the exact RGB evidence, never to the
 * later query pose. Depth is optical Z in the explicitly declared map units. */
export function captureGeometry(frame, packet) {
  if(packet.frameId!==frame.id || packet.imageSha256!==createHash('sha256').update(fs.readFileSync(frame.imagePath)).digest('hex')) throw new Error('Geometry does not match the captured image.');
  if(!['meters','relative'].includes(packet.coordinateUnits)) throw new Error('Geometry requires explicit coordinate units.');
  if(!['sensor','reconstruction'].includes(packet.provenance?.kind) || typeof packet.provenance.source!=='string' || !packet.provenance.source.trim() || packet.provenance.source.length>150) throw new Error('Geometry requires sensor or reconstruction provenance.');
  const pose=structuredClone(packet.pose); validatePose(pose);
  if(pose.trackingState!=='tracking'||pose.capturedAt!==frame.capturedAt || !/^[a-zA-Z0-9_-]{1,100}$/.test(pose.mapId)) throw new Error('Geometry requires the tracked capture-time pose and a safe map ID.');
  pose.id=`pose_${frame.id}`;
  const k=packet.intrinsics,d=packet.depth;
  if(!k || k.width!==518 || k.height!==518 || ![k.fx,k.fy,k.cx,k.cy].every(Number.isFinite)||k.fx<=0||k.fy<=0) throw new Error('Intrinsics must describe the 518 square letterboxed input image.');
  if(!d||![d.width,d.height].every(n=>Number.isSafeInteger(n)&&n>=2&&n<=518)||!Array.isArray(d.data)||d.data.length!==d.width*d.height||d.data.some(n=>!Number.isFinite(n)||n<0||n>10000)) throw new Error('Invalid registered depth raster. Zero denotes missing depth.');
  const detections=frame.detections.map(item=>{
    if(item.status!=='seen') return item;
    const depthM=sampleDepth(d,(item.bbox[0]+item.bbox[2])/2,(item.bbox[1]+item.bbox[3])/2);
    return {...item,...(depthM?{depthM}:{}),semantics:{...item.semantics,geometrySource:packet.provenance.source,geometryKind:packet.provenance.kind,coordinateUnits:packet.coordinateUnits}};
  });
  const points=[],step=Math.max(1,Math.ceil(Math.sqrt(d.width*d.height/3500)));
  for(let y=0;y<d.height;y+=step) for(let x=0;x<d.width;x+=step) {
    const z=d.data[y*d.width+x];if(z<=0)continue;
    const p=unprojectToWorld({pixel:[x/(d.width-1)*517,y/(d.height-1)*517],depthM:z,intrinsics:k,pose});
    points.push([...p,'#6ab6a3']);
  }
  return {pose,intrinsics:structuredClone(k),detections,points};
}

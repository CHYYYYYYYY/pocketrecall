import { validatePose } from './geometry.mjs';

const center = p => [p.worldFromCamera[3],p.worldFromCamera[7],p.worldFromCamera[11]];
const rotation = p => [0,1,2,4,5,6,8,9,10].map(i=>p.worldFromCamera[i]);
const rotate = (r,p) => [0,1,2].map(i=>r[i*3]*p[0]+r[i*3+1]*p[1]+r[i*3+2]*p[2]);
const mean = values => [0,1,2].map(i=>values.reduce((s,p)=>s+p[i],0)/values.length);
const sub = (a,b) => a.map((v,i)=>v-b[i]);
const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
const mul = (a,b) => Array.from({length:9},(_,i)=>[0,1,2].reduce((s,k)=>s+a[Math.floor(i/3)*3+k]*b[k*3+i%3],0));
const transpose = r => [0,3,6,1,4,7,2,5,8].map(i=>r[i]);

/** Shared frames are exact capture identities, not guessed object matches.
 * Camera orientations determine R; camera baselines determine scale. Reject
 * inconsistent windows instead of silently merging unrelated geometry. */
export function alignPoseWindows(pairs) {
  if (!Array.isArray(pairs) || pairs.length<3) throw new Error('Map alignment needs at least three overlapping capture poses.');
  for (const {local,world} of pairs) { validatePose(local); validatePose(world); if(local.trackingState!=='tracking'||world.trackingState!=='tracking') throw new Error('Alignment requires tracked anchors.'); }
  const r=mul(rotation(pairs[0].world),transpose(rotation(pairs[0].local)));
  let maxRotationDeg=0;
  for (const {local,world} of pairs) {
    const predicted=mul(r,rotation(local));
    const angle=Math.acos(Math.max(-1,Math.min(1,(dot(predicted,rotation(world))-1)/2)))*180/Math.PI;
    maxRotationDeg=Math.max(maxRotationDeg,angle);
  }
  if(maxRotationDeg>5) throw new Error('Map alignment rejected: anchor orientation disagreement exceeds 5 degrees.');
  const a=pairs.map(p=>rotate(r,center(p.local))), b=pairs.map(p=>center(p.world));
  const ca=mean(a),cb=mean(b), ac=a.map(p=>sub(p,ca)), bc=b.map(p=>sub(p,cb));
  const energy=ac.reduce((s,p)=>s+dot(p,p),0), worldEnergy=bc.reduce((s,p)=>s+dot(p,p),0);
  if(energy<1e-6 || worldEnergy<1e-6) throw new Error('Map alignment needs a measurable camera baseline. Capture translated views.');
  const scale=ac.reduce((s,p,i)=>s+dot(p,bc[i]),0)/energy;
  if(!Number.isFinite(scale)||scale<.01||scale>100) throw new Error('Map alignment rejected: invalid relative scale.');
  const translation=cb.map((v,i)=>v-scale*ca[i]);
  const residual=Math.sqrt(a.reduce((s,p,i)=>s+sub(p.map((v,k)=>scale*v+translation[k]),b[i]).reduce((t,v)=>t+v*v,0),0)/a.length);
  const baseline=Math.sqrt(worldEnergy/b.length);
  if(residual>Math.max(1e-4,baseline*.08)) throw new Error('Map alignment rejected: shared-pose residual is too large.');
  return {rotation:r,translation,scale,residual,baseline,maxRotationDeg,anchorCount:pairs.length,method:'shared_capture_pose_similarity'};
}

export function transformOutput(output, transform, mapId) {
  const point=p=>rotate(transform.rotation,p).map((v,i)=>v*transform.scale+transform.translation[i]);
  const p=point(center(output.pose)),r=mul(transform.rotation,rotation(output.pose));
  const pose={...output.pose,mapId,worldFromCamera:[...r.slice(0,3),p[0],...r.slice(3,6),p[1],...r.slice(6,9),p[2],0,0,0,1]};
  validatePose(pose);
  return {...output,pose,points:output.points.map(p=>[...point(p.slice(0,3)),p[3]]),detections:output.detections.map(d=>({...d,...(d.depthM!=null?{depthM:d.depthM*transform.scale}:{}),...(d.uncertaintyM!=null?{uncertaintyM:d.uncertaintyM*transform.scale}:{})}))};
}

const spread = (frames,n) => frames.length<=n?frames:Array.from({length:n},(_,i)=>frames[Math.round(i*(frames.length-1)/(n-1))]);
export function selectKeyframes(frames, hasMap) {
  if(!hasMap) return spread(frames,8);
  const fresh=frames.filter(f=>!f.mappedPose);
  if(!fresh.length) return [];
  const anchors=spread(frames.filter(f=>f.mappedPose),3);
  if(anchors.length<3) throw new Error('The saved map needs three shared frames before it can be extended.');
  return [...anchors,...spread(fresh,5)];
}

export function mergeCloud(previous, added, limit=25000) {
  const unique=new Map();
  for(const p of [...previous,...added]) unique.set(p.slice(0,3).map(v=>v.toFixed(3)).join(','),p);
  return spread([...unique.values()],limit);
}

"""Prepare the official LEDGER kitchen demo for non-commercial research replay.
Usage: python scripts/prepare-ledger.py DATA_JSON DENSE_JSON DENSE_BIN
The video must be public/assets/ledger/kitchen.mp4 (official, unmodified).
"""
import hashlib,json,pathlib,subprocess,sys
import numpy as np
root=pathlib.Path(__file__).resolve().parents[1];out=root/'public/assets/ledger';out.mkdir(parents=True,exist_ok=True)
data=json.load(open(sys.argv[1]));dense=json.load(open(sys.argv[2]));raw=pathlib.Path(sys.argv[3]).read_bytes();n=dense['n']
xyz=(np.frombuffer(raw,dtype='<i2',count=n*3).reshape(-1,3).astype(float)+32500)*dense['scale']+dense['offset']
rgb=np.frombuffer(raw,dtype='u1',count=n*3,offset=n*6).reshape(-1,3)
# Keep the official scene coordinate frame, rotated from Z-up to Y-up.
transform=np.array([[1,0,0],[0,0,1],[0,-1,0]])
xyz=xyz@transform.T
camera=np.array(data['camera']);centers=camera[:,1:4]@transform.T;forward=camera[:,4:7]@transform.T
keep=np.flatnonzero(xyz[:,1]<max(centers[:,1])+.45)[::16];xyz=xyz[keep];rgb=rgb[keep]
objects={o['id']:o for o in data['objects']};selected=[39,0,37,77,121,126]
entities=[{'id':f'ledger_{i}','label':objects[i]['name'].title(),'aliases':[objects[i]['name']]+(['glass','酒杯'] if i==39 else []),'priority':'explicit' if i==39 else 'background'} for i in selected]
used=set();frames=[]
for index,source in enumerate(data['frames']):
 t=source['t'];ci=int(np.abs(camera[:,0]-t).argmin());c=centers[ci];f=forward[ci]/np.linalg.norm(forward[ci]);right=np.cross(f,[0,1,0]);right/=np.linalg.norm(right);down=np.cross(f,right)
 pose=np.eye(4);pose[:3,:3]=np.column_stack([right,down,f]);pose[:3,3]=c
 delta=xyz-c;z=delta@f;visible=np.flatnonzero((z>.05)&(abs(delta@right)<z*1.192)&(abs(delta@down)<z*1.192))
 # Approximate occlusion with a coarse depth buffer. The source has no per-point
 # acquisition times: this is a reference-cloud reveal, never an online SLAM result.
 xy=np.column_stack([delta[visible]@right,delta[visible]@down])/(z[visible,None]*1.192)
 pixels=np.clip(((xy+1)*32).astype(int),0,63);bins=pixels[:,1]*64+pixels[:,0]
 front=np.full(4096,np.inf);np.minimum.at(front,bins,z[visible])
 visible=visible[z[visible]<=front[bins]+.10]
 fresh=[int(i) for i in visible if int(i) not in used];used.update(fresh)
 points=[[*(round(float(v),5) for v in xyz[i]),'#'+''.join(f'{int(v):02x}' for v in rgb[i])] for i in fresh]
 detections=[]
 for entity,oid in zip(entities,selected):
  candidates=[d for d in source['dets'] if d.get('ob')==oid and d.get('world')]
  semantics={'provider':'ledger_model_replay','dataset':'HD-EPIC / LEDGER kitchen','sourceObjectId':oid,'videoTime':t,'execution':'recorded','modelPrediction':True,'poseApproximation':'exported center/forward, zero camera roll; not full calibrated pose'}
  if candidates:
   d=max(candidates,key=lambda d:d['s']);detections.append({'entityId':entity['id'],'status':'seen','bbox':d['box'],'worldPosition':(np.array(d['world'])@transform.T).round(5).tolist(),'semantics':{**semantics,'detectorScore':d['s']}})
  else:detections.append({'entityId':entity['id'],'status':'not_seen','semantics':{**semantics,'absenceMeaning':'not present in this sampled LEDGER output; not proof of physical absence'}})
 name=f'frame-{index:02}.jpg'
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-ss',str(t),'-i',str(out/'kitchen.mp4'),'-frames:v','1','-vf','scale=518:518','-q:v','3',str(out/name)],check=True)
 frame={'videoTime':t,'image':name,'imageSha256':hashlib.sha256((out/name).read_bytes()).hexdigest(),'pose':{'mapId':'ledger-hdepic-kitchen','trackingState':'tracking','worldFromCamera':pose.flatten().tolist()},'detections':detections,'points':points,'referenceCameraTime':float(camera[ci,0])}
 frame_name=f'capture-{index:02}.json';(out/frame_name).write_text(json.dumps(frame,separators=(',',':'))+'\n');frames.append({'videoTime':t,'file':frame_name})
manifest={'schemaVersion':1,'source':{'dataset':'LEDGER / HD-EPIC kitchen','url':'https://ledger-3d.github.io/','license':'HD-EPIC CC BY-NC 4.0; credited LEDGER research outputs','geometry':'Precomputed Pi3X + TSDF reference; progressively revealed by approximate camera frustum, not live reconstruction','coordinateUnits':'relative','camera':'Exported centers and forward vectors; roll approximated as zero','wineGlassSourceId':39,'wineGlassObservations':[p[0] for p in objects[39]['traj']]},'video':{'url':'/assets/ledger/kitchen.mp4','name':'LEDGER / HD-EPIC kitchen','duration':data['duration'],'width':data['res'][0],'height':data['res'][1]},'entities':entities,'frames':frames,'dialogue':[{'time':20,'text':'Where did you last see the wine glass?','audio':'/assets/ledger/user-0.wav'},{'time':60,'text':'Find the wine glass.','audio':'/assets/ledger/user-1.wav'},{'time':96,'text':'Show the wine glass history.','audio':'/assets/ledger/user-2.wav'},{'time':144,'text':'Find the wine glass again.','audio':'/assets/ledger/user-3.wav'}]}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'captures':len(frames),'points':len(used),'glassObservations':manifest['source']['wineGlassObservations']}))

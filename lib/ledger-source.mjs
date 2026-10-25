import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const safe=name=>{if(typeof name!=='string'||!/^[a-zA-Z0-9_-]+\.(json|jpg)$/.test(name))throw new Error('Invalid bundled LEDGER path.');return name;};
export function readLedger(directory,videoTime){
  const pack=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if(videoTime===undefined)return pack;
  const entry=pack.frames.find(f=>Math.abs(f.videoTime-videoTime)<.001);
  if(!entry)throw new Error('Use an exact LEDGER sample time.');
  const frame=JSON.parse(fs.readFileSync(path.join(directory,safe(entry.file)),'utf8'));
  const bytes=fs.readFileSync(path.join(directory,safe(frame.image)));
  if(createHash('sha256').update(bytes).digest('hex')!==frame.imageSha256)throw new Error('LEDGER capture image hash mismatch.');
  return {...frame,imageDataUrl:`data:image/jpeg;base64,${bytes.toString('base64')}`};
}

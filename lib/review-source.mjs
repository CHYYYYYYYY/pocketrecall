import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function readReview(directory, videoTime) {
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if(!Array.isArray(manifest.frames)||!manifest.frames.length||!manifest.entities?.length) throw new Error('The real desk sample has not been prepared. See docs/HACKATHON.md.');
  if(videoTime===undefined) return manifest;
  const frame=manifest.frames.find(f=>Math.abs(f.videoTime-videoTime)<.001);
  if(!frame) throw new Error('Use an exact sample capture timestamp.');
  for(const name of [frame.image,frame.geometry]) if(typeof name!=='string'||!/^[a-zA-Z0-9_.-]+$/.test(name)||name.includes('..')) throw new Error('Invalid bundled capture path.');
  const bytes=fs.readFileSync(path.join(directory,frame.image));
  if(createHash('sha256').update(bytes).digest('hex')!==frame.imageSha256) throw new Error('Bundled capture image hash does not match.');
  return {manifest,frame,imageDataUrl:`data:image/jpeg;base64,${bytes.toString('base64')}`,geometry:JSON.parse(fs.readFileSync(path.join(directory,frame.geometry),'utf8'))};
}

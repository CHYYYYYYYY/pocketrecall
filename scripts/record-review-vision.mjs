import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRunVisionClient} from '../lib/run-vision.mjs';
import {loadLocalEnv} from '../server.mjs';
loadLocalEnv();
const root=fileURLToPath(new URL('../public/assets/review/',import.meta.url));
const file=path.join(root,'manifest.json'),pack=JSON.parse(fs.readFileSync(file,'utf8'));
const vision=createRunVisionClient();
if(!vision.configured) throw new Error('Set GEMINI_API_KEY in ignored .env.local first.');
// Explicit data preparation command; real provider calls, never part of CI.
for(const [i,frame] of pack.frames.entries()) {
  const started=performance.now();
  const detections=await vision.analyze('data:image/jpeg;base64,'+fs.readFileSync(path.join(root,frame.image)).toString('base64'),pack.entities);
  frame.detections=detections.map(d=>({...d,semantics:{...d.semantics,execution:'recorded',model:vision.model,modelPrediction:true}}));
  frame.recognition={model:vision.model,recordedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started)};
  fs.writeFileSync(file,JSON.stringify(pack,null,2)+'\n');
  console.log(JSON.stringify({frame:i,elapsedMs:frame.recognition.elapsedMs,objects:detections.map(d=>[d.entityId,d.status])}));
}

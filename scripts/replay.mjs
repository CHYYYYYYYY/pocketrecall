import fs from 'node:fs';
import path from 'node:path';
import { replayManifest } from '../lib/spatial/pipeline.mjs';
import { perceiveFrame } from '../lib/spatial/perception.mjs';
const args=process.argv.slice(2);
const options={};
for(let i=0;i<args.length;i+=2){if(!['--manifest','--out','--vision'].includes(args[i])||!args[i+1]||options[args[i]])throw new Error('Usage: node scripts/replay.mjs --manifest FILE --out NEW_DIRECTORY [--vision gemini]');options[args[i]]=args[i+1];}
if(!options['--manifest']||!options['--out']||(options['--vision']&&options['--vision']!=='gemini'))throw new Error('Usage: node scripts/replay.mjs --manifest FILE --out NEW_DIRECTORY [--vision gemini]');
const manifestPath=path.resolve(options['--manifest']), output=path.resolve(options['--out']);
if(fs.existsSync(output))throw new Error('Replay output directory must be new; existing files are never cleared.');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const perception=[];
if(options['--vision']==='gemini'){
  if(fs.existsSync('.env.local'))process.loadEnvFile('.env.local');
  for(const event of manifest.events){
    if(event.type!=='frame'||Array.isArray(event.frame.detections))continue;
    const frame=await perceiveFrame({imagePath:path.resolve(path.dirname(manifestPath),event.frame.imagePath),frame:event.frame,bindings:manifest.bindings});
    event.frame=frame;if(frame.skipIngest)event.type='perception_skipped';
    perception.push({frameId:frame.id,imageSha256:frame.imageSha256,perception:frame.perception,skippedDetections:frame.skippedDetections});
  }
}
const {trace,snapshot}=replayManifest(manifest,{dataDir:path.join(output,'memory'),baseDir:path.dirname(manifestPath)});
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'trace.json'),JSON.stringify(trace,null,2)+'\n');
fs.writeFileSync(path.join(output,'snapshot.json'),JSON.stringify(snapshot,null,2)+'\n');
if(perception.length)fs.writeFileSync(path.join(output,'perception.json'),JSON.stringify(perception,null,2)+'\n');
console.log(JSON.stringify({completed:true,mode:'manifest-replay',vision:options['--vision']??'provided-detections',providerCalls:perception.length,events:trace.length,observations:snapshot.observations.length,output},null,2));

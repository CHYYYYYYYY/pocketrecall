import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createAppServer, loadLocalEnv } from '../server.mjs';

const liveVision=process.argv.includes('--live-vision'),liveVoice=process.argv.includes('--live-voice');
if(liveVision||liveVoice)loadLocalEnv();
const root=new URL('../public/assets/review/',import.meta.url),pack=JSON.parse(fs.readFileSync(new URL('manifest.json',root)));
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'pocket-judge-'));
let app,base,socket;
async function start(){app=createAppServer({dataDir});app.listen(0,'127.0.0.1');await once(app,'listening');base=`http://127.0.0.1:${app.address().port}`;}
async function close(){socket?.terminate();if(app)await new Promise(resolve=>app.close(resolve));}
async function request(route,body){const res=await fetch(`${base}/api/run/${route}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await res.json();assert.equal(res.status,200,`${route}: ${value.error}`);return value;}
function wave(pcm,rate=24000){const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);}
function pcmFromWave(bytes){assert.equal(bytes.toString('ascii',0,4),'RIFF');let offset=12;while(offset+8<=bytes.length){const name=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4);if(name==='fmt '){assert.equal(bytes.readUInt16LE(offset+8),1);assert.equal(bytes.readUInt16LE(offset+10),1);assert.equal(bytes.readUInt32LE(offset+12),16000);assert.equal(bytes.readUInt16LE(offset+22),16);}if(name==='data')return bytes.subarray(offset+8,offset+8+size);offset+=8+size+(size%2);}throw new Error('WAV has no PCM data');}
async function voice(sessionId){
  const pcm=pcmFromWave(fs.readFileSync(new URL('voice-query.wav',root))),audio=[],events=[];let ready,finish,reject;
  const connected=new Promise(resolve=>ready=resolve),done=new Promise((resolve,fail)=>{finish=resolve;reject=fail;});
  socket=new WebSocket(`${base.replace('http','ws')}/api/run/live?sessionId=${sessionId}`,{origin:base});
  const began=performance.now();let firstAudioMs=null,videoFrames=0,audioChunks=0,stopped=false;
  const timeout=setTimeout(()=>reject(new Error('Live voice did not complete a grounded audio response within 45 seconds.')),45000);
  socket.on('error',()=>reject(new Error('Live socket connection failed')));
  socket.on('message',bytes=>{
    const m=JSON.parse(bytes);events.push(m);
    if(m.type==='ready')ready();
    if(m.type==='error')reject(new Error(m.message));
    if(m.type==='audio'){firstAudioMs??=Math.round(performance.now()-began);audio.push(Buffer.from(m.data,'base64'));}
    if(m.type==='turnComplete'&&audio.length&&events.some(e=>e.type==='agent'))finish();
  });
  const send=packet=>{if(!stopped&&socket.readyState===1)socket.send(JSON.stringify(packet));};
  let videoTimer;
  try{
    await Promise.race([connected,done]);
    const video=()=>{const f=pack.frames[videoFrames%pack.frames.length];send({type:'video',data:fs.readFileSync(new URL(f.image,root)).toString('base64')});videoFrames++;};
    video();videoTimer=setInterval(video,1000);
    for(let i=0;i<pcm.length;i+=3200){send({type:'audio',data:pcm.subarray(i,i+3200).toString('base64')});audioChunks++;await delay(100);}
    // Give automatic VAD a silence tail, then mark the microphone temporarily off.
    for(let i=0;i<10;i++){send({type:'audio',data:Buffer.alloc(3200).toString('base64')});audioChunks++;await delay(100);}
    send({type:'audioEnd'});await done;
    const inputTranscript=events.filter(e=>e.type==='transcript'&&e.role==='user').map(e=>e.text).join('');
    const outputTranscript=events.filter(e=>e.type==='transcript'&&e.role==='assistant').map(e=>e.text).join('');
    assert.match(inputTranscript,/keyboard/i);assert.ok(events.some(e=>e.type==='agent'&&e.result.state.targetId==='keyboard'));
    const groundedInstruction=events.filter(e=>e.type==='agent').at(-1).result.state.guidance.instruction;
    const directionWord=groundedInstruction.match(/right|left|ahead|higher|lower|near/i)?.[0];
    assert.ok(directionWord&&outputTranscript.toLowerCase().includes(directionWord.toLowerCase()),'Spoken response must relay the grounded direction');
    return {passed:true,model:events.find(e=>e.type==='ready').model,transport:'real Gemini Live WebSocket; streamed PCM + JPEG',audioInput:'generated English speech, not a physical microphone',groundedInstruction,inputTranscript,outputTranscript,inputAudioChunks:audioChunks,videoFrames,outputAudioBytes:Buffer.concat(audio).length,firstAudioMs,totalMs:Math.round(performance.now()-began),audio:wave(Buffer.concat(audio))};
  }finally{stopped=true;clearInterval(videoTimer);clearTimeout(timeout);socket.terminate();}
}
try{
  await start();let state=await request('review',{live:liveVision});const sessionId=state.session.id;
  assert.equal(state.observationCount,0);assert.equal(state.map,null);
  const timings=[];
  for(const [i,frame] of pack.frames.entries()){
    const result=await request('review/frame',{sessionId,seq:i+1,videoTime:frame.videoTime});state=result.state;timings.push(result.elapsedMs);
    assert.equal(state.maps.length,1);assert.equal(state.map.id,'tum-fr1-desk');assert.equal(state.map.units,'meters');
  }
  const found=await request('agent',{sessionId,text:'Where did I leave the keyboard?'});
  assert.equal(found.state.guidance.status,'direction');assert.equal(found.state.guidance.simulatedUser,true);
  assert.ok(found.agent.evidence[0].position.every(Number.isFinite));
  const history=await request('agent',{sessionId,text:'Show earlier keyboard sightings'});assert.ok(history.agent.evidence.length>=2);
  const before=await request('export');await close();await start();const after=await request('export');
  assert.deepEqual(after.memory,before.memory);assert.deepEqual(after.maps,before.maps);
  const evidence=await fetch(base+found.agent.evidence[0].evidenceUrl);assert.equal(evidence.status,200);
  const result={passed:true,checkedAt:new Date().toISOString(),input:'Real TUM RGB-D freiburg1_desk camera frames',vision:liveVision?'live Gemini API':'recorded Gemini model predictions',geometry:'measured Kinect depth + reference motion-capture poses',frames:state.frameCount,observations:state.observationCount,mapId:state.map.id,mapRevisions:state.maps[0].revisions.length,points:state.map.points.length,frameProcessingMs:timings,agentTools:found.agent.toolCalls.map(c=>c.tool),guidance:found.state.guidance.instruction,restart:'server recreated; memory/maps/evidence verified',wearer:'simulated; no physical localization claim'};
  const output=new URL('../.pocketrecall-data/verification/',import.meta.url);fs.mkdirSync(output,{recursive:true});
  if(liveVoice){const {audio,...report}=await voice(sessionId);result.liveVoice=report;fs.writeFileSync(new URL('live-response.wav',output),audio);}
  const filename=liveVoice?(liveVision?'judge-live-full.json':'judge-live.json'):liveVision?'judge-vision.json':'judge-replay.json';
  fs.writeFileSync(new URL(filename,output),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await close();fs.rmSync(dataDir,{recursive:true,force:true});}

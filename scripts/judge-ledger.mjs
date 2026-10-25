import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {createAppServer,loadLocalEnv} from '../server.mjs';

const live=process.argv.includes('--live-voice');
if(live)loadLocalEnv();
const assets=new URL('../public/assets/ledger/',import.meta.url);
const pack=JSON.parse(fs.readFileSync(new URL('manifest.json',assets)));
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'pocket-ledger-judge-'));
const output=new URL('../.pocketrecall-data/verification/',import.meta.url);
fs.mkdirSync(output,{recursive:true});
let app,base;
async function start(){app=createAppServer({dataDir});app.listen(0,'127.0.0.1');await once(app,'listening');base=`http://127.0.0.1:${app.address().port}`;}
async function close(){if(app)await new Promise(resolve=>app.close(resolve));app=null;}
async function request(route,body){const res=await fetch(`${base}/api/run/${route}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await res.json();assert.equal(res.status,200,`${route}: ${value.error}`);return value;}
function pcm(bytes){for(let p=12;p+8<=bytes.length;){const size=bytes.readUInt32LE(p+4);if(bytes.toString('ascii',p,p+4)==='data')return bytes.subarray(p+8,p+8+size);p+=8+size+(size%2);}throw new Error('Missing WAV data');}
function wav(bytes){const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(bytes.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(24000,24);h.writeUInt32LE(48000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(bytes.length,40);return Buffer.concat([h,bytes]);}

async function spokenTurn(sessionId,line,frame){
  const socket=new WebSocket(`${base.replace('http','ws')}/api/run/live?sessionId=${sessionId}&input=generated`,{origin:base});
  const events=[],audio=[];let ready,finish,fail,firstAudioMs,videoTimer;
  const began=performance.now(),connected=new Promise(r=>ready=r),done=new Promise((r,j)=>{finish=r;fail=j;});
  done.catch(()=>{});
  const timeout=setTimeout(()=>fail(new Error('Grounded Live reply timed out after 45 seconds.')),45000);
  socket.on('error',()=>fail(new Error('Live socket failed.')));
  socket.on('message',bytes=>{const m=JSON.parse(bytes);events.push(m);if(m.type==='ready')ready();if(m.type==='error')fail(new Error(m.message));if(m.type==='audio'){firstAudioMs??=Math.round(performance.now()-began);audio.push(Buffer.from(m.data,'base64'));}if(m.type==='turnComplete'&&audio.length&&events.some(e=>e.type==='agent'))finish();});
  const send=m=>{if(socket.readyState===1)socket.send(JSON.stringify(m));};
  let videoFrames=0;
  try{
    await Promise.race([connected,done]);
    const sendFrame=()=>{send({type:'video',data:fs.readFileSync(new URL(frame.image,assets)).toString('base64')});videoFrames++;};
    sendFrame();videoTimer=setInterval(sendFrame,1000);
    const input=pcm(fs.readFileSync(new URL(path.basename(line.audio),assets)));
    send({type:'activityStart'});
    for(let i=0;i<input.length;i+=3200){send({type:'audio',data:input.subarray(i,i+3200).toString('base64')});await delay(100);}
    for(let i=0;i<8;i++){send({type:'audio',data:Buffer.alloc(3200).toString('base64')});await delay(100);}
    send({type:'activityEnd'});await done;
    const inputTranscript=events.filter(e=>e.type==='transcript'&&e.role==='user').map(e=>e.text).join('');
    const outputTranscript=events.filter(e=>e.type==='transcript'&&e.role==='assistant').map(e=>e.text).join('');
    assert.match(inputTranscript,/wine glass/i);
    const result=events.filter(e=>e.type==='agent').at(-1).result;
    assert.ok(result.agent.evidence.length,'Spoken reply must retrieve stored evidence');
    assert.ok(result.agent.evidence.every(e=>e.videoTime<=line.time),'No future object observation in the tool result');
    if(line.time===96){assert.match(outputTranscript,/00:16|16 seconds/);assert.ok(!outputTranscript.includes('02:08'));}
    else {const word=result.state.guidance.instruction.match(/right|left|ahead|higher|lower|near/i)?.[0];assert.ok(word&&outputTranscript.toLowerCase().includes(word));}
    fs.writeFileSync(new URL(`kitchen-response-${line.time}.wav`,output),wav(Buffer.concat(audio)));
    return {videoTime:line.time,inputTranscript,outputTranscript,tools:result.agent.toolCalls.map(c=>c.tool),evidenceTimes:result.agent.evidence.map(e=>e.videoTime),model:events.find(e=>e.type==='ready').model,videoFrames,outputAudioBytes:Buffer.concat(audio).length,firstAudioMs,totalMs:Math.round(performance.now()-began)};
  }finally{clearTimeout(timeout);clearInterval(videoTimer);socket.terminate();}
}

try{
  await start();let state=await request('ledger',{});const sessionId=state.session.id;
  assert.equal(state.observationCount,0);assert.equal(state.map,null);assert.equal(state.ledger.source.wineGlassObservations,undefined);
  const snapshots=[],turns=[];let seq=0;
  for(const entry of pack.frames){
    state=(await request('ledger/frame',{sessionId,seq:++seq,videoTime:entry.videoTime})).state;
    const glass=state.objects.find(o=>o.id==='ledger_39');const seen=glass.lastSeen?.semantics.videoTime??null;
    assert.ok(seen===null||seen<=entry.videoTime);
    if(entry.videoTime<16)assert.equal(seen,null);
    if(entry.videoTime>=40&&entry.videoTime<92)assert.equal(seen,40);
    if(entry.videoTime===92)assert.equal(seen,92);
    assert.equal(state.maps.length,1);assert.equal(state.map.units,'relative');
    snapshots.push({videoTime:entry.videoTime,lastSeen:seen,points:state.map.points.length});
    const line=pack.dialogue.find(d=>d.time===entry.videoTime);
    if(line){
      if(live)turns.push(await spokenTurn(sessionId,line,JSON.parse(fs.readFileSync(new URL(entry.file,assets)))));
      else {const result=await request('agent',{sessionId,text:line.text});assert.ok(result.agent.evidence.every(e=>e.videoTime<=entry.videoTime));turns.push({videoTime:entry.videoTime,message:result.message,tools:result.agent.toolCalls.map(c=>c.tool),evidenceTimes:result.agent.evidence.map(e=>e.videoTime)});}
    }
  }
  assert.ok(snapshots.at(-1).points>snapshots[0].points);
  const before=await request('export');await close();await start();const after=await request('export');
  assert.deepEqual(after.memory,before.memory);assert.deepEqual(after.maps,before.maps);
  for(const o of state.objects.filter(o=>o.evidenceUrl))assert.equal((await fetch(base+o.evidenceUrl)).status,200);
  const result={passed:true,checkedAt:new Date().toISOString(),input:'Official LEDGER / HD-EPIC real kitchen footage',vision:'replayed LEDGER model outputs; not a new recognition run',geometry:'Pi3X + TSDF reference cloud, approximate frustum/depth-buffer reveal; relative units; zero-roll camera approximation',voice:live?'Real Gemini Live PCM + concurrent JPEG; generated user speech':'Memory tools with text input; no live provider',frames:state.frameCount,observations:state.observationCount,mapId:state.map.id,points:state.map.points.length,glassSightingTimes:pack.source.wineGlassObservations,snapshots,turns,restart:'server recreated; identical memory/maps and readable saved evidence'};
  fs.writeFileSync(new URL(live?'judge-kitchen-live.json':'judge-kitchen.json',output),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,snapshots:undefined},null,2));
}finally{await close();fs.rmSync(dataDir,{recursive:true,force:true});}

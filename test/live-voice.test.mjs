import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createAppServer } from '../server.mjs';

class Provider extends EventEmitter {
  readyState=0;bufferedAmount=0;messages=[];
  send(data){this.messages.push(JSON.parse(data));}
  close(){this.readyState=3;this.emit('close',1000);}
  terminate(){this.close();}
  open(){this.readyState=1;this.emit('open');}
  reply(data){this.emit('message',Buffer.from(JSON.stringify(data)));}
}
const tick=()=>new Promise(r=>setTimeout(r,30));
async function setup(t,{generated=false}={}){
  const dir=mkdtempSync(path.join(tmpdir(),'pocket-live-')),provider=new Provider();
  const app=createAppServer({dataDir:dir,liveOptions:{apiKey:'test-secret',createSocket:()=>provider}});
  app.listen(0,'127.0.0.1');await once(app,'listening');
  const base=`http://127.0.0.1:${app.address().port}`;
  const client=new WebSocket(`${base.replace('http','ws')}/api/run/live?sessionId=${app.run.session.id}${generated?'&input=generated':''}`,{origin:base});
  const received=[];client.on('message',b=>received.push(JSON.parse(b)));
  await once(client,'open');provider.open();await tick();
  t.after(async()=>{client.terminate();provider.terminate();await new Promise(r=>app.close(r));rmSync(dir,{recursive:true,force:true});});
  return {app,provider,client,received,base};
}
test('generated speech has explicit activity boundaries while microphone VAD remains automatic',async t=>{
  const {provider,client}=await setup(t,{generated:true});
  assert.equal(provider.messages[0].setup.realtimeInputConfig.automaticActivityDetection.disabled,true);
  provider.reply({setupComplete:{}});await tick();
  client.send(JSON.stringify({type:'activityStart'}));
  client.send(JSON.stringify({type:'audio',data:Buffer.alloc(640).toString('base64')}));
  client.send(JSON.stringify({type:'activityEnd'}));await tick();
  assert.deepEqual(provider.messages[1].realtimeInput,{activityStart:{}});
  assert.deepEqual(provider.messages[3].realtimeInput,{activityEnd:{}});
});
test('duplex bridge streams audio/video, preserves all audio parts and interruption events',async t=>{
  const {provider,client,received}=await setup(t);
  assert.equal(provider.messages[0].setup.model,'models/gemini-3.8-live');
  assert.ok(provider.messages[0].setup.tools[0].functionDeclarations.length);
  provider.reply({setupComplete:{}});await tick();
  client.send(JSON.stringify({type:'audio',data:Buffer.alloc(3200).toString('base64')}));
  client.send(JSON.stringify({type:'video',data:Buffer.from([255,216,255,224,1,2,3]).toString('base64')}));
  await tick();
  assert.equal(provider.messages[1].realtimeInput.audio.mimeType,'audio/pcm;rate=16000');
  assert.equal(provider.messages[2].realtimeInput.video.mimeType,'image/jpeg');
  provider.reply({serverContent:{modelTurn:{parts:[{inlineData:{data:'AAAA',mimeType:'audio/pcm;rate=24000'}},{inlineData:{data:'BBBB',mimeType:'audio/pcm;rate=24000'}}]},outputTranscription:{text:'I remember it.'}}});
  provider.reply({serverContent:{interrupted:true,turnComplete:true}});await tick();
  assert.equal(received.filter(m=>m.type==='audio').length,2);
  assert.ok(received.some(m=>m.type==='interrupted'));
  assert.ok(received.some(m=>m.type==='transcript'&&m.role==='assistant'));
  assert.ok(!JSON.stringify(received).includes('test-secret'));
});
test('Live calls the shared memory agent; model cannot fabricate a possession confirmation',async t=>{
  const {app,provider,received}=await setup(t);
  provider.reply({setupComplete:{}});
  provider.reply({toolCall:{functionCalls:[{id:'find',name:'query_memory',args:{request:'Find my keys'}}]}});await tick();
  assert.equal(app.run.session.targetId,'keys');
  assert.ok(received.some(m=>m.type==='agent'&&m.result.agent.toolCalls.some(c=>c.tool==='memory.search')));
  provider.reply({toolCall:{functionCalls:[{id:'invented',name:'query_memory',args:{request:'Got it'}}]}});await tick();
  assert.ok(provider.messages.at(-1).toolResponse.functionResponses[0].response.error);
  assert.equal(app.run.state().confirmedIds.includes('keys'),false);
  provider.reply({serverContent:{inputTranscription:{text:'Got it.'}}});
  provider.reply({toolCall:{functionCalls:[{id:'confirmed',name:'query_memory',args:{request:'Got it'}}]}});await tick();
  assert.equal(app.run.state().confirmedIds.includes('keys'),true);
  app.run.start({mode:'demo'});await tick();assert.equal(provider.readyState,3);
});
test('Live upgrade rejects cross-origin or expired sessions and config never exposes secrets',async t=>{
  const {app,base}=await setup(t);
  const config=await (await fetch(`${base}/api/run/config`)).json();
  assert.equal(config.live.configured,true);assert.ok(!JSON.stringify(config).includes('test-secret'));
  for(const [sessionId,origin,expected] of [[app.run.session.id,'http://evil.example',403],['expired',base,409]]){
    const client=new WebSocket(`${base.replace('http','ws')}/api/run/live?sessionId=${sessionId}`,{origin});
    const status=await new Promise(resolve=>{client.on('unexpected-response',(_,res)=>{resolve(res.statusCode);res.destroy();client.terminate();});client.on('error',()=>{});});
    assert.equal(status,expected);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmFramer } from '../public/pcm-framer.js';
import { LiveConversation } from '../public/run-live.js';
test('microphone framing preserves duration and sample continuity across arbitrary worklet blocks',()=>{
  for(const rate of [16000,44100,48000]){
    const output=[],framer=new PcmFramer(rate,bytes=>output.push(bytes));
    const signal=new Float32Array(rate).fill(.25);
    for(let i=0;i<signal.length;i+=128)framer.push(signal.subarray(i,i+128));
    assert.equal(output.length,50);assert.equal(output.reduce((s,b)=>s+b.byteLength,0),32000);
    for(const bytes of output)assert.equal(new DataView(bytes).getInt16(0,true),8192);
  }
});
test('barge-in stops every scheduled audio source and clears playback time',()=>{
  let stopped=0;const states=[];
  const live=new LiveConversation({onSpeaking:value=>states.push(value)});
  live.sources.add({stop(){stopped++;},disconnect(){}});live.sources.add({stop(){stopped++;},disconnect(){}});
  live.nextAudio=12;live.handle({type:'interrupted'});
  assert.equal(stopped,2);assert.equal(live.sources.size,0);assert.equal(live.nextAudio,0);assert.equal(states.at(-1),false);
});
test('generated audio sends explicit boundaries and a silence tail without opening a microphone',async t=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)});t.after(()=>globalThis.fetch=previous);
  const packets=[],live=new LiveConversation({canPlay:()=>false});
  live.token=Symbol();live.active=live.ready=true;live.send=packet=>packets.push(packet);
  live.context={decodeAudioData:async()=>({sampleRate:16000,getChannelData:()=>new Float32Array(320)}),createBufferSource:()=>({start(){},connect(){}})};
  await live.simulateSpeech('/generated.wav');
  assert.equal(packets[0].type,'activityStart');assert.equal(packets.at(-1).type,'activityEnd');
  assert.ok(packets.filter(p=>p.type==='audio').length>=20,'silence must flush the final speech samples');
  assert.ok(!packets.some(p=>p.type==='audioEnd'));
});

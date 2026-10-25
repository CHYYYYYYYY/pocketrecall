import { PcmFramer } from './pcm-framer.js';
const base64=buffer=>{let value='';for(const byte of new Uint8Array(buffer))value+=String.fromCharCode(byte);return btoa(value);};

/** Real duplex microphone/video transport, native audio playback and barge-in. */
export class LiveConversation {
  constructor({getFrame,onEvent,onStatus,onSpeaking,canPlay=()=>true}={}){
    Object.assign(this,{getFrame,onEvent,onStatus,onSpeaking,canPlay});this.sources=new Set();this.nextAudio=0;this.active=false;this.ready=false;
  }
  async start(sessionId,{microphone=true}={}){
    if(this.active)return;
    this.active=true;this.microphone=microphone;const token=this.token=Symbol();this.onStatus?.(microphone?'Connecting microphone…':'Connecting simulated speaker to Gemini Live…');
    try{
      if(microphone&&!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone access requires localhost or HTTPS.');
      this.context=new AudioContext({sampleRate:16000});await this.context.resume();
      if(microphone){
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(this.token!==token){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;await this.context.audioWorklet.addModule('/pcm-worklet.js');
      if(this.token!==token)return;
      this.source=this.context.createMediaStreamSource(stream);this.worklet=new AudioWorkletNode(this.context,'capture-pcm');
      this.worklet.port.onmessage=e=>{if(this.ready)this.send({type:'audio',data:base64(e.data)});};
      // Keep the processor running without monitoring the microphone locally.
      this.silent=this.context.createGain();this.silent.gain.value=0;
      this.source.connect(this.worklet);this.worklet.connect(this.silent);this.silent.connect(this.context.destination);
      }
      const url=new URL('/api/run/live',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('sessionId',sessionId);
      if(!microphone)url.searchParams.set('input','generated');
      this.socket=new WebSocket(url);
      this.socket.onmessage=e=>{if(this.token===token){try{this.handle(JSON.parse(e.data));}catch{this.stop('Live audio could not be played. Reconnect to try again.');}}};
      this.socket.onerror=()=>{if(this.token===token)this.stop('Live connection failed. Check the local server and Gemini access.');};
      this.socket.onclose=()=>{if(this.token===token)this.stop('Live conversation ended. Your spatial memory is saved.');};
    }catch(error){if(this.token===token)this.stop(error.name==='NotAllowedError'?'Microphone permission was not granted. You can still type.':error.message);}
  }
  async simulateSpeech(url){
    const token=this.token;
    for(let i=0;!this.ready&&i<600;i++){if(!this.active)throw new Error('Live conversation stopped.');await new Promise(r=>setTimeout(r,25));}
    if(!this.ready)throw new Error('Live conversation did not become ready.');
    const response=await fetch(url);if(!response.ok)throw new Error('Demo speech is unavailable.');
    const buffer=await this.context.decodeAudioData(await response.arrayBuffer());
    if(this.token!==token)throw new Error('Demo conversation was cancelled.');
    this.inputPlayback=this.context.createBufferSource();this.inputPlayback.buffer=buffer;
    if(this.canPlay())this.inputPlayback.connect(this.context.destination);this.inputPlayback.start();
    const chunks=[],framer=new PcmFramer(buffer.sampleRate,b=>chunks.push(b));framer.push(buffer.getChannelData(0));
    framer.push(new Float32Array(Math.round(buffer.sampleRate*.4)));
    this.send({type:'activityStart'});
    for(const bytes of chunks){if(this.token!==token)throw new Error('Demo conversation was cancelled.');this.send({type:'audio',data:base64(bytes)});await new Promise(r=>setTimeout(r,20));}
    this.send({type:'activityEnd'});
  }
  send(packet){
    if(!this.ready||this.socket?.readyState!==1)return false;
    if(this.socket.bufferedAmount>512000){if(packet.type==='video')return false;this.stop('Connection is too slow for live audio. Reconnect to try again.');return false;}
    this.socket.send(JSON.stringify(packet));return true;
  }
  text(text){this.interrupt();return this.send({type:'text',text});}
  handle(event){
    if(event.type==='ready'){
      this.ready=true;this.onStatus?.(this.microphone?'Live · listening · video 1 fps':'Simulated user · real Gemini Live · video 1 fps');
      this.videoTimer=setInterval(()=>{try{const frame=this.getFrame?.();if(frame)this.send({type:'video',data:frame.split(',')[1]});}catch{this.onStatus?.('Live audio · video capture unavailable');}},1000);
    }else if(event.type==='audio')this.play(event);
    else if(event.type==='interrupted')this.interrupt();
    else if(event.type==='error'){this.stop(event.message);return;}
    else if(event.type==='notice')this.onStatus?.(event.message);
    this.onEvent?.(event);
  }
  play(event){
    if(!this.context||!this.canPlay())return;
    const binary=atob(event.data),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);
    const rate=Number(event.mimeType.match(/rate=(\d+)/)?.[1]||24000);
    if(![16000,24000,48000].includes(rate)||!bytes.length||bytes.length%2)return;
    const buffer=this.context.createBuffer(1,bytes.length/2,rate),samples=buffer.getChannelData(0);
    for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
    const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);
    const at=Math.max(this.context.currentTime+.025,this.nextAudio);
    if(at-this.context.currentTime>30){this.stop('Audio playback fell behind. Reconnect to try again.');return;}
    this.nextAudio=at+buffer.duration;this.sources.add(source);this.onSpeaking?.(true);
    source.onended=()=>{source.disconnect();this.sources.delete(source);if(!this.sources.size)this.onSpeaking?.(false);};source.start(at);
  }
  interrupt(){for(const source of this.sources){source.onended=null;try{source.stop();source.disconnect();}catch{}}this.sources.clear();this.nextAudio=0;this.onSpeaking?.(false);}
  stop(message='Live conversation stopped.'){
    this.active=false;this.ready=false;this.token=null;clearInterval(this.videoTimer);this.interrupt();
    try{this.inputPlayback?.stop();this.inputPlayback?.disconnect();}catch{}
    this.socket?.close();this.source?.disconnect();this.worklet?.disconnect();this.worklet?.port.close();this.silent?.disconnect();
    this.stream?.getTracks().forEach(track=>track.stop());this.context?.close().catch(()=>{});
    this.socket=this.stream=this.context=null;this.onStatus?.(message);this.onEvent?.({type:'stopped'});
  }
}

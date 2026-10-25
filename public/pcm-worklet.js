import { PcmFramer } from './pcm-framer.js';
class CapturePcm extends AudioWorkletProcessor {
  constructor(){super();this.framer=new PcmFramer(sampleRate,buffer=>this.port.postMessage(buffer,[buffer]));}
  process(inputs){if(inputs[0]?.[0])this.framer.push(inputs[0][0]);return true;}
}
registerProcessor('capture-pcm',CapturePcm);

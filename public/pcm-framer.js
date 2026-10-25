/** Streaming area resampler: continuous mono PCM16LE, 20 ms at 16 kHz. */
export class PcmFramer {
  constructor(rate,emit){this.ratio=rate/16000;this.remaining=this.ratio;this.sum=0;this.emit=emit;this.buffer=new ArrayBuffer(640);this.view=new DataView(this.buffer);this.index=0;}
  push(samples){
    for(const sample of samples){
      let remaining=1;
      while(remaining>1e-8){
        const weight=Math.min(remaining,this.remaining);this.sum+=sample*weight;this.remaining-=weight;remaining-=weight;
        if(this.remaining<1e-8){
          const value=Math.max(-1,Math.min(1,this.sum/this.ratio));
          this.view.setInt16(this.index++*2,Math.round(value*(value<0?32768:32767)),true);
          if(this.index===320){this.emit(this.buffer);this.buffer=new ArrayBuffer(640);this.view=new DataView(this.buffer);this.index=0;}
          this.remaining=this.ratio;this.sum=0;
        }
      }
    }
  }
}

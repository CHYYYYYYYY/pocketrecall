/** Browser actuator adapter. A desktop cannot impersonate physical haptics. */
export class Feedback {
  constructor(onPulse) { this.enabled = false; this.guidance = null; this.timer = null; this.onPulse = onPulse; this.lastHaptic = 0; this.lastSpeech = ''; this.speaking = false; }
  async enable() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('此浏览器不支持 Web Audio；仍可查看方向提示。');
    this.context ||= new Audio(); await this.context.resume(); this.enabled = true; this.schedule();
  }
  disable() { this.enabled = false; clearTimeout(this.timer); this.timer = null; window.speechSynthesis?.cancel(); this.speaking = false; this.context?.suspend(); }
  update(guidance) {
    this.guidance = guidance;
    if (guidance?.aligned && Date.now() - this.lastHaptic > 1200) {
      this.lastHaptic = Date.now(); this.onPulse?.();
      if (this.enabled && typeof navigator.vibrate === 'function') navigator.vibrate([25]);
    }
    this.schedule();
  }
  beat(gain, delay) {
    if (!this.context || this.context.state !== 'running') return;
    const at = this.context.currentTime + delay, osc = this.context.createOscillator(), amp = this.context.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(95, at); osc.frequency.exponentialRampToValueAtTime(44, at + .12);
    amp.gain.setValueAtTime(.0001, at); amp.gain.exponentialRampToValueAtTime(Math.min(gain, .45), at + .012); amp.gain.exponentialRampToValueAtTime(.0001, at + .18);
    osc.connect(amp); amp.connect(this.context.destination); osc.start(at); osc.stop(at + .2); osc.onended = () => { osc.disconnect(); amp.disconnect(); };
  }
  schedule() {
    if (this.timer || !this.enabled || !this.guidance?.pulse.enabled || document.hidden) return;
    const tick = () => {
      this.timer = null;
      if (!this.enabled || !this.guidance?.pulse.enabled || document.hidden) return;
      if (!this.speaking) { this.beat(this.guidance.pulse.gain, 0); this.beat(this.guidance.pulse.gain * .65, .17); }
      this.timer = setTimeout(tick, this.guidance.pulse.intervalMs);
    };
    this.timer = setTimeout(tick, 100);
  }
  speak(text, force = false) {
    if (!this.enabled || !window.speechSynthesis || (!force && text === this.lastSpeech)) return;
    this.lastSpeech = text; window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN'; utterance.rate = 1.02; utterance.volume = .8;
    this.speaking = true; utterance.onend = utterance.onerror = () => { this.speaking = false; this.schedule(); };
    window.speechSynthesis.speak(utterance);
  }
}

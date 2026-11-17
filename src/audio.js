// Procedural foley: every sound is synthesised (no samples).
export class Foley {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.master = null;
  }
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(this.ctx.destination);
    // a short synthetic room for everything to sit in
    this.verb = this.ctx.createConvolver();
    this.verb.buffer = this._impulse(1.6, 3.2);
    this.verbGain = this.ctx.createGain();
    this.verbGain.gain.value = 0.18;
    this.verb.connect(this.verbGain).connect(this.master);
    this.noise = this._noiseBuffer(1.0);
    this._roomTone();
  }
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }
  _noiseBuffer(sec) {
    const b = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * sec), this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  _impulse(sec, decay) {
    const sr = this.ctx.sampleRate;
    const b = this.ctx.createBuffer(2, Math.floor(sr * sec), sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, decay);
    }
    return b;
  }
  _roomTone() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(4);
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const g = this.ctx.createGain();
    g.gain.value = 0.012;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
  }
  _burst({ f = 3000, q = 4, dur = 0.03, gain = 0.3, type = 'bandpass', pan = 0, when = 0, verb = 0.5 }) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const bp = this.ctx.createBiquadFilter();
    bp.type = type;
    bp.frequency.value = f;
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    let node = src.connect(bp).connect(g);
    if (p) { p.pan.value = pan; node = node.connect(p); }
    node.connect(this.master);
    const vs = this.ctx.createGain();
    vs.gain.value = verb;
    node.connect(vs).connect(this.verb);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }
  _tone({ f = 1800, dur = 0.02, gain = 0.05, when = 0, pan = 0 }) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.7, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  // a matchstick landing on stone
  tick(strength = 1, pan = 0) {
    const s = Math.min(1, strength);
    this._burst({ f: 3800 + Math.random() * 1800, q: 6, dur: 0.035, gain: 0.22 * s, pan });
    this._tone({ f: 2100 + Math.random() * 900, dur: 0.018, gain: 0.03 * s, pan });
    if (Math.random() < 0.5) this._burst({ f: 4500, q: 8, dur: 0.02, gain: 0.08 * s, pan, when: 0.025 + Math.random() * 0.02 });
  }
  // fingertips gathering a match: soft scrape
  pick(pan = 0) {
    this._burst({ f: 2400, q: 1.5, dur: 0.06, gain: 0.07, pan });
    this._tone({ f: 1500, dur: 0.012, gain: 0.015, pan, when: 0.03 });
  }
  // fingertip tap / knuckles settling on the table
  tap(strength = 1, pan = 0) {
    this._burst({ f: 900, q: 1.2, dur: 0.05, gain: 0.16 * strength, type: 'lowpass', pan, verb: 0.8 });
    this._tone({ f: 190, dur: 0.06, gain: 0.05 * strength, pan });
  }
  // sleeve rustle on a big reach
  rustle(strength = 1, pan = 0) {
    this._burst({ f: 1600, q: 0.6, dur: 0.22, gain: 0.03 * strength, pan, verb: 0.2 });
  }
}

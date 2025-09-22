import { analyzeBuffer, decodeArrayBufferToAudio } from './analyze.js';
import { clamp } from './noise.js';

// ---- lazy loader for Tone AFTER a user gesture ----
async function ensureTone() {
  if (window.Tone) return window.Tone;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/tone@14.8.49/build/Tone.js';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load Tone.js'));
    document.head.appendChild(s);
  });
  return window.Tone;
}

// Unified audio engine: uploaded track OR procedural Tone.js
export class AudioEngine {
  constructor() {
    this.mode = 'uploaded'; // 'uploaded' | 'procedural'
    this.ctx = null;
    this.analyser = null;
    this.proc = null; // procedural wrapper
    this.buffer = null;
    this.source = null;
    this.masterGain = null;
    this.streamDest = null; // for recording
    this.analysis = null;
    this.startTime = 0;
    this.inOffset = 0;
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1.0;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      this.streamDest = this.ctx.createMediaStreamDestination();
      this.masterGain.connect(this.analyser);
      this.masterGain.connect(this.ctx.destination);
      this.masterGain.connect(this.streamDest);
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch {}
    }
    return this.ctx;
  }

  getMediaStreamDestination() { return this.streamDest; }

  // Uploaded track
  async loadFile(file) {
    await this.ensureContext();
    const ab = await file.arrayBuffer();
    this.buffer = await decodeArrayBufferToAudio(this.ctx, ab);
    this.analysis = analyzeBuffer(this.buffer);
    return this.analysis;
  }

  async startUploaded({ inOffset = 0 }) {
    if (!this.buffer) throw new Error('No audio buffer loaded.');
    await this.ensureContext();
    this.stop();
    this.mode = 'uploaded';
    this.inOffset = clamp(inOffset, 0, Math.max(0, this.buffer.duration - 0.001));
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.masterGain);
    this.source.start(0, this.inOffset);
    this.startTime = this.ctx.currentTime;
  }

  // Procedural (Tone.js)
  async startProcedural({ seed = 123456, bpm = 112, scaleName = 'minor', root = 'C2' }) {
    const Tone = await ensureTone();          // load only after click
    await this.ensureContext();               // resume our context
    this.stop();
    this.mode = 'procedural';
    this.proc = new MusicSystemTone();
    await this.proc.start({ seed, bpm, scaleName, root });

    // Route Tone graph into our masterGain via MediaStream bridge
    const rawCtx = Tone.getContext().rawContext;
    const tapDest = rawCtx.createMediaStreamDestination();
    Tone.Destination.connect(tapDest);
    const tapSrc = this.ctx.createMediaStreamSource(tapDest.stream);
    tapSrc.connect(this.masterGain);

    this.startTime = this.ctx.currentTime;
  }

  stop() {
    if (this.source) { try { this.source.stop(); } catch {} this.source.disconnect(); this.source = null; }
    if (this.proc) { this.proc.stop(); this.proc = null; }
  }

  getDuration() {
    if (this.mode === 'uploaded' && this.buffer) return this.buffer.duration;
    if (this.mode === 'procedural' && this.proc) return Infinity;
    return 0;
  }

  getTime() {
    if (!this.ctx) return 0;
    if (this.mode === 'uploaded') {
      const t = this.ctx.currentTime - this.startTime + this.inOffset;
      return Math.min(t, this.getDuration());
    } else if (this.mode === 'procedural' && this.proc) {
      return window.Tone.Transport.seconds;
    }
    return 0;
  }

  // 0..1 level
  getLevel() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return clamp(rms * 4.5, 0, 1); // heuristic gain
  }

  // Beat pulse [0..1]
  getBeatPulse() {
    if (this.mode === 'procedural' && this.proc && window.Tone) {
      const beat = window.Tone.Time('4n').toSeconds();
      const t = this.getTime();
      const phase = (t % beat) / beat;
      return phase < 0.15 ? 1 - (phase / 0.15) : 0;
    } else if (this.mode === 'uploaded' && this.analysis) {
      const t = this.getTime();
      const beats = this.analysis.beatTimes;
      let lo = 0, hi = beats.length - 1, mid = 0;
      while (lo <= hi) { mid = (lo + hi) >> 1; if (beats[mid] < t) lo = mid + 1; else hi = mid - 1; }
      const idx = Math.max(0, Math.min(beats.length - 1, lo));
      const d = Math.abs(t - beats[idx]);
      const width = 0.12;
      return d < width ? 1 - (d / width) : 0;
    }
    return 0;
  }

  getBarSeconds() {
    if (this.mode === 'procedural' && this.proc && window.Tone) return window.Tone.Time('1m').toSeconds();
    if (this.mode === 'uploaded' && this.analysis) {
      const bpm = this.analysis.bpm || 120;
      return 60 / (bpm / 4);
    }
    return 2.0;
  }
}

// Minimal wrapper for procedural Tone.js music
class MusicSystemTone {
  async start({ bpm = 112, scaleName = 'minor', root = 'C2' } = {}) {
    await ensureTone();
    const Tone = window.Tone;
    await Tone.start();
    Tone.Transport.stop(); Tone.Transport.cancel(0); Tone.Transport.position = 0;
    Tone.Transport.bpm.value = bpm;

    this.reverb = new Tone.Reverb({ decay: 5.5, wet: 0.35 }).toDestination();
    this.delay = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.25, wet: 0.25 }).connect(this.reverb);
    this.master = new Tone.Volume(-6).connect(this.delay);
    this.meter = new Tone.Meter({ channels: 1 }).connect(this.master);
    this.chords = new Tone.PolySynth(Tone.Synth).connect(this.master);
    this.lead = new Tone.FMSynth().connect(this.master);
    this.kick = new Tone.MembraneSynth().connect(this.master);

    const scales = { major:[0,2,4,5,7,9,11], minor:[0,2,3,5,7,8,10], dorian:[0,2,3,5,7,9,10], phrygian:[0,1,3,5,7,8,10] };
    const scale = scales[scaleName] || scales.minor;
    const rootMidi = Tone.Frequency(root).toMidi();
    const degree = (d, oct=0)=> rootMidi + scale[(d%scale.length+scale.length)%scale.length] + 12*oct;

    Tone.Transport.scheduleRepeat((time)=>{
      const d = [0,3,5,2][Math.floor(Tone.Transport.bars)%4];
      this.chords.triggerAttackRelease([degree(d,1),degree(d+2,1),degree(d+4,1)], '1m', time, 0.35);
    }, '1m');

    Tone.Transport.scheduleRepeat((time)=>{
      this.kick.triggerAttackRelease('C2','8n', time, 0.9);
    }, '2n');

    Tone.Transport.scheduleRepeat((time)=>{
      const m = degree(2 + ((Math.random()*6)|0), 2);
      this.lead.triggerAttackRelease(Tone.Frequency(m,'midi'), '8n', time, 0.3);
    }, '8n');

    Tone.Transport.start();
  }
  stop() {
    const Tone = window.Tone;
    try { Tone.Transport.stop(); Tone.Transport.cancel(0); } catch {}
    for (const n of ['chords','lead','kick','reverb','delay','master','meter']) {
      try { this[n]?.dispose?.(); } catch {}
      this[n] = null;
    }
  }
}

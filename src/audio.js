import { analyzeBuffer, decodeArrayBufferToAudio } from './analyze.js';
import { clamp } from './noise.js';

// --- Lazy-load Tone only after a user gesture ---
let _toneLoading = null;
async function ensureTone() {
  if (window.Tone) return window.Tone;
  if (!_toneLoading) {
    _toneLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/tone@14.8.49/build/Tone.js';
      s.async = true;
      s.onload = () => resolve(window.Tone);
      s.onerror = () => reject(new Error('Failed to load Tone.js'));
      document.head.appendChild(s);
    });
  }
  return _toneLoading;
}

// Unified audio engine: uploaded track OR procedural (Tone.js)
export class AudioEngine {
  constructor() {
    this.mode = 'uploaded';   // 'uploaded' | 'procedural'
    this.ctx = null;

    this.mix = null;          // single mix bus for everything
    this.analyser = null;
    this.streamDest = null;

    this.buffer = null;
    this.source = null;       // BufferSource for uploaded track
    this.proc = null;         // MusicSystemTone for procedural

    this.analysis = null;     // uploaded-track analysis
    this.startTime = 0;
    this.inOffset = 0;

    this._toneConnected = false;
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();

      // Mix bus
      this.mix = this.ctx.createGain();
      this.mix.gain.value = 1.0;

      // Metering + output
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;

      this.streamDest = this.ctx.createMediaStreamDestination();

      // mix -> analyser -> speakers
      this.mix.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      // mix -> recorder stream
      this.mix.connect(this.streamDest);
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch {}
    }
    return this.ctx;
  }

  getMediaStream() {
    return this.streamDest ? this.streamDest.stream : null;
  }

  // ---------- Uploaded track ----------
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
    this.inOffset = clamp(+inOffset || 0, 0, Math.max(0, this.buffer.duration - 0.001));

    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.mix);
    this.source.start(0, this.inOffset);

    this.startTime = this.ctx.currentTime;
  }

  // ---------- Procedural (Tone.js) ----------
  async startProcedural({ bpm = 112, scaleName = 'minor', root = 'C2' }) {
    const Tone = await ensureTone();
    await this.ensureContext();
    this.stop(); // stop any previous mode
    this.mode = 'procedural';

    // Make Tone use OUR AudioContext (no cross-context hacks)
    if (Tone.getContext().rawContext !== this.ctx) {
      Tone.setContext(new Tone.Context(this.ctx));
    }
    await Tone.start();

    // Build the little music system
    this.proc = new MusicSystemTone();
    const bpmVal = Number.isFinite(+bpm) ? +bpm : 112;
    await this.proc.start({ bpm: bpmVal, scaleName, root });

    // Route Tone master into our mix bus (and NOT directly to speakers)
    try { Tone.Destination.disconnect(); } catch {}
    try { Tone.Destination.connect(this.mix); this._toneConnected = true; } catch { this._toneConnected = false; }

    this.startTime = this.ctx.currentTime;
  }

  stop() {
    // uploaded
    if (this.source) {
      try { this.source.stop(); } catch {}
      try { this.source.disconnect(); } catch {}
      this.source = null;
    }
    // procedural
    if (this.proc) {
      try { this.proc.stop(); } catch {}
      this.proc = null;
    }
    if (this._toneConnected && window.Tone) {
      try { window.Tone.Destination.disconnect(this.mix); } catch {}
      // reconnect to speakers for safety if needed
      try { window.Tone.Destination.connect(this.ctx.destination); } catch {}
      this._toneConnected = false;
    }
  }

  // Dur/time
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
    } else if (this.mode === 'procedural' && window.Tone) {
      return window.Tone.Transport.seconds;
    }
    return 0;
  }

  // Meter: normalized 0..1
  getLevel() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return clamp(rms * 4.5, 0, 1); // heuristic
  }

  // Beat pulse for visuals
  getBeatPulse() {
    if (this.mode === 'procedural' && window.Tone) {
      const beat = window.Tone.Time('4n').toSeconds();
      const t = this.getTime();
      const phase = (t % beat) / beat;
      return phase < 0.15 ? 1 - (phase / 0.15) : 0;
    } else if (this.mode === 'uploaded' && this.analysis) {
      const t = this.getTime();
      const beats = this.analysis.beatTimes || [];
      if (!beats.length) return 0;
      let lo = 0, hi = beats.length - 1, mid = 0;
      while (lo <= hi) { mid = (lo + hi) >> 1; if (beats[mid] < t) lo = mid + 1; else hi = mid - 1; }
      const idx = Math.max(0, Math.min(beats.length - 1, lo));
      const d = Math.abs(t - beats[idx]);
      const width = 0.12; // 120ms
      return d < width ? 1 - (d / width) : 0;
    }
    return 0;
  }

  getBarSeconds() {
    if (this.mode === 'procedural' && window.Tone) return window.Tone.Time('1m').toSeconds();
    if (this.mode === 'uploaded' && this.analysis) {
      const bpm = Number.isFinite(+this.analysis.bpm) ? +this.analysis.bpm : 120;
      return 60 / (bpm / 4);
    }
    return 2.0;
  }
}

// Minimal, safe procedural bed
class MusicSystemTone {
  async start({ bpm = 112, scaleName = 'minor', root = 'C2' } = {}) {
    const Tone = await ensureTone();
    await Tone.start();

    const bpmVal = Number.isFinite(+bpm) ? +bpm : 112;
    Tone.Transport.stop();
    Tone.Transport.cancel(0);
    Tone.Transport.position = 0;
    Tone.Transport.bpm.value = bpmVal;

    // Nodes
    this.reverb = new Tone.Reverb({ decay: 5.5, wet: 0.35 }).toDestination();
    this.delay  = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.25, wet: 0.25 }).connect(this.reverb);
    this.master = new Tone.Volume(-6).connect(this.delay);

    this.chords = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.2, sustain: 0.6, release: 0.8 }
    }).connect(this.master);

    this.lead = new Tone.FMSynth({
      harmonicity: 2.0, modulationIndex: 8,
      oscillator: { type: 'sine' }, modulation: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.15, sustain: 0.2, release: 0.2 },
      modulationEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.1 }
    }).connect(this.master);

    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.02, octaves: 6, oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.3, sustain: 0.0, release: 0.1 }
    }).connect(this.master);

    // Scale
    const scales = { major:[0,2,4,5,7,9,11], minor:[0,2,3,5,7,8,10], dorian:[0,2,3,5,7,9,10], phrygian:[0,1,3,5,7,8,10] };
    const scale = scales[scaleName] || scales.minor;
    const rootMidi = Tone.Frequency(root || 'C2').toMidi();
    const degree = (d, oct=0)=> rootMidi + scale[(d%scale.length+scale.length)%scale.length] + 12*oct;

    // Schedules (guard every numeric)
    Tone.Transport.scheduleRepeat((time)=>{
      const d = [0,3,5,2][Math.floor(Tone.Transport.bars)%4] || 0;
      const chord = [degree(d,1), degree(d+2,1), degree(d+4,1)]
        .map(m => Tone.Frequency(Number.isFinite(m) ? m : rootMidi, 'midi'));
      this.chords.triggerAttackRelease(chord, '1m', time, 0.35);
    }, '1m');

    Tone.Transport.scheduleRepeat((time)=>{
      this.kick.triggerAttackRelease('C2','8n', time, 0.9);
    }, '2n');

    Tone.Transport.scheduleRepeat((time)=>{
      const randDeg = 2 + ((Math.random()*6)|0);
      const m = Number.isFinite(randDeg) ? degree(randDeg, 2) : degree(2, 2);
      this.lead.triggerAttackRelease(Tone.Frequency(m,'midi'), '8n', time, 0.3);
    }, '8n');

    Tone.Transport.start();
  }

  stop() {
    const Tone = window.Tone;
    try { Tone.Transport.stop(); Tone.Transport.cancel(0); } catch {}
    for (const n of ['chords','lead','kick','reverb','delay','master']) {
      try { this[n]?.dispose?.(); } catch {}
      this[n] = null;
    }
  }
}

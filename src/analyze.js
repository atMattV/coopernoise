// Lightweight offline analysis for uploaded audio: RMS envelope, tempo estimate, beat grid.
export async function decodeArrayBufferToAudio(ctx, arrayBuffer) {
  return await ctx.decodeAudioData(arrayBuffer.slice(0));
}

export function analyzeBuffer(buffer) {
  const sr = buffer.sampleRate;
  const chs = buffer.numberOfChannels;
  const len = buffer.length;

  // Downmix to mono
  const mono = new Float32Array(len);
  for (let c = 0; c < chs; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i] / chs;
  }

  // Frameing
  const hop = 512;
  const win = 1024;
  const nFrames = Math.max(1, Math.floor((len - win) / hop));
  const rms = new Float32Array(nFrames);

  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < win; i++) {
      const s = mono[start + i] || 0;
      sum += s * s;
    }
    rms[f] = Math.sqrt(sum / win);
  }

  // Emphasize onsets: simple half-wave rectified diff of RMS + smoothing
  const flux = new Float32Array(nFrames);
  for (let i = 1; i < nFrames; i++) {
    const d = rms[i] - rms[i-1];
    flux[i] = d > 0 ? d : 0;
  }
  smoothInPlace(flux, 5);

  // Tempo estimate via autocorrelation over BPM range
  const bpmMin = 70, bpmMax = 180;
  let bestBpm = 120, bestScore = -Infinity, bestLag = 0;
  for (let bpm = bpmMin; bpm <= bpmMax; bpm += 1) {
    const periodSec = 60 / bpm;
    const lag = Math.round((periodSec * sr) / hop);
    const score = dotAtLag(flux, lag);
    if (score > bestScore) { bestScore = score; bestBpm = bpm; bestLag = lag; }
  }

  // Build rough beat grid: align to strongest local onset around the first bar
  const peaks = pickPeaks(flux, 0.6 * median(flux));
  let startIdx = peaks.length ? peaks[0] : 0;
  // refine: choose peak that maximizes alignment over 16 beats
  let bestStart = startIdx, bestAlign = -Infinity;
  for (let k = 0; k < Math.min(200, peaks.length); k++) {
    const s = peaks[k];
    const align = alignmentScore(flux, s, bestLag, 16);
    if (align > bestAlign) { bestAlign = align; bestStart = s; }
  }
  startIdx = bestStart;
  const beatFrames = [];
  for (let i = startIdx; i < nFrames; i += bestLag) beatFrames.push(i);

  const beatTimes = beatFrames.map(f => (f * hop) / sr);
  const duration = buffer.duration;

  return {
    sampleRate: sr,
    duration,
    frames: nFrames,
    hop,
    rms,
    onset: flux,
    bpm: bestBpm,
    beatTimes
  };
}

function dotAtLag(x, lag) {
  if (lag <= 0 || lag >= x.length) return -Infinity;
  let s = 0;
  for (let i = lag; i < x.length; i++) s += x[i] * x[i - lag];
  return s / (x.length - lag);
}

function smoothInPlace(arr, radius = 3) {
  const out = new Float32Array(arr.length);
  const w = radius * 2 + 1;
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let r = -radius; r <= radius; r++) {
      const j = i + r;
      if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
    }
    out[i] = s / n;
  }
  arr.set(out);
}

function median(a) {
  const b = Array.from(a).sort((x,y)=>x-y);
  return b.length ? b[Math.floor(b.length/2)] : 0;
}

function pickPeaks(arr, thresh) {
  const peaks = [];
  for (let i = 1; i < arr.length-1; i++) {
    if (arr[i] > thresh && arr[i] > arr[i-1] && arr[i] >= arr[i+1]) peaks.push(i);
  }
  return peaks;
}

function alignmentScore(flux, start, lag, beats) {
  let s = 0;
  for (let i = 0; i < beats; i++) {
    const idx = start + i * lag;
    if (idx >= 0 && idx < flux.length) s += flux[idx];
  }
  return s;
}

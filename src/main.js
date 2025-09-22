import { Visuals } from './visuals.js';
import { AudioEngine } from './audio.js';
import { AVRecorder } from './recorder.js';
import { interpretPrompt } from './prompts.js';
import { Perlin, mulberry32 } from './noise.js';
import { convertWebMBlob } from './ffmpeg.js';

const $ = (sel) => document.querySelector(sel);

const ui = {
  seed: $('#seed'),
  randomize: $('#randomize'),
  duration: $('#duration'),
  useTrackLen: $('#useTrackLen'),
  inOffset: $('#inOffset'),
  outOffset: $('#outOffset'),
  resolution: $('#resolution'),
  fps: $('#fps'),

  audioSource: $('#audioSource'),
  bpm: $('#bpm'),
  scale: $('#scale'),
  root: $('#root'),
  audioFile: $('#audioFile'),
  clearAudio: $('#clearAudio'),
  audioInfo: $('#audioInfo'),

  prompt: $('#prompt'),
  applyPrompt: $('#applyPrompt'),

  shape: $('#shape'),
  mapFile: $('#mapFile'),
  dispFile: $('#dispFile'),
  dropZone: $('#dropZone'),

  start: $('#start'),
  stop: $('#stop'),
  record: $('#record'),
  stopRecord: $('#stopRecord'),
  renderTake: $('#renderTake'),
  container: $('#container'),
  convertLast: $('#convertLast'),
  exportNote: $('#exportNote'),

  status: $('#status'),
  canvasWrap: $('#canvasWrap')
};

let visuals, audio, recorder, rafId = null, startedAt = 0;
let autoCycleShapes = true;
let lastRecordingBlob = null;

function setStatus(msg) { ui.status.textContent = msg; }

function parseRes(val) {
  const [w,h] = val.split('x').map(n=>parseInt(n,10));
  return { w, h };
}

function getParams() {
  const seed = ui.seed.value.trim();
  const duration = Math.max(3, parseInt(ui.duration.value, 10) || 60);
  const useTrackLen = ui.useTrackLen.checked;
  const inOffset = Math.max(0, parseFloat(ui.inOffset.value || '0'));
  const outOffset = Math.max(0, parseFloat(ui.outOffset.value || '0'));
  const { w, h } = parseRes(ui.resolution.value);
  const fps = Math.max(24, Math.min(120, parseInt(ui.fps.value, 10) || 60));

  const audioSource = ui.audioSource.value;
  const bpm = parseInt(ui.bpm.value, 10) || 112;
  const scaleName = ui.scale.value;
  const root = ui.root.value;

  const shape = ui.shape.value;
  const container = ui.container.value;

  return { seed, duration, useTrackLen, inOffset, outOffset, w, h, fps, audioSource, bpm, scaleName, root, shape, container };
}

function enableRunButtons(on) {
  ui.stop.disabled = !on;
  ui.record.disabled = !on;
  ui.renderTake.disabled = !on;
  ui.start.disabled = on;
}
function enableRecordButtons(recOn) {
  ui.stopRecord.disabled = !recOn;
  ui.record.disabled = recOn;
}

function randomizeSeed() {
  const r = Math.random().toString(36).slice(2, 10);
  ui.seed.value = r;
}

function initVisuals(seed, w, h) {
  if (!visuals) visuals = new Visuals({ container: ui.canvasWrap, seed });
  visuals.setSeed(seed);
  visuals.setRenderSize(w, h);
}

async function startAll() {
  const p = getParams();
  setStatus('starting…');

  // Visuals
  initVisuals(p.seed, p.w, p.h);
  if (p.shape !== 'cycle') {
    visuals.setShape(p.shape);
    autoCycleShapes = false;
  } else {
    autoCycleShapes = true;
  }

  // Audio
  audio = new AudioEngine();
  if (p.audioSource === 'procedural') {
    await audio.startProcedural({ seed: p.seed, bpm: p.bpm, scaleName: p.scaleName, root: p.root });
  } else {
    if (!ui.audioFile.files[0]) throw new Error('Upload an audio track or switch to Procedural.');
    await audio.loadFile(ui.audioFile.files[0]);
    // Use track length if requested
    if (p.useTrackLen) {
      ui.duration.value = Math.max(3, Math.floor(audio.getDuration() - p.inOffset - p.outOffset));
    }
    await audio.startUploaded({ inOffset: p.inOffset });
    ui.audioInfo.textContent = `track: ${ui.audioFile.files[0].name} — ${audio.analysis?.bpm ? Math.round(audio.analysis.bpm)+' BPM' : 'BPM ~?'}, ${audio.getDuration().toFixed(1)}s`;
  }

  // Bar length for shape auto-cycling
  const barSecs = audio.getBarSeconds();
  visuals.setBarSeconds(barSecs);
  if (autoCycleShapes) visuals.scheduleAutoShape(audio.getTime(), barSecs);

  // Recorder
  recorder = new AVRecorder(visuals.getCanvas(), audio.getMediaStreamDestination()?.stream);

  // Loop
  startedAt = performance.now()/1000;
  function loop() {
    const t = audio.getTime();
    const lvl = audio.getLevel();
    const beatPulse = audio.getBeatPulse();
    visuals.update({ t, level: lvl, beatPulse, autoShape: autoCycleShapes });
    visuals.render();
    rafId = requestAnimationFrame(loop);
  }
  loop();

  enableRunButtons(true);
  setStatus('running');
}

function stopAll() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (audio) { audio.stop(); audio = null; }
  enableRunButtons(false);
  enableRecordButtons(false);
  setStatus('stopped');
}

function pickMimeFromContainer(container) {
  if (container === 'mp4') return 'mp4';
  if (container === 'webm') return 'webm';
  if (container === 'mov') return 'webm'; // record webm then convert to mov
  return 'auto';
}

function startRecord() {
  const p = getParams();
  recorder.start({ mimeHint: pickMimeFromContainer(p.container), fps: p.fps });
  enableRecordButtons(true);
  setStatus('recording…');
}

async function stopRecord() {
  const p = getParams();
  const base = `perlin_take_${Date.now()}`;
  const filename = p.container === 'mp4' ? `${base}.mp4` :
                   p.container === 'mov' ? `${base}.webm` : // will convert later if MOV selected
                   p.container === 'webm' ? `${base}.webm` : `${base}`;
  lastRecordingBlob = await recorder.stop({ filename });
  ui.convertLast.disabled = !lastRecordingBlob;
  setStatus('recording saved');
}

async function renderTake() {
  // restart clean, record for specified duration, then optional convert
  stopAll();
  await startAll();
  startRecord();
  const p = getParams();
  const total = Math.max(0.1, parseFloat(ui.duration.value));
  setTimeout(async () => {
    await stopRecord();
    // Optional auto-convert if container requires it (MOV or MP4 forced)
    if (p.container === 'mov') {
      setStatus('converting to MOV…');
      const blob = await convertWebMBlob(lastRecordingBlob, 'mov');
      downloadBlob(blob, `perlin_take_${Date.now()}.mov`);
      setStatus('converted to MOV');
    } else if (p.container === 'mp4' && !(recorder?.recorder?.mimeType || '').includes('mp4')) {
      setStatus('converting to MP4…');
      const blob = await convertWebMBlob(lastRecordingBlob, 'mp4');
      downloadBlob(blob, `perlin_take_${Date.now()}.mp4`);
      setStatus('converted to MP4');
    }
    stopAll();
  }, total * 1000);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
}

// --- UI wiring & helpers ---
ui.randomize.addEventListener('click', randomizeSeed);

ui.applyPrompt.addEventListener('click', () => {
  const style = interpretPrompt(ui.prompt.value);
  visuals?.applyStyle(style);
  setStatus('prompt applied');
});

ui.audioSource.addEventListener('change', () => {
  const proc = ui.audioSource.value === 'procedural';
  ui.bpm.disabled = !proc; ui.scale.disabled = !proc; ui.root.disabled = !proc;
  ui.audioFile.disabled = proc; ui.clearAudio.disabled = proc;
  ui.useTrackLen.disabled = proc;
});

ui.audioFile.addEventListener('change', async () => {
  if (ui.audioFile.files[0]) {
    // peek duration & bpm once loaded via AudioEngine at start; show filename for now
    ui.audioInfo.textContent = `ready: ${ui.audioFile.files[0].name}`;
  } else {
    ui.audioInfo.textContent = 'no track';
  }
});

ui.clearAudio.addEventListener('click', () => {
  ui.audioFile.value = '';
  ui.audioInfo.textContent = 'no track';
});

ui.mapFile.addEventListener('change', async () => {
  const f = ui.mapFile.files[0]; if (!f) return;
  await loadAssetFile(f, 'map');
});

ui.dispFile.addEventListener('change', async () => {
  const f = ui.dispFile.files[0]; if (!f) return;
  await loadAssetFile(f, 'disp');
});

ui.dropZone.addEventListener('dragover', (e)=>{ e.preventDefault(); ui.dropZone.classList.add('drag'); });
ui.dropZone.addEventListener('dragleave', ()=>ui.dropZone.classList.remove('drag'));
ui.dropZone.addEventListener('drop', async (e)=>{
  e.preventDefault(); ui.dropZone.classList.remove('drag');
  const files = Array.from(e.dataTransfer.files || []);
  for (const f of files) {
    if (f.type.startsWith('video/')) await loadAssetFile(f, 'map');
    else if (f.type.startsWith('image/')) await loadAssetFile(f, 'map');
  }
});

ui.shape.addEventListener('change', ()=>{
  const s = ui.shape.value;
  if (s !== 'cycle') { visuals?.setShape(s); }
});

ui.start.addEventListener('click', async () => { try { await startAll(); } catch (e) { setStatus(`error: ${e.message}`); } });
ui.stop.addEventListener('click', () => { stopAll(); });
ui.record.addEventListener('click', () => { startRecord(); });
ui.stopRecord.addEventListener('click', async () => { await stopRecord(); });
ui.renderTake.addEventListener('click', async () => { try { await renderTake(); } catch (e) { setStatus(`error: ${e.message}`); } });

ui.convertLast.addEventListener('click', async () => {
  if (!lastRecordingBlob) return;
  const fmtSel = ui.container.value === 'mov' ? 'mov' : 'mp4';
  setStatus(`converting to ${fmtSel.toUpperCase()}…`);
  const blob = await convertWebMBlob(lastRecordingBlob, fmtSel);
  downloadBlob(blob, `perlin_take_${Date.now()}.${fmtSel}`);
  setStatus(`converted to ${fmtSel.toUpperCase()}`);
});

function updateExportNote() {
  const pref = ui.container.value;
  let msg = '';
  const mp4Native = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  if (pref === 'auto') msg = mp4Native ? 'Native MP4 likely; else WebM.' : 'Will record WebM.';
  if (pref === 'mp4') msg = mp4Native ? 'Native MP4 recording.' : 'Record WebM, then convert to MP4 (slower).';
  if (pref === 'mov') msg = 'Record WebM, then convert to MOV (slower).';
  ui.exportNote.textContent = msg;
}
ui.container.addEventListener('change', updateExportNote);
updateExportNote();

function setStatusIdle() { setStatus('idle — set params and press Start'); }
setStatusIdle();

// Load asset (image/video) into textures
async function loadAssetFile(file, kind='map') {
  if (file.type.startsWith('video/')) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.src = url; v.loop = true; v.muted = true; await v.play().catch(()=>{});
    const tex = new (await import('https://unpkg.com/three@0.160.0/build/three.module.js')).VideoTexture(v);
    visuals?.setTextures({ videoTex: tex });
    setStatus(`video texture set: ${file.name}`);
  } else if (file.type.startsWith('image/')) {
    const THREE = await import('https://unpkg.com/three@0.160.0/build/three.module.js');
    const loader = new THREE.TextureLoader();
    const url = URL.createObjectURL(file);
    await new Promise((res, rej) => {
      loader.load(url, (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        if (kind === 'disp') visuals?.setTextures({ dispTex: tex });
        else visuals?.setTextures({ mapTex: tex });
        res();
      }, undefined, rej);
    });
    setStatus(`${kind==='disp'?'displacement':'texture'} set: ${file.name}`);
  } else {
    setStatus('unsupported asset type');
  }
}

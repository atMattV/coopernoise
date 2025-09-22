// Record canvas + audio to MediaRecorder; try native MP4; else WebM; allow conversion with ffmpeg.wasm.
export class AVRecorder {
  constructor(canvas, audioStream) {
    this.canvas = canvas;
    this.audioStream = audioStream; // MediaStreamDestination().stream
    this.chunks = [];
    this.recorder = null;
    this.lastBlob = null;
  }

  // Options: { fps, mimeHint: 'auto'|'webm'|'mp4', width, height }
  createMixedStream({ fps = 60 } = {}) {
    const canvasStream = this.canvas.captureStream(fps);
    const merged = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(this.audioStream ? this.audioStream.getAudioTracks() : [])
    ]);
    return merged;
  }

  static pickMime(preference = 'auto') {
    const tryTypes = [];
    if (preference === 'mp4') {
      tryTypes.push('video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4');
    }
    if (preference === 'webm' || preference === 'auto') {
      tryTypes.push('video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm');
    }
    if (preference === 'auto') {
      tryTypes.unshift('video/mp4;codecs=avc1.42E01E,mp4a.40.2'); // attempt mp4 first if available
    }
    for (const t of tryTypes) if (MediaRecorder.isTypeSupported(t)) return t;
    return ''; // let MediaRecorder decide
  }

  start({ mimeHint = 'auto', fps = 60, onData } = {}) {
    this.chunks = [];
    const stream = this.createMixedStream({ fps });
    const mimeType = AVRecorder.pickMime(mimeHint);
    this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 14_000_000 });
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) { this.chunks.push(e.data); onData && onData(e.data); } };
    this.recorder.start();
  }

  stop({ filename = 'take.webm' } = {}) {
    return new Promise((resolve) => {
      if (!this.recorder) return resolve(null);
      this.recorder.onstop = () => {
        const mime = this.recorder.mimeType || 'video/webm';
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(this.chunks, { type: mime });
        this.lastBlob = blob;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename.endsWith(ext) ? filename : `${filename.replace(/\.\w+$/, '')}.${ext}`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        resolve(blob);
      };
      this.recorder.stop();
    });
  }
}

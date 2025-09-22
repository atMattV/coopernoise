// In-browser WebM → MP4/MOV conversion using FFmpeg.wasm (ESM)
let ff, util, ffmpeg;

async function ensureFFmpeg() {
  if (ffmpeg) return ffmpeg;
  // NB: versions here are commonly workable; if you change, keep both packages aligned.
  ff = await import('https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/esm/index.js');
  util = await import('https://unpkg.com/@ffmpeg/util@0.12.6/dist/esm/index.js');
  ffmpeg = new ff.FFmpeg();
  await ffmpeg.load();
  return ffmpeg;
}

/**
 * Convert a recorded WebM Blob into MP4 or MOV.
 * Strategy: prefer broadly-supported MPEG-4 Part 2 video for wasm reliability.
 * MP4:  mpeg4 video + AAC audio
 * MOV:  mpeg4 video + PCM audio
 */
export async function convertWebMBlob(blob, fmt = 'mp4') {
  if (!['mp4','mov'].includes(fmt)) throw new Error('fmt must be mp4 or mov');
  const ffm = await ensureFFmpeg();

  const inName = 'in.webm';
  const outName = fmt === 'mp4' ? 'out.mp4' : 'out.mov';
  await ffm.writeFile(inName, await util.fetchFile(blob));

  const args = fmt === 'mp4'
    ? ['-i','in.webm','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2',
       '-c:v','mpeg4','-q:v','3',
       '-c:a','aac','-b:a','192k',
       '-movflags','+faststart',
       outName]
    : ['-i','in.webm','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2',
       '-c:v','mpeg4','-q:v','3',
       '-c:a','pcm_s16le',
       '-f','mov', outName];

  await ffm.exec(args);
  const data = await ffm.readFile(outName);
  const type = fmt === 'mp4' ? 'video/mp4' : 'video/quicktime';
  return new Blob([data.buffer], { type });
}

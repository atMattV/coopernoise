// Simple keyword → parameter mapping for style guidance
export function interpretPrompt(input) {
  const p = (input || '').toLowerCase();

  const style = {
    hue: 0.66,            // base hue (0..1)
    saturation: 0.5,
    lightness: 0.58,
    emissive: 0.6,
    noiseScale: 0.55,
    displaceAmp: 0.85,
    rotateBase: 0.12,
    cameraDrift: 1.0,
    audioReact: 0.35,
    wireframe: false,
    toon: false,
    kaleidoscope: false,
    shapeBias: null,      // 'sphere' | 'icosa' | 'torus' | 'plane' | 'box' | null
  };

  const has = (k) => p.includes(k);

  // Color & vibe
  if (has('purple') || has('violet')) style.hue = 0.75;
  if (has('blue')) style.hue = 0.6;
  if (has('teal')) style.hue = 0.5;
  if (has('green')) style.hue = 0.35;
  if (has('red')) style.hue = 0.02;
  if (has('neon')) { style.emissive = 1.0; style.saturation = 0.8; }
  if (has('glassy') || has('glass')) { style.lightness = 0.7; style.emissive += 0.2; }
  if (has('dark') || has('noir')) { style.lightness = 0.4; style.emissive *= 0.7; }

  // Geometry/animation
  if (has('wireframe')) style.wireframe = true;
  if (has('toon')) style.toon = true;
  if (has('kaleido') || has('kaleidoscope')) style.kaleidoscope = true;

  if (has('organic') || has('liquid')) { style.noiseScale = 0.45; style.displaceAmp = 1.0; }
  if (has('fracture') || has('crystal')) { style.noiseScale = 0.85; style.displaceAmp = 0.7; }
  if (has('low displacement')) style.displaceAmp *= 0.6;
  if (has('high displacement')) style.displaceAmp *= 1.4;

  if (has('slow camera')) style.cameraDrift = 0.6;
  if (has('fast camera')) style.cameraDrift = 1.5;

  if (has('more reactive')) style.audioReact *= 1.5;
  if (has('less reactive')) style.audioReact *= 0.6;

  if (has('sphere')) style.shapeBias = 'sphere';
  if (has('icosa')) style.shapeBias = 'icosa';
  if (has('torus')) style.shapeBias = 'torus';
  if (has('plane')) style.shapeBias = 'plane';
  if (has('box')) style.shapeBias = 'box';

  return style;
}

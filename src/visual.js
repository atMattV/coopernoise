import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { Perlin, map, clamp, mulberry32 } from './noise.js';

export class Visuals {
  constructor({ container, seed = 123456 }) {
    this.container = container;
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    this.perlin = new Perlin(seed);
    this.rand = mulberry32((typeof seed === 'string') ? this.perlin._hashString(seed) : seed);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08080c);
    this.scene.fog = new THREE.Fog(0x060608, 12, 64);

    this.camera = new THREE.PerspectiveCamera(60, this.width/this.height, 0.1, 1000);
    this.camera.position.set(0, 0, 8);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(this.width, this.height);
    container.appendChild(this.renderer.domElement);

    // Lighting
    this.amb = new THREE.AmbientLight(0xffffff, 0.3);
    this.key = new THREE.PointLight(0x9f88ff, 1.2, 100); this.key.position.set(6, 8, 6);
    this.rim = new THREE.PointLight(0x66e0ff, 0.9, 100); this.rim.position.set(-7, -5, -3);
    this.scene.add(this.amb, this.key, this.rim);

    // Defaults
    this.mesh = null;
    this.shape = 'sphere';
    this.style = { hue:0.66, saturation:0.5, lightness:0.58, emissive:0.6, noiseScale:0.55, displaceAmp:0.85, rotateBase:0.12, cameraDrift:1.0, audioReact:0.35, wireframe:false, toon:false, kaleidoscope:false, shapeBias:null };

    // Materials
    this.material = this._createMaterial();
    this._buildMesh('sphere');

    // Assets
    this.mapTex = null;
    this.dispTex = null;
    this.videoTex = null;

    // Timing
    this.timeScale = 0.25;
    this.bgHue = this.style.hue;

    window.addEventListener('resize', () => this._onResize());
  }

  _createMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(this.style.hue, this.style.saturation, this.style.lightness),
      metalness: 0.45,
      roughness: 0.35,
      emissive: new THREE.Color().setHSL(this.style.hue + 0.05, 0.8, 0.15),
      emissiveIntensity: this.style.emissive,
      flatShading: false,
      wireframe: this.style.wireframe,
      displacementScale: 0.0
    });
    if (this.style.toon) {
      mat.roughness = 0.85;
      mat.metalness = 0.1;
    }
    return mat;
  }

  applyStyle(style) {
    this.style = { ...this.style, ...style };
    // rebuild material to apply wireframe/toon cleanly
    const old = this.material;
    this.material = this._createMaterial();
    if (old) { old.dispose?.(); }
    if (this.mesh) this.mesh.material = this.material;
    if (style.shapeBias) this.setShape(style.shapeBias);
    this.bgHue = this.style.hue;
    // apply existing textures
    if (this.mapTex) this.material.map = this.mapTex;
    if (this.dispTex) { this.material.displacementMap = this.dispTex; this.material.displacementScale = 0.4 * this.style.displaceAmp; }
    if (this.videoTex) this.material.map = this.videoTex;
    this.material.needsUpdate = true;
  }

  setSeed(seed) {
    this.perlin.setSeed(seed);
    this.rand = mulberry32((typeof seed === 'string') ? this.perlin._hashString(seed) : seed);
  }

  setShape(shape) {
    if (shape === 'cycle') return;
    if (shape === this.shape) return;
    this._buildMesh(shape);
  }

  setRenderSize(w, h) {
    this.width = w; this.height = h;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  setTextures({ mapTex=null, dispTex=null, videoTex=null } = {}) {
    this.mapTex = mapTex || this.mapTex;
    this.dispTex = dispTex || this.dispTex;
    this.videoTex = videoTex || this.videoTex;

    if (this.material) {
      this.material.map = this.videoTex || this.mapTex || null;
      this.material.displacementMap = this.dispTex || null;
      this.material.displacementScale = this.dispTex ? (0.4 * this.style.displaceAmp) : 0.0;
      this.material.needsUpdate = true;
    }
  }

  _buildMesh(shape) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.shape = shape;
    let geometry;
    switch (shape) {
      case 'icosa': geometry = new THREE.IcosahedronGeometry(2.2, 4); break;
      case 'torus': geometry = new THREE.TorusKnotGeometry(1.6, 0.52, 320, 16); break;
      case 'plane': geometry = new THREE.PlaneGeometry(7, 7, 220, 220); break;
      case 'box': geometry = new THREE.BoxGeometry(3.2, 3.2, 3.2, 60, 60, 60); break;
      case 'sphere':
      default: geometry = new THREE.SphereGeometry(2.2, 160, 120); break;
    }
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.scene.add(this.mesh);
    const posAttr = this.mesh.geometry.attributes.position;
    this.basePositions = new Float32Array(posAttr.array.length);
    this.basePositions.set(posAttr.array);
  }

  setBarSeconds(barSeconds) { this._barSeconds = barSeconds; }
  scheduleAutoShape(startTime, barSeconds) { this._scheduleNextShape(startTime, barSeconds); }
  _scheduleNextShape(t, barSeconds) { this._nextShapeAt = t + 16 * (barSeconds || 7.5); }

  update({ t, level = 0.0, beatPulse = 0.0, autoShape = true }) {
    const g = this.mesh.geometry;
    const pos = g.attributes.position.array;
    const base = this.basePositions;

    this.level = this.level ? this.level * 0.85 + level * 0.15 : level;
    const pulse = Math.max(beatPulse, Math.pow(clamp(this.level, 0, 1), 0.9));

    // hue/emit drift
    const hueShift = 0.02 * Math.sin(t * 0.07);
    const mat = this.mesh.material;
    mat.color.setHSL(this.style.hue + hueShift, this.style.saturation, this.style.lightness + 0.05 * pulse);
    mat.emissiveIntensity = this.style.emissive * (0.6 + 0.9 * pulse);

    // background/fog
    const bg = new THREE.Color().setHSL(this.style.hue - 0.06 + 0.04*Math.cos(t*0.05), 0.35, 0.06 + 0.02*pulse);
    this.scene.background = bg;
    this.scene.fog.color = bg;

    // camera drift (kaleidoscope optionally constrains to octants)
    const k = this.style.kaleidoscope ? (x)=>Math.sign(x)*Math.pow(Math.abs(x),0.5) : (x)=>x;
    const drift = this.style.cameraDrift;
    const cr = 8.0 + 2.0 * this.perlin.fbm3(0.2*t*drift, 0.5, 0.7);
    const cay = k(0.6 * this.perlin.fbm3(0.12*t*drift, 2.3, 1.1));
    const cax = k(0.4 * this.perlin.fbm3(0.13*t*drift + 4.1, 0.9, 3.3));
    this.camera.position.set(cr * Math.sin(cay), cax, cr * Math.cos(cay));
    this.camera.lookAt(0,0,0);

    // Vertex displacement by fBm (additional displacementMap is handled by material)
    const freq = this.style.noiseScale;
    const speed = this.timeScale;
    const amp = this.style.displaceAmp * (0.6 + this.style.audioReact * pulse);
    for (let i = 0; i < pos.length; i+=3) {
      const x0 = base[i], y0 = base[i+1], z0 = base[i+2];
      const n = this.perlin.fbm3(x0*freq + t*speed, y0*freq + 3.123, z0*freq - 1.789, 5, 2.0, 0.5);
      const d = 1.0 + amp * n;
      pos[i]   = x0 * d;
      pos[i+1] = y0 * d;
      pos[i+2] = z0 * d;
    }
    g.attributes.position.needsUpdate = true;
    g.computeVertexNormals();

    const rot = (this.style.rotateBase + 0.2 * pulse);
    this.mesh.rotation.y += rot * 0.016;
    this.mesh.rotation.x += rot * 0.009;

    if (autoShape && this._nextShapeAt && t >= this._nextShapeAt) {
      const shapes = ['sphere','icosa','torus','plane','box'];
      const idx = Math.floor(this.rand() * shapes.length);
      this._buildMesh(shapes[idx]);
      this._scheduleNextShape(t, this._barSeconds || 7.5);
    }

    if (this.videoTex) {
      this.videoTex.needsUpdate = true;
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }

  getCanvas() { return this.renderer.domElement; }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w/h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}

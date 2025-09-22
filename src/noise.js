export class Perlin {
  constructor(seed = 123456) {
    this._perm = new Uint8Array(512);
    this.setSeed(seed);
  }
  setSeed(seed) {
    this._seed = (typeof seed === 'string') ? this._hashString(seed) : seed >>> 0;
    const p = new Uint8Array(256);
    const rand = mulberry32(this._seed);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this._perm[i] = p[i & 255];
  }
  fade(t){ return t * t * t * (t * (t * 6 - 15) + 10); }
  lerp(t,a,b){ return a + t * (b - a); }
  grad(hash, x, y, z){
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }
  noise3(x, y, z){
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = this.fade(x), v = this.fade(y), w = this.fade(z);
    const p = this._perm;
    const A  = p[X] + Y,  AA = p[A] + Z,  AB = p[A + 1] + Z;
    const B  = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const res = this.lerp(w,
      this.lerp(v,
        this.lerp(u, this.grad(p[AA], x, y, z),      this.grad(p[BA], x-1, y, z)),
        this.lerp(u, this.grad(p[AB], x, y-1, z),    this.grad(p[BB], x-1, y-1, z))
      ),
      this.lerp(v,
        this.lerp(u, this.grad(p[AA+1], x, y, z-1),  this.grad(p[BA+1], x-1, y, z-1)),
        this.lerp(u, this.grad(p[AB+1], x, y-1, z-1),this.grad(p[BB+1], x-1, y-1, z-1))
      )
    );
    return res;
  }
  noise2(x, y){ return this.noise3(x, y, 0); }
  noise1(x){ return this.noise3(x, 0, 0); }
  fbm3(x, y, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 0.5, freq = 1.0, sum = 0.0;
    for (let i=0; i<octaves; i++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      freq *= lacunarity;
      amp *= gain;
    }
    return sum;
  }
  _hashString(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
}
export function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
export const map = (v, inMin, inMax, outMin, outMax) =>
  outMin + (outMax - outMin) * ((v - inMin) / (inMax - inMin));
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

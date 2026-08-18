/**
 * APEX F1 — src/track/geometry.js
 * ---------------------------------------------------------------------------
 * Turns a track spline into the world you actually drive through.
 *
 *   buildTrackWorld(circuit, curve, opts) -> world
 *
 * Everything here is procedural: no external images, no network, no build step.
 * All textures are painted onto 2D canvases at init and cached for the lifetime
 * of the world. All static geometry is either merged into a handful of large
 * BufferGeometries or drawn with InstancedMesh; the whole circuit lands well
 * under the 450 draw-call budget on the 'high' tier.
 *
 * Conventions (see ARCHITECTURE.md): metres / radians, +Y up, right-handed.
 * "lateral" is the track's right-hand direction (tangent x up).
 * Normalised circuit ranges (0..1) are fractions of TOTAL CURVE LENGTH.
 *
 * This module imports only 'three', 'three/addons/...' and '../game/teams.js',
 * has zero side effects at import time, and never throws out of a public method.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TEAMS } from '../game/teams.js';

/* ===========================================================================
 * 0. Module-scope scratch. NEVER allocate inside update().
 * ========================================================================= */

const _up = new THREE.Vector3(0, 1, 0);
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();
const _col0 = new THREE.Color();
const _col1 = new THREE.Color();
const _col2 = new THREE.Color();

/* Reusable frame results for surface sampling (init + update safe). */
function makeFrameSlot() {
  return {
    pos: new THREE.Vector3(),
    tan: new THREE.Vector3(),
    nrm: new THREE.Vector3(),
    lat: new THREE.Vector3(),
    width: 6.0,
    bank: 0,
    line: 0,
    s: 0,
  };
}
const _frA = makeFrameSlot();
const _frB = makeFrameSlot();
const _frC = makeFrameSlot();

/* ===========================================================================
 * 1. Small maths helpers
 * ========================================================================= */

const TAU = Math.PI * 2;

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}
function wrapIndex(i, n) { return ((i % n) + n) % n; }
function catmullRom1D(p0, p1, p2, p3, t) {
  const v0 = (p2 - p0) * 0.5;
  const v1 = (p3 - p1) * 0.5;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * t + p1;
}

/** Deterministic PRNG so a circuit always dresses itself identically. */
function mulberry32(a) {
  let s = a | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ihash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Periodic value noise — used so every generated texture tiles seamlessly. */
function pnoise(x, y, P, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = wrapIndex(xi, P), x1 = wrapIndex(xi + 1, P);
  const y0 = wrapIndex(yi, P), y1 = wrapIndex(yi + 1, P);
  const a = ihash(x0, y0, seed), b = ihash(x1, y0, seed);
  const c = ihash(x0, y1, seed), d = ihash(x1, y1, seed);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

function pfbm(x, y, P, seed, oct) {
  let f = 1, amp = 0.5, sum = 0, norm = 0;
  const n = oct || 4;
  for (let i = 0; i < n; i++) {
    sum += amp * pnoise(x * f, y * f, Math.max(1, Math.round(P * f)), seed + i * 131);
    norm += amp;
    f *= 2; amp *= 0.5;
  }
  return sum / (norm || 1);
}

/** Non-tiling 2D noise for world-space scatter (terrain, hills). */
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = ihash(xi, yi, seed), b = ihash(xi + 1, yi, seed);
  const c = ihash(xi, yi + 1, seed), d = ihash(xi + 1, yi + 1, seed);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}
function vfbm(x, y, seed, oct) {
  let f = 1, amp = 0.5, sum = 0, norm = 0;
  const n = oct || 4;
  for (let i = 0; i < n; i++) { sum += amp * vnoise(x * f, y * f, seed + i * 57); norm += amp; f *= 2; amp *= 0.5; }
  return sum / (norm || 1);
}

/** Wrap-around box blur over a closed-loop signal. */
function blurLoop(src, radius, passes) {
  const n = src.length;
  if (n === 0 || radius < 1) return src;
  let a = src;
  let b = new Float32Array(n);
  const p = passes || 1;
  for (let k = 0; k < p; k++) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = -radius; j <= radius; j++) sum += a[wrapIndex(i + j, n)];
      b[i] = sum / (radius * 2 + 1);
    }
    const t = a; a = b; b = t;
  }
  if (a !== src) src.set(a);
  return src;
}

/* ===========================================================================
 * 2. Quality tiers
 * ========================================================================= */

const TIERS = {
  low: {
    lonStep: 5.5, kerbStep: 0.55, rumble: false, tex: 256, aniso: 1,
    crowd: 0.18, trees: 0.30, armcoLen: 8, postEvery: 2, tyreRows: 2,
    detail: 0, poleEvery: 100, pointLights: 0, terrainSeg: 40,
    shadows: false, gravelDetail: 0, fenceLod: 0, billboardEvery: 900,
  },
  medium: {
    lonStep: 3.6, kerbStep: 0.42, rumble: true, tex: 512, aniso: 4,
    crowd: 0.45, trees: 0.62, armcoLen: 6, postEvery: 2, tyreRows: 3,
    detail: 1, poleEvery: 75, pointLights: 2, terrainSeg: 64,
    shadows: true, gravelDetail: 1, fenceLod: 1, billboardEvery: 750,
  },
  high: {
    lonStep: 2.5, kerbStep: 0.28, rumble: true, tex: 1024, aniso: 8,
    crowd: 1.0, trees: 1.0, armcoLen: 4, postEvery: 1, tyreRows: 3,
    detail: 2, poleEvery: 55, pointLights: 4, terrainSeg: 96,
    shadows: true, gravelDetail: 2, fenceLod: 1, billboardEvery: 620,
  },
  ultra: {
    lonStep: 2.0, kerbStep: 0.22, rumble: true, tex: 1024, aniso: 16,
    crowd: 1.35, trees: 1.35, armcoLen: 4, postEvery: 1, tyreRows: 4,
    detail: 3, poleEvery: 45, pointLights: 6, terrainSeg: 128,
    shadows: true, gravelDetail: 3, fenceLod: 2, billboardEvery: 520,
  },
};

function resolveQuality(q) {
  const src = q && typeof q === 'object' ? q : {};
  const tier = TIERS[src.tier] ? src.tier : 'high';
  const base = TIERS[tier];
  const out = {};
  for (const k in base) out[k] = base[k];
  out.tier = tier;
  if (typeof src.anisotropy === 'number') out.aniso = clamp(Math.round(src.anisotropy), 1, 16);
  if (typeof src.crowdDensity === 'number') out.crowd = base.crowd * clamp(src.crowdDensity, 0, 2);
  if (typeof src.shadows === 'boolean') out.shadows = src.shadows;
  out.reflections = typeof src.reflections === 'boolean' ? src.reflections : tier !== 'low';
  out.particles = typeof src.particles === 'number' ? src.particles : 1;
  out.raw = src;
  return out;
}

/* ===========================================================================
 * 3. Canvas + texture plumbing
 * ========================================================================= */

function createCanvas(w, h) {
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
  } catch (e) { /* headless */ }
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  } catch (e) { /* unsupported */ }
  return null;
}

function ctx2d(canvas) {
  if (!canvas) return null;
  try { return canvas.getContext('2d', { willReadFrequently: true }); } catch (e) { return null; }
}

function makeTex(W, canvas, opt) {
  if (!canvas) return null;
  try {
    const o = opt || {};
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = o.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.wrapT = o.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    t.anisotropy = o.aniso || W.quality.aniso;
    t.generateMipmaps = o.mips === false ? false : true;
    t.minFilter = o.mips === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    if (o.repeat) t.repeat.set(o.repeat[0], o.repeat[1]);
    t.needsUpdate = true;
    W.texes.push(t);
    return t;
  } catch (e) { return null; }
}

/**
 * Clone a generated texture set so it can carry a different physical tiling.
 * Cloned textures share the source canvas but get their own repeat/offset.
 */
function cloneTexSet(W, set, rep) {
  const out = {};
  if (!set) return out;
  const keys = ['albedo', 'normal', 'rough', 'emissive'];
  for (let i = 0; i < keys.length; i++) {
    const src = set[keys[i]];
    if (!src) continue;
    try {
      const t = src.clone();
      t.repeat.set(rep, rep);
      t.needsUpdate = true;
      W.texes.push(t);
      out[keys[i]] = t;
    } catch (e) { out[keys[i]] = src; }
  }
  return out;
}

/** Draw an ellipse plus its 8 wrapped neighbours so the tile is seamless. */
function wrapEllipse(c, size, x, y, rx, ry, rot) {
  const pad = Math.max(rx, ry) * 2 + 2;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const px = x + dx * size, py = y + dy * size;
      if (px < -pad || px > size + pad || py < -pad || py > size + pad) continue;
      c.beginPath();
      c.ellipse(px, py, rx, ry, rot, 0, TAU);
      c.fill();
    }
  }
}

function wrapRect(c, size, x, y, w, h) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const px = x + dx * size, py = y + dy * size;
      if (px + w < -2 || px > size + 2 || py + h < -2 || py > size + 2) continue;
      c.fillRect(px, py, w, h);
    }
  }
}

/** Convert a wrapping height field (Float32Array, size*size) into a normal map. */
function heightToNormalCanvas(height, size, strength) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return null;
  const img = c.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size;
    const yp = ((y + 1) % size) * size;
    const yc = y * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const nx = (height[yc + xm] - height[yc + xp]) * strength;
      const ny = (height[yp + x] - height[ym + x]) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (yc + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  return cv;
}

/** Build a greyscale canvas from a per-pixel callback returning 0..1. */
function scalarCanvas(size, fn) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return null;
  const img = c.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = clamp(fn(x, y), 0, 1) * 255;
      const i = (y * size + x) * 4;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  return cv;
}

function luminanceField(c, size) {
  const out = new Float32Array(size * size);
  try {
    const img = c.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) / 255;
    }
  } catch (e) { /* tainted / unsupported */ }
  return out;
}

/* ---------------------------------------------------------------------------
 * 3a. ASPHALT — aggregate albedo + normal + roughness
 * ------------------------------------------------------------------------ */

function genAsphalt(W, size) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return { albedo: null, normal: null, rough: null };

  const rnd = mulberry32(0x51f3a2);
  const P = 8;

  // Base: dark bitumen with slow tonal drift.
  const img = c.createImageData(size, size);
  const d = img.data;
  const sc = P / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = pfbm(x * sc, y * sc, P, 991, 4);
      const g = 30 + n * 20;
      const i = (y * size + x) * 4;
      d[i] = g * 1.02; d[i + 1] = g; d[i + 2] = g * 1.06; d[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);

  // Aggregate stones — three size classes, wrapped so the tile is seamless.
  const classes = [
    { n: Math.round(size * size / 900), r: size / 96, jit: 0.55 },
    { n: Math.round(size * size / 260), r: size / 170, jit: 0.45 },
    { n: Math.round(size * size / 90), r: size / 320, jit: 0.35 },
  ];
  for (let k = 0; k < classes.length; k++) {
    const cl = classes[k];
    for (let i = 0; i < cl.n; i++) {
      const x = rnd() * size, y = rnd() * size;
      const rx = cl.r * (0.55 + rnd() * 0.9);
      const ry = rx * (0.6 + rnd() * 0.7);
      const rot = rnd() * TAU;
      const base = 62 + rnd() * 92 * cl.jit + (k === 0 ? 22 : 0);
      const warm = rnd() * 10 - 4;
      c.fillStyle = 'rgb(' + Math.round(base + warm) + ',' + Math.round(base) + ',' + Math.round(base - warm * 0.4) + ')';
      c.globalAlpha = 0.55 + rnd() * 0.45;
      wrapEllipse(c, size, x, y, rx, ry, rot);
      // tiny specular chip on one side of the larger stones
      if (k === 0 && rnd() > 0.55) {
        c.fillStyle = 'rgb(' + Math.round(base + 55) + ',' + Math.round(base + 52) + ',' + Math.round(base + 48) + ')';
        c.globalAlpha = 0.35;
        wrapEllipse(c, size, x - rx * 0.25, y - ry * 0.25, rx * 0.4, ry * 0.4, rot);
      }
    }
  }
  c.globalAlpha = 1;

  // Tar bleed streaks — thin darker smears along the driving direction.
  for (let i = 0; i < Math.round(size / 12); i++) {
    const x = rnd() * size;
    const w = size / 90 + rnd() * (size / 40);
    c.fillStyle = 'rgba(14,14,16,' + (0.06 + rnd() * 0.12).toFixed(3) + ')';
    wrapRect(c, size, x, -2, w, size + 4);
  }

  // Fine grain, per-pixel.
  try {
    const im2 = c.getImageData(0, 0, size, size);
    const d2 = im2.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const g = (ihash(x, y, 4441) - 0.5) * 26;
        const i = (y * size + x) * 4;
        d2[i] = clamp(d2[i] + g, 0, 255);
        d2[i + 1] = clamp(d2[i + 1] + g, 0, 255);
        d2[i + 2] = clamp(d2[i + 2] + g, 0, 255);
      }
    }
    c.putImageData(im2, 0, 0);
  } catch (e) { /* ignore */ }

  const lum = luminanceField(c, size);

  // Height field: stones stand proud, plus micro pitting.
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const pit = pfbm(x * (32 / size), y * (32 / size), 32, 7777, 3);
      height[i] = lum[i] * 0.82 + pit * 0.18;
    }
  }
  const normal = heightToNormalCanvas(height, size, size * 0.030);

  // Roughness: coarse where stones are exposed, smoother in the bitumen.
  const rough = scalarCanvas(size, function (x, y) {
    const i = y * size + x;
    const macro = pfbm(x * (6 / size), y * (6 / size), 6, 313, 3);
    return 0.70 + lum[i] * 0.22 + macro * 0.10;
  });

  return {
    albedo: makeTex(W, cv, { srgb: true }),
    normal: makeTex(W, normal, {}),
    rough: makeTex(W, rough, {}),
  };
}

/* ---------------------------------------------------------------------------
 * 3b. KERB — red/white banding with rubber, chips and grime
 * ------------------------------------------------------------------------ */

function genKerb(W, size, colA, colB) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return { albedo: null, normal: null, rough: null };
  const rnd = mulberry32(0x2ab7c1);

  // Two bands stacked vertically -> repeat.y = 0.5 gives 1 m stripes.
  c.fillStyle = colA || '#c4202c';
  c.fillRect(0, 0, size, size * 0.5);
  c.fillStyle = colB || '#eceae4';
  c.fillRect(0, size * 0.5, size, size * 0.5);

  // Painted edge softening between bands.
  for (let b = 0; b < 2; b++) {
    const y = b === 0 ? size * 0.5 : 0;
    c.fillStyle = 'rgba(0,0,0,0.16)';
    c.fillRect(0, y - 1, size, 2);
  }

  // Rubber deposits and scuffs concentrated on the inner half (low x).
  for (let i = 0; i < Math.round(size * 0.9); i++) {
    const x = Math.pow(rnd(), 1.7) * size;
    const y = rnd() * size;
    const rx = size * (0.01 + rnd() * 0.06);
    const ry = size * (0.004 + rnd() * 0.02);
    c.fillStyle = 'rgba(24,22,22,' + (0.05 + rnd() * 0.20).toFixed(3) + ')';
    wrapEllipse(c, size, x, y, rx, ry, rnd() * 0.6 - 0.3);
  }

  // Chipped paint revealing grey concrete.
  for (let i = 0; i < Math.round(size * 0.35); i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = size * (0.004 + rnd() * 0.016);
    const g = 108 + rnd() * 42;
    c.fillStyle = 'rgb(' + Math.round(g) + ',' + Math.round(g * 0.98) + ',' + Math.round(g * 0.94) + ')';
    c.globalAlpha = 0.5 + rnd() * 0.5;
    wrapEllipse(c, size, x, y, r, r * (0.6 + rnd() * 0.8), rnd() * TAU);
  }
  c.globalAlpha = 1;

  // Grime gradient toward the outer edge.
  for (let i = 0; i < Math.round(size * 0.5); i++) {
    const x = size - Math.pow(rnd(), 1.5) * size * 0.45;
    const y = rnd() * size;
    c.fillStyle = 'rgba(58,52,42,' + (0.03 + rnd() * 0.10).toFixed(3) + ')';
    wrapEllipse(c, size, x, y, size * 0.05, size * 0.03, 0);
  }

  const lum = luminanceField(c, size);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      height[i] = 0.55 * pfbm(x * (24 / size), y * (24 / size), 24, 1319, 3) + lum[i] * 0.12;
    }
  }
  const normal = heightToNormalCanvas(height, size, size * 0.012);
  const rough = scalarCanvas(size, function (x, y) {
    const i = y * size + x;
    return 0.42 + (1 - lum[i]) * 0.20 + pfbm(x * (10 / size), y * (10 / size), 10, 77, 2) * 0.16;
  });

  return {
    albedo: makeTex(W, cv, { srgb: true }),
    normal: makeTex(W, normal, {}),
    rough: makeTex(W, rough, {}),
  };
}

/* ---------------------------------------------------------------------------
 * 3c. GRASS / GRAVEL / ASTRO / CONCRETE
 * ------------------------------------------------------------------------ */

function genGrass(W, size) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return { albedo: null, normal: null, rough: null };
  const rnd = mulberry32(0x7bd11e);

  const img = c.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const patch = pfbm(x * (5 / size), y * (5 / size), 5, 221, 4);
      const fine = pfbm(x * (40 / size), y * (40 / size), 40, 909, 2);
      const g = 62 + patch * 58 + fine * 26;
      const i = (y * size + x) * 4;
      d[i] = g * 0.44; d[i + 1] = g; d[i + 2] = g * 0.32; d[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);

  // Blades.
  const blades = Math.round(size * size / 34);
  for (let i = 0; i < blades; i++) {
    const x = rnd() * size, y = rnd() * size;
    const len = size * (0.006 + rnd() * 0.018);
    const ang = -Math.PI * 0.5 + (rnd() - 0.5) * 1.4;
    const g = 60 + rnd() * 96;
    c.strokeStyle = 'rgba(' + Math.round(g * 0.42) + ',' + Math.round(g) + ',' + Math.round(g * 0.3) + ',' + (0.25 + rnd() * 0.5).toFixed(2) + ')';
    c.lineWidth = Math.max(0.6, size / 900);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const px = x + dx * size, py = y + dy * size;
        if (px < -len * 2 || px > size + len * 2 || py < -len * 2 || py > size + len * 2) continue;
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
        c.stroke();
      }
    }
  }
  // Dry / worn patches.
  for (let i = 0; i < Math.round(size / 22); i++) {
    const x = rnd() * size, y = rnd() * size;
    c.fillStyle = 'rgba(126,116,66,' + (0.06 + rnd() * 0.14).toFixed(3) + ')';
    wrapEllipse(c, size, x, y, size * (0.03 + rnd() * 0.09), size * (0.02 + rnd() * 0.07), rnd() * TAU);
  }

  const lum = luminanceField(c, size);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = lum[i];
  const normal = heightToNormalCanvas(height, size, size * 0.010);
  const rough = scalarCanvas(size, function (x, y) {
    return 0.86 + pfbm(x * (12 / size), y * (12 / size), 12, 31, 2) * 0.12;
  });
  return {
    albedo: makeTex(W, cv, { srgb: true }),
    normal: makeTex(W, normal, {}),
    rough: makeTex(W, rough, {}),
  };
}

function genGravel(W, size) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return { albedo: null, normal: null, rough: null };
  const rnd = mulberry32(0x3d9a77);

  c.fillStyle = '#b0a184';
  c.fillRect(0, 0, size, size);
  const img = c.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = pfbm(x * (7 / size), y * (7 / size), 7, 515, 4);
      const i = (y * size + x) * 4;
      const t = 0.82 + n * 0.36;
      d[i] = clamp(176 * t, 0, 255);
      d[i + 1] = clamp(161 * t, 0, 255);
      d[i + 2] = clamp(132 * t, 0, 255);
    }
  }
  c.putImageData(img, 0, 0);

  const pebbles = Math.round(size * size / 44);
  for (let i = 0; i < pebbles; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = size * (0.003 + Math.pow(rnd(), 2.4) * 0.020);
    const base = 128 + rnd() * 104;
    const tint = rnd();
    c.fillStyle = 'rgb(' + Math.round(base) + ',' + Math.round(base * (0.88 + tint * 0.1)) + ',' + Math.round(base * (0.70 + tint * 0.12)) + ')';
    wrapEllipse(c, size, x, y, r, r * (0.7 + rnd() * 0.6), rnd() * TAU);
    // shadow side
    c.fillStyle = 'rgba(60,50,36,0.30)';
    wrapEllipse(c, size, x + r * 0.35, y + r * 0.35, r * 0.7, r * 0.5, 0);
  }

  const lum = luminanceField(c, size);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      height[i] = lum[i] * 0.75 + pfbm(x * (48 / size), y * (48 / size), 48, 61, 2) * 0.25;
    }
  }
  const normal = heightToNormalCanvas(height, size, size * 0.055);
  const rough = scalarCanvas(size, function () { return 0.94; });
  return {
    albedo: makeTex(W, cv, { srgb: true }),
    normal: makeTex(W, normal, {}),
    rough: makeTex(W, rough, {}),
  };
}

function genAstro(W, size) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return { albedo: null, normal: null, rough: null };
  const rnd = mulberry32(0x11e4b3);

  c.fillStyle = '#1f6b32';
  c.fillRect(0, 0, size, size);
  // Mown stripes running across the strip.
  const bands = 8;
  for (let i = 0; i < bands; i++) {
    if (i % 2 === 0) continue;
    c.fillStyle = 'rgba(255,255,255,0.055)';
    c.fillRect(0, (i / bands) * size, size, size / bands);
  }
  // White painted transverse lines (the classic astroturf hatching).
  c.fillStyle = 'rgba(236,240,232,0.80)';
  for (let i = 0; i < 4; i++) c.fillRect(0, (i / 4) * size + size * 0.10, size, size * 0.035);

  const img = c.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = (pfbm(x * (36 / size), y * (36 / size), 36, 733, 3) - 0.5) * 46;
      const i = (y * size + x) * 4;
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n * 1.2, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n * 0.7, 0, 255);
    }
  }
  c.putImageData(img, 0, 0);

  for (let i = 0; i < Math.round(size / 8); i++) {
    const x = rnd() * size, y = rnd() * size;
    c.fillStyle = 'rgba(30,26,20,' + (0.04 + rnd() * 0.10).toFixed(3) + ')';
    wrapEllipse(c, size, x, y, size * 0.04, size * 0.02, rnd() * TAU);
  }

  const lum = luminanceField(c, size);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      height[y * size + x] = pfbm(x * (60 / size), y * (60 / size), 60, 4, 2) * 0.6 + lum[y * size + x] * 0.4;
    }
  }
  const normal = heightToNormalCanvas(height, size, size * 0.014);
  const rough = scalarCanvas(size, function (x, y) {
    return 0.80 + pfbm(x * (16 / size), y * (16 / size), 16, 8, 2) * 0.16;
  });
  return {
    albedo: makeTex(W, cv, { srgb: true }),
    normal: makeTex(W, normal, {}),
    rough: makeTex(W, rough, {}),
  };
}

function genConcrete(W, size) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return { albedo: null, normal: null, rough: null };
  const rnd = mulberry32(0x9c1de7);

  const img = c.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = pfbm(x * (6 / size), y * (6 / size), 6, 1201, 4);
      const f = pfbm(x * (44 / size), y * (44 / size), 44, 88, 2);
      const g = 132 + n * 44 + f * 16;
      const i = (y * size + x) * 4;
      d[i] = g; d[i + 1] = g * 0.995; d[i + 2] = g * 0.965; d[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);

  // Slab joints on a 1/2 tile grid.
  c.strokeStyle = 'rgba(60,58,55,0.55)';
  c.lineWidth = Math.max(1, size / 340);
  c.beginPath();
  c.moveTo(0, size * 0.5); c.lineTo(size, size * 0.5);
  c.moveTo(size * 0.5, 0); c.lineTo(size * 0.5, size);
  c.moveTo(0, 0.5); c.lineTo(size, 0.5);
  c.moveTo(0.5, 0); c.lineTo(0.5, size);
  c.stroke();

  // Stains, patch repairs and pitting.
  for (let i = 0; i < Math.round(size / 6); i++) {
    const x = rnd() * size, y = rnd() * size;
    c.fillStyle = 'rgba(78,74,68,' + (0.03 + rnd() * 0.10).toFixed(3) + ')';
    wrapEllipse(c, size, x, y, size * (0.02 + rnd() * 0.10), size * (0.015 + rnd() * 0.08), rnd() * TAU);
  }
  for (let i = 0; i < Math.round(size * size / 2600); i++) {
    const x = rnd() * size, y = rnd() * size;
    c.fillStyle = 'rgba(90,86,80,0.5)';
    wrapEllipse(c, size, x, y, size * 0.004, size * 0.004, 0);
  }

  const lum = luminanceField(c, size);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = lum[i];
  const normal = heightToNormalCanvas(height, size, size * 0.012);
  const rough = scalarCanvas(size, function (x, y) {
    return 0.74 + pfbm(x * (9 / size), y * (9 / size), 9, 555, 3) * 0.18;
  });
  return {
    albedo: makeTex(W, cv, { srgb: true }),
    normal: makeTex(W, normal, {}),
    rough: makeTex(W, rough, {}),
  };
}

/* ---------------------------------------------------------------------------
 * 3d. Hardware textures: steel, tyres, fencing, crowd, flags, signage
 * ------------------------------------------------------------------------ */

function genSteel(W, size) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return { albedo: null, rough: null };
  const rnd = mulberry32(0x4f22a9);

  c.fillStyle = '#9aa0a6';
  c.fillRect(0, 0, size, size);
  // Galvanised spangle.
  for (let i = 0; i < Math.round(size * size / 700); i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = size * (0.008 + rnd() * 0.035);
    const g = 138 + rnd() * 70;
    c.fillStyle = 'rgba(' + Math.round(g) + ',' + Math.round(g + 4) + ',' + Math.round(g + 10) + ',0.5)';
    wrapEllipse(c, size, x, y, r, r * (0.5 + rnd() * 0.9), rnd() * TAU);
  }
  // Vertical brushed streaks.
  for (let i = 0; i < size; i++) {
    const x = rnd() * size;
    c.fillStyle = 'rgba(255,255,255,' + (rnd() * 0.05).toFixed(3) + ')';
    wrapRect(c, size, x, 0, Math.max(1, size / 420), size);
  }
  // Scuffs and rust freckles.
  for (let i = 0; i < Math.round(size / 5); i++) {
    const x = rnd() * size, y = rnd() * size;
    c.fillStyle = 'rgba(112,66,34,' + (0.05 + rnd() * 0.22).toFixed(3) + ')';
    wrapEllipse(c, size, x, y, size * (0.004 + rnd() * 0.02), size * (0.004 + rnd() * 0.016), rnd() * TAU);
  }
  for (let i = 0; i < Math.round(size / 9); i++) {
    const x = rnd() * size, y = rnd() * size;
    c.fillStyle = 'rgba(30,30,34,' + (0.05 + rnd() * 0.18).toFixed(3) + ')';
    wrapRect(c, size, x, y, size * (0.02 + rnd() * 0.12), Math.max(1, size / 300));
  }

  const lum = luminanceField(c, size);
  const rough = scalarCanvas(size, function (x, y) {
    const i = y * size + x;
    return 0.24 + (1 - lum[i]) * 0.42 + pfbm(x * (20 / size), y * (20 / size), 20, 991, 2) * 0.16;
  });
  return { albedo: makeTex(W, cv, { srgb: true }), rough: makeTex(W, rough, {}) };
}

function genTyreWall(W, size) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return { albedo: null, rough: null };
  const rnd = mulberry32(0x882199);
  c.fillStyle = '#18191b';
  c.fillRect(0, 0, size, size);
  // Tread blocks running around the circumference (U axis).
  const rows = 6;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 26; i++) {
      const x = (i / 26) * size + (r % 2 ? size / 52 : 0);
      const y = (r / rows) * size;
      c.fillStyle = 'rgba(56,57,60,' + (0.35 + rnd() * 0.4).toFixed(2) + ')';
      wrapRect(c, size, x, y, size / 52, size / rows * 0.62);
    }
  }
  for (let i = 0; i < Math.round(size); i++) {
    const x = rnd() * size, y = rnd() * size;
    c.fillStyle = 'rgba(96,96,100,' + (rnd() * 0.10).toFixed(3) + ')';
    wrapEllipse(c, size, x, y, size * 0.01, size * 0.006, rnd() * TAU);
  }
  const rough = scalarCanvas(size, function (x, y) {
    return 0.82 + pfbm(x * (18 / size), y * (18 / size), 18, 12, 2) * 0.14;
  });
  return { albedo: makeTex(W, cv, { srgb: true }), rough: makeTex(W, rough, {}) };
}

/** Alpha-tested diamond debris fencing. */
function genFence(W, size) {
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return null;
  c.clearRect(0, 0, size, size);
  c.strokeStyle = 'rgba(176,182,188,0.95)';
  c.lineWidth = Math.max(1.5, size / 90);
  c.beginPath();
  const cells = 6;
  const step = size / cells;
  for (let i = -cells; i <= cells * 2; i++) {
    c.moveTo(i * step, 0); c.lineTo(i * step + size, size);
    c.moveTo(i * step, size); c.lineTo(i * step + size, 0);
  }
  c.stroke();
  // Slight thickening at the crossings for a woven look.
  c.fillStyle = 'rgba(150,156,162,0.85)';
  for (let i = 0; i <= cells; i++) {
    for (let j = 0; j <= cells; j++) {
      c.beginPath();
      c.arc(i * step, j * step, size / 150, 0, TAU);
      c.fill();
    }
  }
  return makeTex(W, cv, { srgb: true });
}

/** A single spectator: head + shoulders silhouette, white so instanceColor tints it. */
function genCrowdSprite(W) {
  const size = 64;
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return null;
  c.clearRect(0, 0, size, size);
  c.fillStyle = '#ffffff';
  // torso
  c.beginPath();
  c.moveTo(size * 0.20, size * 0.98);
  c.lineTo(size * 0.24, size * 0.46);
  c.quadraticCurveTo(size * 0.5, size * 0.34, size * 0.76, size * 0.46);
  c.lineTo(size * 0.80, size * 0.98);
  c.closePath();
  c.fill();
  // head
  c.beginPath();
  c.arc(size * 0.5, size * 0.24, size * 0.155, 0, TAU);
  c.fill();
  // slight neck
  c.fillRect(size * 0.43, size * 0.32, size * 0.14, size * 0.10);
  return makeTex(W, cv, { srgb: true, clamp: true });
}

/**
 * Flag atlas, 2x2 cells:
 *   (0,0) plain      (1,0) chequered
 *   (0,1) yellow/red stripes   (1,1) black/white split
 * Cell 0 is white so instanceColor picks the flag colour.
 */
function genFlagAtlas(W) {
  const S = 256, H = S / 2;
  const cv = createCanvas(S, S);
  const c = ctx2d(cv);
  if (!c) return null;
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, H, H);
  // chequered
  const n = 8, cs = H / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      c.fillStyle = ((x + y) % 2) ? '#ffffff' : '#141414';
      c.fillRect(H + x * cs, y * cs, cs + 0.5, cs + 0.5);
    }
  }
  // yellow / red vertical stripes (slippery-surface flag)
  const st = 6;
  for (let i = 0; i < st; i++) {
    c.fillStyle = (i % 2) ? '#e8242c' : '#f5d21a';
    c.fillRect((i / st) * H, H, H / st + 0.5, H);
  }
  // black / white diagonal split
  c.fillStyle = '#ffffff';
  c.fillRect(H, H, H, H);
  c.fillStyle = '#141414';
  c.beginPath();
  c.moveTo(H, H); c.lineTo(S, H); c.lineTo(H, S); c.closePath();
  c.fill();
  return makeTex(W, cv, { srgb: true, clamp: true });
}

/** Grid-slot numerals 1..20 on a 5x4 atlas, white on transparent. */
function genNumeralAtlas(W) {
  const S = 512, cw = S / 5, ch = S / 4;
  const cv = createCanvas(S, S);
  const c = ctx2d(cv);
  if (!c) return null;
  c.clearRect(0, 0, S, S);
  c.fillStyle = '#ffffff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (let i = 0; i < 20; i++) {
    const col = i % 5, row = (i / 5) | 0;
    const label = String(i + 1);
    c.font = 'bold ' + Math.round(ch * (label.length > 1 ? 0.62 : 0.78)) + 'px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillText(label, col * cw + cw * 0.5, row * ch + ch * 0.5);
  }
  return makeTex(W, cv, { srgb: true, clamp: true });
}

/** Braking-distance boards, 2x2 atlas: 200 / 150 / 100 / 50. */
function genBrakeBoardAtlas(W) {
  const S = 512, H = S / 2;
  const cv = createCanvas(S, S);
  const c = ctx2d(cv);
  if (!c) return null;
  const labels = ['200', '150', '100', '50'];
  for (let i = 0; i < 4; i++) {
    const x = (i % 2) * H, y = ((i / 2) | 0) * H;
    c.fillStyle = '#101418';
    c.fillRect(x, y, H, H);
    c.fillStyle = '#e9edf2';
    c.fillRect(x + H * 0.05, y + H * 0.05, H * 0.90, H * 0.90);
    c.fillStyle = '#101418';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = 'bold ' + Math.round(H * 0.52) + 'px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillText(labels[i], x + H * 0.5, y + H * 0.52);
    // the classic chevron count
    c.fillStyle = '#c8102e';
    const bars = 4 - i;
    for (let b = 0; b < bars; b++) {
      c.fillRect(x + H * 0.10 + b * H * 0.20, y + H * 0.80, H * 0.13, H * 0.08);
    }
  }
  return makeTex(W, cv, { srgb: true, clamp: true });
}

/** Invented sponsor wordmarks harvested from teams.js, laid out on a 4x4 atlas. */
function genSponsorAtlas(W) {
  const S = 1024, cw = S / 4, ch = S / 4;
  const cv = createCanvas(S, S);
  const c = ctx2d(cv);
  if (!c) return { tex: null, cells: 0 };

  const names = [];
  try {
    for (let i = 0; i < TEAMS.length; i++) {
      const sp = TEAMS[i].sponsors;
      if (!sp) continue;
      for (let j = 0; j < sp.length; j++) if (names.indexOf(sp[j]) < 0) names.push(sp[j]);
    }
  } catch (e) { /* fall through to defaults */ }
  const extra = ['APEX SERIES', 'GRAND PRIX', 'VELOFUEL', 'NIMBUS AIR', 'TERRAFIN', 'ORBITAL'];
  for (let i = 0; i < extra.length && names.length < 16; i++) names.push(extra[i]);
  while (names.length < 16) names.push('APEX ' + (names.length + 1));

  const palette = [
    ['#0d1b2a', '#f7c948'], ['#8f1d2c', '#f3f0e8'], ['#0b4f6c', '#c6f1ff'],
    ['#1d3b1e', '#d9f28b'], ['#2b1b4a', '#e5d4ff'], ['#f3f0e8', '#101418'],
    ['#c8442a', '#ffe9d6'], ['#00394a', '#3ee0c0'],
  ];
  const rnd = mulberry32(0x1a5f0b);
  for (let i = 0; i < 16; i++) {
    const x = (i % 4) * cw, y = ((i / 4) | 0) * ch;
    const pal = palette[i % palette.length];
    c.fillStyle = pal[0];
    c.fillRect(x, y, cw, ch);
    // graphic furniture
    c.fillStyle = 'rgba(255,255,255,0.07)';
    c.beginPath();
    c.moveTo(x, y + ch * (0.55 + rnd() * 0.2));
    c.lineTo(x + cw, y + ch * (0.30 + rnd() * 0.2));
    c.lineTo(x + cw, y + ch);
    c.lineTo(x, y + ch);
    c.closePath();
    c.fill();
    c.fillStyle = pal[1];
    c.fillRect(x + cw * 0.08, y + ch * 0.16, cw * 0.10, ch * 0.05);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const label = names[i];
    const fs = Math.round(cw * (label.length > 10 ? 0.115 : label.length > 7 ? 0.145 : 0.19));
    c.font = 'bold ' + fs + 'px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillText(label, x + cw * 0.5, y + ch * 0.5);
    c.font = Math.round(cw * 0.055) + 'px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.globalAlpha = 0.62;
    c.fillText('APEX WORLD SERIES', x + cw * 0.5, y + ch * 0.70);
    c.globalAlpha = 1;
    // border
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 3;
    c.strokeRect(x + 1.5, y + 1.5, cw - 3, ch - 3);
  }
  return { tex: makeTex(W, cv, { srgb: true, clamp: true }), cells: 16 };
}

/** Generic building façade: banded concrete with lit window rows. */
function genFacade(W, size, opts) {
  const o = opts || {};
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return { albedo: null, emissive: null };
  const rnd = mulberry32(o.seed || 0x60b1f2);

  c.fillStyle = o.base || '#8d9298';
  c.fillRect(0, 0, size, size);
  for (let i = 0; i < Math.round(size / 3); i++) {
    const y = rnd() * size;
    c.fillStyle = 'rgba(0,0,0,' + (rnd() * 0.05).toFixed(3) + ')';
    c.fillRect(0, y, size, Math.max(1, size / 220));
  }

  const rows = o.rows || 4;
  const cols = o.cols || 8;
  const em = createCanvas(size, size);
  const ec = ctx2d(em);
  if (ec) { ec.fillStyle = '#000000'; ec.fillRect(0, 0, size, size); }

  const wW = (size / cols) * 0.66;
  const wH = (size / rows) * 0.52;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x = (k + 0.5) * (size / cols) - wW * 0.5;
      const y = (r + 0.5) * (size / rows) - wH * 0.5;
      c.fillStyle = o.glass || '#28323c';
      c.fillRect(x, y, wW, wH);
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(x, y, wW, wH * 0.28);
      c.strokeStyle = 'rgba(20,24,28,0.7)';
      c.lineWidth = Math.max(1, size / 300);
      c.strokeRect(x, y, wW, wH);
      if (ec && rnd() > 0.42) {
        const warm = 150 + rnd() * 105;
        ec.fillStyle = 'rgb(' + Math.round(warm) + ',' + Math.round(warm * 0.86) + ',' + Math.round(warm * 0.62) + ')';
        ec.fillRect(x, y, wW, wH);
      }
    }
  }
  // Structural bands between floors.
  c.fillStyle = 'rgba(255,255,255,0.06)';
  for (let r = 0; r <= rows; r++) c.fillRect(0, r * (size / rows) - size / 220, size, size / 110);

  return {
    albedo: makeTex(W, cv, { srgb: true }),
    emissive: makeTex(W, em, { srgb: true }),
  };
}

/** Three tree canopies as alpha-tested billboard cards. */
function genTreeCanopy(W, variety) {
  const size = 256;
  const cv = createCanvas(size, size);
  const c = ctx2d(cv);
  if (!c) return null;
  c.clearRect(0, 0, size, size);
  const rnd = mulberry32(0x300 + variety * 977);

  const palettes = [
    ['#22461f', '#2f6b28', '#3f8a33'],   // broadleaf
    ['#1c3a22', '#27512c', '#356b38'],   // conifer
    ['#3a4a1d', '#4d6127', '#647c33'],   // dry / mediterranean
  ];
  const pal = palettes[variety % 3];

  function blob(x, y, r, col, a) {
    c.globalAlpha = a;
    c.fillStyle = col;
    c.beginPath();
    c.ellipse(x, y, r, r * (0.78 + rnd() * 0.34), rnd() * TAU, 0, TAU);
    c.fill();
  }

  if (variety % 3 === 1) {
    // conifer: stacked triangles
    for (let i = 0; i < 6; i++) {
      const t = i / 6;
      const y = size * (0.12 + t * 0.72);
      const halfW = size * (0.10 + t * 0.30);
      c.globalAlpha = 0.95;
      c.fillStyle = pal[i % 3];
      c.beginPath();
      c.moveTo(size * 0.5, y - size * 0.16);
      c.lineTo(size * 0.5 - halfW, y + size * 0.08);
      c.lineTo(size * 0.5 + halfW, y + size * 0.08);
      c.closePath();
      c.fill();
    }
    for (let i = 0; i < 160; i++) {
      const t = rnd();
      const y = size * (0.12 + t * 0.78);
      const halfW = size * (0.10 + t * 0.32);
      blob(size * 0.5 + (rnd() - 0.5) * halfW * 2, y, size * (0.012 + rnd() * 0.022), pal[(rnd() * 3) | 0], 0.6 + rnd() * 0.4);
    }
  } else {
    for (let i = 0; i < 300; i++) {
      const a = rnd() * TAU;
      const rr = Math.pow(rnd(), 0.55);
      const x = size * 0.5 + Math.cos(a) * rr * size * 0.42;
      const y = size * 0.38 + Math.sin(a) * rr * size * 0.30;
      blob(x, y, size * (0.02 + rnd() * 0.05), pal[(rnd() * 3) | 0], 0.55 + rnd() * 0.45);
    }
    // a couple of dark holes so it reads as foliage, not a green ball
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 14; i++) {
      c.globalAlpha = 0.5 + rnd() * 0.5;
      c.beginPath();
      c.ellipse(size * (0.2 + rnd() * 0.6), size * (0.15 + rnd() * 0.5), size * 0.02, size * 0.03, rnd() * TAU, 0, TAU);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }

  // trunk
  c.globalAlpha = 1;
  c.fillStyle = '#3a2b1e';
  c.fillRect(size * 0.465, size * 0.60, size * 0.07, size * 0.40);
  c.fillStyle = 'rgba(90,68,48,0.7)';
  c.fillRect(size * 0.465, size * 0.60, size * 0.024, size * 0.40);

  return makeTex(W, cv, { srgb: true, clamp: true });
}

/** Blobby mask driving where standing water collects. */
function genPuddleMask(W, size) {
  const cv = scalarCanvas(size, function (x, y) {
    const a = pfbm(x * (4 / size), y * (4 / size), 4, 2024, 4);
    const b = pfbm(x * (13 / size), y * (13 / size), 13, 616, 3);
    const v = smoothstep(0.42, 0.78, a * 0.72 + b * 0.28);
    return v * 0.9 + b * 0.1;
  });
  return makeTex(W, cv, {});
}

/* ===========================================================================
 * 4. Circuit description normalisation
 * ========================================================================= */

function sideSign(side, fallback) {
  if (side === 'left' || side === -1 || side === 'L') return -1;
  if (side === 'right' || side === 1 || side === 'R') return 1;
  if (side === 'both' || side === 0 || side === 'B') return 0;
  return typeof fallback === 'number' ? fallback : 0;
}

function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

function normaliseCircuit(circuit) {
  const c = circuit && typeof circuit === 'object' ? circuit : {};
  const out = {
    id: c.id || 'apex-circuit',
    name: c.name || 'Apex Circuit',
    points: Array.isArray(c.points) ? c.points : [],
    kerbs: Array.isArray(c.kerbs) ? c.kerbs : [],
    surfaces: Array.isArray(c.surfaces) ? c.surfaces : [],
    scenery: Array.isArray(c.scenery) ? c.scenery : [],
    barriers: Array.isArray(c.barriers) ? c.barriers : [],
    brakingMarkers: Array.isArray(c.brakingMarkers) ? c.brakingMarkers : [],
    marshalPosts: Array.isArray(c.marshalPosts) ? c.marshalPosts : [],
    banking: Array.isArray(c.banking) ? c.banking : [],
    bridges: Array.isArray(c.bridges) ? c.bridges : [],
    night: c.night === true,
    street: c.street === true,
    startLine: num(c.startLine, 0),
    pitSide: sideSign(c.pitSide, -1) || -1,
    pitEntry: num(c.pitEntry, null),
    pitExit: num(c.pitExit, null),
    gridSpacing: num(c.gridSpacing, 8.0),
    theme: c.theme && typeof c.theme === 'object' ? c.theme : {},
    seed: num(c.seed, 0x9e3779b9),
  };
  if (out.pitEntry === null) out.pitEntry = wrapFrac(out.startLine - 0.055);
  if (out.pitExit === null) out.pitExit = wrapFrac(out.startLine + 0.048);
  return out;
}

function wrapFrac(v) { return v - Math.floor(v); }

/* ===========================================================================
 * 5. Frames — the sampled spine of the whole world
 * ========================================================================= */

function buildFrames(W) {
  const src = W.curve;
  const circuit = W.circuit;
  const q = W.quality;

  // Work on a private copy so we never mutate the caller's curve state.
  let curve = src;
  try {
    if (src && Array.isArray(src.points) && src.points.length > 2) {
      curve = new THREE.CatmullRomCurve3(
        src.points,
        src.closed !== false,
        src.curveType || 'centripetal',
        typeof src.tension === 'number' ? src.tension : 0.5
      );
    }
  } catch (e) { curve = src; }

  let total = 1000;
  try {
    curve.arcLengthDivisions = 4000;
    if (curve.updateArcLengths) curve.updateArcLengths();
    total = curve.getLength();
  } catch (e) { total = 1000; }
  if (!isFinite(total) || total < 10) total = 1000;

  const count = clamp(Math.round(total / q.lonStep), 96, 6000);
  const step = total / count;

  const F = {
    count: count,
    step: step,
    total: total,
    pos: new Float32Array(count * 3),
    tan: new Float32Array(count * 3),
    nrm: new Float32Array(count * 3),
    lat: new Float32Array(count * 3),
    s: new Float32Array(count),
    width: new Float32Array(count),
    bank: new Float32Array(count),
    curv: new Float32Array(count),
    line: new Float32Array(count),
    dip: new Float32Array(count),
    vary: new Float32Array(count),
    offL: new Float32Array(count),
    offR: new Float32Array(count),
    minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
    minY: Infinity, maxY: -Infinity,
  };

  // --- positions + tangents -------------------------------------------------
  for (let i = 0; i < count; i++) {
    const u = i / count;
    try {
      curve.getPointAt(u, _v0);
      curve.getTangentAt(u, _v1);
    } catch (e) {
      _v0.set(Math.cos(u * TAU) * 300, 0, Math.sin(u * TAU) * 300);
      _v1.set(-Math.sin(u * TAU), 0, Math.cos(u * TAU));
    }
    if (_v1.lengthSq() < 1e-9) _v1.set(0, 0, 1);
    _v1.normalize();
    F.pos[i * 3] = _v0.x; F.pos[i * 3 + 1] = _v0.y; F.pos[i * 3 + 2] = _v0.z;
    F.tan[i * 3] = _v1.x; F.tan[i * 3 + 1] = _v1.y; F.tan[i * 3 + 2] = _v1.z;
    F.s[i] = i * step;
    if (_v0.x < F.minX) F.minX = _v0.x;
    if (_v0.x > F.maxX) F.maxX = _v0.x;
    if (_v0.z < F.minZ) F.minZ = _v0.z;
    if (_v0.z > F.maxZ) F.maxZ = _v0.z;
    if (_v0.y < F.minY) F.minY = _v0.y;
    if (_v0.y > F.maxY) F.maxY = _v0.y;
  }

  // --- half-width, interpolated from control points -------------------------
  const cp = circuit.points;
  const P = cp.length;
  const defaultHalf = 6.0;
  if (P > 3) {
    for (let i = 0; i < count; i++) {
      const u = i / count;
      let t = u;
      try { if (curve.getUtoTmapping) t = curve.getUtoTmapping(u); } catch (e) { t = u; }
      const fi = t * P;
      const i1 = Math.floor(fi);
      const fr = fi - i1;
      const w0 = num(cp[wrapIndex(i1 - 1, P)][3], defaultHalf);
      const w1 = num(cp[wrapIndex(i1, P)][3], defaultHalf);
      const w2 = num(cp[wrapIndex(i1 + 1, P)][3], defaultHalf);
      const w3 = num(cp[wrapIndex(i1 + 2, P)][3], defaultHalf);
      F.width[i] = clamp(catmullRom1D(w0, w1, w2, w3, fr), 2.5, 20);
    }
  } else {
    for (let i = 0; i < count; i++) F.width[i] = defaultHalf;
  }
  blurLoop(F.width, 2, 1);

  // --- signed curvature -----------------------------------------------------
  for (let i = 0; i < count; i++) {
    const a = wrapIndex(i - 1, count), b = wrapIndex(i + 1, count);
    _v0.set(F.tan[a * 3], 0, F.tan[a * 3 + 2]);
    _v1.set(F.tan[b * 3], 0, F.tan[b * 3 + 2]);
    if (_v0.lengthSq() < 1e-9 || _v1.lengthSq() < 1e-9) { F.curv[i] = 0; continue; }
    _v0.normalize(); _v1.normalize();
    _v2.crossVectors(_v0, _v1);
    const sn = _v2.dot(_up);
    const cs = clamp(_v0.dot(_v1), -1, 1);
    F.curv[i] = Math.atan2(sn, cs) / (2 * step);   // >0 == left-hand corner
  }
  blurLoop(F.curv, 2, 2);

  // --- banking --------------------------------------------------------------
  const maxBank = 0.105;
  if (circuit.banking.length) {
    for (let i = 0; i < count; i++) F.bank[i] = 0;
    for (let k = 0; k < circuit.banking.length; k++) {
      const b = circuit.banking[k];
      const at = wrapFrac(num(b.at, 0));
      const rad = typeof b.rad === 'number' ? b.rad : (num(b.deg, 0) * Math.PI) / 180;
      const span = Math.max(1, Math.round(num(b.span, 0.02) * count));
      const centre = Math.round(at * count);
      for (let j = -span; j <= span; j++) {
        const idx = wrapIndex(centre + j, count);
        const fall = 1 - Math.abs(j) / (span + 1);
        F.bank[idx] += rad * fall * fall;
      }
    }
  } else {
    for (let i = 0; i < count; i++) {
      const k = F.curv[i];
      const mag = 1 - Math.exp(-Math.abs(k) * 95);
      F.bank[i] = (k >= 0 ? 1 : -1) * maxBank * mag;
    }
  }
  blurLoop(F.bank, Math.max(2, Math.round(14 / step)), 2);

  // --- frame vectors with banking applied ----------------------------------
  for (let i = 0; i < count; i++) {
    _v1.set(F.tan[i * 3], F.tan[i * 3 + 1], F.tan[i * 3 + 2]);
    _v2.crossVectors(_v1, _up);
    if (_v2.lengthSq() < 1e-8) _v2.set(1, 0, 0);
    _v2.normalize();                      // lateral (right)
    _v3.crossVectors(_v2, _v1).normalize(); // normal (up)
    // Positive bank == left-hand corner == outside (right) edge raised, so the
    // rotation about the tangent must be negative under the right-hand rule.
    _q0.setFromAxisAngle(_v1, -F.bank[i]);
    _v2.applyQuaternion(_q0);
    _v3.applyQuaternion(_q0);
    F.lat[i * 3] = _v2.x; F.lat[i * 3 + 1] = _v2.y; F.lat[i * 3 + 2] = _v2.z;
    F.nrm[i * 3] = _v3.x; F.nrm[i * 3 + 1] = _v3.y; F.nrm[i * 3 + 2] = _v3.z;
  }

  // --- racing line (in half-width fractions) --------------------------------
  const raw = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const k = F.curv[i];
    const mag = Math.min(1, Math.abs(k) * 240);
    raw[i] = -(k >= 0 ? 1 : -1) * mag * 0.80;
  }
  const narrow = Float32Array.from(raw);
  const wide = Float32Array.from(raw);
  blurLoop(narrow, Math.max(2, Math.round(26 / step)), 2);
  blurLoop(wide, Math.max(3, Math.round(78 / step)), 3);
  for (let i = 0; i < count; i++) {
    // Unsharp mask: the overshoot naturally produces wide entry and exit.
    F.line[i] = clamp(narrow[i] * 1.42 - wide[i] * 0.55, -0.86, 0.86);
  }
  blurLoop(F.line, Math.max(1, Math.round(10 / step)), 1);

  // --- drainage dips + large-scale variation --------------------------------
  for (let i = 0; i < count; i++) {
    const a = wrapIndex(i - 1, count), b = wrapIndex(i + 1, count);
    const d2 = F.pos[a * 3 + 1] - 2 * F.pos[i * 3 + 1] + F.pos[b * 3 + 1];
    F.dip[i] = clamp((d2 / (step * step)) * 900, 0, 1);
    F.vary[i] = vfbm(F.pos[i * 3] * 0.0032, F.pos[i * 3 + 2] * 0.0032, 4242, 3);
  }
  blurLoop(F.dip, Math.max(2, Math.round(18 / step)), 2);

  W.curveLocal = curve;
  return F;
}

/* --- frame sampling --------------------------------------------------------
 * frameAt() writes into a caller-supplied slot; zero allocation.
 * ------------------------------------------------------------------------ */

function frameAt(F, s, out) {
  const n = F.count;
  let x = s / F.step;
  if (!isFinite(x)) x = 0;
  const i0 = wrapIndex(Math.floor(x), n);
  const i1 = wrapIndex(i0 + 1, n);
  const t = x - Math.floor(x);
  const a3 = i0 * 3, b3 = i1 * 3;
  out.pos.set(
    F.pos[a3] + (F.pos[b3] - F.pos[a3]) * t,
    F.pos[a3 + 1] + (F.pos[b3 + 1] - F.pos[a3 + 1]) * t,
    F.pos[a3 + 2] + (F.pos[b3 + 2] - F.pos[a3 + 2]) * t
  );
  out.tan.set(
    F.tan[a3] + (F.tan[b3] - F.tan[a3]) * t,
    F.tan[a3 + 1] + (F.tan[b3 + 1] - F.tan[a3 + 1]) * t,
    F.tan[a3 + 2] + (F.tan[b3 + 2] - F.tan[a3 + 2]) * t
  );
  out.lat.set(
    F.lat[a3] + (F.lat[b3] - F.lat[a3]) * t,
    F.lat[a3 + 1] + (F.lat[b3 + 1] - F.lat[a3 + 1]) * t,
    F.lat[a3 + 2] + (F.lat[b3 + 2] - F.lat[a3 + 2]) * t
  );
  out.nrm.set(
    F.nrm[a3] + (F.nrm[b3] - F.nrm[a3]) * t,
    F.nrm[a3 + 1] + (F.nrm[b3 + 1] - F.nrm[a3 + 1]) * t,
    F.nrm[a3 + 2] + (F.nrm[b3 + 2] - F.nrm[a3 + 2]) * t
  );
  if (out.tan.lengthSq() > 1e-9) out.tan.normalize();
  if (out.lat.lengthSq() > 1e-9) out.lat.normalize();
  if (out.nrm.lengthSq() > 1e-9) out.nrm.normalize();
  out.width = F.width[i0] + (F.width[i1] - F.width[i0]) * t;
  out.bank = F.bank[i0] + (F.bank[i1] - F.bank[i0]) * t;
  out.line = F.line[i0] + (F.line[i1] - F.line[i0]) * t;
  out.s = s;
  return out;
}

const ROAD_CROWN = 0.055;

function crownAt(f) {
  const a = Math.min(1, Math.abs(f));
  return ROAD_CROWN * (1 - a * a);
}

/** World point on the driving surface. f is a half-width fraction. */
function surfacePoint(F, s, f, lift, out) {
  frameAt(F, s, _frC);
  const w = _frC.width;
  out.copy(_frC.pos);
  out.addScaledVector(_frC.lat, f * w);
  out.addScaledVector(_frC.nrm, crownAt(f) + (lift || 0));
  return out;
}

/** World point at a fixed lateral offset in METRES from the centreline. */
function offsetPoint(F, s, metres, lift, out) {
  frameAt(F, s, _frC);
  out.copy(_frC.pos);
  out.addScaledVector(_frC.lat, metres);
  out.addScaledVector(_frC.nrm, lift || 0);
  return out;
}

function frac2s(F, at) { return wrapFrac(num(at, 0)) * F.total; }

/* ===========================================================================
 * 6. Geometry plumbing (merge helpers, primitive builders)
 * ========================================================================= */

const MERGE_ATTRS = ['position', 'normal', 'uv'];

function conformGeo(g, names) {
  try {
    g.morphAttributes = {};
    const keys = Object.keys(g.attributes);
    for (let i = 0; i < keys.length; i++) {
      if (names.indexOf(keys[i]) < 0) g.deleteAttribute(keys[i]);
    }
    const n = g.attributes.position ? g.attributes.position.count : 0;
    for (let i = 0; i < names.length; i++) {
      const k = names[i];
      if (!g.attributes[k]) {
        const size = k === 'uv' ? 2 : 3;
        g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n * size), size));
      }
    }
    g.clearGroups();
  } catch (e) { /* leave as-is */ }
  return g;
}

function mergeSafe(list, names) {
  if (!list || list.length === 0) return null;
  const attrs = names || MERGE_ATTRS;
  try {
    let anyIndexed = false, allIndexed = true;
    for (let i = 0; i < list.length; i++) {
      if (list[i].index) anyIndexed = true; else allIndexed = false;
    }
    let src = list;
    if (anyIndexed && !allIndexed) {
      src = new Array(list.length);
      for (let i = 0; i < list.length; i++) src[i] = list[i].index ? list[i].toNonIndexed() : list[i];
    }
    for (let i = 0; i < src.length; i++) conformGeo(src[i], attrs);
    if (src.length === 1) return src[0];
    const merged = mergeGeometries(src, false);
    if (!merged) return src[0];
    for (let i = 0; i < src.length; i++) {
      try { src[i].dispose(); } catch (e) { /* noop */ }
    }
    return merged;
  } catch (e) {
    return list[0] || null;
  }
}

function pushXform(list, geo, m) {
  try { geo.applyMatrix4(m); list.push(geo); } catch (e) { /* noop */ }
  return geo;
}

/** Axis-aligned-then-rotated box pushed into a merge list. */
function pushBox(list, sx, sy, sz, px, py, pz, ry) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  _m0.makeRotationY(ry || 0);
  _m0.setPosition(px, py, pz);
  return pushXform(list, g, _m0);
}

function finishGeo(P, N, UV, IDX) {
  if (!P.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  const vertCount = P.length / 3;
  g.setIndex(vertCount > 65535 ? new THREE.Uint32BufferAttribute(IDX, 1) : new THREE.Uint16BufferAttribute(IDX, 1));
  g.computeBoundingSphere();
  return g;
}

function staticMesh(mesh) {
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/* ===========================================================================
 * 7. The asphalt ribbon
 * ========================================================================= */

const SHOULDER_LIP = 0.045;   // fraction of half-width for the first shoulder step
const SHOULDER_OUT = 0.175;   // outer shoulder extent
const SHOULDER_LIP_DROP = 0.012;
const SHOULDER_DROP = 0.085;

function buildCrossSection() {
  const cs = [];
  cs.push({ f: -1 - SHOULDER_OUT, drop: SHOULDER_DROP });
  cs.push({ f: -1 - SHOULDER_LIP, drop: SHOULDER_LIP_DROP });
  const N = 12;
  for (let i = 0; i < N; i++) cs.push({ f: -1 + (2 * i) / (N - 1), drop: 0 });
  cs.push({ f: 1 + SHOULDER_LIP, drop: SHOULDER_LIP_DROP });
  cs.push({ f: 1 + SHOULDER_OUT, drop: SHOULDER_DROP });
  return cs;
}

function buildRoadGeometry(W) {
  const F = W.frames;
  const cross = W.cross;
  const cols = cross.length;
  const rings = F.count + 1;                 // duplicate seam ring carries V = total
  const vcount = rings * cols;

  const pos = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const aCross = new Float32Array(vcount);
  const aLine = new Float32Array(vcount);
  const aVar = new Float32Array(vcount);
  const aDip = new Float32Array(vcount);
  const idx = new Uint32Array(F.count * (cols - 1) * 6);

  let v = 0;
  for (let r = 0; r < rings; r++) {
    const i = r % F.count;
    const s = r === F.count ? F.total : F.s[i];
    const p3 = i * 3;
    _v0.set(F.pos[p3], F.pos[p3 + 1], F.pos[p3 + 2]);
    _v1.set(F.lat[p3], F.lat[p3 + 1], F.lat[p3 + 2]);
    _v2.set(F.nrm[p3], F.nrm[p3 + 1], F.nrm[p3 + 2]);
    const w = F.width[i];
    const line = F.line[i];
    const vary = F.vary[i];
    const dip = F.dip[i];

    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const cs = cross[cIdx];
      const f = cs.f;
      const lateral = f * w;
      const up = crownAt(f) - cs.drop;
      const o = v * 3;
      pos[o] = _v0.x + _v1.x * lateral + _v2.x * up;
      pos[o + 1] = _v0.y + _v1.y * lateral + _v2.y * up;
      pos[o + 2] = _v0.z + _v1.z * lateral + _v2.z * up;
      uv[v * 2] = lateral;   // U across, in metres
      uv[v * 2 + 1] = s;     // V along, in metres
      aCross[v] = f;
      aLine[v] = line;
      aVar[v] = vary;
      aDip[v] = dip;
      v++;
    }
  }

  let t = 0;
  for (let r = 0; r < F.count; r++) {
    const row0 = r * cols;
    const row1 = (r + 1) * cols;
    for (let c = 0; c < cols - 1; c++) {
      const a = row0 + c, b = row0 + c + 1;
      const cc = row1 + c, d = row1 + c + 1;
      idx[t++] = a; idx[t++] = b; idx[t++] = cc;
      idx[t++] = b; idx[t++] = d; idx[t++] = cc;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aCross', new THREE.BufferAttribute(aCross, 1));
  g.setAttribute('aLine', new THREE.BufferAttribute(aLine, 1));
  g.setAttribute('aVar', new THREE.BufferAttribute(aVar, 1));
  g.setAttribute('aDip', new THREE.BufferAttribute(aDip, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();

  // Stitch normals across the start/finish seam so it is invisible.
  try {
    const nrm = g.attributes.normal.array;
    const last = F.count * cols;
    for (let c = 0; c < cols; c++) {
      const a = c * 3, b = (last + c) * 3;
      const nx = nrm[a] + nrm[b], ny = nrm[a + 1] + nrm[b + 1], nz = nrm[a + 2] + nrm[b + 2];
      const inv = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      nrm[a] = nrm[b] = nx * inv;
      nrm[a + 1] = nrm[b + 1] = ny * inv;
      nrm[a + 2] = nrm[b + 2] = nz * inv;
    }
    g.attributes.normal.needsUpdate = true;
  } catch (e) { /* noop */ }

  g.computeBoundingSphere();
  return g;
}

/* ---------------------------------------------------------------------------
 * 7a. Asphalt material — procedural detailing via onBeforeCompile
 * ------------------------------------------------------------------------ */

const GLSL_NOISE = [
  'float axHash11( float n ){ return fract( sin( n * 91.3458 ) * 47453.5453 ); }',
  'float axHash21( vec2 p ){ p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }',
  'float axNoise( vec2 p ){',
  '  vec2 i = floor( p ); vec2 f = fract( p );',
  '  vec2 u = f * f * ( 3.0 - 2.0 * f );',
  '  float a = axHash21( i );',
  '  float b = axHash21( i + vec2( 1.0, 0.0 ) );',
  '  float c = axHash21( i + vec2( 0.0, 1.0 ) );',
  '  float d = axHash21( i + vec2( 1.0, 1.0 ) );',
  '  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );',
  '}',
  'float axFbm( vec2 p ){',
  '  float v = 0.0; float a = 0.5;',
  '  for ( int i = 0; i < 4; i ++ ) { v += a * axNoise( p ); p *= 2.03; a *= 0.5; }',
  '  return v;',
  '}',
].join('\n');

function makeAsphaltMaterial(W, tex) {
  const U = W.uniforms;
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tex.albedo || null,
    normalMap: tex.normal || null,
    roughnessMap: tex.rough || null,
    roughness: 1.0,
    metalness: 0.0,
    dithering: true,
  });
  if (mat.normalMap) mat.normalScale.set(1.0, 1.0);
  mat.envMapIntensity = 0.35;

  const tile = 3.0;
  const rx = 1 / tile;
  // Snap the longitudinal repeat so the tiling closes exactly around the loop.
  const nTiles = Math.max(1, Math.round(W.frames.total / tile));
  const ry = nTiles / W.frames.total;
  const maps = [tex.albedo, tex.normal, tex.rough];
  for (let i = 0; i < maps.length; i++) if (maps[i]) maps[i].repeat.set(rx, ry);

  mat.onBeforeCompile = function (shader) {
    shader.uniforms.uAxWet = U.wet;
    shader.uniforms.uAxRipple = U.ripple;
    shader.uniforms.uAxTime = U.time;
    shader.uniforms.uAxTod = U.tod;
    shader.uniforms.uAxRubber = U.rubber;
    shader.uniforms.uAxPuddleMask = U.puddleMask;
    shader.uniforms.uAxPuddleScale = U.puddleScale;
    shader.uniforms.uAxDetile = U.detile;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      [
        '#include <common>',
        'attribute float aCross;',
        'attribute float aLine;',
        'attribute float aVar;',
        'attribute float aDip;',
        'varying float vAxCross;',
        'varying float vAxLine;',
        'varying float vAxVar;',
        'varying float vAxDip;',
        'varying vec2 vAxUv;',
        'varying vec3 vAxWorld;',
      ].join('\n')
    ).replace(
      '#include <begin_vertex>',
      [
        '#include <begin_vertex>',
        'vAxCross = aCross;',
        'vAxLine = aLine;',
        'vAxVar = aVar;',
        'vAxDip = aDip;',
        'vAxUv = uv;',
        'vAxWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      ].join('\n')
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      [
        '#include <common>',
        'uniform float uAxWet;',
        'uniform float uAxRipple;',
        'uniform float uAxTime;',
        'uniform float uAxRubber;',
        'uniform float uAxPuddleScale;',
        'uniform float uAxDetile;',
        'uniform vec3 uAxTod;',
        'uniform sampler2D uAxPuddleMask;',
        'varying float vAxCross;',
        'varying float vAxLine;',
        'varying float vAxVar;',
        'varying float vAxDip;',
        'varying vec2 vAxUv;',
        'varying vec3 vAxWorld;',
        'float axWater; float axSheen; float axRub; float axPool;',
        GLSL_NOISE,
      ].join('\n')
    ).replace(
      '#include <map_fragment>',
      [
        '#include <map_fragment>',
        '{',
        // --- break up the visible tiling with a second, rotated sample ------
        '  #ifdef USE_MAP',
        '  vec3 axAlt = texture2D( map, vMapUv * 0.3713 + vec2( 0.317, 0.611 ) ).rgb * diffuse;',
        '  diffuseColor.rgb = mix( diffuseColor.rgb, axAlt, uAxDetile );',
        '  #endif',
        '  vec2 axWP = vAxWorld.xz;',
        '  float axAbs = abs( vAxCross );',
        // --- slow, large-scale tonal drift ---------------------------------
        '  float axBig = axNoise( axWP * 0.0125 ) * 0.6 + axNoise( axWP * 0.0034 ) * 0.4;',
        '  diffuseColor.rgb *= 0.80 + 0.34 * axBig + 0.12 * vAxVar;',
        // --- lighter concrete repair patches --------------------------------
        '  float axCell = floor( vAxUv.y / 42.0 );',
        '  float axLane = floor( vAxUv.x * 0.28 + 4.0 );',
        '  float axPr = axHash11( axCell * 13.17 + axLane * 5.71 );',
        '  float axAlong = abs( fract( vAxUv.y / 42.0 ) - 0.5 ) * 2.0;',
        '  float axPatch = step( 0.87, axPr ) * ( 1.0 - smoothstep( 0.55, 0.95, axAlong ) );',
        '  axPatch *= 1.0 - smoothstep( 0.55, 0.92, abs( fract( vAxUv.x * 0.28 + 0.5 ) - 0.5 ) * 2.0 );',
        '  vec3 axConc = diffuseColor.rgb * 1.45 + vec3( 0.030, 0.030, 0.028 );',
        '  diffuseColor.rgb = mix( diffuseColor.rgb, axConc, axPatch * 0.80 );',
        // --- transverse expansion seams + longitudinal paving joints --------
        '  float axMt = mod( vAxUv.y, 24.0 );',
        '  float axDt = min( axMt, 24.0 - axMt );',
        '  float axSeamT = 1.0 - smoothstep( 0.0, 0.075, axDt );',
        '  float axMu = mod( vAxUv.x + 2.0, 4.0 );',
        '  float axDu = abs( axMu - 2.0 );',
        '  float axSeamU = 1.0 - smoothstep( 0.0, 0.055, axDu );',
        '  float axSeam = clamp( axSeamT + axSeamU * 0.75, 0.0, 1.0 );',
        '  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.52, axSeam * 0.7 );',
        // --- rubbered-in racing line ---------------------------------------
        '  float axD = abs( vAxCross - vAxLine );',
        '  float axCore = 1.0 - smoothstep( 0.06, 0.21, axD );',
        '  float axHalo = 1.0 - smoothstep( 0.18, 0.50, axD );',
        '  float axStreak = 0.72 + 0.28 * axNoise( vec2( vAxUv.x * 1.6, vAxUv.y * 0.09 ) );',
        '  axRub = clamp( ( axCore * 0.86 + axHalo * 0.34 ) * axStreak, 0.0, 1.0 ) * uAxRubber;',
        '  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.44, 0.455, 0.52 ), axRub );',
        // --- marbles and dust off-line, close to the edges ------------------
        '  float axDust = smoothstep( 0.62, 1.0, axAbs ) * ( 1.0 - axRub );',
        '  float axMarb = axFbm( axWP * 0.9 ) * axDust;',
        '  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.36, 1.30, 1.14 ), axMarb * 0.42 );',
        // --- standing water -------------------------------------------------
        '  float axPm = texture2D( uAxPuddleMask, axWP * uAxPuddleScale ).r;',
        '  float axEdge = smoothstep( 0.42, 1.06, axAbs );',
        '  axPool = clamp( axPm * 0.70 + axEdge * 0.60 + vAxDip * 0.85 - axRub * 0.30, 0.0, 1.0 );',
        '  axSheen = clamp( uAxWet * 1.15, 0.0, 1.0 );',
        '  axWater = clamp( uAxWet * ( 0.24 + 1.25 * axPool ), 0.0, 1.0 );',
        '  diffuseColor.rgb *= mix( 1.0, 0.40, axSheen );',
        '  diffuseColor.rgb *= mix( 1.0, 0.58, axWater );',
        '  diffuseColor.rgb *= uAxTod;',
        '}',
      ].join('\n')
    ).replace(
      '#include <roughnessmap_fragment>',
      [
        '#include <roughnessmap_fragment>',
        'roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.74, axRub );',
        'roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.44, axSheen );',
        'roughnessFactor = mix( roughnessFactor, 0.018, axWater );',
        'roughnessFactor = clamp( roughnessFactor, 0.015, 1.0 );',
      ].join('\n')
    ).replace(
      '#include <normal_fragment_maps>',
      [
        '#include <normal_fragment_maps>',
        '{',
        '  float axFlatten = clamp( axWater * 1.25 + axSheen * 0.30, 0.0, 1.0 );',
        '  normal = normalize( mix( normal, nonPerturbedNormal, axFlatten ) );',
        '  #ifdef USE_NORMALMAP_TANGENTSPACE',
        '  if ( uAxRipple > 0.001 ) {',
        '    vec2 rp = vAxWorld.xz;',
        '    float w1 = sin( dot( rp, vec2( 2.7, 1.9 ) ) - uAxTime * 5.1 );',
        '    float w2 = sin( dot( rp, vec2( -1.7, 3.1 ) ) - uAxTime * 6.7 );',
        '    float w3 = sin( dot( rp, vec2( 4.3, -2.3 ) ) - uAxTime * 8.3 );',
        '    vec2 grad = vec2( w1 * 2.7 - w2 * 1.7 + w3 * 4.3, w1 * 1.9 + w2 * 3.1 - w3 * 2.3 );',
        '    float amt = uAxRipple * axWater * 0.014;',
        '    normal = normalize( normal + ( tbn[ 0 ] * grad.x + tbn[ 1 ] * grad.y ) * amt );',
        '  }',
        '  #endif',
        '}',
      ].join('\n')
    );
  };
  mat.customProgramCacheKey = function () { return 'apex-asphalt-v1'; };
  return mat;
}

/* ===========================================================================
 * 8. Kerbs
 * ========================================================================= */

const KERB_PROFILE = [
  { o: 0.00, y: 0.004, u: 0.02, rum: 0 },
  { o: 0.13, y: 0.036, u: 0.14, rum: 0.35 },
  { o: 0.33, y: 0.052, u: 0.33, rum: 1.0 },
  { o: 0.62, y: 0.053, u: 0.62, rum: 1.0 },
  { o: 0.84, y: 0.046, u: 0.84, rum: 0.5 },
  { o: 1.00, y: 0.006, u: 0.99, rum: 0 },
];

function arcSpan(F, s0, s1) {
  let d = s1 - s0;
  while (d < 0) d += F.total;
  while (d > F.total) d -= F.total;
  return d;
}

function buildKerbStrip(F, s0, s1, dir, kw, step, rumble, P, N, UV, IDX) {
  const span = arcSpan(F, s0, s1);
  if (span < 0.5) return;
  const n = Math.max(2, Math.ceil(span / step));
  const ds = span / n;
  const cols = KERB_PROFILE.length;
  const base = P.length / 3;

  for (let r = 0; r <= n; r++) {
    const s = s0 + r * ds;
    frameAt(F, s, _frA);
    const edgeF = dir;
    const edgeM = dir * _frA.width;
    const baseY = crownAt(edgeF);
    // Fade the kerb in and out at the ends so it does not pop out of the road.
    const endFade = Math.min(1, Math.min(r, n - r) / Math.max(1, 2.0 / ds));
    for (let c = 0; c < cols; c++) {
      const pr = KERB_PROFILE[c];
      const off = edgeM + dir * pr.o * kw;
      let y = baseY + pr.y * (0.06 + 0.94 * endFade);
      if (rumble && pr.rum > 0) {
        y += pr.rum * 0.0115 * (0.5 + 0.5 * Math.sin((s / 0.78) * TAU)) * endFade;
      }
      _v0.copy(_frA.pos).addScaledVector(_frA.lat, off).addScaledVector(_frA.nrm, y);
      P.push(_v0.x, _v0.y, _v0.z);
      N.push(0, 1, 0);
      UV.push(pr.u * kw, s);
    }
  }
  for (let r = 0; r < n; r++) {
    const row0 = base + r * cols;
    const row1 = base + (r + 1) * cols;
    for (let c = 0; c < cols - 1; c++) {
      const a = row0 + c, b = row0 + c + 1, cc = row1 + c, d = row1 + c + 1;
      if (dir > 0) { IDX.push(a, b, cc, b, d, cc); }
      else { IDX.push(a, cc, b, b, cc, d); }
    }
  }
}

/** Aggressive-exit sausage kerbs: a run of raised humps just outside the kerb. */
function buildSausages(F, s0, s1, dir, kw, P, N, UV, IDX) {
  const span = arcSpan(F, s0, s1);
  const humpLen = 1.5;
  const gap = 0.55;
  const count = Math.max(1, Math.floor(span / (humpLen + gap)));
  const segs = 6;
  const cross = 5;
  for (let h = 0; h < count; h++) {
    const hs = s0 + h * (humpLen + gap) + gap * 0.5;
    const base = P.length / 3;
    for (let r = 0; r <= segs; r++) {
      const t = r / segs;
      const s = hs + t * humpLen;
      frameAt(F, s, _frA);
      const lonFade = Math.sin(t * Math.PI);
      const edgeM = dir * _frA.width + dir * kw * 0.55;
      const baseY = crownAt(dir);
      for (let c = 0; c <= cross - 1; c++) {
        const cu = c / (cross - 1);
        const width = 0.62;
        const off = edgeM + dir * (cu - 0.5) * width;
        const dome = Math.sqrt(Math.max(0, 1 - Math.pow((cu - 0.5) * 2, 2)));
        const y = baseY + 0.055 + dome * 0.095 * lonFade;
        _v0.copy(_frA.pos).addScaledVector(_frA.lat, off).addScaledVector(_frA.nrm, y);
        P.push(_v0.x, _v0.y, _v0.z);
        N.push(0, 1, 0);
        UV.push(cu * 0.62, s * 1.6);
      }
    }
    for (let r = 0; r < segs; r++) {
      const row0 = base + r * cross;
      const row1 = base + (r + 1) * cross;
      for (let c = 0; c < cross - 1; c++) {
        const a = row0 + c, b = row0 + c + 1, cc = row1 + c, d = row1 + c + 1;
        if (dir > 0) { IDX.push(a, b, cc, b, d, cc); }
        else { IDX.push(a, cc, b, b, cc, d); }
      }
    }
  }
}

/** Derive plausible kerbs from curvature when the circuit does not list them. */
function autoKerbs(F) {
  const out = [];
  const n = F.count;
  const thresh = 0.0045;
  let i = 0;
  while (i < n) {
    if (Math.abs(F.curv[i]) < thresh) { i++; continue; }
    const sign = F.curv[i] >= 0 ? 1 : -1;
    let j = i;
    while (j < n + 8 && Math.abs(F.curv[wrapIndex(j, n)]) >= thresh * 0.55 &&
           (F.curv[wrapIndex(j, n)] >= 0 ? 1 : -1) === sign) j++;
    const lenIdx = j - i;
    if (lenIdx * F.step > 22) {
      const pad = Math.round(14 / F.step);
      const s0 = (i - pad) * F.step;
      const s1 = (j + pad) * F.step;
      const inside = sign > 0 ? -1 : 1;      // left corner -> inside is the left edge
      out.push({ from: wrapFrac(s0 / F.total), to: wrapFrac(s1 / F.total), side: inside > 0 ? 'right' : 'left', type: 'standard' });
      // Exit kerb on the outside, second half of the corner only.
      const mid = (i + j) * 0.5;
      out.push({
        from: wrapFrac((mid * F.step) / F.total),
        to: wrapFrac(((j + pad) * F.step) / F.total),
        side: inside > 0 ? 'left' : 'right',
        type: 'sausage',
      });
    }
    i = j + 1;
  }
  return out;
}

function buildKerbs(W) {
  const F = W.frames;
  const q = W.quality;
  const specs = W.circuit.kerbs.length ? W.circuit.kerbs : autoKerbs(F);

  const P = [], N = [], UV = [], IDX = [];
  const SP = [], SN = [], SUV = [], SIDX = [];

  for (let i = 0; i < specs.length; i++) {
    const k = specs[i];
    const s0 = frac2s(F, num(k.from, num(k.start, 0)));
    const s1 = frac2s(F, num(k.to, num(k.end, 0.01)));
    const kw = clamp(num(k.width, 0.95), 0.35, 2.4);
    const sd = sideSign(k.side, 0);
    const dirs = sd === 0 ? [-1, 1] : [sd];
    const sausage = k.type === 'sausage' || k.sausage === true;
    for (let d = 0; d < dirs.length; d++) {
      try {
        buildKerbStrip(F, s0, s1, dirs[d], kw, q.kerbStep, q.rumble, P, N, UV, IDX);
        if (sausage && q.detail >= 1) buildSausages(F, s0, s1, dirs[d], kw, SP, SN, SUV, SIDX);
      } catch (e) { /* skip a malformed kerb */ }
    }
  }

  const out = { main: null, sausage: null };
  const g = finishGeo(P, N, UV, IDX);
  if (g) { g.computeVertexNormals(); g.computeBoundingSphere(); out.main = g; }
  const gs = finishGeo(SP, SN, SUV, SIDX);
  if (gs) { gs.computeVertexNormals(); gs.computeBoundingSphere(); out.sausage = gs; }
  return out;
}

/* ===========================================================================
 * 9. White lines, start/finish, pit lines, grid boxes
 * ========================================================================= */

function stripMetres(F, s0, s1, step, loFn, hiFn, lift, P, N, UV, IDX, vScale) {
  const span = s1 - s0;
  if (Math.abs(span) < 0.05) return;
  const n = Math.max(1, Math.ceil(Math.abs(span) / step));
  const ds = span / n;
  const base = P.length / 3;
  for (let r = 0; r <= n; r++) {
    const s = s0 + r * ds;
    frameAt(F, s, _frA);
    const lo = loFn(s, _frA);
    const hi = hiFn(s, _frA);
    for (let k = 0; k < 2; k++) {
      const m = k === 0 ? lo : hi;
      _v0.copy(_frA.pos)
        .addScaledVector(_frA.lat, m)
        .addScaledVector(_frA.nrm, crownAt(m / _frA.width) + lift);
      P.push(_v0.x, _v0.y, _v0.z);
      N.push(0, 1, 0);
      UV.push(k, s * (vScale || 1));
    }
  }
  for (let r = 0; r < n; r++) {
    const a = base + r * 2, b = a + 1, c = a + 2, d = a + 3;
    IDX.push(a, b, c, b, d, c);
  }
}

const LINE_LIFT = 0.013;

function buildMarkings(W) {
  const F = W.frames;
  const circuit = W.circuit;
  const P = [], N = [], UV = [], IDX = [];
  const step = Math.max(1.2, W.quality.lonStep * 0.8);
  const lw = 0.13;

  // --- continuous track edge lines -----------------------------------------
  for (let d = -1; d <= 1; d += 2) {
    const dir = d;
    stripMetres(F, 0, F.total, step,
      function (s, fr) { return dir > 0 ? fr.width - lw : -fr.width; },
      function (s, fr) { return dir > 0 ? fr.width : -fr.width + lw; },
      LINE_LIFT, P, N, UV, IDX, 1);
  }

  // --- start / finish line --------------------------------------------------
  const sStart = frac2s(F, circuit.startLine);
  stripMetres(F, sStart - 0.25, sStart + 0.25, 0.25,
    function (s, fr) { return -fr.width + 0.02; },
    function (s, fr) { return fr.width - 0.02; },
    LINE_LIFT + 0.002, P, N, UV, IDX, 1);

  // --- pit entry / exit guide lines ----------------------------------------
  const ps = circuit.pitSide;
  const entry = frac2s(F, circuit.pitEntry);
  const exit = frac2s(F, circuit.pitExit);
  stripMetres(F, entry - 130, entry + 45, step,
    function (s, fr) { return ps * (fr.width - lw * 1.6); },
    function (s, fr) { return ps * fr.width; },
    LINE_LIFT + 0.001, P, N, UV, IDX, 1);
  stripMetres(F, exit - 30, exit + 150, step,
    function (s, fr) { return ps * (fr.width - lw * 1.6); },
    function (s, fr) { return ps * fr.width; },
    LINE_LIFT + 0.001, P, N, UV, IDX, 1);

  // --- 20 grid boxes --------------------------------------------------------
  const slots = [];
  const spacing = circuit.gridSpacing;
  const boxLen = 6.0, boxHalf = 1.05;
  for (let i = 0; i < 20; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const s = sStart - 7.5 - i * spacing;
    frameAt(F, s, _frB);
    const centre = side * _frB.width * 0.44;
    slots.push({ index: i + 1, s: s, lateral: centre, side: side });

    // side lines
    for (let k = -1; k <= 1; k += 2) {
      const m0 = centre + k * boxHalf - (k > 0 ? 0.09 : 0);
      const m1 = m0 + 0.09;
      stripMetres(F, s - boxLen * 0.5, s + boxLen * 0.5, 1.5,
        function () { return m0; }, function () { return m1; },
        LINE_LIFT + 0.002, P, N, UV, IDX, 1);
    }
    // front (forward) line
    stripMetres(F, s + boxLen * 0.5 - 0.09, s + boxLen * 0.5, 0.09,
      function () { return centre - boxHalf; }, function () { return centre + boxHalf; },
      LINE_LIFT + 0.002, P, N, UV, IDX, 1);
  }

  const g = finishGeo(P, N, UV, IDX);
  if (g) { g.computeVertexNormals(); g.computeBoundingSphere(); }

  // --- grid numerals on their own atlas geometry ---------------------------
  const NP = [], NN = [], NUV = [], NIDX = [];
  for (let i = 0; i < 20; i++) {
    const sl = slots[i];
    const col = i % 5, row = (i / 5) | 0;
    const u0 = col / 5, v0 = 1 - (row + 1) / 4;
    const u1 = (col + 1) / 5, v1 = 1 - row / 4;
    const nHalfW = 0.85, nLen = 1.5;
    const sc = sl.s + 3.6;
    offsetPoint(F, sc - nLen * 0.5, sl.lateral - nHalfW, LINE_LIFT + 0.004, _v0);
    offsetPoint(F, sc - nLen * 0.5, sl.lateral + nHalfW, LINE_LIFT + 0.004, _v1);
    offsetPoint(F, sc + nLen * 0.5, sl.lateral + nHalfW, LINE_LIFT + 0.004, _v2);
    offsetPoint(F, sc + nLen * 0.5, sl.lateral - nHalfW, LINE_LIFT + 0.004, _v3);
    const base = NP.length / 3;
    NP.push(_v0.x, _v0.y, _v0.z, _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z, _v3.x, _v3.y, _v3.z);
    for (let k = 0; k < 4; k++) NN.push(0, 1, 0);
    NUV.push(u0, v0, u1, v0, u1, v1, u0, v1);
    NIDX.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const gn = finishGeo(NP, NN, NUV, NIDX);
  if (gn) { gn.computeVertexNormals(); gn.computeBoundingSphere(); }

  return { lines: g, numerals: gn, slots: slots, startS: sStart };
}

/* ===========================================================================
 * 10. Run-off, verges and terrain
 * ========================================================================= */

function computeBarrierOffsets(W) {
  const F = W.frames;
  const street = W.circuit.street;
  const n = F.count;
  const baseGap = street ? 3.2 : 11.0;
  for (let i = 0; i < n; i++) {
    const w = F.width[i];
    const k = F.curv[i];
    const outside = Math.min(1, Math.abs(k) * 190) * (street ? 2.0 : 15.0);
    const left = w * 1.2 + baseGap + (k < 0 ? outside : outside * 0.25);
    const right = w * 1.2 + baseGap + (k > 0 ? outside : outside * 0.25);
    F.offL[i] = left;
    F.offR[i] = right;
  }
  // Surfaces push the barrier out to at least their far edge.
  const specs = W.circuit.surfaces;
  for (let k = 0; k < specs.length; k++) {
    const sp = specs[k];
    const s0 = frac2s(F, num(sp.from, num(sp.start, 0)));
    const s1 = frac2s(F, num(sp.to, num(sp.end, 0.02)));
    const inner = num(sp.offset, 0);
    const wid = clamp(num(sp.width, 12), 1, 90);
    const sd = sideSign(sp.side, 0);
    const i0 = Math.round(s0 / F.step);
    const span = Math.max(1, Math.round(arcSpan(F, s0, s1) / F.step));
    for (let j = 0; j <= span; j++) {
      const i = wrapIndex(i0 + j, n);
      const need = F.width[i] * 1.2 + inner + wid + 2.5;
      if (sd <= 0) F.offL[i] = Math.max(F.offL[i], need);
      if (sd >= 0) F.offR[i] = Math.max(F.offR[i], need);
    }
  }
  // Dilate then smooth so the barrier line never kinks.
  const r = Math.max(1, Math.round(24 / F.step));
  const tmpL = new Float32Array(n), tmpR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let ml = 0, mr = 0;
    for (let j = -r; j <= r; j++) {
      const w = wrapIndex(i + j, n);
      if (F.offL[w] > ml) ml = F.offL[w];
      if (F.offR[w] > mr) mr = F.offR[w];
    }
    tmpL[i] = ml; tmpR[i] = mr;
  }
  F.offL.set(tmpL); F.offR.set(tmpR);
  blurLoop(F.offL, r, 2);
  blurLoop(F.offR, r, 2);
}

function runoffDrop(d) { return -(0.10 + d * 0.028); }

/**
 * Sweep a run-off ribbon between two lateral distances (metres from the
 * centreline, unsigned) on one side, with optional surface displacement.
 */
function buildRunoffRibbon(F, s0, s1, dir, innerFn, outerFn, cols, step, noiseAmp, noiseFreq, seed, P, N, UV, IDX) {
  const span = arcSpan(F, s0, s1) || F.total;
  const n = Math.max(2, Math.ceil(span / step));
  const ds = span / n;
  const base = P.length / 3;
  for (let r = 0; r <= n; r++) {
    const s = s0 + r * ds;
    frameAt(F, s, _frA);
    const inner = innerFn(s, _frA);
    const outer = Math.max(inner + 0.5, outerFn(s, _frA));
    for (let c = 0; c < cols; c++) {
      const t = c / (cols - 1);
      const m = inner + (outer - inner) * t;
      const d = m - _frA.width * 1.2;
      let y = runoffDrop(Math.max(0, d));
      _v0.copy(_frA.pos).addScaledVector(_frA.lat, dir * m).addScaledVector(_frA.nrm, y);
      if (noiseAmp > 0) {
        _v0.y += (vfbm(_v0.x * noiseFreq, _v0.z * noiseFreq, seed, 3) - 0.5) * noiseAmp;
      }
      P.push(_v0.x, _v0.y, _v0.z);
      N.push(0, 1, 0);
      UV.push(dir * m, s);
    }
  }
  for (let r = 0; r < n; r++) {
    const row0 = base + r * cols;
    const row1 = base + (r + 1) * cols;
    for (let c = 0; c < cols - 1; c++) {
      const a = row0 + c, b = row0 + c + 1, cc = row1 + c, d = row1 + c + 1;
      if (dir > 0) { IDX.push(a, b, cc, b, d, cc); }
      else { IDX.push(a, cc, b, b, cc, d); }
    }
  }
}

function buildRunoff(W) {
  const F = W.frames;
  const q = W.quality;
  const step = Math.max(2.5, q.lonStep * 1.6);
  const buckets = {
    grass: [[], [], [], []],
    gravel: [[], [], [], []],
    astro: [[], [], [], []],
    concrete: [[], [], [], []],
  };

  function bucket(name) { return buckets[name] || buckets.grass; }

  // Base verge everywhere, so there is never a hole beside the track.
  const vergeName = W.circuit.street ? 'concrete' : 'grass';
  for (let d = -1; d <= 1; d += 2) {
    const dir = d;
    const b = bucket(vergeName);
    buildRunoffRibbon(F, 0, F.total, dir,
      function (s, fr) { return fr.width * 1.2; },
      function (s, fr) {
        const i = wrapIndex(Math.round(s / F.step), F.count);
        return (dir > 0 ? F.offR[i] : F.offL[i]) + 16;
      },
      5, step, vergeName === 'grass' ? 0.16 : 0.0, 0.06, 1717, b[0], b[1], b[2], b[3]);
  }

  // Declared surfaces overlay the verge, lifted marginally to win the depth test.
  const specs = W.circuit.surfaces;
  for (let k = 0; k < specs.length; k++) {
    const sp = specs[k];
    const type = ['grass', 'gravel', 'astro', 'concrete'].indexOf(sp.type) >= 0 ? sp.type : 'grass';
    const b = bucket(type);
    const s0 = frac2s(F, num(sp.from, num(sp.start, 0)));
    const s1 = frac2s(F, num(sp.to, num(sp.end, 0.02)));
    const inner = num(sp.offset, 0);
    const wid = clamp(num(sp.width, 12), 1, 90);
    const sd = sideSign(sp.side, 0);
    const dirs = sd === 0 ? [-1, 1] : [sd];
    const noise = type === 'gravel' ? (0.06 + q.gravelDetail * 0.05) : (type === 'grass' ? 0.10 : 0.0);
    const cols = type === 'gravel' ? 4 + q.gravelDetail * 2 : 4;
    for (let di = 0; di < dirs.length; di++) {
      const dir = dirs[di];
      try {
        buildRunoffRibbon(F, s0, s1, dir,
          function (s, fr) { return fr.width * 1.2 + inner; },
          function (s, fr) { return fr.width * 1.2 + inner + wid; },
          cols, Math.max(1.8, step * 0.7), noise, type === 'gravel' ? 0.55 : 0.09, 3300 + k * 31,
          b[0], b[1], b[2], b[3]);
      } catch (e) { /* skip */ }
    }
  }

  const out = {};
  const keys = Object.keys(buckets);
  for (let i = 0; i < keys.length; i++) {
    const b = buckets[keys[i]];
    const g = finishGeo(b[0], b[1], b[2], b[3]);
    if (g) { g.computeVertexNormals(); g.computeBoundingSphere(); }
    out[keys[i]] = g;
  }
  return out;
}

function buildTerrain(W) {
  const F = W.frames;
  const q = W.quality;
  const pad = 340;
  const x0 = F.minX - pad, x1 = F.maxX + pad;
  const z0 = F.minZ - pad, z1 = F.maxZ + pad;
  const seg = q.terrainSeg;

  // Subsampled centreline for nearest-distance queries.
  const stride = Math.max(1, Math.floor(F.count / 420));
  const probeN = Math.floor(F.count / stride);
  const px = new Float32Array(probeN), pz = new Float32Array(probeN), py = new Float32Array(probeN);
  for (let i = 0; i < probeN; i++) {
    const j = i * stride;
    px[i] = F.pos[j * 3]; py[i] = F.pos[j * 3 + 1]; pz[i] = F.pos[j * 3 + 2];
  }

  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, seg, seg);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) * 0.5, 0, (z0 + z1) * 0.5);
  const pos = g.attributes.position;
  const arr = pos.array;
  const uvA = g.attributes.uv.array;
  const spanX = x1 - x0, spanZ = z1 - z0;

  for (let i = 0; i < pos.count; i++) {
    const vx = arr[i * 3], vz = arr[i * 3 + 2];
    let best = Infinity, bestY = 0;
    for (let p = 0; p < probeN; p++) {
      const dx = vx - px[p], dz = vz - pz[p];
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bestY = py[p]; }
    }
    const d = Math.sqrt(best);
    const near = bestY - 0.9 - Math.min(d, 45) * 0.030;
    const hills = (vfbm(vx * 0.0016, vz * 0.0016, 8181, 5) - 0.42) * 62 +
                  (vfbm(vx * 0.0068, vz * 0.0068, 3131, 3) - 0.5) * 9;
    const blend = smoothstep(55, 300, d);
    arr[i * 3 + 1] = lerp(near, bestY - 2.5 + hills, blend);
    // UVs in metres, matching the run-off ribbons so materials can be shared.
    uvA[i * 2] = vx - x0;
    uvA[i * 2 + 1] = vz - z0;
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* ===========================================================================
 * 11. Barriers — Armco, concrete, TecPro, tyre stacks, debris fencing
 * ========================================================================= */

function barrierOffsetAt(F, s, dir) {
  const x = s / F.step;
  const i0 = wrapIndex(Math.floor(x), F.count);
  const i1 = wrapIndex(i0 + 1, F.count);
  const t = x - Math.floor(x);
  const a = dir > 0 ? F.offR : F.offL;
  return a[i0] + (a[i1] - a[i0]) * t;
}

/**
 * Orthonormal, right-handed instance basis at the barrier line.
 * Local axes: +X outward (away from the track), +Y world up, +Z along.
 */
function barrierMatrix(F, s, dir, extraOut, height, m) {
  frameAt(F, s, _frA);
  const off = barrierOffsetAt(F, s, dir) + (extraOut || 0);
  _v0.set(_frA.lat.x, 0, _frA.lat.z);
  if (_v0.lengthSq() < 1e-8) _v0.set(1, 0, 0);
  _v0.normalize().multiplyScalar(dir);
  _v2.set(_frA.tan.x, 0, _frA.tan.z);
  if (_v2.lengthSq() < 1e-8) _v2.set(0, 0, 1);
  _v2.normalize().multiplyScalar(-dir);
  _v1.set(0, 1, 0);
  m.makeBasis(_v0, _v1, _v2);
  const ground = _frA.pos.y + runoffDrop(Math.max(0, off - _frA.width * 1.2));
  _v3.copy(_frA.pos).addScaledVector(_frA.lat, dir * off);
  m.setPosition(_v3.x, ground + height, _v3.z);
  return off;
}

const ARMCO_PROFILE = [
  [-0.160, 0.000],
  [-0.120, -0.072],
  [-0.055, -0.072],
  [-0.020, -0.016],
  [0.020, -0.016],
  [0.055, -0.072],
  [0.120, -0.072],
  [0.160, 0.000],
];

function makeArmcoPanelGeo(len) {
  const prof = ARMCO_PROFILE;
  const cols = prof.length;
  const P = [], N = [], UV = [], IDX = [];
  let arc = 0;
  const arcs = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    if (c > 0) {
      const dy = prof[c][0] - prof[c - 1][0];
      const dx = prof[c][1] - prof[c - 1][1];
      arc += Math.sqrt(dx * dx + dy * dy);
    }
    arcs[c] = arc;
  }
  for (let r = 0; r < 2; r++) {
    const z = (r - 0.5) * len;
    for (let c = 0; c < cols; c++) {
      P.push(prof[c][1], prof[c][0], z);
      N.push(-1, 0, 0);
      UV.push(arcs[c], z + len * 0.5);
    }
  }
  for (let c = 0; c < cols - 1; c++) {
    const a = c, b = c + 1, cc = cols + c, d = cols + c + 1;
    IDX.push(a, cc, b, b, cc, d);
  }
  const g = finishGeo(P, N, UV, IDX);
  if (g) { g.computeVertexNormals(); g.computeBoundingSphere(); }
  return g;
}

function collector() { return { m: [], c: [], u: [] }; }

function buildInstanced(W, geo, mat, coll, opts) {
  if (!geo || !coll || coll.m.length === 0) return null;
  const o = opts || {};
  try {
    const n = coll.m.length;
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, coll.m[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.setUsage(o.dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
    if (coll.c.length === n) {
      for (let i = 0; i < n; i++) mesh.setColorAt(i, coll.c[i]);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (coll.u.length === n) {
      const arr = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { arr[i * 2] = coll.u[i].x; arr[i * 2 + 1] = coll.u[i].y; }
      geo.setAttribute('aUvOff', new THREE.InstancedBufferAttribute(arr, 2));
    }
    if (coll.p && coll.p.length === n) {
      const arr = new Float32Array(n);
      for (let i = 0; i < n; i++) arr[i] = coll.p[i];
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(arr, 1));
    }
    mesh.castShadow = !!o.cast;
    mesh.receiveShadow = !!o.receive;
    mesh.frustumCulled = o.cull === true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = o.name || 'apex-instanced';
    W.geoms.push(geo);
    mesh.computeBoundingSphere();
    return mesh;
  } catch (e) { return null; }
}

function barrierPlan(W) {
  const F = W.frames;
  const circuit = W.circuit;
  if (circuit.barriers.length) {
    return circuit.barriers.map(function (b) {
      return {
        from: num(b.from, num(b.start, 0)),
        to: num(b.to, num(b.end, 1)),
        side: sideSign(b.side, 0),
        type: b.type || (circuit.street ? 'concrete' : 'armco'),
      };
    });
  }
  const plan = [{ from: 0, to: 1, side: 0, type: circuit.street ? 'concrete' : 'armco' }];

  // Auto tyre walls on the outside of the sharpest corners.
  const corners = [];
  const n = F.count;
  let i = 0;
  while (i < n) {
    if (Math.abs(F.curv[i]) < 0.006) { i++; continue; }
    let j = i, peak = 0, peakI = i;
    while (j < n && Math.abs(F.curv[wrapIndex(j, n)]) >= 0.003) {
      const v = Math.abs(F.curv[wrapIndex(j, n)]);
      if (v > peak) { peak = v; peakI = j; }
      j++;
    }
    if (peak > 0.006) corners.push({ i: peakI, k: peak, sign: F.curv[wrapIndex(peakI, n)] >= 0 ? 1 : -1 });
    i = j + 1;
  }
  corners.sort(function (a, b) { return b.k - a.k; });
  const maxWalls = W.quality.detail >= 2 ? 10 : (W.quality.detail >= 1 ? 6 : 3);
  for (let c = 0; c < Math.min(maxWalls, corners.length); c++) {
    const cn = corners[c];
    const s = cn.i * F.step;
    const outside = cn.sign > 0 ? 1 : -1;   // left-hand corner -> outside is the right
    plan.push({
      from: wrapFrac((s - 22) / F.total),
      to: wrapFrac((s + 30) / F.total),
      side: outside,
      type: c % 3 === 2 ? 'tecpro' : 'tyre',
    });
  }
  return plan;
}

function buildBarriers(W) {
  const F = W.frames;
  const q = W.quality;
  const plan = barrierPlan(W);
  const out = { meshes: [], tyreCount: 0, armcoCount: 0 };

  const armco = collector();
  const posts = collector();
  const walls = collector();
  const tecpro = collector();
  const tyres = collector();
  const straps = collector();

  const panelLen = q.armcoLen;
  const wallLen = 3.0;

  for (let p = 0; p < plan.length; p++) {
    const seg = plan[p];
    const s0 = frac2s(F, seg.from);
    let span = arcSpan(F, s0, frac2s(F, seg.to));
    if (Math.abs(seg.to - seg.from) >= 0.999) span = F.total;
    if (span < 1) continue;
    const dirs = seg.side === 0 ? [-1, 1] : [seg.side];

    for (let d = 0; d < dirs.length; d++) {
      const dir = dirs[d];
      try {
        if (seg.type === 'armco') {
          const n = Math.max(1, Math.round(span / panelLen));
          for (let i = 0; i < n; i++) {
            const s = s0 + (i + 0.5) * (span / n);
            barrierMatrix(F, s, dir, 0, 0.62, _m0);
            armco.m.push(_m0.clone());
            if (i % q.postEvery === 0) {
              barrierMatrix(F, s - (span / n) * 0.5, dir, 0.075, 0.10, _m0);
              posts.m.push(_m0.clone());
            }
          }
          out.armcoCount += n;
        } else if (seg.type === 'concrete') {
          const n = Math.max(1, Math.round(span / wallLen));
          for (let i = 0; i < n; i++) {
            const s = s0 + (i + 0.5) * (span / n);
            barrierMatrix(F, s, dir, 0, 0.52, _m0);
            walls.m.push(_m0.clone());
          }
        } else if (seg.type === 'tecpro') {
          const blockLen = 1.0;
          const n = Math.max(2, Math.round(span / blockLen));
          const rows = 3;
          for (let i = 0; i < n; i++) {
            const s = s0 + (i + 0.5) * (span / n);
            for (let r = 0; r < rows; r++) {
              barrierMatrix(F, s, dir, -0.5, 0.5 + r * 1.0, _m0);
              tecpro.m.push(_m0.clone());
            }
          }
        } else if (seg.type === 'tyre' || seg.type === 'tyres') {
          const tyreD = 0.72;
          const n = Math.max(3, Math.round(span / tyreD));
          const rows = q.tyreRows;
          const depth = q.detail >= 2 ? 2 : 1;
          for (let i = 0; i < n; i++) {
            const s = s0 + (i + 0.5) * (span / n);
            for (let r = 0; r < rows; r++) {
              for (let k = 0; k < depth; k++) {
                const stagger = (r % 2) * tyreD * 0.5;
                barrierMatrix(F, s + stagger, dir, 0.38 + k * 0.62, 0.36 + r * 0.62, _m0);
                tyres.m.push(_m0.clone());
                out.tyreCount++;
              }
            }
            if (i % 4 === 0) {
              barrierMatrix(F, s, dir, -0.02, 0.36 + (rows - 1) * 0.62 + 0.28, _m0);
              straps.m.push(_m0.clone());
            }
          }
        }
      } catch (e) { /* skip this segment */ }
    }
  }

  out.collectors = { armco: armco, posts: posts, walls: walls, tecpro: tecpro, tyres: tyres, straps: straps };
  out.panelLen = panelLen;
  out.wallLen = wallLen;
  return out;
}

/** Debris fencing panels + posts along a stretch, used in front of grandstands. */
function buildFenceRun(W, s0, span, dir, height, panels, posts) {
  const F = W.frames;
  const panelLen = 4.0;
  const n = Math.max(1, Math.round(span / panelLen));
  for (let i = 0; i < n; i++) {
    const s = s0 + (i + 0.5) * (span / n);
    barrierMatrix(F, s, dir, 0.55, height * 0.5 + 0.9, _m0);
    panels.m.push(_m0.clone());
    barrierMatrix(F, s - (span / n) * 0.5, dir, 0.55, height * 0.5 + 0.9, _m0);
    posts.m.push(_m0.clone());
  }
}

/* ===========================================================================
 * 12. Scenery — grandstands, crowd, pit complex, gantry, towers
 * ========================================================================= */

function pushBoxM(list, sx, sy, sz, px, py, pz, M) {
  try {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(px, py, pz);
    g.applyMatrix4(M);
    list.push(g);
    return g;
  } catch (e) { return null; }
}

function pushCylM(list, r, h, seg, px, py, pz, M) {
  try {
    const g = new THREE.CylinderGeometry(r, r, h, seg || 8, 1, false);
    g.translate(px, py, pz);
    g.applyMatrix4(M);
    list.push(g);
    return g;
  } catch (e) { return null; }
}

function autoScenery(W) {
  const out = [];
  const rnd = mulberry32(W.circuit.seed ^ 0x5eed);
  const start = W.circuit.startLine;
  out.push({ type: 'grandstand', at: wrapFrac(start + 0.985), side: W.circuit.pitSide > 0 ? 'left' : 'right', length: 165, tiers: 16 });
  out.push({ type: 'grandstand', at: wrapFrac(start + 0.22), side: 'right', length: 120, tiers: 12 });
  out.push({ type: 'grandstand', at: wrapFrac(start + 0.46), side: 'left', length: 105, tiers: 11 });
  out.push({ type: 'grandstand', at: wrapFrac(start + 0.72), side: 'right', length: 130, tiers: 13 });
  out.push({ type: 'hospitality', at: wrapFrac(start + 0.035), side: W.circuit.pitSide > 0 ? 'left' : 'right', length: 60 });
  out.push({ type: 'tower', at: wrapFrac(start + 0.004), side: W.circuit.pitSide > 0 ? 'left' : 'right' });
  for (let i = 0; i < 12; i++) {
    out.push({
      type: 'trees',
      at: wrapFrac(rnd()),
      side: rnd() > 0.5 ? 'left' : 'right',
      count: 20 + Math.floor(rnd() * 40),
      spread: 60 + rnd() * 120,
    });
  }
  return out;
}

/**
 * A multi-tier grandstand. Geometry is merged per stand so frustum culling
 * still works; the seats are handed to the shared crowd InstancedMesh.
 */
function buildGrandstand(W, M, opts) {
  const shell = [];
  const seats = W.crowdSeats;
  const L = clamp(num(opts.length, 120), 20, 400);
  const tiers = clamp(Math.round(num(opts.tiers, 12)), 4, 30);
  const run = 0.95;
  const rise = 0.52;
  const D = tiers * run;
  const topY = tiers * rise;
  const rnd = W.rnd;

  // Front debris wall and the raked deck.
  pushBoxM(shell, 0.4, 1.35, L, -0.3, 0.68, 0, M);
  for (let i = 0; i < tiers; i++) {
    pushBoxM(shell, run, rise + 0.25, L, run * (i + 0.5), rise * i + (rise + 0.25) * 0.5 - 0.12, 0, M);
  }
  // Side walls.
  for (let k = -1; k <= 1; k += 2) {
    pushBoxM(shell, D + 0.8, topY + 0.9, 0.5, D * 0.5, (topY + 0.9) * 0.5, k * (L * 0.5 + 0.25), M);
  }
  // Back wall + roof structure.
  pushBoxM(shell, 0.6, topY + 4.2, L + 1.0, D + 0.3, (topY + 4.2) * 0.5, 0, M);
  const roofY = topY + 4.9;
  pushBoxM(shell, D * 0.82, 0.35, L + 1.4, D * 0.60, roofY, 0, M);
  pushBoxM(shell, 0.45, 1.1, L + 1.4, D * 0.19, roofY + 0.45, 0, M);
  const cols = Math.max(3, Math.round(L / 14));
  for (let i = 0; i <= cols; i++) {
    const z = -L * 0.5 + (L / cols) * i;
    pushCylM(shell, 0.16, roofY, 6, D * 0.22, roofY * 0.5, z, M);
  }
  // Stairwells cutting the seating into blocks.
  const blocks = Math.max(2, Math.round(L / 32));
  for (let b = 1; b < blocks; b++) {
    const z = -L * 0.5 + (L / blocks) * b;
    pushBoxM(shell, D, topY * 0.5, 1.1, D * 0.5, topY * 0.25, z, M);
  }

  // Seats -> crowd instances.
  const spacing = 0.62;
  const perRow = Math.max(1, Math.floor(L / spacing));
  for (let i = 0; i < tiers; i++) {
    for (let j = 0; j < perRow; j++) {
      const z = -L * 0.5 + (j + 0.5) * spacing;
      // leave the stairwells empty
      let blocked = false;
      for (let b = 1; b < blocks; b++) {
        const bz = -L * 0.5 + (L / blocks) * b;
        if (Math.abs(z - bz) < 0.85) { blocked = true; break; }
      }
      if (blocked) continue;
      const x = run * (i + 0.62) + (rnd() - 0.5) * 0.12;
      const y = rise * i + 0.42;
      _v0.set(x, y, z + (rnd() - 0.5) * 0.14).applyMatrix4(M);
      seats.push(_v0.x, _v0.y, _v0.z);
    }
  }
  return shell;
}

function buildHospitality(W, M, opts) {
  const list = [];
  const L = clamp(num(opts.length, 60), 12, 300);
  pushBoxM(list, 12, 7.5, L, 6.5, 3.75, 0, M);
  pushBoxM(list, 13.5, 0.5, L + 1.4, 6.5, 7.8, 0, M);
  pushBoxM(list, 0.5, 1.3, L + 1.4, 0.3, 8.6, 0, M);
  // terrace
  pushBoxM(list, 4.0, 0.35, L, -1.6, 3.9, 0, M);
  const rails = Math.max(3, Math.round(L / 6));
  for (let i = 0; i <= rails; i++) {
    pushCylM(list, 0.06, 1.1, 5, -3.4, 4.6, -L * 0.5 + (L / rails) * i, M);
  }
  pushBoxM(list, 4.0, 0.1, 0.1, -1.6, 5.15, 0, M);
  return list;
}

function buildTimingTower(W, M) {
  const list = [];
  pushBoxM(list, 5.0, 26, 7.0, 3.5, 13, 0, M);
  pushBoxM(list, 6.2, 1.0, 8.2, 3.5, 26.6, 0, M);
  pushBoxM(list, 0.6, 9.0, 6.0, 0.6, 18, 0, M);   // the screen face
  pushCylM(list, 0.18, 8, 6, 3.5, 31, 0, M);
  return list;
}

/** Pit complex: garages, roof, pit wall, plus the pit-lane surface. */
function buildPitComplex(W, startS) {
  const F = W.frames;
  const dir = W.circuit.pitSide;
  const shell = [];
  const glassy = [];
  const laneLen = 380;
  const s0 = startS - laneLen * 0.62;
  const bays = 10;

  for (let b = 0; b < bays; b++) {
    const s = s0 + (b + 0.5) * (laneLen / bays);
    barrierMatrix(F, s, dir, 14.0, 0, _m0);
    const bw = (laneLen / bays) - 1.2;
    // garage box
    pushBoxM(shell, 11.0, 8.2, bw, 5.5, 4.1, 0, _m0);
    // roll-up door recess facing the lane
    pushBoxM(glassy, 0.4, 4.4, bw * 0.72, -0.15, 2.4, 0, _m0);
    // dividing pillars
    pushBoxM(shell, 0.7, 8.6, 1.0, 0.35, 4.3, bw * 0.5 + 0.6, _m0);
    // upper hospitality band
    pushBoxM(glassy, 11.4, 3.0, bw, 5.5, 9.9, 0, _m0);
  }
  barrierMatrix(F, s0 + laneLen * 0.5, dir, 14.0, 0, _m0);
  pushBoxM(shell, 12.5, 0.7, laneLen, 5.5, 11.8, 0, _m0);
  pushBoxM(shell, 13.5, 0.9, laneLen + 2, 5.5, 12.6, 0, _m0);
  pushBoxM(shell, 0.7, 1.5, laneLen + 2, -0.6, 12.4, 0, _m0);

  // Pit wall between the lane and the track.
  const wallSegs = Math.max(6, Math.round(laneLen / 6));
  for (let i = 0; i < wallSegs; i++) {
    const s = s0 + (i + 0.5) * (laneLen / wallSegs);
    barrierMatrix(F, s, dir, -barrierOffsetAt(F, s, dir) + 0, 0.55, _m0);
    // re-anchor: the pit wall sits just outside the track edge
    frameAt(F, s, _frB);
    _v0.set(_frB.lat.x, 0, _frB.lat.z).normalize().multiplyScalar(dir);
    _v2.set(_frB.tan.x, 0, _frB.tan.z).normalize().multiplyScalar(-dir);
    _v1.set(0, 1, 0);
    _m1.makeBasis(_v0, _v1, _v2);
    _v3.copy(_frB.pos).addScaledVector(_frB.lat, dir * (_frB.width * 1.25 + 1.2));
    _m1.setPosition(_v3.x, _frB.pos.y + 0.55, _v3.z);
    pushBoxM(shell, 0.42, 1.1, laneLen / wallSegs + 0.05, 0, 0, 0, _m1);
    if (i % 3 === 0) pushBoxM(shell, 1.6, 0.12, 1.6, 1.1, 0.9, 0, _m1);   // timing stand shelves
  }

  // Pit lane surface.
  const LP = [], LN = [], LUV = [], LIDX = [];
  buildRunoffRibbon(F, s0 - 90, s0 + laneLen + 90, dir,
    function (s, fr) { return fr.width * 1.22; },
    function (s, fr) { return fr.width * 1.22 + 13.5; },
    4, 4.0, 0, 0, 0, LP, LN, LUV, LIDX);
  const laneGeo = finishGeo(LP, LN, LUV, LIDX);
  if (laneGeo) { laneGeo.translate(0, 0.05, 0); laneGeo.computeVertexNormals(); laneGeo.computeBoundingSphere(); }

  return { shell: shell, glass: glassy, lane: laneGeo, s0: s0, len: laneLen, dir: dir };
}

/** Start gantry with its 5 red light columns. */
function buildStartGantry(W, startS) {
  const F = W.frames;
  const shell = [];
  frameAt(F, startS, _frB);
  const w = _frB.width;

  for (let d = -1; d <= 1; d += 2) {
    _v0.set(_frB.lat.x, 0, _frB.lat.z).normalize().multiplyScalar(d);
    _v2.set(_frB.tan.x, 0, _frB.tan.z).normalize().multiplyScalar(-d);
    _v1.set(0, 1, 0);
    _m0.makeBasis(_v0, _v1, _v2);
    _v3.copy(_frB.pos).addScaledVector(_frB.lat, d * (w + 3.2));
    _m0.setPosition(_v3.x, _frB.pos.y, _v3.z);
    pushBoxM(shell, 1.5, 9.6, 1.5, 0, 4.8, 0, _m0);
    pushBoxM(shell, 2.2, 0.4, 2.2, 0, 9.8, 0, _m0);
    pushCylM(shell, 0.14, 9.0, 6, 0.9, 4.5, 0.9, _m0);
  }

  // Cross beam.
  _v0.set(_frB.lat.x, 0, _frB.lat.z).normalize();
  _v2.set(_frB.tan.x, 0, _frB.tan.z).normalize().multiplyScalar(-1);
  _v1.set(0, 1, 0);
  _m0.makeBasis(_v0, _v1, _v2);
  _m0.setPosition(_frB.pos.x, _frB.pos.y, _frB.pos.z);
  const beamW = (w + 3.2) * 2 + 1.5;
  pushBoxM(shell, beamW, 1.5, 1.2, 0, 9.9, 0, _m0);
  pushBoxM(shell, beamW, 0.35, 1.9, 0, 10.85, 0, _m0);
  // sign fascia
  pushBoxM(shell, beamW * 0.55, 1.15, 0.22, 0, 11.5, 0.7, _m0);
  // light housing (local +Z faces back down the grid)
  pushBoxM(shell, 7.4, 1.9, 0.9, 0, 8.4, 0.75, _m0);

  // 5 columns x 2 lamps, exposed as instances so set(n) is a colour write.
  const lampColl = collector();
  const glowColl = collector();
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 2; r++) {
      const x = (c - 2) * 1.35;
      const y = 8.4 + (r === 0 ? 0.42 : -0.42);
      _m1.copy(_m0);
      _v4.set(x, y, 1.28);
      _v4.applyMatrix4(_m0);
      _m1.setPosition(_v4.x, _v4.y, _v4.z);
      lampColl.m.push(_m1.clone());
      lampColl.c.push(new THREE.Color(0x090909));
      const gm = _m1.clone();
      glowColl.m.push(gm);
      glowColl.c.push(new THREE.Color(0x000000));
    }
  }
  return { shell: shell, lamps: lampColl, glow: glowColl, matrix: _m0.clone() };
}

/* ===========================================================================
 * 13. Billboards, trees, hills, bridges, marshal posts, boards, lighting
 * ========================================================================= */

function buildBillboards(W) {
  const F = W.frames;
  const q = W.quality;
  const panels = collector();
  const legs = collector();
  const every = q.billboardEvery;
  const n = Math.max(4, Math.floor(F.total / every));
  const rnd = W.rnd;
  const cells = 4;

  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) * (F.total / n) + (rnd() - 0.5) * every * 0.3;
    const dir = rnd() > 0.5 ? 1 : -1;
    try {
      barrierMatrix(F, s, dir, 2.6, 2.9, _m0);
      panels.m.push(_m0.clone());
      const cell = Math.floor(rnd() * 16);
      panels.u.push(new THREE.Vector2((cell % cells) / cells, 1 - Math.floor(cell / cells) / cells - 1 / cells));
      for (let k = -1; k <= 1; k += 2) {
        barrierMatrix(F, s + k * 3.0, dir, 2.6, 1.2, _m0);
        legs.m.push(_m0.clone());
      }
    } catch (e) { /* skip */ }
  }
  return { panels: panels, legs: legs, cells: cells };
}

function buildTrees(W, sceneryList) {
  const F = W.frames;
  const q = W.quality;
  const rnd = W.rnd;
  const sets = [collector(), collector(), collector()];
  const budget = Math.round(1400 * q.trees);
  let placed = 0;

  function scatter(s, dir, count, spread) {
    for (let i = 0; i < count && placed < budget; i++) {
      const ss = s + (rnd() - 0.5) * spread;
      let baseOff;
      try { baseOff = barrierOffsetAt(F, ss, dir); } catch (e) { continue; }
      const out = baseOff + 12 + Math.pow(rnd(), 0.7) * (spread * 0.55 + 30);
      frameAt(F, ss, _frA);
      _v3.copy(_frA.pos).addScaledVector(_frA.lat, dir * out);
      const groundY = _frA.pos.y + runoffDrop(Math.max(0, out - _frA.width * 1.2)) - rnd() * 0.6;
      const h = 5.5 + rnd() * 9.5;
      const v = Math.floor(rnd() * 3);
      _q0.setFromAxisAngle(_up, rnd() * TAU);
      _v4.set(h * (0.55 + rnd() * 0.25), h, h * (0.55 + rnd() * 0.25));
      _m0.compose(_v3.setY(groundY), _q0, _v4);
      sets[v].m.push(_m0.clone());
      placed++;
    }
  }

  let explicit = 0;
  for (let i = 0; i < sceneryList.length; i++) {
    const sc = sceneryList[i];
    if (sc.type !== 'trees' && sc.type !== 'forest') continue;
    explicit++;
    scatter(frac2s(F, num(sc.at, 0)), sideSign(sc.side, 1) || 1, Math.round(num(sc.count, 30)), num(sc.spread, 90));
  }
  if (explicit === 0 && !W.circuit.street) {
    const clusters = 14;
    for (let i = 0; i < clusters; i++) {
      scatter((i + rnd()) * (F.total / clusters), rnd() > 0.5 ? 1 : -1, Math.round(budget / clusters), 110);
    }
  }
  return sets;
}

function buildHills(W) {
  const F = W.frames;
  if (W.circuit.street) return null;
  const list = [];
  const rnd = W.rnd;
  const cx = (F.minX + F.maxX) * 0.5;
  const cz = (F.minZ + F.maxZ) * 0.5;
  const radius = Math.max(F.maxX - F.minX, F.maxZ - F.minZ) * 0.5 + 420;
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rnd() * 0.3;
    const r = radius * (0.85 + rnd() * 0.5);
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const h = 55 + rnd() * 130;
    const rad = 180 + rnd() * 320;
    try {
      const g = new THREE.ConeGeometry(rad, h, 9, 1, false);
      _m0.makeRotationY(rnd() * TAU);
      _m0.setPosition(x, F.minY - 12 + h * 0.5, z);
      g.applyMatrix4(_m0);
      list.push(g);
    } catch (e) { /* skip */ }
  }
  return list;
}

/** Where the circuit crosses over itself, throw a bridge structure across. */
function buildBridges(W) {
  const F = W.frames;
  const list = [];
  const found = [];
  const explicit = W.circuit.bridges;

  if (explicit.length) {
    for (let i = 0; i < explicit.length; i++) found.push(frac2s(F, num(explicit[i].at, 0)));
  } else {
    const stride = Math.max(1, Math.round(12 / F.step));
    const minSep = 160;
    for (let i = 0; i < F.count; i += stride) {
      const xi = F.pos[i * 3], yi = F.pos[i * 3 + 1], zi = F.pos[i * 3 + 2];
      for (let j = i + stride; j < F.count; j += stride) {
        const ds = Math.min((j - i) * F.step, F.total - (j - i) * F.step);
        if (ds < minSep) continue;
        const dx = xi - F.pos[j * 3], dz = zi - F.pos[j * 3 + 2];
        const dy = yi - F.pos[j * 3 + 1];
        if (dx * dx + dz * dz > 900) continue;
        if (Math.abs(dy) < 3.5) continue;
        const upper = dy > 0 ? i : j;
        let dup = false;
        for (let k = 0; k < found.length; k++) {
          if (Math.abs(found[k] - upper * F.step) < 120) { dup = true; break; }
        }
        if (!dup) found.push(upper * F.step);
      }
    }
  }

  for (let k = 0; k < Math.min(found.length, 6); k++) {
    const s = found[k];
    const halfLen = 26;
    const segs = 8;
    for (let d = -1; d <= 1; d += 2) {
      for (let i = 0; i < segs; i++) {
        const ss = s - halfLen + (i + 0.5) * ((halfLen * 2) / segs);
        frameAt(F, ss, _frA);
        _v0.set(_frA.lat.x, 0, _frA.lat.z).normalize();
        _v2.set(_frA.tan.x, 0, _frA.tan.z).normalize();
        _v1.set(0, 1, 0);
        _m0.makeBasis(_v0, _v1, _v2);
        _v3.copy(_frA.pos).addScaledVector(_frA.lat, d * (_frA.width * 1.25));
        _m0.setPosition(_v3.x, _frA.pos.y, _v3.z);
        pushBoxM(list, 0.7, 1.25, (halfLen * 2) / segs + 0.05, 0, 0.35, 0, _m0);
        if (i === 0 || i === segs - 1) {
          pushBoxM(list, 1.4, 7.5, 1.4, 0, -3.9, 0, _m0);
        }
      }
    }
    // Under-deck slab so nothing shows daylight from below.
    for (let i = 0; i < segs; i++) {
      const ss = s - halfLen + (i + 0.5) * ((halfLen * 2) / segs);
      frameAt(F, ss, _frA);
      _v0.set(_frA.lat.x, 0, _frA.lat.z).normalize();
      _v2.set(_frA.tan.x, 0, _frA.tan.z).normalize();
      _v1.set(0, 1, 0);
      _m0.makeBasis(_v0, _v1, _v2);
      _m0.setPosition(_frA.pos.x, _frA.pos.y, _frA.pos.z);
      pushBoxM(list, _frA.width * 2.6, 0.6, (halfLen * 2) / segs + 0.05, 0, -0.45, 0, _m0);
    }
  }
  return list;
}

const FLAG_KINDS = {
  none: { cell: 0, color: 0x000000, blink: 0, hidden: true },
  green: { cell: 0, color: 0x18c23a, blink: 0 },
  yellow: { cell: 0, color: 0xf2d21a, blink: 0 },
  doubleyellow: { cell: 0, color: 0xf2d21a, blink: 1 },
  'double-yellow': { cell: 0, color: 0xf2d21a, blink: 1 },
  blue: { cell: 0, color: 0x1a5fd0, blink: 0 },
  red: { cell: 0, color: 0xd41220, blink: 0 },
  white: { cell: 0, color: 0xf2f2f2, blink: 0 },
  black: { cell: 0, color: 0x151515, blink: 0 },
  chequered: { cell: 1, color: 0xffffff, blink: 0 },
  checkered: { cell: 1, color: 0xffffff, blink: 0 },
  slippery: { cell: 2, color: 0xffffff, blink: 0 },
  meatball: { cell: 3, color: 0xffffff, blink: 0 },
  sc: { cell: 0, color: 0xf2d21a, blink: 2 },
  vsc: { cell: 0, color: 0xf2d21a, blink: 3 },
};

function buildMarshalPosts(W) {
  const F = W.frames;
  const circuit = W.circuit;
  const huts = collector();
  const flags = collector();
  const poles = collector();
  const records = [];

  let specs = circuit.marshalPosts;
  if (!specs.length) {
    const spacing = 340;
    const n = Math.max(6, Math.round(F.total / spacing));
    specs = [];
    for (let i = 0; i < n; i++) specs.push({ at: i / n, side: i % 2 === 0 ? 'right' : 'left' });
  }

  for (let i = 0; i < specs.length; i++) {
    const sp = specs[i];
    const s = frac2s(F, num(sp.at, i / specs.length));
    const dir = sideSign(sp.side, i % 2 === 0 ? 1 : -1) || 1;
    try {
      barrierMatrix(F, s, dir, 2.2, 0, _m0);
      huts.m.push(_m0.clone());
      barrierMatrix(F, s, dir, 1.4, 1.55, _m0);
      poles.m.push(_m0.clone());
      barrierMatrix(F, s, dir, 1.4, 2.35, _m0);
      const fm = _m0.clone();
      flags.m.push(fm);
      flags.c.push(new THREE.Color(0x000000));
      flags.u.push(new THREE.Vector2(0, 0.5));
      if (!flags.p) flags.p = [];
      flags.p.push(W.rnd() * TAU);
      _v0.setFromMatrixPosition(fm);
      records.push({
        index: records.length,
        s: s,
        side: dir,
        position: _v0.clone(),
        flag: 'none',
        _blink: 0,
        _base: fm.clone(),
      });
    } catch (e) { /* skip */ }
  }
  return { huts: huts, flags: flags, poles: poles, records: records };
}

function buildBrakingBoards(W) {
  const F = W.frames;
  const boards = collector();
  const posts = collector();
  let specs = W.circuit.brakingMarkers;

  if (!specs.length) {
    specs = [];
    const n = F.count;
    let i = 0;
    while (i < n) {
      if (Math.abs(F.curv[i]) < 0.007) { i++; continue; }
      let j = i;
      while (j < n && Math.abs(F.curv[wrapIndex(j, n)]) >= 0.004) j++;
      const sign = F.curv[i] >= 0 ? 1 : -1;
      specs.push({ at: wrapFrac((i * F.step) / F.total), side: sign > 0 ? 'right' : 'left', distances: [150, 100, 50] });
      i = j + Math.round(60 / F.step);
    }
  }

  const distMap = { 200: 0, 150: 1, 100: 2, 50: 3 };
  for (let k = 0; k < specs.length; k++) {
    const sp = specs[k];
    const sAt = frac2s(F, num(sp.at, 0));
    const dir = sideSign(sp.side, 1) || 1;
    const dists = Array.isArray(sp.distances) ? sp.distances : [num(sp.value, 100)];
    for (let d = 0; d < dists.length; d++) {
      const dist = dists[d];
      const cell = distMap[dist] !== undefined ? distMap[dist] : 2;
      try {
        barrierMatrix(F, sAt - dist, dir, 1.6, 1.85, _m0);
        boards.m.push(_m0.clone());
        boards.u.push(new THREE.Vector2((cell % 2) * 0.5, cell < 2 ? 0.5 : 0.0));
        barrierMatrix(F, sAt - dist, dir, 1.6, 0.7, _m0);
        posts.m.push(_m0.clone());
      } catch (e) { /* skip */ }
    }
  }
  return { boards: boards, posts: posts };
}

function buildLightPoles(W) {
  const F = W.frames;
  const q = W.quality;
  const poles = collector();
  const heads = collector();
  const positions = [];
  const spacing = q.poleEvery;
  const n = Math.max(6, Math.round(F.total / spacing));
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) * (F.total / n);
    const dir = i % 2 === 0 ? 1 : -1;
    try {
      barrierMatrix(F, s, dir, 5.0, 5.5, _m0);
      poles.m.push(_m0.clone());
      barrierMatrix(F, s, dir, 4.0, 11.2, _m0);
      heads.m.push(_m0.clone());
      _v0.setFromMatrixPosition(_m0);
      positions.push(_v0.x, _v0.y, _v0.z);
    } catch (e) { /* skip */ }
  }
  return { poles: poles, heads: heads, positions: new Float32Array(positions) };
}

/* ---------------------------------------------------------------------------
 * 13a. Shader-driven materials for crowd, flags and atlas signage
 * ------------------------------------------------------------------------ */

function makeAtlasMaterial(W, tex, cell, opts) {
  const o = opts || {};
  const mat = new THREE.MeshStandardMaterial({
    map: tex || null,
    color: o.color !== undefined ? o.color : 0xffffff,
    roughness: o.roughness !== undefined ? o.roughness : 0.75,
    metalness: 0.0,
    side: o.side || THREE.FrontSide,
    transparent: false,
    alphaTest: o.alphaTest !== undefined ? o.alphaTest : 0.0,
  });
  const key = o.key || 'apex-atlas';
  mat.onBeforeCompile = function (shader) {
    shader.uniforms.uAxCell = { value: new THREE.Vector2(cell, cell) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aUvOff;\nuniform vec2 uAxCell;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = vMapUv * uAxCell + aUvOff;\n#endif');
  };
  mat.customProgramCacheKey = function () { return key; };
  W.mats.push(mat);
  return mat;
}

function makeCrowdMaterial(W, tex) {
  const mat = new THREE.MeshBasicMaterial({
    map: tex || null,
    color: 0xffffff,
    alphaTest: 0.34,
    transparent: false,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  mat.onBeforeCompile = function (shader) {
    shader.uniforms.uAxTime = W.uniforms.time;
    shader.uniforms.uAxAnim = W.uniforms.crowdAnim;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        '#include <common>',
        'attribute float aPhase;',
        'uniform float uAxTime;',
        'uniform float uAxAnim;',
      ].join('\n'))
      .replace('#include <project_vertex>', [
        'vec4 mvPosition = vec4( 0.0, 0.0, 0.0, 1.0 );',
        'float axSx = 1.0; float axSy = 1.0;',
        '#ifdef USE_INSTANCING',
        '  mvPosition = instanceMatrix * mvPosition;',
        '  axSx = length( instanceMatrix[ 0 ].xyz );',
        '  axSy = length( instanceMatrix[ 1 ].xyz );',
        '#endif',
        'mvPosition = modelViewMatrix * mvPosition;',
        'float axW = sin( uAxTime * ( 2.1 + fract( aPhase ) * 2.6 ) + aPhase * 11.0 );',
        'float axW2 = cos( uAxTime * ( 1.3 + fract( aPhase * 0.7 ) * 1.4 ) + aPhase * 6.0 );',
        'float axBob = axW * 0.085 * axSy * uAxAnim;',
        'float axSway = axW2 * 0.055 * axSx * uAxAnim;',
        'mvPosition.xyz += vec3( position.x * axSx + axSway, position.y * axSy + axBob + axSy * 0.5, 0.0 );',
        'gl_Position = projectionMatrix * mvPosition;',
      ].join('\n'));
  };
  mat.customProgramCacheKey = function () { return 'apex-crowd-v1'; };
  W.mats.push(mat);
  return mat;
}

function makeFlagMaterial(W, tex) {
  const mat = new THREE.MeshBasicMaterial({
    map: tex || null,
    color: 0xffffff,
    side: THREE.DoubleSide,
    transparent: false,
    toneMapped: true,
  });
  mat.onBeforeCompile = function (shader) {
    shader.uniforms.uAxTime = W.uniforms.time;
    shader.uniforms.uAxCell = { value: new THREE.Vector2(0.5, 0.5) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        '#include <common>',
        'attribute vec2 aUvOff;',
        'attribute float aPhase;',
        'uniform float uAxTime;',
        'uniform vec2 uAxCell;',
      ].join('\n'))
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = vMapUv * uAxCell + aUvOff;\n#endif')
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float axT = clamp( transformed.z / 1.15, 0.0, 1.0 );',
        'float axWave = sin( transformed.z * 7.5 + uAxTime * 9.0 + aPhase ) * 0.075 * axT;',
        'transformed.x += axWave;',
        'transformed.y += axWave * 0.35;',
      ].join('\n'));
  };
  mat.customProgramCacheKey = function () { return 'apex-flag-v1'; };
  W.mats.push(mat);
  return mat;
}

/* ===========================================================================
 * 14. Public factory
 * ========================================================================= */

/**
 * @param {Object} circuit  circuit description (points, kerbs, surfaces, scenery, ...)
 * @param {THREE.CatmullRomCurve3} curve  closed centreline
 * @param {Object} [opts]   { quality, wetnessUniform, puddleMask }
 * @returns {Object} world
 */
export function buildTrackWorld(circuit, curve, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const quality = resolveQuality(options.quality);

  const W = {
    circuit: normaliseCircuit(circuit),
    curve: curve,
    curveLocal: curve,
    quality: quality,
    options: options,
    group: new THREE.Group(),
    geoms: [],
    mats: [],
    texes: [],
    wettables: [],
    crowdSeats: [],
    lightHeadMats: [],
    nightMats: [],
    pointLights: [],
    time: 0,
    timeOfDay: 13.5,
    wetness: 0,
    disposed: false,
    stats: { drawCalls: 0, instances: 0, triangles: 0 },
  };
  W.group.name = 'apex-track-world';
  W.rnd = mulberry32((W.circuit.seed | 0) ^ 0x1f2e3d4c);

  const sharedWet =
    options.wetnessUniform && typeof options.wetnessUniform === 'object' && 'value' in options.wetnessUniform
      ? options.wetnessUniform
      : { value: 0 };

  W.uniforms = {
    wet: sharedWet,
    ripple: { value: 0 },
    time: { value: 0 },
    tod: { value: new THREE.Color(1, 1, 1) },
    rubber: { value: 1 },
    puddleMask: { value: null },
    puddleScale: { value: 0.035 },
    detile: { value: quality.detail >= 1 ? 0.34 : 0.0 },
    crowdAnim: { value: 1 },
  };

  function reg(mesh, opt) {
    if (!mesh) return null;
    const o = opt || {};
    mesh.castShadow = quality.shadows && !!o.cast;
    mesh.receiveShadow = quality.shadows && o.receive !== false;
    if (o.cull === false) mesh.frustumCulled = false;
    staticMesh(mesh);
    W.group.add(mesh);
    W.stats.drawCalls++;
    return mesh;
  }

  function registerWettable(mat, cfg) {
    if (!mat) return mat;
    W.wettables.push({
      mat: mat,
      baseColor: mat.color ? mat.color.clone() : new THREE.Color(1, 1, 1),
      baseRough: typeof mat.roughness === 'number' ? mat.roughness : 1,
      darken: cfg && cfg.darken !== undefined ? cfg.darken : 0.55,
      wetRough: cfg && cfg.wetRough !== undefined ? cfg.wetRough : 0.18,
      envWet: cfg && cfg.envWet !== undefined ? cfg.envWet : 1.0,
      baseEnv: typeof mat.envMapIntensity === 'number' ? mat.envMapIntensity : 1,
    });
    return mat;
  }

  /* --- frames ------------------------------------------------------------ */
  let F;
  try {
    F = buildFrames(W);
  } catch (e) {
    F = null;
  }
  if (!F) {
    // Degenerate fallback: hand back an inert but valid world.
    return inertWorld(W);
  }
  W.frames = F;
  W.cross = buildCrossSection();
  try { computeBarrierOffsets(W); } catch (e) { /* defaults remain */ }

  /* --- textures ---------------------------------------------------------- */
  const T = {};
  const tex = quality.tex;
  try { T.asphalt = genAsphalt(W, tex); } catch (e) { T.asphalt = {}; }
  try { T.kerb = genKerb(W, Math.min(512, tex), '#c4202c', '#eceae4'); } catch (e) { T.kerb = {}; }
  try { T.kerbAlt = genKerb(W, Math.min(256, tex), '#e8b21c', '#c4202c'); } catch (e) { T.kerbAlt = {}; }
  try { T.grass = genGrass(W, Math.min(512, tex)); } catch (e) { T.grass = {}; }
  try { T.gravel = genGravel(W, Math.min(512, tex)); } catch (e) { T.gravel = {}; }
  try { T.astro = genAstro(W, Math.min(256, tex)); } catch (e) { T.astro = {}; }
  try { T.concrete = genConcrete(W, Math.min(512, tex)); } catch (e) { T.concrete = {}; }
  try { T.steel = genSteel(W, Math.min(512, tex)); } catch (e) { T.steel = {}; }
  try { T.tyre = genTyreWall(W, Math.min(256, tex)); } catch (e) { T.tyre = {}; }
  try { T.fence = genFence(W, 256); } catch (e) { T.fence = null; }
  try { T.crowd = genCrowdSprite(W); } catch (e) { T.crowd = null; }
  try { T.flags = genFlagAtlas(W); } catch (e) { T.flags = null; }
  try { T.numerals = genNumeralAtlas(W); } catch (e) { T.numerals = null; }
  try { T.boards = genBrakeBoardAtlas(W); } catch (e) { T.boards = null; }
  try { T.sponsors = genSponsorAtlas(W); } catch (e) { T.sponsors = { tex: null, cells: 4 }; }
  try { T.facade = genFacade(W, Math.min(512, tex), { seed: 0x77aa11, rows: 4, cols: 8 }); } catch (e) { T.facade = {}; }
  try { T.tree = [genTreeCanopy(W, 0), genTreeCanopy(W, 1), genTreeCanopy(W, 2)]; } catch (e) { T.tree = [null, null, null]; }

  // Puddle mask: caller-supplied wins, otherwise procedural.
  let puddleTex = null;
  if (options.puddleMask && options.puddleMask.isTexture) {
    puddleTex = options.puddleMask;
    puddleTex.wrapS = puddleTex.wrapT = THREE.RepeatWrapping;
  } else {
    try { puddleTex = genPuddleMask(W, 256); } catch (e) { puddleTex = null; }
  }
  W.uniforms.puddleMask.value = puddleTex;

  function setRepeat(set, tile) {
    if (!set) return;
    const r = 1 / tile;
    const keys = ['albedo', 'normal', 'rough', 'emissive'];
    for (let i = 0; i < keys.length; i++) {
      const t = set[keys[i]];
      if (t && t.repeat) t.repeat.set(r, r);
    }
  }
  setRepeat(T.grass, 6.0);
  setRepeat(T.gravel, 4.0);
  setRepeat(T.astro, 2.0);
  setRepeat(T.concrete, 5.0);
  setRepeat(T.steel, 1.6);
  setRepeat(T.tyre, 1.0);
  if (T.kerb.albedo) { T.kerb.albedo.repeat.set(1 / 1.0, 1 / 2.0); }
  if (T.kerb.normal) { T.kerb.normal.repeat.set(1 / 1.0, 1 / 2.0); }
  if (T.kerb.rough) { T.kerb.rough.repeat.set(1 / 1.0, 1 / 2.0); }
  if (T.kerbAlt.albedo) { T.kerbAlt.albedo.repeat.set(1 / 0.62, 1 / 1.2); }
  if (T.kerbAlt.normal) { T.kerbAlt.normal.repeat.set(1 / 0.62, 1 / 1.2); }
  if (T.kerbAlt.rough) { T.kerbAlt.rough.repeat.set(1 / 0.62, 1 / 1.2); }

  /* --- materials --------------------------------------------------------- */
  const M = {};
  try { M.asphalt = makeAsphaltMaterial(W, T.asphalt); } catch (e) { M.asphalt = new THREE.MeshStandardMaterial({ color: 0x3a3a3d, roughness: 0.95 }); }
  W.mats.push(M.asphalt);

  function surfaceMat(set, color, rough, cfg) {
    const m = new THREE.MeshStandardMaterial({
      map: set && set.albedo ? set.albedo : null,
      normalMap: set && set.normal ? set.normal : null,
      roughnessMap: set && set.rough ? set.rough : null,
      color: color,
      roughness: rough,
      metalness: 0.0,
      dithering: true,
    });
    m.envMapIntensity = 0.35;
    W.mats.push(m);
    return registerWettable(m, cfg);
  }

  M.kerb = surfaceMat(T.kerb, 0xffffff, 1.0, { darken: 0.62, wetRough: 0.10, envWet: 1.6 });
  M.kerbAlt = surfaceMat(T.kerbAlt, 0xffffff, 1.0, { darken: 0.66, wetRough: 0.12, envWet: 1.4 });
  M.grass = surfaceMat(T.grass, 0xffffff, 1.0, { darken: 0.62, wetRough: 0.55, envWet: 0.5 });
  M.gravel = surfaceMat(T.gravel, 0xffffff, 1.0, { darken: 0.48, wetRough: 0.42, envWet: 0.6 });
  M.astro = surfaceMat(T.astro, 0xffffff, 1.0, { darken: 0.58, wetRough: 0.22, envWet: 1.1 });
  M.concrete = surfaceMat(T.concrete, 0xffffff, 1.0, { darken: 0.50, wetRough: 0.14, envWet: 1.5 });
  M.terrain = surfaceMat(T.grass, 0xc9cfc2, 1.0, { darken: 0.66, wetRough: 0.60, envWet: 0.4 });

  M.line = new THREE.MeshStandardMaterial({
    color: 0xf2f4f5, roughness: 0.52, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  M.line.envMapIntensity = 0.4;
  W.mats.push(registerWettable(M.line, { darken: 0.66, wetRough: 0.09, envWet: 1.8 }));

  M.numeral = new THREE.MeshStandardMaterial({
    map: T.numerals || null, color: 0xf2f4f5, roughness: 0.55, metalness: 0,
    transparent: true, alphaTest: 0.42, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
  });
  W.mats.push(M.numeral);

  M.steel = new THREE.MeshStandardMaterial({
    map: T.steel.albedo || null, roughnessMap: T.steel.rough || null,
    color: 0xffffff, roughness: 0.55, metalness: 0.85, side: THREE.DoubleSide,
  });
  M.steel.envMapIntensity = 1.0;
  W.mats.push(M.steel);

  M.tyre = new THREE.MeshStandardMaterial({
    map: T.tyre.albedo || null, roughnessMap: T.tyre.rough || null,
    color: 0xffffff, roughness: 0.92, metalness: 0.0,
  });
  W.mats.push(registerWettable(M.tyre, { darken: 0.7, wetRough: 0.28, envWet: 1.2 }));

  M.tecpro = new THREE.MeshStandardMaterial({ color: 0x1f4fa8, roughness: 0.62, metalness: 0.05 });
  W.mats.push(M.tecpro);
  M.strap = new THREE.MeshStandardMaterial({ color: 0xe6e9ec, roughness: 0.7, metalness: 0.0 });
  W.mats.push(M.strap);

  M.fence = new THREE.MeshStandardMaterial({
    map: T.fence || null, color: 0xb8bec4, roughness: 0.6, metalness: 0.4,
    transparent: false, alphaTest: 0.42, side: THREE.DoubleSide,
  });
  W.mats.push(M.fence);

  M.building = new THREE.MeshStandardMaterial({
    map: T.facade.albedo || null,
    emissiveMap: T.facade.emissive || null,
    emissive: 0xffffff, emissiveIntensity: 0.0,
    color: 0xffffff, roughness: 0.78, metalness: 0.05,
  });
  W.mats.push(M.building);
  W.nightMats.push(M.building);

  const structTex = cloneTexSet(W, T.concrete, 3.0);
  M.structure = new THREE.MeshStandardMaterial({
    map: structTex.albedo || null, normalMap: structTex.normal || null,
    color: 0xd8dade, roughness: 0.82, metalness: 0.03,
  });
  W.mats.push(registerWettable(M.structure, { darken: 0.62, wetRough: 0.24, envWet: 1.1 }));

  M.glass = new THREE.MeshStandardMaterial({ color: 0x1b2732, roughness: 0.14, metalness: 0.25 });
  M.glass.envMapIntensity = 1.4;
  W.mats.push(M.glass);

  M.crowd = makeCrowdMaterial(W, T.crowd);
  M.flag = makeFlagMaterial(W, T.flags);
  M.billboard = makeAtlasMaterial(W, T.sponsors.tex, 1 / 4, { key: 'apex-billboard-v1', roughness: 0.66, side: THREE.DoubleSide });
  M.board = makeAtlasMaterial(W, T.boards, 0.5, { key: 'apex-board-v1', roughness: 0.6, side: THREE.DoubleSide });

  M.lamp = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  W.mats.push(M.lamp);
  M.glow = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 });
  W.mats.push(M.glow);
  M.lampHead = new THREE.MeshBasicMaterial({ color: 0x1a1c1f, toneMapped: false });
  W.mats.push(M.lampHead);
  W.lightHeadMats.push(M.lampHead);

  M.hill = new THREE.MeshStandardMaterial({ color: 0x53603f, roughness: 0.97, metalness: 0.0 });
  W.mats.push(M.hill);

  M.trees = [];
  for (let i = 0; i < 3; i++) {
    const tm = new THREE.MeshStandardMaterial({
      map: T.tree[i] || null, color: 0xffffff, roughness: 0.88, metalness: 0.0,
      transparent: false, alphaTest: 0.44, side: THREE.DoubleSide,
    });
    W.mats.push(tm);
    M.trees.push(tm);
  }

  /* --- road -------------------------------------------------------------- */
  let roadMesh = null;
  try {
    const roadGeo = buildRoadGeometry(W);
    W.geoms.push(roadGeo);
    roadMesh = new THREE.Mesh(roadGeo, M.asphalt);
    roadMesh.name = 'apex-asphalt';
    roadMesh.receiveShadow = quality.shadows;
    roadMesh.castShadow = false;
    roadMesh.frustumCulled = false;
    staticMesh(roadMesh);
    W.group.add(roadMesh);
    W.stats.drawCalls++;
  } catch (e) { roadMesh = null; }

  /* --- kerbs ------------------------------------------------------------- */
  try {
    const K = buildKerbs(W);
    if (K.main) { W.geoms.push(K.main); reg(new THREE.Mesh(K.main, M.kerb), { cast: false, receive: true, cull: false }); }
    if (K.sausage) { W.geoms.push(K.sausage); reg(new THREE.Mesh(K.sausage, M.kerbAlt), { cast: quality.detail >= 2, receive: true, cull: false }); }
  } catch (e) { /* continue */ }

  /* --- markings ---------------------------------------------------------- */
  let gridSlots = [];
  let startS = 0;
  try {
    const MK = buildMarkings(W);
    gridSlots = MK.slots;
    startS = MK.startS;
    if (MK.lines) { W.geoms.push(MK.lines); reg(new THREE.Mesh(MK.lines, M.line), { receive: true, cull: false }); }
    if (MK.numerals) { W.geoms.push(MK.numerals); reg(new THREE.Mesh(MK.numerals, M.numeral), { receive: false, cull: false }); }
  } catch (e) { /* continue */ }

  /* --- run-off + terrain -------------------------------------------------- */
  try {
    const R = buildRunoff(W);
    const map = { grass: M.grass, gravel: M.gravel, astro: M.astro, concrete: M.concrete };
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i++) {
      const g = R[keys[i]];
      if (!g) continue;
      W.geoms.push(g);
      reg(new THREE.Mesh(g, map[keys[i]]), { receive: true, cull: false });
    }
  } catch (e) { /* continue */ }

  try {
    const tg = buildTerrain(W);
    W.geoms.push(tg);
    const tm = new THREE.Mesh(tg, M.terrain);
    tm.renderOrder = -1;
    reg(tm, { receive: true, cull: false });
  } catch (e) { /* continue */ }

  /* --- barriers ----------------------------------------------------------- */
  try {
    const B = buildBarriers(W);
    const c = B.collectors;
    const panelGeo = makeArmcoPanelGeo(B.panelLen);
    if (panelGeo) {
      const m = buildInstanced(W, panelGeo, M.steel, c.armco, { name: 'apex-armco', cast: quality.tier === 'ultra', receive: true });
      if (m) { W.group.add(m); W.stats.drawCalls++; W.stats.instances += c.armco.m.length; }
    }
    if (c.posts.m.length) {
      const pg = new THREE.BoxGeometry(0.14, 1.35, 0.12);
      pg.translate(0, 0.35, 0);
      const m = buildInstanced(W, pg, M.steel, c.posts, { name: 'apex-armco-posts', receive: true });
      if (m) { W.group.add(m); W.stats.drawCalls++; }
    }
    if (c.walls.m.length) {
      const wg = new THREE.BoxGeometry(0.42, 1.05, B.wallLen);
      const m = buildInstanced(W, wg, M.structure, c.walls, { name: 'apex-concrete-wall', cast: quality.shadows, receive: true });
      if (m) { W.group.add(m); W.stats.drawCalls++; }
    }
    if (c.tecpro.m.length) {
      const tg2 = new THREE.BoxGeometry(0.95, 0.96, 0.98);
      const m = buildInstanced(W, tg2, M.tecpro, c.tecpro, { name: 'apex-tecpro', cast: quality.shadows, receive: true });
      if (m) { W.group.add(m); W.stats.drawCalls++; }
    }
    if (c.tyres.m.length) {
      const rad = quality.detail >= 2 ? 12 : 8;
      const tub = quality.detail >= 2 ? 5 : 4;
      const tgeo = new THREE.TorusGeometry(0.33, 0.115, tub, rad);
      tgeo.rotateY(Math.PI / 2);
      const m = buildInstanced(W, tgeo, M.tyre, c.tyres, { name: 'apex-tyrewall', cast: quality.shadows, receive: true });
      if (m) { W.group.add(m); W.stats.drawCalls++; W.stats.instances += c.tyres.m.length; }
    }
    if (c.straps.m.length) {
      const sg = new THREE.BoxGeometry(1.5, 0.16, 2.9);
      const m = buildInstanced(W, sg, M.strap, c.straps, { name: 'apex-tyre-straps', receive: true });
      if (m) { W.group.add(m); W.stats.drawCalls++; }
    }
  } catch (e) { /* continue */ }

  /* --- scenery ------------------------------------------------------------ */
  const sceneryList = W.circuit.scenery.length ? W.circuit.scenery : autoScenery(W);
  const fencePanels = collector();
  const fencePosts = collector();

  for (let i = 0; i < sceneryList.length; i++) {
    const sc = sceneryList[i];
    const type = sc.type || 'grandstand';
    if (type === 'trees' || type === 'forest') continue;
    const s = frac2s(F, num(sc.at, 0));
    const dir = sideSign(sc.side, 1) || 1;
    try {
      let parts = null;
      let mat = M.structure;
      if (type === 'grandstand' || type === 'stand') {
        barrierMatrix(F, s, dir, num(sc.setback, 9), 0, _m0);
        parts = buildGrandstand(W, _m0, sc);
        if (quality.fenceLod > 0) {
          buildFenceRun(W, s - num(sc.length, 120) * 0.5, num(sc.length, 120), dir, 5.2, fencePanels, fencePosts);
        }
      } else if (type === 'hospitality' || type === 'paddock') {
        barrierMatrix(F, s, dir, num(sc.setback, 22), 0, _m0);
        parts = buildHospitality(W, _m0, sc);
        mat = M.building;
      } else if (type === 'tower' || type === 'timingtower') {
        barrierMatrix(F, s, dir, num(sc.setback, 16), 0, _m0);
        parts = buildTimingTower(W, _m0);
        mat = M.building;
      } else if (type === 'building') {
        barrierMatrix(F, s, dir, num(sc.setback, 30), 0, _m0);
        parts = [];
        pushBoxM(parts, num(sc.depth, 16), num(sc.height, 12), num(sc.length, 40), num(sc.depth, 16) * 0.5, num(sc.height, 12) * 0.5, 0, _m0);
        mat = M.building;
      }
      if (parts && parts.length) {
        const merged = mergeSafe(parts);
        if (merged) {
          W.geoms.push(merged);
          reg(new THREE.Mesh(merged, mat), { cast: quality.shadows, receive: true });
        }
      }
    } catch (e) { /* skip this piece of scenery */ }
  }

  /* --- pit complex + gantry ---------------------------------------------- */
  let startLights = null;
  try {
    const pit = buildPitComplex(W, startS);
    const shell = mergeSafe(pit.shell);
    if (shell) { W.geoms.push(shell); reg(new THREE.Mesh(shell, M.structure), { cast: quality.shadows, receive: true }); }
    const glass = mergeSafe(pit.glass);
    if (glass) { W.geoms.push(glass); reg(new THREE.Mesh(glass, M.glass), { cast: false, receive: true }); }
    if (pit.lane) { W.geoms.push(pit.lane); reg(new THREE.Mesh(pit.lane, M.concrete), { receive: true, cull: false }); }
  } catch (e) { /* continue */ }

  try {
    const G = buildStartGantry(W, startS);
    const shell = mergeSafe(G.shell);
    const lightGroup = new THREE.Group();
    lightGroup.name = 'apex-start-lights';
    if (shell) { W.geoms.push(shell); reg(new THREE.Mesh(shell, M.structure), { cast: quality.shadows, receive: true }); }

    const lampGeo = new THREE.CircleGeometry(0.26, 14);
    const lampMesh = buildInstanced(W, lampGeo, M.lamp, G.lamps, { name: 'apex-start-lamps' });
    const glowGeo = new THREE.PlaneGeometry(1.25, 1.25);
    const glowMesh = buildInstanced(W, glowGeo, M.glow, G.glow, { name: 'apex-start-glow' });
    if (lampMesh) { lightGroup.add(lampMesh); W.stats.drawCalls++; }
    if (glowMesh) { glowMesh.renderOrder = 5; lightGroup.add(glowMesh); W.stats.drawCalls++; }

    const lampLight = new THREE.PointLight(0xff2010, 0, 34, 2);
    _v0.setFromMatrixPosition(G.lamps.m[0] || _m0);
    lampLight.position.copy(_v0);
    lightGroup.add(lampLight);
    W.group.add(lightGroup);

    const RED = new THREE.Color(0xff2412);
    const DARK = new THREE.Color(0x0a0a0b);
    const OFFGLOW = new THREE.Color(0x000000);
    const ONGLOW = new THREE.Color(0x5a0d06);

    startLights = {
      group: lightGroup,
      count: 5,
      lit: 0,
      set: function (n) {
        try {
          const k = clamp(Math.round(n || 0), 0, 5);
          startLights.lit = k;
          if (lampMesh) {
            for (let c = 0; c < 5; c++) {
              for (let r = 0; r < 2; r++) {
                lampMesh.setColorAt(c * 2 + r, c < k ? RED : DARK);
              }
            }
            if (lampMesh.instanceColor) lampMesh.instanceColor.needsUpdate = true;
          }
          if (glowMesh) {
            for (let c = 0; c < 5; c++) {
              for (let r = 0; r < 2; r++) glowMesh.setColorAt(c * 2 + r, c < k ? ONGLOW : OFFGLOW);
            }
            if (glowMesh.instanceColor) glowMesh.instanceColor.needsUpdate = true;
          }
          lampLight.intensity = k * 14;
        } catch (e) { /* never throw at the lights */ }
      },
      off: function () { startLights.set(0); },
      blackout: function () { startLights.set(0); },
    };
    startLights.set(0);
  } catch (e) {
    startLights = null;
  }
  if (!startLights) {
    const g = new THREE.Group();
    startLights = { group: g, count: 5, lit: 0, set: function () {}, off: function () {}, blackout: function () {} };
    W.group.add(g);
  }

  /* --- debris fencing ----------------------------------------------------- */
  try {
    if (fencePanels.m.length) {
      const fg = new THREE.PlaneGeometry(4.0, 5.2, 1, 1);
      fg.rotateY(-Math.PI / 2);
      const uvAttr = fg.attributes.uv;
      for (let i = 0; i < uvAttr.count; i++) uvAttr.setXY(i, uvAttr.getX(i) * 2.6, uvAttr.getY(i) * 3.4);
      uvAttr.needsUpdate = true;
      const m = buildInstanced(W, fg, M.fence, fencePanels, { name: 'apex-fence' });
      if (m) { W.group.add(m); W.stats.drawCalls++; }
      const pg = new THREE.BoxGeometry(0.14, 6.4, 0.14);
      const pm = buildInstanced(W, pg, M.steel, fencePosts, { name: 'apex-fence-posts' });
      if (pm) { W.group.add(pm); W.stats.drawCalls++; }
    }
  } catch (e) { /* continue */ }

  /* --- crowd -------------------------------------------------------------- */
  let crowdMesh = null;
  let crowdTotal = 0;
  try {
    const seats = W.crowdSeats;
    crowdTotal = (seats.length / 3) | 0;
    if (crowdTotal > 0) {
      const order = new Int32Array(crowdTotal);
      for (let i = 0; i < crowdTotal; i++) order[i] = i;
      for (let i = crowdTotal - 1; i > 0; i--) {
        const j = Math.floor(W.rnd() * (i + 1));
        const t = order[i]; order[i] = order[j]; order[j] = t;
      }
      const hardCap = 16000;
      const want = Math.min(crowdTotal, hardCap);
      const coll = collector();
      coll.p = [];
      const shirts = [];
      for (let i = 0; i < TEAMS.length; i++) {
        shirts.push(new THREE.Color(TEAMS[i].colors.primary));
        shirts.push(new THREE.Color(TEAMS[i].colors.secondary));
      }
      const neutral = [0xd8d4cc, 0x8f949a, 0x2b2f36, 0xe8e2d4, 0x5b6470, 0xb04a3a, 0xf0f0f0];
      for (let n = 0; n < neutral.length; n++) shirts.push(new THREE.Color(neutral[n]));

      for (let k = 0; k < want; k++) {
        const idx = order[k];
        const x = seats[idx * 3], y = seats[idx * 3 + 1], z = seats[idx * 3 + 2];
        const sy = 0.86 + W.rnd() * 0.30;
        _v0.set(x, y, z);
        _q0.identity();
        _v4.set(sy, sy, sy);
        _m0.compose(_v0, _q0, _v4);
        coll.m.push(_m0.clone());
        const base = shirts[(W.rnd() * shirts.length) | 0];
        _col0.copy(base).offsetHSL((W.rnd() - 0.5) * 0.06, (W.rnd() - 0.5) * 0.22, (W.rnd() - 0.5) * 0.20);
        coll.c.push(_col0.clone());
        coll.p.push(W.rnd() * TAU);
      }
      const cg = new THREE.PlaneGeometry(0.52, 0.98);
      crowdMesh = buildInstanced(W, cg, M.crowd, coll, { name: 'apex-crowd', dynamic: false });
      if (crowdMesh) {
        crowdMesh.count = Math.max(1, Math.min(want, Math.round(want * Math.min(1, quality.crowd))));
        W.group.add(crowdMesh);
        W.stats.drawCalls++;
        W.stats.instances += crowdMesh.count;
      }
      W.crowdCapacity = want;
    }
  } catch (e) { crowdMesh = null; }
  W.crowdSeats.length = 0;

  /* --- billboards --------------------------------------------------------- */
  try {
    const BB = buildBillboards(W);
    if (BB.panels.m.length) {
      const bg = new THREE.PlaneGeometry(6.4, 2.4);
      bg.rotateY(-Math.PI / 2);
      const m = buildInstanced(W, bg, M.billboard, BB.panels, { name: 'apex-billboards', cast: false, receive: true });
      if (m) { W.group.add(m); W.stats.drawCalls++; }
      const lg = new THREE.BoxGeometry(0.14, 2.6, 0.14);
      const lm = buildInstanced(W, lg, M.steel, BB.legs, { name: 'apex-billboard-legs' });
      if (lm) { W.group.add(lm); W.stats.drawCalls++; }
    }
  } catch (e) { /* continue */ }

  /* --- trees -------------------------------------------------------------- */
  const treeMeshes = [];
  try {
    const TS = buildTrees(W, sceneryList);
    for (let i = 0; i < 3; i++) {
      if (!TS[i].m.length) continue;
      const p1 = new THREE.PlaneGeometry(1, 1);
      p1.translate(0, 0.5, 0);
      const p2 = p1.clone();
      p2.rotateY(Math.PI / 2);
      const card = mergeSafe([p1, p2]);
      if (!card) continue;
      const m = buildInstanced(W, card, M.trees[i], TS[i], { name: 'apex-trees-' + i, cast: quality.detail >= 2, receive: true });
      if (m) { W.group.add(m); W.stats.drawCalls++; treeMeshes.push({ mesh: m, total: TS[i].m.length }); }
    }
  } catch (e) { /* continue */ }

  /* --- hills -------------------------------------------------------------- */
  try {
    const H = buildHills(W);
    if (H && H.length) {
      const merged = mergeSafe(H);
      if (merged) {
        W.geoms.push(merged);
        const hm = new THREE.Mesh(merged, M.hill);
        hm.renderOrder = -2;
        reg(hm, { receive: false, cull: false });
      }
    }
  } catch (e) { /* continue */ }

  /* --- bridges ------------------------------------------------------------ */
  try {
    const BR = buildBridges(W);
    if (BR.length) {
      const merged = mergeSafe(BR);
      if (merged) { W.geoms.push(merged); reg(new THREE.Mesh(merged, M.structure), { cast: quality.shadows, receive: true }); }
    }
  } catch (e) { /* continue */ }

  /* --- marshal posts ------------------------------------------------------ */
  const marshalPosts = [];
  try {
    const MP = buildMarshalPosts(W);
    if (MP.huts.m.length) {
      const hut = [];
      pushBox(hut, 2.1, 2.4, 2.4, 0.9, 1.2, 0);
      pushBox(hut, 2.6, 0.18, 2.9, 0.9, 2.5, 0);
      pushBox(hut, 0.16, 1.05, 2.4, -0.2, 1.6, 0);
      const hg = mergeSafe(hut);
      if (hg) {
        const m = buildInstanced(W, hg, M.structure, MP.huts, { name: 'apex-marshal-huts', cast: quality.shadows, receive: true });
        if (m) { W.group.add(m); W.stats.drawCalls++; }
      }
      const pg = new THREE.CylinderGeometry(0.045, 0.055, 3.1, 6);
      const pm = buildInstanced(W, pg, M.steel, MP.poles, { name: 'apex-marshal-poles' });
      if (pm) { W.group.add(pm); W.stats.drawCalls++; }

      const fg = new THREE.PlaneGeometry(1.15, 0.78, 4, 1);
      fg.rotateY(-Math.PI / 2);
      fg.translate(0, 0, 0.575);
      const fm = buildInstanced(W, fg, M.flag, MP.flags, { name: 'apex-marshal-flags', dynamic: true });
      if (fm) {
        W.group.add(fm);
        W.stats.drawCalls++;
        const uvOff = fm.geometry.attributes.aUvOff;
        for (let i = 0; i < MP.records.length; i++) {
          const rec = MP.records[i];
          bindFlag(rec, i, fm, uvOff, W);
          marshalPosts.push(rec);
        }
        W.flagMesh = fm;
      }
    }
    W.marshalRecords = marshalPosts;
  } catch (e) { /* continue */ }

  /* --- braking boards ------------------------------------------------------ */
  try {
    const BM = buildBrakingBoards(W);
    if (BM.boards.m.length) {
      const bg = new THREE.PlaneGeometry(0.95, 0.95);
      bg.rotateY(-Math.PI / 2);
      const m = buildInstanced(W, bg, M.board, BM.boards, { name: 'apex-brake-boards', receive: true });
      if (m) { W.group.add(m); W.stats.drawCalls++; }
      const pg = new THREE.BoxGeometry(0.10, 1.5, 0.10);
      const pm = buildInstanced(W, pg, M.steel, BM.posts, { name: 'apex-brake-posts' });
      if (pm) { W.group.add(pm); W.stats.drawCalls++; }
    }
  } catch (e) { /* continue */ }

  /* --- track lighting ------------------------------------------------------ */
  try {
    const LP = buildLightPoles(W);
    if (LP.poles.m.length) {
      const pg = new THREE.CylinderGeometry(0.10, 0.19, 11.0, 7);
      const pm = buildInstanced(W, pg, M.steel, LP.poles, { name: 'apex-light-poles', cast: quality.shadows && quality.detail >= 2, receive: true });
      if (pm) { W.group.add(pm); W.stats.drawCalls++; }
      const hg = new THREE.BoxGeometry(1.5, 0.34, 0.75);
      hg.translate(-0.55, 0, 0);
      const hm = buildInstanced(W, hg, M.lampHead, LP.heads, { name: 'apex-light-heads' });
      if (hm) { W.group.add(hm); W.stats.drawCalls++; W.lightHeadMesh = hm; }
      W.polePositions = LP.positions;
      W.poleCount = LP.positions.length / 3;
    }
    const nLights = quality.pointLights;
    for (let i = 0; i < nLights; i++) {
      const pl = new THREE.PointLight(0xfff0d8, 0, 62, 2);
      pl.castShadow = false;
      pl.visible = false;
      W.group.add(pl);
      W.pointLights.push(pl);
    }
    W._lightDist = new Float32Array(Math.max(1, nLights));
    W._lightIdx = new Int32Array(Math.max(1, nLights));
  } catch (e) { /* continue */ }

  /* --- outline for the minimap -------------------------------------------- */
  const outline = [];
  try {
    const want = Math.min(512, F.count);
    const stride = Math.max(1, Math.floor(F.count / want));
    for (let i = 0; i < F.count; i += stride) outline.push({ x: F.pos[i * 3], z: F.pos[i * 3 + 2] });
  } catch (e) { /* empty outline */ }

  const world = assembleApi(W, {
    roadMesh: roadMesh,
    materials: {
      asphalt: M.asphalt, kerb: M.kerb, grass: M.grass,
      gravel: M.gravel, astro: M.astro, concrete: M.concrete,
    },
    allMaterials: M,
    startLights: startLights,
    marshalPosts: marshalPosts,
    outline: outline,
    gridSlots: gridSlots,
    startS: startS,
    crowdMesh: crowdMesh,
    crowdTotal: crowdTotal,
    treeMeshes: treeMeshes,
    textures: T,
  });

  try {
    world.setWetness(num(sharedWet.value, 0));
    world.setTimeOfDay(W.circuit.night ? 21.0 : 13.5);
  } catch (e) { /* continue */ }

  return world;
}

/* ===========================================================================
 * 15. Flag binding, public API assembly, disposal
 * ========================================================================= */

function bindFlag(rec, index, mesh, uvAttr, W) {
  const zero = new THREE.Matrix4();
  zero.copy(rec._base).scale(_v0.set(0.0001, 0.0001, 0.0001));
  rec._zero = zero;
  rec._color = new THREE.Color(0x000000);
  rec._index = index;
  rec.setFlag = function (kind) {
    try {
      const key = typeof kind === 'string' ? kind.toLowerCase().replace(/[\s_]/g, '') : 'none';
      const def = FLAG_KINDS[key] || FLAG_KINDS[kind] || FLAG_KINDS.none;
      rec.flag = key;
      rec._blink = def.blink || 0;
      rec._color.setHex(def.color);
      if (def.hidden) {
        mesh.setMatrixAt(index, rec._zero);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.setColorAt(index, rec._color);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        return;
      }
      mesh.setMatrixAt(index, rec._base);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.setColorAt(index, rec._color);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (uvAttr) {
        const cell = def.cell || 0;
        uvAttr.setXY(index, (cell % 2) * 0.5, cell < 2 ? 0.5 : 0.0);
        uvAttr.needsUpdate = true;
      }
    } catch (e) { /* never throw from a flag change */ }
  };
  rec.setFlag('none');
  W.blinkAny = true;
}

function inertWorld(W) {
  return {
    group: W.group,
    roadMesh: null,
    materials: { asphalt: null, kerb: null, grass: null, gravel: null, astro: null, concrete: null },
    startLights: { group: new THREE.Group(), count: 5, lit: 0, set: function () {}, off: function () {}, blackout: function () {} },
    marshalPosts: [],
    outline: [],
    gridSlots: [],
    uniforms: W.uniforms || {},
    stats: W.stats,
    setWetness: function () {},
    setTimeOfDay: function () {},
    setEnvMap: function () {},
    setQuality: function () {},
    sampleSurface: function (s, f, out) { return (out || new THREE.Vector3()).set(0, 0, 0); },
    update: function () {},
    dispose: function () {},
  };
}

function assembleApi(W, parts) {
  const F = W.frames;
  const M = parts.allMaterials;
  const NIGHT_TINT = new THREE.Color(0.46, 0.54, 0.78);
  const GOLD_TINT = new THREE.Color(1.14, 0.97, 0.80);
  const crowdBase = M.crowd && M.crowd.color ? M.crowd.color.clone() : new THREE.Color(1, 1, 1);
  const flagBase = M.flag && M.flag.color ? M.flag.color.clone() : new THREE.Color(1, 1, 1);
  const headDay = new THREE.Color(0x1a1c1f);
  const headNight = new THREE.Color(0xfff3d6);

  W.lightIntensity = 1500;
  W.nightActive = false;
  W.blinkNeedsUpload = false;

  function setWetness(v01) {
    try {
      const v = clamp(num(v01, 0), 0, 1);
      W.wetness = v;
      W.uniforms.wet.value = v;
      W.uniforms.ripple.value = smoothstep(0.30, 0.85, v);
      W.uniforms.rubber.value = lerp(1.0, 0.55, v);
      if (M.asphalt) {
        M.asphalt.envMapIntensity = lerp(0.32, 2.15, v);
        if (M.asphalt.normalScale) {
          const ns = lerp(1.0, 0.20, v);
          M.asphalt.normalScale.set(ns, ns);
        }
      }
      for (let i = 0; i < W.wettables.length; i++) {
        const e = W.wettables[i];
        if (!e.mat) continue;
        if (e.mat.color) {
          e.mat.color.copy(e.baseColor).multiplyScalar(lerp(1.0, e.darken, v));
        }
        if (typeof e.mat.roughness === 'number') {
          e.mat.roughness = lerp(e.baseRough, e.wetRough, v);
        }
        e.mat.envMapIntensity = lerp(e.baseEnv, e.envWet, v);
      }
    } catch (e) { /* keep going */ }
  }

  function setTimeOfDay(h) {
    try {
      const hour = ((num(h, 13) % 24) + 24) % 24;
      W.timeOfDay = hour;
      const dawn = 1 - smoothstep(4.9, 7.1, hour);
      const dusk = smoothstep(17.9, 20.4, hour);
      const night = clamp(dawn + dusk, 0, 1);
      const gold = Math.exp(-Math.pow(hour - 18.4, 2) / 1.6) + Math.exp(-Math.pow(hour - 6.6, 2) / 1.6);
      W.nightActive = night > 0.32 || W.circuit.night;

      _col1.set(1, 1, 1).lerp(NIGHT_TINT, night * 0.85);
      _col2.set(1, 1, 1).lerp(GOLD_TINT, clamp(gold, 0, 1) * 0.7);
      _col1.multiply(_col2);
      W.uniforms.tod.value.copy(_col1);

      const dim = lerp(1.0, 0.30, night);
      if (M.crowd) M.crowd.color.copy(crowdBase).multiplyScalar(dim);
      if (M.flag) M.flag.color.copy(flagBase).multiplyScalar(lerp(1.0, 0.55, night));
      W.uniforms.crowdAnim.value = lerp(1.0, 0.55, night);

      for (let i = 0; i < W.nightMats.length; i++) {
        const m = W.nightMats[i];
        if (m && typeof m.emissiveIntensity === 'number') m.emissiveIntensity = night * 1.15;
      }
      for (let i = 0; i < W.lightHeadMats.length; i++) {
        const m = W.lightHeadMats[i];
        if (m && m.color) m.color.copy(headDay).lerp(headNight, W.nightActive ? 1 : night);
      }
      if (W.lightHeadMesh) W.lightHeadMesh.visible = true;
      for (let i = 0; i < W.pointLights.length; i++) {
        W.pointLights[i].visible = W.nightActive;
        if (!W.nightActive) W.pointLights[i].intensity = 0;
      }
    } catch (e) { /* keep going */ }
  }

  function setEnvMap(env) {
    try {
      for (let i = 0; i < W.mats.length; i++) {
        const m = W.mats[i];
        if (m && m.isMeshStandardMaterial) { m.envMap = env || null; m.needsUpdate = true; }
      }
    } catch (e) { /* keep going */ }
  }

  function setQuality(q) {
    try {
      const nq = resolveQuality(q);
      W.quality.crowd = nq.crowd;
      W.quality.trees = nq.trees;
      W.quality.shadows = nq.shadows;
      W.quality.aniso = nq.aniso;
      W.quality.pointLights = nq.pointLights;
      W.quality.detail = nq.detail;

      if (parts.crowdMesh && W.crowdCapacity) {
        parts.crowdMesh.count = Math.max(1, Math.min(W.crowdCapacity, Math.round(W.crowdCapacity * Math.min(1, nq.crowd))));
        parts.crowdMesh.visible = nq.crowd > 0.02;
      }
      for (let i = 0; i < parts.treeMeshes.length; i++) {
        const t = parts.treeMeshes[i];
        t.mesh.count = Math.max(1, Math.min(t.total, Math.round(t.total * clamp(nq.trees, 0, 1.5))));
        t.mesh.visible = nq.trees > 0.02;
      }
      for (let i = 0; i < W.texes.length; i++) {
        const t = W.texes[i];
        if (t && t.anisotropy !== nq.aniso) { t.anisotropy = nq.aniso; t.needsUpdate = true; }
      }
      W.group.traverse(function (o) {
        if (!o.isMesh) return;
        if (o.receiveShadow !== undefined) o.receiveShadow = nq.shadows && o !== parts.crowdMesh;
        if (!nq.shadows) o.castShadow = false;
      });
      for (let i = 0; i < W.pointLights.length; i++) {
        if (i >= nq.pointLights) { W.pointLights[i].visible = false; W.pointLights[i].intensity = 0; }
      }
    } catch (e) { /* keep going */ }
  }

  function update(dt, camera) {
    if (W.disposed) return;
    let d = dt;
    if (!(d > 0)) d = 0;
    if (d > 0.25) d = 0.25;
    W.time += d;
    W.uniforms.time.value = W.time;

    // Flag blinking (double yellow, SC, VSC).
    const recs = W.marshalRecords;
    const fm = W.flagMesh;
    if (recs && fm) {
      let dirty = false;
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (!r._blink) continue;
        const rate = r._blink === 1 ? 3.2 : (r._blink === 2 ? 2.0 : 4.4);
        const k = 0.30 + 0.70 * (0.5 + 0.5 * Math.sin(W.time * rate * TAU));
        _col0.copy(r._color).multiplyScalar(k);
        fm.setColorAt(r._index, _col0);
        dirty = true;
      }
      if (dirty && fm.instanceColor) fm.instanceColor.needsUpdate = true;
    }

    // Follow the camera with the handful of real point lights.
    const lights = W.pointLights;
    if (lights.length && camera && camera.position && W.polePositions && W.poleCount > 0) {
      const K = lights.length;
      const bd = W._lightDist;
      const bi = W._lightIdx;
      for (let k = 0; k < K; k++) { bd[k] = Infinity; bi[k] = -1; }
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      const P = W.polePositions;
      const n = W.poleCount;
      for (let p = 0; p < n; p++) {
        const dx = P[p * 3] - cx, dy = P[p * 3 + 1] - cy, dz = P[p * 3 + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= bd[K - 1]) continue;
        let ins = K - 1;
        while (ins > 0 && bd[ins - 1] > d2) { bd[ins] = bd[ins - 1]; bi[ins] = bi[ins - 1]; ins--; }
        bd[ins] = d2; bi[ins] = p;
      }
      for (let k = 0; k < K; k++) {
        const light = lights[k];
        const idx = bi[k];
        if (idx < 0 || !W.nightActive || k >= W.quality.pointLights) {
          light.visible = false;
          light.intensity = 0;
          continue;
        }
        light.visible = true;
        light.position.set(P[idx * 3], P[idx * 3 + 1], P[idx * 3 + 2]);
        const dist = Math.sqrt(bd[k]);
        light.intensity = W.lightIntensity * clamp(1 - dist / 140, 0, 1);
      }
    }
  }

  function sampleSurface(s, f, out) {
    const target = out || new THREE.Vector3();
    try { surfacePoint(F, s, f, 0, target); } catch (e) { target.set(0, 0, 0); }
    return target;
  }

  function dispose() {
    if (W.disposed) return;
    W.disposed = true;
    try {
      W.group.traverse(function (o) {
        if (o.isMesh || o.isInstancedMesh) {
          if (o.geometry && o.geometry.dispose) { try { o.geometry.dispose(); } catch (e) { /* noop */ } }
        }
        if (o.isLight && o.dispose) { try { o.dispose(); } catch (e) { /* noop */ } }
      });
    } catch (e) { /* noop */ }
    for (let i = 0; i < W.geoms.length; i++) {
      try { if (W.geoms[i] && W.geoms[i].dispose) W.geoms[i].dispose(); } catch (e) { /* noop */ }
    }
    for (let i = 0; i < W.mats.length; i++) {
      try { if (W.mats[i] && W.mats[i].dispose) W.mats[i].dispose(); } catch (e) { /* noop */ }
    }
    for (let i = 0; i < W.texes.length; i++) {
      try { if (W.texes[i] && W.texes[i].dispose) W.texes[i].dispose(); } catch (e) { /* noop */ }
    }
    W.geoms.length = 0;
    W.mats.length = 0;
    W.texes.length = 0;
    W.wettables.length = 0;
    W.pointLights.length = 0;
    W.nightMats.length = 0;
    W.lightHeadMats.length = 0;
    if (W.marshalRecords) W.marshalRecords.length = 0;
    try {
      while (W.group.children.length) W.group.remove(W.group.children[W.group.children.length - 1]);
      if (W.group.parent) W.group.parent.remove(W.group);
    } catch (e) { /* noop */ }
    W.frames = null;
    W.polePositions = null;
  }

  return {
    group: W.group,
    roadMesh: parts.roadMesh,
    materials: parts.materials,
    startLights: parts.startLights,
    marshalPosts: parts.marshalPosts,
    outline: parts.outline,

    setWetness: setWetness,
    setTimeOfDay: setTimeOfDay,
    update: update,
    dispose: dispose,
    setQuality: setQuality,

    // Extras — safe for the integrator to use, not required by the contract.
    setEnvMap: setEnvMap,
    sampleSurface: sampleSurface,
    uniforms: W.uniforms,
    frames: F,
    gridSlots: parts.gridSlots,
    startS: parts.startS,
    stats: W.stats,
    crowd: parts.crowdMesh,
    quality: W.quality,
    get wetness() { return W.wetness; },
    get timeOfDay() { return W.timeOfDay; },
    get isNight() { return W.nightActive; },
  };
}

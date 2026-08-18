/**
 * APEX F1 — src/render/driver.js
 * ---------------------------------------------------------------------------
 * A fully procedural, visible driver figure for the cockpit: sculpted modern F1
 * helmet (lathe + displacement), smoked iridescent visor with tear-off, aero
 * crown ridge, chin intake, HANS anchors, balaclava + fireproof race suit with
 * team livery, invented sponsor patches and stitched seams, a 6-point harness
 * with metal buckles, two-bone IK arms in gloves gripping a rectangular modern
 * F1 steering wheel (carbon rim, emissive LCD + shift-light strip, rotary
 * dials, coloured buttons, shift/clutch paddles).
 *
 * Group origin sits at the SEAT BASE so the whole rig can be parented straight
 * onto carModel's `cockpitAnchor`. Car forward is +Z, Y up (see ARCHITECTURE).
 *
 * Zero side effects at import time. Only imports: three, three/addons.
 * No network access — every texture is drawn into a 2D canvas at init.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ===========================================================================
 * Module-scope scratch. NEVER allocate inside update().
 * =========================================================================== */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

/* init-time scratch (kept separate so builders can nest safely) */
const _i1 = new THREE.Vector3();
const _i2 = new THREE.Vector3();
const _i3 = new THREE.Vector3();
const _i4 = new THREE.Vector3();
const _i5 = new THREE.Vector3();
const _i6 = new THREE.Vector3();
const _i7 = new THREE.Vector3();

/* ===========================================================================
 * Tiny math helpers
 * =========================================================================== */
function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  if (!Number.isFinite(t)) t = 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return t * t * (3 - 2 * t);
}
function gauss(t) { return Math.exp(-t * t); }
function hashStr(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** table = [[x,y], ...] ascending in x; smooth piecewise interpolation. */
function tableLerp(table, x) {
  const n = table.length;
  if (n === 0) return 0;
  if (x <= table[0][0]) return table[0][1];
  if (x >= table[n - 1][0]) return table[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (x <= table[i][0]) {
      const a = table[i - 1], b = table[i];
      const t = (x - a[0]) / (b[0] - a[0] || 1);
      return lerp(a[1], b[1], t * t * (3 - 2 * t));
    }
  }
  return table[n - 1][1];
}
/** signed power — used for superelliptic (boxy) cross sections. */
function spow(v, p) { return v < 0 ? -Math.pow(-v, p) : Math.pow(v, p); }

function safeHex(c, fallback) {
  if (typeof c !== 'string' || c.length < 4) return fallback;
  try { _c1.set(c); return c; } catch (e) { return fallback; }
}
function shadeHex(hex, amount) {
  try {
    _c1.set(hex);
    if (amount >= 0) { _c2.setRGB(1, 1, 1); _c1.lerp(_c2, amount); }
    else { _c2.setRGB(0, 0, 0); _c1.lerp(_c2, -amount); }
    return '#' + _c1.getHexString();
  } catch (e) { return hex; }
}
function mixHex(a, b, t) {
  try { _c1.set(a); _c2.set(b); _c1.lerp(_c2, clamp(t, 0, 1)); return '#' + _c1.getHexString(); }
  catch (e) { return a; }
}
function luminance(hex) {
  try { _c1.set(hex); return 0.2126 * _c1.r + 0.7152 * _c1.g + 0.0722 * _c1.b; }
  catch (e) { return 0.5; }
}
function inkOn(hex) { return luminance(hex) > 0.22 ? '#0b0b0d' : '#f4f6f8'; }

/* ===========================================================================
 * Quality tiers
 * =========================================================================== */
const TIER_RANK = { low: 0, medium: 1, high: 2, ultra: 3 };

const DETAIL = {
  low: {
    helmetSeg: 30, helmetRows: 1, helmetTex: 512, suitTex: 512, sleeveTex: 256,
    armRadial: 7, armTube: 6, visorU: 16, visorV: 5, beltRadial: 5, beltLong: 10,
    torsoU: 22, torsoV: 16, dials: 3, buttons: 6, extras: false, weave: 128,
    faceTex: 512, lcdW: 256, lcdH: 134, fingerSeg: 6, iridescence: 0,
  },
  medium: {
    helmetSeg: 44, helmetRows: 2, helmetTex: 1024, suitTex: 1024, sleeveTex: 512,
    armRadial: 9, armTube: 8, visorU: 22, visorV: 6, beltRadial: 6, beltLong: 14,
    torsoU: 30, torsoV: 22, dials: 5, buttons: 9, extras: true, weave: 256,
    faceTex: 1024, lcdW: 320, lcdH: 168, fingerSeg: 8, iridescence: 0.35,
  },
  high: {
    helmetSeg: 60, helmetRows: 3, helmetTex: 1024, suitTex: 1024, sleeveTex: 512,
    armRadial: 11, armTube: 10, visorU: 30, visorV: 8, beltRadial: 7, beltLong: 18,
    torsoU: 40, torsoV: 30, dials: 5, buttons: 11, extras: true, weave: 256,
    faceTex: 1024, lcdW: 320, lcdH: 168, fingerSeg: 10, iridescence: 0.5,
  },
  ultra: {
    helmetSeg: 80, helmetRows: 4, helmetTex: 2048, suitTex: 2048, sleeveTex: 1024,
    armRadial: 14, armTube: 12, visorU: 40, visorV: 10, beltRadial: 8, beltLong: 24,
    torsoU: 52, torsoV: 40, dials: 5, buttons: 11, extras: true, weave: 512,
    faceTex: 2048, lcdW: 384, lcdH: 200, fingerSeg: 12, iridescence: 0.62,
  },
};

function normalizeQuality(q) {
  const tier = (q && typeof q.tier === 'string' && TIER_RANK[q.tier] !== undefined) ? q.tier : 'high';
  return {
    tier,
    rank: TIER_RANK[tier],
    anisotropy: Math.max(1, Math.min(16, (q && Number(q.anisotropy)) || 4)),
    shadows: q ? q.shadows !== false : true,
    detail: DETAIL[tier],
  };
}

/* ===========================================================================
 * Canvas + texture plumbing (procedural only, cached & ref-counted)
 * =========================================================================== */
const _texCache = new Map();

function makeCanvas(w, h) {
  try {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = Math.max(1, w | 0);
      c.height = Math.max(1, h | 0);
      return c;
    }
  } catch (e) { /* fall through */ }
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0));
  } catch (e) { /* fall through */ }
  return null;
}

function ctx2d(canvas) {
  if (!canvas) return null;
  try { return canvas.getContext('2d'); } catch (e) { return null; }
}

function makeTexture(canvas, opts) {
  if (!canvas) return null;
  try {
    const o = opts || {};
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = o.data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = o.wrapS || THREE.ClampToEdgeWrapping;
    t.wrapT = o.wrapT || THREE.ClampToEdgeWrapping;
    if (o.repeat) t.repeat.set(o.repeat[0], o.repeat[1]);
    t.anisotropy = o.anisotropy || 1;
    t.generateMipmaps = o.mipmaps !== false;
    t.minFilter = o.mipmaps === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    t.magFilter = o.nearest ? THREE.NearestFilter : THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  } catch (e) { return null; }
}

/** Shared textures (carbon weave, fabric normal…) are cached + ref counted. */
function acquireShared(key, factory) {
  let entry = _texCache.get(key);
  if (!entry) {
    let tex = null;
    try { tex = factory(); } catch (e) { tex = null; }
    if (!tex) return null;
    tex.userData.__apexCacheKey = key;
    entry = { tex, refs: 0 };
    _texCache.set(key, entry);
  }
  entry.refs++;
  return entry.tex;
}

function releaseTexture(tex) {
  if (!tex) return;
  const key = tex.userData && tex.userData.__apexCacheKey;
  if (key) {
    const entry = _texCache.get(key);
    if (entry) {
      entry.refs--;
      if (entry.refs <= 0) { try { entry.tex.dispose(); } catch (e) {} _texCache.delete(key); }
      return;
    }
  }
  try { tex.dispose(); } catch (e) {}
}

/** Draw callback three times so anything crossing u=0/1 wraps seamlessly. */
function drawWrapped(g, width, fn) {
  for (let k = -1; k <= 1; k++) {
    g.save();
    g.translate(k * width, 0);
    try { fn(k); } catch (e) { /* keep going */ }
    g.restore();
  }
}

function roundRectPath(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(Math.abs(w), Math.abs(h)) * 0.5));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

const FONT_STACK = '"Arial Narrow", "Helvetica Neue", Arial, Helvetica, sans-serif';
const FONT_MONO = '"DIN Alternate", "Roboto Mono", "Courier New", monospace';

/** Fit text into maxW by shrinking the font. Returns the px size actually used. */
function fitText(g, text, maxW, startPx, weight, family) {
  let px = startPx;
  const fam = family || FONT_STACK;
  const w = weight || '700';
  for (let i = 0; i < 26; i++) {
    g.font = w + ' ' + px.toFixed(1) + 'px ' + fam;
    if (g.measureText(text).width <= maxW || px <= 5) break;
    px *= 0.92;
  }
  return px;
}

function drawFittedText(g, text, cx, cy, maxW, startPx, color, weight, family, letterSpace) {
  g.save();
  fitText(g, text, maxW, startPx, weight, family);
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (letterSpace && typeof g.letterSpacing === 'string') {
    try { g.letterSpacing = letterSpace + 'px'; } catch (e) {}
  }
  g.fillText(text, cx, cy);
  g.restore();
}

/** Speckled metallic-flake / noise overlay. */
function speckle(g, w, h, count, alpha, color) {
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = color;
  let seed = 0x9e3779b9;
  for (let i = 0; i < count; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const x = (seed / 4294967296) * w;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const y = (seed / 4294967296) * h;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const s = 0.5 + (seed / 4294967296) * 1.6;
    g.fillRect(x, y, s, s);
  }
  g.restore();
}

/** Dashed "stitched seam" line. */
function stitchLine(g, x0, y0, x1, y1, color, dash, width) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = width || 2;
  g.lineCap = 'butt';
  if (g.setLineDash) g.setLineDash([dash || 6, (dash || 6) * 0.85]);
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
  if (g.setLineDash) g.setLineDash([]);
  g.restore();
}

/* ===========================================================================
 * Geometry construction helpers
 * =========================================================================== */

/**
 * Generic parametric surface builder. fn(u, v, outVec3).
 * Winding gives outward normals when dU x dV points outward.
 */
function buildSurface(uSegs, vSegs, fn, opts) {
  const o = opts || {};
  const uCount = uSegs + 1;
  const vCount = vSegs + 1;
  const total = uCount * vCount;
  const pos = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const idx = new Uint32Array(uSegs * vSegs * 6);
  const p = _i7;
  for (let i = 0; i < uCount; i++) {
    const u = i / uSegs;
    for (let j = 0; j < vCount; j++) {
      const v = j / vSegs;
      p.set(0, 0, 0);
      fn(u, v, p);
      const k = i * vCount + j;
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      uv[k * 2] = o.uOffset !== undefined ? (u * (o.uScale || 1) + o.uOffset) : u;
      uv[k * 2 + 1] = o.vOffset !== undefined ? (v * (o.vScale || 1) + o.vOffset) : v;
    }
  }
  let t = 0;
  const flip = !!o.flip;
  for (let i = 0; i < uSegs; i++) {
    for (let j = 0; j < vSegs; j++) {
      const a = i * vCount + j;
      const b = a + vCount;
      const c = b + 1;
      const d = a + 1;
      if (flip) { idx[t++] = a; idx[t++] = d; idx[t++] = b; idx[t++] = b; idx[t++] = d; idx[t++] = c; }
      else { idx[t++] = a; idx[t++] = b; idx[t++] = d; idx[t++] = b; idx[t++] = c; idx[t++] = d; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  if (o.weldU) weldColumns(g, uSegs, vCount);
  g.computeBoundingSphere();
  return g;
}

/** Average the normals of the first/last u columns of a buildSurface() grid. */
function weldColumns(geom, uSegs, vCount) {
  const n = geom.getAttribute('normal');
  if (!n) return;
  const arr = n.array;
  const last = uSegs * vCount;
  for (let j = 0; j < vCount; j++) {
    const a = j * 3;
    const b = (last + j) * 3;
    const nx = arr[a] + arr[b], ny = arr[a + 1] + arr[b + 1], nz = arr[a + 2] + arr[b + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    arr[a] = arr[b] = nx / l;
    arr[a + 1] = arr[b + 1] = ny / l;
    arr[a + 2] = arr[b + 2] = nz / l;
  }
  n.needsUpdate = true;
}

/** Average the normals of the first/last meridian of a full LatheGeometry. */
function weldLatheSeam(geom, segments, pointCount) {
  const n = geom.getAttribute('normal');
  if (!n) return;
  const arr = n.array;
  const last = segments * pointCount;
  for (let j = 0; j < pointCount; j++) {
    const a = j * 3;
    const b = (last + j) * 3;
    const nx = arr[a] + arr[b], ny = arr[a + 1] + arr[b + 1], nz = arr[a + 2] + arr[b + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    arr[a] = arr[b] = nx / l;
    arr[a + 1] = arr[b + 1] = ny / l;
    arr[a + 2] = arr[b + 2] = nz / l;
  }
  n.needsUpdate = true;
}

/**
 * Swept tube along a sampled centreline with an elliptical / superelliptic
 * cross section. sample(t, outPos) plus a stable frame from an up-hint.
 */
function buildSweep(sample, frameUp, tSegs, radialSegs, halfW, halfH, squash, opts) {
  const o = opts || {};
  const P = _i1, Pa = _i2, Pb = _i3, T = _i4, N = _i5, B = _i6;
  const capStart = !!o.capStart;
  const capEnd = !!o.capEnd;
  return buildSurface(tSegs, radialSegs, (u, v, out) => {
    const eps = 1e-3;
    sample(Math.min(1, u + eps), Pa);
    sample(Math.max(0, u - eps), Pb);
    T.subVectors(Pa, Pb);
    if (T.lengthSq() < 1e-12) T.set(0, 1, 0);
    T.normalize();
    sample(u, P);
    N.copy(frameUp);
    N.addScaledVector(T, -N.dot(T));
    if (N.lengthSq() < 1e-10) { N.set(T.y, -T.x, 0); if (N.lengthSq() < 1e-10) N.set(1, 0, 0); }
    N.normalize();
    B.crossVectors(T, N).normalize();
    let a = halfW(u), b = halfH(u);
    if (capStart && u < 0.001) { a *= 0.02; b *= 0.02; }
    if (capEnd && u > 0.999) { a *= 0.02; b *= 0.02; }
    const th = v * Math.PI * 2;
    const cs = Math.cos(th), sn = Math.sin(th);
    const e = squash || 1;
    const ca = e === 1 ? cs : spow(cs, e);
    const sa = e === 1 ? sn : spow(sn, e);
    out.copy(P).addScaledVector(B, ca * a).addScaledVector(N, sa * b);
  }, { weldU: false, flip: !!o.flip });
}

/** Merge a list of geometries, tagging each with a flat vertex colour. */
function mergeColored(list) {
  const prepared = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const g = entry.geo;
    if (!g) continue;
    if (!g.getAttribute('uv')) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const count = g.getAttribute('position').count;
    const col = new Float32Array(count * 3);
    _c1.set(entry.color || '#ffffff');
    for (let k = 0; k < count; k++) { col[k * 3] = _c1.r; col[k * 3 + 1] = _c1.g; col[k * 3 + 2] = _c1.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!g.index) {
      const n = count;
      const idx = new Uint32Array(n);
      for (let k = 0; k < n; k++) idx[k] = k;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    prepared.push(g);
  }
  if (prepared.length === 0) return null;
  let merged = null;
  try { merged = mergeGeometries(prepared, false); } catch (e) { merged = null; }
  for (let i = 0; i < prepared.length; i++) {
    if (prepared[i] !== merged) { try { prepared[i].dispose(); } catch (e) {} }
  }
  return merged;
}

/** Merge geometries that all share one material (no vertex colours). */
function mergePlain(list) {
  const prepared = [];
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (!g) continue;
    if (!g.getAttribute('uv')) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.index) {
      const n = g.getAttribute('position').count;
      const idx = new Uint32Array(n);
      for (let k = 0; k < n; k++) idx[k] = k;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    prepared.push(g);
  }
  if (!prepared.length) return null;
  let merged = null;
  try { merged = mergeGeometries(prepared, false); } catch (e) { merged = null; }
  for (let i = 0; i < prepared.length; i++) {
    if (prepared[i] !== merged) { try { prepared[i].dispose(); } catch (e) {} }
  }
  return merged;
}

/** Rounded rectangle THREE.Shape helper. */
function roundedRectShape(hw, hh, r) {
  const s = new THREE.Shape();
  const rr = Math.min(r, Math.min(hw, hh) * 0.9);
  s.moveTo(-hw + rr, -hh);
  s.lineTo(hw - rr, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + rr);
  s.lineTo(hw, hh - rr);
  s.quadraticCurveTo(hw, hh, hw - rr, hh);
  s.lineTo(-hw + rr, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - rr);
  s.lineTo(-hw, -hh + rr);
  s.quadraticCurveTo(-hw, -hh, -hw + rr, -hh);
  return s;
}

/* ===========================================================================
 * HELMET FORM — shared profile + analytic sculpted surface.
 * The lathe profile is (radius, height) with height 0 at the neck opening.
 * =========================================================================== */
const HELMET_PROFILE = [
  [0.0930, 0.000], [0.1040, 0.012], [0.1130, 0.030], [0.1200, 0.055],
  [0.1240, 0.085], [0.1245, 0.115], [0.1225, 0.145], [0.1170, 0.175],
  [0.1080, 0.200], [0.0940, 0.222], [0.0750, 0.240], [0.0520, 0.252],
  [0.0260, 0.259], [0.0060, 0.262],
];
const HELMET_ROWS = HELMET_PROFILE.length;
const HELMET_TOP = HELMET_PROFILE[HELMET_ROWS - 1][1];
const HELMET_DEPTH_SCALE = 1.085;
const APERTURE_HALF_ANGLE = 1.24;
const APERTURE_Y = 0.127;
const APERTURE_HALF_H = 0.049;

/** Lathe radius at a given profile height. */
function helmetRAtY(y) {
  if (y <= HELMET_PROFILE[0][1]) return HELMET_PROFILE[0][0];
  if (y >= HELMET_TOP) return HELMET_PROFILE[HELMET_ROWS - 1][0];
  for (let i = 1; i < HELMET_ROWS; i++) {
    if (y <= HELMET_PROFILE[i][1]) {
      const a = HELMET_PROFILE[i - 1], b = HELMET_PROFILE[i];
      const t = (y - a[1]) / (b[1] - a[1] || 1);
      return lerp(a[0], b[0], t);
    }
  }
  return HELMET_PROFILE[HELMET_ROWS - 1][0];
}

/** Lathe "v" texture coordinate at a given profile height. */
function helmetVAtY(y) {
  if (y <= HELMET_PROFILE[0][1]) return 0;
  if (y >= HELMET_TOP) return 1;
  for (let i = 1; i < HELMET_ROWS; i++) {
    if (y <= HELMET_PROFILE[i][1]) {
      const a = HELMET_PROFILE[i - 1], b = HELMET_PROFILE[i];
      const t = (y - a[1]) / (b[1] - a[1] || 1);
      return (i - 1 + t) / (HELMET_ROWS - 1);
    }
  }
  return 1;
}

/** phi = 0 at the front (+Z), +/-PI at the back. Matches LatheGeometry ordering. */
function helmetUAtPhi(phi) {
  let p = phi;
  while (p > Math.PI) p -= Math.PI * 2;
  while (p < -Math.PI) p += Math.PI * 2;
  return (p + Math.PI) / (Math.PI * 2);
}

/**
 * The single source of truth for the helmet shell shape. Everything attached to
 * the shell (vents, HANS tabs, ridge, visor) is placed through this function so
 * nothing ever floats off the surface.
 */
function helmetSurface(phi, y0, out, recessScale) {
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const front = Math.max(0, cp);
  const back = Math.max(0, -cp);
  const sideAbs = Math.abs(sp);
  let r = helmetRAtY(y0);
  let y = y0;

  /* recessed visor aperture (superelliptic, boxy) */
  const ta = Math.abs(phi) / APERTURE_HALF_ANGLE;
  const tb = Math.abs(y0 - APERTURE_Y) / APERTURE_HALF_H;
  const ta3 = ta * ta * ta, tb3 = tb * tb * tb;
  const d = Math.pow(ta3 * ta3 + tb3 * tb3, 1 / 6);
  r -= smoothstep(1.02, 0.86, d) * 0.0085 * (recessScale === undefined ? 1 : recessScale);

  /* brow ridge above the aperture + lower aperture lip */
  r += 0.0028 * front * gauss((y0 - 0.181) / 0.019);
  r += 0.0024 * front * gauss((y0 - 0.073) / 0.017);

  /* flattened temple / ear panel */
  r *= 1 - 0.045 * sideAbs * gauss((y0 - 0.105) / 0.058);

  let x = r * sp;
  let z = r * cp * HELMET_DEPTH_SCALE;

  /* chin bar juts forward and drops */
  const chin = front * front * gauss((y0 - 0.052) / 0.062);
  z += 0.030 * chin;
  y -= 0.011 * chin;

  /* rear occipital extension */
  z -= 0.013 * back * gauss((y0 - 0.168) / 0.078);

  /* neck cut-out: the rear/side of the bottom edge rides much higher */
  y += 0.036 * back * Math.sqrt(back) * smoothstep(0.078, 0.0, y0);
  y += 0.017 * sideAbs * smoothstep(0.058, 0.0, y0);

  /* jaw narrows toward the chin */
  x *= 1 - 0.065 * smoothstep(0.078, 0.0, y0);

  out.set(x, y, z);
  return out;
}

/** Outward normal of the sculpted shell via central differences. */
function helmetNormal(phi, y, out, recessScale) {
  const dp = 0.02, dy = 0.004;
  helmetSurface(phi + dp, y, _i1, recessScale);
  helmetSurface(phi - dp, y, _i2, recessScale);
  helmetSurface(phi, Math.min(HELMET_TOP - 1e-4, y + dy), _i3, recessScale);
  helmetSurface(phi, Math.max(0, y - dy), _i4, recessScale);
  _i1.sub(_i2);
  _i3.sub(_i4);
  out.crossVectors(_i1, _i3);
  if (out.lengthSq() < 1e-12) out.set(Math.sin(phi), 0.2, Math.cos(phi));
  return out.normalize();
}

/* ===========================================================================
 * HELMET PAINT — every driver gets a recognisably different scheme.
 * u wraps the helmet (0 = back seam, 0.5 = front), v runs neck -> crown.
 * =========================================================================== */
function paintHelmet(size, driver, team, sponsors) {
  const W = size;
  const H = size >> 1;
  const cv = makeCanvas(W, H);
  const g = ctx2d(cv);
  if (!g) return null;

  const hb = driver.helmet || {};
  const tc = (team && team.colors) || {};
  const base = safeHex(hb.base, safeHex(tc.primary, '#1b2440'));
  const stripe = safeHex(hb.stripe, safeHex(tc.accent, '#f2c53d'));
  const dark = safeHex(hb.visor, '#141414');
  const trim = safeHex(tc.trim, '#ffffff');
  const accent = safeHex(tc.accent, stripe);
  const secondary = safeHex(tc.secondary, dark);
  const ink = inkOn(base);
  const scheme = hashStr(String(driver.short || driver.name || 'x') + '|' +
    (driver.num || 0) + '|' + stripe) % 8;
  const seedB = hashStr('b' + (driver.short || driver.name || 'x'));

  const X = (u) => u * W;
  const Y = (v) => (1 - v) * H;

  g.fillStyle = base;
  g.fillRect(0, 0, W, H);

  /* ---- meridian band: reads as a stripe running front -> over crown -> back */
  function meridian(uc, halfW0, halfW1, color, v0, v1) {
    drawWrapped(g, W, () => {
      g.fillStyle = color;
      g.beginPath();
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const v = lerp(v0, v1, t);
        const hw = lerp(halfW0, halfW1, t);
        const px = X(uc - hw);
        if (i === 0) g.moveTo(px, Y(v)); else g.lineTo(px, Y(v));
      }
      for (let i = steps; i >= 0; i--) {
        const t = i / steps;
        const v = lerp(v0, v1, t);
        const hw = lerp(halfW0, halfW1, t);
        g.lineTo(X(uc + hw), Y(v));
      }
      g.closePath();
      g.fill();
    });
  }
  function ring(v0, v1, color) {
    g.fillStyle = color;
    g.fillRect(0, Y(v1), W, Y(v0) - Y(v1));
  }
  function ringChecker(v0, v1, cells, ca, cb) {
    const top = Y(v1), hgt = Y(v0) - Y(v1);
    const cw = W / cells;
    for (let i = 0; i < cells; i++) {
      g.fillStyle = (i & 1) ? cb : ca;
      g.fillRect(i * cw, top, cw + 1, hgt * 0.5);
      g.fillStyle = (i & 1) ? ca : cb;
      g.fillRect(i * cw, top + hgt * 0.5, cw + 1, hgt * 0.5 + 1);
    }
  }
  function rays(count, v0, v1, color, width) {
    for (let i = 0; i < count; i++) {
      const uc = i / count;
      meridian(uc, width * 0.35, width, color, v1, v0);
    }
  }
  function blade(uc, color, dir) {
    drawWrapped(g, W, () => {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(X(uc - 0.075 * dir), Y(0.06));
      g.quadraticCurveTo(X(uc + 0.02 * dir), Y(0.35), X(uc + 0.11 * dir), Y(0.62));
      g.lineTo(X(uc + 0.185 * dir), Y(0.62));
      g.quadraticCurveTo(X(uc + 0.075 * dir), Y(0.32), X(uc + 0.045 * dir), Y(0.06));
      g.closePath();
      g.fill();
    });
  }

  switch (scheme) {
    case 0: /* classic crown stripe, front + back, with pinstripes */
      meridian(0.5, 0.075, 0.135, stripe, 0.0, 1.0);
      meridian(0.0, 0.075, 0.135, stripe, 0.0, 1.0);
      meridian(0.5, 0.020, 0.036, trim, 0.0, 1.0);
      meridian(0.0, 0.020, 0.036, trim, 0.0, 1.0);
      ring(0.0, 0.085, secondary);
      break;
    case 1: /* twin side blades */
      blade(0.235, stripe, 1);
      blade(0.765, stripe, -1);
      ring(0.86, 1.0, stripe);
      ring(0.83, 0.86, trim);
      break;
    case 2: /* chequered crown band */
      ringChecker(0.60, 0.80, 22, stripe, base);
      ring(0.80, 1.0, stripe);
      ring(0.56, 0.60, trim);
      ring(0.0, 0.09, secondary);
      break;
    case 3: /* halo band + converging crown rays */
      rays(10, 0.62, 1.0, stripe, 0.028);
      ring(0.46, 0.56, stripe);
      ring(0.43, 0.46, trim);
      ring(0.56, 0.585, trim);
      break;
    case 4: /* split: front half base, rear half stripe, diagonal join */
      drawWrapped(g, W, () => {
        g.fillStyle = stripe;
        g.beginPath();
        g.moveTo(X(0.72), Y(0.0));
        g.lineTo(X(1.28), Y(0.0));
        g.lineTo(X(1.20), Y(1.0));
        g.lineTo(X(0.80), Y(1.0));
        g.closePath();
        g.fill();
        g.fillStyle = trim;
        g.fillRect(X(0.715), 0, W * 0.012, H);
        g.fillRect(X(1.272), 0, W * 0.012, H);
      });
      break;
    case 5: /* chevron stack on both flanks */
      for (let i = 0; i < 5; i++) {
        const v = 0.20 + i * 0.145;
        const col = (i & 1) ? trim : stripe;
        drawWrapped(g, W, () => {
          g.strokeStyle = col;
          g.lineWidth = H * 0.045;
          g.lineJoin = 'round';
          g.beginPath();
          g.moveTo(X(0.10), Y(v - 0.075));
          g.lineTo(X(0.25), Y(v));
          g.lineTo(X(0.40), Y(v - 0.075));
          g.stroke();
          g.beginPath();
          g.moveTo(X(0.60), Y(v - 0.075));
          g.lineTo(X(0.75), Y(v));
          g.lineTo(X(0.90), Y(v - 0.075));
          g.stroke();
        });
      }
      break;
    case 6: /* gradient fade crown -> base with speckle */
      {
        const grad = g.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, stripe);
        grad.addColorStop(0.55, mixHex(stripe, base, 0.65));
        grad.addColorStop(1, base);
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
        speckle(g, W, H, Math.round(W * 3), 0.10, trim);
        ring(0.0, 0.10, secondary);
      }
      break;
    default: /* 7: wide arrow / delta over the crown */
      meridian(0.5, 0.16, 0.05, stripe, 0.30, 1.0);
      meridian(0.0, 0.05, 0.16, stripe, 0.30, 1.0);
      ring(0.24, 0.30, stripe);
      ring(0.215, 0.24, trim);
      ring(0.0, 0.10, secondary);
      break;
  }

  /* ---- a second accent hairline that ties every scheme to the team ---- */
  ring(0.155, 0.175, mixHex(accent, base, 0.15));

  /* ---- shell shading: crown highlight + jaw occlusion (baked micro-AO) ---- */
  g.save();
  g.globalCompositeOperation = 'multiply';
  const shGrad = g.createLinearGradient(0, 0, 0, H);
  shGrad.addColorStop(0.0, '#ffffff');
  shGrad.addColorStop(0.62, '#f2f2f2');
  shGrad.addColorStop(0.88, '#c9c9c9');
  shGrad.addColorStop(1.0, '#8f8f8f');
  g.fillStyle = shGrad;
  g.fillRect(0, 0, W, H);
  g.restore();

  g.save();
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = 0.13;
  const hi = g.createRadialGradient(W * 0.5, H * 0.18, 1, W * 0.5, H * 0.18, W * 0.30);
  hi.addColorStop(0, '#ffffff');
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hi;
  g.fillRect(0, 0, W, H);
  g.restore();

  /* ---- metallic flake ---- */
  speckle(g, W, H, Math.round(W * 1.5), 0.05, '#ffffff');

  /* ---- visor aperture: black recess + rubber gasket ---- */
  const au0 = helmetUAtPhi(-APERTURE_HALF_ANGLE);
  const au1 = helmetUAtPhi(APERTURE_HALF_ANGLE);
  const av0 = helmetVAtY(APERTURE_Y - APERTURE_HALF_H);
  const av1 = helmetVAtY(APERTURE_Y + APERTURE_HALF_H);
  const ax = X(au0), aw = X(au1) - X(au0);
  const ay = Y(av1), ah = Y(av0) - Y(av1);
  g.save();
  g.fillStyle = '#0a0a0c';
  roundRectPath(g, ax, ay, aw, ah, ah * 0.42);
  g.fill();
  g.strokeStyle = '#232326';
  g.lineWidth = Math.max(2, H * 0.012);
  roundRectPath(g, ax - g.lineWidth * 0.5, ay - g.lineWidth * 0.5, aw + g.lineWidth, ah + g.lineWidth, ah * 0.45);
  g.stroke();
  g.restore();

  /* ---- chin band + intake surround ---- */
  g.save();
  g.fillStyle = mixHex(secondary, '#101010', 0.45);
  roundRectPath(g, X(0.40), Y(helmetVAtY(0.062)), X(0.60) - X(0.40), Y(helmetVAtY(0.004)) - Y(helmetVAtY(0.062)), H * 0.03);
  g.fill();
  g.restore();

  /* ---- rear exhaust vent marks ---- */
  drawWrapped(g, W, () => {
    g.fillStyle = 'rgba(8,8,10,0.85)';
    for (let i = 0; i < 3; i++) {
      const vy = Y(0.50 + i * 0.055);
      roundRectPath(g, X(-0.055), vy, W * 0.11, H * 0.022, H * 0.011);
      g.fill();
    }
  });

  /* ---- driver number, large, on the rear quarter (crosses the seam) ---- */
  const num = String(driver.num !== undefined ? driver.num : '');
  if (num) {
    drawWrapped(g, W, () => {
      g.save();
      g.translate(X(0.0), Y(0.40));
      const numMax = W * 0.16;
      fitText(g, num, numMax, H * 0.30, '800', FONT_STACK);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = Math.max(3, H * 0.016);
      g.strokeStyle = inkOn(stripe) === '#0b0b0d' ? '#0b0b0d' : '#101010';
      g.fillStyle = trim;
      g.strokeText(num, 0, 0);
      g.fillText(num, 0, 0);
      g.restore();
    });
  }

  /* ---- team wordmark on both flanks ---- */
  const mark = String((team && (team.short || team.name)) || 'APEX').toUpperCase();
  for (const uc of [0.255, 0.745]) {
    g.save();
    g.translate(X(uc), Y(0.245));
    drawFittedText(g, mark, 0, 0, W * 0.16, H * 0.085, ink, '800', FONT_STACK, 2);
    g.restore();
  }

  /* ---- sponsor wordmark across the chin bar + one on the rear ---- */
  const spA = String((sponsors && sponsors[0]) || 'APEX').toUpperCase();
  const spB = String((sponsors && sponsors[1]) || 'KINETIQ').toUpperCase();
  g.save();
  g.translate(X(0.5), Y(0.045));
  drawFittedText(g, spA, 0, 0, W * 0.155, H * 0.055, '#f0f2f4', '700', FONT_STACK, 1);
  g.restore();
  drawWrapped(g, W, () => {
    g.save();
    g.translate(X(0.0), Y(0.155));
    drawFittedText(g, spB, 0, 0, W * 0.15, H * 0.048, inkOn(base), '700', FONT_STACK, 1);
    g.restore();
  });

  /* ---- driver short name + country under the aperture, both sides ---- */
  const tag = String(driver.short || (driver.name || '').slice(0, 3)).toUpperCase() +
    (driver.country ? '  ' + String(driver.country).toUpperCase() : '');
  for (const uc of [0.35, 0.65]) {
    g.save();
    g.translate(X(uc), Y(0.205));
    drawFittedText(g, tag, 0, 0, W * 0.11, H * 0.040, ink, '600', FONT_MONO, 1);
    g.restore();
  }

  /* ---- homologation label at the neck line ---- */
  g.save();
  g.translate(X(0.5), Y(0.012));
  drawFittedText(g, 'APEX-SPEC 8860 / ' + String(seedB % 9000 + 1000), 0, 0, W * 0.20, H * 0.026, '#8f9297', '500', FONT_MONO, 0);
  g.restore();

  return cv;
}

/* ===========================================================================
 * VISOR TINT — a subtle gradient + sun strip drawn across the visor UVs.
 * =========================================================================== */
function paintVisor(size, tintHex) {
  const W = size, H = size >> 1;
  const cv = makeCanvas(W, H);
  const g = ctx2d(cv);
  if (!g) return null;
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.0, shadeHex(tintHex, -0.55));
  grad.addColorStop(0.28, shadeHex(tintHex, -0.15));
  grad.addColorStop(0.70, shadeHex(tintHex, 0.10));
  grad.addColorStop(1.0, shadeHex(tintHex, -0.25));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  /* sun strip along the top edge */
  g.fillStyle = 'rgba(6,8,14,0.85)';
  g.fillRect(0, 0, W, H * 0.20);
  /* edge darkening left/right */
  const sideGrad = g.createLinearGradient(0, 0, W, 0);
  sideGrad.addColorStop(0.0, 'rgba(0,0,0,0.55)');
  sideGrad.addColorStop(0.12, 'rgba(0,0,0,0)');
  sideGrad.addColorStop(0.88, 'rgba(0,0,0,0)');
  sideGrad.addColorStop(1.0, 'rgba(0,0,0,0.55)');
  g.fillStyle = sideGrad;
  g.fillRect(0, 0, W, H);
  /* faint horizontal sweep highlight */
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = 0.10;
  const swp = g.createLinearGradient(0, H * 0.30, W, H * 0.55);
  swp.addColorStop(0.0, 'rgba(255,255,255,0)');
  swp.addColorStop(0.45, '#ffffff');
  swp.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = swp;
  g.fillRect(0, 0, W, H);
  g.restore();
  return cv;
}

/* ===========================================================================
 * RACE SUIT — u wraps the torso (0.5 = chest), v runs hips -> shoulders.
 * =========================================================================== */
function paintSuit(size, team, driver) {
  const W = size, H = size;
  const cv = makeCanvas(W, H);
  const g = ctx2d(cv);
  if (!g) return null;

  const tc = (team && team.colors) || {};
  const primary = safeHex(tc.primary, '#182238');
  const secondary = safeHex(tc.secondary, '#101010');
  const accent = safeHex(tc.accent, '#f2c53d');
  const trim = safeHex(tc.trim, '#ffffff');
  const sponsors = (team && team.sponsors) || ['ORAVAX', 'KINETIQ', 'NOVAFUEL'];

  const X = (u) => u * W;
  const Y = (v) => (1 - v) * H;

  g.fillStyle = primary;
  g.fillRect(0, 0, W, H);

  /* upper chest / shoulder yoke in the secondary colour */
  g.fillStyle = secondary;
  g.fillRect(0, 0, W, Y(0.66));

  /* accent yoke sweep across the shoulders */
  drawWrapped(g, W, () => {
    g.fillStyle = accent;
    g.beginPath();
    g.moveTo(X(0.16), Y(1.02));
    g.quadraticCurveTo(X(0.5), Y(0.74), X(0.84), Y(1.02));
    g.lineTo(X(0.84), Y(1.10));
    g.lineTo(X(0.16), Y(1.10));
    g.closePath();
    g.fill();
  });

  /* diagonal flash down the flanks */
  drawWrapped(g, W, () => {
    g.fillStyle = mixHex(accent, secondary, 0.35);
    g.beginPath();
    g.moveTo(X(0.08), Y(0.70));
    g.lineTo(X(0.24), Y(0.70));
    g.lineTo(X(0.16), Y(0.02));
    g.lineTo(X(0.02), Y(0.02));
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(X(0.92), Y(0.70));
    g.lineTo(X(0.76), Y(0.70));
    g.lineTo(X(0.84), Y(0.02));
    g.lineTo(X(0.98), Y(0.02));
    g.closePath();
    g.fill();
  });

  /* horizontal split rule */
  g.fillStyle = trim;
  g.fillRect(0, Y(0.665), W, Math.max(2, H * 0.006));

  /* collar band */
  g.fillStyle = mixHex(secondary, '#000000', 0.4);
  g.fillRect(0, 0, W, H * 0.045);

  /* --- stitched seams: shoulder, side, centre-front zip, waist --- */
  const seamCol = 'rgba(0,0,0,0.42)';
  const stitchCol = 'rgba(240,240,240,0.30)';
  const dash = Math.max(4, H * 0.012);
  for (const u of [0.22, 0.78]) {
    g.save();
    g.strokeStyle = seamCol;
    g.lineWidth = Math.max(2, H * 0.005);
    g.beginPath();
    g.moveTo(X(u), Y(1.0));
    g.lineTo(X(u), Y(0.0));
    g.stroke();
    g.restore();
    stitchLine(g, X(u) - H * 0.008, Y(1.0), X(u) - H * 0.008, Y(0.0), stitchCol, dash, Math.max(1, H * 0.003));
    stitchLine(g, X(u) + H * 0.008, Y(1.0), X(u) + H * 0.008, Y(0.0), stitchCol, dash, Math.max(1, H * 0.003));
  }
  stitchLine(g, 0, Y(0.40), W, Y(0.40), stitchCol, dash, Math.max(1, H * 0.003));
  stitchLine(g, 0, Y(0.655), W, Y(0.655), stitchCol, dash, Math.max(1, H * 0.003));

  /* centre-front zip flap */
  g.save();
  g.fillStyle = mixHex(secondary, '#000000', 0.55);
  g.fillRect(X(0.487), Y(1.0), W * 0.026, Y(0.10) - Y(1.0));
  stitchLine(g, X(0.4845), Y(1.0), X(0.4845), Y(0.10), stitchCol, dash * 0.7, Math.max(1, H * 0.0025));
  stitchLine(g, X(0.5155), Y(1.0), X(0.5155), Y(0.10), stitchCol, dash * 0.7, Math.max(1, H * 0.0025));
  g.restore();

  /* --- sponsor patches --- */
  function patch(uc, vc, wu, hv, bg, fg, text, italic) {
    drawWrapped(g, W, () => {
      const px = X(uc - wu * 0.5), py = Y(vc + hv * 0.5);
      const pw = W * wu, ph = H * hv;
      g.save();
      g.fillStyle = bg;
      roundRectPath(g, px, py, pw, ph, ph * 0.18);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = Math.max(1, H * 0.0025);
      g.stroke();
      g.restore();
      g.save();
      g.translate(px + pw * 0.5, py + ph * 0.52);
      drawFittedText(g, text, 0, 0, pw * 0.86, ph * 0.62, fg, italic ? '800' : '700', FONT_STACK, 1);
      g.restore();
    });
  }

  patch(0.5, 0.885, 0.30, 0.052, 'rgba(0,0,0,0)', trim, String(team.name || 'APEX RACING').toUpperCase(), false);
  patch(0.5, 0.775, 0.26, 0.062, trim, '#101418', String(sponsors[0] || 'ORAVAX').toUpperCase(), true);
  patch(0.33, 0.555, 0.155, 0.048, accent, inkOn(accent), String(sponsors[1] || 'KINETIQ').toUpperCase(), false);
  patch(0.67, 0.555, 0.155, 0.048, accent, inkOn(accent), String(sponsors[1] || 'KINETIQ').toUpperCase(), false);
  patch(0.5, 0.470, 0.22, 0.050, '#0d1116', trim, String(sponsors[2] || 'NOVAFUEL').toUpperCase(), false);
  patch(0.5, 0.300, 0.20, 0.044, mixHex(primary, '#000000', 0.35), trim, String(team.engine || 'APEX RA-1').toUpperCase(), false);
  patch(0.0, 0.640, 0.34, 0.085, 'rgba(0,0,0,0)', trim, String(team.short || 'APX').toUpperCase(), false);
  patch(0.0, 0.520, 0.24, 0.048, 'rgba(0,0,0,0)', mixHex(trim, primary, 0.35), String(sponsors[2] || 'NOVAFUEL').toUpperCase(), false);

  /* driver identity strip */
  const dtag = String(driver.short || 'DRV').toUpperCase() + ' ' + String(driver.num !== undefined ? driver.num : '');
  patch(0.5, 0.205, 0.16, 0.042, accent, inkOn(accent), dtag, false);

  /* fireproof / homologation labels */
  g.save();
  g.translate(X(0.5), Y(0.115));
  drawFittedText(g, 'APEX-SPEC FR  •  8856-A', 0, 0, W * 0.20, H * 0.024, 'rgba(255,255,255,0.55)', '500', FONT_MONO, 0);
  g.restore();

  /* fabric micro-shading so the suit does not read as flat paint */
  g.save();
  g.globalCompositeOperation = 'multiply';
  const sg = g.createLinearGradient(0, 0, 0, H);
  sg.addColorStop(0.0, '#e2e2e2');
  sg.addColorStop(0.35, '#ffffff');
  sg.addColorStop(1.0, '#b6b6b6');
  g.fillStyle = sg;
  g.fillRect(0, 0, W, H);
  const rg = g.createLinearGradient(0, 0, W, 0);
  rg.addColorStop(0.0, '#9c9c9c');
  rg.addColorStop(0.22, '#dcdcdc');
  rg.addColorStop(0.5, '#ffffff');
  rg.addColorStop(0.78, '#dcdcdc');
  rg.addColorStop(1.0, '#9c9c9c');
  g.fillStyle = rg;
  g.fillRect(0, 0, W, H);
  g.restore();

  speckle(g, W, H, Math.round(W * 2.5), 0.055, '#000000');
  return cv;
}

/* ===========================================================================
 * SLEEVE / ARM texture — u wraps the limb, v runs shoulder -> wrist.
 * =========================================================================== */
function paintSleeve(size, team, sponsors) {
  const W = size, H = size;
  const cv = makeCanvas(W, H);
  const g = ctx2d(cv);
  if (!g) return null;
  const tc = (team && team.colors) || {};
  const primary = safeHex(tc.primary, '#182238');
  const secondary = safeHex(tc.secondary, '#101010');
  const accent = safeHex(tc.accent, '#f2c53d');
  const trim = safeHex(tc.trim, '#ffffff');

  g.fillStyle = primary;
  g.fillRect(0, 0, W, H);
  g.fillStyle = secondary;
  g.fillRect(0, 0, W, H * 0.30);
  g.fillStyle = accent;
  g.fillRect(0, H * 0.30, W, H * 0.045);
  g.fillStyle = trim;
  g.fillRect(0, H * 0.345, W, H * 0.014);
  g.fillStyle = mixHex(primary, '#000000', 0.35);
  g.fillRect(0, H * 0.86, W, H * 0.14);
  g.fillStyle = accent;
  g.fillRect(0, H * 0.83, W, H * 0.03);

  const sp = String((sponsors && sponsors[0]) || 'APEX').toUpperCase();
  for (const uc of [0.25, 0.75]) {
    g.save();
    g.translate(W * uc, H * 0.56);
    g.rotate(Math.PI * 0.5);
    drawFittedText(g, sp, 0, 0, H * 0.30, W * 0.09, trim, '700', FONT_STACK, 1);
    g.restore();
  }

  stitchLine(g, W * 0.02, 0, W * 0.02, H, 'rgba(255,255,255,0.25)', Math.max(4, H * 0.014), Math.max(1, H * 0.004));
  stitchLine(g, W * 0.52, 0, W * 0.52, H, 'rgba(255,255,255,0.22)', Math.max(4, H * 0.014), Math.max(1, H * 0.004));
  stitchLine(g, 0, H * 0.30, W, H * 0.30, 'rgba(0,0,0,0.45)', Math.max(4, H * 0.014), Math.max(1, H * 0.004));

  g.save();
  g.globalCompositeOperation = 'multiply';
  const rg = g.createLinearGradient(0, 0, W, 0);
  rg.addColorStop(0.0, '#8e8e8e');
  rg.addColorStop(0.28, '#ffffff');
  rg.addColorStop(0.55, '#d8d8d8');
  rg.addColorStop(0.82, '#ffffff');
  rg.addColorStop(1.0, '#8e8e8e');
  g.fillStyle = rg;
  g.fillRect(0, 0, W, H);
  g.restore();
  speckle(g, W, H, Math.round(W * 2), 0.05, '#000000');
  return cv;
}

/* ===========================================================================
 * GLOVE texture
 * =========================================================================== */
function paintGlove(size, team) {
  const W = size, H = size;
  const cv = makeCanvas(W, H);
  const g = ctx2d(cv);
  if (!g) return null;
  const tc = (team && team.colors) || {};
  const primary = safeHex(tc.primary, '#182238');
  const accent = safeHex(tc.accent, '#f2c53d');
  const trim = safeHex(tc.trim, '#ffffff');
  g.fillStyle = mixHex(primary, '#0a0a0a', 0.35);
  g.fillRect(0, 0, W, H);
  g.fillStyle = accent;
  g.fillRect(0, H * 0.06, W, H * 0.10);
  g.fillStyle = trim;
  g.fillRect(0, H * 0.16, W, H * 0.025);
  g.fillStyle = '#141416';
  g.fillRect(0, H * 0.55, W, H * 0.45);
  for (let i = 0; i < 14; i++) {
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, H * (0.56 + i * 0.031), W, H * 0.010);
  }
  g.save();
  g.translate(W * 0.5, H * 0.34);
  drawFittedText(g, String((team && team.short) || 'APX').toUpperCase(), 0, 0, W * 0.5, H * 0.13, trim, '800', FONT_STACK, 2);
  g.restore();
  speckle(g, W, H, Math.round(W * 3), 0.07, '#000000');
  return cv;
}

/* ===========================================================================
 * HARNESS WEBBING texture — u along the belt, v across it.
 * =========================================================================== */
function paintWebbing(size, team) {
  const W = size, H = Math.max(32, size >> 3);
  const cv = makeCanvas(W, H);
  const g = ctx2d(cv);
  if (!g) return null;
  const tc = (team && team.colors) || {};
  const beltCol = safeHex(tc.accent, '#f2c53d');
  const dark = mixHex(beltCol, '#000000', 0.35);
  g.fillStyle = beltCol;
  g.fillRect(0, 0, W, H);
  /* woven twill */
  for (let x = 0; x < W; x += 6) {
    g.fillStyle = ((x / 6) & 1) ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)';
    g.fillRect(x, 0, 3, H);
  }
  for (let y = 0; y < H; y += 5) {
    g.fillStyle = 'rgba(0,0,0,0.07)';
    g.fillRect(0, y, W, 2);
  }
  /* edge binding */
  g.fillStyle = dark;
  g.fillRect(0, 0, W, Math.max(2, H * 0.10));
  g.fillRect(0, H - Math.max(2, H * 0.10), W, Math.max(2, H * 0.10));
  /* repeating wordmark */
  const label = 'APEX 6PT  ' + String((team && team.short) || 'APX') + '  ';
  g.save();
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.font = '700 ' + (H * 0.46).toFixed(1) + 'px ' + FONT_STACK;
  g.fillStyle = inkOn(beltCol);
  const step = g.measureText(label).width || W;
  for (let x = 0; x < W + step; x += step) g.fillText(label, x, H * 0.52);
  g.restore();
  return cv;
}

/* ===========================================================================
 * CARBON TWILL + FABRIC NORMAL (shared / cached)
 * =========================================================================== */
function makeCarbonCanvas(size) {
  const cv = makeCanvas(size, size);
  const g = ctx2d(cv);
  if (!g) return null;
  const cells = 8;
  const cs = size / cells;
  g.fillStyle = '#101216';
  g.fillRect(0, 0, size, size);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const over = ((cx + cy) & 1) === 0;
      const x = cx * cs, y = cy * cs;
      const grad = over
        ? g.createLinearGradient(x, y, x + cs, y + cs)
        : g.createLinearGradient(x + cs, y, x, y + cs);
      grad.addColorStop(0.0, '#0c0e11');
      grad.addColorStop(0.35, '#2b3038');
      grad.addColorStop(0.5, '#3b424c');
      grad.addColorStop(0.65, '#2b3038');
      grad.addColorStop(1.0, '#0c0e11');
      g.fillStyle = grad;
      g.fillRect(x, y, cs + 0.5, cs + 0.5);
      g.save();
      g.globalAlpha = 0.28;
      g.strokeStyle = '#05070a';
      g.lineWidth = Math.max(1, cs * 0.06);
      for (let k = 0; k < 5; k++) {
        const o = (k + 0.5) * cs / 5;
        g.beginPath();
        if (over) { g.moveTo(x, y + o); g.lineTo(x + cs - o, y + cs); }
        else { g.moveTo(x + cs, y + o); g.lineTo(x + o, y + cs); }
        g.stroke();
      }
      g.restore();
    }
  }
  speckle(g, size, size, size * 2, 0.06, '#7f8894');
  return cv;
}

function makeFabricHeight(size) {
  const cv = makeCanvas(size, size);
  const g = ctx2d(cv);
  if (!g) return null;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, size, size);
  const cell = Math.max(3, size >> 6);
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      const over = ((((x / cell) | 0) + ((y / cell) | 0)) & 1) === 0;
      g.fillStyle = over ? '#a8a8a8' : '#606060';
      g.fillRect(x, y, cell, cell * 0.62);
      g.fillStyle = over ? '#6a6a6a' : '#9a9a9a';
      g.fillRect(x, y + cell * 0.62, cell, cell * 0.38);
    }
  }
  speckle(g, size, size, size * 6, 0.20, '#ffffff');
  speckle(g, size, size, size * 6, 0.20, '#000000');
  return cv;
}

function heightToNormalCanvas(src, strength) {
  const w = src.width, h = src.height;
  const sctx = ctx2d(src);
  if (!sctx) return null;
  let data;
  try { data = sctx.getImageData(0, 0, w, h).data; } catch (e) { return null; }
  const out = makeCanvas(w, h);
  const octx = ctx2d(out);
  if (!octx) return null;
  const img = octx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w;
    const yp = ((y + 1) % h) * w;
    const y0 = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const hl = data[(y0 + xm) * 4] / 255;
      const hr = data[(y0 + xp) * 4] / 255;
      const hu = data[(ym + x) * 4] / 255;
      const hd = data[(yp + x) * 4] / 255;
      const nx = -(hr - hl) * strength;
      const ny = (hd - hu) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const k = (y0 + x) * 4;
      d[k] = (nx * inv * 0.5 + 0.5) * 255;
      d[k + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[k + 2] = (inv * 0.5 + 0.5) * 255;
      d[k + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* ===========================================================================
 * STEERING WHEEL — layout data shared by the 3D parts and the face decal.
 * Local space: X right, Y up, Z out toward the front of the car.
 * =========================================================================== */
const WHEEL_HW = 0.137;     /* plate half width  */
const WHEEL_HH = 0.080;     /* plate half height */
const WHEEL_T = 0.017;      /* plate thickness   */
const WHEEL_CORNER = 0.020;
const LCD_CX = 0.0, LCD_CY = 0.018, LCD_W = 0.100, LCD_H = 0.053;
const GRIP_X = 0.1235;
const GRIP_Y = 0.028;
const WRIST_LOCAL = [0.034, -0.030, -0.056]; /* relative to the grip centre */

const WHEEL_DIALS = [
  { x: -0.100, y: 0.030, r: 0.0160, c: '#c9a227', label: 'DIFF', ticks: 12 },
  { x: 0.100, y: 0.030, r: 0.0160, c: '#1e9bd8', label: 'ENG', ticks: 12 },
  { x: -0.100, y: -0.036, r: 0.0135, c: '#e2262c', label: 'BBAL', ticks: 10 },
  { x: 0.100, y: -0.036, r: 0.0135, c: '#38b44a', label: 'MIX', ticks: 8 },
  { x: 0.000, y: -0.053, r: 0.0130, c: '#d8dade', label: 'STRAT', ticks: 12 },
];

const WHEEL_BUTTONS = [
  { x: -0.062, y: 0.062, r: 0.0080, c: '#e2262c', label: 'PIT' },
  { x: -0.030, y: 0.062, r: 0.0080, c: '#ffd400', label: 'BOX' },
  { x: 0.000, y: 0.062, r: 0.0075, c: '#eef1f4', label: 'MRK' },
  { x: 0.030, y: 0.062, r: 0.0080, c: '#1e9bd8', label: 'RDO' },
  { x: 0.062, y: 0.062, r: 0.0080, c: '#38b44a', label: 'DRS' },
  { x: -0.062, y: -0.024, r: 0.0075, c: '#f2f2f2', label: 'N' },
  { x: 0.062, y: -0.024, r: 0.0075, c: '#00c2a8', label: 'TC' },
  { x: -0.030, y: -0.056, r: 0.0075, c: '#8c52ff', label: 'OT' },
  { x: 0.030, y: -0.056, r: 0.0075, c: '#ff7a00', label: 'ERS' },
  { x: -0.062, y: -0.056, r: 0.0070, c: '#e2262c', label: 'BB-' },
  { x: 0.062, y: -0.056, r: 0.0070, c: '#38b44a', label: 'BB+' },
];

function paintWheelFace(size, team, driver, detail) {
  const W = size;
  const H = Math.round(size * (WHEEL_HH / WHEEL_HW) * 0.5) * 2;
  const cv = makeCanvas(W, H);
  const g = ctx2d(cv);
  if (!g) return null;

  const tc = (team && team.colors) || {};
  const accent = safeHex(tc.accent, '#f2c53d');
  const primary = safeHex(tc.primary, '#182238');
  const trim = safeHex(tc.trim, '#ffffff');
  const px = (lx) => ((lx + WHEEL_HW) / (2 * WHEEL_HW)) * W;
  const py = (ly) => (1 - (ly + WHEEL_HH) / (2 * WHEEL_HH)) * H;
  const ps = (m) => (m / (2 * WHEEL_HW)) * W;

  g.clearRect(0, 0, W, H);

  /* rounded plate silhouette with a notched top (alphaTest carves the corners) */
  g.save();
  const cr = ps(WHEEL_CORNER);
  roundRectPath(g, 0, 0, W, H, cr);
  g.clip();

  /* carbon-ish base painted directly so the decal reads even without the weave */
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1b1f25');
  bg.addColorStop(0.5, '#12161b');
  bg.addColorStop(1, '#0b0e12');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  for (let y = -H; y < W + H; y += Math.max(4, W / 90)) {
    g.strokeStyle = ((y | 0) % 2 === 0) ? 'rgba(255,255,255,0.030)' : 'rgba(0,0,0,0.22)';
    g.lineWidth = Math.max(1, W / 340);
    g.beginPath(); g.moveTo(y, 0); g.lineTo(y - H, H); g.stroke();
    g.beginPath(); g.moveTo(y - H, 0); g.lineTo(y, H); g.stroke();
  }

  /* team accent frame */
  g.strokeStyle = accent;
  g.lineWidth = Math.max(2, ps(0.0035));
  roundRectPath(g, g.lineWidth, g.lineWidth, W - g.lineWidth * 2, H - g.lineWidth * 2, cr * 0.85);
  g.stroke();

  /* display recess */
  g.fillStyle = '#050607';
  roundRectPath(g, px(LCD_CX - LCD_W * 0.5) - ps(0.004), py(LCD_CY + LCD_H * 0.5) - ps(0.004),
    ps(LCD_W + 0.008), ps(LCD_H + 0.008), ps(0.005));
  g.fill();
  g.strokeStyle = '#2a2f36';
  g.lineWidth = Math.max(1, ps(0.0015));
  g.stroke();

  /* dial wells + labels */
  const dialCount = Math.min(detail.dials, WHEEL_DIALS.length);
  for (let i = 0; i < dialCount; i++) {
    const d = WHEEL_DIALS[i];
    const cx = px(d.x), cy = py(d.y), rr = ps(d.r);
    g.save();
    const wg = g.createRadialGradient(cx, cy - rr * 0.3, rr * 0.15, cx, cy, rr * 1.45);
    wg.addColorStop(0, '#2a2f37');
    wg.addColorStop(1, '#090b0e');
    g.fillStyle = wg;
    g.beginPath(); g.arc(cx, cy, rr * 1.42, 0, Math.PI * 2); g.fill();
    g.strokeStyle = d.c;
    g.lineWidth = Math.max(1.5, ps(0.0016));
    g.beginPath(); g.arc(cx, cy, rr * 1.36, 0, Math.PI * 2); g.stroke();
    /* index ticks + position numbers */
    g.fillStyle = 'rgba(230,235,240,0.75)';
    for (let k = 0; k < d.ticks; k++) {
      const a = -Math.PI * 0.72 + (k / (d.ticks - 1)) * Math.PI * 1.44;
      const tx = cx + Math.sin(a) * rr * 1.30;
      const ty = cy - Math.cos(a) * rr * 1.30;
      g.beginPath(); g.arc(tx, ty, Math.max(1, ps(0.0009)), 0, Math.PI * 2); g.fill();
    }
    g.restore();
    g.save();
    g.translate(cx, cy + rr * 1.95);
    drawFittedText(g, d.label, 0, 0, rr * 3.4, ps(0.0075), d.c, '700', FONT_STACK, 0);
    g.restore();
  }

  /* button surrounds + labels */
  const btnCount = Math.min(detail.buttons, WHEEL_BUTTONS.length);
  for (let i = 0; i < btnCount; i++) {
    const b = WHEEL_BUTTONS[i];
    const cx = px(b.x), cy = py(b.y), rr = ps(b.r);
    g.save();
    g.fillStyle = '#07090b';
    g.beginPath(); g.arc(cx, cy, rr * 1.55, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(180,190,200,0.35)';
    g.lineWidth = Math.max(1, ps(0.0010));
    g.beginPath(); g.arc(cx, cy, rr * 1.52, 0, Math.PI * 2); g.stroke();
    g.restore();
    g.save();
    g.translate(cx, cy + rr * 2.35);
    drawFittedText(g, b.label, 0, 0, rr * 3.6, ps(0.0068), 'rgba(226,232,238,0.9)', '700', FONT_STACK, 0);
    g.restore();
  }

  /* team wordmark bottom-centre + driver strip top-centre */
  g.save();
  g.translate(W * 0.5, py(-0.0705));
  drawFittedText(g, String(team.name || 'APEX RACING').toUpperCase(), 0, 0, ps(0.085), ps(0.0090), accent, '800', FONT_STACK, 1);
  g.restore();

  g.save();
  g.translate(W * 0.5, py(0.0735));
  drawFittedText(g,
    String(driver.short || 'DRV').toUpperCase() + ' ' + String(driver.num !== undefined ? driver.num : ''),
    0, 0, ps(0.050), ps(0.0085), trim, '800', FONT_MONO, 1);
  g.restore();

  /* subtle vignette */
  g.save();
  g.globalCompositeOperation = 'multiply';
  const vg = g.createRadialGradient(W * 0.5, H * 0.5, W * 0.15, W * 0.5, H * 0.5, W * 0.62);
  vg.addColorStop(0, '#ffffff');
  vg.addColorStop(1, '#8a8a8a');
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);
  g.restore();

  g.restore();
  return cv;
}

/* ===========================================================================
 * WHEEL LCD — emissive canvas, redrawn only when its contents actually change.
 * =========================================================================== */
const LED_COLORS = ['#25e05a', '#25e05a', '#25e05a', '#25e05a', '#25e05a',
  '#ff2a1f', '#ff2a1f', '#ff2a1f', '#ff2a1f', '#ff2a1f',
  '#4d6bff', '#4d6bff', '#4d6bff', '#8a4dff', '#8a4dff'];
const LED_COUNT = LED_COLORS.length;

function createLcd(w, h, team) {
  const cv = makeCanvas(w, h);
  const g = ctx2d(cv);
  if (!g) return null;
  const tc = (team && team.colors) || {};
  const accent = safeHex(tc.accent, '#f2c53d');

  const state = {
    canvas: cv, ctx: g, w, h, accent,
    gear: -99, leds: -1, spd: -1, ers: -1, drs: -1, flash: 0, lap: -1, pos: -1, delta: 9999,
  };

  function draw(gear, leds, spd, ersPct, drs, flash, lap, pos) {
    g.fillStyle = '#04060a';
    g.fillRect(0, 0, w, h);

    /* --- shift light strip --- */
    const stripH = h * 0.20;
    g.fillStyle = '#0a0d12';
    g.fillRect(0, 0, w, stripH);
    const pad = w * 0.014;
    const gap = w * 0.006;
    const lw = (w - pad * 2 - gap * (LED_COUNT - 1)) / LED_COUNT;
    for (let i = 0; i < LED_COUNT; i++) {
      const x = pad + i * (lw + gap);
      const on = flash ? ((i & 1) === (flash > 1 ? 1 : 0)) : (i < leds);
      if (on) {
        g.fillStyle = flash ? '#5c7bff' : LED_COLORS[i];
        g.shadowColor = g.fillStyle;
        g.shadowBlur = w * 0.02;
      } else {
        g.fillStyle = '#161b22';
        g.shadowBlur = 0;
      }
      roundRectPath(g, x, stripH * 0.24, lw, stripH * 0.52, stripH * 0.16);
      g.fill();
    }
    g.shadowBlur = 0;

    /* --- gear --- */
    const gearTxt = gear === 0 ? 'N' : (gear < 0 ? 'R' : String(gear));
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 ' + (h * 0.60).toFixed(0) + 'px ' + FONT_MONO;
    g.shadowColor = '#a8ffbf';
    g.shadowBlur = h * 0.07;
    g.fillStyle = '#e8fff0';
    g.fillText(gearTxt, w * 0.19, h * 0.60);
    g.restore();

    /* --- speed --- */
    g.save();
    g.textAlign = 'right';
    g.textBaseline = 'alphabetic';
    g.font = '700 ' + (h * 0.30).toFixed(0) + 'px ' + FONT_MONO;
    g.fillStyle = '#dfe7f2';
    g.fillText(String(spd), w * 0.80, h * 0.52);
    g.font = '600 ' + (h * 0.12).toFixed(0) + 'px ' + FONT_STACK;
    g.fillStyle = '#7d8794';
    g.fillText('KM/H', w * 0.965, h * 0.52);
    g.restore();

    /* --- ERS bar --- */
    const bx = w * 0.40, by = h * 0.62, bw = w * 0.44, bh = h * 0.11;
    g.fillStyle = '#141a22';
    roundRectPath(g, bx, by, bw, bh, bh * 0.4); g.fill();
    const frac = clamp(ersPct / 100, 0, 1);
    g.fillStyle = frac > 0.55 ? '#25e05a' : (frac > 0.22 ? '#ffd400' : '#ff5a3c');
    roundRectPath(g, bx + 1, by + 1, Math.max(0, (bw - 2) * frac), bh - 2, bh * 0.35); g.fill();
    g.save();
    g.font = '700 ' + (h * 0.095).toFixed(0) + 'px ' + FONT_STACK;
    g.fillStyle = '#98a4b2';
    g.textAlign = 'left';
    g.fillText('ERS', w * 0.40, by - h * 0.02);
    g.restore();

    /* --- bottom info row --- */
    g.save();
    g.font = '700 ' + (h * 0.125).toFixed(0) + 'px ' + FONT_MONO;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = state.accent;
    g.fillText('P' + (pos > 0 ? pos : '-'), w * 0.045, h * 0.95);
    g.fillStyle = '#9aa6b4';
    g.textAlign = 'center';
    g.fillText('L' + (lap > 0 ? lap : 1), w * 0.30, h * 0.95);
    g.restore();

    /* --- DRS badge --- */
    g.save();
    const dx = w * 0.845, dy = h * 0.845, dw = w * 0.115, dh = h * 0.13;
    g.fillStyle = drs ? '#1ee06a' : '#1a2029';
    roundRectPath(g, dx - dw * 0.5, dy - dh * 0.5, dw, dh, dh * 0.28); g.fill();
    g.font = '800 ' + (h * 0.095).toFixed(0) + 'px ' + FONT_STACK;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = drs ? '#04140a' : '#5d6874';
    g.fillText('DRS', dx, dy + h * 0.004);
    g.restore();
  }

  state.draw = draw;
  draw(0, 0, 0, 0, 0, 0, 1, 0);
  return state;
}

/* ===========================================================================
 * Shared build helpers
 * =========================================================================== */
const VISOR_HALF_ANGLE = 1.26;
const _slab = [0, 0];
function slabParams(v) {
  const ang = v * Math.PI * 2;
  _slab[0] = 0.5 + 0.5 * spow(Math.sin(ang), 0.5);
  _slab[1] = spow(Math.cos(ang), 0.5);
  return _slab;
}

function mk(ctx, geo, mat, name, cast) {
  if (!geo || !mat) return null;
  const m = new THREE.Mesh(geo, mat);
  m.name = name || 'part';
  m.castShadow = !!(cast && ctx.quality.shadows);
  m.receiveShadow = false;
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  ctx.reg(geo);
  return m;
}

function mkDyn(ctx, geo, mat, name, cast) {
  const m = mk(ctx, geo, mat, name, cast);
  if (m) m.matrixAutoUpdate = true;
  return m;
}

/* ===========================================================================
 * HELMET
 * =========================================================================== */
function buildHelmet(ctx) {
  const D = ctx.D;
  const M = ctx.mats;
  const g = new THREE.Group();
  g.name = 'helmet';
  const nrm = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const parts = {};

  /* ---------------- shell ---------------- */
  ctx.step('helmet.shell', () => {
    const sub = Math.max(1, D.helmetRows);
    const pts = [];
    for (let i = 0; i < HELMET_ROWS - 1; i++) {
      const a = HELMET_PROFILE[i], b = HELMET_PROFILE[i + 1];
      for (let k = 0; k < sub; k++) {
        const t = k / sub;
        pts.push(new THREE.Vector2(lerp(a[0], b[0], t), lerp(a[1], b[1], t)));
      }
    }
    pts.push(new THREE.Vector2(HELMET_PROFILE[HELMET_ROWS - 1][0], HELMET_PROFILE[HELMET_ROWS - 1][1]));
    const lastIdx = pts.length - 1;                 /* index of the true profile end */
    pts.push(new THREE.Vector2(0.0, HELMET_TOP + 0.0007));  /* pole cap */

    const seg = D.helmetSeg;
    const geo = new THREE.LatheGeometry(pts, seg, -Math.PI, Math.PI * 2);
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const P = pts.length;
    const out = new THREE.Vector3();
    for (let i = 0; i <= seg; i++) {
      for (let j = 0; j < P; j++) {
        const k = i * P + j;
        const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
        const phi = (x === 0 && z === 0) ? (-Math.PI + (i / seg) * Math.PI * 2) : Math.atan2(x, z);
        helmetSurface(phi, y, out, 1);
        pos.setXYZ(k, out.x, out.y, out.z);
        /* keep the painted UV aligned with the un-capped profile */
        uv.setY(k, Math.min(1, j / lastIdx));
      }
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    geo.computeVertexNormals();
    weldLatheSeam(geo, seg, P);
    geo.computeBoundingSphere();
    const shell = mk(ctx, geo, M.helmet, 'helmet.shell', true);
    g.add(shell);
    parts.shell = shell;

    /* dark inner liner so the recess / neck opening never shows sky through */
    if (ctx.quality.rank >= 1) {
      const linerPts = [];
      for (let i = 0; i < pts.length; i++) linerPts.push(new THREE.Vector2(pts[i].x * 0.965, pts[i].y * 0.985 + 0.002));
      const lg = new THREE.LatheGeometry(linerPts, Math.max(12, seg >> 1), -Math.PI, Math.PI * 2);
      const liner = mk(ctx, lg, M.liner, 'helmet.liner', false);
      g.add(liner);
      parts.liner = liner;
    }
  });

  /* ---------------- visor ---------------- */
  const visorPoint = (u, v, out, rOff, vLo, vHi) => {
    const t = Math.abs(u * 2 - 1);
    const a = lerp(-VISOR_HALF_ANGLE, VISOR_HALF_ANGLE, u);
    const yc = APERTURE_Y + 0.0016 * t * t;
    const hh = APERTURE_HALF_H * 1.03 * (1 - 0.30 * t * t * t);
    const vv = lerp(vLo === undefined ? 0 : vLo, vHi === undefined ? 1 : vHi, v);
    const y = clamp(yc + (vv - 0.5) * 2 * hh, 0.004, HELMET_TOP - 0.004);
    helmetSurface(a, y, out, 0);
    helmetNormal(a, y, nrm, 0);
    const bulge = 0.0024 * Math.cos(a * 1.10) * Math.sin(Math.PI * clamp(vv, 0, 1));
    out.addScaledVector(nrm, rOff + bulge);
  };

  ctx.step('helmet.visor', () => {
    const geo = buildSurface(D.visorU, D.visorV, (u, v, out) => visorPoint(u, v, out, 0.0026));
    const visor = mk(ctx, geo, M.visor, 'helmet.visor', false);
    visor.renderOrder = 3;
    g.add(visor);
    parts.visor = visor;
  });

  /* visor gasket lips (top + bottom edge of the aperture) */
  ctx.step('helmet.gasket', () => {
    const lips = [];
    for (const band of [[-0.045, 0.02], [0.98, 1.045]]) {
      lips.push(buildSurface(Math.max(10, D.visorU >> 1), 4, (u, v, out) => {
        const s = slabParams(v);
        visorPoint(u, s[0], out, 0.0016 + s[1] * 0.0016, band[0], band[1]);
      }));
    }
    const merged = mergePlain(lips);
    if (merged) g.add(mk(ctx, merged, M.trim, 'helmet.gasket', false));
  });

  /* ---------------- tear-off film + tab ---------------- */
  if (D.extras) {
    ctx.step('helmet.tearoff', () => {
      const film = buildSurface(D.visorU, Math.max(3, D.visorV >> 1), (u, v, out) => {
        visorPoint(u, v, out, 0.0046, 0.02, 0.98);
      });
      const fm = mk(ctx, film, M.tearoff, 'helmet.tearoff', false);
      fm.renderOrder = 4;
      g.add(fm);

      /* adhesive strip across the top of the film */
      const strip = buildSurface(Math.max(10, D.visorU >> 1), 2, (u, v, out) => {
        visorPoint(u, v, out, 0.0053, 0.80, 0.955);
      });
      const sm = mk(ctx, strip, M.tearoffStrip, 'helmet.tearoff.strip', false);
      sm.renderOrder = 5;
      g.add(sm);

      /* pull tab wrapping past the visor edge */
      const tab = buildSurface(6, 3, (u, v, out) => {
        visorPoint(1.0 + u * 0.155, lerp(0.40, 0.60, v), out, 0.0057 + u * 0.0022);
      });
      const tm = mk(ctx, tab, M.tearoffStrip, 'helmet.tearoff.tab', false);
      tm.renderOrder = 5;
      g.add(tm);
    });
  }

  /* ---------------- crown aero ridge ---------------- */
  ctx.step('helmet.ridge', () => {
    const ridgePath = (s, outPhi) => {
      if (s <= 0.5) { outPhi[0] = 0; outPhi[1] = lerp(0.236, HELMET_TOP - 0.0012, s / 0.5); }
      else { outPhi[0] = Math.PI; outPhi[1] = lerp(HELMET_TOP - 0.0012, 0.148, (s - 0.5) / 0.5); }
    };
    const pf = [0, 0];
    const geo = buildSurface(Math.max(16, D.helmetSeg >> 1), 8, (u, v, out) => {
      ridgePath(u, pf);
      helmetSurface(pf[0], pf[1], out, 1);
      helmetNormal(pf[0], pf[1], nrm, 1);
      tmp.set(-nrm.z, 0, nrm.x);
      if (tmp.lengthSq() < 1e-9) tmp.set(1, 0, 0);
      tmp.normalize();
      const h = 0.0035 + 0.0105 * smoothstep(0.12, 0.62, u) * (1 - smoothstep(0.90, 1.0, u) * 0.55)
        + 0.0055 * gauss((u - 0.80) / 0.13);
      const w = 0.0075 * (0.55 + 0.45 * Math.sin(Math.PI * clamp(u * 1.02, 0, 1)));
      const ang = v * Math.PI * 2;
      out.addScaledVector(tmp, spow(Math.cos(ang), 0.45) * w);
      out.addScaledVector(nrm, (0.5 + 0.5 * Math.sin(ang)) * h);
    });
    g.add(mk(ctx, geo, M.trim, 'helmet.ridge', true));
  });

  /* ---------------- rear duck-tail lip ---------------- */
  ctx.step('helmet.lip', () => {
    const geo = buildSurface(Math.max(14, D.helmetSeg >> 2), 8, (u, v, out) => {
      const phi = Math.PI + lerp(-0.82, 0.82, u);
      const yb = 0.206 - 0.016 * Math.abs(u * 2 - 1);
      helmetSurface(phi, yb, out, 1);
      helmetNormal(phi, yb, nrm, 1);
      tmp.copy(nrm).multiplyScalar(0.72);
      tmp.y -= 0.68;
      tmp.normalize();
      const s = slabParams(v);
      const len = 0.026 * (1 - 0.35 * Math.abs(u * 2 - 1));
      out.addScaledVector(tmp, s[0] * len);
      out.addScaledVector(nrm, 0.0018 + s[1] * 0.0012);
    });
    g.add(mk(ctx, geo, M.trim, 'helmet.lip', true));
  });

  /* ---------------- chin intake ---------------- */
  ctx.step('helmet.chinvent', () => {
    const vg = new THREE.Group();
    helmetSurface(0, 0.030, tmp, 1);
    helmetNormal(0, 0.030, nrm, 1);
    vg.position.copy(tmp).addScaledVector(nrm, -0.001);
    _q1.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
    vg.quaternion.copy(_q1);

    const frameShape = roundedRectShape(0.032, 0.0165, 0.006);
    const hole = new THREE.Path();
    const hw = 0.026, hh = 0.0115, hr = 0.004;
    hole.moveTo(-hw + hr, -hh);
    hole.lineTo(hw - hr, -hh);
    hole.quadraticCurveTo(hw, -hh, hw, -hh + hr);
    hole.lineTo(hw, hh - hr);
    hole.quadraticCurveTo(hw, hh, hw - hr, hh);
    hole.lineTo(-hw + hr, hh);
    hole.quadraticCurveTo(-hw, hh, -hw, hh - hr);
    hole.lineTo(-hw, -hh + hr);
    hole.quadraticCurveTo(-hw, -hh, -hw + hr, -hh);
    frameShape.holes.push(hole);
    const fgeo = new THREE.ExtrudeGeometry(frameShape, {
      depth: 0.006, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0012,
      bevelSegments: 2, curveSegments: 4, steps: 1,
    });
    fgeo.translate(0, 0, -0.003);
    vg.add(mk(ctx, fgeo, M.trim, 'chinvent.frame', false));

    const back = new THREE.PlaneGeometry(0.054, 0.026);
    back.translate(0, 0, -0.006);
    vg.add(mk(ctx, back, M.vent, 'chinvent.mesh', false));

    const slats = [];
    for (let i = 0; i < 3; i++) {
      const s = new THREE.BoxGeometry(0.050, 0.0022, 0.006);
      s.translate(0, -0.0075 + i * 0.0075, -0.0025);
      slats.push(s);
    }
    const sm = mergePlain(slats);
    if (sm) vg.add(mk(ctx, sm, M.trim, 'chinvent.slats', false));
    g.add(vg);
    parts.chinVent = vg;
  });

  /* ---------------- crown intake scoops + rear extractors ---------------- */
  if (D.extras) {
    ctx.step('helmet.vents', () => {
      const scoops = [];
      const darks = [];
      for (const phi of [-0.52, 0.52]) {
        const y = 0.214;
        helmetSurface(phi, y, tmp, 1);
        helmetNormal(phi, y, nrm, 1);
        _q1.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
        const box = new THREE.BoxGeometry(0.026, 0.014, 0.010);
        box.translate(0, 0, 0.003);
        box.applyQuaternion(_q1);
        box.translate(tmp.x, tmp.y, tmp.z);
        scoops.push(box);
        const slot = new THREE.PlaneGeometry(0.020, 0.008);
        slot.translate(0, 0, 0.0075);
        slot.applyQuaternion(_q1);
        slot.translate(tmp.x, tmp.y, tmp.z);
        darks.push(slot);
      }
      for (const phi of [Math.PI - 0.42, Math.PI + 0.42]) {
        const y = 0.118;
        helmetSurface(phi, y, tmp, 1);
        helmetNormal(phi, y, nrm, 1);
        _q1.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
        const slot = new THREE.PlaneGeometry(0.030, 0.013);
        slot.translate(0, 0, 0.0015);
        slot.applyQuaternion(_q1);
        slot.translate(tmp.x, tmp.y, tmp.z);
        darks.push(slot);
      }
      const sm = mergePlain(scoops);
      if (sm) g.add(mk(ctx, sm, M.trim, 'helmet.scoops', true));
      const dm = mergePlain(darks);
      if (dm) g.add(mk(ctx, dm, M.vent, 'helmet.extractors', false));
    });
  }

  /* ---------------- HANS anchor tabs + visor pivots ---------------- */
  ctx.step('helmet.hans', () => {
    const metal = [];
    const rubber = [];
    for (const side of [-1, 1]) {
      const phi = side * 1.17;
      const y = 0.066;
      helmetSurface(phi, y, tmp, 1);
      helmetNormal(phi, y, nrm, 1);
      _q1.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm);
      const post = new THREE.CylinderGeometry(0.0058, 0.0068, 0.011, 10);
      post.translate(0, 0.0055, 0);
      post.applyQuaternion(_q1);
      post.translate(tmp.x, tmp.y, tmp.z);
      metal.push(post);
      const head = new THREE.SphereGeometry(0.0072, 10, 7);
      head.scale(1, 0.65, 1);
      head.translate(0, 0.0125, 0);
      head.applyQuaternion(_q1);
      head.translate(tmp.x, tmp.y, tmp.z);
      metal.push(head);
      const loop = new THREE.TorusGeometry(0.0085, 0.0022, 6, 12);
      loop.rotateX(Math.PI * 0.5);
      loop.translate(0, 0.0145, 0);
      loop.applyQuaternion(_q1);
      loop.translate(tmp.x, tmp.y, tmp.z);
      rubber.push(loop);

      /* visor pivot disc just outboard of the aperture */
      const pp = side * (VISOR_HALF_ANGLE + 0.055);
      helmetSurface(pp, APERTURE_Y, tmp, 1);
      helmetNormal(pp, APERTURE_Y, nrm, 1);
      _q1.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm);
      const disc = new THREE.CylinderGeometry(0.0135, 0.0145, 0.005, 14);
      disc.translate(0, 0.002, 0);
      disc.applyQuaternion(_q1);
      disc.translate(tmp.x, tmp.y, tmp.z);
      rubber.push(disc);
      const screw = new THREE.CylinderGeometry(0.0042, 0.0042, 0.0035, 8);
      screw.translate(0, 0.0045, 0);
      screw.applyQuaternion(_q1);
      screw.translate(tmp.x, tmp.y, tmp.z);
      metal.push(screw);
    }
    const mm = mergePlain(metal);
    if (mm) g.add(mk(ctx, mm, M.metal, 'helmet.hansTabs', true));
    const rm = mergePlain(rubber);
    if (rm) g.add(mk(ctx, rm, M.trim, 'helmet.pivots', true));
  });

  /* ---------------- chin skirt ---------------- */
  if (D.extras) {
    ctx.step('helmet.skirt', () => {
      const geo = buildSurface(Math.max(12, D.helmetSeg >> 2), 6, (u, v, out) => {
        const phi = lerp(-1.05, 1.05, u);
        const yb = 0.007;
        helmetSurface(phi, yb, out, 1);
        helmetNormal(phi, yb, nrm, 1);
        tmp.copy(nrm).multiplyScalar(0.35);
        tmp.y -= 0.94;
        tmp.normalize();
        const s = slabParams(v);
        out.addScaledVector(tmp, s[0] * 0.014);
        out.addScaledVector(nrm, 0.0012 + s[1] * 0.0010);
      });
      g.add(mk(ctx, geo, M.trim, 'helmet.skirt', false));
    });
  }

  /* ---------------- eye point (cockpit camera anchor) ---------------- */
  const eye = new THREE.Object3D();
  eye.name = 'eyePoint';
  eye.position.set(0, APERTURE_Y - 0.006, 0.038);
  g.add(eye);
  parts.eye = eye;

  return { group: g, parts, visor: parts.visor, eye };
}

/* ===========================================================================
 * UV utilities
 * =========================================================================== */
function swapUVs(geo) {
  const a = geo.getAttribute('uv');
  if (!a) return geo;
  for (let i = 0; i < a.count; i++) {
    const x = a.getX(i), y = a.getY(i);
    a.setXY(i, y, x);
  }
  a.needsUpdate = true;
  return geo;
}
function remapUVs(geo, us, uo, vs, vo) {
  const a = geo.getAttribute('uv');
  if (!a) return geo;
  for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * us + uo, a.getY(i) * vs + vo);
  a.needsUpdate = true;
  return geo;
}

/* ===========================================================================
 * BODY — reclined torso, balaclava neck, deltoids, 6-point harness, thighs.
 * Built in "torso space": the spine starts at (0,0,0) = hip joint.
 * =========================================================================== */
const TORSO_HW = [[0, 0.152], [0.2, 0.162], [0.5, 0.172], [0.75, 0.192], [0.9, 0.204], [1, 0.206]];
const TORSO_HDF = [[0, 0.124], [0.4, 0.134], [0.72, 0.150], [1, 0.152]];
const TORSO_HDB = [[0, 0.114], [0.4, 0.119], [0.72, 0.128], [1, 0.130]];

function buildBody(ctx) {
  const D = ctx.D;
  const M = ctx.mats;
  const g = new THREE.Group();
  g.name = 'torso';

  const spine = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0.16, -0.12),
    new THREE.Vector3(0, 0.32, -0.25),
    new THREE.Vector3(0, 0.42, -0.34),
  ], false, 'catmullrom', 0.5);

  /* dedicated scratch so nested surface calls never clobber each other */
  const sp1 = new THREE.Vector3(), sp2 = new THREE.Vector3(), sp3 = new THREE.Vector3(), sp4 = new THREE.Vector3();
  const tn1 = new THREE.Vector3(), tn2 = new THREE.Vector3(), tn3 = new THREE.Vector3(), tn4 = new THREE.Vector3();
  const rp1 = new THREE.Vector3(), rp2 = new THREE.Vector3(), rp3 = new THREE.Vector3();
  const rT = new THREE.Vector3(), rN = new THREE.Vector3(), rB = new THREE.Vector3();
  const cvp = new THREE.Vector3();

  function torsoPoint(u, v, out) {
    const vc = clamp(v, 0, 1);
    spine.getPoint(vc, sp1);
    spine.getTangent(vc, sp2);
    if (sp2.lengthSq() < 1e-10) sp2.set(0, 1, 0); else sp2.normalize();
    sp3.set(1, 0, 0);
    sp4.crossVectors(sp3, sp2);
    if (sp4.lengthSq() < 1e-10) sp4.set(0, 0, 1); else sp4.normalize();
    const th = (u - 0.5) * Math.PI * 2;
    const cs = Math.cos(th), sn = Math.sin(th);
    let hw = tableLerp(TORSO_HW, vc);
    let hd = cs >= 0 ? tableLerp(TORSO_HDF, vc) : tableLerp(TORSO_HDB, vc);
    let cap = 1;
    if (vc < 0.075) cap = Math.sqrt(Math.max(0, 1 - ((0.075 - vc) / 0.075) * ((0.075 - vc) / 0.075)));
    if (vc > 0.88) cap = Math.min(cap, Math.sqrt(Math.max(0, 1 - ((vc - 0.88) / 0.12) * ((vc - 0.88) / 0.12))));
    cap = Math.max(cap, 0.02);
    hw *= cap; hd *= cap;
    out.copy(sp1).addScaledVector(sp3, spow(sn, 0.85) * hw).addScaledVector(sp4, spow(cs, 0.85) * hd);
    return out;
  }

  function torsoNormalAt(u, v, out) {
    const du = 0.02, dv = 0.02;
    torsoPoint(u + du, v, tn1);
    torsoPoint(u - du, v, tn2);
    torsoPoint(u, Math.min(1, v + dv), tn3);
    torsoPoint(u, Math.max(0, v - dv), tn4);
    tn1.sub(tn2);
    tn3.sub(tn4);
    out.crossVectors(tn1, tn3);
    if (out.lengthSq() < 1e-12) out.set(Math.sin((u - 0.5) * Math.PI * 2), 0.2, Math.cos((u - 0.5) * Math.PI * 2));
    return out.normalize();
  }

  /* ---------------- torso shell ---------------- */
  let torsoMesh = null;
  ctx.step('body.torso', () => {
    const geo = buildSurface(D.torsoU, D.torsoV, (u, v, out) => { torsoPoint(u, v, out); }, { weldU: true });
    torsoMesh = mkDyn(ctx, geo, M.suit, 'body.torso', true);
    g.add(torsoMesh);
  });

  /* ---------------- deltoid caps ---------------- */
  const shoulderLocal = [new THREE.Vector3(), new THREE.Vector3()];
  ctx.step('body.deltoids', () => {
    spine.getPoint(0.855, cvp);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      shoulderLocal[i].set(side * 0.185, cvp.y, cvp.z);
    }
    const caps = [];
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SphereGeometry(1, Math.max(10, D.armRadial + 3), Math.max(8, D.armRadial));
      s.scale(0.090, 0.096, 0.092);
      s.translate(shoulderLocal[i].x, shoulderLocal[i].y + 0.006, shoulderLocal[i].z);
      caps.push(s);
    }
    const merged = mergePlain(caps);
    if (merged) g.add(mk(ctx, merged, M.sleeve, 'body.deltoids', true));
  });

  /* ---------------- balaclava neck + fireproof collar ---------------- */
  ctx.step('body.neck', () => {
    spine.getPoint(1, cvp);
    const nx = cvp.x, ny = cvp.y, nz = cvp.z;
    const neck = buildSweep(
      (t, out) => { out.set(nx, ny - 0.055 + t * 0.185, nz + 0.004 + t * 0.020); },
      new THREE.Vector3(0, 0, 1),
      8, Math.max(8, D.armRadial), (t) => 0.068 - 0.012 * t, (t) => 0.062 - 0.010 * t, 1.0, {});
    g.add(mk(ctx, neck, M.balaclava, 'body.neck', true));

    const collar = new THREE.TorusGeometry(0.072, 0.019, 8, Math.max(12, D.armRadial + 4));
    collar.rotateX(Math.PI * 0.5);
    collar.translate(nx, ny - 0.038, nz + 0.006);
    g.add(mk(ctx, collar, M.suit, 'body.collar', true));
  });

  /* ---------------- HANS carbon yoke across the shoulders ---------------- */
  if (D.extras) {
    ctx.step('body.hansYoke', () => {
      const geo = buildSurface(Math.max(14, D.torsoU >> 1), 8, (u, v, out) => {
        const uu = lerp(-0.235, 0.235, u);
        const vv = lerp(0.965, 0.775, v);
        torsoPoint(uu, vv, out);
        torsoNormalAt(uu, vv, rN);
        out.addScaledVector(rN, 0.016 + 0.006 * Math.sin(Math.PI * v));
      }, { weldU: false });
      g.add(mk(ctx, geo, M.carbonThin, 'body.hansYoke', true));
    });
  }

  /* ---------------- harness ---------------- */
  ctx.step('body.harness', () => {
    const beltGeos = [];
    const metalGeos = [];

    function ribbon(pathUV, halfW, halfT, offset, uRepeat) {
      const pts = [];
      for (let i = 0; i < pathUV.length; i++) pts.push(new THREE.Vector3(pathUV[i][0], pathUV[i][1], 0));
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
      const eps = 0.004;
      const geo = buildSurface(D.beltLong, D.beltRadial * 2, (u, v, out) => {
        curve.getPoint(u, rp1);
        curve.getPoint(Math.min(1, u + eps), rp2);
        curve.getPoint(Math.max(0, u - eps), rp3);
        torsoPoint(rp2.x, rp2.y, tn1);
        torsoPoint(rp3.x, rp3.y, tn2);
        rT.subVectors(tn1, tn2);
        if (rT.lengthSq() < 1e-12) rT.set(0, 1, 0);
        rT.normalize();
        torsoPoint(rp1.x, rp1.y, out);
        torsoNormalAt(rp1.x, rp1.y, rN);
        rN.addScaledVector(rT, -rN.dot(rT));
        if (rN.lengthSq() < 1e-10) rN.set(0, 0, 1);
        rN.normalize();
        rB.crossVectors(rT, rN).normalize();
        const ang = v * Math.PI * 2;
        const a = spow(Math.cos(ang), 0.40) * halfW;
        const b = spow(Math.sin(ang), 0.40) * halfT;
        out.addScaledVector(rN, offset + b).addScaledVector(rB, a);
      });
      remapUVs(geo, uRepeat, 0, 1, 0);
      beltGeos.push(geo);
      return curve;
    }

    for (const side of [-1, 1]) {
      /* shoulder strap: over the deltoid, across the chest, into the buckle */
      ribbon([
        [0.5 + side * 0.235, 0.995],
        [0.5 + side * 0.215, 0.945],
        [0.5 + side * 0.150, 0.840],
        [0.5 + side * 0.090, 0.680],
        [0.5 + side * 0.042, 0.520],
        [0.5 + side * 0.016, 0.420],
      ], 0.019, 0.0026, 0.011, 3.2);
      /* lap belt */
      ribbon([
        [0.5 + side * 0.262, 0.115],
        [0.5 + side * 0.215, 0.175],
        [0.5 + side * 0.130, 0.275],
        [0.5 + side * 0.048, 0.360],
        [0.5 + side * 0.016, 0.395],
      ], 0.016, 0.0026, 0.012, 2.2);
      /* anti-submarine strap */
      ribbon([
        [0.5 + side * 0.062, 0.005],
        [0.5 + side * 0.055, 0.110],
        [0.5 + side * 0.040, 0.260],
        [0.5 + side * 0.014, 0.375],
      ], 0.013, 0.0024, 0.012, 1.8);
    }

    const bm = mergePlain(beltGeos);
    if (bm) g.add(mk(ctx, bm, M.belt, 'body.harness', true));

    /* central rotary buckle */
    torsoPoint(0.5, 0.402, rp1);
    torsoNormalAt(0.5, 0.402, rN);
    _q1.setFromUnitVectors(new THREE.Vector3(0, 0, 1), rN);

    const bodyG = new THREE.ExtrudeGeometry(roundedRectShape(0.038, 0.038, 0.010), {
      depth: 0.014, bevelEnabled: true, bevelThickness: 0.0016, bevelSize: 0.0016,
      bevelSegments: 2, curveSegments: 4, steps: 1,
    });
    bodyG.translate(0, 0, 0.013);
    bodyG.applyQuaternion(_q1);
    bodyG.translate(rp1.x, rp1.y, rp1.z);
    metalGeos.push(bodyG);

    const knob = new THREE.CylinderGeometry(0.024, 0.026, 0.010, 16);
    knob.rotateX(Math.PI * 0.5);
    knob.translate(0, 0, 0.032);
    knob.applyQuaternion(_q1);
    knob.translate(rp1.x, rp1.y, rp1.z);
    metalGeos.push(knob);

    const lever = new THREE.BoxGeometry(0.034, 0.008, 0.006);
    lever.translate(0, 0, 0.039);
    lever.applyQuaternion(_q1);
    lever.translate(rp1.x, rp1.y, rp1.z);
    metalGeos.push(lever);

    /* strap adjusters */
    if (D.extras) {
      const adj = [
        [0.5 + 0.120, 0.760], [0.5 - 0.120, 0.760],
        [0.5 + 0.185, 0.205], [0.5 - 0.185, 0.205],
      ];
      for (let i = 0; i < adj.length; i++) {
        torsoPoint(adj[i][0], adj[i][1], rp2);
        torsoNormalAt(adj[i][0], adj[i][1], rN);
        _q1.setFromUnitVectors(new THREE.Vector3(0, 0, 1), rN);
        const sl = new THREE.BoxGeometry(0.042, 0.016, 0.005);
        sl.translate(0, 0, 0.015);
        sl.applyQuaternion(_q1);
        sl.translate(rp2.x, rp2.y, rp2.z);
        metalGeos.push(sl);
      }
    }

    const mm = mergePlain(metalGeos);
    if (mm) g.add(mk(ctx, mm, M.metal, 'body.buckle', true));
  });

  /* ---------------- thigh stubs (mostly hidden by the tub) ---------------- */
  ctx.step('body.thighs', () => {
    const legs = [];
    for (const side of [-1, 1]) {
      const sx = side * 0.082, ex = side * 0.112;
      const geo = buildSweep(
        (t, out) => {
          out.set(lerp(sx, ex, t), lerp(0.010, 0.105, t) + 0.03 * Math.sin(Math.PI * t) * 0.4, lerp(0.030, 0.400, t));
        },
        new THREE.Vector3(0, 1, 0),
        Math.max(5, D.armTube - 2), Math.max(7, D.armRadial), (t) => 0.088 - 0.016 * t, (t) => 0.082 - 0.014 * t,
        0.9, { capEnd: true });
      legs.push(geo);
    }
    const lm = mergePlain(legs);
    if (lm) g.add(mk(ctx, lm, M.suit, 'body.thighs', true));
  });

  /* ---------------- head pivot at the top of the spine ---------------- */
  const headPivot = new THREE.Group();
  headPivot.name = 'headPivot';
  spine.getPoint(1, cvp);
  headPivot.position.set(cvp.x, cvp.y, cvp.z);
  g.add(headPivot);

  return { group: g, headPivot, shoulderLocal, torsoMesh, torsoPoint, torsoNormalAt };
}

/* ===========================================================================
 * ARM — upper + forearm, posed every frame by the analytic 2-bone IK.
 * Bone geometry runs along +Y from the joint.
 * =========================================================================== */
function buildArm(ctx, side) {
  const D = ctx.D;
  const M = ctx.mats;
  const upperLen = 0.290;
  const foreLen = 0.265;

  const upper = new THREE.Group();
  upper.name = 'arm.upper';
  const fore = new THREE.Group();
  fore.name = 'arm.fore';

  ctx.step('arm.upper', () => {
    const geo = buildSweep(
      (t, out) => { out.set(0, t * upperLen, -0.006 * Math.sin(Math.PI * t)); },
      new THREE.Vector3(0, 0, 1),
      D.armTube, D.armRadial,
      (t) => 0.062 - 0.020 * t + 0.007 * gauss((t - 0.34) / 0.30),
      (t) => 0.058 - 0.018 * t + 0.006 * gauss((t - 0.34) / 0.30),
      0.92, { capStart: false, capEnd: false });
    swapUVs(geo);
    remapUVs(geo, 1, 0, -0.48, 1.0);
    upper.add(mk(ctx, geo, M.sleeve, 'arm.upper.mesh', true));
  });

  ctx.step('arm.fore', () => {
    const geo = buildSweep(
      (t, out) => { out.set(0, t * foreLen, 0.004 * Math.sin(Math.PI * t)); },
      new THREE.Vector3(0, 0, 1),
      D.armTube, D.armRadial,
      (t) => 0.050 - 0.020 * t + 0.008 * gauss((t - 0.16) / 0.22),
      (t) => 0.046 - 0.017 * t + 0.007 * gauss((t - 0.16) / 0.22),
      0.92, { capStart: false, capEnd: true });
    swapUVs(geo);
    remapUVs(geo, 1, 0, -0.52, 0.52);
    fore.add(mk(ctx, geo, M.sleeve, 'arm.fore.mesh', true));

    /* elbow pad */
    const pad = new THREE.SphereGeometry(1, Math.max(8, D.armRadial), Math.max(6, D.armRadial - 2));
    pad.scale(0.048, 0.044, 0.050);
    pad.translate(0, 0.012, -0.014);
    fore.add(mk(ctx, pad, M.sleeve, 'arm.elbowPad', true));
  });

  return {
    side, upper, fore, upperLen, foreLen,
    pole: new THREE.Vector3(side * 0.52, -0.80, -0.30).normalize(),
  };
}

/* ===========================================================================
 * GLOVE — parented straight to the wheel rim so it can never slip off it.
 * Local frame == wheel-spin frame: +X outboard, +Y grip axis, +Z away from
 * the driver.
 * =========================================================================== */
function buildGlove(ctx, side) {
  const D = ctx.D;
  const M = ctx.mats;
  const g = new THREE.Group();
  g.name = 'glove';
  g.position.set(side * GRIP_X, GRIP_Y, 0);

  ctx.step('glove', () => {
    const hand = [];
    const detail = [];

    /* palm block, outboard of the grip */
    const palm = new THREE.SphereGeometry(1, Math.max(10, D.fingerSeg + 2), Math.max(8, D.fingerSeg));
    palm.scale(0.025, 0.052, 0.036);
    palm.rotateZ(side * -0.16);
    palm.translate(side * 0.035, -0.004, -0.006);
    hand.push(palm);

    /* four finger rolls wrapping the grip */
    const fy = [-0.031, -0.012, 0.007, 0.026];
    const fr = [0.0106, 0.0112, 0.0106, 0.0092];
    for (let i = 0; i < 4; i++) {
      const arc = 3.32 - i * 0.06;
      const torus = new THREE.TorusGeometry(0.0198, fr[i], Math.max(5, D.fingerSeg >> 1), Math.max(10, D.fingerSeg + 2), arc);
      torus.rotateX(Math.PI * 0.5);
      const start = side > 0 ? -0.36 : (Math.PI - (arc - 0.36));
      torus.rotateY(-start);
      torus.translate(0, fy[i], 0);
      hand.push(torus);
    }

    /* thumb over the top of the grip, on the driver side */
    const thumb = new THREE.CapsuleGeometry(0.0098, 0.030, 3, Math.max(7, D.fingerSeg));
    thumb.rotateZ(side * 0.75);
    thumb.rotateX(-0.42);
    thumb.translate(side * 0.026, 0.036, -0.020);
    hand.push(thumb);

    /* knuckle padding on the back of the hand */
    for (let i = 0; i < 4; i++) {
      const pad = new THREE.BoxGeometry(0.011, 0.0125, 0.019);
      pad.translate(side * 0.055, -0.026 + i * 0.017, 0.001);
      detail.push({ geo: pad, color: ctx.colors.padColor });
    }
    const wristPad = new THREE.BoxGeometry(0.030, 0.016, 0.026);
    wristPad.rotateX(0.30);
    wristPad.translate(side * 0.042, -0.034, -0.030);
    detail.push({ geo: wristPad, color: ctx.colors.padColor });

    /* cuff ring where the sleeve meets the glove */
    const cuff = new THREE.TorusGeometry(0.034, 0.0105, 7, Math.max(12, D.fingerSeg + 4));
    _v1.set(side * 0.34, 0.20, -0.92).normalize();
    _q1.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _v1);
    cuff.applyQuaternion(_q1);
    cuff.translate(side * (WRIST_LOCAL[0] + 0.004), WRIST_LOCAL[1] + 0.004, WRIST_LOCAL[2] + 0.010);
    detail.push({ geo: cuff, color: ctx.colors.cuffColor });

    const hm = mergePlain(hand);
    if (hm) g.add(mk(ctx, hm, M.glove, 'glove.hand', true));
    const dm = mergeColored(detail);
    if (dm) g.add(mk(ctx, dm, M.colored, 'glove.detail', true));
  });

  return g;
}

/* ===========================================================================
 * STEERING WHEEL
 * =========================================================================== */
function buildWheel(ctx) {
  const D = ctx.D;
  const M = ctx.mats;
  const spin = new THREE.Group();
  spin.name = 'wheel.spin';
  /* the rim itself lives in its own sub-group; the gloves are parented to
   * `spin` alongside it so hiding the wheel never hides the driver's hands. */
  const rim = new THREE.Group();
  rim.name = 'wheel.rim';
  spin.add(rim);
  const front = WHEEL_T * 0.5;

  /* ---------------- carbon plate ---------------- */
  ctx.step('wheel.plate', () => {
    const shape = roundedRectShape(WHEEL_HW, WHEEL_HH, WHEEL_CORNER);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: WHEEL_T, bevelEnabled: true, bevelThickness: 0.0022, bevelSize: 0.0022,
      bevelSegments: 2, curveSegments: 8, steps: 1,
    });
    geo.translate(0, 0, -WHEEL_T * 0.5);
    rim.add(mk(ctx, geo, M.carbon, 'wheel.plate', true));
  });

  /* ---------------- printed face decal ---------------- */
  ctx.step('wheel.face', () => {
    const geo = new THREE.PlaneGeometry(WHEEL_HW * 2, WHEEL_HH * 2);
    geo.translate(0, 0, front + 0.0013);
    rim.add(mk(ctx, geo, M.face, 'wheel.face', false));
  });

  /* ---------------- LCD ---------------- */
  ctx.step('wheel.lcd', () => {
    const geo = new THREE.PlaneGeometry(LCD_W, LCD_H);
    geo.translate(LCD_CX, LCD_CY, front + 0.0021);
    const m = mk(ctx, geo, M.lcd, 'wheel.lcd', false);
    if (m) m.renderOrder = 2;
    rim.add(m);
  });

  /* ---------------- grips ---------------- */
  ctx.step('wheel.grips', () => {
    const gripGeos = [];
    const capGeos = [];
    for (const side of [-1, 1]) {
      const geo = buildSweep(
        (t, out) => {
          out.set(
            side * (GRIP_X - 0.006 + 0.014 * t * t),
            lerp(-0.076, 0.084, t),
            -0.011 - 0.006 * Math.sin(Math.PI * t)
          );
        },
        new THREE.Vector3(0, 0, 1),
        Math.max(8, D.armTube + 2), Math.max(9, D.armRadial + 1),
        (t) => 0.0175 - 0.0022 * gauss((t - 0.52) / 0.22),
        (t) => 0.0215 - 0.0040 * gauss((t - 0.52) / 0.20),
        0.75, { capStart: true, capEnd: true });
      gripGeos.push(geo);

      for (const ty of [-0.078, 0.086]) {
        const ring = new THREE.TorusGeometry(0.017, 0.0035, 6, 14);
        ring.rotateX(Math.PI * 0.5);
        ring.translate(side * (GRIP_X - 0.006 + (ty > 0 ? 0.014 : 0)), ty, -0.012);
        capGeos.push(ring);
      }
    }
    const gm = mergePlain(gripGeos);
    if (gm) rim.add(mk(ctx, gm, M.grip, 'wheel.grips', true));
    const cm = mergePlain(capGeos);
    if (cm) rim.add(mk(ctx, cm, M.accentSolid, 'wheel.gripCaps', true));
  });

  /* ---------------- rotary dials ---------------- */
  ctx.step('wheel.dials', () => {
    const bodies = [];
    const caps = [];
    const n = Math.min(D.dials, WHEEL_DIALS.length);
    for (let i = 0; i < n; i++) {
      const d = WHEEL_DIALS[i];
      const body = new THREE.CylinderGeometry(d.r, d.r * 1.04, 0.0115, 16);
      body.rotateX(Math.PI * 0.5);
      body.translate(d.x, d.y, front + 0.0058);
      bodies.push(body);
      /* knurling */
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2;
        const kn = new THREE.BoxGeometry(0.0016, 0.0016, 0.0115);
        kn.translate(d.x + Math.cos(a) * d.r, d.y + Math.sin(a) * d.r, front + 0.0058);
        bodies.push(kn);
      }
      const cap = new THREE.CylinderGeometry(d.r * 0.74, d.r * 0.74, 0.0032, 14);
      cap.rotateX(Math.PI * 0.5);
      cap.translate(d.x, d.y, front + 0.0128);
      caps.push({ geo: cap, color: d.c });
      const ptr = new THREE.BoxGeometry(0.0022, d.r * 0.66, 0.0034);
      ptr.translate(d.x, d.y + d.r * 0.36, front + 0.0142);
      caps.push({ geo: ptr, color: '#101216' });
    }
    const bm = mergePlain(bodies);
    if (bm) rim.add(mk(ctx, bm, M.metal, 'wheel.dials', true));
    const cm = mergeColored(caps);
    if (cm) rim.add(mk(ctx, cm, M.colored, 'wheel.dialCaps', true));
  });

  /* ---------------- buttons ---------------- */
  ctx.step('wheel.buttons', () => {
    const parts = [];
    const n = Math.min(D.buttons, WHEEL_BUTTONS.length);
    for (let i = 0; i < n; i++) {
      const b = WHEEL_BUTTONS[i];
      const body = new THREE.CylinderGeometry(b.r, b.r * 1.06, 0.0044, 12);
      body.rotateX(Math.PI * 0.5);
      body.translate(b.x, b.y, front + 0.0032);
      parts.push({ geo: body, color: b.c });
      const bez = new THREE.CylinderGeometry(b.r * 1.32, b.r * 1.32, 0.0026, 12);
      bez.rotateX(Math.PI * 0.5);
      bez.translate(b.x, b.y, front + 0.0018);
      parts.push({ geo: bez, color: '#191c21' });
    }
    const pm = mergeColored(parts);
    if (pm) rim.add(mk(ctx, pm, M.colored, 'wheel.buttons', true));
  });

  /* ---------------- shift + clutch paddles (behind the wheel) ---------------- */
  ctx.step('wheel.paddles', () => {
    const shift = [];
    const clutch = [];
    function paddle(a0, a1, R, halfH, z, halfT, list) {
      const geo = buildSurface(10, 8, (u, v, out) => {
        const a = lerp(a0, a1, u);
        const s = slabParams(v);
        const dx = Math.sin(a), dy = Math.cos(a);
        const rr = R + (s[0] - 0.5) * 2 * halfH;
        out.set(dx * rr, dy * rr, z + s[1] * halfT + 0.008 * Math.sin(Math.PI * u));
      });
      list.push(geo);
    }
    paddle(0.40, 1.16, 0.093, 0.017, -0.034, 0.0022, shift);
    paddle(-0.40, -1.16, 0.093, 0.017, -0.034, 0.0022, shift);
    if (D.extras) {
      paddle(2.05, 2.62, 0.090, 0.013, -0.041, 0.0020, clutch);
      paddle(-2.05, -2.62, 0.090, 0.013, -0.041, 0.0020, clutch);
    }
    const sm = mergePlain(shift);
    if (sm) rim.add(mk(ctx, sm, M.carbonThin, 'wheel.shiftPaddles', true));
    const cm = mergePlain(clutch);
    if (cm) rim.add(mk(ctx, cm, M.accentSolid, 'wheel.clutchPaddles', true));
  });

  /* ---------------- quick release + column stub ---------------- */
  ctx.step('wheel.hub', () => {
    const parts = [];
    const ring = new THREE.TorusGeometry(0.034, 0.0085, 8, 20);
    ring.translate(0, 0, -WHEEL_T * 0.5 - 0.012);
    parts.push(ring);
    const col = new THREE.CylinderGeometry(0.019, 0.023, 0.075, 14);
    col.rotateX(Math.PI * 0.5);
    col.translate(0, 0, -WHEEL_T * 0.5 - 0.048);
    parts.push(col);
    const flange = new THREE.CylinderGeometry(0.030, 0.030, 0.006, 14);
    flange.rotateX(Math.PI * 0.5);
    flange.translate(0, 0, -WHEEL_T * 0.5 - 0.004);
    parts.push(flange);
    const pm = mergePlain(parts);
    if (pm) rim.add(mk(ctx, pm, M.metal, 'wheel.hub', true));
  });

  const mount = new THREE.Group();
  mount.name = 'wheel.mount';
  mount.add(spin);
  return { mount, spin, parts: rim };
}

/* ===========================================================================
 * Fallbacks so the module never throws on missing data.
 * =========================================================================== */
const FALLBACK_TEAM = Object.freeze({
  id: 'apex', name: 'Apex Racing', short: 'APX', engine: 'Apex RA-1',
  colors: { primary: '#1b2440', secondary: '#0d1018', accent: '#f2c53d', trim: '#ffffff' },
  sponsors: ['ORAVAX', 'KINETIQ', 'NOVAFUEL'],
});
const FALLBACK_DRIVER = Object.freeze({
  num: 0, name: 'Test Driver', short: 'TST', country: 'XX',
  helmet: { base: '#1b2440', stripe: '#f2c53d', visor: '#151515' },
});
const EMPTY_STATE = Object.freeze({});

/* ===========================================================================
 * FACTORY
 * =========================================================================== */
export function createDriver(opts) {
  const o = opts || {};
  const driver = o.driver || FALLBACK_DRIVER;
  const team = o.team || driver.team || FALLBACK_TEAM;
  let quality = normalizeQuality(o.quality);
  let D = quality.detail;

  const group = new THREE.Group();
  group.name = 'driver:' + String(driver.short || driver.name || 'DRV');

  const geoms = [];
  const mats = [];
  const texs = [];
  const errors = [];
  const detailNodes = [];
  const shadowNodes = [];

  function reg(g) { if (g && geoms.indexOf(g) < 0) geoms.push(g); return g; }
  function regM(m) { if (m) mats.push(m); return m; }
  function regT(t) { if (t) texs.push(t); return t; }
  function step(name, fn) {
    try { return fn(); } catch (e) { errors.push(name + ': ' + ((e && e.message) || e)); return null; }
  }

  const tc = (team && team.colors) || FALLBACK_TEAM.colors;
  const colors = {
    primary: safeHex(tc.primary, '#1b2440'),
    secondary: safeHex(tc.secondary, '#0d1018'),
    accent: safeHex(tc.accent, '#f2c53d'),
    trim: safeHex(tc.trim, '#ffffff'),
    padColor: safeHex(tc.primary, '#1b2440'),
    cuffColor: safeHex(tc.accent, '#f2c53d'),
  };

  /* ------------------------------------------------------------------ *
   * Textures
   * ------------------------------------------------------------------ */
  const aniso = quality.anisotropy;
  const helmetTex = step('tex.helmet', () => regT(makeTexture(
    paintHelmet(D.helmetTex, driver, team, (team && team.sponsors) || FALLBACK_TEAM.sponsors),
    { wrapS: THREE.RepeatWrapping, anisotropy: aniso })));
  const visorTex = step('tex.visor', () => regT(makeTexture(
    paintVisor(256, safeHex((driver.helmet || {}).visor, '#161616')), { anisotropy: aniso })));
  const suitTex = step('tex.suit', () => regT(makeTexture(
    paintSuit(D.suitTex, team, driver), { wrapS: THREE.RepeatWrapping, anisotropy: aniso })));
  const sleeveTex = step('tex.sleeve', () => regT(makeTexture(
    paintSleeve(D.sleeveTex, team, (team && team.sponsors) || FALLBACK_TEAM.sponsors),
    { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: aniso })));
  const gloveTex = step('tex.glove', () => regT(makeTexture(
    paintGlove(256, team), { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: aniso })));
  const webbingTex = step('tex.belt', () => regT(makeTexture(
    paintWebbing(512, team), { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: aniso })));
  const faceTex = step('tex.face', () => regT(makeTexture(
    paintWheelFace(D.faceTex, team, driver, D), { anisotropy: aniso })));

  const carbonTex = step('tex.carbon', () => regT(acquireShared('apex:carbon:' + D.weave, () => {
    const t = makeTexture(makeCarbonCanvas(D.weave), {
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: aniso,
    });
    if (t) t.repeat.set(14, 14);
    return t;
  })));
  const fabricNrm = step('tex.fabricNormal', () => regT(acquireShared('apex:fabricN:' + D.weave, () => {
    const h = makeFabricHeight(D.weave);
    const n = h ? heightToNormalCanvas(h, 2.4) : null;
    const t = makeTexture(n, {
      data: true, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: aniso,
    });
    if (t) t.repeat.set(9, 9);
    return t;
  })));

  const lcd = step('tex.lcd', () => createLcd(D.lcdW, D.lcdH, team));
  const lcdTex = step('tex.lcdTexture', () => (lcd ? regT(makeTexture(lcd.canvas, { mipmaps: false })) : null));

  /* ------------------------------------------------------------------ *
   * Materials
   * ------------------------------------------------------------------ */
  const irid = D.iridescence;
  const M = {
    helmet: regM(new THREE.MeshPhysicalMaterial({
      map: helmetTex || null, color: helmetTex ? 0xffffff : new THREE.Color(colors.primary),
      roughness: 0.30, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.045,
      envMapIntensity: 1.15,
    })),
    liner: regM(new THREE.MeshStandardMaterial({
      color: 0x0a0b0d, roughness: 0.96, metalness: 0.0, side: THREE.BackSide,
    })),
    visor: regM(new THREE.MeshPhysicalMaterial({
      map: visorTex || null, color: 0xffffff, roughness: 0.055, metalness: 0.30,
      clearcoat: 1.0, clearcoatRoughness: 0.02, transparent: true, opacity: 0.87,
      iridescence: irid, iridescenceIOR: 1.55, side: THREE.DoubleSide,
      envMapIntensity: 1.6, depthWrite: true,
    })),
    tearoff: regM(new THREE.MeshPhysicalMaterial({
      color: 0xdfe6ee, roughness: 0.10, metalness: 0.0, clearcoat: 1.0,
      transparent: true, opacity: 0.11, side: THREE.DoubleSide, depthWrite: false,
    })),
    tearoffStrip: regM(new THREE.MeshPhysicalMaterial({
      color: 0xc9d3dd, roughness: 0.16, metalness: 0.0, clearcoat: 0.9,
      transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
    })),
    trim: regM(new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 0.68, metalness: 0.05 })),
    vent: regM(new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide })),
    metal: regM(new THREE.MeshStandardMaterial({ color: 0xb6bcc4, roughness: 0.30, metalness: 1.0, envMapIntensity: 1.2 })),
    suit: regM(new THREE.MeshPhysicalMaterial({
      map: suitTex || null, color: suitTex ? 0xffffff : new THREE.Color(colors.primary),
      normalMap: fabricNrm || null, roughness: 0.86, metalness: 0.0,
      sheen: 0.55, sheenColor: new THREE.Color(0xbfc7d2), sheenRoughness: 0.62,
    })),
    sleeve: regM(new THREE.MeshPhysicalMaterial({
      map: sleeveTex || null, color: sleeveTex ? 0xffffff : new THREE.Color(colors.primary),
      normalMap: fabricNrm || null, roughness: 0.86, metalness: 0.0,
      sheen: 0.55, sheenColor: new THREE.Color(0xbfc7d2), sheenRoughness: 0.62,
    })),
    balaclava: regM(new THREE.MeshStandardMaterial({
      color: 0x141519, normalMap: fabricNrm || null, roughness: 0.94, metalness: 0.0,
    })),
    belt: regM(new THREE.MeshStandardMaterial({
      map: webbingTex || null, color: webbingTex ? 0xffffff : new THREE.Color(colors.accent),
      roughness: 0.82, metalness: 0.0,
    })),
    glove: regM(new THREE.MeshStandardMaterial({
      map: gloveTex || null, color: gloveTex ? 0xffffff : 0x1a1c20,
      normalMap: fabricNrm || null, roughness: 0.74, metalness: 0.0,
    })),
    colored: regM(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.44, metalness: 0.08 })),
    accentSolid: regM(new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.accent), roughness: 0.42, metalness: 0.15 })),
    carbon: regM(new THREE.MeshPhysicalMaterial({
      map: carbonTex || null, color: carbonTex ? 0xffffff : 0x14171c,
      roughness: 0.24, metalness: 0.18, clearcoat: 0.85, clearcoatRoughness: 0.08,
    })),
    carbonThin: regM(new THREE.MeshPhysicalMaterial({
      map: carbonTex || null, color: carbonTex ? 0xffffff : 0x14171c,
      roughness: 0.26, metalness: 0.18, clearcoat: 0.8, clearcoatRoughness: 0.09,
      side: THREE.DoubleSide,
    })),
    grip: regM(new THREE.MeshStandardMaterial({
      color: 0x191b1f, normalMap: fabricNrm || null, roughness: 0.93, metalness: 0.0,
    })),
    face: regM(new THREE.MeshStandardMaterial({
      map: faceTex || null, transparent: true, alphaTest: 0.42, roughness: 0.36,
      metalness: 0.10, color: faceTex ? 0xffffff : 0x14171c,
    })),
    lcd: regM(new THREE.MeshBasicMaterial({
      map: lcdTex || null, color: lcdTex ? 0xffffff : 0x0a0f14, toneMapped: false,
    })),
  };

  const ctx = { D, quality, mats: M, reg, regM, regT, step, team, driver, colors };

  /* ------------------------------------------------------------------ *
   * Assembly
   * ------------------------------------------------------------------ */
  const HIP = new THREE.Vector3(0, 0.100, 0.060);
  const body = step('build.body', () => buildBody(ctx)) || {
    group: new THREE.Group(), headPivot: new THREE.Group(),
    shoulderLocal: [new THREE.Vector3(-0.185, 0.38, -0.30), new THREE.Vector3(0.185, 0.38, -0.30)],
    torsoMesh: null,
  };
  const torsoG = body.group;
  torsoG.position.copy(HIP);
  group.add(torsoG);

  const helmetRig = step('build.helmet', () => buildHelmet(ctx)) ||
    { group: new THREE.Group(), parts: {}, visor: null, eye: new THREE.Object3D() };
  helmetRig.group.position.set(0, 0.100, 0.018);
  helmetRig.group.rotation.x = -0.045;
  body.headPivot.add(helmetRig.group);
  const headBase = body.headPivot.position.clone();

  const arms = [];
  step('build.arms', () => {
    for (const side of [-1, 1]) {
      const arm = buildArm(ctx, side);
      group.add(arm.upper);
      group.add(arm.fore);
      arms.push(arm);
    }
  });

  const wheelRig = step('build.wheel', () => buildWheel(ctx)) ||
    { mount: new THREE.Group(), spin: new THREE.Group(), parts: new THREE.Group() };
  const wheelMount = wheelRig.mount;
  const wheelSpin = wheelRig.spin;
  const wheelParts = wheelRig.parts || wheelRig.spin;
  const wOff = o.wheelOffset || {};
  wheelMount.position.set(
    Number.isFinite(wOff.x) ? wOff.x : 0,
    Number.isFinite(wOff.y) ? wOff.y : 0.452,
    Number.isFinite(wOff.z) ? wOff.z : 0.325
  );
  wheelMount.rotation.x = Number.isFinite(o.wheelRake) ? o.wheelRake : 0.40;
  /* the mount is always parented (the hands hang off it); showWheel only
   * hides the rim, for cars whose own model already provides one. */
  group.add(wheelMount);
  wheelParts.visible = o.showWheel !== false;

  const gloves = [];
  step('build.gloves', () => {
    for (const side of [-1, 1]) {
      const gl = buildGlove(ctx, side);
      wheelSpin.add(gl);
      gloves.push(gl);
    }
  });

  /* collect optional-detail + shadow nodes for setQuality() */
  step('collect.nodes', () => {
    const OPTIONAL = ['tearoff', 'scoops', 'extractors', 'skirt', 'hansYoke', 'clutchPaddles',
      'gripCaps', 'dialCaps', 'liner', 'pivots'];
    group.traverse((n) => {
      if (!n.isMesh) return;
      shadowNodes.push(n);
      const nm = n.name || '';
      for (let i = 0; i < OPTIONAL.length; i++) {
        if (nm.indexOf(OPTIONAL[i]) >= 0) { detailNodes.push(n); break; }
      }
    });
  });

  /* ------------------------------------------------------------------ *
   * Pose state — all scratch allocated once, never inside update()
   * ------------------------------------------------------------------ */
  const p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), p3 = new THREE.Vector3();
  const p4 = new THREE.Vector3(), p5 = new THREE.Vector3(), p6 = new THREE.Vector3();
  const p7 = new THREE.Vector3(), p8 = new THREE.Vector3();
  const pm = new THREE.Matrix4();
  const bm = new THREE.Matrix4();
  const ZAXIS = new THREE.Vector3(0, 0, 1);

  const wheelSign = Number.isFinite(o.wheelSign) ? o.wheelSign : -1;
  const maxRpm = Number(o.maxRpm) > 0 ? Number(o.maxRpm) : 12800;
  const bobScale = Number.isFinite(o.bobScale) ? clamp(o.bobScale, 0, 3) : 1;

  let steer = 0;
  let time = 0;
  let lcdAccum = 0;
  let disposed = false;

  const sHeadRoll = { x: 0, v: 0 }, sHeadPitch = { x: 0, v: 0 }, sHeadYaw = { x: 0, v: 0 };
  const sHeadOX = { x: 0, v: 0 }, sHeadOY = { x: 0, v: 0 }, sHeadOZ = { x: 0, v: 0 };
  const sTorRoll = { x: 0, v: 0 }, sTorPitch = { x: 0, v: 0 };
  const sTorOX = { x: 0, v: 0 }, sTorOY = { x: 0, v: 0 }, sTorOZ = { x: 0, v: 0 };

  function spring(s, target, dt, freq, damp) {
    const k = freq * freq;
    const c = 2 * damp * freq;
    s.v += (k * (target - s.x) - c * s.v) * dt;
    s.x += s.v * dt;
    if (!Number.isFinite(s.x)) { s.x = target; s.v = 0; }
  }

  /* --- 2-bone analytic IK -------------------------------------------- */
  function setBone(obj, from, to, bendRef) {
    obj.position.copy(from);
    p6.subVectors(to, from);
    if (p6.lengthSq() < 1e-12) return;
    p6.normalize();                                  /* +Y of the bone */
    p7.copy(bendRef).addScaledVector(p6, -bendRef.dot(p6));
    if (p7.lengthSq() < 1e-10) {
      p7.set(-p6.y, p6.x, 0);
      if (p7.lengthSq() < 1e-10) p7.set(0, 0, 1);
    }
    p7.normalize();                                  /* +Z of the bone */
    p8.crossVectors(p6, p7).normalize();             /* +X = Y x Z     */
    bm.makeBasis(p8, p6, p7);
    obj.quaternion.setFromRotationMatrix(bm);
  }

  function solveArm(arm, S, T) {
    p3.subVectors(T, S);
    let d = p3.length();
    const a = arm.upperLen, b = arm.foreLen;
    const dmin = Math.abs(a - b) + 1e-4;
    const dmax = a + b - 1e-4;
    if (d < dmin) d = dmin; else if (d > dmax) d = dmax;
    if (p3.lengthSq() < 1e-12) p3.set(0, 0, 1); else p3.normalize();
    const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    p4.copy(arm.pole);
    p4.addScaledVector(p3, -p4.dot(p3));
    if (p4.lengthSq() < 1e-10) {
      p4.set(0, -1, 0).addScaledVector(p3, p3.y);
      if (p4.lengthSq() < 1e-10) p4.set(arm.side, 0, 0);
    }
    p4.normalize();
    p5.copy(S).addScaledVector(p3, a * cosA).addScaledVector(p4, a * sinA);
    setBone(arm.upper, S, p5, p4);
    setBone(arm.fore, p5, T, p4);
  }

  function applyPose() {
    const sn = clamp(steer / 2.4, -1, 1);
    const twist = -sn * 0.135;

    torsoG.rotation.set(sTorPitch.x, twist, sTorRoll.x);
    torsoG.position.set(HIP.x + sTorOX.x, HIP.y + sTorOY.x, HIP.z + sTorOZ.x);
    torsoG.updateMatrix();

    wheelSpin.rotation.z = wheelSign * steer;
    wheelSpin.updateMatrix();
    wheelMount.updateMatrix();
    pm.multiplyMatrices(wheelMount.matrix, wheelSpin.matrix);

    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const side = arm.side;
      p1.copy(body.shoulderLocal[i]);
      p1.y += side * sn * 0.018;
      p1.z += Math.abs(sn) * 0.006;
      p1.applyMatrix4(torsoG.matrix);
      p2.set(
        side * (GRIP_X + WRIST_LOCAL[0]),
        GRIP_Y + WRIST_LOCAL[1],
        WRIST_LOCAL[2]
      ).applyMatrix4(pm);
      solveArm(arm, p1, p2);
    }
  }

  /* --- LCD ------------------------------------------------------------ */
  function updateLcd(st, dt) {
    if (!lcd || !lcdTex || !lcd.draw) return;
    const rpm = Number(st.rpm) || 0;
    const lo = maxRpm * 0.62;
    const hi = maxRpm * 0.982;
    let f = (rpm - lo) / (hi - lo || 1);
    f = clamp(f, 0, 1);
    const leds = Math.round(f * LED_COUNT);
    const over = rpm >= hi;
    const flash = over ? (1 + ((time * 11) | 0) % 2) : 0;
    let gear = Math.round(Number(st.gear));
    if (!Number.isFinite(gear)) gear = 0;
    const spd = Math.round((Number(st.speed) || 0) * 3.6);
    const ersPct = Math.round(clamp((st.ers && Number(st.ers.charge)) || 0, 0, 1) * 20) * 5;
    const drs = st.drs ? 1 : 0;
    const lap = Math.max(1, Math.round(Number(st.lap) || 1));
    const pos = (typeof st.position === 'number') ? st.position
      : (Number.isFinite(st.racePosition) ? st.racePosition : 0);

    const urgent = (gear !== lcd.gear) || (flash !== lcd.flash) || (drs !== lcd.drs);
    lcdAccum += dt;
    /* gear/DRS changes jump the queue, everything else is throttled; a hard
     * floor bounds the canvas cost even if the sim feeds nonsense every frame */
    if (lcdAccum < (urgent ? 0.020 : 0.055)) return;

    if (gear !== lcd.gear || leds !== lcd.leds || spd !== lcd.spd || ersPct !== lcd.ers ||
      drs !== lcd.drs || flash !== lcd.flash || lap !== lcd.lap || pos !== lcd.pos) {
      lcd.gear = gear; lcd.leds = leds; lcd.spd = spd; lcd.ers = ersPct;
      lcd.drs = drs; lcd.flash = flash; lcd.lap = lap; lcd.pos = pos;
      lcd.draw(gear, leds, spd, ersPct, drs, flash, lap, pos);
      lcdTex.needsUpdate = true;
    }
    lcdAccum = 0;
  }

  /* --- public update -------------------------------------------------- */
  function update(state, dt) {
    if (disposed) return;
    const d = clamp(Number(dt) || 0.0166, 0.0002, 0.05);
    time += d;
    const st = state || EMPTY_STATE;

    const steerN = clamp(Number(st.steer) || 0, -1, 1);
    const brake = clamp(Number(st.brake) || 0, 0, 1);
    const thr = clamp(Number(st.throttle) || 0, 0, 1);
    const speed = Math.abs(Number(st.speed) || 0);
    const gf = st.gForce;

    /* magnitude from real g when available, sign from driver inputs so the
     * lean is always plausible regardless of the sim's g sign convention. */
    let latMag, lonMag;
    if (gf && Number.isFinite(gf.lat)) latMag = Math.min(1, Math.abs(gf.lat) / 4.2);
    else latMag = Math.min(1, Math.abs(steerN) * speed / 55);
    if (gf && Number.isFinite(gf.lon)) lonMag = Math.min(1, Math.abs(gf.lon) / 4.2);
    else lonMag = Math.min(1, Math.max(brake, thr * 0.55));

    const lat = (steerN >= 0 ? 1 : -1) * latMag;          /* +1 = cornering left  */
    const lon = ((brake - thr) >= 0 ? 1 : -1) * lonMag;   /* +1 = braking         */

    /* head: leans into the corner, pitches under braking, is shoved outboard */
    spring(sHeadRoll, -lat * 0.088 * bobScale, d, 10.5, 0.82);
    spring(sHeadYaw, lat * 0.062 * bobScale, d, 7.5, 0.88);
    spring(sHeadPitch, lon * 0.050 * bobScale, d, 9.5, 0.85);
    spring(sHeadOX, -lat * 0.0125 * bobScale, d, 11.0, 0.80);
    spring(sHeadOY, (-latMag * 0.005 - Math.max(0, lon) * 0.004) * bobScale, d, 12.0, 0.90);
    spring(sHeadOZ, lon * 0.011 * bobScale, d, 10.0, 0.84);

    /* torso: much stiffer, belted in */
    spring(sTorRoll, -lat * 0.030 * bobScale, d, 6.5, 0.92);
    spring(sTorPitch, lon * 0.019 * bobScale, d, 6.0, 0.92);
    spring(sTorOX, -lat * 0.0055 * bobScale, d, 6.5, 0.92);
    spring(sTorOY, -latMag * 0.0025 * bobScale, d, 7.0, 0.95);
    spring(sTorOZ, lon * 0.0055 * bobScale, d, 6.0, 0.92);

    /* chassis vibration — rpm, speed and any wheel that is unhappy */
    let rough = 0;
    const wheels = st.wheels;
    if (wheels && wheels.length) {
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        if (!w) continue;
        if (w.lockedUp) rough += 0.30;
        else if (w.spinning) rough += 0.16;
        const sf = w.surface;
        if (sf === 'kerb') rough += 0.42;
        else if (sf === 'gravel' || sf === 'grass') rough += 0.26;
      }
    }
    rough = Math.min(1.4, rough);
    const rpmN = clamp((Number(st.rpm) || 0) / maxRpm, 0, 1.1);
    const vib = (0.00075 + 0.0016 * rpmN * rpmN + 0.0013 * Math.min(1, speed / 85)
      + 0.0042 * rough) * bobScale;
    const jx = (Math.sin(time * 63.1) * 0.62 + Math.sin(time * 97.7) * 0.38) * vib;
    const jy = (Math.sin(time * 71.3) * 0.55 + Math.sin(time * 113.9) * 0.45) * vib;
    const jz = (Math.sin(time * 84.9) * 0.5 + Math.sin(time * 41.3) * 0.5) * vib * 0.7;
    const breath = Math.sin(time * 2.3) * 0.0022;

    body.headPivot.rotation.set(
      sHeadPitch.x + jy * 1.6,
      sHeadYaw.x + jx * 1.2,
      sHeadRoll.x + jx * 2.0
    );
    body.headPivot.position.set(
      headBase.x + sHeadOX.x + jx,
      headBase.y + sHeadOY.x + jy + breath * 0.4,
      headBase.z + sHeadOZ.x + jz
    );

    if (body.torsoMesh) {
      const bs = 1 + breath;
      body.torsoMesh.scale.set(bs, 1, 1 + breath * 0.75);
    }

    applyPose();
    updateLcd(st, d);
  }

  /* --- public setSteer ------------------------------------------------- */
  function setSteer(rad) {
    const r = Number(rad);
    steer = clamp(Number.isFinite(r) ? r : 0, -2.4, 2.4);
    if (!disposed) { try { applyPose(); } catch (e) { errors.push('setSteer: ' + e.message); } }
    return steer;
  }

  /* --- public setQuality ----------------------------------------------- */
  function setQuality(q) {
    if (disposed) return;
    try {
      quality = normalizeQuality(q);
      D = quality.detail;
      ctx.D = D;
      ctx.quality = quality;
      const rank = quality.rank;
      for (let i = 0; i < detailNodes.length; i++) detailNodes[i].visible = rank >= 1;
      for (let i = 0; i < shadowNodes.length; i++) shadowNodes[i].castShadow = quality.shadows;

      M.visor.iridescence = D.iridescence;
      M.visor.clearcoat = rank >= 1 ? 1.0 : 0.35;
      M.visor.roughness = rank >= 2 ? 0.055 : 0.12;
      M.helmet.clearcoat = rank >= 1 ? 1.0 : 0.30;
      M.carbon.clearcoat = rank >= 1 ? 0.85 : 0.2;
      M.carbonThin.clearcoat = rank >= 1 ? 0.80 : 0.2;

      const sheen = rank >= 2 ? 0.55 : 0.0;
      M.suit.sheen = sheen;
      M.sleeve.sheen = sheen;

      const nrm = rank >= 1 ? (fabricNrm || null) : null;
      const nrmMats = [M.suit, M.sleeve, M.glove, M.grip, M.balaclava];
      for (let i = 0; i < nrmMats.length; i++) {
        if (nrmMats[i].normalMap !== nrm) { nrmMats[i].normalMap = nrm; nrmMats[i].needsUpdate = true; }
      }
      for (let i = 0; i < texs.length; i++) if (texs[i]) texs[i].anisotropy = quality.anisotropy;

      M.visor.needsUpdate = true;
      M.helmet.needsUpdate = true;
      M.suit.needsUpdate = true;
      M.sleeve.needsUpdate = true;
    } catch (e) {
      errors.push('setQuality: ' + ((e && e.message) || e));
    }
  }

  /* --- misc ------------------------------------------------------------ */
  function setVisible(v) { group.visible = !!v; }
  function setHelmetVisible(v) { if (helmetRig.group) helmetRig.group.visible = !!v; }
  function setWheelVisible(v) { wheelParts.visible = !!v; }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { if (group.parent) group.parent.remove(group); } catch (e) {}
    for (let i = 0; i < geoms.length; i++) { try { geoms[i].dispose(); } catch (e) {} }
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      try {
        m.map = null; m.normalMap = null;
        m.dispose();
      } catch (e) {}
    }
    for (let i = 0; i < texs.length; i++) { try { releaseTexture(texs[i]); } catch (e) {} }
    geoms.length = 0; mats.length = 0; texs.length = 0;
    detailNodes.length = 0; shadowNodes.length = 0;
    try { group.clear(); } catch (e) {}
  }

  /* initial pose so the rig is correct before the first update() */
  step('pose.initial', () => { applyPose(); });
  step('quality.initial', () => { setQuality(o.quality); });

  return {
    group,
    update,
    setSteer,
    helmet: helmetRig.group,
    dispose,
    setQuality,

    /* extras — safe for the integrator to use, never required */
    head: body.headPivot,
    torso: torsoG,
    eye: helmetRig.eye,
    visor: helmetRig.visor,
    wheel: wheelMount,
    wheelSpin,
    wheelParts,
    gloves,
    arms,
    driver,
    team,
    errors,
    setVisible,
    setHelmetVisible,
    setWheelVisible,
    getSteer() { return steer; },
  };
}

export default createDriver;

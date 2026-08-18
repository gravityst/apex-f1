/**
 * APEX F1 — src/render/carModel.js
 * ---------------------------------------------------------------------------
 * Fully procedural, hyper-detailed modern-generation Formula 1 car.
 *
 * Nothing is loaded from disk: every vertex, every texel is generated in code.
 * The module is side-effect free at import time; all heavy resources are built
 * lazily on the first createCarModel() call and reference-counted so that a
 * twenty-car grid shares one set of geometry buffers and one set of textures
 * per livery.
 *
 * Coordinate contract (see ARCHITECTURE.md):
 *   - metres, Y up, right handed.
 *   - the model group origin sits on the ground plane (y = 0) at the
 *     longitudinal centre of the wheelbase.
 *   - +Z is forward.  Front axle at z = +1.80, rear axle at z = -1.80.
 *
 * Public API:
 *   createCarModel({ team, driver, quality }) -> CarModel
 *   createLiveryTexture(team, driver, size?)  -> { map, roughnessMap, normalMap }
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TYRE_COMPOUNDS } from '../game/teams.js';

/* ========================================================================== */
/*  Dimensions                                                                */
/* ========================================================================== */

export const DIM = Object.freeze({
  length: 5.63,
  width: 2.00,
  wheelbase: 3.60,
  frontAxleZ: 1.80,
  rearAxleZ: -1.80,
  noseTipZ: 2.62,
  frontWingLE: 2.90,
  rearMostZ: -2.73,
  floorY: 0.06,
  frontTyreR: 0.36,
  frontTyreW: 0.305,
  rearTyreR: 0.37,
  rearTyreW: 0.405,
  rimR: 0.2286,          // 18 inch
  frontTrack: 1.62,
  rearTrack: 1.55,
  frontHubX: 0.81,
  rearHubX: 0.775,
});

/** Distance thresholds used by updateLOD(). */
export const LOD_DISTANCES = Object.freeze([25, 80]);

const TIER_DETAIL = { low: 0.42, medium: 0.68, high: 1.0, ultra: 1.28 };
const TIER_TEXSIZE = { low: 512, medium: 1024, high: 2048, ultra: 2048 };
const TIER_CARBONSIZE = { low: 128, medium: 256, high: 512, ultra: 512 };

/* ========================================================================== */
/*  Module scope scratch — NEVER allocate inside update()                     */
/* ========================================================================== */

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
const _v3e = new THREE.Vector3();
const _mat4a = new THREE.Matrix4();
const _mat4b = new THREE.Matrix4();
const _colA = new THREE.Color();
const _colB = new THREE.Color();
const _UP = new THREE.Vector3(0, 1, 0);
const _FWD = new THREE.Vector3(0, 0, 1);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Sample an array of keyframe objects with Catmull-Rom interpolation on every
 * numeric field.  `f` is a floating point index into the key array.
 */
function sampleKeys(keys, f, out) {
  const n = keys.length;
  const i1 = clamp(Math.floor(f), 0, n - 1);
  const t = clamp(f - i1, 0, 1);
  const i0 = clamp(i1 - 1, 0, n - 1);
  const i2 = clamp(i1 + 1, 0, n - 1);
  const i3 = clamp(i1 + 2, 0, n - 1);
  const k0 = keys[i0], k1 = keys[i1], k2 = keys[i2], k3 = keys[i3];
  const o = out || {};
  for (const key in k1) {
    if (typeof k1[key] !== 'number') continue;
    o[key] = catmull(
      k0[key] !== undefined ? k0[key] : k1[key],
      k1[key],
      k2[key] !== undefined ? k2[key] : k1[key],
      k3[key] !== undefined ? k3[key] : k2[key] !== undefined ? k2[key] : k1[key],
      t);
  }
  return o;
}

/* ========================================================================== */
/*  Geometry toolkit                                                          */
/* ========================================================================== */

/** Guarantee an index buffer so mergeGeometries() never sees a mixed set. */
function ensureIndexed(geom) {
  if (!geom) return geom;
  if (geom.index === null) {
    const count = geom.getAttribute('position').count;
    const arr = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) arr[i] = i;
    geom.setIndex(new THREE.BufferAttribute(arr, 1));
  }
  if (!geom.getAttribute('uv')) {
    const count = geom.getAttribute('position').count;
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (!geom.getAttribute('normal')) geom.computeVertexNormals();
  // merge safety: drop anything exotic
  for (const name in geom.attributes) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geom.deleteAttribute(name);
  }
  geom.clearGroups();
  return geom;
}

/** Reverse triangle winding in place. */
function reverseWinding(geom) {
  const idx = geom.index;
  if (!idx) return geom;
  const a = idx.array;
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t;
  }
  idx.needsUpdate = true;
  return geom;
}

/** Mirror a geometry across the YZ plane, keeping normals and winding sane. */
function mirrorX(geom) {
  const g = geom.clone();
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
  if (nor) for (let i = 0; i < nor.count; i++) nor.setX(i, -nor.getX(i));
  pos.needsUpdate = true;
  if (nor) nor.needsUpdate = true;
  reverseWinding(g);
  g.computeBoundingSphere();
  return g;
}

/**
 * Loft a tube-like surface through a list of cross sections.
 * Each section is { pts: [[x,y], ...] (identical length, closed loop), m: Matrix4 }.
 * Winding is auto-corrected so that face normals point away from the section
 * centroid axis — that removes an entire class of "inside out" bugs.
 */
function loft(sections, opts) {
  const o = opts || {};
  const S = sections.length;
  if (S < 2) return null;
  const N = sections[0].pts.length;
  if (N < 3) return null;
  const cols = N + 1;
  const vertCount = S * cols;
  const pos = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const cen = new Float32Array(S * 3);
  const rect = o.uvRect || [0, 0, 1, 1];
  const uSpan = rect[2] - rect[0];
  const vSpan = rect[3] - rect[1];
  const vFlip = !!o.uvFlipV;

  let vi = 0, ui = 0;
  for (let i = 0; i < S; i++) {
    const sec = sections[i];
    const m = sec.m;
    let cx = 0, cy = 0, cz = 0;
    let vv = S === 1 ? 0 : i / (S - 1);
    if (vFlip) vv = 1 - vv;
    for (let j = 0; j < cols; j++) {
      const src = sec.pts[j % N];
      _v3a.set(src[0], src[1], 0);
      if (m) _v3a.applyMatrix4(m);
      pos[vi] = _v3a.x; pos[vi + 1] = _v3a.y; pos[vi + 2] = _v3a.z;
      vi += 3;
      if (j < N) { cx += _v3a.x; cy += _v3a.y; cz += _v3a.z; }
      uvs[ui] = rect[0] + (j / N) * uSpan;
      uvs[ui + 1] = rect[1] + vv * vSpan;
      ui += 2;
    }
    cen[i * 3] = cx / N; cen[i * 3 + 1] = cy / N; cen[i * 3 + 2] = cz / N;
  }

  const triCount = (S - 1) * N * 2;
  const idx = vertCount > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let k = 0;
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = (i + 1) * cols + j + 1;
      const d = c - 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = a; idx[k++] = d; idx[k++] = c;
    }
  }

  // Orientation vote.
  let vote = 0;
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    _v3a.set(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
    _v3b.set(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]);
    _v3c.crossVectors(_v3a, _v3b);
    const row = Math.min(S - 2, Math.floor(t / (N * 2)));
    _v3d.set(
      (pos[a] + pos[b] + pos[c]) / 3 - cen[row * 3],
      (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3 - cen[row * 3 + 1],
      (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3 - cen[row * 3 + 2]);
    vote += _v3c.dot(_v3d);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  if (vote < 0) reverseWinding(g);
  g.computeVertexNormals();

  const pieces = [g];
  if (o.capStart) pieces.push(capGeometry(sections[0], rect, true, vote < 0));
  if (o.capEnd) pieces.push(capGeometry(sections[S - 1], rect, false, vote < 0));
  if (pieces.length === 1) return g;
  return mergeSafe(pieces);
}

/** Flat fan cap for one end of a loft. */
function capGeometry(sec, rect, isStart, flipped) {
  const N = sec.pts.length;
  const pos = new Float32Array((N + 1) * 3);
  const uvs = new Float32Array((N + 1) * 2);
  let cx = 0, cy = 0, cz = 0;
  for (let j = 0; j < N; j++) {
    _v3a.set(sec.pts[j][0], sec.pts[j][1], 0);
    if (sec.m) _v3a.applyMatrix4(sec.m);
    pos[j * 3] = _v3a.x; pos[j * 3 + 1] = _v3a.y; pos[j * 3 + 2] = _v3a.z;
    cx += _v3a.x; cy += _v3a.y; cz += _v3a.z;
    uvs[j * 2] = rect[0] + (j / N) * (rect[2] - rect[0]);
    uvs[j * 2 + 1] = rect[1] + (isStart ? 0 : 1) * (rect[3] - rect[1]);
  }
  pos[N * 3] = cx / N; pos[N * 3 + 1] = cy / N; pos[N * 3 + 2] = cz / N;
  uvs[N * 2] = rect[0] + 0.5 * (rect[2] - rect[0]);
  uvs[N * 2 + 1] = rect[1] + (isStart ? 0.02 : 0.98) * (rect[3] - rect[1]);

  const idx = new Uint16Array(N * 3);
  let k = 0;
  const forward = isStart !== flipped;
  for (let j = 0; j < N; j++) {
    const a = j, b = (j + 1) % N;
    if (forward) { idx[k++] = N; idx[k++] = b; idx[k++] = a; }
    else { idx[k++] = N; idx[k++] = a; idx[k++] = b; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

/** Merge with a defensive fallback: on failure return the first geometry. */
function mergeSafe(list) {
  const clean = [];
  for (let i = 0; i < list.length; i++) if (list[i]) clean.push(ensureIndexed(list[i]));
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  try {
    const merged = mergeGeometries(clean, false);
    if (merged) {
      for (let i = 0; i < clean.length; i++) clean[i].dispose();
      return merged;
    }
  } catch (e) { /* fall through */ }
  return clean[0];
}

/** Build a section matrix that puts a 2D profile in a plane. */
function sectionMatrix(origin, xAxis, yAxis, zAxis, out) {
  const m = out || new THREE.Matrix4();
  m.set(
    xAxis.x, yAxis.x, zAxis.x, origin.x,
    xAxis.y, yAxis.y, zAxis.y, origin.y,
    xAxis.z, yAxis.z, zAxis.z, origin.z,
    0, 0, 0, 1);
  return m;
}

/** Section matrix for a plane normal to +Z at depth z (identity rotation). */
function zSection(z) {
  return new THREE.Matrix4().makeTranslation(0, 0, z);
}

/**
 * Remap UVs by planar projection from world position, optionally mirroring the
 * u axis on back faces so lettering reads correctly on both sides of a fin.
 */
function planarUV(geom, uAxis, vAxis, rect, opt) {
  const o = opt || {};
  const pos = geom.getAttribute('position');
  const nor = geom.getAttribute('normal');
  const n = pos.count;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const uKey = uAxis, vKey = vAxis;
  const get = (i, key) => (key === 'x' ? pos.getX(i) : key === 'y' ? pos.getY(i) : pos.getZ(i));
  for (let i = 0; i < n; i++) {
    const a = get(i, uKey), b = get(i, vKey);
    if (a < u0) u0 = a; if (a > u1) u1 = a;
    if (b < v0) v0 = b; if (b > v1) v1 = b;
  }
  if (o.uMin !== undefined) u0 = o.uMin;
  if (o.uMax !== undefined) u1 = o.uMax;
  if (o.vMin !== undefined) v0 = o.vMin;
  if (o.vMax !== undefined) v1 = o.vMax;
  const du = (u1 - u0) || 1;
  const dv = (v1 - v0) || 1;
  let uv = geom.getAttribute('uv');
  if (!uv) { uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2); geom.setAttribute('uv', uv); }
  const mirrorAxis = o.mirrorByNormal;
  for (let i = 0; i < n; i++) {
    let a = (get(i, uKey) - u0) / du;
    let b = (get(i, vKey) - v0) / dv;
    if (o.flipU) a = 1 - a;
    if (o.flipV) b = 1 - b;
    if (mirrorAxis && nor) {
      const nv = mirrorAxis === 'x' ? nor.getX(i) : mirrorAxis === 'y' ? nor.getY(i) : nor.getZ(i);
      if (nv < 0) a = 1 - a;
    }
    uv.setXY(i, rect[0] + a * (rect[2] - rect[0]), rect[1] + b * (rect[3] - rect[1]));
  }
  uv.needsUpdate = true;
  return geom;
}

/** Uniform UV fill — used for material zones that must sample a flat swatch. */
function fillUV(geom, u, v) {
  const pos = geom.getAttribute('position');
  const n = pos.count;
  const uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2);
  for (let i = 0; i < n; i++) uv.setXY(i, u, v);
  geom.setAttribute('uv', uv);
  return geom;
}

/* -------------------------------------------------------------------------- */
/*  Profiles                                                                  */
/* -------------------------------------------------------------------------- */

/** Quadratic bezier sampling helper writing [x,y] pairs into an array. */
function pushQuad(out, x0, y0, cx, cy, x1, y1, steps, includeEnd) {
  const last = includeEnd ? steps : steps - 1;
  for (let i = 0; i <= last; i++) {
    const t = i / steps;
    const it = 1 - t;
    out.push([
      it * it * x0 + 2 * it * t * cx + t * t * x1,
      it * it * y0 + 2 * it * t * cy + t * t * y1,
    ]);
  }
}

function pushLine(out, x0, y0, x1, y1, steps, includeEnd) {
  const last = includeEnd ? steps : steps - 1;
  for (let i = 0; i <= last; i++) {
    const t = i / steps;
    out.push([lerp(x0, x1, t), lerp(y0, y1, t)]);
  }
}

/**
 * Counts for the hull cross section.  The same counts must be used at every
 * station so corresponding points line up.
 */
function hullCounts(detail) {
  return {
    nb: Math.max(2, Math.round(3 * detail)),
    ns: Math.max(4, Math.round(10 * detail)),
    nsh: Math.max(2, Math.round(4 * detail)),
    nc: Math.max(2, Math.round(3 * detail)),
    nf: Math.max(1, Math.round(2 * detail)),
  };
}

/**
 * Closed cross-section of the survival cell / nose / engine cover.
 * Traverses bottom-centre -> right flank -> shoulder -> into the cockpit ->
 * top-centre, then mirrors.  A zero cockpit depth degenerates cleanly into a
 * plain crowned deck, so the same generator serves the whole car.
 */
function hullProfile(p, c) {
  const pts = [];
  const yBot = p.yBot, yTop = p.yTop, hw = p.hw;
  const h = Math.max(0.02, yTop - yBot);
  const yMid = yBot + 0.40 * h;
  const ySh = yTop - 0.17 * h;
  const botHW = Math.min(p.botHW, hw * 0.94);
  const shHW = Math.min(p.shHW, hw * 0.98);
  const cpHW = Math.min(p.cpHW, shHW * 0.99);
  const dep = Math.max(0, p.cpDepth);
  const sag = dep > 0.005 ? 0.014 : 0;

  // 1. flat floor, centre -> outer
  pushLine(pts, 0, yBot, botHW, yBot + 0.004, c.nb, false);
  // 2. lower corner radius out to max beam
  pushQuad(pts, botHW, yBot + 0.004, hw * 0.99, yBot + 0.02, hw, yMid, Math.max(2, Math.round(c.ns * 0.45)), false);
  // 3. flank rising to the shoulder line
  const ns3 = c.ns - Math.max(2, Math.round(c.ns * 0.45));
  pushQuad(pts, hw, yMid, hw * 1.005, yTop - 0.30 * h, shHW, ySh, Math.max(2, ns3), false);
  // 4. crowned deck to the coaming
  pushQuad(pts, shHW, ySh, (shHW + cpHW) * 0.5, yTop + 0.012, cpHW, yTop, c.nsh, false);
  // 5. dip into the cockpit (or flat run when closed)
  pushQuad(pts, cpHW, yTop, cpHW * 0.96, yTop - dep * 0.62, cpHW * 0.64, yTop - dep, c.nc, false);
  // 6. cockpit floor to the centreline
  pushLine(pts, cpHW * 0.64, yTop - dep, 0, yTop - dep - sag, c.nf, true);

  const M = pts.length;
  for (let i = M - 2; i >= 1; i--) pts.push([-pts[i][0], pts[i][1]]);
  return pts;
}

/** Rounded box profile used for sidepods, mirrors, crash structures. */
function roundedBoxProfile(hw, hh, r, cx, cy, seg) {
  const pts = [];
  const rr = Math.min(r, Math.min(hw, hh) * 0.95);
  const n = Math.max(2, seg);
  const corners = [
    [hw - rr, -(hh - rr), 1, -1],
    [hw - rr, hh - rr, 1, 1],
    [-(hw - rr), hh - rr, -1, 1],
    [-(hw - rr), -(hh - rr), -1, -1],
  ];
  const base = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
  for (let k = 0; k < 4; k++) {
    const a0 = base[k];
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push([cx + corners[k][0] + Math.cos(a) * rr, cy + corners[k][1] + Math.sin(a) * rr]);
    }
  }
  return pts;
}

/**
 * Asymmetric sidepod cross section (right hand side, x > 0).
 * Includes the signature undercut: the lower flank tucks sharply inboard.
 */
function sidepodProfile(p, seg) {
  const pts = [];
  const n = Math.max(2, seg);
  const xo = p.xOut, xi = p.xIn, yt = p.yTop, yb = p.yBot, xu = p.xUnd;
  const crown = p.crown;
  const yMid = lerp(yb, yt, 0.62);
  // underside, inboard -> undercut lip
  pushLine(pts, xi, yb, xu, yb - 0.004, Math.max(2, Math.round(n * 0.7)), false);
  // undercut rising to the outer flank
  pushQuad(pts, xu, yb - 0.004, xo * 1.01, yMid - 0.10, xo, yMid, n, false);
  // outer flank up to the shoulder
  pushQuad(pts, xo, yMid, xo * 1.005, yt - 0.05, xo * 0.93, yt, Math.max(2, Math.round(n * 0.8)), false);
  // crowned upper deck inboard
  pushQuad(pts, xo * 0.93, yt, xo * 0.55, yt + crown, xi, yt - 0.01, Math.max(3, Math.round(n * 1.3)), false);
  // inboard face down to the floor
  pushLine(pts, xi, yt - 0.01, xi, yb, Math.max(2, Math.round(n * 0.7)), false);
  return pts;
}

/**
 * NACA-style aerofoil, closed loop starting at the trailing edge, over the
 * suction side, round the leading edge and back.  x is 0..1 of chord.
 */
function airfoilProfile(steps, thickness, camber, camberPos, inverted) {
  const n = Math.max(6, steps);
  const t = thickness;
  const m = camber;
  const pC = camberPos || 0.42;
  const upper = [];
  const lower = [];
  for (let i = 0; i <= n; i++) {
    const beta = (i / n) * Math.PI;
    const x = 0.5 * (1 - Math.cos(beta));
    const xs = Math.max(1e-5, x);
    const yt = 5 * t * (0.2969 * Math.sqrt(xs) - 0.1260 * xs - 0.3516 * xs * xs +
      0.2843 * xs * xs * xs - 0.1015 * xs * xs * xs * xs);
    let yc, dyc;
    if (x < pC) {
      yc = (m / (pC * pC)) * (2 * pC * x - x * x);
      dyc = (2 * m / (pC * pC)) * (pC - x);
    } else {
      const q = 1 - pC;
      yc = (m / (q * q)) * ((1 - 2 * pC) + 2 * pC * x - x * x);
      dyc = (2 * m / (q * q)) * (pC - x);
    }
    const th = Math.atan(dyc);
    upper.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lower.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  const pts = [];
  for (let i = n; i >= 1; i--) pts.push(upper[i]);
  for (let i = 0; i <= n - 1; i++) pts.push(lower[i]);
  if (inverted) for (let i = 0; i < pts.length; i++) pts[i] = [pts[i][0], -pts[i][1]];
  return pts;
}

/** Flattened strut cross-section (streamlined tube). */
function strutProfile(chord, thick, seg) {
  const pts = [];
  const n = Math.max(6, seg);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // super-ellipse gives a proper aero teardrop rather than a plain tube
    const k = 0.62;
    pts.push([
      Math.sign(c) * Math.pow(Math.abs(c), k) * chord * 0.5,
      Math.sign(s) * Math.pow(Math.abs(s), k) * thick * 0.5,
    ]);
  }
  return pts;
}

/**
 * Streamlined structural member between two points.  Cross-section long axis is
 * aligned with the airflow (world Z) as far as the member orientation allows.
 */
function strutGeometry(from, to, chord, thick, opts) {
  const o = opts || {};
  const seg = o.seg || 8;
  const steps = o.steps || 1;
  _v3a.subVectors(to, from);
  const len = _v3a.length();
  if (len < 1e-4) return null;
  const axis = _v3b.copy(_v3a).multiplyScalar(1 / len);
  // chord direction: streamwise component orthogonal to the member axis
  _v3c.copy(_FWD).addScaledVector(axis, -_FWD.dot(axis));
  if (_v3c.lengthSq() < 1e-6) _v3c.copy(_UP).addScaledVector(axis, -_UP.dot(axis));
  _v3c.normalize();
  _v3d.crossVectors(axis, _v3c).normalize();
  const prof = strutProfile(chord, thick, seg);
  const sections = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    _v3e.copy(from).addScaledVector(_v3a, t);
    const taper = o.taper ? lerp(1, o.taper, t) : 1;
    const p = taper === 1 ? prof : prof.map((q) => [q[0] * taper, q[1] * taper]);
    sections.push({ pts: p, m: sectionMatrix(_v3e, _v3c, _v3d, axis) });
  }
  return loft(sections, { capStart: true, capEnd: true, uvRect: o.uvRect });
}

/** Parallel-transport frames along a polyline — no Frenet twist artefacts. */
function framesAlongPoints(points, upHint) {
  const n = points.length;
  const tangents = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    tangents.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  const normals = [];
  const binormals = [];
  let ref = (upHint || _UP).clone();
  if (Math.abs(ref.dot(tangents[0])) > 0.98) ref.set(1, 0, 0);
  let nrm = new THREE.Vector3().crossVectors(tangents[0], ref).normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const t0 = tangents[i - 1], t1 = tangents[i];
      const ax = new THREE.Vector3().crossVectors(t0, t1);
      const l = ax.length();
      if (l > 1e-6) {
        ax.multiplyScalar(1 / l);
        const ang = Math.acos(clamp(t0.dot(t1), -1, 1));
        nrm = nrm.clone().applyAxisAngle(ax, ang).normalize();
      } else nrm = nrm.clone();
    }
    normals.push(nrm);
    binormals.push(new THREE.Vector3().crossVectors(tangents[i], nrm).normalize());
  }
  return { tangents, normals, binormals };
}

/** Sweep a 2D profile along a polyline path. */
function sweepGeometry(points, profileFn, opts) {
  const o = opts || {};
  if (points.length < 2) return null;
  const fr = framesAlongPoints(points, o.up);
  const sections = [];
  for (let i = 0; i < points.length; i++) {
    const t = i / (points.length - 1);
    const pts = profileFn(t, i);
    if (!pts) return null;
    sections.push({ pts, m: sectionMatrix(points[i], fr.normals[i], fr.binormals[i], fr.tangents[i]) });
  }
  return loft(sections, { capStart: o.capStart !== false, capEnd: o.capEnd !== false, uvRect: o.uvRect });
}

/** Resample a Catmull-Rom curve into a point list. */
function curvePoints(ctrl, count) {
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', 0.5);
  return curve.getSpacedPoints(Math.max(2, count));
}

/* ========================================================================== */
/*  Procedural texture generation (canvas 2D, no network, cached)             */
/* ========================================================================== */

function hasCanvas() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function texFrom(canvas, opts) {
  const o = opts || {};
  const t = new THREE.CanvasTexture(canvas);
  // Every atlas in this module is authored with v = 0 at the TOP of the canvas,
  // which is the opposite of three's default image orientation.  Without this
  // the whole atlas samples one band too low and all lettering comes out
  // mirrored, because flipping v reverses the handedness of the UV frame.
  t.flipY = false;
  t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  t.wrapS = o.wrap || THREE.RepeatWrapping;
  t.wrapT = o.wrapT || o.wrap || THREE.RepeatWrapping;
  t.anisotropy = o.aniso || 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  if (o.repeat) t.repeat.set(o.repeat[0], o.repeat[1]);
  t.needsUpdate = true;
  return t;
}

/**
 * Sobel a greyscale height canvas into a tangent space normal map canvas.
 * Written as a flat typed array pass: a 2048 square tile is several million
 * samples, so per-pixel closures are not affordable even at load time.
 */
function heightToNormal(src, strength) {
  const w = src.width, h = src.height;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const data = sctx.getImageData(0, 0, w, h).data;
  const dst = makeCanvas(w, h);
  const dctx = dst.getContext('2d');
  const out = dctx.createImageData(w, h);
  const o = out.data;
  const s = (strength === undefined ? 2.0 : strength) / 255;
  for (let y = 0; y < h; y++) {
    const rowM = (y === 0 ? h - 1 : y - 1) * w;
    const rowP = (y === h - 1 ? 0 : y + 1) * w;
    const row0 = y * w;
    for (let x = 0; x < w; x++) {
      const xm = x === 0 ? w - 1 : x - 1;
      const xp = x === w - 1 ? 0 : x + 1;
      const tl = data[(rowM + xm) << 2], t = data[(rowM + x) << 2], tr = data[(rowM + xp) << 2];
      const l = data[(row0 + xm) << 2], r = data[(row0 + xp) << 2];
      const bl = data[(rowP + xm) << 2], b = data[(rowP + x) << 2], br = data[(rowP + xp) << 2];
      let nx = -((tr + 2 * r + br) - (tl + 2 * l + bl)) * s;
      let ny = -((bl + 2 * b + br) - (tl + 2 * t + tr)) * s;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (row0 + x) << 2;
      o[i] = (nx * 0.5 + 0.5) * 255;
      o[i + 1] = (ny * 0.5 + 0.5) * 255;
      o[i + 2] = (nz * 0.5 + 0.5) * 255;
      o[i + 3] = 255;
    }
  }
  dctx.putImageData(out, 0, 0);
  return dst;
}

/** Film grain in a single getImageData / putImageData pass. */
function noiseOverlay(ctx, w, h, amount, scale, seed) {
  try {
    const img = ctx.getImageData(0, 0, w, h);
    const dta = img.data;
    const rnd = mulberry32(seed || 1);
    const step = Math.max(1, Math.floor(scale || 2));
    const amt = amount * 255;
    for (let y = 0; y < h; y += step) {
      const ylim = Math.min(step, h - y);
      for (let x = 0; x < w; x += step) {
        const v = (rnd() - 0.5) * amt;
        const xlim = Math.min(step, w - x);
        for (let dy = 0; dy < ylim; dy++) {
          let i = (((y + dy) * w) + x) << 2;
          for (let dx = 0; dx < xlim; dx++, i += 4) {
            let a = dta[i] + v; dta[i] = a < 0 ? 0 : a > 255 ? 255 : a;
            a = dta[i + 1] + v; dta[i + 1] = a < 0 ? 0 : a > 255 ? 255 : a;
            a = dta[i + 2] + v; dta[i + 2] = a < 0 ? 0 : a > 255 ? 255 : a;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  } catch (e) { /* grain is cosmetic */ }
}

/* ------------------------------ carbon fibre ------------------------------ */

const _carbonCache = new Map();

function acquireCarbon(size) {
  const key = 'c' + size;
  let e = _carbonCache.get(key);
  if (e) { e.refs++; return e.set; }
  const set = buildCarbonSet(size);
  e = { refs: 1, set };
  _carbonCache.set(key, e);
  return set;
}

function releaseCarbon(size) {
  const key = 'c' + size;
  const e = _carbonCache.get(key);
  if (!e) return;
  if (--e.refs > 0) return;
  disposeTexSet(e.set);
  _carbonCache.delete(key);
}

function disposeTexSet(set) {
  if (!set) return;
  for (const k in set) {
    const t = set[k];
    if (t && typeof t.dispose === 'function') t.dispose();
  }
}

/** 2x2 twill weave, generated as height then converted to normal + roughness. */
function buildCarbonSet(size) {
  if (!hasCanvas()) return { map: null, normalMap: null, roughnessMap: null };
  try {
    const tows = 16;                       // tows per tile edge
    const cell = size / tows;
    const height = makeCanvas(size, size);
    const hc = height.getContext('2d');
    hc.fillStyle = '#4a4a4a';
    hc.fillRect(0, 0, size, size);

    const color = makeCanvas(size, size);
    const cc = color.getContext('2d');
    cc.fillStyle = '#0d0f12';
    cc.fillRect(0, 0, size, size);

    const rough = makeCanvas(size, size);
    const rc = rough.getContext('2d');
    rc.fillStyle = '#595959';
    rc.fillRect(0, 0, size, size);

    const pad = cell * 0.06;
    for (let r = 0; r < tows; r++) {
      for (let c = 0; c < tows; c++) {
        // 2/2 twill: warp floats when ((r + c) mod 4) < 2
        const warpOver = (((r + c) % 4) < 2);
        const x = c * cell, y = r * cell;
        const vertical = warpOver;
        const g = vertical
          ? hc.createLinearGradient(x + pad, 0, x + cell - pad, 0)
          : hc.createLinearGradient(0, y + pad, 0, y + cell - pad);
        g.addColorStop(0, '#3a3a3a');
        g.addColorStop(0.5, warpOver ? '#e2e2e2' : '#c8c8c8');
        g.addColorStop(1, '#3a3a3a');
        hc.fillStyle = g;
        hc.fillRect(x, y, cell, cell);

        const g2 = vertical
          ? cc.createLinearGradient(x, 0, x + cell, 0)
          : cc.createLinearGradient(0, y, 0, y + cell);
        g2.addColorStop(0, '#06070a');
        g2.addColorStop(0.42, warpOver ? '#252a33' : '#1c2028');
        g2.addColorStop(0.6, warpOver ? '#2c323d' : '#20242c');
        g2.addColorStop(1, '#06070a');
        cc.fillStyle = g2;
        cc.fillRect(x, y, cell, cell);

        rc.fillStyle = warpOver ? '#4e4e4e' : '#606060';
        rc.fillRect(x, y, cell, cell);
        rc.fillStyle = 'rgba(0,0,0,0.18)';
        if (vertical) rc.fillRect(x + cell * 0.42, y, cell * 0.16, cell);
        else rc.fillRect(x, y + cell * 0.42, cell, cell * 0.16);
      }
    }
    // resin sheen speckle
    noiseOverlay(cc, size, size, 0.05, 2, 7);
    noiseOverlay(rc, size, size, 0.10, 2, 11);

    const normal = heightToNormal(height, 1.4);
    const set = {
      map: texFrom(color, { srgb: true, aniso: 8 }),
      normalMap: texFrom(normal, { aniso: 8 }),
      roughnessMap: texFrom(rough, { aniso: 8 }),
    };
    return set;
  } catch (e) {
    return { map: null, normalMap: null, roughnessMap: null };
  }
}

/* -------------------------------- metal ---------------------------------- */

const _metalCache = new Map();

function acquireMetal(size) {
  const key = 'm' + size;
  let e = _metalCache.get(key);
  if (e) { e.refs++; return e.set; }
  const set = buildMetalSet(size);
  e = { refs: 1, set };
  _metalCache.set(key, e);
  return set;
}

function releaseMetal(size) {
  const key = 'm' + size;
  const e = _metalCache.get(key);
  if (!e) return;
  if (--e.refs > 0) return;
  disposeTexSet(e.set);
  _metalCache.delete(key);
}

function buildMetalSet(size) {
  if (!hasCanvas()) return { roughnessMap: null, normalMap: null };
  try {
    const h = makeCanvas(size, size);
    const hc = h.getContext('2d');
    hc.fillStyle = '#808080';
    hc.fillRect(0, 0, size, size);
    const rnd = mulberry32(4242);
    for (let i = 0; i < size * 5; i++) {
      const y = rnd() * size;
      const w = size * (0.15 + rnd() * 0.85);
      const x = rnd() * size;
      const v = 0.5 + (rnd() - 0.5) * 0.5;
      hc.strokeStyle = 'rgba(' + Math.floor(v * 255) + ',' + Math.floor(v * 255) + ',' + Math.floor(v * 255) + ',0.32)';
      hc.lineWidth = rnd() < 0.85 ? 1 : 2;
      hc.beginPath();
      hc.moveTo(x, y);
      hc.lineTo(x + w, y + (rnd() - 0.5) * 1.5);
      hc.stroke();
    }
    const rough = makeCanvas(size, size);
    const rc = rough.getContext('2d');
    rc.drawImage(h, 0, 0);
    rc.fillStyle = 'rgba(40,40,40,0.55)';
    rc.fillRect(0, 0, size, size);
    return {
      roughnessMap: texFrom(rough, { aniso: 8 }),
      normalMap: texFrom(heightToNormal(h, 0.55), { aniso: 8 }),
    };
  } catch (e) {
    return { roughnessMap: null, normalMap: null };
  }
}

/* --------------------------------- tyres ---------------------------------- */

const _tyreCache = new Map();

function acquireTyre(size, bands) {
  const key = 't' + size;
  let e = _tyreCache.get(key);
  if (e) { e.refs++; return e.set; }
  const set = buildTyreSets(size, bands);
  e = { refs: 1, set };
  _tyreCache.set(key, e);
  return set;
}

function releaseTyre(size) {
  const key = 't' + size;
  const e = _tyreCache.get(key);
  if (!e) return;
  if (--e.refs > 0) return;
  if (e.set) { disposeTexSet(e.set.slick); disposeTexSet(e.set.wet); }
  _tyreCache.delete(key);
}

/**
 * Tyre maps.  The lathe UV runs u around the circumference and v along the
 * section profile, so the canvas is laid out as
 *   v 0 .. bands.inner  : inboard sidewall (lettering, rim protector rib)
 *   bands.inner .. bands.treadA : inboard shoulder
 *   treadA .. treadB : tread band (slick or grooved)
 *   treadB .. outer  : outboard shoulder
 *   outer .. 1       : outboard sidewall (lettering + compound band land)
 */
function buildTyreSets(size, bands) {
  if (!hasCanvas()) return { slick: {}, wet: {} };
  const b = bands || { inner: 0.30, treadA: 0.40, treadB: 0.60, outer: 0.70 };
  const build = (wet) => {
    const w = size, h = size;
    const col = makeCanvas(w, h);
    const c = col.getContext('2d');
    const hh = makeCanvas(w, h);
    const g = hh.getContext('2d');
    const rgh = makeCanvas(w, h);
    const r = rgh.getContext('2d');

    c.fillStyle = '#131315'; c.fillRect(0, 0, w, h);
    g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
    r.fillStyle = '#d0d0d0'; r.fillRect(0, 0, w, h);

    const yInner = b.inner * h, yTA = b.treadA * h, yTB = b.treadB * h, yOuter = b.outer * h;

    // ---- sidewalls: slight radial ribbing + rim protector
    const drawSidewall = (y0, y1, outward) => {
      const grad = c.createLinearGradient(0, y0, 0, y1);
      grad.addColorStop(0, '#0e0e10');
      grad.addColorStop(0.45, '#1a1a1d');
      grad.addColorStop(1, '#101012');
      c.fillStyle = grad; c.fillRect(0, y0, w, y1 - y0);
      // rim protector rib
      const rib = outward ? y0 + (y1 - y0) * 0.12 : y1 - (y1 - y0) * 0.12;
      g.fillStyle = '#c8c8c8'; g.fillRect(0, rib - h * 0.006, w, h * 0.012);
      c.fillStyle = 'rgba(255,255,255,0.05)'; c.fillRect(0, rib - h * 0.006, w, h * 0.012);
      // fine circumferential striations
      for (let i = 0; i < 90; i++) {
        const yy = y0 + ((i + 0.5) / 90) * (y1 - y0);
        g.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
        g.fillRect(0, yy, w, Math.max(1, h / 400));
      }
    };
    drawSidewall(0, yInner, false);
    drawSidewall(yOuter, h, true);

    // ---- sidewall lettering, repeated around the circumference
    const letter = (yc, txt, px, alpha, flip) => {
      c.save(); g.save();
      c.textAlign = 'center'; c.textBaseline = 'middle';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const f = '700 ' + px + 'px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
      c.font = f; g.font = f;
      const reps = 6;
      for (let i = 0; i < reps; i++) {
        const x = ((i + 0.5) / reps) * w;
        c.save(); g.save();
        c.translate(x, yc); g.translate(x, yc);
        if (flip) { c.scale(1, -1); g.scale(1, -1); }
        c.fillStyle = 'rgba(226,226,226,' + alpha + ')';
        c.fillText(txt, 0, 0);
        g.fillStyle = '#e8e8e8';
        g.fillText(txt, 0, 0);
        c.restore(); g.restore();
      }
      c.restore(); g.restore();
    };
    letter(yInner * 0.42, 'APEX', Math.round(size * 0.055), 0.88, false);
    letter(yInner * 0.74, 'RS-01  CONTROL TYRE', Math.round(size * 0.026), 0.55, false);
    letter(h - (h - yOuter) * 0.42, 'APEX', Math.round(size * 0.055), 0.88, false);
    letter(h - (h - yOuter) * 0.74, '305/720 R18   APEX MOTORSPORT', Math.round(size * 0.026), 0.55, false);

    // ---- shoulders
    c.fillStyle = '#141416'; c.fillRect(0, yInner, w, yTA - yInner);
    c.fillRect(0, yTB, w, yOuter - yTB);

    // ---- tread
    const tGrad = c.createLinearGradient(0, yTA, 0, yTB);
    tGrad.addColorStop(0, '#191a1c');
    tGrad.addColorStop(0.5, '#202124');
    tGrad.addColorStop(1, '#191a1c');
    c.fillStyle = tGrad; c.fillRect(0, yTA, w, yTB - yTA);
    r.fillStyle = '#c4c4c4'; r.fillRect(0, yTA, w, yTB - yTA);

    if (wet) {
      // four circumferential grooves plus angled lateral channels
      const grooves = [0.16, 0.38, 0.62, 0.84];
      const gw = (yTB - yTA) * 0.085;
      for (const gp of grooves) {
        const y = yTA + gp * (yTB - yTA);
        c.fillStyle = '#08090a'; c.fillRect(0, y - gw / 2, w, gw);
        g.fillStyle = '#303030'; g.fillRect(0, y - gw / 2, w, gw);
        r.fillStyle = '#f0f0f0'; r.fillRect(0, y - gw / 2, w, gw);
      }
      const lat = 40;
      for (let i = 0; i < lat; i++) {
        const x = (i / lat) * w;
        c.save(); g.save();
        c.translate(x, (yTA + yTB) / 2); g.translate(x, (yTA + yTB) / 2);
        c.rotate(0.42); g.rotate(0.42);
        c.fillStyle = '#08090a';
        c.fillRect(-gw * 0.6, -(yTB - yTA) * 0.62, gw * 1.2, (yTB - yTA) * 1.24);
        g.fillStyle = '#3a3a3a';
        g.fillRect(-gw * 0.6, -(yTB - yTA) * 0.62, gw * 1.2, (yTB - yTA) * 1.24);
        c.restore(); g.restore();
      }
    } else {
      // slicks: faint moulding seams and graining streaks only
      for (let i = 0; i < 3; i++) {
        const y = yTA + (0.25 + i * 0.25) * (yTB - yTA);
        c.fillStyle = 'rgba(255,255,255,0.028)';
        c.fillRect(0, y, w, Math.max(1, h / 512));
      }
      const rnd = mulberry32(99);
      for (let i = 0; i < 340; i++) {
        const x = rnd() * w;
        const y = yTA + rnd() * (yTB - yTA);
        const l = 4 + rnd() * 26;
        c.fillStyle = 'rgba(0,0,0,0.20)';
        c.fillRect(x, y, l, 1);
        g.fillStyle = 'rgba(0,0,0,0.12)';
        g.fillRect(x, y, l, 1);
      }
    }

    noiseOverlay(c, w, h, 0.10, 2, 3);
    noiseOverlay(r, w, h, 0.10, 2, 5);

    return {
      map: texFrom(col, { srgb: true, aniso: 8 }),
      normalMap: texFrom(heightToNormal(hh, 1.1), { aniso: 8 }),
      roughnessMap: texFrom(rgh, { aniso: 8 }),
    };
  };
  try {
    return { slick: build(false), wet: build(true) };
  } catch (e) {
    return { slick: {}, wet: {} };
  }
}

/* ========================================================================== */
/*  Livery atlas                                                              */
/* ========================================================================== */

/**
 * UV regions inside the livery atlas.  Geometry bakes these rects into its UVs
 * at build time so every painted part can share a single material.
 */
export const UVR = Object.freeze({
  hull: [0.00, 0.00, 1.00, 0.52],
  sidepodR: [0.00, 0.52, 0.50, 0.70],
  sidepodL: [0.50, 0.52, 1.00, 0.70],
  deckPan: [0.00, 0.70, 0.50, 0.80],
  floorPan: [0.50, 0.70, 1.00, 0.80],
  wingPan: [0.00, 0.80, 0.50, 0.90],
  trimPan: [0.50, 0.80, 1.00, 0.90],
  detail: [0.00, 0.90, 1.00, 0.94],
  swatch: [0.00, 0.94, 1.00, 1.00],
});

/** Flat colour sample points inside the swatch strip. */
export const SW = Object.freeze({
  primary: [0.125, 0.97],
  accent: [0.375, 0.97],
  matte: [0.625, 0.97],
  titanium: [0.875, 0.97],
});

/** Perimeter (u) landmarks of the hull cross-section. */
const HB = Object.freeze({
  underR: [0.000, 0.070], flankLoR: [0.070, 0.185], flankHiR: [0.185, 0.295],
  deckR: [0.295, 0.388], coamR: [0.388, 0.456], spineR: [0.456, 0.500],
  spineL: [0.500, 0.544], coamL: [0.544, 0.612], deckL: [0.612, 0.705],
  flankHiL: [0.705, 0.815], flankLoL: [0.815, 0.930], underL: [0.930, 1.000],
});

/** Longitudinal (v) landmarks of the hull loft, 0 = nose tip, 1 = tail. */
const HV = Object.freeze({
  tip: 0.000, noseMid: 0.130, bulkhead: 0.261, tubFront: 0.304,
  cockpitFront: 0.391, cockpitMid: 0.522, headrest: 0.609, airbox: 0.652,
  engine: 0.739, coke: 0.826, gearbox: 0.913, tail: 1.000,
});

/** Sidepod perimeter landmarks. */
const SPB = Object.freeze({ under: [0.00, 0.15], flank: [0.15, 0.556], crown: [0.556, 0.852], inner: [0.852, 1.0] });

/** Decal atlas (driver specific, small). */
export const DEC = Object.freeze({
  fin: [0.00, 0.00, 1.00, 0.44],
  rwEP: [0.00, 0.44, 0.50, 0.78],
  fwEP: [0.50, 0.44, 1.00, 0.78],
  swatch: [0.00, 0.78, 1.00, 1.00],
});
const DSW = Object.freeze({ primary: [0.125, 0.89], accent: [0.375, 0.89], matte: [0.625, 0.89], white: [0.875, 0.89] });

/* ------------------------------ colour maths ------------------------------ */

function hx2(v) { const n = clamp(Math.round(v), 0, 255); return (n < 16 ? '0' : '') + n.toString(16); }
function parseHex(h) {
  let s = String(h || '#888888').replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shade(hex, amt) {
  const c = parseHex(hex);
  const f = amt < 0 ? 0 : 255;
  const a = Math.abs(amt);
  return '#' + hx2(lerp(c[0], f, a)) + hx2(lerp(c[1], f, a)) + hx2(lerp(c[2], f, a));
}
function rgba(hex, a) { const c = parseHex(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
function lumOf(hex) { const c = parseHex(hex); return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
function contrastOn(hex) { return lumOf(hex) > 0.55 ? '#0b0b0d' : '#ffffff'; }

/* --------------------------------- type ---------------------------------- */

const FONT_STACK = '"Arial Narrow", "Helvetica Neue Condensed", "Roboto Condensed", Impact, "Arial Black", Arial, sans-serif';
const FONT_PLAIN = '"Helvetica Neue", Helvetica, Arial, sans-serif';

function fontOf(weight, px, cond) {
  return weight + ' ' + Math.max(4, Math.round(px)) + 'px ' + (cond ? FONT_STACK : FONT_PLAIN);
}

/** Letter-spaced text.  align: -1 left, 0 centre, 1 right. Returns width. */
function trackedText(ctx, text, x, y, px, tracking, align, weight, cond) {
  ctx.font = fontOf(weight || '700', px, cond !== false);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const t = String(text);
  const tr = (tracking || 0) * px;
  let w = 0;
  for (let i = 0; i < t.length; i++) w += ctx.measureText(t[i]).width + (i < t.length - 1 ? tr : 0);
  let cx = x;
  if (align === 0) cx = x - w / 2;
  else if (align === 1) cx = x - w;
  for (let i = 0; i < t.length; i++) {
    ctx.fillText(t[i], cx, y);
    cx += ctx.measureText(t[i]).width + tr;
  }
  return w;
}

function measureTracked(ctx, text, px, tracking, weight, cond) {
  ctx.font = fontOf(weight || '700', px, cond !== false);
  const t = String(text);
  const tr = (tracking || 0) * px;
  let w = 0;
  for (let i = 0; i < t.length; i++) w += ctx.measureText(t[i]).width + (i < t.length - 1 ? tr : 0);
  return w;
}

/** A sponsor wordmark with a per-name deterministic treatment. */
function wordmark(ctx, name, x, y, px, colFg, colBg) {
  const style = hashString(name) % 5;
  ctx.save();
  const tr = 0.06;
  const w = measureTracked(ctx, name, px, tr, '800');
  if (style === 1) {
    ctx.fillStyle = colBg;
    ctx.fillRect(x - px * 0.28, y - px * 0.86, w + px * 0.56, px * 1.14);
    ctx.fillStyle = colFg;
    trackedText(ctx, name, x, y, px, tr, -1, '800');
  } else if (style === 2) {
    ctx.fillStyle = colFg;
    ctx.fillRect(x - px * 0.30, y - px * 0.80, px * 0.14, px * 1.02);
    trackedText(ctx, name, x + px * 0.06, y, px, tr, -1, '800');
  } else if (style === 3) {
    ctx.save();
    ctx.transform(1, 0, -0.20, 1, 0, 0);
    ctx.fillStyle = colFg;
    trackedText(ctx, name, x + px * 0.16, y, px, tr, -1, '800');
    ctx.restore();
  } else if (style === 4) {
    ctx.lineWidth = Math.max(1, px * 0.055);
    ctx.strokeStyle = colFg;
    ctx.fillStyle = colFg;
    trackedText(ctx, name, x, y, px, tr, -1, '800');
    ctx.strokeRect(x - px * 0.30, y - px * 0.86, w + px * 0.60, px * 1.16);
  } else {
    ctx.fillStyle = colFg;
    trackedText(ctx, name, x, y, px, tr, -1, '800');
  }
  ctx.restore();
  return w;
}

/* --------------------------------- flags ---------------------------------- */

const FLAGS = {
  NL: { t: 'h', c: ['#ae1c28', '#ffffff', '#21468b'] },
  MX: { t: 'v', c: ['#006847', '#ffffff', '#ce1126'] },
  GB: { t: 'cross2', c: ['#012169', '#ffffff', '#c8102e'] },
  MC: { t: 'h', c: ['#ce1126', '#ffffff'] },
  ES: { t: 'h', c: ['#aa151b', '#f1bf00', '#aa151b'] },
  SE: { t: 'cross', c: ['#006aa7', '#fecc00'] },
  FR: { t: 'v', c: ['#002395', '#ffffff', '#ed2939'] },
  DE: { t: 'h', c: ['#000000', '#dd0000', '#ffce00'] },
  IT: { t: 'v', c: ['#008c45', '#f4f5f0', '#cd212a'] },
  JP: { t: 'disc', c: ['#ffffff', '#bc002d'] },
  NZ: { t: 'v', c: ['#00247d', '#ffffff', '#cc142b'] },
  BR: { t: 'diamond', c: ['#009b3a', '#fedf00', '#002776'] },
  FI: { t: 'cross', c: ['#ffffff', '#002f6c'] },
  CN: { t: 'star', c: ['#de2910', '#ffde00'] },
  TH: { t: 'h5', c: ['#a51931', '#f4f5f8', '#2d2a4a'] },
  US: { t: 'usa', c: ['#b22234', '#ffffff', '#3c3b6e'] },
  AU: { t: 'v', c: ['#00247d', '#ffffff', '#cc142b'] },
  CA: { t: 'v', c: ['#d80621', '#ffffff', '#d80621'] },
  BE: { t: 'v', c: ['#000000', '#fdda24', '#ef3340'] },
  AT: { t: 'h', c: ['#ed2939', '#ffffff', '#ed2939'] },
  CH: { t: 'cross', c: ['#d52b1e', '#ffffff'] },
  DK: { t: 'cross', c: ['#c8102e', '#ffffff'] },
  NO: { t: 'cross', c: ['#ba0c2f', '#ffffff'] },
  PL: { t: 'h', c: ['#ffffff', '#dc143c'] },
  PT: { t: 'v', c: ['#046a38', '#046a38', '#da291c'] },
  AR: { t: 'h', c: ['#74acdf', '#ffffff', '#74acdf'] },
  CO: { t: 'h', c: ['#fcd116', '#003893', '#ce1126'] },
  ZA: { t: 'h', c: ['#007a4d', '#ffffff', '#002395'] },
  IN: { t: 'h', c: ['#ff9933', '#ffffff', '#138808'] },
  KR: { t: 'disc', c: ['#ffffff', '#cd2e3a'] },
};

function drawFlag(ctx, code, x, y, w, h) {
  const f = FLAGS[code] || { t: 'h', c: ['#888888', '#bbbbbb', '#666666'] };
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const c = f.c;
  if (f.t === 'h' || f.t === 'h5') {
    const n = f.t === 'h5' ? 5 : c.length;
    const order = f.t === 'h5' ? [c[0], c[1], c[2], c[1], c[0]] : c;
    for (let i = 0; i < n; i++) { ctx.fillStyle = order[i]; ctx.fillRect(x, y + (i / n) * h, w, h / n + 1); }
  } else if (f.t === 'v') {
    for (let i = 0; i < c.length; i++) { ctx.fillStyle = c[i]; ctx.fillRect(x + (i / c.length) * w, y, w / c.length + 1, h); }
  } else if (f.t === 'cross') {
    ctx.fillStyle = c[0]; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = c[1];
    ctx.fillRect(x + w * 0.30, y, w * 0.16, h);
    ctx.fillRect(x, y + h * 0.40, w, h * 0.20);
  } else if (f.t === 'cross2') {
    ctx.fillStyle = c[0]; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = c[1]; ctx.lineWidth = h * 0.20;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.moveTo(x + w, y); ctx.lineTo(x, y + h); ctx.stroke();
    ctx.fillStyle = c[1];
    ctx.fillRect(x + w * 0.40, y, w * 0.20, h);
    ctx.fillRect(x, y + h * 0.40, w, h * 0.20);
    ctx.fillStyle = c[2];
    ctx.fillRect(x + w * 0.44, y, w * 0.12, h);
    ctx.fillRect(x, y + h * 0.44, w, h * 0.12);
  } else if (f.t === 'disc') {
    ctx.fillStyle = c[0]; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = c[1];
    ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, h * 0.30, 0, Math.PI * 2); ctx.fill();
  } else if (f.t === 'diamond') {
    ctx.fillStyle = c[0]; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = c[1];
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y + h * 0.12); ctx.lineTo(x + w * 0.88, y + h / 2);
    ctx.lineTo(x + w / 2, y + h * 0.88); ctx.lineTo(x + w * 0.12, y + h / 2);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = c[2];
    ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, h * 0.20, 0, Math.PI * 2); ctx.fill();
  } else if (f.t === 'star') {
    ctx.fillStyle = c[0]; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = c[1];
    star(ctx, x + w * 0.24, y + h * 0.32, h * 0.20, h * 0.09, 5);
    for (let i = 0; i < 4; i++) star(ctx, x + w * (0.44 + (i % 2) * 0.07), y + h * (0.14 + i * 0.16), h * 0.075, h * 0.033, 5);
  } else if (f.t === 'usa') {
    for (let i = 0; i < 13; i++) { ctx.fillStyle = i % 2 ? c[1] : c[0]; ctx.fillRect(x, y + (i / 13) * h, w, h / 13 + 1); }
    ctx.fillStyle = c[2]; ctx.fillRect(x, y, w * 0.42, h * (7 / 13));
    ctx.fillStyle = c[1];
    for (let r = 0; r < 4; r++) for (let cI = 0; cI < 5; cI++) star(ctx, x + w * 0.05 + cI * w * 0.083, y + h * 0.06 + r * h * 0.125, h * 0.035, h * 0.016, 5);
  }
  ctx.restore();
}

function star(ctx, cx, cy, ro, ri, points) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fill();
}

/* ------------------------------- patterns --------------------------------- */

/**
 * Paint one of the ten team livery patterns into a W x H tile.
 * Tile frame: x = 0 at the underside centreline, x = W at the top centreline
 * (the tile is the right half of the wrap and is mirrored onto the left);
 * y = 0 at the nose, y = H at the tail.
 */
function paintPattern(ctx, W, H, pattern, cols, seed) {
  const p = cols.primary, s = cols.secondary, a = cols.accent, tr = cols.trim;
  const rnd = mulberry32(seed);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  ctx.fillStyle = p; ctx.fillRect(0, 0, W, H);

  switch (pattern) {
    case 'bolt': {
      const bolt = (cx, amp, wide, col) => {
        ctx.beginPath();
        const n = 9;
        const pts = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const y = t * H;
          const x = cx + Math.sin(t * 5.2) * amp + (i % 2 ? amp * 0.55 : -amp * 0.55);
          pts.push([x, y]);
        }
        ctx.moveTo(pts[0][0] - wide, pts[0][1]);
        for (let i = 0; i <= n; i++) ctx.lineTo(pts[i][0] - wide, pts[i][1]);
        for (let i = n; i >= 0; i--) ctx.lineTo(pts[i][0] + wide, pts[i][1]);
        ctx.closePath();
        ctx.fillStyle = col; ctx.fill();
      };
      bolt(W * 0.52, W * 0.085, W * 0.115, s);
      bolt(W * 0.52, W * 0.085, W * 0.045, shade(s, 0.22));
      bolt(W * 0.80, W * 0.045, W * 0.030, a);
      ctx.fillStyle = a; ctx.fillRect(0, 0, W * 0.055, H);
      ctx.fillStyle = rgba(tr, 0.9); ctx.fillRect(W * 0.055, 0, W * 0.012, H);
      break;
    }
    case 'arrow': {
      const bands = 7;
      const skew = H * 0.16;
      for (let i = 0; i < bands; i++) {
        const y0 = H * (0.06 + i * 0.135);
        const th = H * 0.052;
        ctx.beginPath();
        ctx.moveTo(0, y0 + skew);
        ctx.lineTo(W, y0);
        ctx.lineTo(W, y0 + th);
        ctx.lineTo(0, y0 + skew + th);
        ctx.closePath();
        ctx.fillStyle = i % 2 ? a : s;
        ctx.globalAlpha = i % 2 ? 0.95 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = shade(s, -0.35);
      ctx.fillRect(0, 0, W, H * 0.045);
      break;
    }
    case 'prancing': {
      ctx.fillStyle = shade(p, -0.16);
      ctx.fillRect(0, 0, W * 0.30, H);
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, W * 0.10, H);
      ctx.fillStyle = a;
      ctx.fillRect(W * 0.10, 0, W * 0.018, H);
      // crest on the flank with an abstract rearing steed
      const cx = W * 0.46, cy = H * 0.30, sw = W * 0.30, sh = sw * 1.18;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      ctx.moveTo(-sw / 2, -sh / 2); ctx.lineTo(sw / 2, -sh / 2);
      ctx.lineTo(sw / 2, sh * 0.16); ctx.quadraticCurveTo(sw / 2, sh / 2, 0, sh / 2);
      ctx.quadraticCurveTo(-sw / 2, sh / 2, -sw / 2, sh * 0.16);
      ctx.closePath();
      ctx.fillStyle = a; ctx.fill();
      ctx.lineWidth = sw * 0.045; ctx.strokeStyle = shade(p, -0.4); ctx.stroke();
      ctx.fillStyle = shade(p, -0.55);
      ctx.beginPath();
      ctx.moveTo(-sw * 0.06, sh * 0.30);
      ctx.quadraticCurveTo(-sw * 0.20, sh * 0.10, -sw * 0.10, -sh * 0.04);
      ctx.quadraticCurveTo(-sw * 0.02, -sh * 0.20, sw * 0.10, -sh * 0.28);
      ctx.lineTo(sw * 0.20, -sh * 0.36);
      ctx.lineTo(sw * 0.12, -sh * 0.20);
      ctx.quadraticCurveTo(sw * 0.24, -sh * 0.06, sw * 0.16, sh * 0.16);
      ctx.quadraticCurveTo(sw * 0.10, sh * 0.32, sw * 0.14, sh * 0.34);
      ctx.lineTo(sw * 0.02, sh * 0.34);
      ctx.quadraticCurveTo(sw * 0.02, sh * 0.16, -sw * 0.02, sh * 0.20);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'chevron': {
      const step = H * 0.085;
      const slope = W * 1.55;
      for (let i = -12; i < 26; i++) {
        const y = i * step;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y - slope * 0.30);
        ctx.lineTo(W, y - slope * 0.30 + step * 0.52);
        ctx.lineTo(0, y + step * 0.52);
        ctx.closePath();
        ctx.fillStyle = (i % 3 === 0) ? a : ((i % 3 === 1) ? s : shade(p, -0.22));
        ctx.fill();
      }
      break;
    }
    case 'wave': {
      const bandN = 5;
      for (let b = 0; b < bandN; b++) {
        const base = H * (0.10 + b * 0.19);
        const amp = H * 0.035;
        const th = H * 0.075;
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
          const x = (i / 40) * W;
          const y = base + Math.sin(i / 40 * Math.PI * 2.2 + b * 1.1) * amp;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        for (let i = 40; i >= 0; i--) {
          const x = (i / 40) * W;
          const y = base + th + Math.sin(i / 40 * Math.PI * 2.2 + b * 1.1 + 0.35) * amp;
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        const g = ctx.createLinearGradient(0, base, W, base + th);
        g.addColorStop(0, b % 2 ? a : s);
        g.addColorStop(1, b % 2 ? shade(a, -0.35) : shade(s, 0.28));
        ctx.fillStyle = g; ctx.fill();
      }
      ctx.fillStyle = rgba(tr, 0.75); ctx.fillRect(0, H * 0.965, W, H * 0.035);
      break;
    }
    case 'blade': {
      const ox = W * 1.06, oy = -H * 0.10;
      for (let i = 0; i < 7; i++) {
        const a0 = 1.92 + i * 0.115;
        const a1 = a0 + 0.055 + (i % 2) * 0.028;
        const L = H * 2.1;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + Math.cos(a0) * L, oy + Math.sin(a0) * L);
        ctx.lineTo(ox + Math.cos(a1) * L, oy + Math.sin(a1) * L);
        ctx.closePath();
        ctx.fillStyle = i % 3 === 0 ? a : (i % 3 === 1 ? s : shade(s, -0.30));
        ctx.fill();
      }
      ctx.fillStyle = shade(p, -0.42);
      ctx.beginPath();
      ctx.moveTo(0, H); ctx.lineTo(W * 0.55, H); ctx.lineTo(0, H * 0.58);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'shard': {
      const N = 26;
      const pts = [];
      for (let i = 0; i < N; i++) pts.push([rnd() * W * 1.2 - W * 0.1, rnd() * H * 1.2 - H * 0.1]);
      pts.sort((u, v) => u[1] - v[1]);
      const pal = [s, a, shade(p, -0.28), shade(p, 0.16), shade(s, -0.3), tr];
      for (let i = 0; i < N - 2; i++) {
        ctx.beginPath();
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
        ctx.lineTo(pts[i + 2][0], pts[i + 2][1]);
        ctx.closePath();
        ctx.fillStyle = pal[Math.floor(rnd() * pal.length)];
        ctx.globalAlpha = 0.62 + rnd() * 0.38;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.moveTo(W, 0); ctx.lineTo(W, H * 0.30); ctx.lineTo(W * 0.55, 0);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'crest': {
      const cx = W * 0.62, cy = H * 0.44;
      for (let i = 0; i < 20; i++) {
        const a0 = (i / 20) * Math.PI * 2;
        const a1 = a0 + Math.PI / 20;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a0) * W * 2.4, cy + Math.sin(a0) * W * 2.4);
        ctx.lineTo(cx + Math.cos(a1) * W * 2.4, cy + Math.sin(a1) * W * 2.4);
        ctx.closePath();
        ctx.fillStyle = i % 2 ? shade(s, -0.10) : shade(p, 0.10);
        ctx.fill();
      }
      ctx.beginPath(); ctx.arc(cx, cy, W * 0.30, 0, Math.PI * 2);
      ctx.fillStyle = p; ctx.fill();
      ctx.lineWidth = W * 0.035; ctx.strokeStyle = a; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - W * 0.17, cy - W * 0.20); ctx.lineTo(cx + W * 0.17, cy - W * 0.20);
      ctx.lineTo(cx + W * 0.17, cy + W * 0.04);
      ctx.quadraticCurveTo(cx + W * 0.17, cy + W * 0.24, cx, cy + W * 0.24);
      ctx.quadraticCurveTo(cx - W * 0.17, cy + W * 0.24, cx - W * 0.17, cy + W * 0.04);
      ctx.closePath();
      ctx.fillStyle = a; ctx.fill();
      ctx.fillStyle = shade(p, -0.5);
      ctx.fillRect(cx - W * 0.17, cy - W * 0.08, W * 0.34, W * 0.05);
      ctx.fillRect(0, H * 0.955, W, H * 0.045);
      break;
    }
    case 'circuit': {
      ctx.fillStyle = shade(s, -0.55); ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = rgba(a, 0.20); ctx.lineWidth = Math.max(1, W * 0.004);
      for (let i = 0; i <= 22; i++) {
        ctx.beginPath(); ctx.moveTo((i / 22) * W, 0); ctx.lineTo((i / 22) * W, H); ctx.stroke();
      }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let t = 0; t < 26; t++) {
        let x = rnd() * W, y = rnd() * H;
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.strokeStyle = t % 4 === 0 ? p : a;
        ctx.lineWidth = W * (t % 4 === 0 ? 0.020 : 0.011);
        const segs = 3 + Math.floor(rnd() * 4);
        for (let k = 0; k < segs; k++) {
          const horiz = rnd() < 0.5;
          const d = (rnd() - 0.5) * (horiz ? W * 0.7 : H * 0.5);
          if (horiz) x += d; else y += d;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, W * 0.020, 0, Math.PI * 2);
        ctx.fillStyle = a; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, W * 0.009, 0, Math.PI * 2);
        ctx.fillStyle = shade(s, -0.6); ctx.fill();
      }
      ctx.fillStyle = p;
      ctx.fillRect(0, 0, W * 0.075, H);
      ctx.fillRect(W * 0.90, 0, W * 0.10, H);
      break;
    }
    case 'stripe':
    default: {
      ctx.fillStyle = s;
      ctx.fillRect(W * 0.40, 0, W * 0.24, H);
      ctx.fillStyle = a;
      ctx.fillRect(W * 0.365, 0, W * 0.028, H);
      ctx.fillRect(W * 0.648, 0, W * 0.028, H);
      ctx.fillStyle = shade(p, -0.30);
      ctx.fillRect(W * 0.86, 0, W * 0.14, H);
      ctx.fillStyle = tr;
      ctx.fillRect(0, H * 0.02, W, H * 0.022);
      ctx.fillStyle = s;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(W, 0); ctx.lineTo(W, H * 0.075); ctx.lineTo(0, H * 0.145);
      ctx.closePath(); ctx.fill();
      break;
    }
  }

  // shared finish: matte underside, ambient shading toward the keel
  const gr = ctx.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0, 'rgba(0,0,0,0.45)');
  gr.addColorStop(0.18, 'rgba(0,0,0,0.10)');
  gr.addColorStop(0.62, 'rgba(255,255,255,0.02)');
  gr.addColorStop(1, 'rgba(255,255,255,0.06)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0a0b0d';
  ctx.fillRect(0, 0, W * 0.075, H);
  ctx.restore();
}

/* ------------------------- livery atlas assembly -------------------------- */

function rectPx(r, S) { return { x: r[0] * S, y: r[1] * S, w: (r[2] - r[0]) * S, h: (r[3] - r[1]) * S }; }

/**
 * Run a drawing callback twice, once for the right flank and once mirrored for
 * the left, so wordmarks read correctly from both sides of the car.
 * The callback receives (ctx, lengthPx) and draws from local x = 0 rightwards
 * with the baseline on local y = 0.
 */
function mirroredRun(ctx, S, uBase, vStart, vEnd, fn) {
  const len = (vEnd - vStart) * S;
  ctx.save();
  ctx.translate(uBase * S, vStart * S);
  ctx.rotate(Math.PI / 2);
  fn(ctx, len, 1);
  ctx.restore();
  ctx.save();
  ctx.translate((1 - uBase) * S, vEnd * S);
  ctx.rotate(-Math.PI / 2);
  fn(ctx, len, -1);
  ctx.restore();
}

/** Same idea but confined to a sub-rect of the atlas (sidepods). */
function panelRun(ctx, S, rectR, rectL, uBase, vStart, vEnd, fn) {
  const rr = rectPx(rectR, S);
  const rl = rectPx(rectL, S);
  const len = (vEnd - vStart) * rr.h;
  ctx.save();
  ctx.translate(rr.x + uBase * rr.w, rr.y + vStart * rr.h);
  ctx.rotate(Math.PI / 2);
  fn(ctx, len, 1);
  ctx.restore();
  ctx.save();
  ctx.translate(rl.x + uBase * rl.w, rl.y + vEnd * rl.h);
  ctx.rotate(-Math.PI / 2);
  fn(ctx, len, -1);
  ctx.restore();
}

function buildLiveryCanvas(team, size) {
  const S = size;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const cols = {
    primary: team.colors.primary,
    secondary: team.colors.secondary,
    accent: team.colors.accent,
    trim: team.colors.trim,
  };
  const seed = hashString(team.id + team.livery);
  const fg = contrastOn(cols.primary);

  ctx.fillStyle = cols.primary;
  ctx.fillRect(0, 0, S, S);

  /* ---- hull wrap: paint the right half then mirror across the keel ---- */
  const hull = rectPx(UVR.hull, S);
  const tile = makeCanvas(Math.max(8, Math.round(hull.w * 0.5)), Math.max(8, Math.round(hull.h)));
  paintPattern(tile.getContext('2d'), tile.width, tile.height, team.livery, cols, seed);
  ctx.save();
  ctx.beginPath(); ctx.rect(hull.x, hull.y, hull.w, hull.h); ctx.clip();
  ctx.drawImage(tile, hull.x, hull.y, hull.w * 0.5, hull.h);
  ctx.translate(hull.x + hull.w, hull.y);
  ctx.scale(-1, 1);
  ctx.drawImage(tile, 0, 0, hull.w * 0.5, hull.h);
  ctx.restore();

  /* ---- cockpit surround and coaming: always matte black ---- */
  ctx.fillStyle = '#0a0a0c';
  const cvA = HV.cockpitFront - 0.03, cvB = HV.headrest + 0.02;
  ctx.fillRect(HB.coamR[0] * S, cvA * S, (HB.coamL[1] - HB.coamR[0]) * S, (cvB - cvA) * S);
  ctx.fillStyle = rgba(cols.accent, 0.85);
  ctx.fillRect((HB.coamR[0] - 0.008) * S, cvA * S, 0.010 * S, (cvB - cvA) * S);
  ctx.fillRect((HB.coamL[1] - 0.002) * S, cvA * S, 0.010 * S, (cvB - cvA) * S);

  /* ---- spine flash along the engine cover ---- */
  ctx.fillStyle = rgba(cols.accent, 0.9);
  ctx.fillRect(HB.spineR[0] * S, HV.airbox * S, (HB.spineL[1] - HB.spineR[0]) * S, (HV.tail - HV.airbox) * S);
  ctx.fillStyle = rgba(cols.secondary, 0.55);
  ctx.fillRect((HB.spineR[0] + 0.012) * S, HV.airbox * S, (HB.spineL[1] - HB.spineR[0] - 0.024) * S, (HV.tail - HV.airbox) * S);

  /* ---- nose wordmark run ---- */
  mirroredRun(ctx, S, 0.108, HV.tip + 0.030, HV.bulkhead + 0.055, (g, len) => {
    const px = 0.036 * S;
    g.fillStyle = fg;
    trackedText(g, team.short, len * 0.06, px * 0.36, px * 1.25, 0.10, -1, '800');
    wordmark(g, team.sponsors[1] || 'APEX', len * 0.42, px * 0.30, px * 0.86, fg, rgba(cols.accent, 0.9));
  });

  /* ---- engine cover flank run ---- */
  mirroredRun(ctx, S, 0.120, HV.airbox + 0.010, HV.tail - 0.010, (g, len) => {
    const px = 0.030 * S;
    wordmark(g, team.sponsors[2] || 'APEX', len * 0.04, px * 0.34, px, fg, rgba(cols.accent, 0.9));
    g.fillStyle = rgba(fg, 0.85);
    trackedText(g, team.name.toUpperCase(), len * 0.52, px * 0.30, px * 0.72, 0.14, -1, '600');
  });

  /* ---- upper flank secondary run ---- */
  mirroredRun(ctx, S, 0.215, HV.cockpitFront - 0.02, HV.headrest + 0.06, (g, len) => {
    const px = 0.024 * S;
    g.fillStyle = rgba(fg, 0.9);
    trackedText(g, team.engine.toUpperCase(), len * 0.05, px * 0.3, px, 0.16, -1, '700');
  });

  /* ---- deck: team wordmark ahead of the cockpit ---- */
  ctx.save();
  ctx.translate(0.5 * S, (HV.tubFront) * S);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = rgba(fg, 0.92);
  trackedText(ctx, team.name.toUpperCase(), 0, 0.014 * S, 0.026 * S, 0.20, 0, '800');
  ctx.restore();

  /* ---- sidepods ---- */
  for (const side of ['R', 'L']) {
    const r = rectPx(side === 'R' ? UVR.sidepodR : UVR.sidepodL, S);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = cols.primary; ctx.fillRect(r.x, r.y, r.w, r.h);
    const t2 = makeCanvas(Math.max(8, Math.round(r.w)), Math.max(8, Math.round(r.h)));
    paintPattern(t2.getContext('2d'), t2.width, t2.height, team.livery, cols, seed + 17);
    ctx.drawImage(t2, r.x, r.y, r.w, r.h);
    // undercut shadow band and inlet lip
    const gg = ctx.createLinearGradient(r.x, 0, r.x + r.w * SPB.flank[0], 0);
    gg.addColorStop(0, 'rgba(0,0,0,0.85)');
    gg.addColorStop(1, 'rgba(0,0,0,0.05)');
    ctx.fillStyle = gg; ctx.fillRect(r.x, r.y, r.w * SPB.flank[0], r.h);
    ctx.fillStyle = '#0b0c0e';
    ctx.fillRect(r.x, r.y, r.w, r.h * 0.045);
    ctx.restore();
  }
  panelRun(ctx, S, UVR.sidepodR, UVR.sidepodL, 0.30, 0.10, 0.92, (g, len) => {
    const px = 0.052 * S;
    wordmark(g, team.sponsors[0] || 'APEX', len * 0.03, px * 0.34, px, fg, rgba(cols.accent, 0.95));
    const px2 = px * 0.42;
    g.fillStyle = rgba(fg, 0.8);
    trackedText(g, (team.sponsors[1] || '') + '  •  ' + (team.sponsors[2] || ''), len * 0.03, px * 1.3, px2, 0.12, -1, '600');
  });
  panelRun(ctx, S, UVR.sidepodR, UVR.sidepodL, 0.66, 0.12, 0.55, (g, len) => {
    const px = 0.026 * S;
    g.fillStyle = rgba(fg, 0.82);
    trackedText(g, team.base.toUpperCase(), 0, 0, px, 0.18, -1, '600');
  });

  /* ---- engine deck panel (airbox shoulders, camera pods, mirror pods) ---- */
  {
    const r = rectPx(UVR.deckPan, S);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = shade(cols.primary, -0.14); ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = cols.accent;
    ctx.fillRect(r.x, r.y + r.h * 0.42, r.w, r.h * 0.14);
    ctx.fillStyle = rgba(cols.secondary, 0.8);
    ctx.fillRect(r.x, r.y + r.h * 0.60, r.w, r.h * 0.06);
    ctx.fillStyle = rgba(fg, 0.9);
    trackedText(ctx, team.short, r.x + r.w * 0.5, r.y + r.h * 0.30, r.h * 0.30, 0.16, 0, '800');
    ctx.restore();
  }

  /* ---- floor / diffuser panel: exposed carbon with accent edge ---- */
  {
    const r = rectPx(UVR.floorPan, S);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = '#101216'; ctx.fillRect(r.x, r.y, r.w, r.h);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.028)' : 'rgba(0,0,0,0.20)';
      ctx.fillRect(r.x, r.y + (i / 40) * r.h, r.w, r.h / 40);
    }
    ctx.fillStyle = cols.accent;
    ctx.fillRect(r.x, r.y, r.w, r.h * 0.06);
    ctx.fillRect(r.x, r.y + r.h * 0.94, r.w, r.h * 0.06);
    ctx.fillStyle = rgba('#ffffff', 0.55);
    trackedText(ctx, 'APEX F1  •  FLOOR EDGE', r.x + r.w * 0.5, r.y + r.h * 0.55, r.h * 0.10, 0.22, 0, '600');
    ctx.restore();
  }

  /* ---- wing surfaces ---- */
  {
    const r = rectPx(UVR.wingPan, S);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = '#0c0e11'; ctx.fillRect(r.x, r.y, r.w, r.h);
    // u runs around the aerofoil: 0..0.5 is the underside, 0.5..1 the topside
    const g2 = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y);
    g2.addColorStop(0.00, '#0a0c0f');
    g2.addColorStop(0.44, '#12151a');
    g2.addColorStop(0.52, rgba(cols.primary, 0.98));
    g2.addColorStop(0.80, rgba(cols.primary, 0.98));
    g2.addColorStop(1.00, '#0a0c0f');
    ctx.fillStyle = g2; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = cols.accent;
    ctx.fillRect(r.x + r.w * 0.495, r.y, r.w * 0.022, r.h);
    ctx.fillStyle = rgba(cols.secondary, 0.85);
    ctx.fillRect(r.x + r.w * 0.86, r.y, r.w * 0.05, r.h);
    ctx.save();
    ctx.translate(r.x + r.w * 0.64, r.y + r.h * 0.5);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = rgba(fg, 0.88);
    trackedText(ctx, team.sponsors[0] || 'APEX', 0, r.w * 0.016, r.w * 0.045, 0.16, 0, '800');
    ctx.fillStyle = rgba(fg, 0.55);
    trackedText(ctx, team.short + ' AERO', 0, -r.w * 0.030, r.w * 0.026, 0.20, 0, '600');
    ctx.restore();
    ctx.restore();
  }

  /* ---- generic trim panel (mirrors, halo, camera pods, ducts) ---- */
  {
    const r = rectPx(UVR.trimPan, S);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = shade(cols.primary, -0.10); ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = cols.secondary; ctx.fillRect(r.x, r.y, r.w * 0.34, r.h);
    ctx.fillStyle = cols.accent; ctx.fillRect(r.x + r.w * 0.34, r.y, r.w * 0.06, r.h);
    ctx.fillStyle = rgba(fg, 0.8);
    trackedText(ctx, team.short, r.x + r.w * 0.70, r.y + r.h * 0.62, r.h * 0.42, 0.10, 0, '800');
    ctx.restore();
  }

  /* ---- fine detail strip: FIA style warning labels and seam decals ---- */
  {
    const r = rectPx(UVR.detail, S);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = '#15171b'; ctx.fillRect(r.x, r.y, r.w, r.h);
    const labels = ['LIFT HERE', 'EXTINGUISHER', 'ELECTRICAL CUT-OFF', 'HIGH VOLTAGE', 'JACK POINT', 'FUEL'];
    for (let i = 0; i < labels.length; i++) {
      const x = r.x + (i / labels.length) * r.w;
      const w = r.w / labels.length;
      ctx.fillStyle = i % 2 ? '#e3e3e3' : '#d81f26';
      ctx.fillRect(x + w * 0.04, r.y + r.h * 0.15, w * 0.92, r.h * 0.70);
      ctx.fillStyle = i % 2 ? '#101010' : '#ffffff';
      trackedText(ctx, labels[i], x + w * 0.5, r.y + r.h * 0.68, r.h * 0.42, 0.05, 0, '700');
    }
    ctx.restore();
  }

  /* ---- flat colour swatches ---- */
  {
    const r = rectPx(UVR.swatch, S);
    const sw = [cols.primary, cols.accent, '#131417', '#9aa0a8'];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = sw[i];
      ctx.fillRect(r.x + (i / 4) * r.w, r.y, r.w / 4 + 1, r.h);
    }
  }

  return c;
}

/* ------------------ shared (livery independent) detail maps --------------- */

function buildBodyDetailCanvases(S) {
  const height = makeCanvas(S, S);
  const hc = height.getContext('2d');
  const rough = makeCanvas(S, S);
  const rc = rough.getContext('2d');
  hc.fillStyle = '#808080'; hc.fillRect(0, 0, S, S);
  rc.fillStyle = '#333333'; rc.fillRect(0, 0, S, S);

  const line = (x0, y0, x1, y1, wpx) => {
    hc.strokeStyle = '#5a5a5a'; hc.lineWidth = wpx;
    hc.beginPath(); hc.moveTo(x0 * S, y0 * S); hc.lineTo(x1 * S, y1 * S); hc.stroke();
    hc.strokeStyle = '#9a9a9a'; hc.lineWidth = Math.max(1, wpx * 0.5);
    hc.beginPath(); hc.moveTo(x0 * S, y0 * S + wpx * 0.8); hc.lineTo(x1 * S, y1 * S + wpx * 0.8); hc.stroke();
    rc.strokeStyle = '#2a2a2a'; rc.lineWidth = wpx;
    rc.beginPath(); rc.moveTo(x0 * S, y0 * S); rc.lineTo(x1 * S, y1 * S); rc.stroke();
  };

  // transverse panel joints across the hull
  const joints = [HV.noseMid, HV.bulkhead, HV.tubFront, HV.cockpitFront, HV.headrest,
    HV.airbox, HV.engine, HV.coke, HV.gearbox];
  const lw = Math.max(1.5, S / 500);
  for (const v of joints) line(0, v * UVR.hull[3], 1, v * UVR.hull[3], lw);
  // longitudinal seams at the shoulder and keel
  for (const u of [HB.flankHiR[0], HB.deckR[0], HB.deckL[1], HB.flankHiL[1], HB.underR[1], HB.underL[0]]) {
    line(u, 0, u, UVR.hull[3], lw * 0.8);
  }

  // matte underside + cockpit interior
  rc.fillStyle = '#a8a8a8';
  rc.fillRect(0, 0, HB.underR[1] * S, UVR.hull[3] * S);
  rc.fillRect(HB.underL[0] * S, 0, (1 - HB.underL[0]) * S, UVR.hull[3] * S);
  rc.fillRect(HB.coamR[0] * S, (HV.cockpitFront - 0.03) * S, (HB.coamL[1] - HB.coamR[0]) * S, (HV.headrest + 0.02 - HV.cockpitFront + 0.03) * S);

  // sidepod cooling louvre relief on the crown band
  for (const r0 of [UVR.sidepodR, UVR.sidepodL]) {
    const r = rectPx(r0, S);
    for (let i = 0; i < 14; i++) {
      const y = r.y + r.h * (0.30 + i * 0.036);
      hc.fillStyle = '#3d3d3d';
      hc.fillRect(r.x + r.w * SPB.crown[0], y, r.w * 0.24, r.h * 0.014);
      hc.fillStyle = '#c0c0c0';
      hc.fillRect(r.x + r.w * SPB.crown[0], y + r.h * 0.014, r.w * 0.24, r.h * 0.007);
      rc.fillStyle = '#6a6a6a';
      rc.fillRect(r.x + r.w * SPB.crown[0], y, r.w * 0.24, r.h * 0.021);
    }
    rc.fillStyle = '#909090';
    rc.fillRect(r.x, r.y, r.w * SPB.flank[0], r.h);
  }

  // exposed carbon zones: floor and wing panels are matte-ish
  for (const r0 of [UVR.floorPan, UVR.wingPan]) {
    const r = rectPx(r0, S);
    rc.fillStyle = '#565656';
    rc.fillRect(r.x, r.y, r.w, r.h);
  }

  // fasteners
  const rnd = mulberry32(31337);
  for (let i = 0; i < 260; i++) {
    const x = rnd() * S, y = rnd() * UVR.hull[3] * S;
    const rad = Math.max(1, S / 800);
    hc.fillStyle = '#606060';
    hc.beginPath(); hc.arc(x, y, rad * 1.6, 0, Math.PI * 2); hc.fill();
    hc.fillStyle = '#b0b0b0';
    hc.beginPath(); hc.arc(x, y - rad * 0.4, rad, 0, Math.PI * 2); hc.fill();
  }

  noiseOverlay(rc, S, S, 0.10, 2, 77);
  return { height, rough };
}

/* ------------------------------ decal atlas ------------------------------- */

function buildDecalCanvas(team, driver, S) {
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const cols = team.colors;
  const fg = contrastOn(cols.primary);
  ctx.fillStyle = cols.primary;
  ctx.fillRect(0, 0, S, S);

  /* ---- shark fin: side elevation, x = front..rear, y = top..bottom ---- */
  {
    const r = rectPx(DEC.fin, S);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = cols.primary; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = rgba(cols.secondary, 0.9);
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + r.h);
    ctx.lineTo(r.x + r.w, r.y + r.h * 0.30);
    ctx.lineTo(r.x + r.w, r.y + r.h);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = cols.accent;
    ctx.fillRect(r.x, r.y, r.w, r.h * 0.075);
    // big number toward the front of the fin
    ctx.fillStyle = fg;
    trackedText(ctx, String(driver.num), r.x + r.w * 0.20, r.y + r.h * 0.74, r.h * 0.66, -0.03, 0, '800');
    // surname toward the rear
    ctx.fillStyle = rgba(fg, 0.95);
    trackedText(ctx, driver.name.split(' ').pop().toUpperCase(), r.x + r.w * 0.62, r.y + r.h * 0.42, r.h * 0.20, 0.12, 0, '700');
    drawFlag(ctx, driver.country, r.x + r.w * 0.50, r.y + r.h * 0.52, r.w * 0.18, r.h * 0.20);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = Math.max(1, S / 400);
    ctx.strokeRect(r.x + r.w * 0.50, r.y + r.h * 0.52, r.w * 0.18, r.h * 0.20);
    ctx.fillStyle = rgba(fg, 0.75);
    trackedText(ctx, team.short + '  ' + team.engine.toUpperCase(), r.x + r.w * 0.62, r.y + r.h * 0.92, r.h * 0.10, 0.16, 0, '600');
    ctx.restore();
  }

  /* ---- rear wing endplate ---- */
  {
    const r = rectPx(DEC.rwEP, S);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = '#0d0f12'; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = cols.primary;
    ctx.fillRect(r.x, r.y, r.w, r.h * 0.58);
    ctx.fillStyle = cols.accent;
    ctx.fillRect(r.x, r.y + r.h * 0.58, r.w, r.h * 0.05);
    ctx.fillStyle = fg;
    trackedText(ctx, String(driver.num), r.x + r.w * 0.30, r.y + r.h * 0.46, r.h * 0.42, -0.02, 0, '800');
    ctx.fillStyle = rgba(fg, 0.9);
    trackedText(ctx, team.sponsors[0] || 'APEX', r.x + r.w * 0.68, r.y + r.h * 0.36, r.h * 0.16, 0.10, 0, '800');
    ctx.fillStyle = 'rgba(235,235,235,0.85)';
    trackedText(ctx, driver.short, r.x + r.w * 0.68, r.y + r.h * 0.80, r.h * 0.18, 0.14, 0, '700');
    ctx.restore();
  }

  /* ---- front wing endplate ---- */
  {
    const r = rectPx(DEC.fwEP, S);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = '#0d0f12'; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = cols.primary;
    ctx.fillRect(r.x, r.y + r.h * 0.10, r.w, r.h * 0.52);
    ctx.fillStyle = cols.accent;
    ctx.fillRect(r.x, r.y + r.h * 0.62, r.w, r.h * 0.06);
    ctx.fillStyle = fg;
    trackedText(ctx, team.short, r.x + r.w * 0.42, r.y + r.h * 0.50, r.h * 0.30, 0.06, 0, '800');
    drawFlag(ctx, driver.country, r.x + r.w * 0.74, r.y + r.h * 0.22, r.w * 0.20, r.h * 0.24);
    ctx.restore();
  }

  /* ---- swatches ---- */
  {
    const r = rectPx(DEC.swatch, S);
    const sw = [cols.primary, cols.accent, '#131417', '#f2f2f2'];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = sw[i];
      ctx.fillRect(r.x + (i / 4) * r.w, r.y, r.w / 4 + 1, r.h);
    }
  }
  return c;
}

/* ---------------------------- texture caches ------------------------------ */

const _liveryCache = new Map();
const _decalCache = new Map();
const _detailCache = new Map();

function acquireLivery(team, size) {
  const key = team.id + '|' + size;
  let e = _liveryCache.get(key);
  if (e) { e.refs++; return e.tex; }
  let tex = null;
  if (hasCanvas()) {
    try { tex = texFrom(buildLiveryCanvas(team, size), { srgb: true, aniso: 8, wrap: THREE.ClampToEdgeWrapping }); }
    catch (err) { tex = null; }
  }
  _liveryCache.set(key, { refs: 1, tex });
  return tex;
}
function releaseLivery(team, size) {
  const key = team.id + '|' + size;
  const e = _liveryCache.get(key);
  if (!e) return;
  if (--e.refs > 0) return;
  if (e.tex) e.tex.dispose();
  _liveryCache.delete(key);
}

function acquireDecal(team, driver, size) {
  const key = team.id + '|' + driver.num + '|' + size;
  let e = _decalCache.get(key);
  if (e) { e.refs++; return e.tex; }
  let tex = null;
  if (hasCanvas()) {
    try { tex = texFrom(buildDecalCanvas(team, driver, size), { srgb: true, aniso: 8, wrap: THREE.ClampToEdgeWrapping }); }
    catch (err) { tex = null; }
  }
  _decalCache.set(key, { refs: 1, tex });
  return tex;
}
function releaseDecal(team, driver, size) {
  const key = team.id + '|' + driver.num + '|' + size;
  const e = _decalCache.get(key);
  if (!e) return;
  if (--e.refs > 0) return;
  if (e.tex) e.tex.dispose();
  _decalCache.delete(key);
}

function acquireDetail(size) {
  const key = 'd' + size;
  let e = _detailCache.get(key);
  if (e) { e.refs++; return e.set; }
  let set = { normalMap: null, roughnessMap: null };
  if (hasCanvas()) {
    try {
      const cv = buildBodyDetailCanvases(size);
      set = {
        normalMap: texFrom(heightToNormal(cv.height, 0.9), { aniso: 8, wrap: THREE.ClampToEdgeWrapping }),
        roughnessMap: texFrom(cv.rough, { aniso: 8, wrap: THREE.ClampToEdgeWrapping }),
      };
    } catch (err) { /* keep nulls */ }
  }
  _detailCache.set(key, { refs: 1, set });
  return set;
}
function releaseDetail(size) {
  const key = 'd' + size;
  const e = _detailCache.get(key);
  if (!e) return;
  if (--e.refs > 0) return;
  disposeTexSet(e.set);
  _detailCache.delete(key);
}

/**
 * Public livery texture factory.
 *
 * NOTE ON SHARING: `map` is cached per TEAM (both drivers of a constructor run
 * the same base livery) while the driver number / name / flag live on the much
 * smaller `decalMap`.  `roughnessMap` and `normalMap` are livery independent and
 * shared by every car on the grid.  That keeps a 20 car grid at roughly one
 * tenth of the VRAM a naive per-car 2K atlas would need.
 *
 * The returned textures are reference counted internally; do not dispose them
 * yourself unless you also called this directly (in which case call
 * result.release()).
 */
export function createLiveryTexture(team, driver, size) {
  const S = size || 2048;
  const detailSize = Math.max(256, Math.round(S / 2));
  const decalSize = Math.max(256, Math.round(S / 4));
  const map = acquireLivery(team, S);
  const detail = acquireDetail(detailSize);
  const decalMap = driver ? acquireDecal(team, driver, decalSize) : null;
  return {
    map,
    roughnessMap: detail.roughnessMap,
    normalMap: detail.normalMap,
    decalMap,
    release() {
      releaseLivery(team, S);
      releaseDetail(detailSize);
      if (driver) releaseDecal(team, driver, decalSize);
    },
  };
}

/* ========================================================================== */
/*  Car geometry                                                              */
/* ========================================================================== */

const PART = Object.freeze({
  PAINT: 'paint', CARBON: 'carbon', METAL: 'metal', DARK: 'dark', GLASS: 'glass',
  DECAL: 'decal', RUBBER: 'rubber', DISC: 'disc', LIGHT: 'light',
  EXHAUST: 'exhaust', BAND: 'band', TITAN: 'titan',
});

/**
 * Material collapsing per LOD level.  Distant cars fold their rarely noticed
 * materials into the ones that carry the silhouette, which is what keeps a
 * twenty car grid inside a sane draw call budget.
 */
const COLLAPSE = [
  null,
  { titan: PART.CARBON, glass: PART.DARK, band: PART.RUBBER, metal: PART.CARBON },
  {
    titan: PART.CARBON, glass: PART.CARBON, metal: PART.CARBON, dark: PART.CARBON,
    decal: PART.PAINT, band: PART.RUBBER, disc: PART.CARBON, exhaust: PART.CARBON,
  },
];

/** Accumulates geometry per material key and merges once at the end. */
class PartBin {
  constructor(remap) { this.map = new Map(); this.remap = remap || null; }
  add(rawKey, geom) {
    if (!geom) return null;
    const key = (this.remap && this.remap[rawKey]) ? this.remap[rawKey] : rawKey;
    ensureIndexed(geom);
    let a = this.map.get(key);
    if (!a) { a = []; this.map.set(key, a); }
    a.push(geom);
    return geom;
  }
  /** add the part and its mirror image across the car centreline */
  addPair(key, geom) {
    if (!geom) return;
    const m = mirrorX(geom);
    this.add(key, geom);
    this.add(key, m);
  }
  merge() {
    const out = new Map();
    for (const entry of this.map) {
      const g = mergeSafe(entry[1]);
      if (g) out.set(entry[0], g);
    }
    this.map.clear();
    return out;
  }
}

/* ------------------------- extrusion orientation -------------------------- */

function extrudeOpts(t, d, bevel) {
  const o = {
    depth: t,
    steps: 1,
    curveSegments: Math.max(3, Math.round(10 * d)),
    bevelEnabled: !!bevel && d > 0.6,
  };
  if (o.bevelEnabled) {
    o.bevelThickness = Math.min(t * 0.35, 0.004);
    o.bevelSize = Math.min(t * 0.5, 0.004);
    o.bevelOffset = 0;
    o.bevelSegments = 1;
  }
  return o;
}

/** Shape authored in (z, y); result is a plate with thickness along X. */
function plateZY(shape, t, d, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, extrudeOpts(t, d, bevel));
  g.translate(0, 0, -t * 0.5);
  g.rotateY(-Math.PI / 2);
  return g;
}

/** Shape authored in (x, z); result is a plate with thickness along Y. */
function plateXZ(shape, t, d, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, extrudeOpts(t, d, bevel));
  g.translate(0, 0, -t * 0.5);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Per-vertex triplanar UVs so the carbon twill keeps a constant real size. */
function carbonUV(geom, scale) {
  const pos = geom.getAttribute('position');
  const nor = geom.getAttribute('normal');
  const n = pos.count;
  let uv = geom.getAttribute('uv');
  if (!uv || uv.count !== n) { uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2); geom.setAttribute('uv', uv); }
  const s = scale || 6.0;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nor ? Math.abs(nor.getX(i)) : 0;
    const ny = nor ? Math.abs(nor.getY(i)) : 1;
    const nz = nor ? Math.abs(nor.getZ(i)) : 0;
    let u, v;
    if (nx >= ny && nx >= nz) { u = z * s; v = y * s; }
    else if (ny >= nz) { u = x * s; v = z * s; }
    else { u = x * s; v = y * s; }
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return geom;
}

/* ------------------------------- the hull -------------------------------- */

/**
 * Longitudinal control stations of the survival cell.  The same loft carries
 * the nose cone, the tub with its cockpit opening, the airbox and the engine
 * cover down to the gearbox fairing.
 */
const HULL_KEYS = [
  { z: 2.640, hw: 0.030, yBot: 0.242, yTop: 0.272, botHW: 0.018, shHW: 0.022, cpHW: 0.020, cpDepth: 0 },
  { z: 2.620, hw: 0.075, yBot: 0.215, yTop: 0.325, botHW: 0.045, shHW: 0.055, cpHW: 0.050, cpDepth: 0 },
  { z: 2.450, hw: 0.105, yBot: 0.200, yTop: 0.365, botHW: 0.065, shHW: 0.082, cpHW: 0.070, cpDepth: 0 },
  { z: 2.200, hw: 0.145, yBot: 0.190, yTop: 0.425, botHW: 0.090, shHW: 0.112, cpHW: 0.100, cpDepth: 0 },
  { z: 1.950, hw: 0.190, yBot: 0.180, yTop: 0.495, botHW: 0.120, shHW: 0.152, cpHW: 0.130, cpDepth: 0 },
  { z: 1.700, hw: 0.235, yBot: 0.150, yTop: 0.555, botHW: 0.150, shHW: 0.192, cpHW: 0.160, cpDepth: 0 },
  { z: 1.550, hw: 0.265, yBot: 0.115, yTop: 0.585, botHW: 0.170, shHW: 0.212, cpHW: 0.180, cpDepth: 0 },
  { z: 1.350, hw: 0.300, yBot: 0.085, yTop: 0.625, botHW: 0.200, shHW: 0.250, cpHW: 0.210, cpDepth: 0 },
  { z: 1.150, hw: 0.330, yBot: 0.070, yTop: 0.660, botHW: 0.230, shHW: 0.280, cpHW: 0.240, cpDepth: 0.020 },
  { z: 1.050, hw: 0.342, yBot: 0.066, yTop: 0.672, botHW: 0.240, shHW: 0.290, cpHW: 0.250, cpDepth: 0.120 },
  { z: 0.850, hw: 0.358, yBot: 0.062, yTop: 0.690, botHW: 0.260, shHW: 0.310, cpHW: 0.270, cpDepth: 0.300 },
  { z: 0.600, hw: 0.372, yBot: 0.060, yTop: 0.712, botHW: 0.280, shHW: 0.320, cpHW: 0.285, cpDepth: 0.400 },
  { z: 0.350, hw: 0.375, yBot: 0.060, yTop: 0.740, botHW: 0.280, shHW: 0.325, cpHW: 0.280, cpDepth: 0.420 },
  { z: 0.150, hw: 0.368, yBot: 0.060, yTop: 0.780, botHW: 0.270, shHW: 0.320, cpHW: 0.260, cpDepth: 0.360 },
  { z: 0.020, hw: 0.352, yBot: 0.060, yTop: 0.870, botHW: 0.250, shHW: 0.300, cpHW: 0.220, cpDepth: 0.160 },
  { z: -0.120, hw: 0.335, yBot: 0.062, yTop: 0.965, botHW: 0.235, shHW: 0.280, cpHW: 0.170, cpDepth: 0.050 },
  { z: -0.350, hw: 0.310, yBot: 0.066, yTop: 0.950, botHW: 0.215, shHW: 0.260, cpHW: 0.120, cpDepth: 0 },
  { z: -0.700, hw: 0.280, yBot: 0.072, yTop: 0.880, botHW: 0.190, shHW: 0.235, cpHW: 0.090, cpDepth: 0 },
  { z: -1.050, hw: 0.245, yBot: 0.080, yTop: 0.800, botHW: 0.160, shHW: 0.205, cpHW: 0.070, cpDepth: 0 },
  { z: -1.400, hw: 0.200, yBot: 0.090, yTop: 0.710, botHW: 0.130, shHW: 0.170, cpHW: 0.050, cpDepth: 0 },
  { z: -1.700, hw: 0.155, yBot: 0.105, yTop: 0.620, botHW: 0.100, shHW: 0.130, cpHW: 0.040, cpDepth: 0 },
  { z: -1.900, hw: 0.118, yBot: 0.125, yTop: 0.540, botHW: 0.075, shHW: 0.100, cpHW: 0.030, cpDepth: 0 },
  { z: -2.020, hw: 0.085, yBot: 0.160, yTop: 0.450, botHW: 0.050, shHW: 0.070, cpHW: 0.020, cpDepth: 0 },
  { z: -2.120, hw: 0.048, yBot: 0.215, yTop: 0.355, botHW: 0.030, shHW: 0.040, cpHW: 0.015, cpDepth: 0 },
];

function buildHull(bin, d) {
  const counts = hullCounts(d);
  const K = HULL_KEYS.length;
  const S = Math.max(K, Math.round(K * clamp(1.7 * d, 0.85, 2.2)));
  const secs = [];
  const tmp = {};
  for (let i = 0; i < S; i++) {
    const f = (i / (S - 1)) * (K - 1);
    const p = sampleKeys(HULL_KEYS, f, tmp);
    secs.push({ pts: hullProfile(p, counts), m: zSection(p.z) });
  }
  bin.add(PART.PAINT, loft(secs, { uvRect: UVR.hull, capStart: true, capEnd: true }));

  // FIA crash-structure tip band
  const tip = new THREE.CylinderGeometry(0.036, 0.020, 0.055, Math.max(6, Math.round(14 * d)), 1, false);
  tip.rotateX(Math.PI / 2);
  tip.translate(0, 0.252, 2.632);
  fillUV(tip, SW.matte[0], SW.matte[1]);
  bin.add(PART.PAINT, tip);
}

/** Airbox intake duct above the driver's head. */
function buildAirbox(bin, d) {
  const seg = Math.max(3, Math.round(5 * d));
  const keys = [
    { z: 0.060, hw: 0.118, y0: 0.792, y1: 0.930, r: 0.045 },
    { z: -0.010, hw: 0.104, y0: 0.800, y1: 0.918, r: 0.040 },
    { z: -0.140, hw: 0.076, y0: 0.818, y1: 0.888, r: 0.028 },
    { z: -0.300, hw: 0.046, y0: 0.836, y1: 0.866, r: 0.014 },
  ];
  const secs = keys.map((k) => ({
    pts: roundedBoxProfile(k.hw, (k.y1 - k.y0) * 0.5, k.r, 0, (k.y0 + k.y1) * 0.5, seg),
    m: zSection(k.z),
  }));
  const g = loft(secs, { capEnd: true, capStart: false });
  if (g) { fillUV(g, SW.matte[0], SW.matte[1]); bin.add(PART.DARK, g); }

  // intake lip
  const lip = new THREE.TorusGeometry(0.10, 0.011, Math.max(4, Math.round(6 * d)), Math.max(8, Math.round(20 * d)));
  lip.scale(1.0, 0.62, 1.0);
  lip.translate(0, 0.861, 0.062);
  carbonUV(lip, 9);
  bin.add(PART.CARBON, lip);

  // roll hoop blade behind the airbox mouth
  const rh = new THREE.Shape();
  rh.moveTo(0.05, 0.78); rh.lineTo(0.05, 0.965); rh.lineTo(-0.30, 0.955); rh.lineTo(-0.30, 0.90);
  rh.lineTo(-0.06, 0.90); rh.lineTo(-0.02, 0.78);
  rh.closePath();
  const rhg = plateZY(rh, 0.030, d, true);
  carbonUV(rhg, 8);
  bin.add(PART.CARBON, rhg);
}

/** Shark fin, engine cover strakes and cooling exit. */
function buildFin(bin, d) {
  const fin = new THREE.Shape();
  fin.moveTo(-0.30, 0.952);
  fin.lineTo(-1.86, 0.560);
  fin.lineTo(-1.86, 0.500);
  fin.quadraticCurveTo(-1.20, 0.605, -0.62, 0.760);
  fin.quadraticCurveTo(-0.42, 0.830, -0.30, 0.900);
  fin.closePath();
  const g = plateZY(fin, 0.014, d, true);
  planarUV(g, 'z', 'y', DEC.fin, { flipU: true, flipV: true, mirrorByNormal: 'x' });
  bin.add(PART.DECAL, g);

  // cooling exit chimney at the top of the coke bottle
  const ex = new THREE.Shape();
  ex.moveTo(-1.55, 0.640); ex.lineTo(-1.90, 0.520); ex.lineTo(-1.90, 0.470); ex.lineTo(-1.55, 0.585);
  ex.closePath();
  const eg = plateZY(ex, 0.10, d, false);
  fillUV(eg, SW.matte[0], SW.matte[1]);
  bin.add(PART.DARK, eg);
}

/** Titanium halo with the correct wishbone plan-form and central pylon. */
function buildHalo(bin, d) {
  const ctrl = [
    new THREE.Vector3(-0.300, 0.792, 0.010),
    new THREE.Vector3(-0.345, 0.888, 0.255),
    new THREE.Vector3(-0.315, 0.951, 0.560),
    new THREE.Vector3(-0.192, 0.964, 0.800),
    new THREE.Vector3(0.000, 0.958, 0.882),
    new THREE.Vector3(0.192, 0.964, 0.800),
    new THREE.Vector3(0.315, 0.951, 0.560),
    new THREE.Vector3(0.345, 0.888, 0.255),
    new THREE.Vector3(0.300, 0.792, 0.010),
  ];
  const steps = Math.max(14, Math.round(34 * d));
  const pts = curvePoints(ctrl, steps);
  const seg = Math.max(6, Math.round(10 * d));
  const hoop = sweepGeometry(pts, (t) => {
    const w = smoothstep(clamp((0.5 - Math.abs(t - 0.5)) / 0.30, 0, 1));
    return strutProfile(lerp(0.023, 0.072, w), lerp(0.054, 0.026, w), seg);
  }, { up: _UP, capStart: true, capEnd: true });
  if (hoop) { carbonUV(hoop, 9); bin.add(PART.TITAN, hoop); }

  // central pylon
  const pylon = strutGeometry(
    new THREE.Vector3(0, 0.952, 0.884),
    new THREE.Vector3(0, 0.664, 0.995),
    0.062, 0.026, { seg: Math.max(6, Math.round(10 * d)), steps: 2 });
  if (pylon) { carbonUV(pylon, 9); bin.add(PART.TITAN, pylon); }

  // rear mounting brackets
  const br = strutGeometry(
    new THREE.Vector3(0.296, 0.800, 0.020),
    new THREE.Vector3(0.268, 0.712, -0.026),
    0.048, 0.030, { seg: 6, steps: 1 });
  if (br) { carbonUV(br, 10); bin.addPair(PART.TITAN, br); }
}

/** Mirrors on aero stalks. */
function buildMirrors(bin, d) {
  const seg = Math.max(3, Math.round(5 * d));
  const stalk = strutGeometry(
    new THREE.Vector3(0.300, 0.700, 0.760),
    new THREE.Vector3(0.452, 0.706, 0.726),
    0.052, 0.016, { seg: 6, steps: 1 });
  if (stalk) { carbonUV(stalk, 12); bin.addPair(PART.CARBON, stalk); }

  const podKeys = [
    { z: 0.786, hw: 0.020, hh: 0.026, r: 0.012 },
    { z: 0.760, hw: 0.036, hh: 0.038, r: 0.016 },
    { z: 0.706, hw: 0.038, hh: 0.040, r: 0.016 },
    { z: 0.686, hw: 0.030, hh: 0.034, r: 0.014 },
  ];
  const secs = podKeys.map((k) => ({
    pts: roundedBoxProfile(k.hw, k.hh, k.r, 0.470, 0.712, seg),
    m: zSection(k.z),
  }));
  const pod = loft(secs, { capStart: true, capEnd: true, uvRect: UVR.trimPan });
  if (pod) bin.addPair(PART.PAINT, pod);

  const glass = new THREE.PlaneGeometry(0.062, 0.042, 1, 1);
  glass.rotateY(-0.30);
  glass.translate(0.470, 0.712, 0.682);
  fillUV(glass, SW.titanium[0], SW.titanium[1]);
  bin.addPair(PART.GLASS, glass);
}

/** Onboard camera pods on the airbox plus the mandatory T-cam. */
function buildCameraPods(bin, d) {
  const seg = Math.max(3, Math.round(4 * d));
  const keys = [
    { z: 0.040, hw: 0.026, hh: 0.022, r: 0.008 },
    { z: -0.030, hw: 0.030, hh: 0.026, r: 0.010 },
    { z: -0.110, hw: 0.026, hh: 0.022, r: 0.008 },
  ];
  const secs = keys.map((k) => ({
    pts: roundedBoxProfile(k.hw, k.hh, k.r, 0.098, 0.982, seg),
    m: zSection(k.z),
  }));
  const pod = loft(secs, { capStart: true, capEnd: true, uvRect: UVR.trimPan });
  if (pod) bin.addPair(PART.PAINT, pod);

  const lens = new THREE.CylinderGeometry(0.011, 0.011, 0.010, Math.max(6, Math.round(12 * d)));
  lens.rotateX(Math.PI / 2);
  lens.translate(0.098, 0.982, 0.046);
  fillUV(lens, SW.matte[0], SW.matte[1]);
  bin.addPair(PART.GLASS, lens);

  // T-cam mast
  const mast = strutGeometry(
    new THREE.Vector3(0, 0.960, -0.180),
    new THREE.Vector3(0, 1.006, -0.196),
    0.038, 0.016, { seg: 6, steps: 1 });
  if (mast) { carbonUV(mast, 12); bin.add(PART.CARBON, mast); }
  const tcam = new THREE.BoxGeometry(0.086, 0.036, 0.052);
  tcam.translate(0, 1.026, -0.196);
  fillUV(tcam, SW.matte[0], SW.matte[1]);
  bin.add(PART.DARK, tcam);
}

/** Side impact structures visible ahead of the sidepod inlets. */
function buildSIS(bin, d) {
  const seg = Math.max(3, Math.round(4 * d));
  const upper = [
    { z: 0.760, hw: 0.020, hh: 0.036, x: 0.330, y: 0.360 },
    { z: 0.700, hw: 0.034, hh: 0.040, x: 0.520, y: 0.352 },
    { z: 0.640, hw: 0.030, hh: 0.034, x: 0.700, y: 0.344 },
    { z: 0.610, hw: 0.018, hh: 0.024, x: 0.790, y: 0.340 },
  ];
  const lower = [
    { z: 0.820, hw: 0.020, hh: 0.028, x: 0.300, y: 0.188 },
    { z: 0.760, hw: 0.032, hh: 0.032, x: 0.500, y: 0.180 },
    { z: 0.700, hw: 0.028, hh: 0.028, x: 0.680, y: 0.172 },
    { z: 0.670, hw: 0.016, hh: 0.020, x: 0.760, y: 0.168 },
  ];
  for (const set of [upper, lower]) {
    const secs = set.map((k) => ({
      pts: roundedBoxProfile(k.hw, k.hh, Math.min(k.hw, k.hh) * 0.55, k.x, k.y, seg),
      m: zSection(k.z),
    }));
    const g = loft(secs, { capStart: true, capEnd: true });
    if (g) { carbonUV(g, 8); bin.addPair(PART.CARBON, g); }
  }
}

/** Cockpit interior: seat pan, headrest padding, dash bulkhead, belts. */
function buildCockpit(bin, d) {
  const seg = Math.max(3, Math.round(5 * d));
  const seat = [
    { z: 1.020, hw: 0.180, hh: 0.028, y: 0.330 },
    { z: 0.820, hw: 0.205, hh: 0.030, y: 0.318 },
    { z: 0.560, hw: 0.215, hh: 0.032, y: 0.312 },
    { z: 0.320, hw: 0.205, hh: 0.048, y: 0.330 },
    { z: 0.170, hw: 0.190, hh: 0.070, y: 0.386 },
    { z: 0.090, hw: 0.175, hh: 0.076, y: 0.440 },
  ];
  const secs = seat.map((k) => ({
    pts: roundedBoxProfile(k.hw, k.hh, 0.022, 0, k.y, seg),
    m: zSection(k.z),
  }));
  const g = loft(secs, { capStart: true, capEnd: true });
  if (g) { fillUV(g, SW.matte[0], SW.matte[1]); bin.add(PART.DARK, g); }

  // headrest bolster
  const hr = new THREE.CylinderGeometry(0.075, 0.075, 0.34, Math.max(6, Math.round(14 * d)), 1, false, -Math.PI * 0.62, Math.PI * 1.24);
  hr.rotateZ(Math.PI / 2);
  hr.rotateY(Math.PI / 2);
  hr.translate(0, 0.680, 0.075);
  fillUV(hr, SW.matte[0], SW.matte[1]);
  bin.add(PART.DARK, hr);

  // dash bulkhead
  const dash = new THREE.Shape();
  dash.moveTo(-0.24, 0.00); dash.lineTo(0.24, 0.00); dash.lineTo(0.20, 0.10); dash.lineTo(-0.20, 0.10);
  dash.closePath();
  const dg = new THREE.ExtrudeGeometry(dash, extrudeOpts(0.012, d, false));
  dg.rotateX(-0.30);
  dg.translate(0, 0.560, 1.060);
  fillUV(dg, SW.matte[0], SW.matte[1]);
  bin.add(PART.DARK, dg);
}

/* ------------------------------- sidepods --------------------------------- */

const SP_KEYS = [
  { z: 0.640, xOut: 0.860, xIn: 0.400, yTop: 0.530, yBot: 0.300, xUnd: 0.700, crown: 0.020 },
  { z: 0.480, xOut: 0.900, xIn: 0.360, yTop: 0.560, yBot: 0.140, xUnd: 0.660, crown: 0.030 },
  { z: 0.150, xOut: 0.930, xIn: 0.330, yTop: 0.600, yBot: 0.085, xUnd: 0.620, crown: 0.040 },
  { z: -0.200, xOut: 0.920, xIn: 0.310, yTop: 0.600, yBot: 0.075, xUnd: 0.600, crown: 0.045 },
  { z: -0.550, xOut: 0.850, xIn: 0.300, yTop: 0.570, yBot: 0.070, xUnd: 0.560, crown: 0.040 },
  { z: -0.900, xOut: 0.680, xIn: 0.280, yTop: 0.500, yBot: 0.068, xUnd: 0.460, crown: 0.030 },
  { z: -1.200, xOut: 0.480, xIn: 0.260, yTop: 0.410, yBot: 0.068, xUnd: 0.340, crown: 0.020 },
  { z: -1.450, xOut: 0.330, xIn: 0.240, yTop: 0.330, yBot: 0.070, xUnd: 0.270, crown: 0.010 },
];

function remapUVRect(geom, from, to) {
  const uv = geom.getAttribute('uv');
  if (!uv) return geom;
  const fu = (from[2] - from[0]) || 1, fv = (from[3] - from[1]) || 1;
  for (let i = 0; i < uv.count; i++) {
    const a = (uv.getX(i) - from[0]) / fu;
    const b = (uv.getY(i) - from[1]) / fv;
    uv.setXY(i, to[0] + a * (to[2] - to[0]), to[1] + b * (to[3] - to[1]));
  }
  uv.needsUpdate = true;
  return geom;
}

function buildSidepods(bin, d, level) {
  const seg = Math.max(2, Math.round(6 * d));
  const K = SP_KEYS.length;
  const S = Math.max(K, Math.round(K * clamp(2.0 * d, 1.0, 2.6)));
  const secs = [];
  const tmp = {};
  for (let i = 0; i < S; i++) {
    const p = sampleKeys(SP_KEYS, (i / (S - 1)) * (K - 1), tmp);
    secs.push({ pts: sidepodProfile(p, seg), m: zSection(p.z) });
  }
  const right = loft(secs, { uvRect: UVR.sidepodR, capStart: true, capEnd: true });
  if (right) {
    const left = remapUVRect(mirrorX(right), UVR.sidepodR, UVR.sidepodL);
    bin.add(PART.PAINT, right);
    bin.add(PART.PAINT, left);
  }

  // inlet duct interior
  const duct = [
    { z: 0.652, hw: 0.200, hh: 0.100, r: 0.036 },
    { z: 0.560, hw: 0.168, hh: 0.084, r: 0.030 },
    { z: 0.430, hw: 0.116, hh: 0.058, r: 0.020 },
  ].map((k) => ({ pts: roundedBoxProfile(k.hw, k.hh, k.r, 0.640, 0.415, seg), m: zSection(k.z) }));
  const dg = loft(duct, { capStart: false, capEnd: true });
  if (dg) { fillUV(dg, SW.matte[0], SW.matte[1]); bin.addPair(PART.DARK, dg); }

  // inlet lip
  const lipShape = new THREE.Shape();
  lipShape.moveTo(0.430, 0.310); lipShape.lineTo(0.850, 0.310);
  lipShape.lineTo(0.850, 0.522); lipShape.lineTo(0.430, 0.522);
  lipShape.closePath();
  const lipHole = new THREE.Path();
  lipHole.moveTo(0.452, 0.328); lipHole.lineTo(0.828, 0.328);
  lipHole.lineTo(0.828, 0.504); lipHole.lineTo(0.452, 0.504);
  lipHole.closePath();
  lipShape.holes.push(lipHole);
  const lipG = new THREE.ExtrudeGeometry(lipShape, extrudeOpts(0.026, d, false));
  lipG.translate(0, 0, 0.636);
  carbonUV(lipG, 10);
  bin.addPair(PART.CARBON, lipG);

  if (level > 0) return;

  // cooling louvres along the shoulder
  const spAt = (z) => {
    let f = 0;
    for (let i = 0; i < K - 1; i++) {
      if (z <= SP_KEYS[i].z && z >= SP_KEYS[i + 1].z) {
        f = i + (SP_KEYS[i].z - z) / (SP_KEYS[i].z - SP_KEYS[i + 1].z);
        break;
      }
    }
    return sampleKeys(SP_KEYS, f, {});
  };
  const nL = 13;
  for (let i = 0; i < nL; i++) {
    const z = -0.06 - i * 0.052;
    const p = spAt(z);
    const xc = lerp(p.xIn, p.xOut, 0.70);
    const yc = p.yTop + p.crown * 0.55;
    const slot = new THREE.BoxGeometry(p.xOut * 0.34, 0.006, 0.026);
    slot.translate(xc, yc - 0.004, z);
    fillUV(slot, SW.matte[0], SW.matte[1]);
    bin.addPair(PART.DARK, slot);
    const lipS = new THREE.BoxGeometry(p.xOut * 0.34, 0.0045, 0.016);
    lipS.rotateX(-0.42);
    lipS.translate(xc, yc + 0.008, z + 0.012);
    carbonUV(lipS, 14);
    bin.addPair(PART.CARBON, lipS);
  }

  // shoulder winglet ahead of the louvres
  const wl = new THREE.Shape();
  wl.moveTo(0.520, 0.300); wl.quadraticCurveTo(0.760, 0.360, 0.870, 0.230);
  wl.lineTo(0.855, 0.198); wl.quadraticCurveTo(0.740, 0.320, 0.516, 0.268);
  wl.closePath();
  const wlg = plateXZ(wl, 0.010, d, true);
  wlg.translate(0, 0.560, 0);
  carbonUV(wlg, 8);
  bin.addPair(PART.CARBON, wlg);
}

/* --------------------------- floor and diffuser --------------------------- */

/** Thin walled arch used for the venturi tunnels and the diffuser. */
function archProfile(x0, x1, yBase, h, t, seg) {
  const n = Math.max(4, seg);
  const inner = [];
  const outer = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = lerp(x0, x1, u);
    const y = yBase + h * Math.sin(Math.PI * Math.pow(u, 0.9));
    inner.push([x, y]);
    outer.push([x, y + t]);
  }
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(inner[i]);
  for (let i = n; i >= 0; i--) pts.push(outer[i]);
  return pts;
}

function buildFloor(bin, d, level) {
  const seg = Math.max(3, Math.round(9 * d));

  // main floor plate outline (authored in x, z)
  const fs = new THREE.Shape();
  fs.moveTo(0.00, 1.320);
  fs.quadraticCurveTo(0.30, 1.300, 0.430, 1.180);
  fs.quadraticCurveTo(0.640, 0.980, 0.780, 0.680);
  fs.quadraticCurveTo(0.860, 0.400, 0.868, 0.000);
  fs.lineTo(0.868, -0.900);
  fs.quadraticCurveTo(0.855, -1.250, 0.760, -1.520);
  fs.lineTo(0.000, -1.560);
  fs.lineTo(-0.760, -1.520);
  fs.quadraticCurveTo(-0.855, -1.250, -0.868, -0.900);
  fs.lineTo(-0.868, 0.000);
  fs.quadraticCurveTo(-0.860, 0.400, -0.780, 0.680);
  fs.quadraticCurveTo(-0.640, 0.980, -0.430, 1.180);
  fs.quadraticCurveTo(-0.30, 1.300, 0.00, 1.320);
  const fg = plateXZ(fs, 0.016, d, false);
  fg.translate(0, DIM.floorY + 0.008, 0);
  planarUV(fg, 'x', 'z', UVR.floorPan);
  bin.add(PART.CARBON, fg);

  // wooden plank down the keel
  const plank = new THREE.BoxGeometry(0.30, 0.010, 2.60);
  plank.translate(0, DIM.floorY - 0.005, -0.20);
  fillUV(plank, SW.matte[0], SW.matte[1]);
  bin.add(PART.DARK, plank);

  // floor edge fence, swept along the outer edge
  const edgePts = [];
  const zEdge = [1.15, 0.90, 0.62, 0.30, -0.05, -0.40, -0.75, -1.05, -1.30, -1.46];
  const xEdge = [0.470, 0.660, 0.790, 0.845, 0.868, 0.868, 0.868, 0.858, 0.820, 0.770];
  for (let i = 0; i < zEdge.length; i++) edgePts.push(new THREE.Vector3(xEdge[i], DIM.floorY + 0.028, zEdge[i]));
  const fence = sweepGeometry(edgePts, () => strutProfile(0.012, 0.056, Math.max(5, Math.round(8 * d))),
    { up: _UP, capStart: true, capEnd: true });
  if (fence) { carbonUV(fence, 8); bin.addPair(PART.CARBON, fence); }

  // venturi tunnel roof, visible as the big inlet ahead of the sidepod
  const tunKeys = [
    { z: 1.230, x0: 0.150, x1: 0.560, h: 0.115, t: 0.012 },
    { z: 0.900, x0: 0.150, x1: 0.640, h: 0.150, t: 0.012 },
    { z: 0.400, x0: 0.155, x1: 0.740, h: 0.185, t: 0.012 },
    { z: -0.200, x0: 0.160, x1: 0.790, h: 0.200, t: 0.012 },
    { z: -0.800, x0: 0.165, x1: 0.800, h: 0.205, t: 0.012 },
    { z: -1.300, x0: 0.170, x1: 0.760, h: 0.215, t: 0.012 },
    { z: -1.540, x0: 0.175, x1: 0.720, h: 0.230, t: 0.012 },
  ];
  const tunSecs = tunKeys.map((k) => ({
    pts: archProfile(k.x0, k.x1, DIM.floorY - 0.002, k.h, k.t, seg),
    m: zSection(k.z),
  }));
  const tun = loft(tunSecs, { capStart: true, capEnd: true });
  if (tun) { carbonUV(tun, 7); bin.addPair(PART.CARBON, tun); }

  // floor inlet fences
  if (level === 0) {
    for (let i = 0; i < 4; i++) {
      const fx = 0.24 + i * 0.115;
      const sh = new THREE.Shape();
      sh.moveTo(1.300 - i * 0.045, DIM.floorY);
      sh.quadraticCurveTo(1.180 - i * 0.05, DIM.floorY + 0.135, 1.020 - i * 0.06, DIM.floorY + 0.150);
      sh.lineTo(0.900 - i * 0.06, DIM.floorY + 0.140);
      sh.quadraticCurveTo(1.060 - i * 0.05, DIM.floorY + 0.090, 1.250 - i * 0.045, DIM.floorY);
      sh.closePath();
      const g = plateZY(sh, 0.008, d, false);
      g.translate(fx, 0, 0);
      carbonUV(g, 12);
      bin.addPair(PART.CARBON, g);
    }
  }

  /* ---- diffuser ---- */
  const dfKeys = [
    { z: -1.560, x0: 0.100, x1: 0.560, h: 0.100, t: 0.014 },
    { z: -1.760, x0: 0.100, x1: 0.575, h: 0.165, t: 0.014 },
    { z: -1.960, x0: 0.100, x1: 0.585, h: 0.235, t: 0.014 },
    { z: -2.140, x0: 0.100, x1: 0.590, h: 0.300, t: 0.014 },
    { z: -2.250, x0: 0.100, x1: 0.590, h: 0.330, t: 0.014 },
  ];
  const dfSecs = dfKeys.map((k) => ({
    pts: archProfile(k.x0, k.x1, DIM.floorY - 0.004, k.h, k.t, seg),
    m: zSection(k.z),
  }));
  const df = loft(dfSecs, { capStart: false, capEnd: true });
  if (df) { carbonUV(df, 7); bin.addPair(PART.CARBON, df); }

  // diffuser side walls
  const dw = new THREE.Shape();
  dw.moveTo(-1.560, DIM.floorY); dw.lineTo(-2.250, DIM.floorY);
  dw.lineTo(-2.250, DIM.floorY + 0.360); dw.lineTo(-1.560, DIM.floorY + 0.110);
  dw.closePath();
  const dwg = plateZY(dw, 0.012, d, false);
  dwg.translate(0.596, 0, 0);
  carbonUV(dwg, 8);
  bin.addPair(PART.CARBON, dwg);

  // vertical strakes
  const nStr = level === 0 ? 5 : 3;
  for (let i = 0; i < nStr; i++) {
    const sx = 0.135 + i * (0.44 / nStr);
    const hgt = 0.09 + i * 0.012;
    const st = new THREE.Shape();
    st.moveTo(-1.620, DIM.floorY);
    st.lineTo(-2.240, DIM.floorY);
    st.lineTo(-2.240, DIM.floorY + hgt + 0.09);
    st.lineTo(-1.620, DIM.floorY + hgt * 0.35);
    st.closePath();
    const g = plateZY(st, 0.007, d, false);
    g.translate(sx, 0, 0);
    carbonUV(g, 12);
    bin.addPair(PART.CARBON, g);
  }
}

/* ------------------------------ front wing -------------------------------- */

const FW_ELEMENTS = [
  { leZ: 2.842, leY: 0.074, chord: 0.300, tw: 0.10, th: 0.100, cam: 0.075 },
  { leZ: 2.726, leY: 0.118, chord: 0.240, tw: 0.24, th: 0.085, cam: 0.100 },
  { leZ: 2.640, leY: 0.180, chord: 0.205, tw: 0.42, th: 0.075, cam: 0.115 },
  { leZ: 2.530, leY: 0.248, chord: 0.180, tw: 0.62, th: 0.070, cam: 0.130 },
];

const FW_STATIONS = [-0.980, -0.930, -0.860, -0.760, -0.640, -0.500, -0.360, -0.240,
  -0.160, -0.115, -0.060, 0.0, 0.060, 0.115, 0.160, 0.240, 0.360, 0.500, 0.640,
  0.760, 0.860, 0.930, 0.980];

function wingElementGeometry(el, index, d, stations) {
  const steps = Math.max(6, Math.round(13 * d));
  const secs = [];
  for (let i = 0; i < stations.length; i++) {
    const x = stations[i];
    const ax = Math.abs(x);
    const neutral = smoothstep(clamp((ax - 0.100) / 0.075, 0, 1));
    const outer = smoothstep(clamp((ax - 0.300) / 0.680, 0, 1));
    const tipTaper = smoothstep(clamp((ax - 0.780) / 0.200, 0, 1));
    const tw = el.tw * lerp(0.18, 1.0, neutral) * (1 + 0.38 * outer);
    const chord = el.chord * (1 - 0.14 * outer) * (1 - 0.24 * tipTaper);
    const dy = -0.030 * outer - 0.028 * tipTaper + (index > 0 ? -0.012 * outer : 0);
    const dz = -0.020 * outer;
    const cam = el.cam * lerp(0.35, 1.0, neutral);
    const prof = airfoilProfile(steps, el.th, cam, 0.42, true);
    const pts = new Array(prof.length);
    for (let k = 0; k < prof.length; k++) pts[k] = [prof[k][0] * chord, prof[k][1] * chord];
    const s = Math.sin(tw), c = Math.cos(tw);
    _v3a.set(x, el.leY + dy, el.leZ + dz);
    _v3b.set(0, s, -c);
    _v3c.set(0, c, s);
    _v3d.set(1, 0, 0);
    secs.push({ pts, m: sectionMatrix(_v3a, _v3b, _v3c, _v3d) });
  }
  return loft(secs, { uvRect: UVR.wingPan, capStart: true, capEnd: true });
}

function buildFrontWing(bin, d, level) {
  const stations = level === 0 ? FW_STATIONS : FW_STATIONS.filter((v, i) => i % 2 === 0 || Math.abs(v) < 0.17);
  const n = level === 2 ? 2 : 4;
  for (let e = 0; e < n; e++) {
    const g = wingElementGeometry(FW_ELEMENTS[e], e, d, stations);
    if (g) bin.add(PART.PAINT, g);
  }
  if (level === 2) return;

  /* ---- endplates ---- */
  const ep = new THREE.Shape();
  ep.moveTo(2.890, 0.048);
  ep.quadraticCurveTo(2.904, 0.180, 2.868, 0.282);
  ep.quadraticCurveTo(2.820, 0.360, 2.706, 0.372);
  ep.lineTo(2.514, 0.352);
  ep.quadraticCurveTo(2.410, 0.336, 2.398, 0.230);
  ep.lineTo(2.410, 0.052);
  ep.closePath();
  const epg = plateZY(ep, 0.011, d, true);
  epg.translate(0.958, 0, 0);
  _mat4a.makeTranslation(0.958, 0.050, 0);
  _mat4a.multiply(_mat4b.makeRotationZ(-0.10));
  _mat4a.multiply(_mat4b.makeTranslation(-0.958, -0.050, 0));
  epg.applyMatrix4(_mat4a);
  planarUV(epg, 'z', 'y', DEC.fwEP, { flipU: true, flipV: true, mirrorByNormal: 'x' });
  const epL = mirrorX(epg);
  planarUV(epL, 'z', 'y', DEC.fwEP, { flipU: true, flipV: true, mirrorByNormal: 'x' });
  bin.add(PART.DECAL, epg);
  bin.add(PART.DECAL, epL);

  /* ---- footplate ---- */
  const fp = new THREE.Shape();
  fp.moveTo(0.845, 2.418);
  fp.quadraticCurveTo(0.890, 2.680, 0.944, 2.870);
  fp.lineTo(0.998, 2.864);
  fp.quadraticCurveTo(0.962, 2.660, 0.938, 2.408);
  fp.closePath();
  const fpg = plateXZ(fp, 0.010, d, true);
  fpg.translate(0, 0.052, 0);
  carbonUV(fpg, 8);
  bin.addPair(PART.CARBON, fpg);

  /* ---- outwash cascade winglets ---- */
  if (level === 0) {
    for (let i = 0; i < 2; i++) {
      const cw = new THREE.Shape();
      const zc = 2.560 + i * 0.130;
      cw.moveTo(zc, 0.300 + i * 0.026);
      cw.quadraticCurveTo(zc + 0.075, 0.330 + i * 0.026, zc + 0.140, 0.302 + i * 0.026);
      cw.lineTo(zc + 0.140, 0.286 + i * 0.026);
      cw.quadraticCurveTo(zc + 0.070, 0.312 + i * 0.026, zc, 0.284 + i * 0.026);
      cw.closePath();
      const g = plateZY(cw, 0.050 + i * 0.016, d, false);
      g.translate(0.962 - i * 0.012, 0, 0);
      _mat4a.makeTranslation(0.962, 0.295 + i * 0.026, 0);
      _mat4a.multiply(_mat4b.makeRotationZ(-0.22));
      _mat4a.multiply(_mat4b.makeTranslation(-0.962, -(0.295 + i * 0.026), 0));
      g.applyMatrix4(_mat4a);
      carbonUV(g, 10);
      bin.addPair(PART.CARBON, g);
    }
    // endplate footplate strake
    const st = new THREE.Shape();
    st.moveTo(2.480, 0.050); st.lineTo(2.730, 0.058); st.lineTo(2.730, 0.128); st.lineTo(2.480, 0.140);
    st.closePath();
    const stg = plateZY(st, 0.008, d, false);
    stg.translate(0.890, 0, 0);
    carbonUV(stg, 12);
    bin.addPair(PART.CARBON, stg);
  }

  /* ---- wing to nose mounting pillars ---- */
  for (let i = 0; i < 2; i++) {
    const p = strutGeometry(
      new THREE.Vector3(0.062 + i * 0.010, 0.300, 2.600 - i * 0.10),
      new THREE.Vector3(0.070 + i * 0.010, 0.150, 2.660 - i * 0.10),
      0.070, 0.020, { seg: 6, steps: 1 });
    if (p) { carbonUV(p, 10); bin.addPair(PART.CARBON, p); }
  }
}

/* ------------------------------- rear wing -------------------------------- */

function buildRearWing(bin, d, level) {
  const steps = Math.max(6, Math.round(13 * d));
  const span = level === 0 ? [-0.512, -0.400, -0.250, -0.100, 0.0, 0.100, 0.250, 0.400, 0.512]
    : [-0.512, -0.250, 0.0, 0.250, 0.512];

  /* ---- mainplane ---- */
  {
    const secs = [];
    for (let i = 0; i < span.length; i++) {
      const x = span[i];
      const ax = Math.abs(x);
      const chord = 0.255 * (1 - 0.05 * smoothstep(clamp((ax - 0.30) / 0.22, 0, 1)));
      const tw = 0.30 + 0.05 * smoothstep(clamp(ax / 0.51, 0, 1));
      const prof = airfoilProfile(steps, 0.105, 0.095, 0.40, true);
      const pts = new Array(prof.length);
      for (let k = 0; k < prof.length; k++) pts[k] = [prof[k][0] * chord, prof[k][1] * chord];
      const s = Math.sin(tw), c = Math.cos(tw);
      _v3a.set(x, 0.800, -2.290);
      _v3b.set(0, s, -c); _v3c.set(0, c, s); _v3d.set(1, 0, 0);
      secs.push({ pts, m: sectionMatrix(_v3a, _v3b, _v3c, _v3d) });
    }
    const g = loft(secs, { uvRect: UVR.wingPan, capStart: true, capEnd: true });
    if (g) bin.add(PART.PAINT, g);
  }

  /* ---- beam wing, two elements ---- */
  for (let e = 0; e < 2; e++) {
    const secs = [];
    const bs = [-0.420, -0.220, 0.0, 0.220, 0.420];
    for (let i = 0; i < bs.length; i++) {
      const chord = 0.150 - e * 0.020;
      const tw = 0.34 + e * 0.16;
      const prof = airfoilProfile(Math.max(5, Math.round(9 * d)), 0.095, 0.10, 0.42, true);
      const pts = new Array(prof.length);
      for (let k = 0; k < prof.length; k++) pts[k] = [prof[k][0] * chord, prof[k][1] * chord];
      const s = Math.sin(tw), c = Math.cos(tw);
      _v3a.set(bs[i], 0.318 + e * 0.082, -2.268 - e * 0.030);
      _v3b.set(0, s, -c); _v3c.set(0, c, s); _v3d.set(1, 0, 0);
      secs.push({ pts, m: sectionMatrix(_v3a, _v3b, _v3c, _v3d) });
    }
    const g = loft(secs, { uvRect: UVR.wingPan, capStart: true, capEnd: true });
    if (g) bin.add(PART.PAINT, g);
  }

  /* ---- endplates ---- */
  const ep = new THREE.Shape();
  ep.moveTo(-2.230, 0.506);
  ep.lineTo(-2.230, 0.930);
  ep.quadraticCurveTo(-2.295, 0.992, -2.425, 0.992);
  ep.lineTo(-2.698, 0.985);
  ep.quadraticCurveTo(-2.730, 0.960, -2.727, 0.900);
  ep.lineTo(-2.716, 0.560);
  ep.quadraticCurveTo(-2.698, 0.500, -2.596, 0.496);
  ep.closePath();
  const epg = plateZY(ep, 0.012, d, true);
  epg.translate(0.524, 0, 0);
  planarUV(epg, 'z', 'y', DEC.rwEP, { flipU: true, flipV: true, mirrorByNormal: 'x' });
  const epL = mirrorX(epg);
  planarUV(epL, 'z', 'y', DEC.rwEP, { flipU: true, flipV: true, mirrorByNormal: 'x' });
  bin.add(PART.DECAL, epg);
  bin.add(PART.DECAL, epL);

  /* ---- swan neck pylons ---- */
  for (let i = 0; i < 2; i++) {
    const sx = 0.148 + i * 0.0;
    const ctrl = [
      new THREE.Vector3(sx, 0.396, -2.010),
      new THREE.Vector3(sx, 0.600, -2.108),
      new THREE.Vector3(sx, 0.790, -2.226),
      new THREE.Vector3(sx, 0.884, -2.302),
      new THREE.Vector3(sx, 0.872, -2.352),
    ];
    if (i === 1) for (const c of ctrl) c.x = -sx;
    const pts = curvePoints(ctrl, Math.max(6, Math.round(14 * d)));
    const g = sweepGeometry(pts, () => strutProfile(0.090, 0.020, Math.max(5, Math.round(8 * d))),
      { up: _UP, capStart: true, capEnd: true });
    if (g) { carbonUV(g, 9); bin.add(PART.CARBON, g); }
  }

  /* ---- endplate louvres + upper flick ---- */
  if (level === 0) {
    for (let i = 0; i < 4; i++) {
      const lv = new THREE.BoxGeometry(0.020, 0.008, 0.085);
      lv.rotateX(0.35);
      lv.translate(0.522, 0.905 - i * 0.055, -2.545 + i * 0.010);
      carbonUV(lv, 14);
      bin.addPair(PART.CARBON, lv);
    }
  }
}

/** Flap chord, closed incidence, hinge position and open travel. */
const DRS_CHORD = 0.170;
const DRS_TWIST = 0.52;
export const DRS_HINGE = Object.freeze({ x: 0, y: 0.966, z: -2.568 });
const DRS_OPEN_ANGLE = -0.46;

/**
 * DRS flap authored around its trailing edge, which is where the real hinge
 * lives: opening rotates the leading edge up and forward and blows the slot
 * gap open instead of just tilting the whole element.
 */
function buildDrsFlap(d, level) {
  const steps = Math.max(6, Math.round(13 * d));
  const span = level === 0 ? [-0.508, -0.380, -0.200, 0.0, 0.200, 0.380, 0.508] : [-0.508, 0.0, 0.508];
  const secs = [];
  const chord = DRS_CHORD;
  const tw = DRS_TWIST;
  for (let i = 0; i < span.length; i++) {
    const prof = airfoilProfile(steps, 0.085, 0.085, 0.40, true);
    const pts = new Array(prof.length);
    for (let k = 0; k < prof.length; k++) pts[k] = [prof[k][0] * chord, prof[k][1] * chord];
    const s = Math.sin(tw), c = Math.cos(tw);
    // group origin sits on the trailing edge: the leading edge is offset forward and down
    _v3a.set(span[i], -chord * s, chord * c);
    _v3b.set(0, s, -c); _v3c.set(0, c, s); _v3d.set(1, 0, 0);
    secs.push({ pts, m: sectionMatrix(_v3a, _v3b, _v3c, _v3d) });
  }
  return loft(secs, { uvRect: UVR.wingPan, capStart: true, capEnd: true });
}

/* --------------------- crash structure, exhaust, lights ------------------- */

function buildRearEnd(bin, d) {
  const seg = Math.max(3, Math.round(5 * d));
  const keys = [
    { z: -1.880, hw: 0.110, hh: 0.090, y: 0.330, r: 0.035 },
    { z: -2.020, hw: 0.096, hh: 0.078, y: 0.330, r: 0.030 },
    { z: -2.180, hw: 0.072, hh: 0.060, y: 0.322, r: 0.024 },
    { z: -2.290, hw: 0.044, hh: 0.040, y: 0.316, r: 0.016 },
  ];
  const secs = keys.map((k) => ({ pts: roundedBoxProfile(k.hw, k.hh, k.r, 0, k.y, seg), m: zSection(k.z) }));
  const g = loft(secs, { capStart: true, capEnd: true });
  if (g) { carbonUV(g, 7); bin.add(PART.CARBON, g); }

  // gearbox / crash structure support fin to the beam wing
  const sf = new THREE.Shape();
  sf.moveTo(-1.900, 0.250); sf.lineTo(-2.250, 0.250); sf.lineTo(-2.250, 0.310); sf.lineTo(-1.900, 0.330);
  sf.closePath();
  const sfg = plateZY(sf, 0.024, d, false);
  carbonUV(sfg, 10);
  bin.add(PART.CARBON, sfg);

  // exhaust tailpipe
  const pipe = new THREE.CylinderGeometry(0.056, 0.052, 0.30, Math.max(8, Math.round(18 * d)), 1, true);
  pipe.rotateX(Math.PI / 2);
  pipe.translate(0, 0.452, -2.170);
  fillUV(pipe, SW.titanium[0], SW.titanium[1]);
  bin.add(PART.METAL, pipe);
  const ring = new THREE.RingGeometry(0.030, 0.050, Math.max(8, Math.round(18 * d)));
  ring.rotateY(Math.PI);
  ring.translate(0, 0.452, -2.321);
  fillUV(ring, SW.matte[0], SW.matte[1]);
  bin.add(PART.EXHAUST, ring);

  // rain light cluster
  const rl = new THREE.BoxGeometry(0.098, 0.098, 0.020);
  rl.translate(0, 0.300, -2.300);
  fillUV(rl, SW.matte[0], SW.matte[1]);
  bin.add(PART.LIGHT, rl);
  const sm = new THREE.BoxGeometry(0.048, 0.048, 0.016);
  sm.translate(0.300, 0.140, -2.246);
  fillUV(sm, SW.matte[0], SW.matte[1]);
  bin.addPair(PART.LIGHT, sm);
  const shroud = new THREE.BoxGeometry(0.126, 0.126, 0.030);
  shroud.translate(0, 0.300, -2.288);
  fillUV(shroud, SW.matte[0], SW.matte[1]);
  bin.add(PART.DARK, shroud);
}

/* ------------------------------- suspension ------------------------------- */

/** Inboard rotation pivot of one suspension corner (car space). */
function cornerPivot(front, side) {
  return new THREE.Vector3(side * 0.250, 0.340, front ? DIM.frontAxleZ : DIM.rearAxleZ);
}

/**
 * One suspension corner, authored in car space then shifted so that the group
 * pivot sits on the inboard mounting line.  Rotating the group about Z lifts
 * the outboard end exactly like real wishbone travel.
 */
function buildSuspensionCorner(d, front, level) {
  const bin = new PartBin(COLLAPSE[level]);
  const seg = Math.max(5, Math.round(8 * d));
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const add = (a, b, ch, th, taper) => {
    const g = strutGeometry(a, b, ch, th, { seg, steps: level === 0 ? 2 : 1, taper });
    if (g) { carbonUV(g, 11); bin.add(PART.CARBON, g); }
  };

  if (front) {
    const outUp = V(0.700, 0.505, 1.800);
    const outLo = V(0.720, 0.196, 1.800);
    add(V(0.244, 0.498, 1.646), outUp, 0.072, 0.021, 0.72);
    add(V(0.292, 0.512, 1.288), outUp, 0.072, 0.021, 0.72);
    add(V(0.232, 0.170, 1.664), outLo, 0.082, 0.024, 0.74);
    add(V(0.268, 0.176, 1.242), outLo, 0.082, 0.024, 0.74);
    add(V(0.256, 0.300, 1.420), V(0.706, 0.298, 1.702), 0.048, 0.020, 0.85);   // track rod
    add(V(0.718, 0.208, 1.792), V(0.252, 0.522, 1.520), 0.060, 0.024, 0.90);   // pushrod
    // upright
    const up = strutGeometry(V(0.714, 0.190, 1.800), V(0.702, 0.512, 1.800), 0.112, 0.052,
      { seg, steps: 2, taper: 0.72 });
    if (up) { carbonUV(up, 9); bin.add(PART.CARBON, up); }
  } else {
    const outUp = V(0.660, 0.432, -1.800);
    const outLo = V(0.680, 0.200, -1.800);
    add(V(0.202, 0.450, -1.618), outUp, 0.070, 0.021, 0.72);
    add(V(0.216, 0.452, -1.988), outUp, 0.070, 0.021, 0.72);
    add(V(0.168, 0.166, -1.640), outLo, 0.080, 0.024, 0.74);
    add(V(0.182, 0.168, -1.978), outLo, 0.080, 0.024, 0.74);
    add(V(0.182, 0.252, -2.020), V(0.666, 0.264, -1.930), 0.046, 0.020, 0.85); // toe link
    add(V(0.652, 0.440, -1.812), V(0.188, 0.206, -1.602), 0.058, 0.024, 0.90); // pullrod
    const up = strutGeometry(V(0.674, 0.192, -1.800), V(0.662, 0.442, -1.800), 0.108, 0.050,
      { seg, steps: 2, taper: 0.74 });
    if (up) { carbonUV(up, 9); bin.add(PART.CARBON, up); }
    // driveshaft
    const ds = new THREE.CylinderGeometry(0.026, 0.026, 0.545, Math.max(5, Math.round(9 * d)), 1, false);
    ds.rotateZ(-Math.PI / 2);
    ds.translate(0.382, 0.186, -1.800);
    fillUV(ds, SW.titanium[0], SW.titanium[1]);
    bin.add(PART.METAL, ds);
  }
  const merged = bin.merge();
  const piv = cornerPivot(front, 1);
  for (const entry of merged) entry[1].translate(-piv.x, -piv.y, -piv.z);
  return merged;
}

/* --------------------------------- wheels --------------------------------- */

function tyreProfile(R, W, rim) {
  const p = [];
  const push = (r, a) => p.push(new THREE.Vector2(r, a));
  push(rim * 1.000, -W * 0.840);
  push(rim * 1.052, -W * 0.940);
  push(rim * 1.220, -W * 1.024);
  push(0.52 * R + 0.48 * rim, -W * 1.062);
  push(0.72 * R + 0.28 * rim, -W * 1.046);
  push(0.880 * R, -W * 0.990);
  push(0.952 * R, -W * 0.918);
  push(0.988 * R, -W * 0.800);
  push(1.000 * R, -W * 0.660);
  push(1.002 * R, -W * 0.340);
  push(1.003 * R, 0);
  push(1.002 * R, W * 0.340);
  push(1.000 * R, W * 0.660);
  push(0.988 * R, W * 0.800);
  push(0.952 * R, W * 0.918);
  push(0.880 * R, W * 0.990);
  push(0.72 * R + 0.28 * rim, W * 1.046);
  push(0.52 * R + 0.48 * rim, W * 1.062);
  push(rim * 1.220, W * 1.024);
  push(rim * 1.052, W * 0.940);
  push(rim * 1.000, W * 0.840);
  const n = p.length - 1;
  return { pts: p, bands: { inner: 6 / n, treadA: 8 / n, treadB: 12 / n, outer: 14 / n } };
}

/** The tread band UV split, shared by the tyre texture generator. */
const TYRE_BANDS = tyreProfile(0.36, 0.1525, DIM.rimR).bands;

function buildWheelSpin(d, front, level) {
  const bin = new PartBin(COLLAPSE[level]);
  const R = front ? DIM.frontTyreR : DIM.rearTyreR;
  const W = (front ? DIM.frontTyreW : DIM.rearTyreW) * 0.5;
  const rim = DIM.rimR;
  const seg = level === 2 ? 12 : Math.max(14, Math.round((level === 1 ? 22 : 46) * clamp(d, 0.5, 1.3)));

  // tyre
  const tp = tyreProfile(R, W, rim);
  const pts = level === 2
    ? tp.pts.filter((v, i) => i % 2 === 0 || i === tp.pts.length - 1)
    : tp.pts;
  const tyre = new THREE.LatheGeometry(pts, seg);
  tyre.rotateZ(-Math.PI / 2);
  bin.add(PART.RUBBER, tyre);

  // rim barrel and aero wheel cover
  const barrel = new THREE.CylinderGeometry(rim, rim, W * 1.72, seg, 1, true);
  barrel.rotateZ(-Math.PI / 2);
  fillUV(barrel, SW.titanium[0], SW.titanium[1]);
  bin.add(PART.METAL, barrel);

  const cover = new THREE.CylinderGeometry(rim * 0.80, rim * 0.995, 0.046, seg, 1, false);
  cover.rotateZ(-Math.PI / 2);
  cover.translate(W * 0.74, 0, 0);
  fillUV(cover, SW.primary[0], SW.primary[1]);
  bin.add(PART.PAINT, cover);

  if (level < 2) {
    const inner = new THREE.CylinderGeometry(rim * 0.86, rim * 0.995, 0.036, seg, 1, false);
    inner.rotateZ(-Math.PI / 2);
    inner.translate(-W * 0.76, 0, 0);
    fillUV(inner, SW.matte[0], SW.matte[1]);
    bin.add(PART.DARK, inner);

    const nut = new THREE.CylinderGeometry(0.038, 0.038, 0.034, 6, 1, false);
    nut.rotateZ(-Math.PI / 2);
    nut.translate(W * 0.80, 0, 0);
    fillUV(nut, SW.titanium[0], SW.titanium[1]);
    bin.add(PART.METAL, nut);

    const ringD = new THREE.TorusGeometry(rim * 0.66, 0.007, 5, Math.max(10, Math.round(seg * 0.6)));
    ringD.rotateY(Math.PI / 2);
    ringD.translate(W * 0.78, 0, 0);
    fillUV(ringD, SW.matte[0], SW.matte[1]);
    bin.add(PART.DARK, ringD);
  }

  // coloured compound band on both sidewalls
  const bandSeg = Math.max(10, Math.round(seg * 0.7));
  const ro = new THREE.RingGeometry(R * 0.630, R * 0.735, bandSeg);
  ro.rotateY(Math.PI / 2);
  ro.translate(W * 1.052, 0, 0);
  const ri = new THREE.RingGeometry(R * 0.630, R * 0.735, bandSeg);
  ri.rotateY(-Math.PI / 2);
  ri.translate(-W * 1.052, 0, 0);
  bin.add(PART.BAND, ro);
  bin.add(PART.BAND, ri);

  // drilled carbon brake disc
  const dr = front ? 0.166 : 0.158;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, dr, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, dr * 0.47, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  if (level === 0) {
    const rings = [[0.62, 24], [0.80, 30]];
    for (const rg of rings) {
      const rr = dr * rg[0];
      for (let i = 0; i < rg[1]; i++) {
        const a = (i / rg[1]) * Math.PI * 2 + (rg[0] > 0.7 ? 0.08 : 0);
        const hp = new THREE.Path();
        hp.absarc(Math.cos(a) * rr, Math.sin(a) * rr, dr * 0.038, 0, Math.PI * 2, true);
        shape.holes.push(hp);
      }
    }
  }
  const discGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.032, steps: 1, bevelEnabled: false,
    curveSegments: level === 0 ? 6 : Math.max(10, Math.round(24 * d)),
  });
  discGeo.translate(0, 0, -0.016);
  discGeo.rotateY(Math.PI / 2);
  fillUV(discGeo, SW.matte[0], SW.matte[1]);
  bin.add(PART.DISC, discGeo);

  return bin.merge();
}

/** Parts that steer and travel with the upright but never spin. */
function buildWheelStatic(d, front, level) {
  const bin = new PartBin(COLLAPSE[level]);
  const R = front ? DIM.frontTyreR : DIM.rearTyreR;
  const W = (front ? DIM.frontTyreW : DIM.rearTyreW) * 0.5;
  const seg = Math.max(10, Math.round(20 * d));

  // Brake duct drum.  Real drums are not closed cylinders and the glow has to
  // escape somewhere, so the shroud wraps from up-front round to down-rear and
  // leaves an aperture facing rearward where the hot disc is visible.
  const drum = new THREE.CylinderGeometry(R * 0.545, R * 0.545, W * 0.86, seg, 1, true,
    4.19, 4.18);
  drum.rotateZ(-Math.PI / 2);
  drum.translate(-W * 0.30, 0, 0);
  carbonUV(drum, 8);
  bin.add(PART.CARBON, drum);

  const back = new THREE.RingGeometry(DIM.rimR * 0.42, R * 0.545, seg, 1, 4.19, 4.18);
  back.rotateY(-Math.PI / 2);
  back.translate(-W * 0.73, 0, 0);
  carbonUV(back, 8);
  bin.add(PART.CARBON, back);

  // duct lip around the aperture
  const lip = new THREE.TorusGeometry(R * 0.545, 0.010, 4, Math.max(8, Math.round(seg * 0.8)),
    4.18);
  lip.rotateY(Math.PI / 2);
  lip.rotateX(-4.19);
  lip.translate(-W * 0.72, 0, 0);
  carbonUV(lip, 10);
  bin.add(PART.CARBON, lip);

  if (level === 0) {
    // inlet scoop facing forward
    const scoop = new THREE.Shape();
    scoop.moveTo(0.055, -0.075); scoop.lineTo(0.215, -0.055);
    scoop.quadraticCurveTo(0.245, 0.0, 0.215, 0.070);
    scoop.lineTo(0.055, 0.090);
    scoop.closePath();
    const sg = new THREE.ExtrudeGeometry(scoop, extrudeOpts(W * 0.66, d, false));
    sg.rotateY(Math.PI / 2);
    sg.translate(-W * 0.62, -0.04, 0);
    carbonUV(sg, 9);
    bin.add(PART.CARBON, sg);

    // caliper
    const cal = new THREE.BoxGeometry(0.052, 0.150, 0.086);
    cal.translate(-0.004, 0.148, 0.034);
    cal.applyMatrix4(_mat4a.makeRotationX(-0.22));
    fillUV(cal, SW.titanium[0], SW.titanium[1]);
    bin.add(PART.METAL, cal);
    const bridge = new THREE.BoxGeometry(0.070, 0.036, 0.058);
    bridge.translate(-0.004, 0.212, 0.020);
    fillUV(bridge, SW.titanium[0], SW.titanium[1]);
    bin.add(PART.METAL, bridge);
  }
  return bin.merge();
}

/* ========================================================================== */
/*  Materials                                                                 */
/* ========================================================================== */

function applyPaintShader(mat, tintHex, strength) {
  try {
    const uColor = { value: new THREE.Color(tintHex) };
    const uStr = { value: strength };
    mat.userData.flakeUniforms = { uColor, uStr };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFlakeColor = uColor;
      shader.uniforms.uFlakeStrength = uStr;
      shader.fragmentShader = 'uniform vec3 uFlakeColor;\nuniform float uFlakeStrength;\n' + shader.fragmentShader;
      const tag = '#include <emissivemap_fragment>';
      if (shader.fragmentShader.indexOf(tag) !== -1) {
        shader.fragmentShader = shader.fragmentShader.replace(tag, tag +
          '\n\tfloat apexFres = pow( 1.0 - saturate( dot( normalize( vViewPosition ), normal ) ), 4.0 );' +
          '\n\ttotalEmissiveRadiance += uFlakeColor * apexFres * uFlakeStrength;');
      }
    };
    mat.customProgramCacheKey = function () { return 'apexPaintFlake'; };
  } catch (e) { /* plain paint is fine */ }
}

const _sharedMatCache = new Map();

function acquireSharedMaterials(team, driver, tier) {
  const key = team.id + '|' + driver.num + '|' + tier;
  let e = _sharedMatCache.get(key);
  if (e) { e.refs++; return e.bundle; }
  const bundle = buildSharedMaterials(team, driver, tier);
  _sharedMatCache.set(key, { refs: 1, bundle });
  return bundle;
}

function releaseSharedMaterials(team, driver, tier) {
  const key = team.id + '|' + driver.num + '|' + tier;
  const e = _sharedMatCache.get(key);
  if (!e) return;
  if (--e.refs > 0) return;
  const b = e.bundle;
  try {
    for (const k in b.mats) if (b.mats[k]) b.mats[k].dispose();
    releaseLivery(team, b.sizes.livery);
    releaseDetail(b.sizes.detail);
    releaseDecal(team, driver, b.sizes.decal);
    releaseCarbon(b.sizes.carbon);
    releaseMetal(b.sizes.carbon);
  } catch (err) { /* ignore */ }
  _sharedMatCache.delete(key);
}

function buildSharedMaterials(team, driver, tier) {
  const texSize = TIER_TEXSIZE[tier] || 2048;
  const carbonSize = TIER_CARBONSIZE[tier] || 512;
  const detailSize = Math.max(256, Math.round(texSize / 2));
  const decalSize = Math.max(256, Math.round(texSize / 4));
  const sizes = { livery: texSize, detail: detailSize, decal: decalSize, carbon: carbonSize };

  const liveryMap = acquireLivery(team, texSize);
  const detail = acquireDetail(detailSize);
  const decalMap = acquireDecal(team, driver, decalSize);
  const carbon = acquireCarbon(carbonSize);
  const metal = acquireMetal(carbonSize);
  const hiFi = tier === 'high' || tier === 'ultra';

  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: liveryMap || null,
    roughnessMap: detail.roughnessMap || null,
    normalMap: hiFi ? (detail.normalMap || null) : null,
    roughness: detail.roughnessMap ? 1.0 : 0.28,
    metalness: 0.06,
    clearcoat: 0.9,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.15,
  });
  if (paint.normalMap) paint.normalScale.set(0.55, 0.55);
  if (!liveryMap) paint.color.set(team.colors.primary);
  applyPaintShader(paint, team.colors.accent, hiFi ? 0.055 : 0.03);

  const decal = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: decalMap || null,
    roughness: 0.26,
    metalness: 0.05,
    clearcoat: 0.85,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.1,
    side: THREE.DoubleSide,
  });
  if (!decalMap) decal.color.set(team.colors.primary);

  const carbonMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: carbon.map || null,
    normalMap: carbon.normalMap || null,
    roughnessMap: carbon.roughnessMap || null,
    roughness: carbon.roughnessMap ? 1.0 : 0.42,
    metalness: 0.10,
    clearcoat: 0.55,
    clearcoatRoughness: 0.14,
    envMapIntensity: 1.0,
    side: THREE.DoubleSide,
  });
  if (carbonMat.normalMap) carbonMat.normalScale.set(0.75, 0.75);
  if (!carbon.map) carbonMat.color.set(0x14161a);

  const titan = new THREE.MeshPhysicalMaterial({
    color: 0x71777f,
    normalMap: metal.normalMap || null,
    roughnessMap: metal.roughnessMap || null,
    roughness: metal.roughnessMap ? 1.0 : 0.40,
    metalness: 0.92,
    clearcoat: 0.25,
    envMapIntensity: 1.2,
  });
  if (titan.normalMap) titan.normalScale.set(0.35, 0.35);

  const metalMat = new THREE.MeshPhysicalMaterial({
    color: 0xb4b9c0,
    normalMap: metal.normalMap || null,
    roughnessMap: metal.roughnessMap || null,
    roughness: metal.roughnessMap ? 1.0 : 0.34,
    metalness: 1.0,
    envMapIntensity: 1.3,
  });
  if (metalMat.normalMap) metalMat.normalScale.set(0.3, 0.3);

  const dark = new THREE.MeshStandardMaterial({
    color: 0x0c0d10, roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide,
  });

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x14181f, metalness: 1.0, roughness: 0.05,
    clearcoat: 1.0, clearcoatRoughness: 0.03, envMapIntensity: 1.6,
  });

  return {
    sizes,
    textures: { liveryMap, detail, decalMap, carbon, metal },
    mats: {
      paint, decal, carbon: carbonMat, titan, metal: metalMat, dark, glass,
    },
  };
}

/* ========================================================================== */
/*  Shared geometry cache                                                     */
/* ========================================================================== */

const TIER_TYRESIZE = { low: 256, medium: 512, high: 1024, ultra: 1024 };

function mirrorMap(map) {
  const out = new Map();
  if (!map) return out;
  for (const e of map) out.set(e[0], mirrorX(e[1]));
  return out;
}

function disposeMap(map) {
  if (!map) return;
  for (const e of map) { if (e[1]) e[1].dispose(); }
  map.clear();
}

function buildGeometrySet(tier) {
  const base = TIER_DETAIL[tier] !== undefined ? TIER_DETAIL[tier] : 1;
  const levels = [];
  for (let level = 0; level < 3; level++) {
    const d = base * (level === 0 ? 1 : (level === 1 ? 0.58 : 0.34));
    const bin = new PartBin(COLLAPSE[level]);
    const safe = (fn) => { try { fn(); } catch (e) { /* a missing sub-part must never kill the car */ } };

    safe(() => buildHull(bin, d));
    safe(() => buildSidepods(bin, d, level));
    safe(() => buildFloor(bin, d, level));
    safe(() => buildFrontWing(bin, d, level));
    safe(() => buildRearWing(bin, d, level));
    safe(() => buildRearEnd(bin, d));
    safe(() => buildHalo(bin, d));
    if (level < 2) {
      safe(() => buildAirbox(bin, d));
      safe(() => buildFin(bin, d));
      safe(() => buildSIS(bin, d));
      safe(() => buildCockpit(bin, d));
    }
    if (level === 0) {
      safe(() => buildMirrors(bin, d));
      safe(() => buildCameraPods(bin, d));
    }

    let drs = null;
    safe(() => { drs = buildDrsFlap(d, level); });

    let suspF = null, suspR = null;
    if (level < 2) {
      safe(() => { suspF = buildSuspensionCorner(d, true, level); });
      safe(() => { suspR = buildSuspensionCorner(d, false, level); });
    }
    let wsF = null, wsR = null, wtF = null, wtR = null;
    safe(() => { wsF = buildWheelSpin(d, true, level); });
    safe(() => { wsR = buildWheelSpin(d, false, level); });
    if (level < 2) {
      safe(() => { wtF = buildWheelStatic(d, true, level); });
      safe(() => { wtR = buildWheelStatic(d, false, level); });
    }

    levels.push({
      body: bin.merge(),
      drs,
      susp: [suspF ? mirrorMap(suspF) : null, suspF, suspR ? mirrorMap(suspR) : null, suspR],
      wheelSpin: [wsF ? mirrorMap(wsF) : null, wsF, wsR ? mirrorMap(wsR) : null, wsR],
      wheelStatic: [wtF ? mirrorMap(wtF) : null, wtF, wtR ? mirrorMap(wtR) : null, wtR],
    });
  }
  return { levels };
}

const _geoCache = new Map();

function acquireGeometry(tier) {
  let e = _geoCache.get(tier);
  if (e) { e.refs++; return e.set; }
  const set = buildGeometrySet(tier);
  _geoCache.set(tier, { refs: 1, set });
  return set;
}

function releaseGeometry(tier) {
  const e = _geoCache.get(tier);
  if (!e) return;
  if (--e.refs > 0) return;
  try {
    for (const lvl of e.set.levels) {
      disposeMap(lvl.body);
      if (lvl.drs) lvl.drs.dispose();
      for (let i = 0; i < 4; i++) {
        disposeMap(lvl.susp[i]);
        disposeMap(lvl.wheelSpin[i]);
        disposeMap(lvl.wheelStatic[i]);
      }
    }
  } catch (err) { /* ignore */ }
  _geoCache.delete(tier);
}

/* ========================================================================== */
/*  CarModel                                                                  */
/* ========================================================================== */

const FALLBACK_TEAM = {
  id: 'apex', name: 'Apex Works', short: 'APX', engine: 'Apex RE-0', base: 'Nowhere',
  colors: { primary: '#1d4ed8', secondary: '#0b0f18', accent: '#f5c518', trim: '#ffffff' },
  livery: 'stripe', sponsors: ['APEX', 'VECTOR', 'NIMBUS'],
  drivers: [],
};
const FALLBACK_DRIVER = {
  num: 0, name: 'Test Driver', short: 'TST', country: 'GB',
  helmet: { base: '#1d4ed8', stripe: '#f5c518', visor: '#111111' },
};

const HUB_Y = [DIM.frontTyreR, DIM.frontTyreR, DIM.rearTyreR, DIM.rearTyreR];
const HUB_X = [-DIM.frontHubX, DIM.frontHubX, -DIM.rearHubX, DIM.rearHubX];
const HUB_Z = [DIM.frontAxleZ, DIM.frontAxleZ, DIM.rearAxleZ, DIM.rearAxleZ];
const SUSP_SIGN = [-1, 1, -1, 1];
const SUSP_ARM = 0.45;          // outboard lever arm used to convert travel to arm rotation
const TRAVEL_RANGE = 0.055;     // total visible suspension travel, metres
const MAX_STEER = 0.31;         // radians at full lock, used only if steerAngle is absent

class CarModel {
  constructor(opts) {
    const o = opts || {};
    this.team = o.team || FALLBACK_TEAM;
    this.driver = o.driver || (this.team.drivers && this.team.drivers[0]) || FALLBACK_DRIVER;
    this.quality = o.quality || { tier: 'high', shadows: true, anisotropy: 8 };
    this._tier = TIER_DETAIL[this.quality.tier] !== undefined ? this.quality.tier : 'high';
    this._tyreSize = TIER_TYRESIZE[this._tier] || 512;

    this.group = new THREE.Group();
    this.group.name = 'apexCar_' + this.team.id + '_' + this.driver.num;
    this.group.userData.carModel = this;
    this.body = new THREE.Group();
    this.body.name = 'chassis';
    this.group.add(this.body);

    this.cockpitAnchor = new THREE.Object3D();
    this.cockpitAnchor.name = 'cockpitAnchor';
    this.cockpitAnchor.position.set(0, 0.318, 0.560);
    this.body.add(this.cockpitAnchor);

    this.wheels = [];
    this.lodLevel = 0;
    this.lodDistances = (o.lodDistances && o.lodDistances.length === 2)
      ? [o.lodDistances[0], o.lodDistances[1]]
      : (this._tier === 'low' ? [14, 48] : this._tier === 'medium' ? [20, 65] : [LOD_DISTANCES[0], LOD_DISTANCES[1]]);
    this.drsOpen = false;
    this.tyreCompound = o.tyreCompound || 'medium';

    // animation state (never allocate in update)
    this._drs = 0;
    this._drsTarget = 0;
    this._roll = 0;
    this._pitch = 0;
    this._ride = 0;
    this._rainT = 0;
    this._rainForced = false;
    this._rainOn = 0;
    this._discHeat = [0, 0, 0, 0];
    this._exhaust = 0;
    this._rollScale = o.rollScale !== undefined ? o.rollScale : 0.0070;
    this._pitchScale = o.pitchScale !== undefined ? o.pitchScale : 0.0050;

    this._lodBody = [null, null, null];
    this._lodWheel = [[], [], []];
    this._lodSusp = [[], [], []];
    this._lodDrs = [null, null, null];
    this._spins = [];
    this._susp = [];
    this._ownMats = [];
    this._sharedTex = [];
    this._acq = { geo: false, mats: false, tyre: false };

    try { this._build(); }
    catch (e) { this._buildFallback(); }

    this.setTyreCompound(this.tyreCompound);
    this.setLOD(0);
  }

  /* ------------------------------------------------------------------ */

  _build() {
    const shadows = this.quality.shadows !== false;
    this._geo = acquireGeometry(this._tier);
    this._acq.geo = true;
    this._shared = acquireSharedMaterials(this.team, this.driver, this._tier);
    this._acq.mats = true;
    const sm = this._shared.mats;

    const tyreTex = acquireTyre(this._tyreSize, TYRE_BANDS);
    this._acq.tyre = true;
    this._tyreTex = tyreTex;
    const slick = tyreTex.slick || {};

    this.tyreMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: slick.map || null,
      normalMap: slick.normalMap || null,
      roughnessMap: slick.roughnessMap || null,
      roughness: slick.roughnessMap ? 1.0 : 0.85,
      metalness: 0.0,
    });
    if (!slick.map) this.tyreMat.color.set(0x151517);
    if (this.tyreMat.normalMap) this.tyreMat.normalScale.set(0.85, 0.85);

    this.bandMat = new THREE.MeshStandardMaterial({
      color: 0xf5d800, emissive: 0xf5d800, emissiveIntensity: 0.10,
      roughness: 0.52, metalness: 0.0, side: THREE.DoubleSide,
    });
    this.lightMat = new THREE.MeshStandardMaterial({
      color: 0x2a0308, emissive: 0xff1220, emissiveIntensity: 0.0,
      roughness: 0.35, metalness: 0.0,
    });
    this.exhaustMat = new THREE.MeshStandardMaterial({
      color: 0x191411, emissive: 0xff4308, emissiveIntensity: 0.10,
      roughness: 0.55, metalness: 0.35, side: THREE.DoubleSide,
    });
    this.discMats = [];
    for (let i = 0; i < 4; i++) {
      this.discMats.push(new THREE.MeshStandardMaterial({
        color: 0x2b2825, emissive: 0x000000, emissiveIntensity: 0.0,
        roughness: 0.62, metalness: 0.10, side: THREE.DoubleSide,
      }));
    }
    this._ownMats.push(this.tyreMat, this.bandMat, this.lightMat, this.exhaustMat);
    for (const m of this.discMats) this._ownMats.push(m);

    const st = this._shared.textures;
    this._sharedTex.push(st.liveryMap, st.decalMap, st.detail.normalMap, st.detail.roughnessMap,
      st.carbon.map, st.carbon.normalMap, st.carbon.roughnessMap,
      st.metal.normalMap, st.metal.roughnessMap,
      slick.map, slick.normalMap, slick.roughnessMap);

    const baseMats = {
      paint: sm.paint, carbon: sm.carbon, metal: sm.metal, dark: sm.dark,
      glass: sm.glass, decal: sm.decal, titan: sm.titan,
      rubber: this.tyreMat, band: this.bandMat,
      light: this.lightMat, exhaust: this.exhaustMat, disc: this.discMats[0],
    };

    /* ---- chassis LODs ---- */
    for (let lv = 0; lv < 3; lv++) {
      const g = new THREE.Group();
      g.name = 'bodyLOD' + lv;
      const meshes = this._meshesFrom(this._geo.levels[lv].body, baseMats, shadows);
      for (const m of meshes) g.add(m);
      this.body.add(g);
      this._lodBody[lv] = g;
    }

    /* ---- DRS flap ---- */
    this.drsPivot = new THREE.Object3D();
    this.drsPivot.name = 'drsPivot';
    this.drsPivot.position.set(DRS_HINGE.x, DRS_HINGE.y, DRS_HINGE.z);
    this.body.add(this.drsPivot);
    for (let lv = 0; lv < 3; lv++) {
      const geo = this._geo.levels[lv].drs;
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, sm.paint);
      mesh.castShadow = shadows;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.drsPivot.add(mesh);
      this._lodDrs[lv] = mesh;
    }

    /* ---- suspension corners ---- */
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const side = HUB_X[i] < 0 ? -1 : 1;
      const piv = cornerPivot(front, side);
      const grp = new THREE.Object3D();
      grp.name = 'susp' + i;
      grp.position.copy(piv);
      this.body.add(grp);
      this._susp.push(grp);
      for (let lv = 0; lv < 3; lv++) {
        const map = this._geo.levels[lv].susp[i];
        const sub = new THREE.Group();
        if (map) {
          const meshes = this._meshesFrom(map, baseMats, shadows);
          for (const m of meshes) sub.add(m);
        }
        grp.add(sub);
        this._lodSusp[lv].push(sub);
      }
    }

    /* ---- wheels ---- */
    for (let i = 0; i < 4; i++) {
      const hub = new THREE.Object3D();
      hub.name = ['flWheel', 'frWheel', 'rlWheel', 'rrWheel'][i];
      hub.rotation.order = 'YXZ';
      hub.position.set(HUB_X[i], HUB_Y[i], HUB_Z[i]);
      this.group.add(hub);
      this.wheels.push(hub);

      const spin = new THREE.Object3D();
      spin.name = 'spin';
      hub.add(spin);
      this._spins.push(spin);
      hub.userData.spin = spin;

      const wheelMats = {};
      for (const k in baseMats) wheelMats[k] = baseMats[k];
      wheelMats.disc = this.discMats[i];

      for (let lv = 0; lv < 3; lv++) {
        const sg = new THREE.Group();
        const spinMap = this._geo.levels[lv].wheelSpin[i];
        if (spinMap) for (const m of this._meshesFrom(spinMap, wheelMats, shadows)) sg.add(m);
        spin.add(sg);

        const tg = new THREE.Group();
        const statMap = this._geo.levels[lv].wheelStatic[i];
        if (statMap) for (const m of this._meshesFrom(statMap, wheelMats, shadows)) tg.add(m);
        hub.add(tg);

        this._lodWheel[lv].push(sg, tg);
      }
    }
  }

  _meshesFrom(map, mats, shadows) {
    const out = [];
    if (!map) return out;
    for (const entry of map) {
      const mat = mats[entry[0]];
      if (!mat || !entry[1]) continue;
      const mesh = new THREE.Mesh(entry[1], mat);
      mesh.name = entry[0];
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows && entry[0] !== 'glass' && entry[0] !== 'light';
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      out.push(mesh);
    }
    return out;
  }

  /** Absolute last resort so the race can still run if geometry generation dies. */
  _buildFallback() {
    try {
      if (!this.body) { this.body = new THREE.Group(); this.group.add(this.body); }
      const g = new THREE.BoxGeometry(1.6, 0.7, 4.8);
      g.translate(0, 0.45, 0);
      const m = new THREE.MeshStandardMaterial({ color: this.team.colors.primary, roughness: 0.35, metalness: 0.1 });
      this._ownMats.push(m);
      const mesh = new THREE.Mesh(g, m);
      this.body.add(mesh);
      this._lodBody[0] = this.body;
      if (this.wheels.length === 0) {
        for (let i = 0; i < 4; i++) {
          const hub = new THREE.Object3D();
          hub.rotation.order = 'YXZ';
          hub.position.set(HUB_X[i], HUB_Y[i], HUB_Z[i]);
          this.group.add(hub);
          const spin = new THREE.Object3D();
          hub.add(spin);
          this.wheels.push(hub);
          this._spins.push(spin);
        }
      }
      this._degraded = true;
    } catch (e) { /* nothing left to do */ }
  }

  /* --------------------------------- API ---------------------------------- */

  setDRS(open) {
    this.drsOpen = !!open;
    this._drsTarget = this.drsOpen ? 1 : 0;
  }

  setRainLight(on) { this._rainForced = !!on; }

  setBodyResponse(rollScale, pitchScale) {
    if (typeof rollScale === 'number') this._rollScale = rollScale;
    if (typeof pitchScale === 'number') this._pitchScale = pitchScale;
  }

  setLOD(level) {
    const lv = clamp(Math.round(level || 0), 0, 2);
    this.lodLevel = lv;
    for (let i = 0; i < 3; i++) {
      const on = i === lv;
      if (this._lodBody[i] && this._lodBody[i] !== this.body) this._lodBody[i].visible = on;
      if (this._lodDrs[i]) this._lodDrs[i].visible = on;
      const ws = this._lodWheel[i];
      for (let k = 0; k < ws.length; k++) ws[k].visible = on;
      const ss = this._lodSusp[i];
      for (let k = 0; k < ss.length; k++) ss[k].visible = on;
    }
    return lv;
  }

  /** Convenience: pick a level from the camera distance. */
  updateLOD(cameraPosition) {
    if (!cameraPosition) return this.lodLevel;
    const dist = this.group.position.distanceTo(cameraPosition);
    const lv = dist < this.lodDistances[0] ? 0 : (dist < this.lodDistances[1] ? 1 : 2);
    if (lv !== this.lodLevel) this.setLOD(lv);
    return lv;
  }

  setTyreCompound(name) {
    try {
      const key = (name && TYRE_COMPOUNDS[name]) ? name : 'medium';
      this.tyreCompound = key;
      const c = TYRE_COMPOUNDS[key];
      if (this.bandMat) {
        this.bandMat.color.set(c.color);
        this.bandMat.emissive.set(c.color);
        this.bandMat.emissiveIntensity = 0.12;
      }
      const wet = (key === 'wet' || key === 'inter');
      const set = this._tyreTex ? (wet ? this._tyreTex.wet : this._tyreTex.slick) : null;
      if (set && this.tyreMat) {
        const changed = this.tyreMat.map !== (set.map || null);
        this.tyreMat.map = set.map || null;
        this.tyreMat.normalMap = set.normalMap || null;
        this.tyreMat.roughnessMap = set.roughnessMap || null;
        if (changed) this.tyreMat.needsUpdate = true;
      }
    } catch (e) { /* keep the previous compound */ }
  }

  setQuality(q) {
    try {
      if (!q) return;
      this.quality = q;
      const aniso = clamp(Math.round(q.anisotropy || 4), 1, 16);
      for (let i = 0; i < this._sharedTex.length; i++) {
        const t = this._sharedTex[i];
        if (t && t.anisotropy !== aniso) { t.anisotropy = aniso; t.needsUpdate = true; }
      }
      const shadows = q.shadows !== false;
      this.group.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = shadows;
          o.receiveShadow = shadows && o.name !== 'glass' && o.name !== 'light';
        }
      });
      const hi = q.tier === 'high' || q.tier === 'ultra';
      const sm = this._shared && this._shared.mats;
      if (sm) {
        if (sm.paint) { sm.paint.clearcoat = hi ? 0.9 : 0.5; sm.paint.needsUpdate = true; }
        if (sm.carbon) { sm.carbon.clearcoat = hi ? 0.55 : 0.25; sm.carbon.needsUpdate = true; }
        if (sm.decal) sm.decal.clearcoat = hi ? 0.85 : 0.45;
      }
      if (this.tyreMat) this.tyreMat.normalScale.set(hi ? 0.85 : 0.4, hi ? 0.85 : 0.4);
    } catch (e) { /* ignore */ }
  }

  /* -------------------------------- update -------------------------------- */

  update(state, dt) {
    if (!state) return;
    const d = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0.0166;
    const ws = state.wheels;
    let compSum = 0;

    for (let i = 0; i < 4; i++) {
      const hub = this.wheels[i];
      if (!hub) continue;
      const w = ws ? ws[i] : null;
      const spin = this._spins[i];

      if (w) {
        if (spin) spin.rotation.x = w.spinAngle || 0;
        if (i < 2) {
          hub.rotation.y = (w.steerAngle !== undefined && w.steerAngle !== null)
            ? w.steerAngle
            : (state.steer || 0) * MAX_STEER;
        }
        const comp = (w.compression !== undefined && w.compression !== null) ? w.compression : 0.5;
        compSum += comp;
        const target = HUB_Y[i] + (comp - 0.5) * TRAVEL_RANGE;
        hub.position.y = damp(hub.position.y, target, 26, d);
      } else {
        compSum += 0.5;
        if (spin && state.speed) {
          spin.rotation.x = (spin.rotation.x + (state.speed / HUB_Y[i]) * d) % 6.283185307179586;
        }
        if (i < 2) hub.rotation.y = (state.steer || 0) * MAX_STEER;
      }

      const arm = this._susp[i];
      if (arm) arm.rotation.z = SUSP_SIGN[i] * (hub.position.y - HUB_Y[i]) / SUSP_ARM;
    }

    /* ---- chassis attitude ---- */
    const gf = state.gForce;
    const gl = gf && typeof gf.lat === 'number' ? clamp(gf.lat, -6, 6) : 0;
    const gn = gf && typeof gf.lon === 'number' ? clamp(gf.lon, -6, 6) : 0;
    this._roll = damp(this._roll, gl * this._rollScale, 8.5, d);
    this._pitch = damp(this._pitch, -gn * this._pitchScale, 7.5, d);
    this.body.rotation.z = this._roll;
    this.body.rotation.x = this._pitch;
    const rideTarget = -((compSum * 0.25) - 0.5) * 0.020;
    this._ride = damp(this._ride, rideTarget, 12, d);
    this.body.position.y = this._ride;

    /* ---- DRS ---- */
    const wantDrs = (typeof state.drs === 'boolean') ? (state.drs ? 1 : 0) : this._drsTarget;
    this._drs = damp(this._drs, wantDrs, 11, d);
    if (this.drsPivot) this.drsPivot.rotation.x = this._drs * DRS_OPEN_ANGLE;

    /* ---- brake disc glow ---- */
    const brake = state.brake || 0;
    const spd = state.speed || 0;
    const speedF = spd > 70 ? 1 : spd / 70;
    for (let i = 0; i < 4; i++) {
      const m = this.discMats && this.discMats[i];
      if (!m) continue;
      const w = ws ? ws[i] : null;
      let t = brake * speedF * (i < 2 ? 1.0 : 0.74);
      if (w && w.lockedUp) t = t < 0.55 ? 0.55 : t;
      if (t > 1) t = 1;
      const cur = this._discHeat[i];
      this._discHeat[i] = damp(cur, t, t > cur ? 6.0 : 0.85, d);
      const h = this._discHeat[i];
      if (h < 0.02) {
        if (m.emissiveIntensity !== 0) { m.emissiveIntensity = 0; m.emissive.setRGB(0, 0, 0); }
      } else {
        const hh = h * h;
        m.emissive.setRGB(1.0, 0.055 + 0.34 * hh, 0.004 + 0.05 * hh * hh);
        m.emissiveIntensity = hh * 3.1;
      }
    }

    /* ---- rain light ---- */
    this._rainT += d;
    const rainActive = (typeof state.rainLight === 'boolean') ? state.rainLight : this._rainForced;
    let lightTarget;
    if (rainActive) {
      lightTarget = ((this._rainT * 4.0) % 1.0) < 0.5 ? 4.0 : 0.0;
    } else {
      lightTarget = brake > 0.04 ? 1.6 * brake : 0.0;
    }
    if (this.lightMat) {
      this._rainOn = rainActive ? lightTarget : damp(this._rainOn, lightTarget, 18, d);
      this.lightMat.emissiveIntensity = this._rainOn;
    }

    /* ---- exhaust heat ---- */
    if (this.exhaustMat) {
      const rpmF = state.rpm ? clamp(state.rpm / 12000, 0, 1) : 0;
      const eT = 0.10 + (state.throttle || 0) * rpmF * 1.5;
      this._exhaust = damp(this._exhaust, eT, 5, d);
      this.exhaustMat.emissiveIntensity = this._exhaust;
    }
  }

  /* -------------------------------- teardown ------------------------------ */

  dispose() {
    try {
      if (this.group.parent) this.group.parent.remove(this.group);
      this.group.traverse((o) => { if (o.isMesh) o.geometry = undefined; });
      this.group.clear();
      if (this.body) this.body.clear();
      for (let i = 0; i < this._ownMats.length; i++) {
        const m = this._ownMats[i];
        if (m && typeof m.dispose === 'function') m.dispose();
      }
      this._ownMats.length = 0;
      if (this._acq.geo) { releaseGeometry(this._tier); this._acq.geo = false; }
      if (this._acq.mats) { releaseSharedMaterials(this.team, this.driver, this._tier); this._acq.mats = false; }
      if (this._acq.tyre) { releaseTyre(this._tyreSize); this._acq.tyre = false; }
      this._geo = null;
      this._shared = null;
      this._tyreTex = null;
      this._sharedTex.length = 0;
      this.wheels.length = 0;
      this._spins.length = 0;
      this._susp.length = 0;
      this.discMats = null;
    } catch (e) { /* teardown must never throw */ }
  }
}

/**
 * Build one car.
 *
 * @param {Object} opts
 * @param {Object} opts.team    entry from src/game/teams.js
 * @param {Object} opts.driver  a driver record from that team
 * @param {Object} opts.quality quality tier object from ARCHITECTURE.md
 * @returns {CarModel}
 */
export function createCarModel(opts) {
  return new CarModel(opts || {});
}

export default createCarModel;

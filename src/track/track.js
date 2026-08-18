/**
 * APEX F1 — Track sampler.
 *
 * Turns a circuit definition into a fast, allocation-free query surface:
 * arc-length parameterisation, surface lookup, a solved racing line and a
 * physics-derived speed profile that both the AI and the driving aids use.
 */
import * as THREE from 'three';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

const SAMPLES = 2400;          // LUT resolution around the lap
const GRID_CELL = 24;          // metres, spatial hash for project()

/** Reusable sample record — sample() fills and returns this unless a target is given. */
function makeSample() {
  return {
    s: 0,
    pos: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 1, 0),
    lateral: new THREE.Vector3(1, 0, 0),
    width: 7,
    banking: 0,
    curvature: 0,
    gradient: 0,
  };
}

export function createTrack(circuit) {
  // ---- 1. Build the centreline curve -------------------------------------
  const ctrl = circuit.points.map((p) => new THREE.Vector3(p[0], p[2] ?? 0, p[1]));
  const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal', 0.5);
  const halfWidths = circuit.points.map((p) => (p[3] != null ? p[3] : 7.0));

  // ---- 2. Arc-length LUT --------------------------------------------------
  const N = SAMPLES;
  const pos = new Float32Array(N * 3);
  const tan = new Float32Array(N * 3);
  const nrm = new Float32Array(N * 3);
  const lat = new Float32Array(N * 3);
  const cum = new Float32Array(N + 1);
  const wid = new Float32Array(N);
  const bank = new Float32Array(N);
  const curv = new Float32Array(N);
  const grad = new Float32Array(N);

  // Dense pre-pass at uniform t, then resample to uniform arc length.
  const M = N * 3;
  const rawP = [];
  let rawLen = 0;
  const rawCum = new Float64Array(M + 1);
  for (let i = 0; i <= M; i++) {
    const p = curve.getPoint((i % M) / M, new THREE.Vector3());
    rawP.push(p);
    if (i > 0) { rawLen += p.distanceTo(rawP[i - 1]); rawCum[i] = rawLen; }
  }
  const length = rawLen;

  // Walk uniform arc-length stations, mapping back to curve parameter t.
  let ri = 0;
  const tOf = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const target = (i / N) * length;
    while (ri < M && rawCum[ri + 1] < target) ri++;
    const seg = rawCum[ri + 1] - rawCum[ri] || 1e-6;
    const f = (target - rawCum[ri]) / seg;
    tOf[i] = ((ri + f) / M) % 1;
    cum[i] = target;
  }
  cum[N] = length;

  // Control-point index (in normalised lap distance) for width interpolation.
  const cpU = ctrl.map((_, i) => i / ctrl.length);

  for (let i = 0; i < N; i++) {
    const t = tOf[i];
    const p = curve.getPoint(t, new THREE.Vector3());
    const tg = curve.getTangent(t, new THREE.Vector3()).normalize();
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    tan[i * 3] = tg.x; tan[i * 3 + 1] = tg.y; tan[i * 3 + 2] = tg.z;
    grad[i] = tg.y;

    // half-width: catmull-ish interpolation over the control ring
    const u = i / N;
    const fi = u * ctrl.length;
    const i0 = Math.floor(fi) % ctrl.length;
    const i1 = (i0 + 1) % ctrl.length;
    const ff = fi - Math.floor(fi);
    wid[i] = halfWidths[i0] * (1 - ff) + halfWidths[i1] * ff;
  }

  // ---- 2b. Vertical smoothing -------------------------------------------
  // Catmull-Rom through control points ~65 m apart can produce vertical
  // curvature of ~0.01 1/m. At 90 m/s that is 8 g of vertical acceleration:
  // the car gets thrown off the road, the front unloads to zero and it washes
  // straight off. Smooth the elevation until the profile is physically
  // driveable, keeping long grades intact (this only removes short-wavelength
  // content) and then rebuild the tangents' vertical component to match.
  {
    const ds = length / N;
    const y = new Float32Array(N);
    for (let i = 0; i < N; i++) y[i] = pos[i * 3 + 1];
    const tmp = new Float32Array(N);
    const MAX_VCURV = 0.0016;            // ~1.3 g at 90 m/s
    const measure = () => {
      let m = 0;
      for (let i = 0; i < N; i++) {
        const a = (i - 1 + N) % N, b = (i + 1) % N;
        m = Math.max(m, Math.abs((y[b] - 2 * y[i] + y[a]) / (ds * ds)));
      }
      return m;
    };
    let passes = 0;
    while (measure() > MAX_VCURV && passes < 900) {
      for (let k = 0; k < 20; k++) {
        for (let i = 0; i < N; i++) {
          const a = (i - 1 + N) % N, b = (i + 1) % N;
          tmp[i] = (y[a] + 2 * y[i] + y[b]) * 0.25;
        }
        y.set(tmp);
        passes++;
      }
    }
    for (let i = 0; i < N; i++) pos[i * 3 + 1] = y[i];
    // Rebuild tangents so the vertical component matches the smoothed profile.
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      const hx = pos[b * 3] - pos[a * 3];
      const hz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const hy = y[b] - y[a];
      const len = Math.hypot(hx, hy, hz) || 1;
      tan[i * 3] = hx / len; tan[i * 3 + 1] = hy / len; tan[i * 3 + 2] = hz / len;
      grad[i] = hy / len;
    }
  }

  // Curvature + frames (second pass, needs neighbours)
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N, b = (i + 1) % N;
    _v0.set(tan[a * 3], 0, tan[a * 3 + 2]).normalize();
    _v1.set(tan[b * 3], 0, tan[b * 3 + 2]).normalize();
    const ds = (cum[b] - cum[a] + length) % length || 1e-6;
    // signed planar curvature
    const cross = _v0.x * _v1.z - _v0.z * _v1.x;
    const dot = THREE.MathUtils.clamp(_v0.dot(_v1), -1, 1);
    const dTheta = Math.atan2(cross, dot);
    curv[i] = -dTheta / ds;

    // frame: lateral = right-hand side of travel, banked toward the inside
    _v2.set(tan[i * 3], tan[i * 3 + 1], tan[i * 3 + 2]);
    _v0.crossVectors(UP, _v2).normalize();          // right-hand side of travel
    if (!isFinite(_v0.x) || _v0.lengthSq() < 1e-8) _v0.set(1, 0, 0);
    // Camber is applied in a second pass — it must be smoothed over a long
    // window first, or a hairpin entry twists the road ~1 m at the edge and
    // launches cars off the surface.
    bank[i] = THREE.MathUtils.clamp(curv[i] * 6.0, -0.055, 0.055);
    lat[i * 3] = _v0.x; lat[i * 3 + 1] = _v0.y; lat[i * 3 + 2] = _v0.z;
  }

  // Smooth the camber over ~90 m, then build the banked frames.
  {
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < 26; pass++) {
      for (let i = 0; i < N; i++) {
        const a = (i - 1 + N) % N, b = (i + 1) % N;
        tmp[i] = (bank[a] + 2 * bank[i] + bank[b]) / 4;
      }
      bank.set(tmp);
    }
    for (let i = 0; i < N; i++) {
      _v2.set(tan[i * 3], tan[i * 3 + 1], tan[i * 3 + 2]).normalize();
      _v0.set(lat[i * 3], lat[i * 3 + 1], lat[i * 3 + 2]);
      _q0.setFromAxisAngle(_v2, bank[i]);
      _v0.applyQuaternion(_q0).normalize();
      _v1.crossVectors(_v0, _v2).normalize();        // up (banked)
      if (_v1.y < 0) _v1.negate();
      lat[i * 3] = _v0.x; lat[i * 3 + 1] = _v0.y; lat[i * 3 + 2] = _v0.z;
      nrm[i * 3] = _v1.x; nrm[i * 3 + 1] = _v1.y; nrm[i * 3 + 2] = _v1.z;
    }
  }

  // Smooth curvature (it drives the racing line and the speed profile)
  const cs = new Float32Array(N);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < N; i++) {
      const a = (i - 2 + N) % N, b = (i - 1 + N) % N, c = (i + 1) % N, d = (i + 2) % N;
      cs[i] = (curv[a] + 2 * curv[b] + 4 * curv[i] + 2 * curv[c] + curv[d]) / 10;
    }
    curv.set(cs);
  }

  // ---- 3. Spatial hash for project() -------------------------------------
  const grid = new Map();
  const key = (cx, cz) => cx * 100003 + cz;
  for (let i = 0; i < N; i++) {
    const cx = Math.floor(pos[i * 3] / GRID_CELL);
    const cz = Math.floor(pos[i * 3 + 2] / GRID_CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const k = key(cx + ox, cz + oz);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(i);
      }
    }
  }

  // ---- 4. Surface bands (normalised ranges -> metres) ---------------------
  const kerbs = (circuit.kerbs || []).map((k) => ({
    from: k.from * length, to: k.to * length, side: k.side || 'both', aggression: k.aggression ?? 0.5,
  }));
  const surfaces = (circuit.surfaces || []).map((sf) => ({
    from: sf.from * length, to: sf.to * length, side: sf.side || 'both',
    type: sf.type || 'grass', width: sf.width ?? 12,
  }));
  const drsZones = (circuit.drsZones || []).map((z) => ({
    detectS: z.detect * length, startS: z.start * length, endS: z.end * length,
  }));
  const sectors = [0, (circuit.sectors?.[0] ?? 0.34) * length, (circuit.sectors?.[1] ?? 0.68) * length];

  const inBand = (s, from, to) => (from <= to ? s >= from && s <= to : s >= from || s <= to);

  const SURFACE = {
    asphalt:  { grip: 1.00, roughness: 0.02, drag: 0.000 },
    kerb:     { grip: 0.86, roughness: 0.55, drag: 0.010 },
    astro:    { grip: 0.74, roughness: 0.20, drag: 0.028 },
    grass:    { grip: 0.52, roughness: 0.36, drag: 0.085 },
    gravel:   { grip: 0.36, roughness: 0.70, drag: 0.260 },
    concrete: { grip: 0.88, roughness: 0.08, drag: 0.005 },
    pit:      { grip: 0.97, roughness: 0.03, drag: 0.000 },
    wall:     { grip: 0.30, roughness: 1.00, drag: 0.500 },
  };

  // ---- 5. Racing line (minimum-curvature relaxation) ---------------------
  // Solved on a DECIMATED grid: a +-1 stencil at 2 m spacing would need
  // O(n^2) iterations to propagate across a corner, and converges to the
  // centreline. ~18 m stations let the line actually swing out-in-out.
  const CAR_HALF = 1.02;
  const line = new Float32Array(N);
  {
    const M = Math.max(96, Math.min(420, Math.round(length / 18)));
    const step = N / M;
    const idx = new Int32Array(M);
    const px = new Float64Array(M), pz = new Float64Array(M), py = new Float64Array(M);
    const lx = new Float64Array(M), lz = new Float64Array(M);
    const lim = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      const k = Math.round(i * step) % N;
      idx[i] = k;
      px[i] = pos[k * 3]; py[i] = pos[k * 3 + 1]; pz[i] = pos[k * 3 + 2];
      lx[i] = lat[k * 3]; lz[i] = lat[k * 3 + 2];
      lim[i] = Math.max(0.4, wid[k] - CAR_HALF - 0.45);   // keep clear of the edge
    }
    const off = new Float64Array(M);
    // Minimise curvature directly by gradient descent on E = sum |p_{i-1} - 2 p_i + p_{i+1}|^2,
    // where p_i = centre_i + off_i * lateral_i.  (Pulling each point toward its
    // neighbours' chord midpoint instead minimises LENGTH, which hugs the inside
    // of every corner and makes the apex tighter than the centreline.)
    {
      const dx = new Float64Array(M), dz = new Float64Array(M);
      // Descent step must satisfy eta * 2 * 16 < 2 for the biharmonic operator.
      const eta = 0.028;
      for (let iter = 0; iter < 9000; iter++) {
        for (let i = 0; i < M; i++) {
          const a2 = (i - 1 + M) % M, b2 = (i + 1) % M;
          const pax = px[a2] + lx[a2] * off[a2], paz = pz[a2] + lz[a2] * off[a2];
          const pbx = px[i] + lx[i] * off[i], pbz = pz[i] + lz[i] * off[i];
          const pcx = px[b2] + lx[b2] * off[b2], pcz = pz[b2] + lz[b2] * off[b2];
          dx[i] = pax - 2 * pbx + pcx;
          dz[i] = paz - 2 * pbz + pcz;
        }
        for (let i = 0; i < M; i++) {
          const a2 = (i - 1 + M) % M, b2 = (i + 1) % M;
          const gx = dx[a2] - 2 * dx[i] + dx[b2];
          const gz = dz[a2] - 2 * dz[i] + dz[b2];
          const grad2 = gx * lx[i] + gz * lz[i];
          const v = off[i] - eta * grad2;   // descent, not ascent
          off[i] = v < -lim[i] ? -lim[i] : v > lim[i] ? lim[i] : v;
        }
      }
    }
    // Late-apex bias: sacrifice a little entry for a better exit.
    {
      const biased = new Float64Array(M);
      for (let i = 0; i < M; i++) {
        const back = (i - 1 + M) % M;
        biased[i] = off[i] * 0.86 + off[back] * 0.14;
        biased[i] = Math.max(-lim[i], Math.min(lim[i], biased[i]));
      }
      off.set(biased);
    }
    // Upsample back to the full LUT with Catmull-Rom in the offset domain.
    for (let i = 0; i < N; i++) {
      const f = (i / N) * M;
      const i1 = Math.floor(f) % M;
      const t = f - Math.floor(f);
      const i0 = (i1 - 1 + M) % M, i2 = (i1 + 1) % M, i3 = (i1 + 2) % M;
      const p0 = off[i0], p1 = off[i1], p2 = off[i2], p3 = off[i3];
      const t2 = t * t, t3 = t2 * t;
      line[i] = 0.5 * ((2 * p1) + (-p0 + p2) * t
              + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      const l = Math.max(0.4, wid[i] - CAR_HALF - 0.45);
      line[i] = Math.max(-l, Math.min(l, line[i]));
    }
  }

  // Curvature *of the racing line* — what actually limits speed.
  const lineCurv = new Float32Array(N);
  {
    const span = Math.max(4, Math.round(N / (length / 12)));   // ~12 m arms
    for (let i = 0; i < N; i++) {
      const a = (i - span + N) % N, b = (i + span) % N;
      const ax = pos[a * 3] + lat[a * 3] * line[a], az = pos[a * 3 + 2] + lat[a * 3 + 2] * line[a];
      const bx = pos[i * 3] + lat[i * 3] * line[i], bz = pos[i * 3 + 2] + lat[i * 3 + 2] * line[i];
      const cx = pos[b * 3] + lat[b * 3] * line[b], cz = pos[b * 3 + 2] + lat[b * 3 + 2] * line[b];
      const abx = bx - ax, abz = bz - az, bcx = cx - bx, bcz = cz - bz, acx = cx - ax, acz = cz - az;
      const area2 = abx * bcz - abz * bcx;
      const la = Math.hypot(abx, abz), lb = Math.hypot(bcx, bcz), lc = Math.hypot(acx, acz);
      const denom = la * lb * lc;
      lineCurv[i] = denom > 1e-6 ? (2 * area2) / denom : 0;
    }
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < N; i++) {
        const a = (i - 1 + N) % N, b = (i + 1) % N;
        tmp[i] = (lineCurv[a] + 2 * lineCurv[i] + lineCurv[b]) / 4;
      }
      lineCurv.set(tmp);
    }
  }

  // ---- 6. Speed profile ---------------------------------------------------
  // Reference car matched to the actual vehicle model's measured capability
  // (load-sensitive mu ~1.62 at cornering loads, ClA including ground effect).
  const speed = new Float32Array(N);
  // Matched to the actual vehicle: race mass INCLUDING fuel, mu after the
  // compound factor and a realistic thermal state, ClA including ground effect.
  const REF = { m: 900, mu: 1.50, ClA: 5.20, CdA: 1.30, rho: 1.21, g: 9.81, aAcc: 11.0, aBrk: 42.0, vMax: 93, safety: 0.945 };
  function solveProfile(gripScale = 1) {
    const mu = REF.mu * gripScale;
    // Solve numerically: the closed form ignores tyre LOAD SENSITIVITY, and in
    // the regime where aero grip appears to outgrow demand it returns "max
    // speed" for corners the car cannot physically take. Grip per unit load
    // falls as downforce piles on, so the limit has to be found by bisection
    // against the same mu model the tyres actually use.
    const FZ0 = 2565;              // mean of the front/rear reference loads
    const LOADSENS = 0.140;
    for (let i = 0; i < N; i++) {
      const k = Math.abs(lineCurv[i]);
      if (k < 1e-5) { speed[i] = REF.vMax; continue; }
      let lo = 4, hi = REF.vMax;
      for (let it = 0; it < 26; it++) {
        const v = (lo + hi) * 0.5;
        const Fz = REF.m * REF.g + 0.5 * REF.rho * REF.ClA * v * v;
        const muEff = mu * Math.pow(FZ0 / Math.max(400, Fz * 0.25), LOADSENS);
        if (REF.m * v * v * k <= muEff * Fz) lo = v; else hi = v;
      }
      speed[i] = Math.min(lo * REF.safety, REF.vMax);
    }
    const ds = length / N;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < N; i++) {            // forward: traction-limited
        const j = (i + 1) % N;
        const v = speed[i];
        const aeroGrip = 1 + (0.5 * REF.rho * REF.ClA * v * v) / (REF.m * REF.g);
        // Gravity along the road: climbing costs acceleration, descending adds it.
        const slopeA = REF.g * grad[i];
        const aMax = Math.max(0.8, Math.min(REF.aAcc * Math.min(1.7, aeroGrip) * gripScale, 24 - v * 0.20) - slopeA);
        const limF = Math.sqrt(Math.max(0, v * v + 2 * aMax * ds));
        if (speed[j] > limF) speed[j] = limF;
      }
      for (let i = N - 1; i >= 0; i--) {       // backward: braking-limited
        const j = (i + 1) % N;
        const v = speed[j];
        const aeroGrip = 1 + (0.5 * REF.rho * REF.ClA * v * v) / (REF.m * REF.g);
        // Braking downhill is materially worse; uphill helps.
        const bMax = Math.max(6, REF.aBrk * Math.min(2.4, aeroGrip) * gripScale * 0.42 + REF.g * grad[i]);
        const limB = Math.sqrt(Math.max(0, v * v + 2 * bMax * ds));
        if (speed[i] > limB) speed[i] = limB;
      }
    }
  }
  solveProfile(1);

  // ---- 7. Pit lane --------------------------------------------------------
  const pitCfg = circuit.pit || { entry: 0.94, exit: 0.06, side: 'left', laneOffset: 13, speedLimit: 22.2 };
  const pit = {
    entryS: pitCfg.entry * length,
    exitS: pitCfg.exit * length,
    side: pitCfg.side,
    laneOffset: pitCfg.laneOffset ?? 13,
    speedLimit: pitCfg.speedLimit ?? 22.2,
    boxS: [],
    lane(s) {
      const sign = pitCfg.side === 'right' ? 1 : -1;
      const span = (pit.exitS - pit.entryS + length) % length;
      let d = (s - pit.entryS + length) % length;
      if (d > span) return 0;
      const f = d / Math.max(1, span);
      const ramp = Math.min(1, f / 0.14) * Math.min(1, (1 - f) / 0.14);
      return sign * pit.laneOffset * THREE.MathUtils.clamp(ramp, 0, 1);
    },
    contains(s) {
      const span = (pit.exitS - pit.entryS + length) % length;
      return ((s - pit.entryS + length) % length) <= span;
    },
  };
  for (let i = 0; i < 20; i++) {
    const span = (pit.exitS - pit.entryS + length) % length;
    pit.boxS.push((pit.entryS + span * (0.28 + i * 0.021)) % length);
  }

  // ---- 8. Starting grid ---------------------------------------------------
  const startGrid = [];
  {
    const gridStartS = (length - 190) % length;
    for (let i = 0; i < 20; i++) {
      const row = Math.floor(i / 2);
      const s = (gridStartS + row * 8.6) % length;
      const sideSign = i % 2 === 0 ? -1 : 1;
      const idx = Math.floor((s / length) * N) % N;
      const off = sideSign * (wid[idx] * 0.46);
      const p = new THREE.Vector3(
        pos[idx * 3] + lat[idx * 3] * off,
        pos[idx * 3 + 1] + lat[idx * 3 + 1] * off + 0.02,
        pos[idx * 3 + 2] + lat[idx * 3 + 2] * off,
      );
      startGrid.push({
        pos: p,
        heading: Math.atan2(tan[idx * 3], tan[idx * 3 + 2]),
        s, lateral: off,
      });
    }
  }

  // ---- 9. Public API ------------------------------------------------------
  const _s = makeSample();
  const idxOf = (s) => {
    let u = (s % length + length) % length;
    return (u / length) * N;
  };

  /**
   * Catmull-Rom across four stations. Linear interpolation leaves a slope
   * discontinuity at every station (~2 m apart); at racing speed the car hits
   * one every ~25 ms, which hammers the suspension, unloads the tyres and
   * makes the car undriveable. The road surface has to be C1.
   */
  function cr(a, b, c, d, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * b) + (-a + c) * t
      + (2 * a - 5 * b + 4 * c - d) * t2
      + (-a + 3 * b - 3 * c + d) * t3);
  }
  function sample(s, target) {
    const out = target || _s;
    const fi = idxOf(s);
    const i1 = Math.floor(fi) % N;
    const f = fi - Math.floor(fi);
    const i0 = (i1 - 1 + N) % N, i2 = (i1 + 1) % N, i3 = (i1 + 2) % N;
    const a3 = i0 * 3, b3 = i1 * 3, c3 = i2 * 3, d3 = i3 * 3;
    out.s = (s % length + length) % length;
    out.pos.set(
      cr(pos[a3], pos[b3], pos[c3], pos[d3], f),
      cr(pos[a3 + 1], pos[b3 + 1], pos[c3 + 1], pos[d3 + 1], f),
      cr(pos[a3 + 2], pos[b3 + 2], pos[c3 + 2], pos[d3 + 2], f),
    );
    out.tangent.set(
      cr(tan[a3], tan[b3], tan[c3], tan[d3], f),
      cr(tan[a3 + 1], tan[b3 + 1], tan[c3 + 1], tan[d3 + 1], f),
      cr(tan[a3 + 2], tan[b3 + 2], tan[c3 + 2], tan[d3 + 2], f),
    ).normalize();
    out.normal.set(
      cr(nrm[a3], nrm[b3], nrm[c3], nrm[d3], f),
      cr(nrm[a3 + 1], nrm[b3 + 1], nrm[c3 + 1], nrm[d3 + 1], f),
      cr(nrm[a3 + 2], nrm[b3 + 2], nrm[c3 + 2], nrm[d3 + 2], f),
    ).normalize();
    out.lateral.set(
      cr(lat[a3], lat[b3], lat[c3], lat[d3], f),
      cr(lat[a3 + 1], lat[b3 + 1], lat[c3 + 1], lat[d3 + 1], f),
      cr(lat[a3 + 2], lat[b3 + 2], lat[c3 + 2], lat[d3 + 2], f),
    ).normalize();
    out.width = cr(wid[i0], wid[i1], wid[i2], wid[i3], f);
    out.banking = cr(bank[i0], bank[i1], bank[i2], bank[i3], f);
    out.curvature = cr(curv[i0], curv[i1], curv[i2], curv[i3], f);
    out.gradient = cr(grad[i0], grad[i1], grad[i2], grad[i3], f);
    return out;
  }

  const _proj = { s: 0, lateral: 0, height: 0, onTrack: false, index: 0 };
  function project(p, hintS) {
    let best = -1, bestD = Infinity;
    if (hintS != null) {
      // Local search around the hint — the common case, and O(1).
      const c = Math.floor(idxOf(hintS));
      for (let d = -26; d <= 26; d++) {
        const i = (c + d + N) % N;
        const dx = p.x - pos[i * 3], dz = p.z - pos[i * 3 + 2];
        const dd = dx * dx + dz * dz;
        if (dd < bestD) { bestD = dd; best = i; }
      }
      // Reject a stale hint — and reset the distance with it, or the broad
      // searches below can never beat it and we fall through with best = -1.
      if (bestD > 90 * 90) { best = -1; bestD = Infinity; }
    }
    if (best < 0) {
      const cx = Math.floor(p.x / GRID_CELL), cz = Math.floor(p.z / GRID_CELL);
      const arr = Number.isFinite(cx) && Number.isFinite(cz) ? grid.get(key(cx, cz)) : null;
      if (arr) {
        for (let n = 0; n < arr.length; n++) {
          const i = arr[n];
          const dx = p.x - pos[i * 3], dz = p.z - pos[i * 3 + 2];
          const dd = dx * dx + dz * dz;
          if (dd < bestD) { bestD = dd; best = i; }
        }
      }
      if (best < 0) {
        // Full coarse sweep, then refine around the winner.
        for (let i = 0; i < N; i += 3) {
          const dx = p.x - pos[i * 3], dz = p.z - pos[i * 3 + 2];
          const dd = dx * dx + dz * dz;
          if (dd < bestD) { bestD = dd; best = i; }
        }
        if (best >= 0) {
          for (let d = -3; d <= 3; d++) {
            const i = (best + d + N) % N;
            const dx = p.x - pos[i * 3], dz = p.z - pos[i * 3 + 2];
            const dd = dx * dx + dz * dz;
            if (dd < bestD) { bestD = dd; best = i; }
          }
        }
      }
      // Last resort (a non-finite query point): never index out of bounds.
      if (best < 0 || !Number.isFinite(bestD)) best = 0;
    }
    // Refine to sub-station accuracy by projecting onto the local tangent.
    const i = best;
    const dx = p.x - pos[i * 3], dy = p.y - pos[i * 3 + 1], dz = p.z - pos[i * 3 + 2];
    const along = dx * tan[i * 3] + dy * tan[i * 3 + 1] + dz * tan[i * 3 + 2];
    const side = dx * lat[i * 3] + dy * lat[i * 3 + 1] + dz * lat[i * 3 + 2];
    const up = dx * nrm[i * 3] + dy * nrm[i * 3 + 1] + dz * nrm[i * 3 + 2];
    _proj.index = i;
    _proj.s = (cum[i] + along + length) % length;
    _proj.lateral = side;
    _proj.height = up;
    _proj.onTrack = Math.abs(side) <= wid[i];
    return _proj;
  }

  const _surf = { type: 'asphalt', grip: 1, roughness: 0, drag: 0, kerb: false };
  function surfaceAt(s, lateral) {
    const i = Math.floor(idxOf(s)) % N;
    const hw = wid[i];
    const a = Math.abs(lateral);
    const sideName = lateral < 0 ? 'left' : 'right';

    if (pit.contains(s)) {
      const laneOff = pit.lane(s);
      if (laneOff !== 0 && Math.abs(lateral - laneOff) < 6) {
        Object.assign(_surf, SURFACE.pit, { type: 'pit', kerb: false });
        return _surf;
      }
    }
    if (a <= hw) {
      Object.assign(_surf, SURFACE.asphalt, { type: 'asphalt', kerb: false });
      return _surf;
    }
    // Kerb band immediately outside the white line
    for (let n = 0; n < kerbs.length; n++) {
      const k = kerbs[n];
      if ((k.side === 'both' || k.side === sideName) && inBand(s, k.from, k.to) && a <= hw + 1.5) {
        Object.assign(_surf, SURFACE.kerb, { type: 'kerb', kerb: true });
        _surf.roughness = 0.28 + k.aggression * 0.6;
        return _surf;
      }
    }
    // Run-off bands
    for (let n = 0; n < surfaces.length; n++) {
      const sf = surfaces[n];
      if ((sf.side === 'both' || sf.side === sideName) && inBand(s, sf.from, sf.to) && a <= hw + sf.width) {
        Object.assign(_surf, SURFACE[sf.type] || SURFACE.grass, { type: sf.type, kerb: false });
        return _surf;
      }
    }
    if (a <= hw + 1.6) { Object.assign(_surf, SURFACE.kerb, { type: 'kerb', kerb: true }); return _surf; }
    if (a <= hw + 7.0) { Object.assign(_surf, SURFACE.astro, { type: 'astro', kerb: false }); return _surf; }
    Object.assign(_surf, SURFACE.grass, { type: 'grass', kerb: false });
    return _surf;
  }

  function racingLine(s) {
    const fi = idxOf(s);
    const i1 = Math.floor(fi) % N;
    const f = fi - Math.floor(fi);
    return cr(line[(i1 - 1 + N) % N], line[i1], line[(i1 + 1) % N], line[(i1 + 2) % N], f);
  }
  function targetSpeed(s) {
    const fi = idxOf(s);
    const i0 = Math.floor(fi) % N, i1 = (i0 + 1) % N;
    const f = fi - Math.floor(fi);
    return speed[i0] * (1 - f) + speed[i1] * f;
  }
  function lineCurvature(s) {
    const i = Math.floor(idxOf(s)) % N;
    return lineCurv[i];
  }
  /** Signed forward distance from a to b along the lap (0..length). */
  function ahead(a, b) { return (b - a + length) % length; }
  /** Shortest signed difference, -length/2..length/2 */
  function delta(a, b) {
    let d = (b - a + length) % length;
    if (d > length / 2) d -= length;
    return d;
  }

  function worldPoint(s, lateral, out) {
    const sm = sample(s);
    return (out || new THREE.Vector3()).copy(sm.pos).addScaledVector(sm.lateral, lateral);
  }

  /** Height of the driving surface under a world point (banked plane). */
  function heightAt(p, hintS) {
    const pr = project(p, hintS);
    const sm = sample(pr.s);
    return sm.pos.y + sm.lateral.y * pr.lateral;
  }

  // Distance from the centreline to the barrier, per station.
  const wall = new Float32Array(N);
  {
    const defMargin = circuit.wallMargin != null ? circuit.wallMargin : 13;
    for (let i = 0; i < N; i++) {
      const si = cum[i];
      let m = defMargin;
      for (let n = 0; n < surfaces.length; n++) {
        const sf = surfaces[n];
        if (inBand(si, sf.from, sf.to)) m = Math.max(m, sf.width + 1.5);
      }
      wall[i] = wid[i] + m;
    }
    // Smooth so the barrier line never steps.
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < 8; pass++) {
      for (let i = 0; i < N; i++) {
        const a = (i - 1 + N) % N, b = (i + 1) % N;
        tmp[i] = (wall[a] + 2 * wall[i] + wall[b]) / 4;
      }
      wall.set(tmp);
    }
  }
  function wallAt(s) {
    const fi = idxOf(s);
    const i0 = Math.floor(fi) % N, i1 = (i0 + 1) % N;
    const f = fi - Math.floor(fi);
    return wall[i0] * (1 - f) + wall[i1] * f;
  }

  // Lap time the reference speed profile would achieve — the yardstick the
  // adaptive AI measures the player against.
  let referenceLapTime = 0;
  {
    const ds = length / N;
    for (let i = 0; i < N; i++) referenceLapTime += ds / Math.max(6, speed[i]);
  }

  const outline = [];
  for (let i = 0; i < N; i += 4) outline.push({ x: pos[i * 3], z: pos[i * 3 + 2] });

  const inDRS = (s) => {
    for (let i = 0; i < drsZones.length; i++) {
      const z = drsZones[i];
      if (inBand(s, z.startS, z.endS)) return i;
    }
    return -1;
  };
  const atDRSDetect = (prevS, s) => {
    for (let i = 0; i < drsZones.length; i++) {
      const d = drsZones[i].detectS;
      if (ahead(prevS, d) <= ahead(prevS, s) && ahead(prevS, s) < length * 0.5) return i;
    }
    return -1;
  };
  const sectorOf = (s) => (s < sectors[1] ? 0 : s < sectors[2] ? 1 : 2);

  return {
    circuit, curve, length, sampleCount: N,
    sample, project, surfaceAt, racingLine, targetSpeed, lineCurvature,
    worldPoint, heightAt, ahead, delta, outline, wallAt, referenceLapTime,
    drsZones, sectors, sectorOf, inDRS, atDRSDetect, pit, startGrid,
    solveProfile,
    // raw tables (read-only) for consumers that want to walk the lap cheaply
    _tables: { pos, tan, nrm, lat, cum, wid, bank, curv, line, lineCurv, speed, wall, N },
  };
}

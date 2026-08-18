/**
 * APEX F1 — src/render/sky.js
 * ---------------------------------------------------------------------------
 * Dynamic time-of-day sky: analytic Preetham/Hosek-style atmospheric
 * scattering, a limb-darkened sun disc, layered domain-warped volumetric
 * clouds, a procedural twinkling star field, a phased moon, and image-based
 * lighting produced by rendering the dome into a cube target and running it
 * through PMREMGenerator.
 *
 * Engine: three.js r185 (vendored). Native ESM, no build step.
 *
 * DESIGN NOTES
 * ------------
 *  - Every sky element (dome, stars, moon, billboard clouds) is rendered in
 *    "direction space": the vertex shaders strip the translation out of
 *    modelViewMatrix and force gl_Position.z = w. That means the sky is
 *    permanently centred on the camera, is never clipped by camera.far, and
 *    the sky group can simply live at the world origin and never move.
 *  - All sky materials keep `transparent: false` but set an explicit blending
 *    mode. three only forces NoBlending when `blending === NormalBlending &&
 *    transparent === false`, so a CustomBlending/AdditiveBlending material
 *    stays in the OPAQUE render queue (where negative renderOrder actually
 *    works) while still alpha-blending. Combined with depthTest:false /
 *    depthWrite:false this makes the whole sky a true background layer that
 *    the world always draws over, whatever the caller's near/far planes are.
 *  - The fog colour is produced by a CPU port of the exact same scattering
 *    integral the shader runs, so getFogColor() always matches the horizon.
 *
 * PUBLIC API
 *   createSky(renderer, scene, opts) -> {
 *     update(weather, dt, cameraTarget), sunLight, fillLight, hemiLight,
 *     getSunDirection(), getSunColor(), getFogColor(), skyMesh,
 *     dispose(), setQuality(q), ...extras
 *   }
 */

import * as THREE from 'three';

/* =========================================================================
 * Module-scope scratch. NEVER allocate inside update().
 * ====================================================================== */

const _vSun = new THREE.Vector3(1, 1, 0);
const _vMoon = new THREE.Vector3(-1, 1, 0);
const _vKey = new THREE.Vector3(0, 1, 0);
const _vTarget = new THREE.Vector3();
const _vSnapped = new THREE.Vector3();
const _axX = new THREE.Vector3();
const _axY = new THREE.Vector3();
const _axZ = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();

const _colSun = new THREE.Color();
const _colFog = new THREE.Color();
const _colHaze = new THREE.Color();
const _colZenith = new THREE.Color();
const _colAmbient = new THREE.Color();
const _colCloudLit = new THREE.Color();
const _colCloudDark = new THREE.Color();
const _colHemiSky = new THREE.Color();
const _colHemiGround = new THREE.Color();
const _colFill = new THREE.Color();

// 3-float scratch buffers for the CPU atmosphere integral.
const _rgbA = [0, 0, 0];
const _rgbB = [0, 0, 0];
const _rgbC = [0, 0, 0];
const _rgbD = [0, 0, 0];
const _rgbAcc = [0, 0, 0];
const _fex = [0, 0, 0];

const UP_Y = new THREE.Vector3(0, 1, 0);
const UP_X = new THREE.Vector3(1, 0, 0);

/* =========================================================================
 * Physical / artistic constants (shared verbatim with the GLSL).
 * ====================================================================== */

const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;

// Precomputed total Rayleigh scattering for 680/550/450 nm primaries.
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
// pi * pow((2pi)/lambda, v-2) * K   for the Mie term.
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];

const SUN_CUTOFF_ANGLE = 1.6110731556870734;
const SUN_STEEPNESS = 1.5;
const SUN_EE = 1000.0;

// Master radiance scale. Everything (GPU + CPU) is multiplied by this before
// tone mapping, so the fog / lights / dome can never drift apart.
const EXPOSURE_BASE = 0.0055;

const DEG2RAD = Math.PI / 180;
const EARTH_TILT = 23.44 * DEG2RAD;

/* =========================================================================
 * Quality tiers.
 * ====================================================================== */

const QUALITY_PRESETS = {
  low: {
    cloudOctaves: 2, cloudWarp: 0, cirrus: 0,
    stars: 420, billboards: 0,
    envSize: 0, envInterval: Infinity,
    shadowMapSize: 1024, shadowExtent: 85,  shadowRadius: 1,
    milkyWay: 0.35,
  },
  medium: {
    cloudOctaves: 3, cloudWarp: 1, cirrus: 0,
    stars: 1100, billboards: 40,
    envSize: 64, envInterval: 4.0,
    shadowMapSize: 1024, shadowExtent: 100, shadowRadius: 2,
    milkyWay: 0.6,
  },
  high: {
    cloudOctaves: 4, cloudWarp: 2, cirrus: 1,
    stars: 1900, billboards: 92,
    envSize: 128, envInterval: 2.0,
    shadowMapSize: 2048, shadowExtent: 120, shadowRadius: 3,
    milkyWay: 0.85,
  },
  ultra: {
    cloudOctaves: 5, cloudWarp: 2, cirrus: 1,
    stars: 2800, billboards: 150,
    envSize: 256, envInterval: 2.0,
    shadowMapSize: 4096, shadowExtent: 145, shadowRadius: 4,
    milkyWay: 1.0,
  },
};

const MAX_STARS = 2800;
const MAX_BILLBOARDS = 150;

/* =========================================================================
 * Weather → sky parameter tables.
 * ====================================================================== */

const CONDITION_TABLE = {
  clear: { cover: 0.06, storm: 0.0, turbidity: 2.1, humidity: 0.15, cirrus: 0.18 },
  cloudy: { cover: 0.44, storm: 0.0, turbidity: 3.4, humidity: 0.42, cirrus: 0.5 },
  overcast: { cover: 0.86, storm: 0.12, turbidity: 5.2, humidity: 0.75, cirrus: 0.7 },
  lightrain: { cover: 0.76, storm: 0.3, turbidity: 6.0, humidity: 0.85, cirrus: 0.55 },
  rain: { cover: 0.9, storm: 0.62, turbidity: 7.4, humidity: 0.95, cirrus: 0.4 },
  storm: { cover: 0.97, storm: 1.0, turbidity: 9.2, humidity: 1.0, cirrus: 0.25 },
};

/* =========================================================================
 * Small maths helpers.
 * ====================================================================== */

function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
function lerp(a, b, t) { return a + (b - a) * t; }

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. */
function damp(current, target, tau, dt) {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/** Deterministic PRNG so the star field / cloud layout is stable per seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --- CPU value noise, matching the GLSL well enough for texture baking --- */

function hash2(x, y) {
  let px = x * 0.1031, py = y * 0.1030, pz = x * 0.0973;
  px -= Math.floor(px); py -= Math.floor(py); pz -= Math.floor(pz);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d; py += d; pz += d;
  const v = (px + py) * pz;
  return v - Math.floor(v);
}

function vnoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

function fbm2(x, y, octaves) {
  let s = 0, amp = 0.5, norm = 0;
  let px = x, py = y;
  for (let i = 0; i < octaves; i++) {
    s += amp * vnoise2(px, py);
    norm += amp;
    const nx = 1.62 * px - 1.2 * py;
    const ny = 1.2 * px + 1.62 * py;
    px = nx; py = ny;
    amp *= 0.5;
  }
  return s / (norm || 1);
}

/** Rough blackbody → linear RGB, used for star tinting. */
function blackbodyRGB(kelvin, out) {
  const t = clamp(kelvin, 1200, 30000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  out[0] = clamp(r, 0, 255) / 255;
  out[1] = clamp(g, 0, 255) / 255;
  out[2] = clamp(b, 0, 255) / 255;
  // crude sRGB→linear so the additive stars behave
  for (let i = 0; i < 3; i++) out[i] = Math.pow(out[i], 2.2);
  return out;
}

/* =========================================================================
 * Solar / lunar position.
 * ====================================================================== */

/**
 * Analytic solar position.
 * @param {number} hours   local solar time, 0..24
 * @param {number} latRad  observer latitude (radians)
 * @param {number} dayOfYear 1..365
 * @param {THREE.Vector3} out  receives a unit direction (Y up, +X east, -Z north)
 */
function solarDirection(hours, latRad, dayOfYear, out) {
  const decl = EARTH_TILT * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
  const H = ((hours - 12) / 12) * Math.PI; // hour angle

  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const sinDec = Math.sin(decl), cosDec = Math.cos(decl);

  const sinAlt = clamp(sinLat * sinDec + cosLat * cosDec * Math.cos(H), -1, 1);
  const alt = Math.asin(sinAlt);
  const cosAlt = Math.cos(alt);

  let az;
  const denom = cosAlt * cosLat;
  if (Math.abs(denom) < 1e-6) {
    az = H > 0 ? Math.PI : 0;
  } else {
    const cosAz = clamp((sinDec - sinAlt * sinLat) / denom, -1, 1);
    az = Math.acos(cosAz);
    if (H > 0) az = 2 * Math.PI - az;
  }

  // azimuth measured from north, clockwise (east positive)
  out.set(Math.sin(az) * cosAlt, sinAlt, -Math.cos(az) * cosAlt);
  const len = out.length();
  if (len > 1e-6) out.multiplyScalar(1 / len); else out.set(0, 1, 0);
  return out;
}

/* =========================================================================
 * CPU port of the shader's scattering integral.
 * Everything is linear radiance, pre tone-mapping — exactly what THREE.Fog
 * and light colours want.
 * ====================================================================== */

function sunIntensityCPU(zenithCos) {
  const c = clamp(zenithCos, -1, 1);
  const v = 1 - Math.exp(-((SUN_CUTOFF_ANGLE - Math.acos(c)) / SUN_STEEPNESS));
  return SUN_EE * Math.max(0, v);
}

function rayleighPhaseCPU(cosT) { return (3 / (16 * Math.PI)) * (1 + cosT * cosT); }

function hgPhaseCPU(cosT, g) {
  const g2 = g * g;
  const den = Math.pow(Math.max(1e-4, 1 - 2 * g * cosT + g2), 1.5);
  return (1 / (4 * Math.PI)) * ((1 - g2) / den);
}

/**
 * Atmospheric state cached per-frame so repeated direction samples are cheap.
 */
class AtmosphereCPU {
  constructor() {
    this.betaR = [0, 0, 0];
    this.betaM = [0, 0, 0];
    this.sunE = 0;
    this.mieG = 0.8;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.exposure = EXPOSURE_BASE;
  }

  configure(sunDir, turbidity, rayleigh, mieCoefficient, mieG, sunfade, exposure) {
    this.sunDir.copy(sunDir);
    this.mieG = mieG;
    this.exposure = exposure;
    this.sunE = sunIntensityCPU(sunDir.y);
    const rCoef = Math.max(0.05, rayleigh - 1.0 * (1.0 - sunfade));
    const c = 0.2 * turbidity * 1e-17;
    const mCoef = 0.434 * c * mieCoefficient;
    for (let i = 0; i < 3; i++) {
      this.betaR[i] = TOTAL_RAYLEIGH[i] * rCoef;
      this.betaM[i] = MIE_CONST[i] * mCoef;
    }
  }

  /** Radiance in direction (dx,dy,dz) — no sun disc, no clouds. */
  sample(dx, dy, dz, out) {
    let sy = dy < 0 ? 0 : dy;
    let len = Math.sqrt(dx * dx + sy * sy + dz * dz);
    if (len < 1e-6) { dx = 0; sy = 1; dz = 0; len = 1; }
    const ux = dx / len, uy = sy / len, uz = dz / len;

    const zenithAngle = Math.acos(clamp(uy, 0, 1));
    const denom = Math.cos(zenithAngle) +
      0.15 * Math.pow(Math.max(1e-3, 93.885 - (zenithAngle * 180) / Math.PI), -1.253);
    const inv = 1 / Math.max(denom, 1e-4);
    const sR = RAYLEIGH_ZENITH * inv;
    const sM = MIE_ZENITH * inv;

    const s = this.sunDir;
    // Phase uses the *unclamped* direction so below-horizon fog still tracks the sun.
    let cosTheta = dx * s.x + dy * s.y + dz * s.z;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    cosTheta = clamp(cosTheta / dl, -1, 1);

    const rPhase = rayleighPhaseCPU(cosTheta);
    const mPhase = hgPhaseCPU(cosTheta, this.mieG);
    const upDotSun = clamp(s.y, -1, 1);
    const sunsetBlend = clamp(Math.pow(1 - upDotSun, 5), 0, 1);

    for (let i = 0; i < 3; i++) {
      const bR = this.betaR[i], bM = this.betaM[i];
      _fex[i] = Math.exp(-(bR * sR + bM * sM));
      const sum = Math.max(bR + bM, 1e-9);
      const ratio = (bR * rPhase + bM * mPhase) / sum;

      let lin = Math.pow(Math.max(0, this.sunE * ratio * (1 - _fex[i])), 1.5);
      const grade = Math.pow(Math.max(0, this.sunE * ratio * _fex[i]), 0.5);
      lin *= lerp(1.0, grade, sunsetBlend);

      out[i] = lin * this.exposure;
    }
    return out;
  }

  /** Direct transmittance along the sun's own path — this is the sun's colour. */
  sunTransmittance(out) {
    const zenithAngle = Math.acos(clamp(Math.max(this.sunDir.y, -0.12), -1, 1));
    const denom = Math.cos(zenithAngle) +
      0.15 * Math.pow(Math.max(1e-3, 93.885 - (zenithAngle * 180) / Math.PI), -1.253);
    const inv = 1 / Math.max(denom, 1e-4);
    const sR = RAYLEIGH_ZENITH * inv;
    const sM = MIE_ZENITH * inv;
    for (let i = 0; i < 3; i++) {
      out[i] = Math.exp(-(this.betaR[i] * sR + this.betaM[i] * sM));
    }
    return out;
  }
}

/* =========================================================================
 * Procedural textures (canvas 2D, generated once at init).
 * ====================================================================== */

function createCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

/**
 * Soft cumulus billboard sprite.
 *  RGB = vertical shading term (1 at the sunlit top, 0 at the shaded base)
 *  A   = density
 */
function buildCloudSprite(size, seed) {
  const rng = mulberry32(seed);
  const canvas = createCanvas(size, size);
  let data;

  if (canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.clearRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'lighter';
      // Cumulus silhouette: broad flat base, several lumpy crowns.
      const blobs = 26;
      for (let i = 0; i < blobs; i++) {
        const crown = i < blobs * 0.55;
        const bx = 0.5 + (rng() - 0.5) * (crown ? 0.66 : 0.86);
        const by = crown
          ? 0.40 + Math.pow(rng(), 1.7) * 0.20
          : 0.62 + rng() * 0.14;
        const r = (crown ? 0.10 + rng() * 0.16 : 0.07 + rng() * 0.10) * size;
        const g = ctx.createRadialGradient(bx * size, by * size, 0, bx * size, by * size, r);
        g.addColorStop(0.0, 'rgba(255,255,255,0.80)');
        g.addColorStop(0.42, 'rgba(255,255,255,0.38)');
        g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx * size, by * size, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      const img = ctx.getImageData(0, 0, size, size);
      data = img.data;
      const inv = 1 / (size - 1);
      for (let y = 0; y < size; y++) {
        const v = y * inv;
        for (let x = 0; x < size; x++) {
          const idx = (y * size + x) * 4;
          const u = x * inv;
          let dens = data[idx] / 255;

          const n = fbm2(u * 7.0, v * 7.0, 4);
          const n2 = fbm2(u * 19.0 + 11.3, v * 19.0 - 4.7, 3);
          dens *= 0.50 + 0.85 * n;
          dens -= (1 - n2) * 0.10;

          const dx = (u - 0.5) * 2.0;
          const dy = (v - 0.52) * 2.15;
          const rr = Math.sqrt(dx * dx + dy * dy);
          dens *= smoothstep(1.02, 0.50, rr);
          dens = clamp(dens * 1.35, 0, 1);

          const alpha = smoothstep(0.09, 0.58, dens);
          // v=0 is the canvas top; flipY maps it to uv.y=1 (quad top). Good.
          const height = clamp(1.0 - v * 1.22 + (n - 0.5) * 0.42, 0, 1);
          const hs = Math.round(height * 255);
          data[idx] = hs;
          data[idx + 1] = hs;
          data[idx + 2] = hs;
          data[idx + 3] = Math.round(alpha * 255);
        }
      }
      ctx.putImageData(img, 0, 0);

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    }
  }

  // Canvas unavailable — fall back to a purely numeric DataTexture.
  const buf = new Uint8Array(size * size * 4);
  const inv = 1 / (size - 1);
  for (let y = 0; y < size; y++) {
    const v = y * inv;
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const idx = (y * size + x) * 4;
      const n = fbm2(u * 7.0, v * 7.0, 4);
      const dx = (u - 0.5) * 2.0, dy = (v - 0.52) * 2.15;
      const rr = Math.sqrt(dx * dx + dy * dy);
      const dens = clamp((0.35 + 0.9 * n) * smoothstep(1.02, 0.42, rr) * 1.3, 0, 1);
      const height = clamp(1.0 - v * 1.22 + (n - 0.5) * 0.42, 0, 1);
      const hs = Math.round(height * 255);
      buf[idx] = hs; buf[idx + 1] = hs; buf[idx + 2] = hs;
      buf[idx + 3] = Math.round(smoothstep(0.10, 0.58, dens) * 255);
    }
  }
  const dt = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat);
  dt.colorSpace = THREE.LinearSRGBColorSpace;
  dt.minFilter = THREE.LinearFilter;
  dt.magFilter = THREE.LinearFilter;
  dt.needsUpdate = true;
  return dt;
}

/** Lunar albedo: mare basins, crater rings, regolith mottling. */
function buildMoonTexture(size, seed) {
  const rng = mulberry32(seed);
  const canvas = createCanvas(size, size);
  if (!canvas) {
    const buf = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const g = 190 + Math.round(hash2(i % size, Math.floor(i / size)) * 40 - 20);
      buf[i * 4] = g; buf[i * 4 + 1] = g; buf[i * 4 + 2] = g; buf[i * 4 + 3] = 255;
    }
    const dt = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat);
    dt.colorSpace = THREE.SRGBColorSpace;
    dt.needsUpdate = true;
    return dt;
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    const dt = new THREE.DataTexture(new Uint8Array(size * size * 4).fill(200), size, size, THREE.RGBAFormat);
    dt.colorSpace = THREE.SRGBColorSpace;
    dt.needsUpdate = true;
    return dt;
  }

  ctx.fillStyle = '#cfcac2';
  ctx.fillRect(0, 0, size, size);

  // Mare — large dark basaltic plains.
  for (let i = 0; i < 9; i++) {
    const cx = rng() * size, cy = rng() * size;
    const rx = (0.08 + rng() * 0.20) * size;
    const ry = rx * (0.55 + rng() * 0.7);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    const dark = 118 + Math.floor(rng() * 26);
    g.addColorStop(0.0, `rgba(${dark},${dark + 4},${dark + 10},0.92)`);
    g.addColorStop(0.7, `rgba(${dark + 20},${dark + 24},${dark + 30},0.55)`);
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rng() * Math.PI);
    ctx.scale(1, ry / rx);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Craters — bright rim, darker floor, occasional ray system.
  for (let i = 0; i < 170; i++) {
    const cx = rng() * size, cy = rng() * size;
    const r = Math.pow(rng(), 2.6) * size * 0.075 + size * 0.004;
    const g = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    g.addColorStop(0.0, 'rgba(96,94,90,0.55)');
    g.addColorStop(0.62, 'rgba(140,138,133,0.30)');
    g.addColorStop(0.86, 'rgba(238,236,230,0.55)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    if (r > size * 0.03 && rng() > 0.72) {
      const rays = 9 + Math.floor(rng() * 8);
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = '#f4f1ea';
      for (let k = 0; k < rays; k++) {
        const a = rng() * Math.PI * 2;
        const l = r * (2.4 + rng() * 5.0);
        ctx.lineWidth = Math.max(0.6, r * 0.10 * rng());
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
        ctx.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Regolith mottling.
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const inv = 1 / (size - 1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const n = fbm2(x * inv * 12.0, y * inv * 12.0, 4) - 0.5;
      const k = 1 + n * 0.20;
      d[idx] = clamp(d[idx] * k, 0, 255);
      d[idx + 1] = clamp(d[idx + 1] * k, 0, 255);
      d[idx + 2] = clamp(d[idx + 2] * k, 0, 255);
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/* =========================================================================
 * GLSL — sky dome
 * ====================================================================== */

const SKY_VERT = /* glsl */`
varying vec3 vDir;

void main() {
  vDir = position;
  mat4 mv = mat4( mat3( modelViewMatrix ) );   // strip translation: dome rides the camera
  vec4 p = projectionMatrix * mv * vec4( position, 1.0 );
  gl_Position = p.xyww;                        // pin to the far plane, never clipped
}
`;

const SKY_FRAG = /* glsl */`
#define PI 3.141592653589793

varying vec3 vDir;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uBetaR;
uniform vec3  uBetaM;
uniform float uSunE;
uniform float uMieG;
uniform float uExposure;
uniform float uSunAngularRadius;
uniform float uSunDiscIntensity;
uniform float uSunGlow;

uniform float uNight;
uniform vec3  uNightSky;
uniform float uMoonIllum;
uniform vec3  uMoonGlow;
uniform float uMilkyWay;

uniform vec3  uHazeColor;
uniform float uHorizonHaze;
uniform float uGroundLevel;

uniform float uCloudCover;
uniform float uCloudSharp;
uniform float uCloudOpacity;
uniform float uCloudScale;
uniform float uCloudHeight;
uniform float uTurbulence;
uniform float uStorm;
uniform vec2  uCloudDrift;
uniform vec2  uCirrusDrift;
uniform vec2  uParallax;
uniform float uCirrusCover;
uniform vec3  uCloudLit;
uniform vec3  uCloudDark;
uniform float uTime;

const float RAYLEIGH_ZENITH = 8.4e3;
const float MIE_ZENITH      = 1.25e3;
const vec3  UPV             = vec3( 0.0, 1.0, 0.0 );

float rayleighPhase( float c ) {
  return ( 3.0 / ( 16.0 * PI ) ) * ( 1.0 + c * c );
}

float hgPhase( float c, float g ) {
  float g2 = g * g;
  float d  = max( 1e-4, pow( 1.0 - 2.0 * g * c + g2, 1.5 ) );
  return ( 1.0 / ( 4.0 * PI ) ) * ( ( 1.0 - g2 ) / d );
}

/* ---- procedural noise -------------------------------------------------- */

float hash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float vnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = hash21( i );
  float b = hash21( i + vec2( 1.0, 0.0 ) );
  float c = hash21( i + vec2( 0.0, 1.0 ) );
  float d = hash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

const mat2 FBM_ROT = mat2( 1.62, 1.20, -1.20, 1.62 );

float fbm( vec2 p ) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  for ( int i = 0; i < CLOUD_OCTAVES; i ++ ) {
    s += a * vnoise( p );
    n += a;
    p = FBM_ROT * p;
    a *= 0.5;
  }
  return s / max( n, 1e-4 );
}

/* ---- cloud field ------------------------------------------------------- */

// returns vec3( density, sunward gradient, raw undistorted noise )
//
// The gradient and the raw field are deliberately taken BEFORE the coverage
// threshold. At high cover the thresholded density saturates to 1 everywhere,
// so shading derived from it would go flat — an overcast or storm deck would
// turn into a featureless grey sheet. Keeping the raw field alive means the
// deck stays turbulent no matter how total the coverage.
vec3 cloudDensity( vec2 p, vec2 sunOff, float cover, vec2 turb ) {
  vec2 w = p;

#if CLOUD_WARP >= 1
  vec2 q = vec2( fbm( p ), fbm( p + vec2( 5.2, 1.3 ) ) );
  w = p + 1.65 * q + turb;
#endif

#if CLOUD_WARP >= 2
  vec2 r = vec2( fbm( w + vec2( 1.7, 9.2 ) ), fbm( w + vec2( 8.3, 2.8 ) ) );
  w = p + 1.95 * r + turb * 0.5;
#endif

  float f  = fbm( w );
  float f2 = fbm( w + sunOff );

  float lo = 1.0 - cover;
  float d  = smoothstep( lo, lo + uCloudSharp, f );
  d = d * d * ( 3.0 - 2.0 * d );          // billow — rounds the crowns

  return vec3( d, ( f - f2 ) * 7.0, f );
}

vec4 cloudLayer( vec3 d, vec3 sunDir, vec3 skyCol ) {
  if ( uCloudCover < 0.003 || d.y < 0.002 ) return vec4( 0.0 );

  vec3 acc = vec3( 0.0 );
  float alpha = 0.0;

  // --- low cumulus deck ---------------------------------------------------
  float t = uCloudHeight / max( d.y, 0.020 );
  vec2 p = ( d.xz * t + uParallax ) * uCloudScale + uCloudDrift;

  vec2 sunFlat = sunDir.xz;
  float sl = length( sunFlat );
  vec2 sunOff = ( sl > 1e-4 ? sunFlat / sl : vec2( 1.0, 0.0 ) ) * 0.38;

  vec2 turb = vec2( sin( uTime * 0.071 ), cos( uTime * 0.0531 ) ) * uTurbulence;

  vec3 cd = cloudDensity( p, sunOff, uCloudCover, turb );
  float dens = cd.x * smoothstep( 0.0, 0.085, d.y );
  float grad = cd.y;
  float raw  = cd.z;

  float sunAmt = clamp( dot( d, sunDir ) * 0.5 + 0.5, 0.0, 1.0 );
  // grad = self-shadowing toward the sun; raw = body thickness; sunAmt = phase
  float lit = clamp( 0.46 + grad + ( raw - 0.5 ) * 0.95 + 0.24 * ( sunAmt - 0.5 ),
                     0.0, 1.0 );
  lit = mix( lit, lit * 0.34, uStorm );

  vec3 col = mix( uCloudDark, uCloudLit, lit );

  // silver lining: bright rim where a thin edge sits in front of the sun
  float rim = dens * ( 1.0 - dens ) * 4.0;
  col += uCloudLit * rim * pow( max( dot( d, sunDir ), 0.0 ), 10.0 ) * 1.6;

  // aerial perspective — distant deck dissolves into the horizon haze
  col = mix( col, skyCol, smoothstep( 0.34, 0.015, d.y ) * 0.88 );

  alpha = clamp( dens * uCloudOpacity, 0.0, 1.0 );
  acc = col;

#if CIRRUS
  // --- high cirrus veil ---------------------------------------------------
  if ( uCirrusCover > 0.004 ) {
    float t2 = ( uCloudHeight * 2.6 ) / max( d.y, 0.035 );
    vec2 p2 = ( d.xz * t2 + uParallax * 0.35 ) * ( uCloudScale * 0.42 ) + uCirrusDrift;
    p2.y *= 3.4;                                   // stretch into wind-combed streaks
    float f = fbm( p2 );
    float lo2 = 1.0 - uCirrusCover * 0.75;
    float dc = smoothstep( lo2, lo2 + 0.34, f ) * smoothstep( 0.0, 0.16, d.y );
    dc *= 0.55 * ( 1.0 - uStorm * 0.6 );
    vec3 ccol = mix( uCloudLit * 1.05, skyCol, 0.32 );
    acc = mix( acc, mix( ccol, acc, alpha ), dc * ( 1.0 - alpha * 0.6 ) );
    alpha = clamp( alpha + dc * ( 1.0 - alpha ), 0.0, 1.0 );
  }
#endif

  return vec4( acc, alpha );
}

void main() {
  vec3 d = normalize( vDir );
  vec3 sun = normalize( uSunDir );

  // Lift the direction to the horizon so the integral stays well-conditioned.
  vec3 sd = vec3( d.x, max( d.y, 0.0 ), d.z );
  float sdl = length( sd );
  sd = sdl > 1e-5 ? sd / sdl : UPV;

  float zenithAngle = acos( clamp( dot( UPV, sd ), 0.0, 1.0 ) );
  float denom = cos( zenithAngle ) +
                0.15 * pow( max( 1e-3, 93.885 - zenithAngle * 180.0 / PI ), -1.253 );
  float inv = 1.0 / max( denom, 1e-4 );
  float sR = RAYLEIGH_ZENITH * inv;
  float sM = MIE_ZENITH * inv;

  vec3 Fex = exp( -( uBetaR * sR + uBetaM * sM ) );

  float cosTheta = dot( d, sun );
  vec3 betaRTheta = uBetaR * rayleighPhase( cosTheta );
  vec3 betaMTheta = uBetaM * hgPhase( cosTheta, uMieG );
  vec3 betaSum    = max( uBetaR + uBetaM, vec3( 1e-9 ) );
  vec3 ratio      = ( betaRTheta + betaMTheta ) / betaSum;

  vec3 Lin = pow( max( uSunE * ratio * ( 1.0 - Fex ), vec3( 0.0 ) ), vec3( 1.5 ) );
  Lin *= mix( vec3( 1.0 ),
              pow( max( uSunE * ratio * Fex, vec3( 0.0 ) ), vec3( 0.5 ) ),
              clamp( pow( 1.0 - sun.y, 5.0 ), 0.0, 1.0 ) );

  // ---- sun disc with wavelength dependent limb darkening -----------------
  float theta = acos( clamp( cosTheta, -1.0, 1.0 ) );
  float rr = theta / max( uSunAngularRadius, 1e-4 );
  vec3 disc = vec3( 0.0 );
  if ( rr < 1.0 ) {
    float mu = sqrt( max( 0.0, 1.0 - rr * rr ) );
    const vec3 limbU = vec3( 0.397, 0.503, 0.652 );
    disc = vec3( 1.0 ) - limbU * ( 1.0 - mu );
  }
  float discEdge = 1.0 - smoothstep( 0.90, 1.0, rr );
  vec3 L0 = uSunE * uSunDiscIntensity * Fex * disc * discEdge;

  // forward-scattered aureole around the disc
  float glow = exp( -theta * theta * 760.0 ) * 0.85 + exp( -theta * theta * 26.0 ) * 0.055;
  L0 += uSunE * uSunGlow * Fex * glow;

  vec3 sky = ( Lin + L0 ) * uExposure;

  // ---- night ------------------------------------------------------------
  if ( uNight > 0.001 ) {
    vec3 night = uNightSky * Fex * uNight;

    // Milky Way band around a tilted galactic plane.
    const vec3 galPole = vec3( 0.3665, 0.4275, -0.8262 );
    float band = 1.0 - abs( dot( d, galPole ) );
    float mw = smoothstep( 0.815, 1.0, band );
    mw *= 0.30 + 0.70 * fbm( vec2( atan( d.z, d.x ) * 3.1, d.y * 5.0 ) );
    night += uMilkyWay * uNight * mw * vec3( 0.052, 0.056, 0.084 ) *
             smoothstep( -0.01, 0.22, d.y );

    // Moon halo (the disc itself is a separate billboard).
    float mcos = dot( d, normalize( uMoonDir ) );
    float mth = acos( clamp( mcos, -1.0, 1.0 ) );
    night += uMoonGlow * uMoonIllum * uNight *
             ( exp( -mth * mth * 170.0 ) * 0.50 + exp( -mth * mth * 11.0 ) * 0.020 );

    sky += night;
  }

  // ---- horizon haze + below-horizon ground bounce ------------------------
  float below = smoothstep( 0.015, -0.075, d.y );
  sky = mix( sky, uHazeColor, uHorizonHaze * exp( -max( d.y, 0.0 ) * 24.0 ) * ( 1.0 - below ) );
  sky = mix( sky, uHazeColor * uGroundLevel, below );

  // ---- clouds ------------------------------------------------------------
  vec4 cl = cloudLayer( d, sun, sky );
  sky = mix( sky, cl.rgb, cl.a );

  gl_FragColor = vec4( max( sky, vec3( 0.0 ) ), 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* =========================================================================
 * GLSL — stars
 * ====================================================================== */

const STAR_VERT = /* glsl */`
attribute float aSize;
attribute float aPhase;
attribute float aSpeed;
attribute vec3  aColor;

uniform float uTime;
uniform float uOpacity;
uniform float uScale;
uniform float uExtinction;

varying vec3  vCol;
varying float vAlpha;
varying float vBright;

void main() {
  mat4 mv = mat4( mat3( modelViewMatrix ) );
  vec4 p = projectionMatrix * mv * vec4( position, 1.0 );
  gl_Position = p.xyww;

  // Two incommensurate sines give a non-repeating scintillation.
  float s1 = sin( uTime * aSpeed + aPhase );
  float s2 = sin( uTime * aSpeed * 0.371 + aPhase * 2.13 );
  float tw = 0.70 + 0.30 * s1 * ( 0.55 + 0.45 * s2 );

  float alt = normalize( position ).y;
  float ext = smoothstep( -0.03, 0.20, alt );
  ext = mix( 1.0, ext, uExtinction );

  vBright = tw;
  vAlpha = uOpacity * tw * ext;
  vCol = aColor;

  gl_PointSize = max( 1.0, aSize * uScale * ( 0.72 + 0.5 * tw ) );
}
`;

const STAR_FRAG = /* glsl */`
varying vec3  vCol;
varying float vAlpha;
varying float vBright;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length( c );
  if ( r > 0.5 ) discard;

  float core = exp( -r * r * 46.0 );
  float halo = exp( -r * r * 9.0 ) * 0.30;

  // faint diffraction spike on the brightest stars
  float spike = ( 1.0 - smoothstep( 0.0, 0.028, abs( c.x ) ) ) +
                ( 1.0 - smoothstep( 0.0, 0.028, abs( c.y ) ) );
  spike *= smoothstep( 0.86, 1.0, vBright ) * ( 1.0 - smoothstep( 0.10, 0.5, r ) ) * 0.35;

  float i = ( core + halo + spike ) * vAlpha;
  if ( i <= 0.0015 ) discard;

  gl_FragColor = vec4( vCol * i, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* =========================================================================
 * GLSL — moon
 * ====================================================================== */

const MOON_VERT = /* glsl */`
uniform vec3  uMoonDir;
uniform vec3  uTangent;
uniform vec3  uBitangent;
uniform float uQuadHalfAngle;

varying vec2 vQuad;

void main() {
  vQuad = position.xy * 2.0;                  // PlaneGeometry(1,1) -> [-1,1]
  vec3 p = uMoonDir + ( uTangent * position.x + uBitangent * position.y ) * ( uQuadHalfAngle * 2.0 );
  mat4 mv = mat4( mat3( modelViewMatrix ) );
  vec4 c = projectionMatrix * mv * vec4( p, 1.0 );
  gl_Position = c.xyww;
}
`;

const MOON_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3  uSunLocal;      // sun direction in ( tangent, bitangent, moonDir ) basis
uniform vec3  uMoonColor;
uniform float uIntensity;
uniform float uDiscRadius;    // fraction of the quad half-extent
uniform float uHaloStrength;
uniform float uEarthshine;

varying vec2 vQuad;

void main() {
  float r = length( vQuad );
  vec3 col = vec3( 0.0 );
  float a = 0.0;

  // ---- halo -------------------------------------------------------------
  float halo = exp( -r * 3.1 ) * uHaloStrength;
  col += uMoonColor * halo;
  a = halo;

  // ---- disc -------------------------------------------------------------
  if ( r < uDiscRadius * 1.06 ) {
    float rn = r / uDiscRadius;
    float mask = 1.0 - smoothstep( 0.965, 1.0, rn );
    if ( mask > 0.0 ) {
      float z = sqrt( max( 0.0, 1.0 - min( rn * rn, 1.0 ) ) );
      // visible hemisphere normals lean back toward the viewer (-moonDir)
      vec3 n = vec3( vQuad.x / uDiscRadius, vQuad.y / uDiscRadius, -z );
      float ndl = dot( normalize( n ), normalize( uSunLocal ) );
      float lambert = smoothstep( -0.10, 0.16, ndl );

      vec2 uv = vQuad / uDiscRadius * 0.5 + 0.5;
      vec3 albedo = texture2D( uMap, clamp( uv, 0.0, 1.0 ) ).rgb;

      // limb darkening keeps the edge from looking like a sticker
      float limb = 0.72 + 0.28 * z;

      vec3 lunar = albedo * uMoonColor * ( lambert * limb + uEarthshine );
      col = mix( col, lunar * 1.0, mask );
      a = max( a, mask );
    }
  }

  col *= uIntensity;
  if ( a <= 0.002 ) discard;

  gl_FragColor = vec4( col, a );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* =========================================================================
 * GLSL — billboard cumulus
 * ====================================================================== */

const BILLBOARD_VERT = /* glsl */`
attribute vec2  aPos;       // position on the cloud plane
attribute float aAlt;       // altitude multiplier
attribute vec2  aScale;     // half-extent on the cloud plane
attribute float aSeed;
attribute float aOpacity;

uniform vec2  uDrift;
uniform vec2  uParallax;
uniform float uDomain;
uniform float uAltitude;
uniform float uTime;
uniform float uCover;
uniform float uSpin;

varying vec2  vUv;
varying vec3  vDir;
varying float vOpacity;
varying float vFar;

void main() {
  float halfD = uDomain * 0.5;
  vec2 pp = aPos + uDrift + uParallax;
  pp = mod( pp + halfD, uDomain ) - halfD;

  vec3 c = vec3( pp.x, uAltitude * aAlt, pp.y );
  float dist = max( length( c ), 1e-3 );
  vec3 dir = c / dist;

  vec3 upv = abs( dir.y ) < 0.92 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 tx = normalize( cross( upv, dir ) );
  vec3 ty = cross( dir, tx );

  // slow breathing so the deck never looks frozen
  float wob = 1.0 + 0.09 * sin( uTime * 0.17 + aSeed * 6.2831 );
  vec2 ang = aScale * wob / dist;

  // gentle roll about the view axis, seeded per puff
  float rot = uSpin * sin( uTime * 0.031 + aSeed * 12.9 );
  float cr = cos( rot ), sr = sin( rot );
  vec2 q = vec2( position.x * cr - position.y * sr, position.x * sr + position.y * cr );

  vec3 p = dir + ( tx * q.x * ang.x + ty * q.y * ang.y );

  vUv = uv;
  vDir = normalize( p );
  vFar = dist / halfD;

  float edge = 1.0 - smoothstep( 0.60, 0.99, length( pp ) / halfD );
  vOpacity = aOpacity * edge * smoothstep( 0.0, 0.06, dir.y ) * uCover;

  mat4 mv = mat4( mat3( modelViewMatrix ) );
  vec4 cs = projectionMatrix * mv * vec4( p, 1.0 );
  gl_Position = cs.xyww;
}
`;

const BILLBOARD_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3  uLit;
uniform vec3  uDark;
uniform vec3  uHaze;
uniform vec3  uSunDir;
uniform float uStorm;

varying vec2  vUv;
varying vec3  vDir;
varying float vOpacity;
varying float vFar;

void main() {
  vec4 tex = texture2D( uMap, vUv );
  float a = tex.a * vOpacity;
  if ( a < 0.004 ) discard;

  vec3 sunDir = normalize( uSunDir );

  // Vertical shading term. Driven mainly by the quad's own UV (robust: the
  // canvas round-trip premultiplies alpha, so tex.r is unreliable in the thin
  // edges) with the sprite's baked height adding per-puff variation.
  float h = clamp( vUv.y * 0.82 + ( tex.r - 0.5 ) * 0.55, 0.0, 1.0 );
  float sunAmt = clamp( dot( vDir, sunDir ) * 0.5 + 0.5, 0.0, 1.0 );

  float lit = clamp( pow( h, 0.85 ) * ( 0.40 + 0.80 * sunAmt ) + 0.05, 0.0, 1.0 );
  lit = mix( lit, lit * 0.32, uStorm );

  vec3 col = mix( uDark, uLit, lit );
  col += uLit * pow( sunAmt, 9.0 ) * ( 1.0 - h ) * 0.85;   // rim / silver lining
  col = mix( col, uHaze, clamp( vFar * 0.34, 0.0, 0.50 ) );

  gl_FragColor = vec4( col, a );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* =========================================================================
 * Factory
 * ====================================================================== */

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {Object} [opts]
 * @param {Object|string} [opts.quality]         quality tier object or tier name
 * @param {number} [opts.latitude=34]            degrees
 * @param {number} [opts.dayOfYear=180]
 * @param {number} [opts.sunIntensity=4.2]       peak DirectionalLight intensity
 * @param {number} [opts.exposure=1]             sky radiance multiplier
 * @param {number} [opts.shadowExtent]           half-width of the ortho shadow box (m)
 * @param {number} [opts.shadowDistance=420]     light standoff distance (m)
 * @param {boolean}[opts.envMap=true]            enable IBL generation
 * @param {number} [opts.envInterval]            seconds between env regenerations
 * @param {boolean}[opts.addToScene=true]        add sky + lights to the scene
 * @param {number} [opts.seed=1337]
 * @param {number} [opts.moonPhase]              0..1 (0 = new, 0.5 = full)
 */
export function createSky(renderer, scene, opts = {}) {
  const options = opts || {};

  /* ---------------- quality resolution ---------------- */

  function resolveQuality(q) {
    let tier = 'high';
    let obj = null;
    if (typeof q === 'string') {
      tier = q;
    } else if (q && typeof q === 'object') {
      obj = q;
      if (typeof q.tier === 'string') tier = q.tier;
    }
    const preset = QUALITY_PRESETS[tier] || QUALITY_PRESETS.high;
    const merged = {
      tier,
      cloudOctaves: preset.cloudOctaves,
      cloudWarp: preset.cloudWarp,
      cirrus: preset.cirrus,
      stars: preset.stars,
      billboards: preset.billboards,
      envSize: preset.envSize,
      envInterval: preset.envInterval,
      shadowMapSize: preset.shadowMapSize,
      shadowExtent: preset.shadowExtent,
      shadowRadius: preset.shadowRadius,
      milkyWay: preset.milkyWay,
      shadows: true,
      reflections: true,
    };
    if (obj) {
      if (typeof obj.shadowMapSize === 'number' && obj.shadowMapSize > 0) {
        merged.shadowMapSize = obj.shadowMapSize;
      }
      if (typeof obj.shadows === 'boolean') merged.shadows = obj.shadows;
      if (typeof obj.reflections === 'boolean') merged.reflections = obj.reflections;
      if (typeof obj.particles === 'number') {
        merged.billboards = Math.round(merged.billboards * clamp(obj.particles, 0.15, 1.5));
      }
    }
    if (typeof options.shadowExtent === 'number') merged.shadowExtent = options.shadowExtent;
    if (typeof options.envInterval === 'number') merged.envInterval = options.envInterval;
    if (options.envMap === false) merged.envSize = 0;
    merged.billboards = Math.min(merged.billboards, MAX_BILLBOARDS);
    merged.stars = Math.min(merged.stars, MAX_STARS);
    return merged;
  }

  let quality = resolveQuality(options.quality);

  /* ---------------- persistent state ---------------- */

  const state = {
    disposed: false,
    time: 0,
    latitude: (typeof options.latitude === 'number' ? options.latitude : 34) * DEG2RAD,
    dayOfYear: typeof options.dayOfYear === 'number' ? options.dayOfYear : 180,
    seed: (options.seed | 0) || 1337,

    sunIntensityMax: typeof options.sunIntensity === 'number' ? options.sunIntensity : 4.2,
    exposure: typeof options.exposure === 'number' ? options.exposure : 1.0,
    shadowDistance: typeof options.shadowDistance === 'number' ? options.shadowDistance : 420,

    // 0 = new, 0.5 = full. Defaults to full so night races get a real key light.
    moonPhase: typeof options.moonPhase === 'number' ? options.moonPhase : 0.5,

    // smoothed weather
    cover: 0.06,
    storm: 0.0,
    turbidity: 2.1,
    humidity: 0.15,
    cirrus: 0.18,
    windSpeed: 0,
    windDir: 0,
    timeOfDay: 13.0,

    driftX: 0,
    driftY: 0,
    cirrusX: 0,
    cirrusY: 0,

    sunfade: 1,
    night: 0,
    moonIllum: 0,
    keyIsMoon: false,

    // env throttling
    envAccum: 0,
    envLastElev: -99,
    envLastCover: -99,
    envReady: false,
    envDirty: true,

    // grading throttle
    gradeAccum: 1,
  };

  const atmosphere = new AtmosphereCPU();

  /* ---------------- root group ---------------- */

  const group = new THREE.Group();
  group.name = 'APEX_Sky';
  group.matrixAutoUpdate = false;
  group.frustumCulled = false;

  /* =====================================================================
   * Sky dome
   * ================================================================== */

  const skyGeometry = new THREE.SphereGeometry(1, 48, 30);

  const skyUniforms = {
    uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.7) },
    uMoonDir: { value: new THREE.Vector3(-0.3, 0.6, -0.7) },
    uBetaR: { value: new THREE.Vector3() },
    uBetaM: { value: new THREE.Vector3() },
    uSunE: { value: 500 },
    uMieG: { value: 0.80 },
    uExposure: { value: EXPOSURE_BASE },
    uSunAngularRadius: { value: 0.0068 },
    uSunDiscIntensity: { value: 1200.0 },
    uSunGlow: { value: 130.0 },

    uNight: { value: 0 },
    uNightSky: { value: new THREE.Vector3(0.0016, 0.0026, 0.0062) },
    uMoonIllum: { value: 0 },
    uMoonGlow: { value: new THREE.Vector3(0.30, 0.34, 0.46) },
    uMilkyWay: { value: quality.milkyWay },

    uHazeColor: { value: new THREE.Vector3(0.55, 0.62, 0.75) },
    uHorizonHaze: { value: 0.34 },
    uGroundLevel: { value: 0.42 },

    uCloudCover: { value: 0.06 },
    uCloudSharp: { value: 0.30 },
    uCloudOpacity: { value: 0.96 },
    uCloudScale: { value: 0.85 },
    uCloudHeight: { value: 1.0 },
    uTurbulence: { value: 0.05 },
    uStorm: { value: 0 },
    uCloudDrift: { value: new THREE.Vector2() },
    uCirrusDrift: { value: new THREE.Vector2() },
    uParallax: { value: new THREE.Vector2() },
    uCirrusCover: { value: 0.18 },
    uCloudLit: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
    uCloudDark: { value: new THREE.Vector3(0.35, 0.38, 0.45) },
    uTime: { value: 0 },
  };

  const skyMaterial = new THREE.ShaderMaterial({
    name: 'ApexSkyDome',
    uniforms: skyUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    defines: {
      CLOUD_OCTAVES: quality.cloudOctaves,
      CLOUD_WARP: quality.cloudWarp,
      CIRRUS: quality.cirrus,
    },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: true,
    blending: THREE.NoBlending,
    transparent: false,
  });

  const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
  skyMesh.name = 'APEX_SkyDome';
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -10000;
  skyMesh.matrixAutoUpdate = false;
  skyMesh.updateMatrix();
  group.add(skyMesh);

  /* =====================================================================
   * Star field
   * ================================================================== */

  let starPoints = null;
  let starGeometry = null;
  let starMaterial = null;
  const starUniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uScale: { value: 1.6 },
    uExtinction: { value: 1.0 },
  };

  try {
    const rng = mulberry32(state.seed ^ 0x51ed270b);
    const pos = new Float32Array(MAX_STARS * 3);
    const size = new Float32Array(MAX_STARS);
    const phase = new Float32Array(MAX_STARS);
    const speed = new Float32Array(MAX_STARS);
    const col = new Float32Array(MAX_STARS * 3);
    const bb = [0, 0, 0];

    // Galactic plane normal — used to bias density into a Milky Way band.
    const gpx = 0.3665, gpy = 0.4275, gpz = -0.8262;

    for (let i = 0; i < MAX_STARS; i++) {
      let x = 0, y = 0, z = 0;
      // rejection-sample toward the galactic plane for ~45% of stars
      const inBand = rng() < 0.45;
      for (let attempt = 0; attempt < 24; attempt++) {
        const u = rng() * 2 - 1;
        const a = rng() * Math.PI * 2;
        const s = Math.sqrt(Math.max(0, 1 - u * u));
        x = s * Math.cos(a); y = u; z = s * Math.sin(a);
        if (!inBand) break;
        const dp = Math.abs(x * gpx + y * gpy + z * gpz);
        if (dp < 0.24 || rng() > 0.9) break;
      }
      // keep stars above the horizon plane mostly (below never shows)
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;

      // Magnitude distribution: many faint, few brilliant.
      const mag = Math.pow(rng(), 3.1);
      size[i] = 0.9 + mag * 4.4;
      phase[i] = rng() * Math.PI * 2;
      speed[i] = 1.1 + rng() * 4.2;

      const kelvin = 2700 + Math.pow(rng(), 0.75) * 14000;
      blackbodyRGB(kelvin, bb);
      const bright = 0.28 + mag * 1.5;
      col[i * 3] = bb[0] * bright;
      col[i * 3 + 1] = bb[1] * bright;
      col[i * 3 + 2] = bb[2] * bright;
    }

    starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    starGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    starGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    starGeometry.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    starGeometry.setDrawRange(0, quality.stars);
    starGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);

    starMaterial = new THREE.ShaderMaterial({
      name: 'ApexSkyStars',
      uniforms: starUniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: true,
      transparent: false,
      blending: THREE.AdditiveBlending,
    });

    starPoints = new THREE.Points(starGeometry, starMaterial);
    starPoints.name = 'APEX_SkyStars';
    starPoints.frustumCulled = false;
    starPoints.renderOrder = -9990;
    starPoints.matrixAutoUpdate = false;
    starPoints.updateMatrix();
    starPoints.visible = false;
    group.add(starPoints);
  } catch (e) {
    starPoints = null;
  }

  /* =====================================================================
   * Moon
   * ================================================================== */

  let moonMesh = null;
  let moonGeometry = null;
  let moonMaterial = null;
  let moonTexture = null;
  const moonUniforms = {
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uTangent: { value: new THREE.Vector3(1, 0, 0) },
    uBitangent: { value: new THREE.Vector3(0, 0, 1) },
    uQuadHalfAngle: { value: 0.030 },
    uMap: { value: null },
    uSunLocal: { value: new THREE.Vector3(1, 0, 0) },
    uMoonColor: { value: new THREE.Vector3(0.78, 0.82, 0.95) },
    uIntensity: { value: 0 },
    uDiscRadius: { value: 0.34 },
    uHaloStrength: { value: 0.10 },
    uEarthshine: { value: 0.035 },
  };

  try {
    moonTexture = buildMoonTexture(256, state.seed ^ 0x2f9a);
    moonUniforms.uMap.value = moonTexture;
    moonGeometry = new THREE.PlaneGeometry(1, 1);
    moonMaterial = new THREE.ShaderMaterial({
      name: 'ApexSkyMoon',
      uniforms: moonUniforms,
      vertexShader: MOON_VERT,
      fragmentShader: MOON_FRAG,
      side: THREE.DoubleSide,   // billboard basis faces away from the camera
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: true,
      transparent: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    moonMesh = new THREE.Mesh(moonGeometry, moonMaterial);
    moonMesh.name = 'APEX_SkyMoon';
    moonMesh.frustumCulled = false;
    moonMesh.renderOrder = -9985;
    moonMesh.matrixAutoUpdate = false;
    moonMesh.updateMatrix();
    moonMesh.visible = false;
    group.add(moonMesh);
  } catch (e) {
    moonMesh = null;
  }

  /* =====================================================================
   * Billboard cumulus
   * ================================================================== */

  let cloudMesh = null;
  let cloudGeometry = null;
  let cloudMaterial = null;
  let cloudTexture = null;
  const CLOUD_DOMAIN = 34000; // metres across the cloud plane
  const CLOUD_ALT = 2100;     // metres
  const cloudUniforms = {
    uMap: { value: null },
    uDrift: { value: new THREE.Vector2() },
    uParallax: { value: new THREE.Vector2() },
    uDomain: { value: CLOUD_DOMAIN },
    uAltitude: { value: CLOUD_ALT },
    uTime: { value: 0 },
    uCover: { value: 0 },
    uSpin: { value: 0.10 },
    uLit: { value: new THREE.Vector3(1, 1, 1) },
    uDark: { value: new THREE.Vector3(0.35, 0.38, 0.45) },
    uHaze: { value: new THREE.Vector3(0.55, 0.62, 0.75) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uStorm: { value: 0 },
  };

  try {
    cloudTexture = buildCloudSprite(256, state.seed ^ 0x7c1d);
    cloudUniforms.uMap.value = cloudTexture;

    const plane = new THREE.PlaneGeometry(1, 1);
    cloudGeometry = new THREE.InstancedBufferGeometry();
    cloudGeometry.index = plane.index;
    cloudGeometry.setAttribute('position', plane.getAttribute('position'));
    cloudGeometry.setAttribute('normal', plane.getAttribute('normal'));
    cloudGeometry.setAttribute('uv', plane.getAttribute('uv'));
    // NOTE: `plane` is intentionally not disposed — cloudGeometry now owns its
    // attribute objects and the source geometry was never uploaded to the GPU.

    const rng = mulberry32(state.seed ^ 0x19af33);
    const aPos = new Float32Array(MAX_BILLBOARDS * 2);
    const aAlt = new Float32Array(MAX_BILLBOARDS);
    const aScale = new Float32Array(MAX_BILLBOARDS * 2);
    const aSeed = new Float32Array(MAX_BILLBOARDS);
    const aOpacity = new Float32Array(MAX_BILLBOARDS);

    const order = [];
    for (let i = 0; i < MAX_BILLBOARDS; i++) {
      const x = (rng() - 0.5) * CLOUD_DOMAIN;
      const z = (rng() - 0.5) * CLOUD_DOMAIN;
      order.push({ x, z, d: Math.sqrt(x * x + z * z) });
    }
    // Draw far puffs first so the alpha overlap reads roughly correctly.
    order.sort((a, b) => b.d - a.d);

    for (let i = 0; i < MAX_BILLBOARDS; i++) {
      const o = order[i];
      aPos[i * 2] = o.x;
      aPos[i * 2 + 1] = o.z;
      aAlt[i] = 0.78 + rng() * 0.55;
      const w = 1500 + Math.pow(rng(), 1.6) * 4200;
      aScale[i * 2] = w;
      aScale[i * 2 + 1] = w * (0.40 + rng() * 0.32);
      aSeed[i] = rng();
      aOpacity[i] = 0.58 + rng() * 0.42;
    }

    cloudGeometry.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 2));
    cloudGeometry.setAttribute('aAlt', new THREE.InstancedBufferAttribute(aAlt, 1));
    cloudGeometry.setAttribute('aScale', new THREE.InstancedBufferAttribute(aScale, 2));
    cloudGeometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
    cloudGeometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(aOpacity, 1));
    cloudGeometry.instanceCount = quality.billboards;
    cloudGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);

    cloudMaterial = new THREE.ShaderMaterial({
      name: 'ApexSkyCumulus',
      uniforms: cloudUniforms,
      vertexShader: BILLBOARD_VERT,
      fragmentShader: BILLBOARD_FRAG,
      // The billboard basis makes each quad's geometric normal point AWAY from
      // the camera, so single-sided rendering would back-face cull every puff.
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: true,
      transparent: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });

    cloudMesh = new THREE.Mesh(cloudGeometry, cloudMaterial);
    cloudMesh.name = 'APEX_SkyCumulus';
    cloudMesh.frustumCulled = false;
    cloudMesh.renderOrder = -9980;
    cloudMesh.matrixAutoUpdate = false;
    cloudMesh.updateMatrix();
    cloudMesh.visible = quality.billboards > 0;
    group.add(cloudMesh);
  } catch (e) {
    cloudMesh = null;
  }

  /* =====================================================================
   * Lights
   * ================================================================== */

  const sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
  sunLight.name = 'APEX_SunLight';
  sunLight.castShadow = quality.shadows !== false;
  sunLight.position.set(120, 300, 120);
  sunLight.target.position.set(0, 0, 0);

  try {
    const sh = sunLight.shadow;
    sh.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    sh.camera.left = -quality.shadowExtent;
    sh.camera.right = quality.shadowExtent;
    sh.camera.top = quality.shadowExtent;
    sh.camera.bottom = -quality.shadowExtent;
    sh.camera.near = 1;
    sh.camera.far = state.shadowDistance * 2 + quality.shadowExtent * 2;
    sh.camera.updateProjectionMatrix();
    const texel = (2 * quality.shadowExtent) / quality.shadowMapSize;
    sh.bias = -0.00035;
    sh.normalBias = Math.min(0.07, Math.max(0.010, texel * 0.9));
    sh.radius = quality.shadowRadius;
    sh.blurSamples = 8;
  } catch (e) { /* shadows optional */ }

  const fillLight = new THREE.DirectionalLight(0x9ab4d8, 0.35);
  fillLight.name = 'APEX_FillLight';
  fillLight.castShadow = false;
  fillLight.position.set(-180, 160, -140);

  const hemiLight = new THREE.HemisphereLight(0x9fc4ea, 0x3b3a35, 0.6);
  hemiLight.name = 'APEX_HemiLight';
  hemiLight.position.set(0, 60, 0);

  const addToScene = options.addToScene !== false;
  if (addToScene && scene && scene.add) {
    try {
      scene.add(group);
      scene.add(sunLight);
      scene.add(sunLight.target);
      scene.add(fillLight);
      scene.add(fillLight.target);
      scene.add(hemiLight);
    } catch (e) { /* keep going */ }
  }

  /* =====================================================================
   * Image-based lighting
   * ================================================================== */

  let pmremGenerator = null;
  let cubeRT = null;
  let pmremRT = null;
  let envScene = null;
  let envCamera = null;
  let envDomeMesh = null;
  let envMoonMesh = null;
  let envSizeCurrent = 0;

  function teardownEnv() {
    try {
      if (scene && scene.environment && pmremRT && scene.environment === pmremRT.texture) {
        scene.environment = null;
      }
      if (pmremRT) { pmremRT.dispose(); pmremRT = null; }
      if (cubeRT) { cubeRT.dispose(); cubeRT = null; }
      if (envScene) {
        if (envDomeMesh) envScene.remove(envDomeMesh);
        if (envMoonMesh) envScene.remove(envMoonMesh);
        envScene = null;
      }
      envDomeMesh = null;
      envMoonMesh = null;
      envCamera = null;
      envSizeCurrent = 0;
      state.envReady = false;
    } catch (e) { /* ignore */ }
  }

  function setupEnv(size) {
    if (!renderer || !size || size < 16) { teardownEnv(); return; }
    if (envSizeCurrent === size && cubeRT && envCamera) return;
    teardownEnv();
    try {
      // HDR cube target where the platform can render to it, LDR otherwise.
      let hdrType = THREE.HalfFloatType;
      try {
        const ext = renderer.extensions;
        const gl2 = renderer.capabilities && renderer.capabilities.isWebGL2;
        const ok = gl2
          ? (ext && (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')))
          : (ext && ext.has('EXT_color_buffer_half_float'));
        if (!ok) hdrType = THREE.UnsignedByteType;
      } catch (eCaps) {
        hdrType = THREE.UnsignedByteType;
      }

      cubeRT = new THREE.WebGLCubeRenderTarget(size, {
        type: hdrType,
        mapping: THREE.CubeReflectionMapping,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      });
      cubeRT.texture.name = 'APEX_SkyCube';

      envCamera = new THREE.CubeCamera(0.1, 10, cubeRT);

      envScene = new THREE.Scene();
      envDomeMesh = new THREE.Mesh(skyGeometry, skyMaterial);
      envDomeMesh.frustumCulled = false;
      envDomeMesh.renderOrder = -10000;
      envDomeMesh.matrixAutoUpdate = false;
      envDomeMesh.updateMatrix();
      envScene.add(envDomeMesh);

      if (moonGeometry && moonMaterial) {
        envMoonMesh = new THREE.Mesh(moonGeometry, moonMaterial);
        envMoonMesh.frustumCulled = false;
        envMoonMesh.renderOrder = -9985;
        envMoonMesh.matrixAutoUpdate = false;
        envMoonMesh.updateMatrix();
        envScene.add(envMoonMesh);
      }

      if (!pmremGenerator) pmremGenerator = new THREE.PMREMGenerator(renderer);
      envSizeCurrent = size;
      state.envDirty = true;
    } catch (e) {
      teardownEnv();
    }
  }

  function regenerateEnv() {
    if (!cubeRT || !envCamera || !envScene || !pmremGenerator || !renderer) return;
    let prevAutoClear = true;
    let prevTarget = null;
    try {
      prevAutoClear = renderer.autoClear;
      prevTarget = renderer.getRenderTarget();
      renderer.autoClear = true;

      if (envMoonMesh) envMoonMesh.visible = moonMesh ? moonMesh.visible : false;
      envCamera.update(renderer, envScene);

      pmremRT = pmremGenerator.fromCubemap(cubeRT.texture, pmremRT);
      if (pmremRT && pmremRT.texture) {
        pmremRT.texture.name = 'APEX_SkyEnv';
        if (scene) scene.environment = pmremRT.texture;
        state.envReady = true;
      }
    } catch (e) {
      // A single failure should not kill the frame — disable IBL and move on.
      try { teardownEnv(); } catch (e2) { /* ignore */ }
    } finally {
      try {
        renderer.autoClear = prevAutoClear;
        renderer.setRenderTarget(prevTarget);
      } catch (e3) { /* ignore */ }
    }
  }

  if (quality.envSize > 0 && options.envMap !== false) {
    setupEnv(quality.envSize);
  }

  /* =====================================================================
   * Grading — derives every CPU-side colour from the same integral the
   * shader runs, so nothing can drift out of sync.
   * ================================================================== */

  const grading = {
    fog: new THREE.Color(0.5, 0.6, 0.75),
    haze: new THREE.Color(0.5, 0.6, 0.75),
    zenith: new THREE.Color(0.2, 0.35, 0.7),
    sun: new THREE.Color(1, 1, 1),
    sunIntensity: 0,
    ambient: new THREE.Color(0.3, 0.4, 0.55),
    cloudLit: new THREE.Color(1, 1, 1),
    cloudDark: new THREE.Color(0.3, 0.33, 0.4),
  };

  function sampleHorizon(azOffsetSin, azOffsetCos, elev, out) {
    // Build a direction at `elev` radians, rotated `azOffset` from the sun azimuth.
    const sx = _vSun.x, sz = _vSun.z;
    let ax = sx, az = sz;
    const l = Math.sqrt(ax * ax + az * az);
    if (l < 1e-5) { ax = 1; az = 0; } else { ax /= l; az /= l; }
    const rx = ax * azOffsetCos - az * azOffsetSin;
    const rz = ax * azOffsetSin + az * azOffsetCos;
    const ce = Math.cos(elev), se = Math.sin(elev);
    return atmosphere.sample(rx * ce, se, rz * ce, out);
  }

  function recomputeGrading() {
    const sunfade = state.sunfade;
    const rayleigh = 2.0 + state.humidity * 0.55;
    const mieCoefficient = 0.0045 + state.humidity * 0.006 + state.storm * 0.010;
    const mieG = 0.80 - state.storm * 0.06;
    const expo = EXPOSURE_BASE * state.exposure;

    atmosphere.configure(_vSun, state.turbidity, rayleigh, mieCoefficient, mieG, sunfade, expo);

    // --- horizon ring -----------------------------------------------------
    sampleHorizon(0.0, 1.0, 0.020, _rgbA);          // toward the sun
    sampleHorizon(1.0, 0.0, 0.020, _rgbB);          // +90 deg
    sampleHorizon(0.0, -1.0, 0.020, _rgbC);         // away from the sun
    sampleHorizon(-1.0, 0.0, 0.020, _rgbD);         // -90 deg

    for (let i = 0; i < 3; i++) {
      _rgbAcc[i] = (_rgbA[i] * 0.34 + _rgbB[i] * 0.22 + _rgbC[i] * 0.22 + _rgbD[i] * 0.22);
    }

    // --- zenith -----------------------------------------------------------
    atmosphere.sample(0, 1, 0, _rgbA);
    _colZenith.setRGB(_rgbA[0], _rgbA[1], _rgbA[2], THREE.LinearSRGBColorSpace);

    // --- haze: horizon ring, desaturated toward white by humidity ---------
    const lumH = _rgbAcc[0] * 0.2126 + _rgbAcc[1] * 0.7152 + _rgbAcc[2] * 0.0722;
    const desat = 0.20 + state.humidity * 0.42 + state.cover * 0.22;
    const hazeBoost = 1.0 + state.humidity * 0.30;
    _colHaze.setRGB(
      lerp(_rgbAcc[0], lumH, desat) * hazeBoost,
      lerp(_rgbAcc[1], lumH, desat) * hazeBoost,
      lerp(_rgbAcc[2], lumH, desat) * hazeBoost,
      THREE.LinearSRGBColorSpace,
    );

    // --- night lift: never let the sky go pure black -----------------------
    const nightLift = state.night * 0.0022;

    // --- sun transmittance drives hue; elevation drives level --------------
    atmosphere.sunTransmittance(_fex);
    const maxF = Math.max(_fex[0], _fex[1], _fex[2], 1e-5);
    const sr = _fex[0] / maxF, sg = _fex[1] / maxF, sb = _fex[2] / maxF;

    const elev = _vSun.y;
    let sunLevel = smoothstep(-0.075, 0.26, elev);
    // golden hour: keep a warm, low, but still meaningful key light
    sunLevel = Math.pow(sunLevel, 0.82);
    const coverDim = (1 - state.cover * 0.70) * (1 - state.storm * 0.30);
    let intensity = state.sunIntensityMax * sunLevel * coverDim;

    state.keyIsMoon = false;
    if (elev < -0.06 && state.moonIllum > 0.02) {
      // Hand the key light over to the moon once the sun is properly down.
      const blend = smoothstep(-0.06, -0.16, elev);
      const moonI = 0.085 * state.moonIllum * coverDim * blend;
      if (moonI > intensity) {
        intensity = moonI;
        state.keyIsMoon = true;
      }
    }

    if (state.keyIsMoon) {
      _colSun.setRGB(0.62, 0.72, 1.0, THREE.LinearSRGBColorSpace);
    } else {
      // Slight warm bias at low elevation on top of the physical transmittance.
      const warm = smoothstep(0.30, -0.02, elev);
      _colSun.setRGB(
        Math.min(1.0, sr * (1 + warm * 0.10)),
        sg * (1 - warm * 0.05),
        sb * (1 - warm * 0.18),
        THREE.LinearSRGBColorSpace,
      );
    }
    grading.sun.copy(_colSun);
    grading.sunIntensity = intensity;

    // --- ambient / cloud shading ------------------------------------------
    _colAmbient.copy(_colZenith).lerp(_colHaze, 0.45);

    const sunDirectLin = Math.max(0.0, sunLevel) * (1 - state.cover * 0.45);
    _colCloudLit.setRGB(
      _colAmbient.r * 1.35 + sr * sunDirectLin * 1.55,
      _colAmbient.g * 1.35 + sg * sunDirectLin * 1.55,
      _colAmbient.b * 1.35 + sb * sunDirectLin * 1.50,
      THREE.LinearSRGBColorSpace,
    );
    const stormMul = 1 - state.storm * 0.72;
    _colCloudLit.multiplyScalar(stormMul * (1 - state.cover * 0.20) + 0.02);

    _colCloudDark.setRGB(
      _colAmbient.r * 0.34 + _colHaze.r * 0.15,
      _colAmbient.g * 0.35 + _colHaze.g * 0.15,
      _colAmbient.b * 0.38 + _colHaze.b * 0.15,
      THREE.LinearSRGBColorSpace,
    );
    // Shaded cloud bases are neutral grey, not sky-blue — desaturate hard,
    // otherwise overcast decks develop blue veins where the density dips.
    const darkLum = _colCloudDark.r * 0.2126 + _colCloudDark.g * 0.7152 + _colCloudDark.b * 0.0722;
    _colCloudDark.setRGB(
      lerp(_colCloudDark.r, darkLum, 0.58),
      lerp(_colCloudDark.g, darkLum, 0.58),
      lerp(_colCloudDark.b, darkLum, 0.70),
      THREE.LinearSRGBColorSpace,
    );
    _colCloudDark.multiplyScalar((1 - state.storm * 0.84) * (1 - state.cover * 0.24) + 0.010);

    grading.cloudLit.copy(_colCloudLit);
    grading.cloudDark.copy(_colCloudDark);
    grading.zenith.copy(_colZenith);
    grading.ambient.copy(_colAmbient);

    // --- fog ---------------------------------------------------------------
    const hh = skyUniforms.uHorizonHaze.value;
    _colFog.setRGB(
      lerp(_rgbAcc[0], _colHaze.r, hh) + nightLift,
      lerp(_rgbAcc[1], _colHaze.g, hh) + nightLift * 1.1,
      lerp(_rgbAcc[2], _colHaze.b, hh) + nightLift * 1.6,
      THREE.LinearSRGBColorSpace,
    );
    // Overcast pushes the fog toward the flat, lit underside of the deck.
    _colFog.lerp(_colCloudDark, state.cover * 0.30);
    _colFog.lerp(_colCloudLit, state.cover * 0.22);
    _colFog.multiplyScalar(1 - state.storm * 0.28);
    grading.fog.copy(_colFog);
    grading.haze.copy(_colHaze);

    // --- push into the shaders --------------------------------------------
    skyUniforms.uBetaR.value.set(atmosphere.betaR[0], atmosphere.betaR[1], atmosphere.betaR[2]);
    skyUniforms.uBetaM.value.set(atmosphere.betaM[0], atmosphere.betaM[1], atmosphere.betaM[2]);
    skyUniforms.uSunE.value = atmosphere.sunE;
    skyUniforms.uMieG.value = mieG;
    skyUniforms.uExposure.value = expo;
    skyUniforms.uHazeColor.value.set(_colHaze.r, _colHaze.g, _colHaze.b);
    skyUniforms.uCloudLit.value.set(_colCloudLit.r, _colCloudLit.g, _colCloudLit.b);
    skyUniforms.uCloudDark.value.set(_colCloudDark.r, _colCloudDark.g, _colCloudDark.b);

    if (cloudUniforms) {
      cloudUniforms.uLit.value.set(_colCloudLit.r, _colCloudLit.g, _colCloudLit.b);
      cloudUniforms.uDark.value.set(_colCloudDark.r, _colCloudDark.g, _colCloudDark.b);
      cloudUniforms.uHaze.value.set(_colHaze.r, _colHaze.g, _colHaze.b);
    }

    // --- ambient rigs ------------------------------------------------------
    _colHemiSky.copy(_colZenith).lerp(_colHaze, 0.35).multiplyScalar(1.0);
    _colHemiGround.setRGB(
      0.055 + _colHaze.r * 0.16,
      0.050 + _colHaze.g * 0.15,
      0.045 + _colHaze.b * 0.13,
      THREE.LinearSRGBColorSpace,
    );
    hemiLight.color.copy(_colHemiSky);
    hemiLight.groundColor.copy(_colHemiGround);
    hemiLight.intensity = clamp(
      0.22 + smoothstep(-0.12, 0.30, elev) * 0.85 * (1 + state.cover * 0.55) + state.night * 0.045,
      0.03, 2.2,
    );

    _colFill.copy(_colZenith).lerp(_colHaze, 0.25);
    const fillLum = Math.max(_colFill.r, _colFill.g, _colFill.b, 1e-4);
    _colFill.multiplyScalar(1 / fillLum);
    fillLight.color.copy(_colFill);
    fillLight.intensity = clamp(
      0.18 + smoothstep(-0.10, 0.35, elev) * 0.60 * (0.55 + state.cover * 0.85),
      0.01, 1.6,
    );

    sunLight.color.copy(grading.sun);
    sunLight.intensity = grading.sunIntensity;
  }

  /* =====================================================================
   * Shadow camera follow (texel-snapped to kill shimmer)
   * ================================================================== */

  function updateShadowCamera(target) {
    if (!sunLight.castShadow) {
      sunLight.position.copy(target).addScaledVector(_vKey, state.shadowDistance);
      sunLight.target.position.copy(target);
      sunLight.target.updateMatrixWorld();
      return;
    }

    const ext = quality.shadowExtent;
    const mapSize = sunLight.shadow.mapSize.x || 1024;
    const texel = (2 * ext) / mapSize;

    // Light-space basis matching three's internal shadow camera lookAt (up = +Y).
    _axZ.copy(_vKey);
    if (Math.abs(_axZ.y) > 0.9995) {
      _axZ.x += 0.003;
      _axZ.normalize();
    }
    _axX.crossVectors(UP_Y, _axZ);
    if (_axX.lengthSq() < 1e-8) _axX.crossVectors(UP_X, _axZ);
    _axX.normalize();
    _axY.crossVectors(_axZ, _axX).normalize();

    const px = target.dot(_axX);
    const py = target.dot(_axY);
    const pz = target.dot(_axZ);
    const sx = Math.round(px / texel) * texel;
    const sy = Math.round(py / texel) * texel;

    _vSnapped.set(0, 0, 0)
      .addScaledVector(_axX, sx)
      .addScaledVector(_axY, sy)
      .addScaledVector(_axZ, pz);

    sunLight.target.position.copy(_vSnapped);
    sunLight.position.copy(_vSnapped).addScaledVector(_axZ, state.shadowDistance);
    sunLight.target.updateMatrixWorld();
    sunLight.updateMatrixWorld();

    // Keep the fill light roughly anti-key so it reads as sky bounce.
    fillLight.position.copy(target)
      .addScaledVector(_axZ, -state.shadowDistance * 0.5)
      .addScaledVector(UP_Y, state.shadowDistance * 0.7);
    fillLight.target.position.copy(target);
    fillLight.target.updateMatrixWorld();

    hemiLight.position.set(target.x, target.y + 80, target.z);
  }

  function applyShadowFrustum() {
    if (!sunLight.shadow) return;
    try {
      const sh = sunLight.shadow;
      const ext = quality.shadowExtent;
      sh.camera.left = -ext;
      sh.camera.right = ext;
      sh.camera.top = ext;
      sh.camera.bottom = -ext;
      sh.camera.near = 1;
      sh.camera.far = state.shadowDistance * 2 + ext * 2;
      sh.camera.updateProjectionMatrix();
      const texel = (2 * ext) / (sh.mapSize.x || 1024);
      sh.normalBias = Math.min(0.07, Math.max(0.010, texel * 0.9));
      sh.radius = quality.shadowRadius;
      if (sh.map && (sh.map.width !== sh.mapSize.x)) {
        sh.map.dispose();
        sh.map = null;
      }
    } catch (e) { /* ignore */ }
  }

  /* =====================================================================
   * Weather ingestion
   * ================================================================== */

  function ingestWeather(weather, dt) {
    const w = weather || {};
    const cond = typeof w.condition === 'string' ? w.condition : 'clear';
    const table = CONDITION_TABLE[cond] || CONDITION_TABLE.clear;

    let coverTarget = table.cover;
    if (typeof w.overcast === 'number') {
      coverTarget = clamp(lerp(coverTarget, w.overcast, 0.85), 0, 0.995);
    }
    if (typeof w.cloudCover === 'number') {
      coverTarget = clamp(w.cloudCover, 0, 0.995);
    }
    // Rain always implies at least the cloud that produces it.
    const rain = typeof w.rainIntensity === 'number' ? clamp(w.rainIntensity, 0, 1) : 0;
    coverTarget = Math.max(coverTarget, rain * 0.92);

    const stormTarget = clamp(Math.max(table.storm, rain * 0.85), 0, 1);
    const turbTarget = table.turbidity + rain * 1.4;
    const humTarget = Math.max(table.humidity, rain * 0.9);
    const cirrusTarget = table.cirrus;

    state.cover = damp(state.cover, coverTarget, 5.0, dt);
    state.storm = damp(state.storm, stormTarget, 7.0, dt);
    state.turbidity = damp(state.turbidity, turbTarget, 8.0, dt);
    state.humidity = damp(state.humidity, humTarget, 6.0, dt);
    state.cirrus = damp(state.cirrus, cirrusTarget, 9.0, dt);

    const ws = typeof w.windSpeed === 'number' ? w.windSpeed : 4;
    const wd = typeof w.windDir === 'number' ? w.windDir : 0.6;
    state.windSpeed = damp(state.windSpeed, ws, 3.0, dt);
    // Angles are damped on the shortest arc.
    let delta = wd - state.windDir;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    state.windDir += delta * (1 - Math.exp(-dt / 4.0));

    state.timeOfDay = typeof w.timeOfDay === 'number'
      ? ((w.timeOfDay % 24) + 24) % 24
      : state.timeOfDay;
  }

  /* =====================================================================
   * update()
   * ================================================================== */

  function resolveTarget(cameraTarget, out) {
    if (!cameraTarget) { out.set(0, 0, 0); return out; }
    if (cameraTarget.isVector3) { out.copy(cameraTarget); return out; }
    if (cameraTarget.isObject3D) {
      try { cameraTarget.getWorldPosition(out); return out; } catch (e) { /* fall through */ }
    }
    if (cameraTarget.position && typeof cameraTarget.position.x === 'number') {
      out.set(cameraTarget.position.x, cameraTarget.position.y, cameraTarget.position.z);
      return out;
    }
    if (typeof cameraTarget.x === 'number') {
      out.set(cameraTarget.x, cameraTarget.y || 0, cameraTarget.z || 0);
      return out;
    }
    out.set(0, 0, 0);
    return out;
  }

  function update(weather, dt, cameraTarget) {
    if (state.disposed) return;

    const step = clamp(typeof dt === 'number' && isFinite(dt) ? dt : 0.016, 0, 0.25);
    state.time += step;

    try {
      ingestWeather(weather, step);
    } catch (e) { /* keep the sky alive */ }

    /* ---- sun & moon ---- */
    try {
      solarDirection(state.timeOfDay, state.latitude, state.dayOfYear, _vSun);

      // Moon: opposite hour angle, offset by the synodic phase, and a small
      // orbital inclination so it never sits exactly on the sun's arc.
      const phase = ((state.moonPhase % 1) + 1) % 1;
      const moonHours = state.timeOfDay + 12 + (phase - 0.5) * 24;
      solarDirection(moonHours, state.latitude + 0.09, state.dayOfYear, _vMoon);

      state.sunfade = clamp(smoothstep(-0.03, 0.34, _vSun.y), 0, 1);
      state.night = clamp(smoothstep(0.06, -0.14, _vSun.y), 0, 1);

      // Illuminated fraction of the lunar disc as seen from the observer.
      const cosPhase = clamp(_vSun.dot(_vMoon), -1, 1);
      const illumFraction = (1 - cosPhase) * 0.5;
      state.moonIllum = illumFraction * clamp(smoothstep(-0.06, 0.10, _vMoon.y), 0, 1);
    } catch (e) { /* keep last-known directions */ }

    /* ---- key light direction ---- */
    try {
      if (_vSun.y < -0.06 && state.moonIllum > 0.02) {
        _vKey.copy(_vMoon);
      } else {
        _vKey.copy(_vSun);
      }
      if (_vKey.y < 0.04) {
        // Never let the key light rake exactly along the ground plane; the
        // shadow frustum degenerates and everything self-shadows.
        _vKey.y = Math.max(_vKey.y, 0.04);
        _vKey.normalize();
      }
    } catch (e) { /* ignore */ }

    /* ---- cloud drift ---- */
    try {
      const wx = Math.sin(state.windDir);
      const wz = Math.cos(state.windDir);
      // Sky-shader drift is in normalised cloud-plane units.
      const shaderRate = state.windSpeed * 0.00085 * (1 + state.storm * 0.8);
      state.driftX -= wx * shaderRate * step;
      state.driftY -= wz * shaderRate * step;
      const cirrusRate = state.windSpeed * 0.00165;
      state.cirrusX -= wx * cirrusRate * step;
      state.cirrusY -= wz * cirrusRate * step;

      skyUniforms.uCloudDrift.value.set(state.driftX, state.driftY);
      skyUniforms.uCirrusDrift.value.set(state.cirrusX, state.cirrusY);
    } catch (e) { /* ignore */ }

    /* ---- world target ---- */
    resolveTarget(cameraTarget, _vTarget);

    /* ---- grading (throttled, but always fresh enough to look continuous) ---- */
    try {
      state.gradeAccum += step;
      if (state.gradeAccum >= 0.05) {
        state.gradeAccum = 0;
        recomputeGrading();
      }
    } catch (e) { /* ignore */ }

    /* ---- sky uniforms ---- */
    try {
      skyUniforms.uSunDir.value.copy(_vSun);
      skyUniforms.uMoonDir.value.copy(_vMoon);
      skyUniforms.uTime.value = state.time;
      skyUniforms.uNight.value = state.night;
      skyUniforms.uMoonIllum.value = state.moonIllum;
      skyUniforms.uMilkyWay.value = quality.milkyWay * (1 - state.cover * 0.9);

      skyUniforms.uCloudCover.value = state.cover;
      skyUniforms.uCloudSharp.value = lerp(0.30, 0.13, state.storm);
      skyUniforms.uCloudOpacity.value = lerp(0.92, 1.0, state.cover);
      skyUniforms.uStorm.value = state.storm;
      skyUniforms.uTurbulence.value = 0.04 + state.storm * 0.85 + state.windSpeed * 0.012;
      skyUniforms.uCirrusCover.value = state.cirrus * (1 - state.cover * 0.55);
      skyUniforms.uHorizonHaze.value = clamp(0.26 + state.humidity * 0.34 + state.cover * 0.14, 0, 0.9);
      skyUniforms.uGroundLevel.value = lerp(0.46, 0.26, state.storm);
      skyUniforms.uSunAngularRadius.value = 0.0068;
      skyUniforms.uSunDiscIntensity.value = 1200 * (1 - state.cover * 0.85);
      skyUniforms.uSunGlow.value = 130 * (1 - state.cover * 0.6) * (1 + state.humidity * 0.4);

      // Parallax: driving 5 km across the track genuinely slides the deck.
      skyUniforms.uParallax.value.set(
        _vTarget.x / 2400,
        _vTarget.z / 2400,
      );
    } catch (e) { /* ignore */ }

    /* ---- stars ---- */
    try {
      if (starPoints) {
        const op = state.night * (1 - state.cover * 0.94);
        starPoints.visible = op > 0.004;
        if (starPoints.visible) {
          starUniforms.uTime.value = state.time;
          starUniforms.uOpacity.value = op * 1.35;
          const pr = renderer && renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
          starUniforms.uScale.value = 1.35 * clamp(pr, 0.5, 2.5);
        }
      }
    } catch (e) { /* ignore */ }

    /* ---- moon ---- */
    try {
      if (moonMesh) {
        // -0.01 rad ≈ the atmospheric-refraction allowance; any lower and the
        // disc floats visibly below the horizon line.
        const vis = _vMoon.y > -0.010 && state.night > 0.01 && state.cover < 0.985;
        moonMesh.visible = vis;
        if (vis) {
          moonUniforms.uMoonDir.value.copy(_vMoon);

          // Tangent frame for the billboard.
          const upRef = Math.abs(_vMoon.y) < 0.94 ? UP_Y : UP_X;
          _tmpA.crossVectors(upRef, _vMoon);
          if (_tmpA.lengthSq() < 1e-8) _tmpA.crossVectors(UP_X, _vMoon);
          _tmpA.normalize();
          _tmpB.crossVectors(_vMoon, _tmpA).normalize();
          moonUniforms.uTangent.value.copy(_tmpA);
          moonUniforms.uBitangent.value.copy(_tmpB);

          // Sun expressed in that frame → correct phase terminator.
          _tmpC.set(_vSun.dot(_tmpA), _vSun.dot(_tmpB), _vSun.dot(_vMoon));
          if (_tmpC.lengthSq() < 1e-8) _tmpC.set(1, 0, 0);
          moonUniforms.uSunLocal.value.copy(_tmpC);

          const horizonSwell = 1 + smoothstep(0.30, 0.0, _vMoon.y) * 0.28;
          moonUniforms.uQuadHalfAngle.value = 0.0300 * horizonSwell;
          moonUniforms.uDiscRadius.value = 0.34;

          const clear = 1 - state.cover * 0.92;
          const horizonFade = smoothstep(-0.010, 0.055, _vMoon.y);
          moonUniforms.uIntensity.value = state.night * clear * 3.4 * horizonFade;
          moonUniforms.uHaloStrength.value = 0.055 + state.humidity * 0.10;
          moonUniforms.uEarthshine.value = 0.030 * (1 - state.moonIllum * 0.5);

          // Low moons redden exactly like a low sun.
          const low = smoothstep(0.28, -0.02, _vMoon.y);
          moonUniforms.uMoonColor.value.set(
            lerp(0.80, 1.00, low),
            lerp(0.84, 0.72, low),
            lerp(1.00, 0.52, low),
          );
        }
      }
    } catch (e) { /* ignore */ }

    /* ---- billboard clouds ---- */
    try {
      if (cloudMesh && cloudGeometry.instanceCount > 0) {
        const cover = clamp((state.cover - 0.10) / 0.70, 0, 1);
        cloudMesh.visible = cover > 0.01;
        if (cloudMesh.visible) {
          const wx = Math.sin(state.windDir);
          const wz = Math.cos(state.windDir);
          const rate = state.windSpeed * (1 + state.storm * 0.6);
          cloudUniforms.uDrift.value.x -= wx * rate * step;
          cloudUniforms.uDrift.value.y -= wz * rate * step;
          cloudUniforms.uParallax.value.set(_vTarget.x, _vTarget.z);
          cloudUniforms.uTime.value = state.time;
          cloudUniforms.uCover.value = cover * (1 - state.storm * 0.18);
          cloudUniforms.uStorm.value = state.storm;
          cloudUniforms.uSunDir.value.copy(_vSun);
          cloudUniforms.uAltitude.value = CLOUD_ALT * lerp(1.0, 0.62, state.storm);
          cloudUniforms.uSpin.value = 0.06 + state.storm * 0.22;
        }
      }
    } catch (e) { /* ignore */ }

    /* ---- lights + shadow follow ---- */
    try {
      updateShadowCamera(_vTarget);
    } catch (e) { /* ignore */ }

    /* ---- image-based lighting (throttled) ---- */
    try {
      if (cubeRT && envCamera && pmremGenerator) {
        state.envAccum += step;
        const elev = _vSun.y;
        const dElev = Math.abs(elev - state.envLastElev);
        const dCover = Math.abs(state.cover - state.envLastCover);
        const interval = quality.envInterval;
        const changed = dElev > 0.010 || dCover > 0.03 || !state.envReady || state.envDirty;
        if (state.envAccum >= interval && (changed || state.envAccum >= interval * 4)) {
          state.envAccum = 0;
          state.envLastElev = elev;
          state.envLastCover = state.cover;
          state.envDirty = false;
          regenerateEnv();
        }
      }
    } catch (e) { /* ignore */ }
  }

  /* =====================================================================
   * setQuality()
   * ================================================================== */

  function setQuality(q) {
    if (state.disposed) return;
    try {
      const next = resolveQuality(q);
      const octavesChanged =
        next.cloudOctaves !== quality.cloudOctaves ||
        next.cloudWarp !== quality.cloudWarp ||
        next.cirrus !== quality.cirrus;

      quality = next;

      if (octavesChanged) {
        skyMaterial.defines.CLOUD_OCTAVES = quality.cloudOctaves;
        skyMaterial.defines.CLOUD_WARP = quality.cloudWarp;
        skyMaterial.defines.CIRRUS = quality.cirrus;
        skyMaterial.needsUpdate = true;
      }

      skyUniforms.uMilkyWay.value = quality.milkyWay;

      if (starGeometry) {
        starGeometry.setDrawRange(0, clamp(quality.stars, 0, MAX_STARS));
      }
      if (cloudGeometry && cloudMesh) {
        cloudGeometry.instanceCount = clamp(quality.billboards, 0, MAX_BILLBOARDS);
        cloudMesh.visible = quality.billboards > 0;
      }

      sunLight.castShadow = quality.shadows !== false;
      if (sunLight.shadow) {
        if (sunLight.shadow.mapSize.x !== quality.shadowMapSize) {
          sunLight.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
          if (sunLight.shadow.map) {
            sunLight.shadow.map.dispose();
            sunLight.shadow.map = null;
          }
        }
        applyShadowFrustum();
      }

      if (quality.envSize > 0 && options.envMap !== false) {
        setupEnv(quality.envSize);
      } else {
        teardownEnv();
      }

      state.envDirty = true;
      state.gradeAccum = 1;
    } catch (e) { /* keep running at the previous quality */ }
  }

  /* =====================================================================
   * dispose()
   * ================================================================== */

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;

    try { teardownEnv(); } catch (e) { /* ignore */ }
    try { if (pmremGenerator) { pmremGenerator.dispose(); pmremGenerator = null; } } catch (e) { /* ignore */ }

    try {
      if (group.parent) group.parent.remove(group);
      if (sunLight.parent) sunLight.parent.remove(sunLight);
      if (sunLight.target.parent) sunLight.target.parent.remove(sunLight.target);
      if (fillLight.parent) fillLight.parent.remove(fillLight);
      if (fillLight.target.parent) fillLight.target.parent.remove(fillLight.target);
      if (hemiLight.parent) hemiLight.parent.remove(hemiLight);
    } catch (e) { /* ignore */ }

    try { if (sunLight.shadow && sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; } } catch (e) { /* ignore */ }
    try { sunLight.dispose && sunLight.dispose(); } catch (e) { /* ignore */ }
    try { fillLight.dispose && fillLight.dispose(); } catch (e) { /* ignore */ }
    try { hemiLight.dispose && hemiLight.dispose(); } catch (e) { /* ignore */ }

    try { skyGeometry.dispose(); } catch (e) { /* ignore */ }
    try { skyMaterial.dispose(); } catch (e) { /* ignore */ }
    try { if (starGeometry) starGeometry.dispose(); } catch (e) { /* ignore */ }
    try { if (starMaterial) starMaterial.dispose(); } catch (e) { /* ignore */ }
    try { if (moonGeometry) moonGeometry.dispose(); } catch (e) { /* ignore */ }
    try { if (moonMaterial) moonMaterial.dispose(); } catch (e) { /* ignore */ }
    try { if (moonTexture) moonTexture.dispose(); } catch (e) { /* ignore */ }
    try { if (cloudGeometry) cloudGeometry.dispose(); } catch (e) { /* ignore */ }
    try { if (cloudMaterial) cloudMaterial.dispose(); } catch (e) { /* ignore */ }
    try { if (cloudTexture) cloudTexture.dispose(); } catch (e) { /* ignore */ }

    try { group.clear(); } catch (e) { /* ignore */ }
  }

  /* =====================================================================
   * Public accessors
   * ================================================================== */

  const _outSunDir = new THREE.Vector3(0, 1, 0);
  const _outMoonDir = new THREE.Vector3(0, 1, 0);
  const _outKeyDir = new THREE.Vector3(0, 1, 0);
  const _outSunColor = new THREE.Color(1, 1, 1);
  const _outFogColor = new THREE.Color(1, 1, 1);
  const _outHazeColor = new THREE.Color(1, 1, 1);
  const _outAmbient = new THREE.Color(1, 1, 1);

  /** Unit vector pointing FROM the world TOWARD the sun. May be below y=0 at night. */
  function getSunDirection(target) {
    const out = target && target.isVector3 ? target : _outSunDir;
    return out.copy(_vSun);
  }

  /** Unit vector toward the moon. */
  function getMoonDirection(target) {
    const out = target && target.isVector3 ? target : _outMoonDir;
    return out.copy(_vMoon);
  }

  /** The direction the key light (sunLight) actually comes from — moon at night. */
  function getKeyLightDirection(target) {
    const out = target && target.isVector3 ? target : _outKeyDir;
    return out.copy(_vKey);
  }

  /** Linear-space colour of the key light (already applied to sunLight.color). */
  function getSunColor(target) {
    const out = target && target.isColor ? target : _outSunColor;
    return out.copy(grading.sun);
  }

  /**
   * Linear-space horizon colour. Assign straight into THREE.Fog / FogExp2 —
   * fog is applied before tone mapping so no colour-space conversion is needed.
   */
  function getFogColor(target) {
    const out = target && target.isColor ? target : _outFogColor;
    return out.copy(grading.fog);
  }

  function getHazeColor(target) {
    const out = target && target.isColor ? target : _outHazeColor;
    return out.copy(grading.haze);
  }

  /** Rough hemispheric ambient radiance — handy for particle / decal tinting. */
  function getAmbientColor(target) {
    const out = target && target.isColor ? target : _outAmbient;
    return out.copy(grading.ambient);
  }

  function getSunElevation() { return Math.asin(clamp(_vSun.y, -1, 1)); }
  function getNightFactor() { return state.night; }
  function getCloudCover() { return state.cover; }
  function getEnvMap() { return pmremRT ? pmremRT.texture : null; }
  function isKeyLightMoon() { return state.keyIsMoon; }

  /** Force the IBL to refresh on the next update (e.g. after a weather jump). */
  function markEnvDirty() { state.envDirty = true; state.envAccum = 1e6; }

  /* ---- first-frame priming so the very first rendered frame is correct ---- */
  try {
    update(options.weather || { condition: 'clear', timeOfDay: options.timeOfDay || 13.5 }, 0.016, null);
    recomputeGrading();
    markEnvDirty();
  } catch (e) { /* ignore */ }

  return {
    update,
    setQuality,
    dispose,

    sunLight,
    fillLight,
    hemiLight,
    skyMesh,

    getSunDirection,
    getSunColor,
    getFogColor,

    // extras
    group,
    starPoints,
    moonMesh,
    cloudMesh,
    getMoonDirection,
    getKeyLightDirection,
    getHazeColor,
    getAmbientColor,
    getSunElevation,
    getNightFactor,
    getCloudCover,
    getEnvMap,
    isKeyLightMoon,
    markEnvDirty,
    get quality() { return quality; },
  };
}

export default createSky;

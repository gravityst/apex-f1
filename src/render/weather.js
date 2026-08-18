/**
 * APEX F1 — src/render/weather.js
 * ---------------------------------------------------------------------------
 * Rain, spray, wet-track visuals and storm atmospherics.
 *
 *  - Camera-following rain volume of stretched, wind-and-speed sheared streaks.
 *  - Cockpit visor droplets (procedural, GPU-side) with speed streaking + wipes.
 *  - Rooster-tail spray thrown from every car's wheels, pooled in one draw call.
 *  - A shared wetness uniform + procedural puddle mask / ripple map that the
 *    track material samples (see `patchTrackMaterial`).
 *  - Lightning flashes with randomised, distance-delayed thunder callbacks.
 *  - Drifting low mist banks that kill visibility in heavy rain.
 *
 * Contract:
 *   createWeather(scene, camera, opts) -> {
 *     update(weatherState, cars, camera, dt),
 *     getWetnessUniform(), getPuddleMask(), triggerLightning(),
 *     setCockpitDroplets(b), dispose(), setQuality(q), ...extras
 *   }
 *
 * Zero side effects at import time. Zero allocations in update().
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';

/* ===========================================================================
 * Module-scope scratch. NEVER allocate inside update().
 * ======================================================================== */

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _prevCam = new THREE.Vector3();
const _camVel = new THREE.Vector3();
const _instVel = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _apparent = new THREE.Vector3();
const _tmpCol = new THREE.Color();
const _UP = new THREE.Vector3(0, 1, 0);

const TAU = Math.PI * 2;

/* ===========================================================================
 * Quality tiers
 * ======================================================================== */

const TIER_PRESETS = {
  low: {
    rain: 1800, spray: 500, mist: 3,
    puddleTex: 256, rippleTex: 128, streakTex: 96, puffTex: 64,
    ripples: false, visorLayers: 1, sprayRate: 0.35,
  },
  medium: {
    rain: 5200, spray: 1200, mist: 5,
    puddleTex: 256, rippleTex: 256, streakTex: 128, puffTex: 96,
    ripples: true, visorLayers: 2, sprayRate: 0.6,
  },
  high: {
    rain: 10000, spray: 2600, mist: 7,
    puddleTex: 512, rippleTex: 256, streakTex: 192, puffTex: 128,
    ripples: true, visorLayers: 3, sprayRate: 1.0,
  },
  ultra: {
    rain: 17000, spray: 4400, mist: 9,
    puddleTex: 512, rippleTex: 512, streakTex: 256, puffTex: 128,
    ripples: true, visorLayers: 3, sprayRate: 1.35,
  },
};

/* Rain simulation volume (camera relative, metres). */
const BOX_HALF_XZ = 30.0;
const BOX_HALF_Y = 18.0;
const BOX_Y_OFFSET = 7.0;

const MAX_CARS = 40;
const SPRAY_CULL_DIST = 300.0;

/* ===========================================================================
 * Small maths helpers
 * ======================================================================== */

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function lerp(a, b, t) { return a + (b - a) * t; }

function smoothstep(e0, e1, x) {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. */
function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Deterministic xorshift32; used both at init and (allocation-free) at runtime. */
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* ---- tileable value noise -------------------------------------------------- */

function hashi(x, y, s) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, y, period, seed) {
  const p = period | 0;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p;
  const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
  const a = hashi(x0, y0, seed), b = hashi(x1, y0, seed);
  const c = hashi(x0, y1, seed), d = hashi(x1, y1, seed);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}

/** u,v in [0,1). Tileable fbm; `period` is the base cell count across the tile. */
function fbm(u, v, period, octaves, seed, gain) {
  const g = gain === undefined ? 0.5 : gain;
  let amp = 1, sum = 0, norm = 0, p = period;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(u * p, v * p, p, seed + i * 1319);
    norm += amp;
    amp *= g;
    p *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/* ===========================================================================
 * Procedural textures (canvas 2D at init, cached, never fetched)
 * ======================================================================== */

function applyTexOpts(tex, o) {
  tex.wrapS = o.wrap || THREE.ClampToEdgeWrapping;
  tex.wrapT = o.wrap || THREE.ClampToEdgeWrapping;
  tex.minFilter = o.mips === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = o.mips !== false;
  tex.colorSpace = o.colorSpace || THREE.LinearSRGBColorSpace;
  tex.anisotropy = o.anisotropy || 1;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a texture from an RGBA byte array. Prefers a canvas 2D context (per the
 * project rules); falls back to a DataTexture if no DOM is present so the module
 * can never hard-crash in a headless context.
 */
function textureFromPixels(w, h, pixels, o) {
  const opts = o || {};
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const cvs = document.createElement('canvas');
      cvs.width = w;
      cvs.height = h;
      const ctx = cvs.getContext('2d', { willReadFrequently: false });
      if (ctx) {
        const img = ctx.createImageData(w, h);
        img.data.set(pixels);
        ctx.putImageData(img, 0, 0);
        const tex = new THREE.CanvasTexture(cvs);
        return applyTexOpts(tex, opts);
      }
    }
  } catch (e) { /* fall through to DataTexture */ }
  const tex = new THREE.DataTexture(pixels, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  return applyTexOpts(tex, opts);
}

/** Elongated rain streak: bright leading head, feathered tail, soft flanks. */
function buildStreakTexture(height) {
  const H = Math.max(48, height | 0);
  const W = Math.max(8, (H / 8) | 0);
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const t = (y + 0.5) / H;                       // 0 = tail, 1 = head
    const shaped = Math.pow(t, 0.68);
    const along = Math.pow(Math.max(0, Math.sin(Math.PI * shaped)), 0.8);
    const head = smoothstep(0.55, 0.98, t);
    for (let x = 0; x < W; x++) {
      const dx = ((x + 0.5) / W) * 2 - 1;
      const across = Math.max(0, 1 - dx * dx);
      const body = along * Math.pow(across, 1.4);
      const core = Math.pow(across, 7) * along;
      const a = clamp01(body * 0.82 + core * 0.55 + head * core * 0.75);
      const lum = clamp01(0.5 + core * 0.55 + head * 0.35);
      const i = (y * W + x) * 4;
      px[i] = (lum * 255) | 0;
      px[i + 1] = (Math.min(1, lum * 1.02) * 255) | 0;
      px[i + 2] = (Math.min(1, lum * 1.12) * 255) | 0;
      px[i + 3] = (a * 255) | 0;
    }
  }
  return textureFromPixels(W, H, px, { mips: true });
}

/** Turbulent soft puff used for wheel spray. */
function buildPuffTexture(size, seed) {
  const S = Math.max(32, size | 0);
  const px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const dx = u - 0.5, dy = v - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const warp = fbm(u, v, 4, 4, seed, 0.55) - 0.5;
      const grain = fbm(u, v, 9, 3, seed + 977, 0.5);
      let a = 1 - smoothstep(0.18, 1.0, d + warp * 0.42);
      a *= 0.42 + 0.85 * grain;
      a *= smoothstep(1.0, 0.72, d);               // hard rim so quads never clip
      a = clamp01(a);
      const lum = clamp01(0.62 + 0.42 * grain + 0.18 * (1 - d));
      const i = (y * S + x) * 4;
      px[i] = (lum * 255) | 0;
      px[i + 1] = (lum * 255) | 0;
      px[i + 2] = (Math.min(1, lum * 1.05) * 255) | 0;
      px[i + 3] = (a * 255) | 0;
    }
  }
  return textureFromPixels(S, S, px, { mips: true });
}

/** Wide, wispy, horizontally-stretched cloud sheet for the low mist banks. */
function buildCloudTexture(size, seed) {
  const S = Math.max(64, size | 0);
  const px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const dx = (u - 0.5) * 1.02, dy = (v - 0.5) * 2.35;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const n1 = fbm(u, v, 3, 5, seed, 0.55);
      const n2 = fbm(u, v, 7, 4, seed + 611, 0.5);
      let a = 1 - smoothstep(0.05, 1.05, d + (n1 - 0.5) * 0.85);
      a *= 0.30 + 0.95 * n2;
      a *= smoothstep(1.05, 0.62, d);
      a = clamp01(a) * 0.9;
      const lum = clamp01(0.66 + 0.3 * n2);
      const i = (y * S + x) * 4;
      px[i] = (lum * 255) | 0;
      px[i + 1] = (lum * 255) | 0;
      px[i + 2] = (Math.min(1, lum * 1.06) * 255) | 0;
      px[i + 3] = (a * 255) | 0;
    }
  }
  return textureFromPixels(S, S, px, { mips: true });
}

/**
 * Puddle / standing-water mask sampled by the track material in world XZ.
 *   R = pooling amount (blobby, low frequency, ridged edges)
 *   G = micro roughness break-up
 *   B = drainage streaking (stretched along one axis)
 *   A = macro wetness variation (kerb run-off, camber shadows)
 */
function buildPuddleMask(size, seed, anisotropy) {
  const S = Math.max(64, size | 0);
  const px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;

      const base = fbm(u, v, 3, 5, seed, 0.58);
      const mid = fbm(u, v, 7, 4, seed + 313, 0.5);
      const fine = fbm(u, v, 19, 3, seed + 727, 0.5);

      let pool = base * 0.62 + mid * 0.28 + fine * 0.10;
      // Ridged remap so puddles get defined shorelines instead of a soft haze.
      pool = smoothstep(0.36, 0.74, pool);
      pool = pool * pool * (3 - 2 * pool);
      // Nibble the shoreline with fine noise so edges are not perfect blobs.
      pool = clamp01(pool - (1 - pool) * (fine - 0.5) * 0.55);

      const micro = fbm(u, v, 23, 3, seed + 1237, 0.5);
      const drain = fbm(u * 1, v * 4, 6, 4, seed + 1889, 0.52);
      const macro = fbm(u, v, 2, 4, seed + 2593, 0.6);

      const i = (y * S + x) * 4;
      px[i] = (clamp01(pool) * 255) | 0;
      px[i + 1] = (clamp01(0.25 + 0.75 * micro) * 255) | 0;
      px[i + 2] = (clamp01(drain) * 255) | 0;
      px[i + 3] = (clamp01(0.35 + 0.65 * macro) * 255) | 0;
    }
  }
  return textureFromPixels(S, S, px, {
    wrap: THREE.RepeatWrapping,
    mips: true,
    anisotropy: anisotropy || 1,
  });
}

/**
 * Rain-ring ripple field (Worley cells).
 *   RG = radial direction from the ring centre, encoded 0..1
 *   B  = normalised radius inside the ring
 *   A  = per-ring random phase
 * The track shader animates this into expanding rings.
 */
function buildRippleMap(size, seed, anisotropy) {
  const S = Math.max(64, size | 0);
  const cells = 7;
  const px = new Uint8Array(S * S * 4);
  const inv = 1 / 0.62;
  for (let y = 0; y < S; y++) {
    const py = ((y + 0.5) / S) * cells;
    const cy = Math.floor(py);
    for (let x = 0; x < S; x++) {
      const pxx = ((x + 0.5) / S) * cells;
      const cx = Math.floor(pxx);

      let best = 1e9, bdx = 0, bdy = 1, phase = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const gy = cy + oy;
        const wy = ((gy % cells) + cells) % cells;
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const wx = ((gx % cells) + cells) % cells;
          const jx = hashi(wx, wy, seed);
          const jy = hashi(wx, wy, seed + 5501);
          const ccx = gx + 0.18 + 0.64 * jx;
          const ccy = gy + 0.18 + 0.64 * jy;
          const dx = pxx - ccx, dy = py - ccy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < best) {
            best = d; bdx = dx; bdy = dy;
            phase = hashi(wx, wy, seed + 9059);
          }
        }
      }
      const inv2 = best > 1e-5 ? 1 / best : 0;
      const nx = bdx * inv2, ny = bdy * inv2;
      const r = clamp01(best * inv);
      const i = (y * S + x) * 4;
      px[i] = ((nx * 0.5 + 0.5) * 255) | 0;
      px[i + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      px[i + 2] = (r * 255) | 0;
      px[i + 3] = (phase * 255) | 0;
    }
  }
  return textureFromPixels(S, S, px, {
    wrap: THREE.RepeatWrapping,
    mips: true,
    anisotropy: anisotropy || 1,
  });
}

/* ===========================================================================
 * Shaders
 * ======================================================================== */

const RAIN_VERT = /* glsl */`
attribute vec3 iPos;   // camera-relative position (metres)
attribute vec3 iSeed;  // x: size, y: alpha, z: velocity jitter

uniform vec3  uRainVel;     // apparent velocity (rain + wind - camera), world space
uniform float uStreakTime;  // virtual shutter time -> streak length
uniform float uWidth;
uniform float uMinLen;
uniform float uMaxLen;
uniform float uNearFade;
uniform float uFarFade;
uniform float uOpacity;

varying vec2  vUv;
varying float vAlpha;

void main() {
  float jit = 0.76 + 0.48 * iSeed.z;
  vec3 vel = uRainVel * jit;

  vec4 mv = modelViewMatrix * vec4( iPos, 1.0 );
  vec3 velView = ( viewMatrix * vec4( vel, 0.0 ) ).xyz;

  float dist = max( 0.001, -mv.z );
  vec3 toCam = normalize( -mv.xyz );

  // Project the velocity onto the billboard plane so the streak always reads
  // as a straight line on screen, however the camera is oriented.
  vec3 d = velView - toCam * dot( velView, toCam );
  float dl = length( d );
  vec3 along = ( dl > 1e-4 ) ? ( d / dl ) : vec3( 0.0, -1.0, 0.0 );
  vec3 sx = cross( along, toCam );
  float sl = length( sx );
  vec3 side = ( sl > 1e-4 ) ? ( sx / sl ) : vec3( 1.0, 0.0, 0.0 );

  float len = clamp( dl * uStreakTime, uMinLen, uMaxLen ) * ( 0.60 + 0.80 * iSeed.x );
  float wid = uWidth * ( 0.55 + 0.90 * iSeed.x ) * ( 1.0 + dist * 0.018 );

  vec3 p = mv.xyz + along * ( position.y * len ) + side * ( position.x * wid );
  gl_Position = projectionMatrix * vec4( p, 1.0 );

  float nf = smoothstep( uNearFade * 0.20, uNearFade, dist );
  float ff = 1.0 - smoothstep( uFarFade * 0.55, uFarFade, dist );

  // Fast streaks read thinner, so lift their alpha to keep density constant.
  float boost = clamp( dl * uStreakTime / max( uMinLen, 0.001 ), 1.0, 2.4 );
  vAlpha = uOpacity * ( 0.42 + 0.78 * iSeed.y ) * nf * ff * mix( 1.0, 0.62, ( boost - 1.0 ) / 1.4 );
  vUv = uv;
}
`;

const RAIN_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;

varying vec2  vUv;
varying float vAlpha;

void main() {
  vec4 t = texture2D( uMap, vUv );
  float a = t.a * vAlpha;
  if ( a < 0.0035 ) discard;
  vec3 c = uColor * ( 0.52 + 0.90 * t.r );
  gl_FragColor = vec4( c, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPRAY_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iData;   // x size, y age01, z alpha, w spin

uniform float uOpacity;
uniform float uFogDensity;

varying vec2  vUv;
varying float vAlpha;
varying float vFog;

void main() {
  vec4 mv = modelViewMatrix * vec4( iPos, 1.0 );

  float s = iData.x;
  float c = cos( iData.w );
  float sn = sin( iData.w );
  vec2 q = vec2( position.x * c - position.y * sn, position.x * sn + position.y * c ) * s;
  mv.xy += q;

  gl_Position = projectionMatrix * mv;

  float age = clamp( iData.y, 0.0, 1.0 );
  float fadeIn = smoothstep( 0.0, 0.11, age );
  float fadeOut = pow( max( 0.0, 1.0 - age ), 1.45 );

  float dist = max( 0.0, -mv.z );
  // Kill the puff before it clips through the near plane / the driver's head.
  float nearFade = smoothstep( 0.35, 1.6, dist );

  vAlpha = uOpacity * iData.z * fadeIn * fadeOut * nearFade;
  vFog = 1.0 - exp( -uFogDensity * dist );
  vUv = uv;
}
`;

const SPRAY_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3  uColor;
uniform vec3  uFogColor;
uniform float uLight;

varying vec2  vUv;
varying float vAlpha;
varying float vFog;

void main() {
  vec4 t = texture2D( uMap, vUv );
  float a = t.a * vAlpha;
  if ( a < 0.004 ) discard;
  vec3 c = uColor * uLight * ( 0.70 + 0.58 * t.r );
  c = mix( c, uFogColor, clamp( vFog, 0.0, 1.0 ) );
  gl_FragColor = vec4( c, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const MIST_VERT = /* glsl */`
uniform float uFogDensity;

varying vec2  vUv;
varying float vFog;
varying float vNear;

void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  float dist = max( 0.0, -mv.z );
  vFog = 1.0 - exp( -uFogDensity * dist );
  vNear = smoothstep( 1.5, 16.0, dist );
  vUv = uv;
}
`;

const MIST_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3  uColor;
uniform vec3  uFogColor;
uniform float uOpacity;
uniform float uLight;

varying vec2  vUv;
varying float vFog;
varying float vNear;

void main() {
  vec4 t = texture2D( uMap, vUv );
  float a = t.a * uOpacity * vNear;
  if ( a < 0.003 ) discard;
  vec3 c = uColor * uLight * ( 0.72 + 0.42 * t.r );
  c = mix( c, uFogColor, clamp( vFog * 0.85, 0.0, 1.0 ) );
  gl_FragColor = vec4( c, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const VISOR_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const VISOR_FRAG = /* glsl */`
uniform float uTime;
uniform float uSpeed;      // 0..1 normalised airspeed -> streak strength
uniform float uIntensity;  // 0..1 droplet coverage
uniform float uOpacity;
uniform float uWipe;       // <0 idle, else 0..1 sweep progress
uniform float uClean;      // 0..1 residual cleanliness after a wipe
uniform float uAspect;
uniform float uLight;
uniform vec3  uTint;

varying vec2 vUv;

float hash21( vec2 p ) {
  p = fract( p * vec2( 233.34, 851.73 ) );
  p += dot( p, p + 23.45 );
  return fract( p.x * p.y );
}

// One droplet layer. Returns ( bead+trail mask, specular highlight ).
vec2 dropLayer( vec2 uv, float t, float scale, float streak, float seed ) {
  uv *= scale;
  uv.y += seed * 3.17;

  vec2 id = floor( uv );
  vec2 gv = fract( uv ) - 0.5;

  float n  = hash21( id + seed );
  float n2 = hash21( id + seed + 17.77 );
  float n3 = hash21( id + seed + 41.31 );

  float present = step( 1.0 - clamp( uIntensity * 1.2, 0.0, 1.0 ), n3 );
  if ( present < 0.5 ) return vec2( 0.0 );

  // Airflow drives the beads UP the visor; faster car -> faster, longer runners.
  float spd = ( 0.09 + 0.42 * n2 ) * ( 0.30 + 2.4 * streak );
  float f = fract( n * 7.31 + t * spd );
  float py = -0.5 + f;
  float fade = sin( f * 3.14159265 );

  float px = ( n2 - 0.5 ) * 0.60 + sin( t * ( 0.6 + n ) + n * 6.2831 ) * 0.035;

  float r = ( 0.052 + 0.105 * n ) * ( 0.55 + 0.70 * uIntensity );

  vec2 q = ( gv - vec2( px, py ) ) * vec2( 1.0, 0.88 / ( 1.0 + 1.05 * streak ) );
  float d = length( q );
  float bead = smoothstep( r, r * 0.26, d );

  float tl = ( 0.16 + 0.62 * streak ) * ( 0.45 + n2 );
  float ty = clamp( ( py - gv.y ) / max( tl, 0.001 ), 0.0, 1.0 );
  float tw = r * ( 0.60 - 0.48 * ty );
  float trail = smoothstep( tw, 0.0, abs( gv.x - px ) ) * ( 1.0 - ty ) * step( 0.0, py - gv.y );

  float mask = max( bead, trail * ( 0.30 + 0.55 * streak ) ) * fade;

  vec2 hp = vec2( px + r * 0.30, py + r * 0.32 );
  float hi = smoothstep( r * 1.05, r * 0.30, length( ( gv - hp ) * vec2( 1.0, 0.86 ) ) );
  hi *= bead * fade;

  return vec2( mask, hi );
}

void main() {
  vec2 uv = vUv - 0.5;
  uv.x *= uAspect;

  float streak = clamp( uSpeed, 0.0, 1.0 );

  vec2 a = dropLayer( uv, uTime, 7.0, streak, 0.0 );
  float mask = a.x;
  float hi = a.y;

  #if VISOR_LAYERS > 1
    vec2 b = dropLayer( uv * 1.63 + vec2( 3.7, 1.1 ), uTime * 1.21, 11.0, streak * 0.78, 5.31 );
    mask = max( mask, b.x * 0.86 );
    hi = max( hi, b.y * 0.80 );
  #endif
  #if VISOR_LAYERS > 2
    vec2 c = dropLayer( uv * 2.71 + vec2( -2.1, 4.4 ), uTime * 0.63, 17.0, streak * 0.34, 11.93 );
    mask = max( mask, c.x * 0.60 );
    hi = max( hi, c.y * 0.55 );
  #endif

  // Hand / tear-off wipe: a diagonal blade that clears everything behind it and
  // leaves a thin optical smear at its edge.
  float band = 1.0;
  float smear = 0.0;
  if ( uWipe >= 0.0 ) {
    float sd = uv.x * 0.93 + uv.y * 0.36;
    float bx = mix( -1.35, 1.45, uWipe );
    float s = sd - bx;
    band = smoothstep( -0.11, 0.02, s );
    smear = smoothstep( 0.17, 0.0, abs( s ) ) * ( 1.0 - band );
  }

  float wiped = ( 1.0 - band ) + uClean;
  wiped = clamp( wiped, 0.0, 1.0 );
  mask *= mix( 1.0, 0.06, wiped );
  hi *= mix( 1.0, 0.10, wiped );

  float film = smear * 0.30;
  float alpha = clamp( mask * 0.52 + hi * 0.92 + film, 0.0, 1.0 ) * uOpacity;
  if ( alpha < 0.004 ) discard;

  vec3 col = uTint * uLight * ( 0.48 + 0.95 * hi + 0.22 * mask + 0.6 * film );
  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* --- injected into the track material by patchTrackMaterial() -------------- */

const WET_PARS_VERT = /* glsl */`
varying vec3 vApexWorld;
`;

const WET_BODY_VERT = /* glsl */`
vApexWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const WET_PARS_FRAG = /* glsl */`
uniform float     uApexWetness;
uniform float     uApexPuddleLevel;
uniform float     uApexPuddleScale;
uniform float     uApexRain;
uniform float     uApexTime;
uniform float     uApexRippleScale;
uniform float     uApexRippleStrength;
uniform float     uApexDarken;
uniform vec3      uApexWaterTint;
uniform sampler2D uApexPuddleMask;
uniform sampler2D uApexRippleMap;

varying vec3 vApexWorld;
`;

const WET_MAP_FRAG = /* glsl */`
  float apexWet = clamp( uApexWetness, 0.0, 1.0 );
  float apexPuddle = 0.0;
  float apexSheen = 0.0;
  vec2  apexRip = vec2( 0.0 );

  if ( apexWet > 0.001 ) {
    vec4 apexPm = texture2D( uApexPuddleMask, vApexWorld.xz * uApexPuddleScale );
    float apexPl = clamp( uApexPuddleLevel, 0.0, 1.0 );
    apexPuddle = smoothstep( 1.0 - apexPl * 0.95 - 0.02, 1.0 - apexPl * 0.95 + 0.24, apexPm.r ) * apexWet;
    // Drainage streaks stay damp long after the racing line dries out.
    apexSheen = apexWet * mix( 0.55, 1.0, apexPm.a ) + apexPm.b * apexWet * 0.25;
    apexSheen = clamp( apexSheen, 0.0, 1.0 );

    #ifdef APEX_RIPPLES
      float apexRain = clamp( uApexRain, 0.0, 1.0 );
      if ( apexRain > 0.004 ) {
        vec4 r1 = texture2D( uApexRippleMap, vApexWorld.xz * uApexRippleScale );
        float w1 = sin( r1.b * 21.0 - uApexTime * 11.0 + r1.a * 6.2831853 );
        w1 *= ( 1.0 - r1.b ) * ( 1.0 - r1.b );
        apexRip += ( r1.rg * 2.0 - 1.0 ) * w1;

        vec4 r2 = texture2D( uApexRippleMap, vApexWorld.zx * uApexRippleScale * 1.83 + vec2( 0.37, 0.61 ) );
        float w2 = sin( r2.b * 21.0 - uApexTime * 13.9 + r2.a * 6.2831853 );
        w2 *= ( 1.0 - r2.b ) * ( 1.0 - r2.b );
        apexRip += ( r2.rg * 2.0 - 1.0 ) * w2 * 0.68;

        apexRip *= apexRain * uApexRippleStrength * mix( 0.22, 1.0, apexPuddle );
      }
    #endif

    // Wet asphalt goes dark and slightly cool; standing water goes darker still.
    float darkenAmount = uApexDarken * apexSheen;
    diffuseColor.rgb *= mix( 1.0, 0.46, darkenAmount );
    diffuseColor.rgb *= mix( 1.0, 0.24, apexPuddle );
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uApexWaterTint, 0.55 * apexSheen );
  }
`;

const WET_ROUGH_FRAG = /* glsl */`
  if ( apexWet > 0.001 ) {
    roughnessFactor = mix( roughnessFactor, 0.10, apexSheen * 0.78 );
    roughnessFactor = mix( roughnessFactor, 0.035, apexPuddle );
    roughnessFactor = clamp( roughnessFactor + length( apexRip ) * 0.22, 0.02, 1.0 );
  }
`;

const WET_NORMAL_FRAG = /* glsl */`
  if ( apexWet > 0.001 ) {
    // Flatten the asphalt micro-relief under water, then stamp in rain rings.
    vec3 apexFlat = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    normal = normalize( mix( normal, apexFlat, apexPuddle * 0.65 ) );
    vec3 apexWX = viewMatrix[ 0 ].xyz;
    vec3 apexWZ = viewMatrix[ 2 ].xyz;
    normal = normalize( normal + ( apexWX * apexRip.x + apexWZ * apexRip.y ) * 0.55 );
  }
`;

const WET_CLEARCOAT_NORMAL_FRAG = /* glsl */`
  #ifdef USE_CLEARCOAT
    if ( apexWet > 0.001 ) {
      // The water film is its own smooth layer sitting on top of the asphalt.
      vec3 apexCcFlat = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
      clearcoatNormal = normalize( mix( clearcoatNormal, apexCcFlat, apexSheen * 0.55 + apexPuddle * 0.40 ) );
      clearcoatNormal = normalize( clearcoatNormal + ( viewMatrix[ 0 ].xyz * apexRip.x + viewMatrix[ 2 ].xyz * apexRip.y ) * 0.80 );
    }
  #endif
`;

const WET_CLEARCOAT_FRAG = /* glsl */`
  #ifdef USE_CLEARCOAT
    if ( apexWet > 0.001 ) {
      material.clearcoat = clamp( mix( material.clearcoat, 1.0, apexSheen * 0.85 ), 0.0, 1.0 );
      material.clearcoatRoughness = clamp( mix( material.clearcoatRoughness, 0.045, apexPuddle ), 0.0, 1.0 );
    }
  #endif
`;

/* ===========================================================================
 * Factory
 * ======================================================================== */

const _quatA = new THREE.Quaternion();
const _EMPTY_STATE = {
  condition: 'clear', rainIntensity: 0, trackWetness: 0, puddles: 0,
  windSpeed: 0, windDir: 0, temperature: 22, trackTemp: 30, timeOfDay: 13,
};

function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

/**
 * @param {THREE.Scene}  scene
 * @param {THREE.Camera} camera
 * @param {Object} [opts]
 *   onThunder      fn(delaySeconds)  called the instant lightning strikes
 *   quality        quality tier object or tier string
 *   seed           deterministic seed for textures / particle jitter
 *   cockpitDroplets  start with visor droplets enabled (default false)
 *   autoLightning  auto-strike during 'storm' (default true)
 *   visorDistance  metres in front of the camera for the droplet plane (0.32)
 *   lightningLight an existing THREE.Light to drive instead of creating one
 *   createLight    set false to never create a lightning light
 *   manageFog      set true to let the module drive scene.fog density
 */
export function createWeather(scene, camera, opts) {
  const options = opts || {};
  const onThunder = typeof options.onThunder === 'function' ? options.onThunder : null;
  const seed = (options.seed | 0) || 0x51ed270b;
  const rndInit = makeRng(seed);
  const rnd = makeRng(seed ^ 0x2545f491);

  let disposed = false;
  let enabled = options.enabled !== false;
  let cockpitDroplets = options.cockpitDroplets === true;
  const autoLightning = options.autoLightning !== false;
  const manageFog = options.manageFog === true;
  const visorDistance = num(options.visorDistance, 0.32);

  /* ---- quality ---------------------------------------------------------- */

  function resolveQuality(q) {
    let tier = 'high', particles = 1, aniso = 4;
    if (typeof q === 'string') {
      tier = q;
    } else if (q && typeof q === 'object') {
      if (typeof q.tier === 'string') tier = q.tier;
      if (typeof q.particles === 'number' && isFinite(q.particles)) particles = q.particles;
      if (typeof q.anisotropy === 'number' && isFinite(q.anisotropy)) aniso = q.anisotropy;
    }
    if (!TIER_PRESETS[tier]) tier = 'high';
    return {
      tier,
      particles: clamp(particles, 0.05, 2.0),
      anisotropy: clamp(aniso | 0, 1, 16),
    };
  }

  let quality = resolveQuality(options.quality);
  let preset = TIER_PRESETS[quality.tier];

  /* ---- root ------------------------------------------------------------- */

  const group = new THREE.Group();
  group.name = 'ApexWeather';
  group.frustumCulled = false;
  try { if (scene && scene.add) scene.add(group); } catch (e) { /* headless */ }

  /* ---- textures (built once; references stay stable for bound materials) -- */

  let texStreak = null, texPuff = null, texCloud = null, texPuddle = null, texRipple = null;
  try { texStreak = buildStreakTexture(preset.streakTex); } catch (e) { texStreak = null; }
  try { texPuff = buildPuffTexture(preset.puffTex, seed + 11); } catch (e) { texPuff = null; }
  try { texCloud = buildCloudTexture(Math.max(128, preset.puffTex * 2), seed + 29); } catch (e) { texCloud = null; }
  try { texPuddle = buildPuddleMask(preset.puddleTex, seed + 53, quality.anisotropy); } catch (e) { texPuddle = null; }
  try { texRipple = buildRippleMap(preset.rippleTex, seed + 97, quality.anisotropy); } catch (e) { texRipple = null; }

  /* ---- shared uniforms exposed to the track material -------------------- */

  const shared = {
    uApexWetness: { value: 0 },
    uApexPuddleLevel: { value: 0 },
    uApexPuddleScale: { value: num(options.puddleScale, 0.035) },
    uApexRain: { value: 0 },
    uApexTime: { value: 0 },
    uApexRippleScale: { value: num(options.rippleScale, 0.32) },
    uApexRippleStrength: { value: num(options.rippleStrength, 0.55) },
    uApexDarken: { value: num(options.wetDarken, 1.0) },
    uApexWaterTint: { value: new THREE.Color(0.72, 0.79, 0.92) },
    uApexPuddleMask: { value: texPuddle },
    uApexRippleMap: { value: texRipple },
  };

  /* ---- runtime state ---------------------------------------------------- */

  let elapsed = 0;
  let firstFrame = true;
  let flashStrength = 0;
  let lightLevel = 1;
  let mistAmount = 0;
  let sprayLoad = 0;
  let visibility = 1;
  let lastError = null;

  const FLASH_MAX = 6;
  const flashT = new Float32Array(FLASH_MAX);
  const flashA = new Float32Array(FLASH_MAX);
  const flashD = new Float32Array(FLASH_MAX);
  let flashN = 0;
  let nextStrike = 5 + rnd() * 14;

  const fogColor = new THREE.Color(0.52, 0.56, 0.62);

  /* ---- lightning light -------------------------------------------------- */

  let lightningLight = null;
  let ownsLight = false;
  try {
    if (options.lightningLight && options.lightningLight.isLight) {
      lightningLight = options.lightningLight;
    } else if (options.createLight !== false) {
      lightningLight = new THREE.DirectionalLight(0xd6e2ff, 0);
      lightningLight.name = 'ApexLightning';
      lightningLight.position.set(120, 260, -180);
      lightningLight.castShadow = false;
      ownsLight = true;
      group.add(lightningLight);
      group.add(lightningLight.target);
    }
  } catch (e) { lightningLight = null; }
  const flashPeak = num(options.flashIntensity, 9.0);

  /* =========================================================================
   * RAIN
   * ====================================================================== */

  const rain = {
    mesh: null, geo: null, mat: null,
    cap: 0, active: 0,
    pos: null, seedArr: null, posAttr: null,
    range: { start: 0, count: 0 },
    ok: false, errors: 0,
  };

  function makeQuadGeometry() {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    geo.instanceCount = 0;
    return geo;
  }

  function seedRainRange(from, to) {
    const pos = rain.pos;
    for (let i = from; i < to; i++) {
      const i3 = i * 3;
      pos[i3] = (rndInit() * 2 - 1) * BOX_HALF_XZ;
      pos[i3 + 1] = (rndInit() * 2 - 1) * BOX_HALF_Y;
      pos[i3 + 2] = (rndInit() * 2 - 1) * BOX_HALF_XZ;
    }
  }

  function allocRain(cap) {
    const geo = makeQuadGeometry();
    const pos = new Float32Array(cap * 3);
    const sd = new Float32Array(cap * 3);
    for (let i = 0; i < cap; i++) {
      const i3 = i * 3;
      sd[i3] = rndInit();
      sd[i3 + 1] = rndInit();
      sd[i3 + 2] = rndInit();
    }
    const posAttr = new THREE.InstancedBufferAttribute(pos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', posAttr);
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(sd, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), BOX_HALF_XZ * 2.2);

    rain.geo = geo;
    rain.pos = pos;
    rain.seedArr = sd;
    rain.posAttr = posAttr;
    rain.cap = cap;
    rain.active = 0;
    seedRainRange(0, cap);
    return geo;
  }

  try {
    const cap = Math.max(256, Math.round(preset.rain * quality.particles));
    const geo = allocRain(cap);
    rain.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texStreak },
        uColor: { value: new THREE.Color(0.55, 0.65, 0.80) },
        uRainVel: { value: new THREE.Vector3(0, -14, 0) },
        uStreakTime: { value: num(options.streakTime, 0.030) },
        uWidth: { value: num(options.rainWidth, 0.021) },
        uMinLen: { value: 0.11 },
        uMaxLen: { value: 8.0 },
        uNearFade: { value: 1.15 },
        uFarFade: { value: BOX_HALF_XZ * 0.98 },
        uOpacity: { value: 0 },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    rain.mesh = new THREE.Mesh(geo, rain.mat);
    rain.mesh.name = 'ApexRain';
    rain.mesh.frustumCulled = false;
    rain.mesh.matrixAutoUpdate = false;
    rain.mesh.renderOrder = 7000;
    rain.mesh.visible = false;
    group.add(rain.mesh);
    rain.ok = true;
  } catch (e) {
    lastError = e;
    rain.ok = false;
  }

  /* =========================================================================
   * SPRAY
   * ====================================================================== */

  const spray = {
    mesh: null, geo: null, mat: null,
    cap: 0, alive: 0,
    pos: null, data: null, vel: null,
    age: null, life: null, s0: null, s1: null, spinRate: null,
    posAttr: null, dataAttr: null,
    posRange: { start: 0, count: 0 },
    dataRange: { start: 0, count: 0 },
    ok: false, errors: 0,
  };

  const emitAcc = new Float32Array(MAX_CARS);

  function allocSpray(cap) {
    const geo = makeQuadGeometry();
    const pos = new Float32Array(cap * 3);
    const data = new Float32Array(cap * 4);
    const posAttr = new THREE.InstancedBufferAttribute(pos, 3);
    const dataAttr = new THREE.InstancedBufferAttribute(data, 4);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    dataAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', posAttr);
    geo.setAttribute('iData', dataAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

    spray.geo = geo;
    spray.posAttr = posAttr;
    spray.dataAttr = dataAttr;
    spray.pos = pos;
    spray.data = data;
    spray.vel = new Float32Array(cap * 3);
    spray.age = new Float32Array(cap);
    spray.life = new Float32Array(cap);
    spray.s0 = new Float32Array(cap);
    spray.s1 = new Float32Array(cap);
    spray.spinRate = new Float32Array(cap);
    spray.cap = cap;
    spray.alive = 0;
    return geo;
  }

  try {
    const cap = Math.max(128, Math.round(preset.spray * quality.particles));
    const geo = allocSpray(cap);
    spray.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texPuff },
        uColor: { value: new THREE.Color(0.86, 0.89, 0.95) },
        uFogColor: { value: new THREE.Color(0.52, 0.56, 0.62) },
        uLight: { value: 1 },
        uOpacity: { value: 0.85 },
        uFogDensity: { value: 0.0035 },
      },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    spray.mesh = new THREE.Mesh(geo, spray.mat);
    spray.mesh.name = 'ApexSpray';
    spray.mesh.frustumCulled = false;
    spray.mesh.matrixAutoUpdate = false;
    spray.mesh.renderOrder = 6800;
    spray.mesh.visible = false;
    group.add(spray.mesh);
    spray.ok = true;
  } catch (e) {
    lastError = e;
    spray.ok = false;
  }

  /* =========================================================================
   * MIST BANKS
   * ====================================================================== */

  const mist = {
    group: null, geo: null, mat: null,
    meshes: null, rel: null, drift: null,
    radius: 95, groundY: 0, ok: false, errors: 0,
  };

  try {
    // Always allocate the ultra bank count (9 cheap quads sharing one material)
    // so raising the quality tier later never has to reallocate.
    const count = Math.max(0, TIER_PRESETS.ultra.mist);
    mist.group = new THREE.Group();
    mist.group.name = 'ApexMist';
    mist.geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    mist.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texCloud },
        uColor: { value: new THREE.Color(0.80, 0.83, 0.88) },
        uFogColor: { value: new THREE.Color(0.52, 0.56, 0.62) },
        uOpacity: { value: 0 },
        uLight: { value: 1 },
        uFogDensity: { value: 0.0045 },
      },
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    mist.meshes = [];
    mist.rel = new Float32Array(count * 3);
    mist.drift = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(mist.geo, mist.mat);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = 6000;
      const ang = (i / count) * TAU + rndInit() * 0.9;
      const rad = 26 + rndInit() * 62;
      mist.rel[i * 3] = Math.cos(ang) * rad;
      mist.rel[i * 3 + 1] = 2.2 + rndInit() * 7.5;
      mist.rel[i * 3 + 2] = Math.sin(ang) * rad;
      mist.drift[i * 2] = 0.55 + rndInit() * 0.9;
      mist.drift[i * 2 + 1] = rndInit();
      const w = 46 + rndInit() * 74;
      const h = 9 + rndInit() * 15;
      m.scale.set(rndInit() < 0.5 ? -w : w, h, 1);
      m.updateMatrix();
      mist.meshes.push(m);
      mist.group.add(m);
    }
    mist.group.visible = false;
    group.add(mist.group);
    mist.ok = count > 0;
  } catch (e) {
    lastError = e;
    mist.ok = false;
  }

  /* =========================================================================
   * VISOR DROPLETS
   * ====================================================================== */

  const visor = {
    mesh: null, geo: null, mat: null,
    wipeT: -1, wipeSpeed: 2.7, clean: 0,
    nextWipe: 3 + rnd() * 5,
    speedNorm: 0,
    ok: false, errors: 0,
  };

  try {
    visor.geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    visor.mat = new THREE.ShaderMaterial({
      defines: { VISOR_LAYERS: Math.max(1, preset.visorLayers | 0) },
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: 0 },
        uIntensity: { value: 0 },
        uOpacity: { value: 0 },
        uWipe: { value: -1 },
        uClean: { value: 0 },
        uAspect: { value: 1.7778 },
        uLight: { value: 1 },
        uTint: { value: new THREE.Color(0.80, 0.86, 0.96) },
      },
      vertexShader: VISOR_VERT,
      fragmentShader: VISOR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    visor.mesh = new THREE.Mesh(visor.geo, visor.mat);
    visor.mesh.name = 'ApexVisor';
    visor.mesh.frustumCulled = false;
    visor.mesh.matrixAutoUpdate = false;
    visor.mesh.renderOrder = 9990;
    visor.mesh.visible = false;
    group.add(visor.mesh);
    visor.ok = true;
  } catch (e) {
    lastError = e;
    visor.ok = false;
  }

  /* runtime capacity limits (changed by setQuality without reallocating) */
  rain.limit = rain.cap;
  spray.limit = spray.cap;
  mist.limit = mist.ok ? Math.min(mist.meshes.length, preset.mist) : 0;
  let ripplesOn = preset.ripples;

  /* =========================================================================
   * Lightning
   * ====================================================================== */

  function triggerLightning() {
    if (disposed) return;
    try {
      const n = 2 + ((rnd() * 3) | 0);
      flashN = Math.min(FLASH_MAX, n);
      let delay = 0;
      for (let i = 0; i < flashN; i++) {
        flashT[i] = -delay;
        flashA[i] = (i === 0) ? 1.15 : (0.30 + rnd() * 0.65);
        flashD[i] = 0.085 + rnd() * 0.24;
        delay += 0.035 + rnd() * 0.16;
      }
      if (lightningLight && ownsLight) {
        const a = rnd() * TAU;
        const e = 0.40 + rnd() * 0.75;
        const ce = Math.cos(e), r = 420;
        lightningLight.position.set(Math.cos(a) * ce * r, Math.sin(e) * r + 140, Math.sin(a) * ce * r);
        if (lightningLight.target) lightningLight.target.position.set(0, 0, 0);
      }
      if (onThunder) {
        // Sound lags light: 343 m/s. Near strikes crack, distant ones rumble.
        const distance = 240 + rnd() * rnd() * 4600;
        onThunder(distance / 343);
      }
    } catch (e) { lastError = e; }
  }

  function updateFlash(dt) {
    if (flashN === 0) {
      if (flashStrength !== 0) {
        flashStrength = 0;
        if (lightningLight) lightningLight.intensity = 0;
      }
      return;
    }
    let f = 0;
    let alive = false;
    for (let i = 0; i < flashN; i++) {
      flashT[i] += dt;
      const t = flashT[i];
      if (t < 0) { alive = true; continue; }
      const k = t / flashD[i];
      if (k >= 1) continue;
      alive = true;
      const env = Math.pow(1 - k, 1.6);
      const flicker = 0.74 + 0.26 * Math.sin(k * 31.0 + i * 2.13);
      f += flashA[i] * env * flicker;
    }
    if (!alive) flashN = 0;
    flashStrength = clamp(f, 0, 2);
    if (lightningLight) lightningLight.intensity = flashStrength * flashPeak;
  }

  /* =========================================================================
   * Rain
   * ====================================================================== */

  function updateRain(dt, intensity, windSpeed, windDir) {
    if (!rain.ok || rain.errors > 8) return;
    const mesh = rain.mesh;
    if (!enabled || intensity <= 0.004) {
      mesh.visible = false;
      rain.geo.instanceCount = 0;
      return;
    }
    mesh.visible = true;

    const limit = Math.min(rain.cap, rain.limit);
    const target = Math.max(1, Math.min(limit, Math.round(limit * Math.pow(intensity, 0.70))));
    if (target > rain.active) seedRainRange(rain.active, target);
    rain.active = target;

    // Apparent velocity = fall + wind - camera. Subtracting the camera velocity
    // is what shears the rain toward the driver at 300 km/h.
    const fall = -(8.5 + 13.0 * intensity);
    _wind.set(Math.sin(windDir) * windSpeed, 0, Math.cos(windDir) * windSpeed);
    _apparent.copy(_wind);
    _apparent.y += fall;
    _apparent.sub(_camVel);

    const u = rain.mat.uniforms;
    u.uRainVel.value.copy(_apparent);

    const ax = _apparent.x * dt, ay = _apparent.y * dt, az = _apparent.z * dt;
    const pos = rain.pos, sd = rain.seedArr;
    const hx = BOX_HALF_XZ, hy = BOX_HALF_Y;
    const sx = hx * 2, sy = hy * 2;

    for (let i = 0; i < target; i++) {
      const i3 = i * 3;
      const jit = 0.76 + 0.48 * sd[i3 + 2];
      let x = pos[i3] + ax * jit;
      let y = pos[i3 + 1] + ay * jit;
      let z = pos[i3 + 2] + az * jit;
      if (x > hx || x < -hx) x = (((x + hx) % sx) + sx) % sx - hx;
      if (y > hy || y < -hy) y = (((y + hy) % sy) + sy) % sy - hy;
      if (z > hx || z < -hx) z = (((z + hx) % sx) + sx) % sx - hx;
      pos[i3] = x;
      pos[i3 + 1] = y;
      pos[i3 + 2] = z;
    }

    rain.range.start = 0;
    rain.range.count = target * 3;
    rain.posAttr.updateRanges.length = 0;
    rain.posAttr.updateRanges.push(rain.range);
    rain.posAttr.needsUpdate = true;
    rain.geo.instanceCount = target;

    const shade = clamp01(0.30 + 0.70 * lightLevel) + flashStrength * 0.8;
    u.uOpacity.value = Math.pow(intensity, 0.62) * num(options.rainOpacity, 0.55) * clamp(shade, 0.12, 2.2);
    const c = u.uColor.value;
    c.setRGB(
      lerp(0.16, 0.56, clamp01(lightLevel)) + flashStrength * 0.5,
      lerp(0.19, 0.66, clamp01(lightLevel)) + flashStrength * 0.5,
      lerp(0.26, 0.82, clamp01(lightLevel)) + flashStrength * 0.5
    );

    mesh.position.set(_camPos.x, _camPos.y + BOX_Y_OFFSET, _camPos.z);
    mesh.updateMatrix();
  }

  /* =========================================================================
   * Spray
   * ====================================================================== */

  function emitSpray(x, y, z, vx, vy, vz, s0, s1, life, alpha) {
    if (spray.alive >= spray.limit) return false;
    const i = spray.alive++;
    const i3 = i * 3, i4 = i * 4;
    spray.pos[i3] = x; spray.pos[i3 + 1] = y; spray.pos[i3 + 2] = z;
    spray.vel[i3] = vx; spray.vel[i3 + 1] = vy; spray.vel[i3 + 2] = vz;
    spray.age[i] = 0;
    spray.life[i] = life;
    spray.s0[i] = s0;
    spray.s1[i] = s1;
    spray.spinRate[i] = (rnd() - 0.5) * 1.8;
    spray.data[i4] = s0;
    spray.data[i4 + 1] = 0;
    spray.data[i4 + 2] = alpha;
    spray.data[i4 + 3] = rnd() * TAU;
    return true;
  }

  function killSpray(i) {
    const last = --spray.alive;
    if (last === i) return;
    const a3 = i * 3, b3 = last * 3, a4 = i * 4, b4 = last * 4;
    const pos = spray.pos, vel = spray.vel, data = spray.data;
    pos[a3] = pos[b3]; pos[a3 + 1] = pos[b3 + 1]; pos[a3 + 2] = pos[b3 + 2];
    vel[a3] = vel[b3]; vel[a3 + 1] = vel[b3 + 1]; vel[a3 + 2] = vel[b3 + 2];
    data[a4] = data[b4]; data[a4 + 1] = data[b4 + 1];
    data[a4 + 2] = data[b4 + 2]; data[a4 + 3] = data[b4 + 3];
    spray.age[i] = spray.age[last];
    spray.life[i] = spray.life[last];
    spray.s0[i] = spray.s0[last];
    spray.s1[i] = spray.s1[last];
    spray.spinRate[i] = spray.spinRate[last];
  }

  function updateSpray(dt, cars, wetness, intensity, windX, windZ) {
    if (!spray.ok || spray.errors > 8) return;
    if (!enabled) {
      spray.mesh.visible = false;
      spray.geo.instanceCount = 0;
      spray.alive = 0;
      return;
    }

    const pos = spray.pos, vel = spray.vel, data = spray.data;
    const drag = 1 - Math.exp(-2.05 * dt);
    const cullSq = SPRAY_CULL_DIST * SPRAY_CULL_DIST;
    const cx = _camPos.x, cy = _camPos.y, cz = _camPos.z;

    /* --- integrate + retire ------------------------------------------- */
    let i = 0;
    while (i < spray.alive) {
      const i3 = i * 3, i4 = i * 4;
      const life = spray.life[i];
      const age = spray.age[i] + dt;
      if (age >= life) { killSpray(i); continue; }
      spray.age[i] = age;
      const t = age / life;

      let vx = vel[i3], vy = vel[i3 + 1], vz = vel[i3 + 2];
      vx += (windX - vx) * drag;
      vz += (windZ - vz) * drag;
      vy -= vy * drag * 0.85;
      vy += (0.42 - 2.35 * t) * dt;   // brief lift, then the mist settles out
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;

      const x = pos[i3] + vx * dt;
      const y = pos[i3 + 1] + vy * dt;
      const z = pos[i3 + 2] + vz * dt;
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;

      const dx = x - cx, dy = y - cy, dz = z - cz;
      if (dx * dx + dy * dy + dz * dz > cullSq) { killSpray(i); continue; }

      const e = t * t * (3 - 2 * t);
      data[i4] = spray.s0[i] + (spray.s1[i] - spray.s0[i]) * e;
      data[i4 + 1] = t;
      data[i4 + 3] += spray.spinRate[i] * dt;
      i++;
    }

    /* --- emission ------------------------------------------------------ */
    if (wetness > 0.015 && cars && cars.length) {
      const n = Math.min(cars.length | 0, MAX_CARS);
      const rateScale = preset.sprayRate * clamp(quality.particles, 0.1, 2.0);
      const wetBoost = 0.55 + 0.75 * wetness + 0.35 * intensity;

      for (let ci = 0; ci < n; ci++) {
        const car = cars[ci];
        if (!car || !car.position) { emitAcc[ci] = 0; continue; }
        const p = car.position;
        const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 260 * 260) { emitAcc[ci] = 0; continue; }

        let speed = num(car.speed, NaN);
        if (!isFinite(speed)) speed = car.velocity ? car.velocity.length() : 0;
        if (speed < 5.5) { emitAcc[ci] = 0; continue; }

        const speedF = clamp01((speed - 5.5) / 42);
        const prox = 1 / (1 + d2 / 5400);
        let rate = 120 * speedF * wetness * wetBoost * (0.30 + 0.90 * prox) * rateScale;
        if (rate <= 0) { emitAcc[ci] = 0; continue; }

        emitAcc[ci] += rate * dt;
        let count = emitAcc[ci] | 0;
        if (count > 26) count = 26;
        if (count <= 0) continue;
        emitAcc[ci] -= count;

        // Car basis
        if (car.quaternion && car.quaternion.isQuaternion) {
          _fwd.set(0, 0, 1).applyQuaternion(car.quaternion);
        } else if (car.velocity && car.velocity.lengthSq() > 1e-4) {
          _fwd.copy(car.velocity).normalize();
        } else {
          _fwd.set(0, 0, 1);
        }
        _rgt.crossVectors(_fwd, _UP);
        if (_rgt.lengthSq() < 1e-6) _rgt.set(1, 0, 0); else _rgt.normalize();

        const vel0x = car.velocity ? car.velocity.x : _fwd.x * speed;
        const vel0y = car.velocity ? car.velocity.y : 0;
        const vel0z = car.velocity ? car.velocity.z : _fwd.z * speed;

        const wheels = car.wheels;
        for (let k = 0; k < count; k++) {
          const sub = (k + rnd()) / count;
          const back = sub * dt;

          let wx, wy, wz, radius = 0.36;
          const rear = wheels ? wheels[2 + (k & 1)] : null;
          if (rear && rear.worldPos) {
            if (rear.contact === false) continue;
            radius = num(rear.radius, 0.36);
            wx = rear.worldPos.x;
            wy = rear.worldPos.y - radius * 0.80;
            wz = rear.worldPos.z;
          } else {
            const side = (k & 1) ? 0.74 : -0.74;
            wx = p.x - _fwd.x * 1.55 + _rgt.x * side;
            wy = p.y - 0.10;
            wz = p.z - _fwd.z * 1.55 + _rgt.z * side;
          }
          // Rewind along the car's path so the plume is a ribbon, not a stack.
          wx -= vel0x * back;
          wy -= vel0y * back;
          wz -= vel0z * back;

          const r1 = rnd(), r2 = rnd(), r3 = rnd();
          const backSpd = speed * (0.05 + 0.24 * r1);
          const upSpd = 1.0 + 3.6 * r2 + speed * 0.030;
          const latSpd = (r3 - 0.5) * (1.5 + speed * 0.060);

          const s0 = 0.20 + 0.32 * r2;
          const s1 = s0 * (3.2 + 3.2 * r1) * (0.70 + 0.70 * speedF);
          const life = 0.50 + 0.90 * r3 + speedF * 0.40;
          const alpha = (0.13 + 0.24 * r1) * wetness * (0.50 + 0.65 * speedF);

          if (!emitSpray(
            wx, wy + 0.06, wz,
            -_fwd.x * backSpd + _rgt.x * latSpd,
            upSpd,
            -_fwd.z * backSpd + _rgt.z * latSpd,
            s0, s1, life, alpha
          )) break;
        }

        // Diffuser rooster tail: the big, opaque column that blinds the car behind.
        if (speedF > 0.30) {
          const rr = rnd();
          emitSpray(
            p.x - _fwd.x * 2.05, p.y + 0.28, p.z - _fwd.z * 2.05,
            -_fwd.x * speed * 0.14 + (rnd() - 0.5) * 1.6,
            2.6 + speed * 0.055 + rr * 1.4,
            -_fwd.z * speed * 0.14 + (rnd() - 0.5) * 1.6,
            0.55 + 0.4 * rr,
            3.4 + 3.4 * rr + speedF * 3.0,
            0.85 + 0.85 * rr,
            (0.10 + 0.10 * rr) * wetness * (0.4 + 0.75 * speedF)
          );
        }
      }
    }

    const alive = spray.alive;
    spray.geo.instanceCount = alive;
    spray.mesh.visible = alive > 0;
    sprayLoad = spray.limit > 0 ? alive / spray.limit : 0;

    if (alive > 0) {
      spray.posRange.start = 0;
      spray.posRange.count = alive * 3;
      spray.posAttr.updateRanges.length = 0;
      spray.posAttr.updateRanges.push(spray.posRange);
      spray.posAttr.needsUpdate = true;

      spray.dataRange.start = 0;
      spray.dataRange.count = alive * 4;
      spray.dataAttr.updateRanges.length = 0;
      spray.dataAttr.updateRanges.push(spray.dataRange);
      spray.dataAttr.needsUpdate = true;
    }

    const su = spray.mat.uniforms;
    su.uLight.value = clamp(0.35 + 0.75 * lightLevel + flashStrength * 1.9, 0.15, 3.5);
    su.uFogColor.value.copy(fogColor);
    su.uOpacity.value = 0.92;
  }

  /* =========================================================================
   * Mist banks
   * ====================================================================== */

  function updateMist(dt, intensity, windX, windZ) {
    if (!mist.ok || mist.errors > 8) return;
    const target = enabled ? clamp01((intensity - 0.30) / 0.55) : 0;
    mistAmount = damp(mistAmount, target, 1.6, dt);
    if (mistAmount < 0.015) {
      mistAmount = target <= 0 ? 0 : mistAmount;
      mist.group.visible = false;
      return;
    }
    mist.group.visible = true;
    mist.mat.uniforms.uOpacity.value = mistAmount * num(options.mistOpacity, 0.30);
    mist.mat.uniforms.uLight.value = clamp(0.35 + 0.75 * lightLevel + flashStrength * 1.4, 0.15, 3.0);
    mist.mat.uniforms.uFogColor.value.copy(fogColor);

    mist.groundY = firstFrame ? (_camPos.y - 2.0) : damp(mist.groundY, _camPos.y - 2.0, 0.5, dt);

    const R = mist.radius;
    const meshes = mist.meshes, rel = mist.rel, drift = mist.drift;
    const limit = Math.min(meshes.length, mist.limit);
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (i >= limit) { m.visible = false; continue; }
      m.visible = true;
      const i3 = i * 3;
      const dsp = drift[i * 2];
      let x = rel[i3] + (windX * dsp - _camVel.x) * dt;
      let z = rel[i3 + 2] + (windZ * dsp - _camVel.z) * dt;
      const d = Math.sqrt(x * x + z * z);
      if (d > R) {
        const s = (R * 0.94) / (d > 1e-4 ? d : 1);
        x = -x * s;
        z = -z * s;
      }
      rel[i3] = x;
      rel[i3 + 2] = z;

      const bob = Math.sin(elapsed * 0.21 + drift[i * 2 + 1] * TAU) * 0.55;
      m.position.set(_camPos.x + x, mist.groundY + rel[i3 + 1] + bob, _camPos.z + z);
      _quatA.setFromAxisAngle(_UP, Math.atan2(-x, -z));
      m.quaternion.copy(_quatA);
      m.updateMatrix();
    }
  }

  /* =========================================================================
   * Visor droplets
   * ====================================================================== */

  function updateVisor(dt, cam, intensity, camSpeed) {
    if (!visor.ok || visor.errors > 8) return;
    const show = enabled && cockpitDroplets && intensity > 0.015;
    if (!show) {
      visor.mesh.visible = false;
      visor.wipeT = -1;
      visor.clean = 0;
      return;
    }
    visor.mesh.visible = true;
    const u = visor.mat.uniforms;

    visor.speedNorm = damp(visor.speedNorm, clamp01(camSpeed / 85), 5.0, dt);

    // Wipe cycle: the driver clears the visor more often the harder it rains.
    if (visor.wipeT >= 0) {
      visor.wipeT += dt * visor.wipeSpeed;
      if (visor.wipeT >= 1) {
        visor.wipeT = -1;
        visor.clean = 0.94;
        visor.nextWipe = Math.max(1.6, 6.5 + rnd() * 5.0 - intensity * 3.4);
      }
    } else {
      visor.nextWipe -= dt;
      if (visor.nextWipe <= 0) {
        visor.wipeT = 0;
        visor.wipeSpeed = 2.1 + rnd() * 1.7;
      }
    }
    visor.clean = damp(visor.clean, 0, 0.75 + intensity * 1.9, dt);

    u.uTime.value = elapsed;
    u.uSpeed.value = visor.speedNorm;
    u.uIntensity.value = clamp01(intensity * 1.06);
    u.uOpacity.value = clamp01(0.32 + 0.68 * intensity) * num(options.visorOpacity, 0.95);
    u.uWipe.value = visor.wipeT;
    u.uClean.value = visor.clean;
    u.uLight.value = clamp(0.30 + 0.80 * lightLevel + flashStrength * 2.0, 0.12, 3.5);

    let h = 0.55, w = 0.98;
    if (cam && cam.isPerspectiveCamera) {
      h = 2 * Math.tan(cam.fov * 0.5 * Math.PI / 180) * visorDistance;
      w = h * (num(cam.aspect, 1.7778) || 1.7778);
    }
    u.uAspect.value = w / Math.max(h, 1e-4);

    if (cam && cam.getWorldQuaternion) {
      cam.getWorldQuaternion(_quatA);
      visor.mesh.quaternion.copy(_quatA);
    }
    visor.mesh.position.copy(_camPos).addScaledVector(_camDir, visorDistance);
    visor.mesh.scale.set(w * 1.06, h * 1.06, 1);
    visor.mesh.updateMatrix();
  }

  /* =========================================================================
   * Track material patching
   * ====================================================================== */

  const patchedList = [];

  /**
   * Inject wet-asphalt response into any MeshStandard/MeshPhysical material.
   * The material samples the shared puddle mask in world XZ, darkens, drops its
   * roughness, and (on medium+) gets animated rain rings.
   */
  function patchTrackMaterial(material) {
    if (disposed) return null;
    try {
      if (!material || !material.isMaterial) return null;
      for (let i = 0; i < patchedList.length; i++) {
        if (patchedList[i].material === material) return patchedList[i].handle;
      }

      const prevOBC = material.onBeforeCompile;
      const prevKey = material.customProgramCacheKey;
      const ownOBC = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile');
      const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');

      material.onBeforeCompile = function (shader, renderer) {
        try {
          if (typeof prevOBC === 'function') prevOBC.call(this, shader, renderer);
        } catch (e) { /* keep going: a broken upstream hook must not kill the track */ }

        shader.uniforms.uApexWetness = shared.uApexWetness;
        shader.uniforms.uApexPuddleLevel = shared.uApexPuddleLevel;
        shader.uniforms.uApexPuddleScale = shared.uApexPuddleScale;
        shader.uniforms.uApexRain = shared.uApexRain;
        shader.uniforms.uApexTime = shared.uApexTime;
        shader.uniforms.uApexRippleScale = shared.uApexRippleScale;
        shader.uniforms.uApexRippleStrength = shared.uApexRippleStrength;
        shader.uniforms.uApexDarken = shared.uApexDarken;
        shader.uniforms.uApexWaterTint = shared.uApexWaterTint;
        shader.uniforms.uApexPuddleMask = shared.uApexPuddleMask;
        shader.uniforms.uApexRippleMap = shared.uApexRippleMap;

        shader.vertexShader = WET_PARS_VERT + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          '#include <project_vertex>\n' + WET_BODY_VERT
        );

        const defs = ripplesOn ? '#define APEX_RIPPLES\n' : '';
        shader.fragmentShader = defs + WET_PARS_FRAG + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          '#include <map_fragment>\n' + WET_MAP_FRAG
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n' + WET_ROUGH_FRAG
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\n' + WET_NORMAL_FRAG
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <clearcoat_normal_fragment_begin>',
          '#include <clearcoat_normal_fragment_begin>\n' + WET_CLEARCOAT_NORMAL_FRAG
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <lights_physical_fragment>',
          '#include <lights_physical_fragment>\n' + WET_CLEARCOAT_FRAG
        );
      };

      // three's default cache key stringifies onBeforeCompile, which would now be
      // this whole function. Emit a short stable key instead, chaining only a key
      // the material actually owned.
      material.customProgramCacheKey = function () {
        let base = '';
        try { if (ownKey && typeof prevKey === 'function') base = prevKey.call(this) || ''; } catch (e) { base = ''; }
        return base + '|apexwet' + (ripplesOn ? 'R' : '');
      };
      material.needsUpdate = true;

      const entry = { material, prevOBC, prevKey, ownOBC, ownKey, handle: null };
      entry.handle = {
        uniforms: shared,
        unpatch() {
          restorePatched(entry);
          const idx = patchedList.indexOf(entry);
          if (idx >= 0) patchedList.splice(idx, 1);
        },
      };
      patchedList.push(entry);
      return entry.handle;
    } catch (e) {
      lastError = e;
      return null;
    }
  }

  function restorePatched(e) {
    try {
      if (e.ownOBC) e.material.onBeforeCompile = e.prevOBC;
      else delete e.material.onBeforeCompile;
      if (e.ownKey) e.material.customProgramCacheKey = e.prevKey;
      else delete e.material.customProgramCacheKey;
      e.material.needsUpdate = true;
    } catch (err) { /* ignore */ }
  }

  function unpatchAll() {
    for (let i = patchedList.length - 1; i >= 0; i--) restorePatched(patchedList[i]);
    patchedList.length = 0;
  }

  /* =========================================================================
   * Main update
   * ====================================================================== */

  let camInitialised = false;
  let fogBase = null;

  function update(weatherState, cars, cam, dt) {
    if (disposed) return;

    const activeCam = (cam && cam.isCamera) ? cam : camera;

    let step = num(dt, 0.01666);
    if (step < 0) step = 0;
    if (step > 0.1) step = 0.1;
    elapsed += step;

    const ws = weatherState || _EMPTY_STATE;
    const intensity = clamp01(num(ws.rainIntensity, 0));
    const wetness = clamp01(num(ws.trackWetness, 0));
    const puddles = clamp01(num(ws.puddles, 0));
    const windSpeed = clamp(num(ws.windSpeed, 0), 0, 60);
    const windDir = num(ws.windDir, 0);
    const tod = num(ws.timeOfDay, 13);
    const condition = (typeof ws.condition === 'string') ? ws.condition : 'clear';

    /* --- camera tracking ------------------------------------------------ */
    try {
      if (activeCam && activeCam.getWorldPosition) {
        activeCam.getWorldPosition(_camPos);
        activeCam.getWorldDirection(_camDir);
      }
    } catch (e) { lastError = e; }

    if (!camInitialised) {
      _prevCam.copy(_camPos);
      _camVel.set(0, 0, 0);
      camInitialised = true;
    }
    _vA.copy(_camPos).sub(_prevCam);
    if (step > 1e-5) {
      if (_vA.lengthSq() > 625) {
        _camVel.set(0, 0, 0);         // camera cut / teleport: do not shear the rain
      } else {
        _vA.multiplyScalar(1 / step);
        _camVel.lerp(_vA, 1 - Math.exp(-14 * step));
      }
    }
    _prevCam.copy(_camPos);
    const camSpeed = _camVel.length();

    /* --- ambient level -------------------------------------------------- */
    const dayCurve = clamp01(smoothstep(4.5, 7.5, tod) - smoothstep(17.5, 20.5, tod));
    let cloudy = intensity;
    if (condition === 'overcast') cloudy = Math.max(cloudy, 0.55);
    else if (condition === 'cloudy') cloudy = Math.max(cloudy, 0.25);
    else if (condition === 'storm') cloudy = Math.max(cloudy, 0.80);
    const targetLight = clamp01(0.10 + 0.90 * dayCurve) * (1 - 0.50 * cloudy);
    lightLevel = damp(lightLevel, targetLight, 3.0, step);

    try {
      if (scene && scene.fog && scene.fog.color) fogColor.copy(scene.fog.color);
    } catch (e) { /* ignore */ }

    /* --- lightning ------------------------------------------------------ */
    try {
      updateFlash(step);
      if (autoLightning) {
        if (enabled && condition === 'storm') {
          nextStrike -= step;
          if (nextStrike <= 0) {
            triggerLightning();
            nextStrike = 4.5 + rnd() * rnd() * 26;
          }
        } else {
          nextStrike = 4 + rnd() * 12;
        }
      }
    } catch (e) { lastError = e; }

    const windX = Math.sin(windDir) * windSpeed;
    const windZ = Math.cos(windDir) * windSpeed;

    /* --- subsystems ----------------------------------------------------- */
    try { updateRain(step, intensity, windSpeed, windDir); }
    catch (e) { rain.errors++; lastError = e; }

    try { updateSpray(step, cars, wetness, intensity, windX, windZ); }
    catch (e) { spray.errors++; lastError = e; }

    try { updateMist(step, intensity, windX, windZ); }
    catch (e) { mist.errors++; lastError = e; }

    try { updateVisor(step, activeCam, intensity, camSpeed); }
    catch (e) { visor.errors++; lastError = e; }

    /* --- shared wet-track uniforms -------------------------------------- */
    try {
      shared.uApexWetness.value = damp(shared.uApexWetness.value, wetness, 2.4, step);
      shared.uApexPuddleLevel.value = damp(shared.uApexPuddleLevel.value, puddles, 1.4, step);
      shared.uApexRain.value = damp(shared.uApexRain.value, intensity, 3.0, step);
      shared.uApexTime.value = elapsed;
    } catch (e) { lastError = e; }

    /* --- atmospheric depth ---------------------------------------------- */
    try {
      let fogDensity = 0.0030;
      const f = scene ? scene.fog : null;
      if (f) {
        if (f.isFogExp2) fogDensity = num(f.density, fogDensity);
        else if (f.isFog && f.far > 0) fogDensity = 1.6 / f.far;
      }
      fogDensity = Math.min(0.05, fogDensity + intensity * 0.0035 + mistAmount * 0.0018);
      if (spray.mat) spray.mat.uniforms.uFogDensity.value = fogDensity;
      if (mist.mat) mist.mat.uniforms.uFogDensity.value = fogDensity;

      if (manageFog && f && f.isFogExp2) {
        if (fogBase === null) fogBase = f.density;
        f.density = fogBase + intensity * 0.0095 + mistAmount * 0.0055;
      }
    } catch (e) { lastError = e; }

    visibility = clamp01(1 - (0.38 * intensity + 0.20 * mistAmount + 0.16 * clamp01(sprayLoad * 1.4)));
    group.visible = enabled;
    api.flashStrength = flashStrength;
    firstFrame = false;
  }

  /* =========================================================================
   * Controls
   * ====================================================================== */

  function setCockpitDroplets(b) {
    cockpitDroplets = !!b;
    try {
      if (!cockpitDroplets && visor.mesh) visor.mesh.visible = false;
    } catch (e) { lastError = e; }
  }

  /** Force an immediate visor wipe (e.g. bound to a player key). */
  function wipeVisor() {
    if (visor.ok && visor.wipeT < 0) {
      visor.wipeT = 0;
      visor.wipeSpeed = 2.1 + rnd() * 1.7;
    }
  }

  function setEnabled(b) {
    enabled = !!b;
    group.visible = enabled;
    if (!enabled) {
      try {
        if (rain.mesh) rain.mesh.visible = false;
        if (spray.mesh) spray.mesh.visible = false;
        if (mist.group) mist.group.visible = false;
        if (visor.mesh) visor.mesh.visible = false;
        if (lightningLight) lightningLight.intensity = 0;
      } catch (e) { lastError = e; }
    }
  }

  function setQuality(q) {
    if (disposed) return;
    try {
      const nq = resolveQuality(q);
      quality = nq;
      preset = TIER_PRESETS[nq.tier];

      if (rain.ok) {
        const want = Math.max(256, Math.round(preset.rain * nq.particles));
        if (want > rain.cap) {
          const old = rain.geo;
          const geo = allocRain(want);
          rain.mesh.geometry = geo;
          if (old && old.dispose) old.dispose();
        }
        rain.limit = Math.min(rain.cap, want);
        if (rain.active > rain.limit) rain.active = rain.limit;
      }

      if (spray.ok) {
        const want = Math.max(128, Math.round(preset.spray * nq.particles));
        if (want > spray.cap) {
          const old = spray.geo;
          const geo = allocSpray(want);
          spray.mesh.geometry = geo;
          if (old && old.dispose) old.dispose();
        }
        spray.limit = Math.min(spray.cap, want);
        if (spray.alive > spray.limit) spray.alive = spray.limit;
      }

      if (mist.ok) mist.limit = Math.min(mist.meshes.length, Math.max(0, preset.mist));

      if (visor.ok && visor.mat) {
        const layers = Math.max(1, preset.visorLayers | 0);
        if (visor.mat.defines.VISOR_LAYERS !== layers) {
          visor.mat.defines.VISOR_LAYERS = layers;
          visor.mat.needsUpdate = true;
        }
      }

      const wantRipples = !!preset.ripples;
      if (wantRipples !== ripplesOn) {
        ripplesOn = wantRipples;
        for (let i = 0; i < patchedList.length; i++) {
          const m = patchedList[i].material;
          if (m) m.needsUpdate = true;
        }
      }

      const a = nq.anisotropy;
      if (texPuddle && texPuddle.anisotropy !== a) { texPuddle.anisotropy = a; texPuddle.needsUpdate = true; }
      if (texRipple && texRipple.anisotropy !== a) { texRipple.anisotropy = a; texRipple.needsUpdate = true; }
    } catch (e) { lastError = e; }
  }

  /* =========================================================================
   * Dispose
   * ====================================================================== */

  function disposeOne(o) {
    try { if (o && typeof o.dispose === 'function') o.dispose(); } catch (e) { /* ignore */ }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { unpatchAll(); } catch (e) { /* ignore */ }

    try {
      if (mist.meshes) {
        for (let i = 0; i < mist.meshes.length; i++) {
          const m = mist.meshes[i];
          if (m && m.parent) m.parent.remove(m);
        }
        mist.meshes.length = 0;
      }
      if (lightningLight) {
        lightningLight.intensity = 0;
        if (lightningLight.target && lightningLight.target.parent) {
          lightningLight.target.parent.remove(lightningLight.target);
        }
        if (lightningLight.parent) lightningLight.parent.remove(lightningLight);
        if (ownsLight) disposeOne(lightningLight);
      }
      if (group.parent) group.parent.remove(group);
    } catch (e) { /* ignore */ }

    disposeOne(rain.geo); disposeOne(rain.mat);
    disposeOne(spray.geo); disposeOne(spray.mat);
    disposeOne(mist.geo); disposeOne(mist.mat);
    disposeOne(visor.geo); disposeOne(visor.mat);
    disposeOne(texStreak); disposeOne(texPuff); disposeOne(texCloud);
    disposeOne(texPuddle); disposeOne(texRipple);

    shared.uApexPuddleMask.value = null;
    shared.uApexRippleMap.value = null;

    rain.mesh = null; rain.geo = null; rain.mat = null;
    rain.pos = null; rain.seedArr = null; rain.posAttr = null; rain.ok = false;
    spray.mesh = null; spray.geo = null; spray.mat = null;
    spray.pos = null; spray.data = null; spray.vel = null;
    spray.age = null; spray.life = null; spray.s0 = null; spray.s1 = null;
    spray.spinRate = null; spray.posAttr = null; spray.dataAttr = null; spray.ok = false;
    mist.group = null; mist.geo = null; mist.mat = null; mist.rel = null; mist.drift = null; mist.ok = false;
    visor.mesh = null; visor.geo = null; visor.mat = null; visor.ok = false;
    texStreak = texPuff = texCloud = texPuddle = texRipple = null;
    lightningLight = null;
    flashN = 0;
    flashStrength = 0;
  }

  /* =========================================================================
   * Public API
   * ====================================================================== */

  const api = {
    /** Root object (already added to the scene). */
    group,

    /** Per-frame driver. */
    update,

    /** Shared 0..1 wetness uniform other materials can bind directly. */
    getWetnessUniform() { return shared.uApexWetness; },

    /** Procedural puddle mask, sampled in world XZ. RGBA = pool/micro/drain/macro. */
    getPuddleMask() { return texPuddle; },

    /** Animated rain-ring field used by the wet track shader. */
    getRippleMap() { return texRipple; },

    /** Every uniform this module owns, for hand-rolled material bindings. */
    getUniforms() { return shared; },

    /** Bolt wet-asphalt response onto a MeshStandard/MeshPhysical material. */
    patchTrackMaterial,

    /** Strike now: flashes the scene and schedules delayed thunder. */
    triggerLightning,

    /** 0..~1.5 this frame. Read it to punch exposure/bloom or flash the HUD. */
    getFlashStrength() { return flashStrength; },

    /** Visor droplets on/off (cockpit + helmet cams). */
    setCockpitDroplets,
    isCockpitDroplets() { return cockpitDroplets; },
    wipeVisor,

    /** 0..1, 1 = perfectly clear. Useful for AI caution and HUD warnings. */
    getVisibility() { return visibility; },

    /** Live counters for the debug overlay. */
    getRainCount() { return rain.active; },
    getSprayCount() { return spray.alive; },
    getMistAmount() { return mistAmount; },
    getLightningLight() { return lightningLight; },
    getLastError() { return lastError; },

    setEnabled,
    isEnabled() { return enabled; },
    setQuality,
    dispose,

    /** Mirrors getFlashStrength(); refreshed every update(). */
    flashStrength: 0,
  };

  try { setQuality(options.quality !== undefined ? options.quality : quality); } catch (e) { lastError = e; }

  return api;
}

export default createWeather;

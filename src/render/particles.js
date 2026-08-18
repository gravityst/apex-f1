/**
 * APEX F1 — src/render/particles.js
 * ---------------------------------------------------------------------------
 * Transient particulate effects: tyre smoke, sparks, dust & gravel, grass
 * clippings, carbon-fibre debris and wet-weather spray.
 *
 * Design notes
 *  - One fixed-capacity pool per effect, each backed by exactly ONE InstancedMesh.
 *    Nothing is allocated after init: every per-particle attribute lives in a
 *    pre-allocated Float32Array (structure-of-arrays), and the alive particles
 *    are kept compacted into [0 .. count) by swap-removal so the instance draw
 *    range is always contiguous and `mesh.count` is exactly the live count.
 *  - Billboards are oriented in the VERTEX SHADER. The CPU writes only the
 *    translation + scale into `instanceMatrix`; the shader lifts the centre out
 *    of column 3, transforms it to view space, and offsets the corner in view
 *    space, so every quad faces the camera for free (and spark quads instead
 *    align to their screen-space velocity vector to form streaks).
 *  - Solid pools (gravel pebbles, carbon shards) integrate a real quaternion
 *    with angular velocity and compose the instance matrix by hand.
 *  - All procedural textures are drawn once into an offscreen canvas at init
 *    and cached on the instance. No network access, ever.
 *
 * Import surface is deliberately minimal: three only.
 */

import * as THREE from 'three';

/* ==========================================================================
 * Module-scope constants, scratch objects and fast math.
 * Nothing here has side effects beyond filling a few lookup tables.
 * ========================================================================== */

const TAU = Math.PI * 2;
const GRAVITY = 9.81;

/** Pre-allocated scratch. Used synchronously inside a single call, never held. */
const _scratchVecA = new THREE.Vector3();
const _scratchVecB = new THREE.Vector3();
const _scratchColor = new THREE.Color();

/* --- fast sine table (turbulence is evaluated a few thousand times a frame) - */
const SIN_BITS = 10;
const SIN_N = 1 << SIN_BITS;
const SIN_MASK = SIN_N - 1;
const SIN_SCALE = SIN_N / TAU;
const SIN_TABLE = new Float32Array(SIN_N);
for (let i = 0; i < SIN_N; i++) SIN_TABLE[i] = Math.sin((i / SIN_N) * TAU);

/** Table-driven sine. ~4x faster than Math.sin and plenty accurate for noise. */
function fsin(x) {
  return SIN_TABLE[(x * SIN_SCALE) & SIN_MASK];
}
function fcos(x) {
  return SIN_TABLE[((x * SIN_SCALE) + (SIN_N >> 2)) & SIN_MASK];
}

/* --- deterministic PRNG: keeps replays/screenshots reproducible ------------ */
let _rngState = 0x9e3779b9 >>> 0;
function rnd() {
  // xorshift32
  let x = _rngState;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  _rngState = x;
  return x / 4294967296;
}
/** Symmetric random in [-0.5, 0.5]. */
function rndc() { return rnd() - 0.5; }
/** Random in [a, b). */
function rndr(a, b) { return a + (b - a) * rnd(); }

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function isFiniteNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }

/** sRGB (authoring) -> linear-light (three's working space). */
function s2l(c) {
  return c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/* --- tileable value-noise used by the procedural textures ----------------- */
function hash2i(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function wrapi(v, period) {
  const m = v % period;
  return m < 0 ? m + period : m;
}
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = wrapi(xi, period), x1 = wrapi(xi + 1, period);
  const y0 = wrapi(yi, period), y1 = wrapi(yi + 1, period);
  const n00 = hash2i(x0, y0, seed);
  const n10 = hash2i(x1, y0, seed);
  const n01 = hash2i(x0, y1, seed);
  const n11 = hash2i(x1, y1, seed);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}
/** Tileable fBm over the unit square; `base` is the lowest-octave grid size. */
function fbm(u, v, base, seed, octaves, gain) {
  let amp = 1, sum = 0, norm = 0, period = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u * period, v * period, period, seed + o * 7919);
    norm += amp;
    amp *= gain;
    period *= 2;
  }
  return sum / (norm || 1);
}

/* ==========================================================================
 * Shaders
 * ========================================================================== */

/** Shared fog helper. Fog is implemented locally (own uniforms) rather than
 *  through three's chunk system so the module can never be broken by a change
 *  in include ordering, and so additive passes can attenuate instead of tint. */
const FOG_PARS = /* glsl */`
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogDensity;
uniform int   uFogMode;   // 0 = off, 1 = linear, 2 = exp2
float apexFogFactor( float depth ) {
  if ( uFogMode == 1 ) {
    return clamp( ( depth - uFogNear ) / max( uFogFar - uFogNear, 1e-4 ), 0.0, 1.0 );
  } else if ( uFogMode == 2 ) {
    float f = uFogDensity * depth;
    return 1.0 - exp( - f * f );
  }
  return 0.0;
}
`;

/**
 * Camera-facing billboard vertex program.
 *   instanceMatrix[3].xyz  -> world centre
 *   instanceMatrix[0].x    -> width
 *   instanceMatrix[1].y    -> height
 *   aData = ( life01, rotation, seed, aux )
 * With STRETCH the quad is aligned to the screen-projected velocity and hangs
 * BEHIND the particle centre (head at v = 1, tail at v = 0).
 */
const BILLBOARD_VERT = /* glsl */`
attribute vec4 aColor;
attribute vec4 aData;
#ifdef STRETCH
attribute vec3 aVel;
#endif

uniform float uNearFade;
uniform float uFarFade;

varying vec4  vTint;
varying vec2  vUvA;
varying float vLife;
varying float vSeed;
varying float vDepth;

void main() {
  vec3 centre = vec3( instanceMatrix[ 3 ].x, instanceMatrix[ 3 ].y, instanceMatrix[ 3 ].z );
  float sw = instanceMatrix[ 0 ].x;
  float sh = instanceMatrix[ 1 ].y;

  vec4 mv = modelViewMatrix * vec4( centre, 1.0 );
  vec2 corner = position.xy;
  vec2 offset;

  #ifdef STRETCH
    vec3 vv = ( modelViewMatrix * vec4( aVel, 0.0 ) ).xyz;
    vec2 d = vv.xy;
    float dl = length( d );
    vec2 dir = mix( vec2( 0.0, 1.0 ), d / max( dl, 1e-4 ), step( 1e-4, dl ) );
    vec2 side = vec2( dir.y, - dir.x );
    float len = sh + aData.w;
    offset = side * ( corner.x * sw ) + dir * ( ( corner.y - 0.5 ) * len );
  #else
    float ca = cos( aData.y );
    float sa = sin( aData.y );
    vec2 p = vec2( corner.x * sw, corner.y * sh );
    offset = vec2( p.x * ca - p.y * sa, p.x * sa + p.y * ca );
  #endif

  mv.xy += offset;

  float depth = - mv.z;
  vTint  = aColor;
  vTint.a *= smoothstep( 0.0, uNearFade, depth );
  vTint.a *= 1.0 - smoothstep( uFarFade * 0.72, uFarFade, depth );
  vUvA   = uv;
  vLife  = aData.x;
  vSeed  = aData.z;
  vDepth = depth;

  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Volumetric-looking smoke / dust / spray fragment program.
 *  - R channel of the map is the soft puff silhouette, G is tiling detail.
 *  - The detail lookup scrolls with life, and an erosion threshold that climbs
 *    with life dissolves the puff from the outside in: that is what reads as
 *    "billowing and breaking up" rather than "a quad fading out".
 *  - Shading uses a fake hemispherical normal derived from the quad UV, lit by
 *    the sun direction in view space, so puffs get a lit rim and shaded core.
 */
const SMOKE_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform float uFadeIn;
uniform float uFadeOut;
uniform float uErode;
uniform float uSoftEdge;
uniform float uDetail;
uniform float uScroll;
uniform float uSelfShadow;
uniform float uOpacity;
uniform vec3  uSunViewDir;
uniform vec3  uLightTint;
uniform vec3  uShadowTint;

varying vec4  vTint;
varying vec2  vUvA;
varying float vLife;
varying float vSeed;
varying float vDepth;

${FOG_PARS}

void main() {
  vec4 tex = texture2D( uMap, vUvA );
  float puff = tex.r;

  float life = vLife;
  vec2 duv = vUvA * 1.31 + vec2( vSeed * 5.13 + life * uScroll, vSeed * 2.71 - life * uScroll * 0.61 );
  float detail = texture2D( uMap, fract( duv ) ).g;

  float mask = puff * mix( 1.0, detail * 1.55, uDetail );

  float thr = uErode * life;
  float shape = smoothstep( thr, thr + uSoftEdge, mask );

  float fin  = smoothstep( 0.0, uFadeIn, life );
  float fout = 1.0 - smoothstep( uFadeOut, 1.0, life );

  float alpha = shape * fin * fout * vTint.a * uOpacity;
  if ( alpha < 0.0035 ) discard;

  // fake spherical normal for the puff, lit in view space
  vec2 nxy = vUvA * 2.0 - 1.0;
  float r2 = dot( nxy, nxy );
  vec3 n = vec3( nxy, sqrt( max( 0.0, 1.0 - r2 ) ) );
  float ndl = dot( n, uSunViewDir ) * 0.5 + 0.5;
  vec3 lit = mix( uShadowTint, uLightTint, ndl );

  vec3 col = vTint.rgb * lit;
  col *= mix( 1.0, 0.70, smoothstep( 0.30, 1.0, mask ) * uSelfShadow );

  float fogF = apexFogFactor( vDepth );
  col = mix( col, uFogColor, fogF );

  gl_FragColor = vec4( col, alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Sparks: premultiplied additive streaks with a white-hot core that cools to
 * orange then deep red, plus a per-particle flicker. Fog attenuates rather
 * than tints, because additive light does not get "fogged" toward grey.
 */
const SPARK_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3  uHot;
uniform vec3  uCool;
uniform float uFlicker;
uniform float uIntensity;

varying vec4  vTint;
varying vec2  vUvA;
varying float vLife;
varying float vSeed;
varying float vDepth;

${FOG_PARS}

void main() {
  vec4 tex = texture2D( uMap, vUvA );
  float body = tex.a;
  if ( body < 0.004 ) discard;

  float life = vLife;
  float fout = 1.0 - smoothstep( 0.55, 1.0, life );
  float flick = 1.0 - uFlicker * ( 0.5 + 0.5 * sin( ( vSeed * 91.0 + life * 47.0 ) * 6.2831853 ) );

  vec3 col = mix( uHot, vTint.rgb, smoothstep( 0.0, 0.28, life ) );
  col = mix( col, uCool, smoothstep( 0.45, 1.0, life ) );

  float energy = body * fout * flick * vTint.a * uIntensity;
  vec3 outCol = col * energy + vec3( 1.0, 0.92, 0.78 ) * tex.r * energy * 0.85;

  outCol *= ( 1.0 - apexFogFactor( vDepth ) );

  gl_FragColor = vec4( outCol, energy );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Grass clippings / small alpha-tested flecks. Opaque with a cutout so they
 * sort correctly against each other and the world without a depth pre-pass.
 */
const FLECK_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform float uAlphaCut;
uniform vec3  uSunViewDir;
uniform vec3  uLightTint;
uniform vec3  uShadowTint;

varying vec4  vTint;
varying vec2  vUvA;
varying float vLife;
varying float vSeed;
varying float vDepth;

${FOG_PARS}

void main() {
  vec4 tex = texture2D( uMap, vUvA );
  float a = tex.a * vTint.a;
  if ( a < uAlphaCut ) discard;

  // cheap two-sided shading from a fake normal so tumbling flecks catch light
  vec2 nxy = vUvA * 2.0 - 1.0;
  vec3 n = normalize( vec3( nxy.x * 0.45, nxy.y * 0.45, 1.0 ) );
  float ndl = abs( dot( n, uSunViewDir ) );
  vec3 lit = mix( uShadowTint, uLightTint, ndl );

  vec3 col = vTint.rgb * tex.rgb * lit;
  col *= mix( 1.0, 0.55, smoothstep( 0.55, 1.0, vLife ) );   // browns off as it settles
  col = mix( col, uFogColor, apexFogFactor( vDepth ) );

  gl_FragColor = vec4( col, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Lit, instanced, tumbling solids: gravel pebbles and carbon shards. */
const SOLID_VERT = /* glsl */`
attribute vec4 aColor;
attribute vec4 aData;

varying vec3  vNrm;
varying vec3  vWorld;
varying vec4  vTint;
varying float vLife;
varying float vDepth;

void main() {
  mat3 im = mat3( instanceMatrix );
  vec3 n = normalize( im * normal );

  vec4 local = instanceMatrix * vec4( position, 1.0 );
  vec4 world = modelMatrix * local;
  vec4 mv = modelViewMatrix * local;

  vNrm   = normalize( mat3( modelMatrix ) * n );
  vWorld = world.xyz;
  vTint  = aColor;
  vLife  = aData.x;
  vDepth = - mv.z;

  gl_Position = projectionMatrix * mv;
}
`;

const SOLID_FRAG = /* glsl */`
uniform vec3  uSunDir;      // world space, pointing TOWARD the sun
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform float uSpecular;
uniform float uSpecPower;

varying vec3  vNrm;
varying vec3  vWorld;
varying vec4  vTint;
varying float vLife;
varying float vDepth;

${FOG_PARS}

void main() {
  vec3 n = normalize( vNrm );
  vec3 v = normalize( cameraPosition - vWorld );

  float ndl = max( dot( n, uSunDir ), 0.0 );
  float hemi = n.y * 0.5 + 0.5;
  vec3 ambient = mix( uGroundColor, uSkyColor, hemi );

  vec3 col = vTint.rgb * ( ambient + uSunColor * ndl );

  vec3 h = normalize( uSunDir + v );
  float spec = pow( max( dot( n, h ), 0.0 ), uSpecPower ) * uSpecular * vTint.a;
  col += uSunColor * spec;

  col = mix( col, uFogColor, apexFogFactor( vDepth ) );

  gl_FragColor = vec4( col, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ==========================================================================
 * Tier tables
 * ========================================================================== */

const TIER_CAPS = {
  low:    { smoke: 260,  spark: 180,  dust: 170,  spray: 240,  grass: 130, pebble: 90,  debris: 80 },
  medium: { smoke: 620,  spark: 380,  dust: 340,  spray: 560,  grass: 260, pebble: 190, debris: 170 },
  high:   { smoke: 1100, spark: 660,  dust: 620,  spray: 1000, grass: 440, pebble: 340, debris: 300 },
  ultra:  { smoke: 1750, spark: 1050, dust: 980,  spray: 1600, grass: 720, pebble: 560, debris: 470 },
};

const TIER_EMIT = { low: 0.42, medium: 0.68, high: 1.0, ultra: 1.3 };

function tierOf(name) {
  return (name && TIER_CAPS[name]) ? name : 'high';
}

/* Surface look-up for dust colour / gravel content. Keys match
 * track.surfaceAt().type plus a few common aliases. */
const SURFACES = {
  gravel:   { r: 0.63, g: 0.55, b: 0.44, jitter: 0.09, pebbles: 1.00, pr: 0.52, pg: 0.47, pb: 0.40, coarse: 1.0 },
  dirt:     { r: 0.50, g: 0.40, b: 0.30, jitter: 0.08, pebbles: 0.30, pr: 0.40, pg: 0.32, pb: 0.24, coarse: 0.7 },
  sand:     { r: 0.80, g: 0.72, b: 0.55, jitter: 0.06, pebbles: 0.14, pr: 0.72, pg: 0.64, pb: 0.48, coarse: 0.5 },
  grass:    { r: 0.44, g: 0.43, b: 0.30, jitter: 0.07, pebbles: 0.10, pr: 0.34, pg: 0.30, pb: 0.20, coarse: 0.4 },
  astro:    { r: 0.38, g: 0.46, b: 0.34, jitter: 0.05, pebbles: 0.00, pr: 0.30, pg: 0.36, pb: 0.26, coarse: 0.2 },
  kerb:     { r: 0.68, g: 0.62, b: 0.60, jitter: 0.05, pebbles: 0.05, pr: 0.58, pg: 0.54, pb: 0.52, coarse: 0.3 },
  concrete: { r: 0.72, g: 0.71, b: 0.68, jitter: 0.05, pebbles: 0.10, pr: 0.62, pg: 0.61, pb: 0.58, coarse: 0.4 },
  asphalt:  { r: 0.44, g: 0.44, b: 0.46, jitter: 0.05, pebbles: 0.06, pr: 0.30, pg: 0.30, pb: 0.32, coarse: 0.3 },
  pit:      { r: 0.55, g: 0.55, b: 0.57, jitter: 0.04, pebbles: 0.04, pr: 0.36, pg: 0.36, pb: 0.38, coarse: 0.2 },
};

/* ==========================================================================
 * Procedural textures (canvas 2D, generated once per instance)
 * ========================================================================== */

function makeCanvas(size) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function finishTexture(canvas, aniso) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.max(1, aniso | 0);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Smoke atlas.
 *   R = soft billowing puff silhouette (warped radial falloff)
 *   G = seamless mid-frequency detail used for erosion + internal structure
 *   B = coarse blob mask (unused by the default shader, kept for variants)
 *   A = same as R so the texture also works as a plain alpha map
 */
function makeSmokeTexture(size, seed, aniso, warpAmount, detailBase, edgePower) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;

      // radial base, warped by low frequency noise to break the circle
      const dx = (u - 0.5) * 2;
      const dy = (v - 0.5) * 2;
      let d = Math.sqrt(dx * dx + dy * dy);
      const warp = fbm(u, v, 3, seed, 4, 0.55) - 0.5;
      d += warp * warpAmount;

      let puff = clamp01(1.0 - d);
      puff = Math.pow(puff, edgePower);

      // interior density: clumps of thicker vapour
      const clump = fbm(u, v, 5, seed + 131, 4, 0.5);
      puff *= 0.62 + 0.55 * clump;
      puff = clamp01(puff);

      // seamless detail channel (tileable because fbm wraps at each period)
      let detail = fbm(u, v, detailBase, seed + 977, 5, 0.52);
      detail = clamp01((detail - 0.30) * 1.85 + 0.30);

      const coarse = clamp01(fbm(u, v, 2, seed + 555, 3, 0.6));

      const o = (y * size + x) * 4;
      data[o] = (puff * 255) | 0;
      data[o + 1] = (detail * 255) | 0;
      data[o + 2] = (coarse * 255) | 0;
      data[o + 3] = (puff * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(canvas, aniso);
}

/**
 * Grit atlas for dust/gravel puffs: harder silhouette, strong granularity so
 * the puff reads as suspended particulate rather than vapour.
 */
function makeGritTexture(size, seed, aniso) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;

      const dx = (u - 0.5) * 2;
      const dy = (v - 0.5) * 2;
      let d = Math.sqrt(dx * dx + dy * dy);
      d += (fbm(u, v, 4, seed, 4, 0.58) - 0.5) * 0.62;

      let puff = clamp01(1.0 - d);
      puff = Math.pow(puff, 1.35);

      const grain = fbm(u, v, 9, seed + 313, 4, 0.48);
      const speck = fbm(u, v, 18, seed + 733, 2, 0.5);
      puff *= 0.45 + 0.75 * grain;
      puff = clamp01(puff * (0.82 + 0.35 * speck));

      let detail = clamp01((grain * 0.6 + speck * 0.4 - 0.28) * 2.0 + 0.28);

      const o = (y * size + x) * 4;
      data[o] = (puff * 255) | 0;
      data[o + 1] = (detail * 255) | 0;
      data[o + 2] = (speck * 255) | 0;
      data[o + 3] = (puff * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(canvas, aniso);
}

/**
 * Spark streak: bright tapered line. A (body) is used for the energy mask,
 * R carries the extra-hot core so the shader can push the centre over 1.0.
 */
function makeSparkTexture(size, aniso) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;               // 0 = tail, 1 = head
    // head is bright and round, tail thins and dims out
    const headw = 0.30 + 0.70 * Math.pow(v, 1.6);
    const along = Math.pow(v, 1.9) * (0.35 + 0.65 * clamp01((1.0 - v) * 8.0 + 0.35));
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      const ax = Math.abs(u - 0.5) * 2 / Math.max(headw, 1e-3);
      const across = clamp01(1 - ax);

      const core = Math.pow(across, 7.0) * Math.pow(v, 3.0);
      const glow = Math.pow(across, 1.7);
      const body = clamp01((glow * 0.85 + core * 0.6) * along);

      const o = (y * size + x) * 4;
      data[o] = (clamp01(core) * 255) | 0;
      data[o + 1] = (clamp01(glow) * 255) | 0;
      data[o + 2] = 0;
      data[o + 3] = (body * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = finishTexture(canvas, aniso);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Grass clipping: a slightly curved tapered blade with a lighter spine.
 * RGB carries shading detail, A is the cutout.
 */
function makeBladeTexture(size, aniso) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    const bend = 0.17 * Math.sin(v * Math.PI * 0.9);
    const cx = 0.5 - 0.08 + bend;
    const halfw = 0.115 * (1.0 - Math.pow(v, 1.7)) + 0.012;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      const dist = Math.abs(u - cx);
      let a = clamp01((halfw - dist) / Math.max(halfw * 0.55, 1e-3));
      a = a > 0 ? clamp01(a * 1.6) : 0;
      // taper the very base and tip so it does not look like a rectangle
      a *= clamp01(v * 14.0) * clamp01((1.02 - v) * 9.0);

      const spine = clamp01(1.0 - dist / Math.max(halfw, 1e-3));
      const shade = 0.62 + 0.42 * Math.pow(spine, 2.0) - 0.18 * v;

      const o = (y * size + x) * 4;
      data[o] = (clamp01(shade * 0.92) * 255) | 0;
      data[o + 1] = (clamp01(shade) * 255) | 0;
      data[o + 2] = (clamp01(shade * 0.70) * 255) | 0;
      data[o + 3] = (a * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = finishTexture(canvas, aniso);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/* ==========================================================================
 * Solid geometries
 * ========================================================================== */

/**
 * Irregular faceted pebble. The source icosahedron is non-indexed (each face
 * carries its own vertices), so the jitter is derived from a hash of the
 * ORIGINAL vertex position: duplicated corners receive an identical offset and
 * the shell stays watertight instead of cracking open.
 */
function makePebbleGeometry() {
  const src = new THREE.IcosahedronGeometry(0.5, 0);
  const flat = src.index ? src.toNonIndexed() : src;
  const pos = flat.getAttribute('position');
  const q = (v) => Math.round(v * 2048);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const kx = q(x), ky = q(y), kz = q(z);
    const h1 = hash2i(kx, ky ^ kz, 8123);
    const h2 = hash2i(ky, kz ^ kx, 41231);
    const h3 = hash2i(kz, kx ^ ky, 90311);
    pos.setXYZ(
      i,
      x * (1 + (h1 - 0.5) * 0.46) * 1.06,
      y * (1 + (h2 - 0.5) * 0.46) * 0.76,
      z * (1 + (h3 - 0.5) * 0.46)
    );
  }
  pos.needsUpdate = true;
  flat.computeVertexNormals();
  flat.computeBoundingSphere();
  if (flat !== src) { try { src.dispose(); } catch (e) { /* ignore */ } }
  return flat;
}

/**
 * Carbon-fibre shard: a flat, angular, slightly dished polygon built as a
 * double-sided fan so it reads as a torn piece of bodywork rather than a chip.
 */
function makeShardGeometry() {
  const n = 7;
  const rimX = new Float32Array(n);
  const rimY = new Float32Array(n);
  const rimZ = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rndc() * 0.42;
    const r = 0.5 * (0.42 + rnd() * 0.86);
    rimX[i] = Math.cos(a) * r;
    rimY[i] = rndc() * 0.055;
    rimZ[i] = Math.sin(a) * r * 0.68;
  }
  const topY = 0.075;
  const botY = -0.055;

  const verts = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // top fan
    verts.push(0, topY, 0, rimX[i], rimY[i], rimZ[i], rimX[j], rimY[j], rimZ[j]);
    // bottom fan (reverse winding)
    verts.push(0, botY, 0, rimX[j], rimY[j], rimZ[j], rimX[i], rimY[i], rimZ[i]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ==========================================================================
 * Pool
 * ========================================================================== */

const COMMON_FIELDS = [
  'px', 'py', 'pz', 'vx', 'vy', 'vz',
  'age', 'life', 'size', 'grow', 'rot', 'rotv',
  'seed', 'gy', 'drag', 'grav', 'buoy', 'turb',
  'wind', 'spread', 'r', 'g', 'b', 'a', 'aux', 'misc',
];
const SPIN_FIELDS = ['qx', 'qy', 'qz', 'qw', 'wx', 'wy', 'wz', 'rest', 'fric'];

class Pool {
  constructor(name, capacity, mesh, hasSpin, hasVel) {
    this.name = name;
    this.capacity = capacity;
    this.cap = capacity;           // effective (quality-limited) ceiling
    this.count = 0;
    this.frac = 0;                 // fractional emission accumulator
    this.recycle = 0;
    this.mesh = mesh;
    this.hasSpin = !!hasSpin;
    this.prevCount = -1;

    this.matrixAttr = mesh.instanceMatrix;
    this.matrix = mesh.instanceMatrix.array;
    this.colorAttr = mesh.geometry.getAttribute('aColor');
    this.color = this.colorAttr.array;
    this.dataAttr = mesh.geometry.getAttribute('aData');
    this.data = this.dataAttr.array;
    this.velAttr = hasVel ? mesh.geometry.getAttribute('aVel') : null;
    this.vel = this.velAttr ? this.velAttr.array : null;

    const names = hasSpin ? COMMON_FIELDS.concat(SPIN_FIELDS) : COMMON_FIELDS;
    this.fields = [];
    for (let i = 0; i < names.length; i++) {
      const arr = new Float32Array(capacity);
      this[names[i]] = arr;
      this.fields.push(arr);
    }
    this.fieldCount = this.fields.length;

    // identity instance matrices so untouched elements are valid
    const m = this.matrix;
    for (let i = 0; i < capacity; i++) {
      const o = i * 16;
      m[o] = 1; m[o + 5] = 1; m[o + 10] = 1; m[o + 15] = 1;
    }
    mesh.count = 0;
  }

  /** Grab a slot. Returns -1 when the pool is disabled (cap 0). */
  alloc() {
    const cap = this.cap;
    if (cap <= 0) return -1;
    if (this.count < cap) return this.count++;
    const i = this.recycle;
    this.recycle = (i + 1) % cap;
    return i;
  }

  /** Swap-remove: move the last live particle into slot i. */
  removeAt(i) {
    const last = --this.count;
    if (i !== last) {
      const f = this.fields;
      for (let k = 0; k < this.fieldCount; k++) {
        const arr = f[k];
        arr[i] = arr[last];
      }
      if (this.vel) {
        const a = i * 4, b = last * 4;
        this.vel[a] = this.vel[b];
        this.vel[a + 1] = this.vel[b + 1];
        this.vel[a + 2] = this.vel[b + 2];
      }
    }
  }

  clear() {
    this.count = 0;
    this.frac = 0;
    this.recycle = 0;
    this.mesh.count = 0;
    this.prevCount = -1;
  }

  /** Upload only the live, contiguous head of each buffer. */
  flush() {
    const c = this.count;
    this.mesh.count = c;
    if (c === 0 && this.prevCount === 0) return;
    this.prevCount = c;
    if (c === 0) return;

    const ma = this.matrixAttr;
    if (ma.clearUpdateRanges) { ma.clearUpdateRanges(); ma.addUpdateRange(0, c * 16); }
    ma.needsUpdate = true;

    const ca = this.colorAttr;
    if (ca.clearUpdateRanges) { ca.clearUpdateRanges(); ca.addUpdateRange(0, c * 4); }
    ca.needsUpdate = true;

    const da = this.dataAttr;
    if (da.clearUpdateRanges) { da.clearUpdateRanges(); da.addUpdateRange(0, c * 4); }
    da.needsUpdate = true;

    if (this.velAttr) {
      const va = this.velAttr;
      if (va.clearUpdateRanges) { va.clearUpdateRanges(); va.addUpdateRange(0, c * 3); }
      va.needsUpdate = true;
    }
  }
}

const _noopRaycast = function () {};

function buildInstancedGeometry(base, capacity, withVelocity) {
  const geo = base;
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aData', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  if (withVelocity) {
    geo.setAttribute('aVel', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
  }
  return geo;
}

/* ==========================================================================
 * Factory
 * ========================================================================== */

/**
 * @param {THREE.Scene|THREE.Object3D} scene  container the particle group is added to
 * @param {Object} [opts]
 *   quality        {tier, particles, anisotropy}  — see ARCHITECTURE.md
 *   capacityTier   'low'|'medium'|'high'|'ultra'  — allocation ceiling (default = quality.tier)
 *   groundY        Number   fallback ground plane height (default 0)
 *   groundAt       (x, z) => y   optional exact ground resolver
 *   wind           THREE.Vector3 | {speed, dir}
 *   sunDirection   THREE.Vector3 (points toward the sun)
 *   sunColor / skyColor / groundColor  THREE.Color | hex
 *   cullDistance   Number   metres beyond which emission is suppressed (default 320)
 *   maxBurst       Number   hard cap on particles spawned by a single emit call
 *   renderOrder    Number   base render order for the transparent passes
 */
export function createParticles(scene, opts) {
  const o = opts || {};
  const quality = (o.quality && typeof o.quality === 'object') ? o.quality : {};
  const initialTier = tierOf(quality.tier || o.tier);
  const capTier = tierOf(o.capacityTier || initialTier);
  const caps = TIER_CAPS[capTier];
  const aniso = Math.max(1, (quality.anisotropy || o.anisotropy || 4) | 0);
  const capacityScale = isFiniteNum(o.capacityScale) ? clamp(o.capacityScale, 0.1, 4) : 1;

  const CULL = isFiniteNum(o.cullDistance) ? o.cullDistance : 320;
  const CULL2 = CULL * CULL;
  const MAX_BURST = isFiniteNum(o.maxBurst) ? Math.max(1, o.maxBurst | 0) : 96;
  const BASE_ORDER = isFiniteNum(o.renderOrder) ? o.renderOrder : 8;

  const group = new THREE.Group();
  group.name = 'apex-particles';
  group.matrixAutoUpdate = false;
  group.frustumCulled = false;

  /* ---- shared uniform objects (one write updates every material) --------- */
  const uFogColor = { value: new THREE.Color(0.62, 0.66, 0.72) };
  const uFogNear = { value: 40 };
  const uFogFar = { value: 2200 };
  const uFogDensity = { value: 0.0 };
  const uFogMode = { value: 0 };

  const uSunViewDir = { value: new THREE.Vector3(0.0, 0.55, -0.83) };
  const uSunWorldDir = { value: new THREE.Vector3(0.35, 0.78, 0.52).normalize() };
  const uLightTint = { value: new THREE.Color(1.06, 1.02, 0.96) };
  const uShadowTint = { value: new THREE.Color(0.44, 0.50, 0.62) };
  const uSunColor = { value: new THREE.Color(1.0, 0.96, 0.88) };
  const uSkyColor = { value: new THREE.Color(0.34, 0.40, 0.52) };
  const uGroundColorU = { value: new THREE.Color(0.16, 0.15, 0.13) };

  function fogUniforms() {
    return {
      uFogColor: uFogColor, uFogNear: uFogNear, uFogFar: uFogFar,
      uFogDensity: uFogDensity, uFogMode: uFogMode,
    };
  }

  /* ---- state ------------------------------------------------------------ */
  const state = {
    time: 0,
    tier: initialTier,
    density: isFiniteNum(quality.particles) ? clamp(quality.particles, 0, 1.5) : 1,
    emitScale: 1,
    wind: new THREE.Vector3(0, 0, 0),
    groundY: isFiniteNum(o.groundY) ? o.groundY : 0,
    // A flat ground plane is only assumed when the integrator explicitly asks
    // for one; otherwise the emit height is the local ground reference, which
    // is correct on elevation change and banking.
    usePlane: isFiniteNum(o.groundY),
    groundAt: (typeof o.groundAt === 'function') ? o.groundAt : null,
    wetness: 0,
    rain: 0,
    hasCamera: false,
    camPos: new THREE.Vector3(),
    disposed: false,
    fogRef: null,
  };

  const textures = [];
  const geometries = [];
  const materials = [];
  const pools = {};
  const poolList = [];

  function track(list, item) { if (item) list.push(item); return item; }

  /* ---- textures --------------------------------------------------------- */
  let texSmoke = null, texGrit = null, texSpark = null, texBlade = null;
  try {
    const smokeSize = (capTier === 'low') ? 128 : (capTier === 'medium' ? 192 : 256);
    texSmoke = track(textures, makeSmokeTexture(smokeSize, 1337, aniso, 0.52, 6, 1.05));
  } catch (e) { texSmoke = null; }
  try {
    const gritSize = (capTier === 'low') ? 96 : 160;
    texGrit = track(textures, makeGritTexture(gritSize, 90210, aniso));
  } catch (e) { texGrit = null; }
  try {
    texSpark = track(textures, makeSparkTexture(64, aniso));
  } catch (e) { texSpark = null; }
  try {
    texBlade = track(textures, makeBladeTexture(64, aniso));
  } catch (e) { texBlade = null; }

  /* ---- material builders ------------------------------------------------ */
  function makeSmokeMaterial(map, params) {
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({
        uMap: { value: map },
        uFadeIn: { value: params.fadeIn },
        uFadeOut: { value: params.fadeOut },
        uErode: { value: params.erode },
        uSoftEdge: { value: params.softEdge },
        uDetail: { value: params.detail },
        uScroll: { value: params.scroll },
        uSelfShadow: { value: params.selfShadow },
        uOpacity: { value: 1 },
        uNearFade: { value: params.nearFade },
        uFarFade: { value: params.farFade },
        uSunViewDir: uSunViewDir,
        uLightTint: uLightTint,
        uShadowTint: uShadowTint,
      }, fogUniforms()),
      vertexShader: BILLBOARD_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    return track(materials, mat);
  }

  function makeSparkMaterial(map) {
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({
        uMap: { value: map },
        uHot: { value: new THREE.Color(s2l(1.0), s2l(0.97), s2l(0.86)) },
        uCool: { value: new THREE.Color(s2l(0.95), s2l(0.22), s2l(0.03)) },
        uFlicker: { value: 0.34 },
        uIntensity: { value: 2.35 },
        uNearFade: { value: 0.22 },
        uFarFade: { value: 700 },
      }, fogUniforms()),
      vertexShader: BILLBOARD_VERT,
      fragmentShader: SPARK_FRAG,
      defines: { STRETCH: '' },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    return track(materials, mat);
  }

  function makeFleckMaterial(map) {
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({
        uMap: { value: map },
        uAlphaCut: { value: 0.38 },
        uNearFade: { value: 0.2 },
        uFarFade: { value: 320 },
        uSunViewDir: uSunViewDir,
        uLightTint: uLightTint,
        uShadowTint: uShadowTint,
      }, fogUniforms()),
      vertexShader: BILLBOARD_VERT,
      fragmentShader: FLECK_FRAG,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: true,
    });
    return track(materials, mat);
  }

  function makeSolidMaterial(specular, specPower, doubleSided) {
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({
        uSunDir: uSunWorldDir,
        uSunColor: uSunColor,
        uSkyColor: uSkyColor,
        uGroundColor: uGroundColorU,
        uSpecular: { value: specular },
        uSpecPower: { value: specPower },
      }, fogUniforms()),
      vertexShader: SOLID_VERT,
      fragmentShader: SOLID_FRAG,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      fog: false,
      toneMapped: true,
    });
    return track(materials, mat);
  }

  /* ---- pool construction ------------------------------------------------ */
  function addPool(name, capacity, baseGeo, material, cfg) {
    const cap = Math.max(8, Math.round(capacity * capacityScale));
    const geo = buildInstancedGeometry(baseGeo, cap, !!(cfg && cfg.velocity));
    track(geometries, geo);
    const mesh = new THREE.InstancedMesh(geo, material, cap);
    mesh.name = 'apex-particles-' + name;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = (cfg && isFiniteNum(cfg.order)) ? cfg.order : BASE_ORDER;
    mesh.raycast = _noopRaycast;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);
    const pool = new Pool(name, cap, mesh, !!(cfg && cfg.spin), !!(cfg && cfg.velocity));
    pools[name] = pool;
    poolList.push(pool);
    return pool;
  }

  const SMOKE_PARAMS = {
    fadeIn: 0.085, fadeOut: 0.42, erode: 0.58, softEdge: 0.32,
    detail: 0.85, scroll: 0.34, selfShadow: 0.55, nearFade: 1.35, farFade: 900,
  };
  const DUST_PARAMS = {
    fadeIn: 0.07, fadeOut: 0.36, erode: 0.72, softEdge: 0.24,
    detail: 1.0, scroll: 0.20, selfShadow: 0.45, nearFade: 1.1, farFade: 700,
  };
  const SPRAY_PARAMS = {
    fadeIn: 0.13, fadeOut: 0.24, erode: 0.36, softEdge: 0.46,
    detail: 0.55, scroll: 0.52, selfShadow: 0.12, nearFade: 0.9, farFade: 620,
  };

  let matSmoke = null, matDust = null, matSpray = null, matSpark = null;
  let matGrass = null, matPebble = null, matDebris = null;

  try {
    matSmoke = makeSmokeMaterial(texSmoke, SMOKE_PARAMS);
    addPool('smoke', caps.smoke, new THREE.PlaneGeometry(1, 1), matSmoke, { order: BASE_ORDER });
  } catch (e) { /* smoke unavailable — everything else still runs */ }

  try {
    matDust = makeSmokeMaterial(texGrit || texSmoke, DUST_PARAMS);
    addPool('dust', caps.dust, new THREE.PlaneGeometry(1, 1), matDust, { order: BASE_ORDER + 1 });
  } catch (e) { /* ignore */ }

  try {
    matSpray = makeSmokeMaterial(texSmoke, SPRAY_PARAMS);
    addPool('spray', caps.spray, new THREE.PlaneGeometry(1, 1), matSpray, { order: BASE_ORDER + 2 });
  } catch (e) { /* ignore */ }

  try {
    matSpark = makeSparkMaterial(texSpark);
    addPool('spark', caps.spark, new THREE.PlaneGeometry(1, 1), matSpark, { order: BASE_ORDER + 6, velocity: true });
  } catch (e) { /* ignore */ }

  try {
    matGrass = makeFleckMaterial(texBlade);
    addPool('grass', caps.grass, new THREE.PlaneGeometry(1, 1), matGrass, { order: 1 });
  } catch (e) { /* ignore */ }

  try {
    matPebble = makeSolidMaterial(0.12, 22.0, false);
    addPool('pebble', caps.pebble, makePebbleGeometry(), matPebble, { order: 1, spin: true });
  } catch (e) { /* ignore */ }

  try {
    matDebris = makeSolidMaterial(0.85, 62.0, true);
    addPool('debris', caps.debris, makeShardGeometry(), matDebris, { order: 1, spin: true });
  } catch (e) { /* ignore */ }

  try {
    if (scene && typeof scene.add === 'function') scene.add(group);
  } catch (e) { /* detached mode — integrator can add `group` itself */ }

  /* ======================================================================
   * Emission helpers
   * ====================================================================== */

  /** Convert a requested amount into an integer particle count, honouring
   *  quality density, distance falloff and the fractional accumulator. */
  function takeCount(pool, amount, rate, x, y, z) {
    if (!pool || pool.cap <= 0) return 0;
    let a = amount;
    if (!isFiniteNum(a) || a <= 0) return 0;
    a *= rate * state.emitScale;

    if (state.hasCamera) {
      const dx = x - state.camPos.x, dy = y - state.camPos.y, dz = z - state.camPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > CULL2) return 0;
      if (d2 > 2500) {
        // linear-ish falloff from 50 m out to the cull radius
        const t = (Math.sqrt(d2) - 50) / Math.max(CULL - 50, 1);
        a *= 1 - 0.72 * clamp01(t);
      }
    }

    pool.frac += a;
    let n = Math.floor(pool.frac);
    if (n <= 0) return 0;
    pool.frac -= n;
    if (n > MAX_BURST) { n = MAX_BURST; pool.frac = 0; }
    return n;
  }

  /**
   * Local ground height used for bounces and the smoke floor.
   * @param {Number} drop  assumed distance from the emit point down to the
   *                       surface (contact-patch emitters ~0, bodywork ~0.35)
   */
  function groundAt(x, y, z, drop) {
    if (state.groundAt) {
      try {
        const g = state.groundAt(x, z);
        if (isFiniteNum(g)) return g;
      } catch (e) { /* fall through */ }
    }
    if (state.usePlane) return state.groundY;
    // Emitters sit at the contact patch, so the emit height is the best
    // available local ground reference on banked / undulating track.
    return y - (isFiniteNum(drop) ? drop : 0.02);
  }

  /**
   * Direction-preserving, magnitude-capped velocity carry-over.
   * Physics may hand us the contact-patch slip velocity (a few m/s) or the raw
   * car velocity (80+ m/s); capping the inherited speed keeps a plume hanging
   * where it was shed instead of being fired down the straight, and makes the
   * effect look correct under either convention.
   * @returns {Number} multiplier to apply to the source velocity
   */
  function carryScale(speed, k, maxSpeed) {
    if (!(speed > 1e-4)) return 0;
    const want = speed * k;
    return (want > maxSpeed ? maxSpeed : want) / speed;
  }

  /** Read a Vector3-like into scratch. Returns false when unusable. */
  function readVec(v, out) {
    if (!v) return false;
    const x = v.x, y = v.y, z = v.z;
    if (!isFiniteNum(x) || !isFiniteNum(y) || !isFiniteNum(z)) return false;
    out.set(x, y, z);
    return true;
  }

  /* ======================================================================
   * Public emitters
   * ====================================================================== */

  /**
   * Tyre smoke — lock-ups, wheelspin, burnouts.
   * @param {Vector3} pos      contact patch position (world)
   * @param {Vector3} vel      slip velocity of the contact patch (world m/s)
   * @param {Number}  amount   particles requested this call (fractional ok)
   * @param {Number}  wetness  0 = dry grey smoke, 1 = white vapour
   */
  function emitTyreSmoke(pos, vel, amount, wetness) {
    try {
      const p = pools.smoke;
      if (!p) return;
      if (!readVec(pos, _scratchVecA)) return;
      if (!readVec(vel, _scratchVecB)) _scratchVecB.set(0, 0, 0);

      const w = clamp01(isFiniteNum(wetness) ? wetness : state.wetness);
      const dry = 1 - w;
      const n = takeCount(p, amount, 1, _scratchVecA.x, _scratchVecA.y, _scratchVecA.z);
      if (n <= 0) return;

      const px = _scratchVecA.x, py = _scratchVecA.y, pz = _scratchVecA.z;
      const vx = _scratchVecB.x, vy = _scratchVecB.y, vz = _scratchVecB.z;
      const slip = Math.sqrt(vx * vx + vy * vy + vz * vz);
      // How hard the tyre is smoking: taken from both the slip speed and the
      // requested rate, so it reads correctly under either calling convention.
      const heat = clamp01(0.6 * clamp01(slip / 22) + 0.7 * clamp01(amount / 8));
      const gy = groundAt(px, py, pz);
      const cs = carryScale(slip, 0.16 + 0.14 * heat, 10);

      for (let k = 0; k < n; k++) {
        const i = p.alloc();
        if (i < 0) return;

        // Birth around the contact patch, biased slightly rearward of the tyre
        const spread = 0.16 + 0.16 * heat;
        p.px[i] = px + rndc() * spread * 2;
        p.py[i] = py + 0.03 + rnd() * 0.14;
        p.pz[i] = pz + rndc() * spread * 2;

        // Smoke is dragged out of the contact patch, not fired out of it:
        // a capped fraction of the slip velocity plus a fat random puff.
        const jitter = 0.65 + 1.35 * rnd();
        p.vx[i] = vx * cs + rndc() * jitter;
        p.vz[i] = vz * cs + rndc() * jitter;
        p.vy[i] = 0.35 + rnd() * (0.85 + 0.9 * heat) + w * 1.15;

        p.age[i] = 0;
        p.life[i] = w > 0.5
          ? rndr(0.45, 0.95) + dry * 0.6
          : rndr(1.25, 2.55) + heat * 0.75;

        p.size[i] = rndr(0.26, 0.52) * (1 + 0.35 * heat);
        p.grow[i] = rndr(1.35, 2.55) * (1 + 0.55 * w);
        p.rot[i] = rnd() * TAU;
        p.rotv[i] = rndc() * (1.5 + 2.2 * rnd());
        p.seed[i] = rnd();
        p.gy[i] = gy;

        p.drag[i] = rndr(1.6, 2.6);
        p.grav[i] = 0.16 * dry;                 // rubber particulate has mass
        p.buoy[i] = rndr(0.55, 1.35) * (0.55 + 0.85 * heat) + w * 1.4;
        p.turb[i] = rndr(0.55, 1.35);
        p.wind[i] = rndr(0.55, 0.95);
        p.spread[i] = rndr(1.6, 3.4);           // ground-hugging lateral bloom

        // Colour: dry smoke is a warm grey (burnt rubber), wet is pure white
        // vapour that is almost invisible except against dark backgrounds.
        const base = w > 0.5 ? rndr(0.93, 1.0) : rndr(0.60, 0.80) - heat * 0.06;
        const warm = 0.030 * dry;
        p.r[i] = s2l(clamp01(base + warm));
        p.g[i] = s2l(clamp01(base + warm * 0.42));
        p.b[i] = s2l(clamp01(base - warm * 0.30));
        p.a[i] = dry * rndr(0.26, 0.46) * (0.65 + 0.55 * heat) + w * rndr(0.05, 0.11);
        p.aux[i] = 0;
        p.misc[i] = 0;
      }
    } catch (e) { /* never let an effect break the frame */ }
  }

  /**
   * Sparks — titanium skid blocks grounding out, or metal-on-metal contact.
   * @param {Vector3} pos    emission point (world)
   * @param {Vector3} vel    car velocity (world m/s); sparks trail from it
   * @param {Number}  amount particles requested this call
   */
  function emitSparks(pos, vel, amount) {
    try {
      const p = pools.spark;
      if (!p) return;
      if (!readVec(pos, _scratchVecA)) return;
      if (!readVec(vel, _scratchVecB)) _scratchVecB.set(0, 0, 0);

      const n = takeCount(p, amount, 1, _scratchVecA.x, _scratchVecA.y, _scratchVecA.z);
      if (n <= 0) return;

      const px = _scratchVecA.x, py = _scratchVecA.y, pz = _scratchVecA.z;
      const vx = _scratchVecB.x, vy = _scratchVecB.y, vz = _scratchVecB.z;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const gy = groundAt(px, py, pz);
      const wet = clamp01(state.wetness);

      for (let k = 0; k < n; k++) {
        const i = p.alloc();
        if (i < 0) return;

        p.px[i] = px + rndc() * 0.13;
        p.py[i] = py + rnd() * 0.05;
        p.pz[i] = pz + rndc() * 0.13;

        // Sparks are shed backwards: they keep a small fraction of car speed
        // and gain a wide cone of scatter, so the shower fans out behind.
        const carry = carryScale(speed, rndr(0.10, 0.34), 16);
        const scatter = 1.4 + rnd() * 3.4;
        p.vx[i] = vx * carry + rndc() * scatter;
        p.vz[i] = vz * carry + rndc() * scatter;
        p.vy[i] = vy * 0.1 + rndr(0.4, 3.1);

        p.age[i] = 0;
        p.life[i] = rndr(0.30, 0.85) * (1 - 0.35 * wet);
        p.size[i] = rndr(0.014, 0.038);          // streak width
        p.grow[i] = 0;
        p.rot[i] = 0;
        p.rotv[i] = 0;
        p.seed[i] = rnd();
        p.gy[i] = gy;

        p.drag[i] = rndr(0.55, 1.25);
        p.grav[i] = GRAVITY * rndr(0.85, 1.1);
        p.buoy[i] = 0;
        p.turb[i] = rndr(0.35, 1.1);
        p.wind[i] = 0.12;
        p.spread[i] = 0;

        // hot yellow-white cooling to orange, handled further in the shader
        p.r[i] = s2l(rndr(0.97, 1.0));
        p.g[i] = s2l(rndr(0.55, 0.80));
        p.b[i] = s2l(rndr(0.10, 0.26));
        p.a[i] = rndr(0.75, 1.0) * (1 - 0.4 * wet);

        p.aux[i] = clamp(0.05 + speed * 0.011, 0.05, 0.95);   // streak length
        p.misc[i] = 2 + (rnd() * 2 | 0);                      // bounces left
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * Dust & gravel — a car running wide onto the run-off.
   * @param {Vector3} pos
   * @param {Vector3} vel
   * @param {Number}  amount
   * @param {String}  surfaceType  track.surfaceAt().type
   */
  function emitDust(pos, vel, amount, surfaceType) {
    try {
      if (!readVec(pos, _scratchVecA)) return;
      if (!readVec(vel, _scratchVecB)) _scratchVecB.set(0, 0, 0);

      const surf = SURFACES[surfaceType] || SURFACES.gravel;
      const px = _scratchVecA.x, py = _scratchVecA.y, pz = _scratchVecA.z;
      const vx = _scratchVecB.x, vy = _scratchVecB.y, vz = _scratchVecB.z;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const energy = clamp01(speed / 40);
      const gy = groundAt(px, py, pz);
      const wet = clamp01(state.wetness);

      const p = pools.dust;
      if (p) {
        const cs = carryScale(speed, 0.28 + 0.22 * energy, 13);
        const n = takeCount(p, amount, 1, px, py, pz);
        for (let k = 0; k < n; k++) {
          const i = p.alloc();
          if (i < 0) break;

          p.px[i] = px + rndc() * 0.45;
          p.py[i] = py + 0.04 + rnd() * 0.22;
          p.pz[i] = pz + rndc() * 0.45;

          const jitter = 1.0 + 2.1 * rnd();
          p.vx[i] = vx * cs + rndc() * jitter;
          p.vz[i] = vz * cs + rndc() * jitter;
          p.vy[i] = 0.7 + rnd() * (1.5 + 2.6 * energy);

          p.age[i] = 0;
          p.life[i] = rndr(1.1, 2.4) * (1 - 0.45 * wet);
          p.size[i] = rndr(0.32, 0.72) * (1 + 0.4 * energy);
          p.grow[i] = rndr(1.0, 2.1);
          p.rot[i] = rnd() * TAU;
          p.rotv[i] = rndc() * 2.2;
          p.seed[i] = rnd();
          p.gy[i] = gy;

          p.drag[i] = rndr(1.5, 2.6);
          p.grav[i] = rndr(0.55, 1.35) * (1 + surf.coarse);   // dust settles back down
          p.buoy[i] = rndr(0.35, 0.95) * energy;
          p.turb[i] = rndr(0.45, 1.1);
          p.wind[i] = rndr(0.7, 1.05);
          p.spread[i] = rndr(1.2, 2.6);

          const j = surf.jitter;
          p.r[i] = s2l(clamp01(surf.r + rndc() * j));
          p.g[i] = s2l(clamp01(surf.g + rndc() * j));
          p.b[i] = s2l(clamp01(surf.b + rndc() * j));
          p.a[i] = rndr(0.28, 0.58) * (0.5 + 0.7 * energy) * (1 - 0.6 * wet);
          p.aux[i] = 0;
          p.misc[i] = 0;
        }
      }

      // tumbling stones thrown out of the trap
      const pb = pools.pebble;
      if (pb && surf.pebbles > 0.001) {
        const cs = carryScale(speed, 0.30 + 0.30 * energy, 17);
        const n = takeCount(pb, amount * surf.pebbles * 0.42, 1, px, py, pz);
        for (let k = 0; k < n; k++) {
          const i = pb.alloc();
          if (i < 0) break;

          p_initSolid(pb, i, px, py + 0.05, pz, gy);

          const jitter = 1.6 + 4.0 * rnd();
          pb.vx[i] = vx * cs + rndc() * jitter;
          pb.vz[i] = vz * cs + rndc() * jitter;
          pb.vy[i] = 1.6 + rnd() * (2.6 + 5.5 * energy);

          pb.life[i] = rndr(1.5, 3.2);
          pb.size[i] = rndr(0.035, 0.085) * (0.7 + 0.6 * surf.coarse);
          pb.drag[i] = rndr(0.22, 0.48);
          pb.grav[i] = GRAVITY;
          pb.rest[i] = rndr(0.16, 0.36);
          pb.fric[i] = rndr(0.45, 0.72);
          pb.turb[i] = 0;
          pb.wind[i] = 0.02;

          const j = surf.jitter;
          pb.r[i] = s2l(clamp01(surf.pr + rndc() * j));
          pb.g[i] = s2l(clamp01(surf.pg + rndc() * j));
          pb.b[i] = s2l(clamp01(surf.pb + rndc() * j));
          pb.a[i] = 0.35 + 0.4 * wet;            // wet stones are glossier
        }
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * Grass clippings — kicked up when a car cuts across the green.
   */
  function emitGrass(pos, vel, amount) {
    try {
      if (!readVec(pos, _scratchVecA)) return;
      if (!readVec(vel, _scratchVecB)) _scratchVecB.set(0, 0, 0);

      const px = _scratchVecA.x, py = _scratchVecA.y, pz = _scratchVecA.z;
      const vx = _scratchVecB.x, vy = _scratchVecB.y, vz = _scratchVecB.z;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const energy = clamp01(speed / 40);
      const gy = groundAt(px, py, pz);

      const p = pools.grass;
      if (p) {
        const cs = carryScale(speed, 0.24 + 0.22 * energy, 11);
        const n = takeCount(p, amount, 1, px, py, pz);
        for (let k = 0; k < n; k++) {
          const i = p.alloc();
          if (i < 0) break;

          p.px[i] = px + rndc() * 0.4;
          p.py[i] = py + 0.04 + rnd() * 0.12;
          p.pz[i] = pz + rndc() * 0.4;

          const jitter = 1.4 + 3.2 * rnd();
          p.vx[i] = vx * cs + rndc() * jitter;
          p.vz[i] = vz * cs + rndc() * jitter;
          p.vy[i] = 1.3 + rnd() * (2.2 + 4.4 * energy);

          p.age[i] = 0;
          p.life[i] = rndr(1.3, 2.9);
          p.size[i] = rndr(0.045, 0.115);
          p.grow[i] = 0;
          p.rot[i] = rnd() * TAU;
          p.rotv[i] = rndc() * 22;                 // clippings spin hard
          p.seed[i] = rnd();
          p.gy[i] = gy;

          p.drag[i] = rndr(2.2, 4.4);              // huge area, low mass
          p.grav[i] = GRAVITY * rndr(0.28, 0.5);
          p.buoy[i] = 0;
          p.turb[i] = rndr(1.4, 3.2);
          p.wind[i] = rndr(1.0, 1.8);
          p.spread[i] = 0;

          const shade = rndr(0.30, 0.62);
          const yellow = rnd() < 0.18 ? rndr(0.10, 0.26) : 0;
          p.r[i] = s2l(clamp01(shade * 0.52 + yellow));
          p.g[i] = s2l(clamp01(shade + yellow * 0.6));
          p.b[i] = s2l(clamp01(shade * 0.26));
          p.a[i] = 1;
          p.aux[i] = 0;
          p.misc[i] = 0;
        }
      }

      // a low, dark scuff of earth under the clippings
      if (pools.dust) emitDust(pos, vel, amount * 0.30, 'grass');
    } catch (e) { /* ignore */ }
  }

  /**
   * Carbon-fibre debris — front wing endplates, bargeboard shrapnel.
   */
  function emitDebris(pos, vel, amount) {
    try {
      const p = pools.debris;
      if (!p) return;
      if (!readVec(pos, _scratchVecA)) return;
      if (!readVec(vel, _scratchVecB)) _scratchVecB.set(0, 0, 0);

      const px = _scratchVecA.x, py = _scratchVecA.y, pz = _scratchVecA.z;
      const vx = _scratchVecB.x, vy = _scratchVecB.y, vz = _scratchVecB.z;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const gy = groundAt(px, py, pz, 0.35);   // contact happens at bodywork height

      const n = takeCount(p, amount, 1, px, py, pz);
      for (let k = 0; k < n; k++) {
        const i = p.alloc();
        if (i < 0) return;

        p_initSolid(p, i, px + rndc() * 0.3, py + rndc() * 0.3, pz + rndc() * 0.3, gy);

        const carry = carryScale(speed, rndr(0.25, 0.75), 15);
        const burst = 2.0 + rnd() * 6.5;
        p.vx[i] = vx * carry + rndc() * burst;
        p.vz[i] = vz * carry + rndc() * burst;
        p.vy[i] = rndr(0.5, 4.5) + clamp(speed * 0.05, 0, 3);

        p.life[i] = rndr(2.6, 5.5);
        p.size[i] = rndr(0.07, 0.24);
        p.drag[i] = rndr(0.85, 2.0);              // flat plates bleed speed fast
        p.grav[i] = GRAVITY * rndr(0.72, 0.95);
        p.rest[i] = rndr(0.10, 0.30);
        p.fric[i] = rndr(0.35, 0.65);
        p.turb[i] = rndr(0.8, 2.4);               // flutter while airborne
        p.wind[i] = rndr(0.25, 0.6);

        // spin hard about a random axis
        const ax = rndc(), ay = rndc(), az = rndc();
        const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
        const rate = rndr(6, 26);
        p.wx[i] = (ax / al) * rate;
        p.wy[i] = (ay / al) * rate;
        p.wz[i] = (az / al) * rate;

        // matte black carbon weave with the occasional painted livery fleck
        const painted = rnd() < 0.16;
        if (painted) {
          p.r[i] = s2l(rndr(0.35, 0.85));
          p.g[i] = s2l(rndr(0.25, 0.70));
          p.b[i] = s2l(rndr(0.20, 0.65));
          p.a[i] = 0.75;
        } else {
          const v = rndr(0.045, 0.12);
          p.r[i] = s2l(v);
          p.g[i] = s2l(v * 1.02);
          p.b[i] = s2l(v * 1.12);
          p.a[i] = 1.0;                            // strong clearcoat sheen
        }
      }

      // contact also scuffs a little dust off the surface
      if (pools.dust) emitDust(pos, vel, amount * 0.22, 'asphalt');
    } catch (e) { /* ignore */ }
  }

  /**
   * Wet-weather spray — the rooster tail off a wet track.
   */
  function emitSpray(pos, vel, amount) {
    try {
      const p = pools.spray;
      if (!p) return;
      if (!readVec(pos, _scratchVecA)) return;
      if (!readVec(vel, _scratchVecB)) _scratchVecB.set(0, 0, 0);

      const px = _scratchVecA.x, py = _scratchVecA.y, pz = _scratchVecA.z;
      const vx = _scratchVecB.x, vy = _scratchVecB.y, vz = _scratchVecB.z;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const energy = clamp01(speed / 70);
      const gy = groundAt(px, py, pz);
      const wet = clamp01(state.wetness > 0 ? state.wetness : 0.6);

      // mist is entrained by the wake, so it carries further than smoke does
      const cs = carryScale(speed, 0.42 + 0.30 * energy, 18);
      const n = takeCount(p, amount, 1, px, py, pz);
      for (let k = 0; k < n; k++) {
        const i = p.alloc();
        if (i < 0) return;

        p.px[i] = px + rndc() * 0.34;
        p.py[i] = py + 0.05 + rnd() * 0.30;
        p.pz[i] = pz + rndc() * 0.34;

        const jitter = 0.9 + 2.2 * rnd();
        p.vx[i] = vx * cs + rndc() * jitter;
        p.vz[i] = vz * cs + rndc() * jitter;
        p.vy[i] = 0.9 + rnd() * (1.8 + 3.6 * energy);

        p.age[i] = 0;
        p.life[i] = rndr(0.75, 1.85);
        p.size[i] = rndr(0.28, 0.70);
        p.grow[i] = rndr(2.2, 4.4);               // mist expands aggressively
        p.rot[i] = rnd() * TAU;
        p.rotv[i] = rndc() * 3.0;
        p.seed[i] = rnd();
        p.gy[i] = gy;

        p.drag[i] = rndr(2.2, 3.8);
        p.grav[i] = rndr(0.35, 0.95);             // water droplets fall back
        p.buoy[i] = rndr(0.25, 0.85) * energy;
        p.turb[i] = rndr(0.9, 2.1);
        p.wind[i] = rndr(0.9, 1.4);
        p.spread[i] = rndr(0.9, 2.0);

        const white = rndr(0.90, 1.0);
        p.r[i] = s2l(white * 0.97);
        p.g[i] = s2l(white * 0.985);
        p.b[i] = s2l(white);
        p.a[i] = rndr(0.055, 0.16) * (0.45 + 0.85 * energy) * (0.5 + 0.7 * wet);
        p.aux[i] = 0;
        p.misc[i] = 0;
      }
    } catch (e) { /* ignore */ }
  }

  /** Shared init for the quaternion-carrying solid pools. */
  function p_initSolid(p, i, x, y, z, gy) {
    p.px[i] = x; p.py[i] = y; p.pz[i] = z;
    p.age[i] = 0;
    p.rot[i] = 0; p.rotv[i] = 0;
    p.seed[i] = rnd();
    p.gy[i] = gy;
    p.buoy[i] = 0;
    p.spread[i] = 0;
    p.grow[i] = 0;
    p.aux[i] = 0;
    p.misc[i] = 0;

    // random unit quaternion
    const u1 = rnd(), u2 = rnd(), u3 = rnd();
    const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
    p.qx[i] = s1 * fsin(TAU * u2);
    p.qy[i] = s1 * fcos(TAU * u2);
    p.qz[i] = s2 * fsin(TAU * u3);
    p.qw[i] = s2 * fcos(TAU * u3);

    const rate = rndr(4, 18);
    const ax = rndc(), ay = rndc(), az = rndc();
    const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    p.wx[i] = (ax / al) * rate;
    p.wy[i] = (ay / al) * rate;
    p.wz[i] = (az / al) * rate;

    p.rest[i] = 0.25;
    p.fric[i] = 0.55;
  }

  /* ======================================================================
   * Integrators
   * ====================================================================== */

  /** Soft billboard puffs: smoke, dust and spray share this integrator. */
  function updatePuffs(p, dt, t, wx, wy, wz) {
    const m = p.matrix, col = p.color, dat = p.data;
    let i = 0;
    while (i < p.count) {
      const age = p.age[i] + dt;
      const life = p.life[i];
      if (age >= life) { p.removeAt(i); continue; }
      p.age[i] = age;
      const l = age / life;

      let vx = p.vx[i], vy = p.vy[i], vz = p.vz[i];

      // advection toward the ambient wind
      const kw = p.wind[i] * dt;
      vx += (wx - vx) * kw;
      vy += (wy - vy) * kw * 0.35;
      vz += (wz - vz) * kw;

      // buoyancy decays as the plume cools; gravity pulls particulate back
      vy += p.buoy[i] * (1 - l) * dt;
      vy -= p.grav[i] * dt;

      // curl-ish turbulence from the sine table (two evaluations per axis)
      const sd = p.seed[i];
      const tu = p.turb[i] * dt;
      vx += fsin(t * 1.73 + sd * 43.1) * tu;
      vz += fsin(t * 1.41 + sd * 91.7 + 2.1) * tu;
      vy += fsin(t * 2.17 + sd * 57.3 + 4.2) * tu * 0.45;

      // semi-implicit drag: unconditionally stable at any dt
      const d = 1 / (1 + p.drag[i] * dt);
      vx *= d; vy *= d; vz *= d;

      let x = p.px[i] + vx * dt;
      let y = p.py[i] + vy * dt;
      let z = p.pz[i] + vz * dt;

      // billowing expansion, decelerating
      let s = p.size[i] + p.grow[i] * dt;
      p.grow[i] *= 1 / (1 + 1.05 * dt);
      p.size[i] = s;

      // When the puff reaches the ground it stops sinking and rolls outward:
      // descent momentum is converted into lateral spread once, then a slow
      // continuing bloom takes over. Both are bounded so a long-lived puff
      // sitting on the surface can never accelerate away.
      const floor = p.gy[i] + s * 0.22;
      if (y < floor) {
        y = floor;
        const hs2 = vx * vx + vz * vz;
        if (vy < 0) {
          const push = -vy * 0.55;
          if (hs2 > 1e-4 && hs2 < 64) {
            const inv = push / Math.sqrt(hs2);
            vx += vx * inv;
            vz += vz * inv;
          }
          vy *= -0.10;
        }
        if (hs2 < 36) {
          const bloom = p.spread[i] * dt;
          vx += vx * bloom;
          vz += vz * bloom;
        }
      }

      p.vx[i] = vx; p.vy[i] = vy; p.vz[i] = vz;
      p.px[i] = x; p.py[i] = y; p.pz[i] = z;

      const rot = p.rot[i] + p.rotv[i] * dt;
      p.rot[i] = rot;
      p.rotv[i] *= 1 / (1 + 0.55 * dt);

      const o = i * 16;
      m[o] = s; m[o + 5] = s; m[o + 12] = x; m[o + 13] = y; m[o + 14] = z;

      const c = i * 4;
      col[c] = p.r[i]; col[c + 1] = p.g[i]; col[c + 2] = p.b[i]; col[c + 3] = p.a[i];
      dat[c] = l; dat[c + 1] = rot; dat[c + 2] = sd; dat[c + 3] = 0;

      i++;
    }
  }

  /** Ballistic streaks with a bounce off the local ground reference. */
  function updateSparks(p, dt, t, wx, wy, wz) {
    const m = p.matrix, col = p.color, dat = p.data, vel = p.vel;
    let i = 0;
    while (i < p.count) {
      const age = p.age[i] + dt;
      const life = p.life[i];
      if (age >= life) { p.removeAt(i); continue; }
      p.age[i] = age;
      const l = age / life;

      let vx = p.vx[i], vy = p.vy[i], vz = p.vz[i];

      vy -= p.grav[i] * dt;

      const kw = p.wind[i] * dt;
      vx += (wx - vx) * kw;
      vz += (wz - vz) * kw;

      const sd = p.seed[i];
      const tu = p.turb[i] * dt;
      vx += fsin(t * 6.1 + sd * 77.0) * tu;
      vz += fsin(t * 5.3 + sd * 51.0 + 1.7) * tu;

      const d = 1 / (1 + p.drag[i] * dt);
      vx *= d; vy *= d; vz *= d;

      let x = p.px[i] + vx * dt;
      let y = p.py[i] + vy * dt;
      let z = p.pz[i] + vz * dt;

      const gy = p.gy[i];
      if (y <= gy && vy < 0) {
        if (p.misc[i] > 0) {
          p.misc[i] -= 1;
          y = gy + 1e-3;
          vy = -vy * rndr(0.18, 0.42);
          vx *= rndr(0.55, 0.85);
          vz *= rndr(0.55, 0.85);
          // a bounce scatters the shower and shortens what is left of the life
          vx += rndc() * 0.9;
          vz += rndc() * 0.9;
          p.age[i] = age + life * 0.12;
        } else {
          y = gy + 1e-3;
          vy = 0;
          vx *= 0.35; vz *= 0.35;
          p.age[i] = Math.min(life - 1e-4, age + life * 0.30);
        }
      }

      p.vx[i] = vx; p.vy[i] = vy; p.vz[i] = vz;
      p.px[i] = x; p.py[i] = y; p.pz[i] = z;

      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const stretch = clamp(p.aux[i] * (0.35 + speed * 0.055), 0.03, 1.25);
      const s = p.size[i];

      const o = i * 16;
      m[o] = s; m[o + 5] = s; m[o + 12] = x; m[o + 13] = y; m[o + 14] = z;

      const c = i * 4;
      col[c] = p.r[i]; col[c + 1] = p.g[i]; col[c + 2] = p.b[i]; col[c + 3] = p.a[i];
      dat[c] = l; dat[c + 1] = 0; dat[c + 2] = sd; dat[c + 3] = stretch;

      const v3 = i * 3;
      vel[v3] = vx; vel[v3 + 1] = vy; vel[v3 + 2] = vz;

      i++;
    }
  }

  /** Alpha-cutout flecks (grass clippings) that flutter and settle flat. */
  function updateFlecks(p, dt, t, wx, wy, wz) {
    const m = p.matrix, col = p.color, dat = p.data;
    let i = 0;
    while (i < p.count) {
      const age = p.age[i] + dt;
      const life = p.life[i];
      if (age >= life) { p.removeAt(i); continue; }
      p.age[i] = age;
      const l = age / life;

      let vx = p.vx[i], vy = p.vy[i], vz = p.vz[i];
      const settled = p.misc[i] > 0.5;

      if (!settled) {
        vy -= p.grav[i] * dt;

        const kw = p.wind[i] * dt;
        vx += (wx - vx) * kw;
        vy += (wy - vy) * kw * 0.5;
        vz += (wz - vz) * kw;

        const sd = p.seed[i];
        const tu = p.turb[i] * dt;
        vx += fsin(t * 4.3 + sd * 61.0) * tu;
        vz += fsin(t * 3.7 + sd * 88.0 + 2.6) * tu;
        vy += fsin(t * 5.9 + sd * 33.0 + 1.1) * tu * 0.6;   // flutter

        const d = 1 / (1 + p.drag[i] * dt);
        vx *= d; vy *= d; vz *= d;
      } else {
        vx = 0; vy = 0; vz = 0;
      }

      let x = p.px[i] + vx * dt;
      let y = p.py[i] + vy * dt;
      let z = p.pz[i] + vz * dt;

      const floor = p.gy[i] + p.size[i] * 0.25;
      if (y < floor) {
        y = floor;
        if (Math.abs(vy) < 1.1) {
          p.misc[i] = 1;                 // lies flat on the ground
          p.rotv[i] = 0;
        } else {
          vy = -vy * 0.22;
          vx *= 0.6; vz *= 0.6;
        }
      }

      p.vx[i] = vx; p.vy[i] = vy; p.vz[i] = vz;
      p.px[i] = x; p.py[i] = y; p.pz[i] = z;

      const rot = p.rot[i] + p.rotv[i] * dt;
      p.rot[i] = rot;
      if (!settled) p.rotv[i] *= 1 / (1 + 0.9 * dt);

      // shrink away in the last 15% of life so the cutout can vanish cleanly
      const shrink = l > 0.85 ? (1 - (l - 0.85) / 0.15) : 1;
      const s = p.size[i] * shrink;

      const o = i * 16;
      m[o] = s * 0.55; m[o + 5] = s; m[o + 12] = x; m[o + 13] = y; m[o + 14] = z;

      const c = i * 4;
      col[c] = p.r[i]; col[c + 1] = p.g[i]; col[c + 2] = p.b[i]; col[c + 3] = p.a[i];
      dat[c] = l; dat[c + 1] = rot; dat[c + 2] = p.seed[i]; dat[c + 3] = 0;

      i++;
    }
  }

  /** Tumbling rigid solids with real angular velocity, bounce and settling. */
  function updateSolids(p, dt, t, wx, wy, wz, flutter) {
    const m = p.matrix, col = p.color, dat = p.data;
    let i = 0;
    while (i < p.count) {
      const age = p.age[i] + dt;
      const life = p.life[i];
      if (age >= life) { p.removeAt(i); continue; }
      p.age[i] = age;
      const l = age / life;

      let vx = p.vx[i], vy = p.vy[i], vz = p.vz[i];
      const settled = p.misc[i] > 0.5;

      let wxr = p.wx[i], wyr = p.wy[i], wzr = p.wz[i];

      if (!settled) {
        vy -= p.grav[i] * dt;

        const kw = p.wind[i] * dt;
        vx += (wx - vx) * kw;
        vz += (wz - vz) * kw;

        if (flutter) {
          // flat plates knife through the air: lateral lift tied to the spin
          const sd = p.seed[i];
          const tu = p.turb[i] * dt;
          vx += fsin(t * 7.3 + sd * 59.0) * tu;
          vz += fsin(t * 6.1 + sd * 83.0 + 2.2) * tu;
          vy += fsin(t * 9.1 + sd * 27.0 + 0.7) * tu * 0.85;
        }

        const d = 1 / (1 + p.drag[i] * dt);
        vx *= d; vy *= d; vz *= d;
      } else {
        vx = 0; vy = 0; vz = 0;
        wxr = 0; wyr = 0; wzr = 0;
      }

      let x = p.px[i] + vx * dt;
      let y = p.py[i] + vy * dt;
      let z = p.pz[i] + vz * dt;

      const radius = p.size[i] * 0.5;
      const floor = p.gy[i] + radius;
      if (y < floor) {
        y = floor;
        const impact = -vy;
        const rest = p.rest[i];
        if (impact > 0.55) {
          vy = impact * rest;
          const f = p.fric[i];
          vx *= f; vz *= f;
          // impact torque: the stone kicks into a new tumble
          wxr = wxr * 0.6 + rndc() * impact * 3.4;
          wyr = wyr * 0.6 + rndc() * impact * 3.4;
          wzr = wzr * 0.6 + rndc() * impact * 3.4;
        } else {
          // rolling / skidding to a halt
          vy = 0;
          const f = 1 / (1 + 5.5 * dt);
          vx *= f; vz *= f;
          wxr *= f; wyr *= f; wzr *= f;
          if ((vx * vx + vz * vz) < 0.02) {
            p.misc[i] = 1;
            // let it lie for a while, then fade with the rest of its life
            if (p.age[i] < life * 0.55) p.age[i] = life * 0.55;
          }
        }
      }

      p.vx[i] = vx; p.vy[i] = vy; p.vz[i] = vz;
      p.px[i] = x; p.py[i] = y; p.pz[i] = z;
      p.wx[i] = wxr; p.wy[i] = wyr; p.wz[i] = wzr;

      // quaternion integration: q += 0.5 * omega * q * dt, then renormalise
      let qx = p.qx[i], qy = p.qy[i], qz = p.qz[i], qw = p.qw[i];
      const h = dt * 0.5;
      const dqx = (wxr * qw + wyr * qz - wzr * qy) * h;
      const dqy = (wyr * qw + wzr * qx - wxr * qz) * h;
      const dqz = (wzr * qw + wxr * qy - wyr * qx) * h;
      const dqw = (-wxr * qx - wyr * qy - wzr * qz) * h;
      qx += dqx; qy += dqy; qz += dqz; qw += dqw;
      const ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
      const inv = 1 / ql;
      qx *= inv; qy *= inv; qz *= inv; qw *= inv;
      p.qx[i] = qx; p.qy[i] = qy; p.qz[i] = qz; p.qw[i] = qw;

      // shrink out over the final 12% of life so it disappears without popping
      const shrink = l > 0.88 ? (1 - (l - 0.88) / 0.12) : 1;
      const s = p.size[i] * shrink;

      const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
      const xx = qx * x2, xy = qx * y2, xz = qx * z2;
      const yy = qy * y2, yz = qy * z2, zz = qz * z2;
      const wxq = qw * x2, wyq = qw * y2, wzq = qw * z2;

      const o = i * 16;
      m[o] = (1 - (yy + zz)) * s;
      m[o + 1] = (xy + wzq) * s;
      m[o + 2] = (xz - wyq) * s;
      m[o + 4] = (xy - wzq) * s;
      m[o + 5] = (1 - (xx + zz)) * s;
      m[o + 6] = (yz + wxq) * s;
      m[o + 8] = (xz + wyq) * s;
      m[o + 9] = (yz - wxq) * s;
      m[o + 10] = (1 - (xx + yy)) * s;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z;

      const c = i * 4;
      col[c] = p.r[i]; col[c + 1] = p.g[i]; col[c + 2] = p.b[i]; col[c + 3] = p.a[i];
      dat[c] = l; dat[c + 1] = 0; dat[c + 2] = p.seed[i]; dat[c + 3] = 0;

      i++;
    }
  }

  /* ======================================================================
   * Frame update
   * ====================================================================== */

  function syncFog() {
    const fog = (scene && scene.fog) ? scene.fog : null;
    if (!fog) {
      if (uFogMode.value !== 0) uFogMode.value = 0;
      return;
    }
    if (fog.isFogExp2) {
      uFogMode.value = 2;
      uFogDensity.value = fog.density;
    } else {
      uFogMode.value = 1;
      uFogNear.value = fog.near;
      uFogFar.value = fog.far;
    }
    if (fog.color) uFogColor.value.copy(fog.color);
  }

  function update(dt, camera) {
    if (state.disposed) return;
    try {
      let step = dt;
      if (!isFiniteNum(step) || step <= 0) step = 0;
      if (step > 0.1) step = 0.1;               // never explode after a stall
      state.time += step;

      if (camera && camera.isCamera) {
        state.hasCamera = true;
        if (camera.matrixWorld) {
          const e = camera.matrixWorld.elements;
          state.camPos.set(e[12], e[13], e[14]);
        }
        // sun direction in view space, for the puff shading model
        if (camera.matrixWorldInverse) {
          uSunViewDir.value.copy(uSunWorldDir.value).transformDirection(camera.matrixWorldInverse);
        }
      }

      syncFog();

      if (step > 0) {
        const t = state.time;
        const wx = state.wind.x, wy = state.wind.y, wz = state.wind.z;
        if (pools.smoke) updatePuffs(pools.smoke, step, t, wx, wy, wz);
        if (pools.dust) updatePuffs(pools.dust, step, t, wx, wy, wz);
        if (pools.spray) updatePuffs(pools.spray, step, t, wx, wy, wz);
        if (pools.spark) updateSparks(pools.spark, step, t, wx, wy, wz);
        if (pools.grass) updateFlecks(pools.grass, step, t, wx, wy, wz);
        if (pools.pebble) updateSolids(pools.pebble, step, t, wx, wy, wz, false);
        if (pools.debris) updateSolids(pools.debris, step, t, wx, wy, wz, true);
      }

      for (let i = 0; i < poolList.length; i++) poolList[i].flush();
    } catch (e) {
      // A failed frame must not take the race with it: drop everything live
      // and keep going next frame.
      try { for (let i = 0; i < poolList.length; i++) poolList[i].clear(); } catch (e2) { /* ignore */ }
    }
  }

  /* ======================================================================
   * Control surface
   * ====================================================================== */

  function applyQuality() {
    const tierCaps = TIER_CAPS[state.tier];
    const d = clamp(state.density, 0, 1.5);
    state.emitScale = (TIER_EMIT[state.tier] || 1) * d;
    for (let i = 0; i < poolList.length; i++) {
      const p = poolList[i];
      const want = Math.round((tierCaps[p.name] || p.capacity) * clamp(d, 0.15, 1.5));
      p.cap = clamp(want, 0, p.capacity);
      if (p.count > p.cap) p.count = p.cap;
      if (p.recycle >= p.cap) p.recycle = 0;
    }
  }

  function setQuality(q) {
    try {
      if (typeof q === 'string') {
        state.tier = tierOf(q);
      } else if (q && typeof q === 'object') {
        if (typeof q.tier === 'string') state.tier = tierOf(q.tier);
        if (isFiniteNum(q.particles)) state.density = clamp(q.particles, 0, 1.5);
        if (isFiniteNum(q.anisotropy)) {
          const a = Math.max(1, q.anisotropy | 0);
          for (let i = 0; i < textures.length; i++) {
            if (textures[i].anisotropy !== a) { textures[i].anisotropy = a; textures[i].needsUpdate = true; }
          }
        }
      }
      applyQuality();
    } catch (e) { /* ignore */ }
  }

  /** Ambient wind. Accepts a Vector3-like, or {windSpeed, windDir} radians. */
  function setWind(a, b, c) {
    try {
      if (isFiniteNum(a)) {
        state.wind.set(a, isFiniteNum(b) ? b : 0, isFiniteNum(c) ? c : 0);
      } else if (a && isFiniteNum(a.x) && isFiniteNum(a.z)) {
        state.wind.set(a.x, isFiniteNum(a.y) ? a.y : 0, a.z);
      } else if (a && (isFiniteNum(a.speed) || isFiniteNum(a.windSpeed))) {
        const sp = isFiniteNum(a.speed) ? a.speed : a.windSpeed;
        const dir = isFiniteNum(a.dir) ? a.dir : (isFiniteNum(a.windDir) ? a.windDir : 0);
        state.wind.set(Math.sin(dir) * sp, 0, Math.cos(dir) * sp);
      }
    } catch (e) { /* ignore */ }
  }

  /** Pull wind + wetness straight out of the race weather state. */
  function setWeather(w) {
    try {
      if (!w || typeof w !== 'object') return;
      if (isFiniteNum(w.windSpeed)) setWind(w);
      if (isFiniteNum(w.trackWetness)) state.wetness = clamp01(w.trackWetness);
      if (isFiniteNum(w.rainIntensity)) state.rain = clamp01(w.rainIntensity);
    } catch (e) { /* ignore */ }
  }

  /**
   * Match the particle lighting to the sky module.
   * @param {Object} l  { direction, sunColor, skyColor, groundColor,
   *                      lightTint, shadowTint }  colours are hex or THREE.Color
   */
  function setLighting(l) {
    try {
      if (!l || typeof l !== 'object') return;
      const dir = l.direction || l.sunDirection;
      if (dir && isFiniteNum(dir.x)) {
        uSunWorldDir.value.set(dir.x, dir.y, dir.z);
        if (uSunWorldDir.value.lengthSq() > 1e-8) uSunWorldDir.value.normalize();
      }
      if (l.sunColor !== undefined) uSunColor.value.set(l.sunColor);
      if (l.skyColor !== undefined) uSkyColor.value.set(l.skyColor);
      if (l.groundColor !== undefined) uGroundColorU.value.set(l.groundColor);
      if (l.lightTint !== undefined) uLightTint.value.set(l.lightTint);
      if (l.shadowTint !== undefined) uShadowTint.value.set(l.shadowTint);
      if (l.sunColor !== undefined && l.lightTint === undefined) {
        // derive a sensible puff tint from the sun colour
        _scratchColor.copy(uSunColor.value).multiplyScalar(1.06);
        uLightTint.value.copy(_scratchColor);
      }
      if (l.skyColor !== undefined && l.shadowTint === undefined) {
        _scratchColor.copy(uSkyColor.value).multiplyScalar(1.25);
        uShadowTint.value.copy(_scratchColor);
      }
    } catch (e) { /* ignore */ }
  }

  /** Optional exact ground resolver: fn(x, z) -> world Y. */
  function setGroundResolver(fn) {
    state.groundAt = (typeof fn === 'function') ? fn : null;
  }

  /** Force a flat ground plane at `y` (used for bounces + the smoke floor). */
  function setGroundHeight(y) {
    if (isFiniteNum(y)) { state.groundY = y; state.usePlane = true; }
  }

  function reset() {
    try {
      for (let i = 0; i < poolList.length; i++) {
        const p = poolList[i];
        p.clear();
        p.flush();
      }
      state.time = 0;
    } catch (e) { /* ignore */ }
  }

  function getStats() {
    const out = {};
    for (let i = 0; i < poolList.length; i++) {
      const p = poolList[i];
      out[p.name] = { live: p.count, cap: p.cap, capacity: p.capacity };
    }
    return out;
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    try {
      for (let i = 0; i < poolList.length; i++) {
        const mesh = poolList[i].mesh;
        if (mesh.parent) mesh.parent.remove(mesh);
        if (typeof mesh.dispose === 'function') mesh.dispose();
      }
    } catch (e) { /* ignore */ }
    try { if (group.parent) group.parent.remove(group); } catch (e) { /* ignore */ }
    for (let i = 0; i < geometries.length; i++) {
      try { geometries[i].dispose(); } catch (e) { /* ignore */ }
    }
    for (let i = 0; i < materials.length; i++) {
      try { materials[i].dispose(); } catch (e) { /* ignore */ }
    }
    for (let i = 0; i < textures.length; i++) {
      try { textures[i].dispose(); } catch (e) { /* ignore */ }
    }
    geometries.length = 0;
    materials.length = 0;
    textures.length = 0;
    poolList.length = 0;
    for (const k in pools) delete pools[k];
  }

  // initial quality pass
  applyQuality();
  if (o.wind) setWind(o.wind);
  if (o.weather) setWeather(o.weather);
  if (o.sunDirection || o.sunColor || o.skyColor || o.groundColor) {
    setLighting({
      direction: o.sunDirection,
      sunColor: o.sunColor,
      skyColor: o.skyColor,
      groundColor: o.groundColor,
    });
  }

  const api = {
    update,
    emitTyreSmoke,
    emitSparks,
    emitDust,
    emitGrass,
    emitDebris,
    emitSpray,
    reset,
    dispose,
    setQuality,
    // extras
    setWind,
    setWeather,
    setLighting,
    setGroundResolver,
    setGroundHeight,
    getStats,
    group,
  };

  Object.defineProperty(api, 'activeCount', {
    enumerable: true,
    get() {
      let n = 0;
      for (let i = 0; i < poolList.length; i++) n += poolList[i].count;
      return n;
    },
  });

  return api;
}

export default createParticles;

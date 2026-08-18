/**
 * APEX F1 — src/render/effects.js
 * ---------------------------------------------------------------------------
 * The cinematic post-processing stack.
 *
 * Pass chain (high / ultra):
 *
 *    RenderPass  ->  VelocityBlurPass  ->  UnrealBloomPass  ->  LensFXPass  ->  OutputPass
 *    (scene+depth)   (reprojection +      (tight threshold,     (chromatic +     (tone map +
 *                     radial blur)         additive HDR)         barrel +         colour space)
 *                                                                vignette +
 *                                                                grain + dirt +
 *                                                                impact + flash)
 *
 * Everything upstream of OutputPass lives in linear HDR (HalfFloatType), so bloom,
 * lens dirt and the lightning flash all behave like real light.
 *
 * Depth handling
 * --------------
 * The velocity blur needs the scene depth buffer. EffectComposer ping-pongs between two
 * render targets, and a full-screen ShaderPass triggers renderer.autoClear on whichever
 * target it writes into — which would wipe a shared depth attachment. So:
 *
 *   - renderTarget1 is created WITHOUT any depth attachment (fullscreen quads don't need one).
 *   - renderTarget2 gets a dedicated DepthTexture. RenderPass always renders into `readBuffer`.
 *   - At the top of every frame we force `readBuffer = renderTarget2`, `writeBuffer = renderTarget1`
 *     so RenderPass deterministically lands in the depth-carrying target regardless of how many
 *     swapping passes ran last frame.
 *
 * Defensive contract
 * ------------------
 * Nothing in this module throws at the caller. If a pass fails to construct, or a frame throws,
 * the stack warns exactly once, sets `enabled = false` and degrades to a plain
 * renderer.render(scene, camera).
 *
 * @module render/effects
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ===========================================================================
 * Module-scope scratch. NEVER allocated inside update()/render().
 * Single-threaded, non-reentrant use only.
 * ======================================================================== */

const _scratchView = new THREE.Matrix4();
const _scratchSize = new THREE.Vector2();
const _scratchVec3 = new THREE.Vector3();
const _scratchVec3b = new THREE.Vector3();
const _scratchVec3c = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();
const _scratchColor = new THREE.Color();

/* ===========================================================================
 * One-shot warnings
 * ======================================================================== */

const _warnedKeys = new Set();

function warnOnce(key, message, err) {
    if (_warnedKeys.has(key)) return;
    _warnedKeys.add(key);
    try {
        if (err !== undefined && err !== null) {
            console.warn('[APEX FX] ' + message, err);
        } else {
            console.warn('[APEX FX] ' + message);
        }
    } catch (e) { /* console unavailable — nothing sensible to do */ }
}

/* ===========================================================================
 * Quality tiers
 * ======================================================================== */

/**
 * Per-tier presets. `postFX:false` means the composer is never built and the caller
 * is expected to render the scene directly (`enabled` reports false).
 */
export const POSTFX_TIERS = Object.freeze({
    low: Object.freeze({
        postFX: false,
        motionBlur: false,
        blurSamples: 0,
        bloom: false,
        bloomScale: 0.5,
        bloomStrength: 0.0,
        bloomRadius: 0.3,
        bloomThreshold: 0.95,
        chroma: false,
        distort: false,
        dirt: false,
        grain: false,
        dirtSize: 256,
        msaa: 0,
    }),
    medium: Object.freeze({
        postFX: true,
        motionBlur: false,
        blurSamples: 0,
        bloom: true,
        bloomScale: 0.5,
        bloomStrength: 0.42,
        bloomRadius: 0.30,
        bloomThreshold: 0.90,
        chroma: false,
        distort: false,
        dirt: false,
        grain: true,
        dirtSize: 256,
        msaa: 0,
    }),
    high: Object.freeze({
        postFX: true,
        motionBlur: true,
        blurSamples: 10,
        bloom: true,
        bloomScale: 0.75,
        bloomStrength: 0.55,
        bloomRadius: 0.35,
        bloomThreshold: 0.85,
        chroma: true,
        distort: true,
        dirt: true,
        grain: true,
        dirtSize: 512,
        msaa: 0,
    }),
    ultra: Object.freeze({
        postFX: true,
        motionBlur: true,
        blurSamples: 16,
        bloom: true,
        bloomScale: 1.0,
        bloomStrength: 0.62,
        bloomRadius: 0.40,
        bloomThreshold: 0.85,
        chroma: true,
        distort: true,
        dirt: true,
        grain: true,
        dirtSize: 1024,
        msaa: 4,
    }),
});

function resolveTierName(q) {
    if (typeof q === 'string') {
        const t = q.toLowerCase();
        if (POSTFX_TIERS[t]) return t;
        return 'high';
    }
    if (q && typeof q === 'object') {
        if (typeof q.tier === 'string' && POSTFX_TIERS[q.tier.toLowerCase()]) {
            return q.tier.toLowerCase();
        }
    }
    return 'high';
}

/* ===========================================================================
 * Procedural lens-dirt / streak texture
 *
 * Generated once per size with a canvas 2D context and shared (ref-counted)
 * between PostFX instances. No network access, no external images.
 * ======================================================================== */

const _dirtCache = new Map(); // size -> { texture, refs }

function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Paints a plausible piece of filthy optical glass: greasy smudges, dust motes,
 * fine radial scratches and a couple of long anamorphic wipe streaks.
 * @param {number} size square texture edge in px
 * @returns {HTMLCanvasElement|null}
 */
function paintLensDirtCanvas(size) {
    if (typeof document === 'undefined' || !document.createElement) return null;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!ctx) return null;

    const rnd = mulberry32(0x51F1CE);
    const S = size;

    // --- base: near black, faintly warm so the dirt never reads as pure grey
    ctx.fillStyle = '#040405';
    ctx.fillRect(0, 0, S, S);

    ctx.globalCompositeOperation = 'lighter';

    // --- broad greasy smudges (fingerprints, wiped rain film)
    const smudgeCount = Math.max(28, Math.round(S * 0.16));
    for (let i = 0; i < smudgeCount; i++) {
        const cx = rnd() * S;
        const cy = rnd() * S;
        const rad = (0.02 + rnd() * 0.13) * S;
        const squash = 0.28 + rnd() * 1.4;
        const rot = rnd() * Math.PI;
        const a = 0.020 + rnd() * 0.10;

        // very slightly tinted: cool on some smears, warm on others
        const warm = rnd();
        const cr = Math.round(150 + warm * 105);
        const cg = Math.round(150 + (1.0 - Math.abs(warm - 0.5) * 2.0) * 90);
        const cb = Math.round(160 + (1.0 - warm) * 95);

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.scale(1, squash);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
        g.addColorStop(0.0, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + a.toFixed(4) + ')');
        g.addColorStop(0.45, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a * 0.42).toFixed(4) + ')');
        g.addColorStop(1.0, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // --- dust motes and grit, denser toward the frame edges where muck collects
    const speckCount = Math.max(280, Math.round(S * 1.35));
    for (let i = 0; i < speckCount; i++) {
        let x = rnd();
        let y = rnd();
        // bias toward edges: push samples away from centre
        const bx = x - 0.5;
        const by = y - 0.5;
        const bias = 0.55 + 0.45 * rnd();
        x = 0.5 + bx * (1.0 + bias * 0.55);
        y = 0.5 + by * (1.0 + bias * 0.55);
        if (x < 0 || x > 1 || y < 0 || y > 1) continue;

        const px = x * S;
        const py = y * S;
        const r = (0.0006 + rnd() * rnd() * 0.0055) * S;
        const a = 0.05 + rnd() * rnd() * 0.55;
        const tint = 190 + Math.round(rnd() * 65);
        ctx.fillStyle = 'rgba(' + tint + ',' + tint + ',' + Math.min(255, tint + 12) + ',' + a.toFixed(4) + ')';
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
    }

    // --- fine scratches: mostly horizontal (wiper arcs / cloth wipes)
    const scratchCount = Math.max(14, Math.round(S * 0.05));
    for (let i = 0; i < scratchCount; i++) {
        const y0 = rnd() * S;
        const x0 = rnd() * S;
        const len = (0.12 + rnd() * 0.6) * S;
        const ang = (rnd() - 0.5) * 0.55 + (rnd() < 0.22 ? Math.PI * 0.5 : 0.0);
        const x1 = x0 + Math.cos(ang) * len;
        const y1 = y0 + Math.sin(ang) * len;
        const a = 0.035 + rnd() * 0.13;

        const lg = ctx.createLinearGradient(x0, y0, x1, y1);
        lg.addColorStop(0.0, 'rgba(0,0,0,0)');
        lg.addColorStop(0.5, 'rgba(225,232,255,' + a.toFixed(4) + ')');
        lg.addColorStop(1.0, 'rgba(0,0,0,0)');
        ctx.strokeStyle = lg;
        ctx.lineWidth = 0.4 + rnd() * (S / 380);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
    }

    // --- a few sweeping wiper arcs
    const arcCount = 6;
    for (let i = 0; i < arcCount; i++) {
        const cx = (rnd() * 1.6 - 0.3) * S;
        const cy = (rnd() * 1.6 - 0.3) * S;
        const rad = (0.25 + rnd() * 0.7) * S;
        const start = rnd() * Math.PI * 2;
        const sweep = 0.3 + rnd() * 1.1;
        const a = 0.018 + rnd() * 0.05;
        ctx.strokeStyle = 'rgba(206,216,240,' + a.toFixed(4) + ')';
        ctx.lineWidth = 0.8 + rnd() * (S / 260);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, start, start + sweep);
        ctx.stroke();
    }

    // --- long anamorphic wipe bands, the thing that sells a sun streak
    const bandCount = 5;
    for (let i = 0; i < bandCount; i++) {
        const y = rnd() * S;
        const h = (0.004 + rnd() * 0.03) * S;
        const a = 0.03 + rnd() * 0.09;
        const lg = ctx.createLinearGradient(0, y, S, y);
        lg.addColorStop(0.0, 'rgba(0,0,0,0)');
        lg.addColorStop(0.22 + rnd() * 0.1, 'rgba(190,205,255,' + a.toFixed(4) + ')');
        lg.addColorStop(0.55 + rnd() * 0.1, 'rgba(255,236,205,' + (a * 0.8).toFixed(4) + ')');
        lg.addColorStop(1.0, 'rgba(0,0,0,0)');
        ctx.fillStyle = lg;
        ctx.fillRect(0, y - h * 0.5, S, h);
    }

    // --- edge grime halo: real lenses are dirtiest at the barrel edge
    const eg = ctx.createRadialGradient(S * 0.5, S * 0.5, S * 0.22, S * 0.5, S * 0.5, S * 0.72);
    eg.addColorStop(0.0, 'rgba(0,0,0,0)');
    eg.addColorStop(1.0, 'rgba(150,160,190,0.07)');
    ctx.fillStyle = eg;
    ctx.fillRect(0, 0, S, S);

    ctx.globalCompositeOperation = 'source-over';

    // --- soften: real dirt is out of focus at the sensor plane
    try {
        if (typeof ctx.filter === 'string') {
            const blurred = document.createElement('canvas');
            blurred.width = S;
            blurred.height = S;
            const bctx = blurred.getContext('2d');
            if (bctx) {
                bctx.filter = 'blur(' + Math.max(1, S / 420).toFixed(2) + 'px)';
                bctx.drawImage(canvas, 0, 0);
                bctx.filter = 'none';
                return blurred;
            }
        }
    } catch (e) {
        warnOnce('dirtBlur', 'canvas filter blur unavailable, using unblurred lens dirt.', e);
    }

    return canvas;
}

/**
 * @param {number} size
 * @param {number} anisotropy
 * @returns {THREE.Texture} always returns something bindable (1x1 black fallback)
 */
function acquireLensDirt(size, anisotropy) {
    const key = size | 0;
    const hit = _dirtCache.get(key);
    if (hit) {
        hit.refs++;
        if (anisotropy > hit.texture.anisotropy) {
            hit.texture.anisotropy = anisotropy;
            hit.texture.needsUpdate = true;
        }
        return hit.texture;
    }

    let texture = null;
    try {
        const canvas = paintLensDirtCanvas(key);
        if (canvas) {
            texture = new THREE.CanvasTexture(canvas);
            texture.name = 'APEX.lensDirt';
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = true;
            texture.anisotropy = Math.max(1, anisotropy | 0);
            texture.needsUpdate = true;
        }
    } catch (e) {
        warnOnce('dirtTex', 'lens dirt texture generation failed; falling back to flat.', e);
        texture = null;
    }

    if (!texture) {
        // 1x1 black so the sampler is always bound to something valid.
        const data = new Uint8Array([0, 0, 0, 255]);
        texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
        texture.name = 'APEX.lensDirt.fallback';
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
    }

    _dirtCache.set(key, { texture, refs: 1 });
    return texture;
}

function releaseLensDirt(size) {
    const key = size | 0;
    const hit = _dirtCache.get(key);
    if (!hit) return;
    hit.refs--;
    if (hit.refs <= 0) {
        try { hit.texture.dispose(); } catch (e) { /* already gone */ }
        _dirtCache.delete(key);
    }
}

/* ===========================================================================
 * Shared GLSL
 * ======================================================================== */

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const GLSL_HASH = /* glsl */ `
float apexHash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
}

float apexHash13( vec3 p3 ) {
    p3 = fract( p3 * 0.1031 );
    p3 += dot( p3, p3.zyx + 31.32 );
    return fract( ( p3.x + p3.y ) * p3.z );
}
`;

/* ===========================================================================
 * Pass 1 — velocity / reprojection motion blur
 *
 * Reconstructs world position from the depth buffer, reprojects it with the
 * previous frame's view-projection matrix and smears along the resulting
 * screen-space delta. A cubic radial term is layered on top so the frame edges
 * streak outward at speed even when the camera is dead straight.
 * ======================================================================== */

const VelocityBlurShader = {
    name: 'ApexVelocityBlurShader',

    defines: {
        BLUR_SAMPLES: 10,
    },

    uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uIntensity: { value: 0.0 },
        uRadial: { value: 0.0 },
        uMaxBlur: { value: 0.045 },
        uCenterBias: { value: 0.35 },
        uTime: { value: 0.0 },
    },

    vertexShader: FULLSCREEN_VERTEX,

    fragmentShader: /* glsl */ `
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;

uniform mat4  uInvViewProj;
uniform mat4  uPrevViewProj;
uniform vec2  uTexel;
uniform float uIntensity;
uniform float uRadial;
uniform float uMaxBlur;
uniform float uCenterBias;
uniform float uTime;

${GLSL_HASH}

void main() {

    vec4 centerColor = texture2D( tDiffuse, vUv );

    // --- reconstruct world position from window-space depth
    float depth = texture2D( tDepth, vUv ).x;

    vec2 velocity = vec2( 0.0 );

    vec4 clip = vec4( vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
    vec4 world = uInvViewProj * clip;

    if ( abs( world.w ) > 1e-7 ) {

        world /= world.w;

        // --- reproject into the previous frame
        vec4 prevClip = uPrevViewProj * world;

        if ( prevClip.w > 1e-5 ) {

            vec2 prevUv = ( prevClip.xy / prevClip.w ) * 0.5 + 0.5;
            velocity = ( vUv - prevUv );

        }

    }

    velocity *= uIntensity;

    // --- radial streak: only really bites in the outer third of the frame
    vec2 toCentre = vUv - vec2( 0.5 );
    float rr = clamp( length( toCentre ) * 2.0, 0.0, 1.45 );
    velocity += toCentre * ( rr * rr * rr ) * uRadial;

    float len = length( velocity );

    if ( len > uMaxBlur ) {
        velocity *= uMaxBlur / len;
        len = uMaxBlur;
    }

    // sub-pixel motion is not worth 10 taps
    if ( len < uTexel.y ) {
        gl_FragColor = centerColor;
        return;
    }

    // --- dithered, centre-weighted tap loop
    float jitter = apexHash12( gl_FragCoord.xy + vec2( uTime * 37.13, uTime * 17.71 ) ) - 0.5;

    vec4 accum = vec4( 0.0 );
    float weightSum = 0.0;

    for ( int i = 0; i < BLUR_SAMPLES; i ++ ) {

        float t = ( float( i ) + 0.5 + jitter ) / float( BLUR_SAMPLES ) - 0.5;
        vec2 sampleUv = clamp( vUv + velocity * t, vec2( 0.0 ), vec2( 1.0 ) );

        float w = 1.0 - uCenterBias * abs( t ) * 2.0;
        accum += texture2D( tDiffuse, sampleUv ) * w;
        weightSum += w;

    }

    gl_FragColor = accum / max( weightSum, 1e-4 );

}
`,
};

/* ===========================================================================
 * Pass 2 — the lens / film pass
 *
 * Barrel distortion, radial chromatic aberration, lens dirt gated on the sun,
 * anamorphic streak, vignette, impact punch (shake + RGB split + desaturation),
 * full-screen flash and animated film grain. One pass, four texture taps.
 * ======================================================================== */

const LensFXShader = {
    name: 'ApexLensFXShader',

    defines: {
        USE_CHROMA: 1,
        USE_DISTORT: 1,
        USE_DIRT: 1,
        USE_GRAIN: 1,
    },

    uniforms: {
        tDiffuse: { value: null },
        tDirt: { value: null },

        uShake: { value: new THREE.Vector2(0, 0) },
        uAspect: { value: 16 / 9 },
        uTime: { value: 0 },

        uVignette: { value: 0.55 },
        uVigInner: { value: 0.42 },
        uVigOuter: { value: 1.12 },

        uChroma: { value: 0.0 },
        uDistort: { value: 0.0 },
        uGrain: { value: 0.035 },

        uSplit: { value: 0.0 },
        uDesat: { value: 0.0 },
        uExposure: { value: 1.0 },

        uFlashColor: { value: new THREE.Color(1, 1, 1) },
        uFlash: { value: 0.0 },

        uSun: { value: new THREE.Vector3(0.5, 0.5, 0.0) },
        uDirt: { value: 0.0 },
        uDirtTint: { value: new THREE.Color(1.0, 0.94, 0.82) },
    },

    vertexShader: FULLSCREEN_VERTEX,

    fragmentShader: /* glsl */ `
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tDirt;

uniform vec2  uShake;
uniform float uAspect;
uniform float uTime;

uniform float uVignette;
uniform float uVigInner;
uniform float uVigOuter;

uniform float uChroma;
uniform float uDistort;
uniform float uGrain;

uniform float uSplit;
uniform float uDesat;
uniform float uExposure;

uniform vec3  uFlashColor;
uniform float uFlash;

uniform vec3  uSun;
uniform float uDirt;
uniform vec3  uDirtTint;

${GLSL_HASH}

const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

void main() {

    // --- impact shake, applied as a screen offset so the game camera is never touched
    vec2 uv = vUv + uShake;

    // --- aspect-corrected radial basis
    vec2 c = ( uv - 0.5 ) * vec2( uAspect, 1.0 );
    float r2 = dot( c, c );

    #ifdef USE_DISTORT
        float k = 1.0 + uDistort * r2 + uDistort * 0.35 * r2 * r2;
        uv = 0.5 + vec2( c.x / uAspect, c.y ) * k;
    #endif

    vec3 col;

    #ifdef USE_CHROMA

        vec2 dir = c / max( sqrt( r2 ), 1e-4 );
        dir = vec2( dir.x / uAspect, dir.y );

        // Aberration grows with the square of the radius, like real glass. The
        // constants are in uv units: at uChroma = 1 the extreme corner separates by
        // ~0.0075 uv (about 10 px at 1280 wide), and the frame centre stays clean.
        // The impact split adds a hard lateral tear on top.
        float ca = uChroma * ( 0.0003 + r2 * 0.0072 );
        vec2 off = dir * ca + vec2( uSplit, 0.0 );

        col.r = texture2D( tDiffuse, clamp( uv + off, vec2( 0.0 ), vec2( 1.0 ) ) ).r;
        col.g = texture2D( tDiffuse, clamp( uv,       vec2( 0.0 ), vec2( 1.0 ) ) ).g;
        col.b = texture2D( tDiffuse, clamp( uv - off, vec2( 0.0 ), vec2( 1.0 ) ) ).b;

    #else

        col = texture2D( tDiffuse, clamp( uv, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb;

    #endif

    #ifdef USE_DIRT

        if ( uSun.z > 0.001 && uDirt > 0.001 ) {

            vec2 sd = ( vUv - uSun.xy ) * vec2( uAspect, 1.0 );
            float sdist2 = dot( sd, sd );

            // Cheap occlusion probe: pre-tonemap HDR, so an unobstructed sun disc is
            // enormously brighter than anything a grandstand or a wall can be.
            vec3 sunTap = texture2D( tDiffuse, clamp( uSun.xy, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb;
            float sunLum = dot( sunTap, LUMA );
            float occ = smoothstep( 0.75, 4.5, sunLum );

            float halo   = exp( -sdist2 * 5.5 );
            float wide   = exp( -sdist2 * 0.55 );
            float streak = exp( -abs( sd.y ) * 85.0 ) * exp( -abs( sd.x ) * 2.1 );

            vec3 grimeTex = texture2D( tDirt, vUv ).rgb;
            float grime = dot( grimeTex, vec3( 0.45, 0.4, 0.25 ) );

            float amt = uDirt * uSun.z * occ;

            col += uDirtTint * amt * (
                  grime * ( halo * 1.75 + wide * 0.35 )
                + streak * 0.40
                + halo * 0.08
            );

        }

    #endif

    // --- vignette (linear-light multiply == less light reaching the corners)
    float vr = length( ( vUv - 0.5 ) * vec2( uAspect, 1.0 ) ) / ( 0.5 * sqrt( uAspect * uAspect + 1.0 ) );
    float vig = 1.0 - smoothstep( uVigInner, uVigOuter, vr );
    col *= mix( 1.0, vig, clamp( uVignette, 0.0, 1.0 ) );

    // --- impact desaturation punch
    float lum = dot( col, LUMA );
    col = mix( col, vec3( lum ), clamp( uDesat, 0.0, 1.0 ) );

    col *= uExposure;

    // --- lightning / flag flash, additive in linear space so it genuinely blows out
    col += uFlashColor * uFlash;

    #ifdef USE_GRAIN

        float frame = floor( uTime * 24.0 );
        float g1 = apexHash13( vec3( gl_FragCoord.xy, frame ) );
        float g2 = apexHash13( vec3( gl_FragCoord.yx * 1.371, frame + 7.0 ) );
        float n = ( g1 - 0.5 ) * 0.85 + ( g2 - 0.5 ) * 0.15;

        // film grain is loudest in the mids and shadows, not the highlights
        float shadowBoost = 1.0 - smoothstep( 0.0, 0.75, dot( col, LUMA ) );
        col *= 1.0 + n * uGrain * ( 0.45 + 0.95 * shadowBoost );

    #endif

    gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );

}
`,
};

/* ===========================================================================
 * Factory
 * ======================================================================== */

/**
 * Builds the post-processing stack.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {Object} [opts]
 * @param {Object|string} [opts.quality]      quality tier object (see ARCHITECTURE.md) or tier name
 * @param {number}  [opts.width]              logical width  (defaults to renderer size)
 * @param {number}  [opts.height]             logical height (defaults to renderer size)
 * @param {number}  [opts.pixelRatio]         overrides renderer.getPixelRatio()
 * @param {number}  [opts.bloomStrength]
 * @param {number}  [opts.bloomRadius]
 * @param {number}  [opts.bloomThreshold]
 * @param {number}  [opts.vignette]           0..1 base vignette
 * @param {number}  [opts.chromatic]          0..1 base chromatic aberration
 * @param {number}  [opts.grain]              0..1 base film grain
 * @param {number}  [opts.distortion]         base barrel distortion coefficient
 * @param {number}  [opts.dirt]               0..1 lens dirt strength
 * @param {number}  [opts.motionBlur]         0..1 scale on the whole motion-blur effect
 * @param {number}  [opts.maxBlur]            uv clamp on blur length (default 0.045)
 * @param {number|false} [opts.msaa]          MSAA samples on the scene target
 * @param {THREE.Vector3} [opts.sunDirection] direction TO the sun (world space, normalised)
 * @param {number}  [opts.anisotropy]
 * @returns {Object} the PostFX handle
 */
export function createPostFX(renderer, scene, camera, opts) {

    const options = opts || {};

    /* --------------------------------------------------------------
     * Guard: without a renderer there is nothing sane to return, but
     * we still hand back a complete no-op API so callers never branch.
     * ----------------------------------------------------------- */
    if (!renderer || typeof renderer.render !== 'function') {
        warnOnce('noRenderer', 'createPostFX() called without a WebGLRenderer — returning inert stack.');
        return createInertPostFX(renderer, scene, camera);
    }

    /* ============================================================
     * State
     * ========================================================= */

    let composer = null;
    let renderPass = null;
    let blurPass = null;
    let bloomPass = null;
    let fxPass = null;
    let outputPass = null;

    let sceneDepthTexture = null;
    let dirtTexture = null;
    let dirtTextureSize = 0;

    let built = false;
    let capable = true;          // false once something has irrecoverably failed
    let userEnabled = options.enabled !== false;
    let postFXForcedOff = (options.postFX === false);
    let disposed = false;
    let consecutiveFailures = 0;

    let tierName = resolveTierName(options.quality !== undefined ? options.quality : options);
    let preset = POSTFX_TIERS[tierName];

    let pixelRatio = 1;
    let widthCSS = 1280;
    let heightCSS = 720;
    let sizedOnce = false;
    let msaaSamples = 0;

    // --- animated / driven parameters
    let time = 0;
    let speedTarget = 0;         // setSpeedBlur target
    let speed = 0;               // smoothed
    let impact = 0;              // decaying impact punch
    let shakePhase = 0;
    let flashStrength = 0;
    const flashColor = new THREE.Color(1, 1, 1);

    // --- tunables (base values, before speed/impact modulation)
    const base = {
        vignette: numOr(options.vignette, 0.55),
        chromatic: numOr(options.chromatic, 0.40),
        grain: numOr(options.grain, 0.035),
        distortion: numOr(options.distortion, 0.022),
        dirt: numOr(options.dirt, 0.65),
        motionBlur: numOr(options.motionBlur, 1.0),
        maxBlur: numOr(options.maxBlur, 0.045),
        exposureImpact: 0.16,
        bloomStrength: numOr(options.bloomStrength, NaN),
        bloomRadius: numOr(options.bloomRadius, NaN),
        bloomThreshold: numOr(options.bloomThreshold, NaN),
        blurShutter: numOr(options.blurShutter, 0.62),
        flashDecay: numOr(options.flashDecay, 9.0),
        impactDecay: numOr(options.impactDecay, 5.5),
    };

    // --- reprojection history (per instance, never scratch)
    const prevViewProj = new THREE.Matrix4();
    const curViewProj = new THREE.Matrix4();
    const prevCamPos = new THREE.Vector3();
    const prevCamQuat = new THREE.Quaternion();
    let historyValid = false;
    let camMatricesValid = false;
    const CUT_DIST_SQ = 900;      // 30 m in one frame == a camera cut
    const CUT_ANGLE = 0.75;       // ~43 deg in one frame == a camera cut

    // --- sun tracking for the lens dirt gate
    const sunDirection = new THREE.Vector3(0.35, 0.82, 0.45).normalize();
    let sunIntensity = 1.0;
    let sunAutoLight = null;

    if (options.sunDirection && options.sunDirection.isVector3) {
        sunDirection.copy(options.sunDirection);
        if (sunDirection.lengthSq() < 1e-8) sunDirection.set(0.35, 0.82, 0.45);
        sunDirection.normalize();
    }

    /* ============================================================
     * Helpers
     * ========================================================= */

    function numOr(v, d) {
        return (typeof v === 'number' && isFinite(v)) ? v : d;
    }

    function clamp01(v) {
        if (typeof v !== 'number' || !isFinite(v)) return 0;
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    /** Whether this tier + caller configuration permits a composer at all. */
    function postFXAllowed() {
        return preset.postFX === true && postFXForcedOff === false;
    }

    /**
     * Brings the camera's world/view matrices up to date exactly the way
     * WebGLRenderer.render() would, so reprojection and the sun projection both
     * use this frame's transform rather than last frame's.
     * @returns {boolean} success
     */
    function syncCamera() {
        camMatricesValid = false;
        try {
            if (!camera) return false;
            camera.updateMatrixWorld();
            camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
            _scratchView.copy(camera.matrixWorldInverse);
            curViewProj.multiplyMatrices(camera.projectionMatrix, _scratchView);
            camMatricesValid = true;
            return true;
        } catch (e) {
            warnOnce('camSync', 'camera matrix update failed; effects idle this frame.', e);
            return false;
        }
    }

    function readRendererSize() {
        try {
            renderer.getSize(_scratchSize);
            if (_scratchSize.x > 0 && _scratchSize.y > 0) {
                widthCSS = _scratchSize.x;
                heightCSS = _scratchSize.y;
            }
        } catch (e) { /* keep previous */ }

        // Explicit opts.width/height only seed the first read — after that setSize()
        // owns the dimensions, so a later setQuality() can't rewind a resize.
        if (!sizedOnce) {
            if (typeof options.width === 'number' && options.width > 0) widthCSS = options.width;
            if (typeof options.height === 'number' && options.height > 0) heightCSS = options.height;
        }

        try {
            pixelRatio = (typeof options.pixelRatio === 'number' && options.pixelRatio > 0)
                ? options.pixelRatio
                : (renderer.getPixelRatio() || 1);
        } catch (e) {
            pixelRatio = 1;
        }
        if (!isFinite(pixelRatio) || pixelRatio <= 0) pixelRatio = 1;
        pixelRatio = Math.min(pixelRatio, 4);
    }

    function resolveMSAA() {
        if (options.msaa === false) return 0;
        if (typeof options.msaa === 'number' && isFinite(options.msaa)) {
            return Math.max(0, Math.min(8, options.msaa | 0));
        }
        return preset.msaa | 0;
    }

    /**
     * Try to find a directional "sun" light in the scene once, so the lens dirt
     * has something believable to key off even if the caller never calls setSun().
     */
    function autoDetectSun() {
        if (!scene || typeof scene.traverse !== 'function') return;
        try {
            let best = null;
            let bestIntensity = -1;
            scene.traverse(function (obj) {
                if (obj && obj.isDirectionalLight && obj.intensity > bestIntensity) {
                    best = obj;
                    bestIntensity = obj.intensity;
                }
            });
            if (best) sunAutoLight = best;
        } catch (e) {
            warnOnce('sunDetect', 'sun auto-detection failed; using the default sun vector.', e);
        }
    }

    /* ============================================================
     * Construction / teardown of the pass chain
     * ========================================================= */

    function buildChain() {
        if (built || disposed || !capable) return built;
        if (!postFXAllowed()) return false;

        readRendererSize();
        msaaSamples = resolveMSAA();

        const devW = Math.max(1, Math.floor(widthCSS * pixelRatio));
        const devH = Math.max(1, Math.floor(heightCSS * pixelRatio));

        try {
            /* ---- render targets -------------------------------------------------
             * rt1: no depth at all — only fullscreen quads ever write to it.
             * rt2: carries the DepthTexture the velocity pass reads.
             * ------------------------------------------------------------------ */
            const rt1 = new THREE.WebGLRenderTarget(devW, devH, {
                type: THREE.HalfFloatType,
                format: THREE.RGBAFormat,
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                depthBuffer: false,
                stencilBuffer: false,
                generateMipmaps: false,
            });
            rt1.texture.name = 'APEX.postFX.rt1';
            rt1.texture.generateMipmaps = false;

            composer = new EffectComposer(renderer, rt1);
            composer.renderToScreen = true;

            // rt2 is where RenderPass lands (see the module header note), so it is the
            // one that needs a real depth attachment.
            const rt2 = composer.renderTarget2;
            rt2.texture.name = 'APEX.postFX.rt2';
            rt2.texture.generateMipmaps = false;
            rt2.depthBuffer = true;
            rt2.stencilBuffer = false;

            if (preset.motionBlur) {
                sceneDepthTexture = new THREE.DepthTexture(devW, devH, THREE.UnsignedIntType);
                sceneDepthTexture.name = 'APEX.postFX.depth';
                sceneDepthTexture.format = THREE.DepthFormat;
                sceneDepthTexture.minFilter = THREE.NearestFilter;
                sceneDepthTexture.magFilter = THREE.NearestFilter;
                sceneDepthTexture.generateMipmaps = false;
                rt2.depthTexture = sceneDepthTexture;
            }

            if (msaaSamples > 0) {
                try {
                    rt2.samples = msaaSamples;
                } catch (e) {
                    msaaSamples = 0;
                    warnOnce('msaa', 'MSAA render target unsupported; continuing without it.', e);
                }
            }

            /* ---- 1. scene ---- */
            renderPass = new RenderPass(scene, camera);
            renderPass.clear = true;
            composer.addPass(renderPass);

            /* ---- 2. velocity / reprojection motion blur ---- */
            if (preset.motionBlur) {
                try {
                    blurPass = new ShaderPass(VelocityBlurShader);
                    blurPass.material.defines = { BLUR_SAMPLES: preset.blurSamples | 0 };
                    blurPass.material.depthTest = false;
                    blurPass.material.depthWrite = false;
                    blurPass.material.needsUpdate = true;
                    blurPass.uniforms.tDepth.value = sceneDepthTexture;
                    blurPass.uniforms.uMaxBlur.value = base.maxBlur;
                    composer.addPass(blurPass);
                } catch (e) {
                    blurPass = null;
                    warnOnce('blurPass', 'motion blur pass failed to build; continuing without it.', e);
                }
            }

            /* ---- 3. bloom ---- */
            if (preset.bloom) {
                try {
                    const strength = isFinite(base.bloomStrength) ? base.bloomStrength : preset.bloomStrength;
                    const radius = isFinite(base.bloomRadius) ? base.bloomRadius : preset.bloomRadius;
                    const threshold = isFinite(base.bloomThreshold) ? base.bloomThreshold : preset.bloomThreshold;

                    _scratchSize.set(
                        Math.max(1, Math.floor(devW * preset.bloomScale)),
                        Math.max(1, Math.floor(devH * preset.bloomScale))
                    );
                    bloomPass = new UnrealBloomPass(_scratchSize, strength, radius, threshold);
                    composer.addPass(bloomPass);
                } catch (e) {
                    bloomPass = null;
                    warnOnce('bloomPass', 'bloom pass failed to build; continuing without it.', e);
                }
            }

            /* ---- 4. lens / film ---- */
            try {
                fxPass = new ShaderPass(LensFXShader);
                fxPass.material.depthTest = false;
                fxPass.material.depthWrite = false;
                applyFXDefines();

                dirtTextureSize = preset.dirtSize | 0;
                const aniso = numOr(options.anisotropy, 4);
                dirtTexture = acquireLensDirt(dirtTextureSize, aniso);
                fxPass.uniforms.tDirt.value = dirtTexture;

                composer.addPass(fxPass);
            } catch (e) {
                fxPass = null;
                warnOnce('fxPass', 'lens FX pass failed to build; continuing without it.', e);
            }

            /* ---- 5. tone mapping + colour space, always last ---- */
            outputPass = new OutputPass();
            composer.addPass(outputPass);

            // Nothing survived beyond the render pass — bypassing is cheaper than a copy.
            if (!blurPass && !bloomPass && !fxPass) {
                throw new Error('no effect passes constructed');
            }

            built = true;
            applySize(widthCSS, heightCSS, pixelRatio);
            autoDetectSun();
            return true;

        } catch (e) {
            warnOnce('build', 'post-processing stack failed to build; falling back to plain rendering.', e);
            capable = false;
            teardownChain();
            return false;
        }
    }

    function teardownChain() {
        try { if (renderPass && renderPass.dispose) renderPass.dispose(); } catch (e) { /* noop */ }
        try { if (blurPass) blurPass.dispose(); } catch (e) { /* noop */ }
        try { if (bloomPass) bloomPass.dispose(); } catch (e) { /* noop */ }
        try { if (fxPass) fxPass.dispose(); } catch (e) { /* noop */ }
        try { if (outputPass) outputPass.dispose(); } catch (e) { /* noop */ }

        try {
            if (composer) {
                if (composer.renderTarget1) composer.renderTarget1.dispose();
                if (composer.renderTarget2) composer.renderTarget2.dispose();
                composer.dispose();
                composer.passes.length = 0;
            }
        } catch (e) { /* noop */ }

        try { if (sceneDepthTexture) sceneDepthTexture.dispose(); } catch (e) { /* noop */ }

        if (dirtTexture) {
            releaseLensDirt(dirtTextureSize);
            dirtTexture = null;
            dirtTextureSize = 0;
        }

        composer = null;
        renderPass = null;
        blurPass = null;
        bloomPass = null;
        fxPass = null;
        outputPass = null;
        sceneDepthTexture = null;
        built = false;
        historyValid = false;
    }

    function applyFXDefines() {
        if (!fxPass) return;
        const defs = {};
        if (preset.chroma) defs.USE_CHROMA = 1;
        if (preset.distort) defs.USE_DISTORT = 1;
        if (preset.dirt) defs.USE_DIRT = 1;
        if (preset.grain) defs.USE_GRAIN = 1;
        fxPass.material.defines = defs;
        fxPass.material.needsUpdate = true;
    }

    /* ============================================================
     * Sizing
     * ========================================================= */

    function applySize(w, h, pr) {
        widthCSS = Math.max(1, w);
        heightCSS = Math.max(1, h);
        pixelRatio = Math.max(0.1, Math.min(4, pr));

        if (!composer) return;

        const devW = Math.max(1, Math.floor(widthCSS * pixelRatio));
        const devH = Math.max(1, Math.floor(heightCSS * pixelRatio));

        try {
            // setSize() first so the composer's cached logical size is in CSS pixels,
            // then setPixelRatio() re-runs the resize with the correct ratio. Doing it
            // the other way round briefly allocates targets at size * ratio squared.
            composer.setSize(widthCSS, heightCSS);
            composer.setPixelRatio(pixelRatio);
        } catch (e) {
            warnOnce('resize', 'composer resize failed.', e);
        }

        // Bloom runs at a fraction of the frame on lower tiers — re-apply after the
        // composer has stamped the full size onto every pass.
        if (bloomPass) {
            try {
                bloomPass.setSize(
                    Math.max(1, Math.floor(devW * preset.bloomScale)),
                    Math.max(1, Math.floor(devH * preset.bloomScale))
                );
            } catch (e) { /* keep default size */ }
        }

        if (blurPass) {
            blurPass.uniforms.uTexel.value.set(1 / devW, 1 / devH);
        }
        if (fxPass) {
            fxPass.uniforms.uAspect.value = devW / Math.max(1, devH);
        }

        historyValid = false;
    }

    /* ============================================================
     * Per-frame parameter update
     * ========================================================= */

    function updateDynamics(dt) {
        // Wrapped tight: uTime feeds hash functions where large magnitudes eat the
        // float32 mantissa and the grain/dither would visibly freeze.
        time += dt;
        if (time > 512) time -= 512;

        // smoothed speed so blur/aberration never pops on gear changes
        const k = Math.min(1, dt * 6.0);
        speed += (speedTarget - speed) * k;
        if (speed < 1e-4) speed = 0;

        // impact decays exponentially; the phase keeps running so repeated hits
        // don't restart the shake waveform in the same place every time
        if (impact > 0) {
            shakePhase += dt;
            impact *= Math.exp(-dt * base.impactDecay);
            if (impact < 0.002) impact = 0;
        }

        if (flashStrength > 0) {
            flashStrength *= Math.exp(-dt * base.flashDecay);
            if (flashStrength < 0.002) flashStrength = 0;
        }
    }

    function updateBlurUniforms(dt) {
        if (!blurPass) return;

        const u = blurPass.uniforms;

        if (!camMatricesValid) {
            u.uIntensity.value = 0;
            u.uRadial.value = 0;
            blurPass.enabled = false;
            return;
        }

        // --- detect camera cuts (chase -> onboard -> replay -> podium) and drop history
        let cut = false;
        _scratchVec3.setFromMatrixPosition(camera.matrixWorld);
        camera.getWorldQuaternion(_scratchQuat);

        if (historyValid) {
            if (_scratchVec3.distanceToSquared(prevCamPos) > CUT_DIST_SQ) {
                cut = true;
            } else {
                const d = Math.abs(
                    _scratchQuat.x * prevCamQuat.x +
                    _scratchQuat.y * prevCamQuat.y +
                    _scratchQuat.z * prevCamQuat.z +
                    _scratchQuat.w * prevCamQuat.w
                );
                if (2 * Math.acos(d > 1 ? 1 : d) > CUT_ANGLE) cut = true;
            }
        }

        prevCamPos.copy(_scratchVec3);
        prevCamQuat.copy(_scratchQuat);

        if (!historyValid || cut) {
            prevViewProj.copy(curViewProj);
            historyValid = true;
        }

        u.uInvViewProj.value.copy(curViewProj).invert();
        u.uPrevViewProj.value.copy(prevViewProj);

        /* Normalise the reprojection delta to a 60 Hz frame so blur length is a
         * function of car speed rather than of the machine's frame rate, then
         * apply the virtual shutter angle. */
        const frameNorm = dt > 1e-5 ? Math.min(3.0, (1 / 60) / dt) : 1.0;
        const drive = base.motionBlur * base.blurShutter * frameNorm;

        // 0.30 of the effect is always on (world detail passing the car), the rest ramps
        u.uIntensity.value = drive * (0.30 + 1.55 * speed);
        u.uRadial.value = base.motionBlur * 0.055 * speed * speed * Math.min(1.6, frameNorm);
        u.uMaxBlur.value = base.maxBlur;
        u.uCenterBias.value = 0.35;
        u.uTime.value = time;

        blurPass.enabled = (u.uIntensity.value > 1e-4 || u.uRadial.value > 1e-5);
    }

    function updateFXUniforms() {
        if (!fxPass) return;

        const u = fxPass.uniforms;
        const imp = impact;
        const imp2 = imp * imp;

        u.uTime.value = time;

        // --- shake: three detuned sinusoids per axis so it never reads as a loop
        if (imp > 0) {
            const t = shakePhase;
            const sx = (Math.sin(t * 61.7) * 0.55 + Math.sin(t * 103.3 + 1.7) * 0.30 + Math.sin(t * 23.9 + 0.4) * 0.15);
            const sy = (Math.cos(t * 57.1 + 2.1) * 0.50 + Math.sin(t * 89.7) * 0.35 + Math.cos(t * 31.3 + 1.1) * 0.15);
            u.uShake.value.set(sx * imp2 * 0.024, sy * imp2 * 0.019);
        } else if (u.uShake.value.x !== 0 || u.uShake.value.y !== 0) {
            u.uShake.value.set(0, 0);
        }

        // --- vignette closes in a little under load
        u.uVignette.value = Math.min(1.0, base.vignette * (1.0 + 0.22 * speed) + imp * 0.30);
        u.uVigInner.value = 0.42 - 0.06 * speed - 0.05 * imp;
        u.uVigOuter.value = 1.12 - 0.05 * imp;

        // --- aberration + barrel ramp with speed, spike on impact
        u.uChroma.value = base.chromatic * (0.22 + 0.78 * speed) + imp * 0.55;
        u.uDistort.value = base.distortion * (0.30 + 0.70 * speed) + imp * 0.018;
        u.uSplit.value = imp2 * 0.0075;

        u.uDesat.value = Math.min(0.85, imp * 0.62);
        u.uExposure.value = 1.0 + imp * base.exposureImpact - imp2 * 0.10;

        u.uGrain.value = base.grain * (1.0 + 0.55 * imp);

        u.uFlash.value = flashStrength;
        u.uFlashColor.value.copy(flashColor);

        // --- sun projection for the dirt gate
        if (preset.dirt) {
            updateSunUniform(u);
            u.uDirt.value = base.dirt;
        } else {
            u.uDirt.value = 0;
        }
    }

    function updateSunUniform(u) {
        if (!camMatricesValid) {
            u.uSun.value.z = 0;
            return;
        }

        try {
            if (sunAutoLight && sunAutoLight.parent !== null) {
                // direction TO the light, world space
                _scratchVec3.setFromMatrixPosition(sunAutoLight.matrixWorld);
                if (sunAutoLight.target) {
                    _scratchVec3b.setFromMatrixPosition(sunAutoLight.target.matrixWorld);
                    _scratchVec3.sub(_scratchVec3b);
                }
                if (_scratchVec3.lengthSq() > 1e-8) {
                    sunDirection.copy(_scratchVec3).normalize();
                }
            }

            // world-space camera origin (works for parented rig cameras too)
            _scratchVec3b.setFromMatrixPosition(camera.matrixWorld);

            // a point a long way along the sun direction
            _scratchVec3c.copy(sunDirection).multiplyScalar(1e5).add(_scratchVec3b);

            // View space first: the sign of z is the only reliable in-front test.
            // Projecting straight to NDC would flip x/y for points behind the camera
            // and would report "off screen" for anything past the far plane.
            _scratchVec3c.applyMatrix4(camera.matrixWorldInverse);
            const inFront = _scratchVec3c.z < -1e-3;

            _scratchVec3c.applyMatrix4(camera.projectionMatrix);

            const sx = _scratchVec3c.x * 0.5 + 0.5;
            const sy = _scratchVec3c.y * 0.5 + 0.5;

            // fade out as the sun leaves the frame rather than snapping off
            const mx = Math.max(0, -sx, sx - 1);
            const my = Math.max(0, -sy, sy - 1);
            const edgeFade = Math.max(0, 1 - Math.max(mx, my) * 5.0);

            u.uSun.value.set(
                sx < -0.5 ? -0.5 : (sx > 1.5 ? 1.5 : sx),
                sy < -0.5 ? -0.5 : (sy > 1.5 ? 1.5 : sy),
                inFront ? edgeFade * sunIntensity : 0
            );
        } catch (e) {
            u.uSun.value.z = 0;
        }
    }

    /* ============================================================
     * Fallback path
     * ========================================================= */

    function renderPlain() {
        try {
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);
        } catch (e) {
            warnOnce('plainRender', 'direct scene render failed.', e);
        }
    }

    /* ============================================================
     * Public methods
     * ========================================================= */

    function isEnabled() {
        return !disposed && capable && userEnabled && postFXAllowed() && built && composer !== null;
    }

    /**
     * Renders one frame. Never throws.
     * @param {number} [dt] seconds since the last frame
     */
    function render(dt) {
        if (disposed) return;

        let step = (typeof dt === 'number' && isFinite(dt)) ? dt : 1 / 60;
        if (step < 0) step = 0;
        if (step > 0.1) step = 0.1;

        if (!isEnabled()) {
            // Callers that honour `enabled` render the scene themselves; callers that
            // just call render() every frame still get a picture.
            const canLateBuild = capable && userEnabled && postFXAllowed() && !built;
            if (!canLateBuild || !buildChain()) {
                renderPlain();
                return;
            }
        }

        try {
            updateDynamics(step);
            syncCamera();
            updateBlurUniforms(step);
            updateFXUniforms();

            /* Deterministic ping-pong parity: RenderPass writes into readBuffer, and
             * renderTarget2 is the buffer carrying our DepthTexture. Forcing the pair
             * every frame makes the depth attachment independent of how many swapping
             * passes were enabled last frame. */
            composer.readBuffer = composer.renderTarget2;
            composer.writeBuffer = composer.renderTarget1;

            composer.render(step);

            // history for the next reprojection
            if (camMatricesValid) prevViewProj.copy(curViewProj);

            consecutiveFailures = 0;

        } catch (e) {
            consecutiveFailures++;
            warnOnce('renderFail', 'post-processing frame threw; falling back to plain rendering.', e);
            if (consecutiveFailures >= 3) {
                capable = false;
                teardownChain();
            }
            renderPlain();
        }
    }

    /**
     * @param {number} w logical (CSS) width
     * @param {number} h logical (CSS) height
     * @param {number} [pr] device pixel ratio override
     */
    function setSize(w, h, pr) {
        if (disposed) return;
        const nw = (typeof w === 'number' && w > 0) ? w : widthCSS;
        const nh = (typeof h === 'number' && h > 0) ? h : heightCSS;

        let npr = pr;
        if (typeof npr !== 'number' || !isFinite(npr) || npr <= 0) {
            if (typeof options.pixelRatio === 'number' && options.pixelRatio > 0) {
                npr = options.pixelRatio;
            } else {
                try { npr = renderer.getPixelRatio() || 1; } catch (e) { npr = pixelRatio; }
            }
        }

        if (typeof pr === 'number' && isFinite(pr) && pr > 0) options.pixelRatio = pr;
        sizedOnce = true;

        try {
            applySize(nw, nh, npr);
        } catch (e) {
            warnOnce('setSize', 'setSize failed.', e);
        }
    }

    /**
     * @param {Object|string} q quality tier object (ARCHITECTURE.md) or tier name
     */
    function setQuality(q) {
        if (disposed) return;

        const newTier = resolveTierName(q);
        const forceOff = !!(q && typeof q === 'object' && q.postFX === false);

        if (typeof q === 'object' && q !== null) {
            if (typeof q.pixelRatio === 'number' && q.pixelRatio > 0) {
                options.pixelRatio = q.pixelRatio;
            }
            if (typeof q.anisotropy === 'number' && q.anisotropy > 0) {
                options.anisotropy = q.anisotropy;
            }
        }

        const tierChanged = (newTier !== tierName);
        tierName = newTier;
        preset = POSTFX_TIERS[tierName];
        postFXForcedOff = forceOff;

        if (!postFXAllowed()) {
            // 'low' (or an explicit postFX:false) — release everything and let the
            // caller render the scene directly. `enabled` now reports false.
            if (built) teardownChain();
            return;
        }

        if (!built) {
            buildChain();
            return;
        }

        if (tierChanged) {
            // Structural change (motion blur on/off, dirt resolution, MSAA) — rebuild.
            teardownChain();
            capable = true;
            buildChain();
            return;
        }

        // Same tier, possibly a new pixel ratio.
        readRendererSize();
        applySize(widthCSS, heightCSS, pixelRatio);
    }

    /**
     * Drives the motion blur / aberration ramp. Feed it normalised car speed.
     * @param {number} amount01
     */
    function setSpeedBlur(amount01) {
        speedTarget = clamp01(amount01);
    }

    /**
     * Punch the frame: shake + RGB split + desaturation. Decays on its own.
     * @param {number} strength01
     */
    function setImpact(strength01) {
        const s = clamp01(strength01);
        if (s > impact) {
            impact = s;
            // nudge the phase so back-to-back hits don't replay identically
            shakePhase += 0.37 + s * 0.61;
        }
    }

    /**
     * Full-screen additive colour flash (lightning, pit lights, flag flashes).
     * Additive in linear space, applied after bloom so it stays hard-edged.
     * @param {THREE.Color|number|string} color
     * @param {number} strength
     */
    function setFlash(color, strength) {
        try {
            if (color !== undefined && color !== null) {
                if (color.isColor) {
                    flashColor.copy(color);
                } else {
                    _scratchColor.set(color);
                    flashColor.copy(_scratchColor);
                }
            }
        } catch (e) {
            flashColor.setRGB(1, 1, 1);
        }
        const s = (typeof strength === 'number' && isFinite(strength)) ? Math.max(0, strength) : 1;
        if (s > flashStrength) flashStrength = s;
    }

    /** @param {number} amount01 */
    function setVignette(amount01) {
        base.vignette = clamp01(amount01);
    }

    /** @param {number} amount01 */
    function setChromatic(amount01) {
        base.chromatic = clamp01(amount01);
    }

    /** @param {number} amount01 */
    function setGrain(amount01) {
        base.grain = Math.max(0, Math.min(0.5, numOr(amount01, base.grain)));
    }

    /** @param {number} amount barrel distortion coefficient (0 .. ~0.15) */
    function setDistortion(amount) {
        base.distortion = Math.max(0, Math.min(0.4, numOr(amount, base.distortion)));
    }

    /** @param {number} amount01 lens dirt / sun streak strength */
    function setDirt(amount01) {
        base.dirt = clamp01(amount01);
    }

    /** @param {number} scale overall multiplier on the motion blur effect */
    function setMotionBlur(scale) {
        base.motionBlur = Math.max(0, numOr(scale, base.motionBlur));
    }

    /**
     * @param {Object} params { strength, radius, threshold }
     */
    function setBloom(params) {
        if (!params) return;
        if (typeof params.strength === 'number') base.bloomStrength = params.strength;
        if (typeof params.radius === 'number') base.bloomRadius = params.radius;
        if (typeof params.threshold === 'number') base.bloomThreshold = params.threshold;
        if (!bloomPass) return;
        try {
            if (isFinite(base.bloomStrength)) bloomPass.strength = base.bloomStrength;
            if (isFinite(base.bloomRadius)) bloomPass.radius = base.bloomRadius;
            if (isFinite(base.bloomThreshold)) bloomPass.threshold = base.bloomThreshold;
        } catch (e) { /* noop */ }
    }

    /**
     * World-space direction TO the sun, plus how much of it is getting through
     * (0 in an overcast storm, 1 at high noon). Drives the lens dirt gate.
     * @param {THREE.Vector3} dir
     * @param {number} [intensity01]
     */
    function setSun(dir, intensity01) {
        try {
            if (dir && typeof dir.x === 'number') {
                _scratchVec3.set(dir.x, dir.y, dir.z);
                if (_scratchVec3.lengthSq() > 1e-8) {
                    sunDirection.copy(_scratchVec3).normalize();
                }
            }
        } catch (e) { /* keep previous */ }
        if (typeof intensity01 === 'number' && isFinite(intensity01)) {
            sunIntensity = Math.max(0, Math.min(1, intensity01));
        }
        // an explicit sun overrides whatever light we auto-detected
        sunAutoLight = null;
    }

    /** Binds the sun gate to a scene DirectionalLight (position is tracked each frame). */
    function setSunLight(light) {
        sunAutoLight = (light && light.isLight) ? light : null;
    }

    /** Drops the reprojection history — call after a camera cut you know about. */
    function resetHistory() {
        historyValid = false;
    }

    /** @param {boolean} b */
    function setEnabled(b) {
        if (disposed) return;
        userEnabled = !!b;
        if (userEnabled && capable && postFXAllowed() && !built) {
            buildChain();
        }
    }

    /**
     * Swap the camera the stack renders and reprojects with (chase / onboard /
     * trackside / replay). Drops the motion-blur history so the cut doesn't smear.
     * @param {THREE.Camera} cam
     */
    function setCamera(cam) {
        if (!cam || !cam.isCamera) return;
        camera = cam;
        if (renderPass) renderPass.camera = cam;
        historyValid = false;
        camMatricesValid = false;
    }

    /**
     * Swap the rendered scene (garage / grid / race / podium).
     * @param {THREE.Scene} sc
     */
    function setScene(sc) {
        if (!sc || !sc.isScene) return;
        scene = sc;
        if (renderPass) renderPass.scene = sc;
        sunAutoLight = null;
        historyValid = false;
    }

    /** @param {number} samples MSAA samples on the scene target (0 disables) */
    function setMSAA(samples) {
        const s = Math.max(0, Math.min(8, (typeof samples === 'number' ? samples : 0) | 0));
        options.msaa = s === 0 ? false : s;
        if (!built) return;
        try {
            if (composer && composer.renderTarget2) {
                composer.renderTarget2.samples = s;
                msaaSamples = s;
            }
        } catch (e) {
            warnOnce('msaaSet', 'MSAA change rejected.', e);
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        teardownChain();
        capable = false;
    }

    /* ============================================================
     * Boot
     * ========================================================= */

    readRendererSize();
    if (postFXAllowed() && userEnabled) {
        buildChain();
    }

    /* ============================================================
     * Handle
     * ========================================================= */

    const api = {
        render,
        update: render,          // alias for callers that name it update()
        setSize,
        setQuality,
        setSpeedBlur,
        setImpact,
        setFlash,
        setVignette,
        setChromatic,
        setGrain,
        setDistortion,
        setDirt,
        setMotionBlur,
        setBloom,
        setSun,
        setSunLight,
        setMSAA,
        setCamera,
        setScene,
        resetHistory,
        setEnabled,
        dispose,
    };

    Object.defineProperties(api, {
        enabled: { get: isEnabled, enumerable: true },
        composer: { get: function () { return composer; }, enumerable: true },
        tier: { get: function () { return tierName; }, enumerable: true },
        passes: {
            get: function () {
                return {
                    render: renderPass,
                    motionBlur: blurPass,
                    bloom: bloomPass,
                    lens: fxPass,
                    output: outputPass,
                };
            },
            enumerable: true,
        },
        depthTexture: { get: function () { return sceneDepthTexture; }, enumerable: false },
        isPostFX: { value: true, enumerable: false },
    });

    return api;
}

/* ===========================================================================
 * Inert stack — same shape, does nothing, never throws.
 * ======================================================================== */

function createInertPostFX(renderer, scene, camera) {
    const noop = function () {};
    const api = {
        render: function () {
            try {
                if (renderer && scene && camera) {
                    renderer.setRenderTarget(null);
                    renderer.render(scene, camera);
                }
            } catch (e) { /* nothing left to try */ }
        },
        update: null,
        setSize: noop,
        setQuality: noop,
        setSpeedBlur: noop,
        setImpact: noop,
        setFlash: noop,
        setVignette: noop,
        setChromatic: noop,
        setGrain: noop,
        setDistortion: noop,
        setDirt: noop,
        setMotionBlur: noop,
        setBloom: noop,
        setSun: noop,
        setSunLight: noop,
        setMSAA: noop,
        setCamera: noop,
        setScene: noop,
        resetHistory: noop,
        setEnabled: noop,
        dispose: noop,
    };
    api.update = api.render;

    Object.defineProperties(api, {
        enabled: { get: function () { return false; }, enumerable: true },
        composer: { get: function () { return null; }, enumerable: true },
        tier: { get: function () { return 'low'; }, enumerable: true },
        passes: { get: function () { return {}; }, enumerable: true },
        isPostFX: { value: true, enumerable: false },
    });

    return api;
}

export default createPostFX;

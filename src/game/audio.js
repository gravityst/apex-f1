/**
 * APEX F1 — Procedural audio engine.
 * ---------------------------------------------------------------------------
 * Everything you hear is synthesised at runtime with the WebAudio API.
 * There are no audio files anywhere in this project and this module performs
 * ZERO network requests.
 *
 * Signal architecture
 * -------------------
 *                                    ┌──────────────┐
 *   engine banks A/B ─┐              │  convolver   │  (procedural IR)
 *   intake honk       │              └──────┬───────┘
 *   turbo whistle     ├─► engineCore ─► shiftCut ─► limiterCut ─┐
 *   MGU-K / MGU-H     │                                         │
 *   exhaust pops ─────┴───────────────────────────────────────► engineOut ─┐
 *   tyre squeal / scrub / wet hiss ──────────────────────────► tyreBus ────┤
 *   wind / air ──────────────────────────────────────────────► windBus ────┼─► worldBus
 *   AI cars (HRTF panners, pooled) ──────────────────────────► aiBus ──────┤      │
 *   kerbs / impacts / DRS / mechanical ──────────────────────► sfxBus ─────┤      │
 *   rain + trackside ambience ───────────────────────────────► ambBus ─────┘      │
 *                                                                                 ▼
 *   UI + team radio ─────────────────────────────────► uiBus ──┐        cabinLP ─► cabinHP
 *                                                              │              │
 *                                                              ▼              ├─► reverbSend ─► convolver ─► reverbReturn
 *                                                          mixBus ◄───────────┘                                   │
 *                                                              │◄──────────────────────────────────────────────────┘
 *                                                              ▼
 *                                                        compressor ─► master ─► destination
 *
 * The engine note is real additive synthesis: a stack of sine partials at
 * fractional and integer multiples of the firing frequency, split across two
 * detuned "banks" so the V6 growls with firing-order irregularity instead of
 * whining like a saw. Per-partial gains are re-weighted every 33 ms from rpm
 * and load, so the timbre opens up under power and goes hollow on the overrun.
 *
 * No allocations happen in update(). All scratch storage is pre-allocated at
 * module scope or inside the closure at init time.
 */

/* ========================================================================== *
 *  Math + small helpers (module scope, zero allocation)
 * ========================================================================== */

const TWO_PI = Math.PI * 2;
const SPEED_OF_SOUND = 343.0;

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function lerp(a, b, t) { return a + (b - a) * t; }

function smoothstep(e0, e1, x) {
  const d = e1 - e0;
  const t = clamp01(d === 0 ? 0 : (x - e0) / d);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. */
function approach(cur, tgt, dt, tau) {
  if (!(tau > 1e-5)) return tgt;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (tgt - cur) * k;
}

function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }

/** Safe AudioParam ramp. Never throws, never zippers. */
function sp(param, value, now, tau) {
  if (!param) return;
  const v = isNum(value) ? value : 0;
  param.setTargetAtTime(v, now, tau > 0.0005 ? tau : 0.005);
}

/** Safe AudioParam ramp for frequency-like params (must stay > 0). */
function spf(param, value, now, tau, lo, hi) {
  if (!param) return;
  let v = isNum(value) ? value : lo;
  if (v < lo) v = lo; else if (v > hi) v = hi;
  param.setTargetAtTime(v, now, tau > 0.0005 ? tau : 0.005);
}

/** Shared onended handler — `this` is the node, so no closure is allocated. */
function _selfDisconnect() {
  try { this.disconnect(); } catch (e) { /* already gone */ }
}

/** Shared onended handler that also tears down an attached chain. */
function _chainDisconnect() {
  try { this.disconnect(); } catch (e) { /* ignore */ }
  const c = this._apexChain;
  if (c) {
    for (let i = 0; i < c.length; i++) { try { c[i].disconnect(); } catch (e) { /* ignore */ } }
    this._apexChain = null;
  }
}

/** Deterministic xorshift32 — used for every procedural buffer. */
function makeRng(seed) {
  let s = (seed | 0) || 0x9e3779b9;
  return function rng() {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return ((s >>> 0) / 4294967296);
  };
}

/* ========================================================================== *
 *  Engine partial table.
 *  m  : multiple of the firing frequency (0.5 steps produce the half-order
 *       "bank" components that give a V6 its growl)
 *  lo : partial weight on a closed throttle
 *  hi : partial weight at full load
 *  Ordered by perceptual importance so low quality tiers can slice the head.
 * ========================================================================== */
const HARMONICS = [
  { m: 1.0,  lo: 0.86, hi: 1.00, half: false },
  { m: 0.5,  lo: 0.30, hi: 0.64, half: true  },
  { m: 2.0,  lo: 0.52, hi: 0.88, half: false },
  { m: 1.5,  lo: 0.27, hi: 0.47, half: true  },
  { m: 3.0,  lo: 0.38, hi: 0.79, half: false },
  { m: 2.5,  lo: 0.15, hi: 0.29, half: true  },
  { m: 4.0,  lo: 0.25, hi: 0.63, half: false },
  { m: 5.0,  lo: 0.17, hi: 0.49, half: false },
  { m: 6.0,  lo: 0.13, hi: 0.41, half: false },
  { m: 3.5,  lo: 0.09, hi: 0.19, half: true  },
  { m: 8.0,  lo: 0.085, hi: 0.27, half: false },
  { m: 7.0,  lo: 0.095, hi: 0.31, half: false },
  { m: 10.0, lo: 0.058, hi: 0.205, half: false },
  { m: 12.0, lo: 0.043, hi: 0.160, half: false },
  { m: 14.0, lo: 0.031, hi: 0.124, half: false },
  { m: 16.0, lo: 0.024, hi: 0.098, half: false },
];

/* Camera mixes. Keys are canonical; ALIASES maps everything else onto them. */
const MIX_PRESETS = {
  cockpit:   { lp: 3300,  hp:  85, engine: 1.00, wind: 1.60, tyre: 0.88, ai: 0.60, rev: 0.34, amb: 0.55, ui: 1.0 },
  helmet:    { lp: 2400,  hp: 120, engine: 0.94, wind: 1.90, tyre: 0.76, ai: 0.52, rev: 0.26, amb: 0.72, ui: 1.0 },
  bonnet:    { lp: 6800,  hp:  55, engine: 1.06, wind: 1.20, tyre: 1.02, ai: 0.82, rev: 0.55, amb: 0.85, ui: 1.0 },
  chase:     { lp: 11500, hp:  45, engine: 1.00, wind: 0.82, tyre: 1.05, ai: 0.98, rev: 0.75, amb: 1.00, ui: 1.0 },
  tv:        { lp: 15000, hp:  55, engine: 0.80, wind: 0.46, tyre: 1.16, ai: 1.18, rev: 1.20, amb: 1.10, ui: 1.0 },
  trackside: { lp: 13500, hp:  70, engine: 0.66, wind: 0.30, tyre: 1.22, ai: 1.34, rev: 1.60, amb: 1.25, ui: 1.0 },
  garage:    { lp: 7000,  hp:  60, engine: 0.55, wind: 0.12, tyre: 0.40, ai: 0.70, rev: 1.30, amb: 0.60, ui: 1.0 },
};

const MIX_ALIASES = {
  onboard: 'cockpit', driver: 'cockpit', halo: 'cockpit', interior: 'cockpit', cabin: 'cockpit',
  visor: 'helmet', head: 'helmet', pov: 'helmet', firstperson: 'helmet',
  hood: 'bonnet', bumper: 'bonnet', nose: 'bonnet', front: 'bonnet', wing: 'bonnet', tcam: 'bonnet',
  follow: 'chase', far: 'chase', near: 'chase', third: 'chase', thirdperson: 'chase', default: 'chase',
  broadcast: 'tv', cinematic: 'tv', replay: 'tv', orbit: 'tv', helicopter: 'tv', drone: 'tv',
  marshal: 'trackside', spectator: 'trackside', grandstand: 'trackside', static: 'trackside',
  pit: 'garage', pitlane: 'garage', menu: 'garage', paddock: 'garage',
};

/* Quality tier → synth budget. */
const TIER_BUDGET = {
  low:    { harmonics: 7,  aiVoices: 3, reverb: false, irSeconds: 1.1, aiNoise: false, shots: 8,  crackle: 0.55 },
  medium: { harmonics: 10, aiVoices: 4, reverb: true,  irSeconds: 1.4, aiNoise: false, shots: 12, crackle: 0.8 },
  high:   { harmonics: 13, aiVoices: 6, reverb: true,  irSeconds: 1.9, aiNoise: true,  shots: 16, crackle: 1.0 },
  ultra:  { harmonics: 16, aiVoices: 6, reverb: true,  irSeconds: 2.3, aiNoise: true,  shots: 20, crackle: 1.0 },
};

/* Module-scope scratch — reused every frame, never re-allocated. */
const _sv = { x: 0, y: 0, z: 0 };   // scratch vector A
const _sw = { x: 0, y: 0, z: 0 };   // scratch vector B
const _fwd = { x: 0, y: 0, z: 1 };  // listener/car forward
const _up = { x: 0, y: 1, z: 0 };   // listener up

/* ========================================================================== *
 *  Procedural buffer factory helpers
 * ========================================================================== */

function fillWhite(ch, rng) {
  for (let i = 0; i < ch.length; i++) ch[i] = rng() * 2 - 1;
}

function fillPink(ch, rng) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < ch.length; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    ch[i] = out * 0.115;
  }
}

/** Crossfade the tail of a loop buffer into its head so the loop point is silent. */
function loopSmooth(ch, sr) {
  const n = ch.length;
  const fade = Math.min(Math.floor(sr * 0.04), Math.floor(n * 0.2));
  if (fade < 8) return;
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const a = ch[i];
    const b = ch[n - fade + i];
    ch[i] = a * t + b * (1 - t);
  }
  // Zero the region we folded in so energy isn't doubled.
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    ch[n - fade + i] *= t;
  }
}

/** One-pole lowpass applied in place. cutoff is normalised 0..1 of Nyquist. */
function onePoleLP(ch, k) {
  let y = 0;
  for (let i = 0; i < ch.length; i++) { y += (ch[i] - y) * k; ch[i] = y; }
}

/** One-pole highpass applied in place. */
function onePoleHP(ch, k) {
  let y = 0, prev = 0;
  for (let i = 0; i < ch.length; i++) {
    const x = ch[i];
    y = k * (y + x - prev);
    prev = x;
    ch[i] = y;
  }
}

/* ========================================================================== *
 *  createAudio
 * ========================================================================== */

/**
 * @param {Object} [opts]
 * @param {Object} [opts.quality]        quality tier object from ARCHITECTURE.md
 * @param {AudioContext} [opts.context]  reuse an existing context instead of making one
 * @param {number} [opts.masterVolume]   0..1
 * @param {number} [opts.engineVolume]   0..1
 * @param {number} [opts.uiVolume]       0..1
 * @param {number} [opts.cylinders]      default 6
 * @param {number} [opts.maxRpm]         default 15000
 * @param {number} [opts.idleRpm]        default 4200
 * @param {number} [opts.maxAiVoices]    hard-capped at 6
 * @param {boolean}[opts.muted]
 * @returns {Object} audio API
 */
export function createAudio(opts) {
  const O = opts || {};

  const quality = O.quality || null;
  const tierName = (quality && typeof quality.tier === 'string' && TIER_BUDGET[quality.tier]) ? quality.tier : 'high';
  const budget = TIER_BUDGET[tierName];

  /* ---------------------------------------------------------------- state */
  const S = {
    ac: null,
    ownsContext: false,
    ready: false,
    initPromise: null,
    failed: false,
    lastError: null,
    disposed: false,

    // user-facing volumes
    volMaster: isNum(O.masterVolume) ? clamp01(O.masterVolume) : 0.85,
    volEngine: isNum(O.engineVolume) ? clamp01(O.engineVolume) : 1.0,
    volUI: isNum(O.uiVolume) ? clamp01(O.uiVolume) : 0.8,
    muted: !!O.muted,

    // engine config
    cylinders: isNum(O.cylinders) ? Math.max(2, O.cylinders) : 6,
    maxRpm: isNum(O.maxRpm) ? Math.max(2000, O.maxRpm) : 15000,
    idleRpm: isNum(O.idleRpm) ? Math.max(400, O.idleRpm) : 4200,

    harmonicCount: Math.min(HARMONICS.length, isNum(O.harmonics) ? O.harmonics : budget.harmonics),
    aiVoiceCount: Math.min(6, isNum(O.maxAiVoices) ? Math.max(0, O.maxAiVoices | 0) : budget.aiVoices),
    useReverb: O.reverb === undefined ? budget.reverb : !!O.reverb,
    useAiNoise: budget.aiNoise,
    crackleScale: budget.crackle,
    shotPoolSize: budget.shots,

    // running engine state
    engineRunning: false,
    engineArm: 0,          // 0..1 master engine presence

    rpm: 0, rpmN: 0, rpmPrev: 0,
    load: 0, loadRaw: 0,
    throttlePrev: 0,
    boost: 0,
    overrun: 0,
    speed: 0, speedN: 0,
    gearPrev: 0,
    drsPrev: false,
    ersDeploy: 0,
    limiterOn: false,
    irregular: 0,
    irregTarget: 0,

    // tyre / surface
    squeal: 0, scrub: 0, wetHiss: 0, offroad: 0,
    kerbPhase: 0, kerbActive: 0,

    // crackle scheduling
    crackleTimer: 0, crackleEnergy: 0,

    // camera mix
    mixKey: 'chase',
    mix: MIX_PRESETS.chase,
    mixLp: MIX_PRESETS.chase.lp,
    mixHp: MIX_PRESETS.chase.hp,
    mixDirty: false,
    mixJustChanged: true,

    // listener
    lx: 0, ly: 0, lz: 0,
    lvx: 0, lvy: 0, lvz: 0,
    listenerInit: false,

    // update pacing
    slowAcc: 0,
    aiAcc: 0,
    time: 0,

    // nodes / lifecycle bookkeeping
    sources: [],   // things with .stop()
    nodes: [],     // things with .disconnect()
    rng: makeRng(0x51ed5eed),
  };

  const RATE_SLOW = 1 / 30;   // partial re-weighting rate
  const RATE_AI = 1 / 8;      // AI voice reassignment rate

  /* Graph handles (populated in buildGraph). */
  const G = {
    master: null, comp: null, mixBus: null,
    worldBus: null, cabinLP: null, cabinHP: null,
    reverbSend: null, convolver: null, reverbReturn: null,
    uiBus: null,

    engineOut: null, engineCore: null, shiftCut: null, limiterCut: null,
    limiterLfo: null, limiterDepth: null,
    engineTone: null, engineShapeLP: null, enginePeak: null, engineLowShelf: null,
    bankA: null, bankB: null,
    exhaustFx: null,

    intakeOsc: null, intakeBP: null, intakeGain: null, intakeSub: null,
    turboOsc: null, turboGain: null, turboNoiseSrc: null, turboNoiseBP: null, turboNoiseGain: null,
    mguOsc: null, mguOsc2: null, mguGain: null, mguFilter: null,

    tyreBus: null,
    squealSrc: null, squealBP: null, squealBP2: null, squealGain: null,
    scrubSrc: null, scrubBP: null, scrubGain: null,
    wetSrc: null, wetHP: null, wetGain: null,
    offSrc: null, offBP: null, offGain: null,

    windBus: null, windSrc: null, windLP: null, windBP: null, windGain: null, windBuffetGain: null,
    ambBus: null, rainSrc: null, rainHP: null, rainGain: null,

    aiBus: null,
    sfxBus: null,

    radioBand: null, radioShaper: null, radioOut: null, radioFormants: null,
  };

  /* Pre-allocated arrays (never re-created). */
  const partials = [];        // { osc, gain, m, lo, hi, half, bank }
  const aiVoices = [];
  const shotVoices = [];
  const impactVoices = [];

  /* AI selection scratch — pre-sized, reused every frame. */
  const MAX_CARS = 64;
  const _carDist = new Float32Array(MAX_CARS);
  const _carIdx = new Int32Array(MAX_CARS);
  const _pickIdx = new Int32Array(8);
  let _pickCount = 0;

  /* Procedural buffers. */
  const BUF = {
    white: null, pink: null, ir: null,
    pops: null,          // array of 5
    flutter: null, thump: null, click: null,
    crack: null, thud: null, gravel: null,
    crank: null, squelch: null, psst: null, thunk: null,
  };

  /* =============================== buffers =============================== */

  function makeNoiseBuffers(ac) {
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 2.5);
    const rngA = makeRng(0x1234abcd);
    const rngB = makeRng(0x77c0ffee);

    const white = ac.createBuffer(2, n, sr);
    fillWhite(white.getChannelData(0), rngA);
    fillWhite(white.getChannelData(1), rngB);
    loopSmooth(white.getChannelData(0), sr);
    loopSmooth(white.getChannelData(1), sr);
    BUF.white = white;

    const pink = ac.createBuffer(2, n, sr);
    fillPink(pink.getChannelData(0), makeRng(0x5eed0001));
    fillPink(pink.getChannelData(1), makeRng(0x5eed0002));
    loopSmooth(pink.getChannelData(0), sr);
    loopSmooth(pink.getChannelData(1), sr);
    BUF.pink = pink;
  }

  /**
   * Procedural impulse response: sparse early reflections over a diffuse,
   * exponentially decaying noise tail, gently lowpassed so it doesn't sizzle.
   */
  function makeImpulseResponse(ac, seconds) {
    const sr = ac.sampleRate;
    const n = Math.max(64, Math.floor(sr * seconds));
    const ir = ac.createBuffer(2, n, sr);
    const rng = makeRng(0xbadc0de1);

    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      const decay = 3.1 + c * 0.15;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const env = Math.pow(1 - t, decay);
        // Sparse-ish diffuse tail: density rises with time.
        const density = 0.18 + 0.82 * t;
        const s = rng() < density ? (rng() * 2 - 1) : 0;
        ch[i] = s * env;
      }
      // Early reflection taps — gives the grandstand/pit-wall slap.
      const taps = [0.007, 0.013, 0.019, 0.028, 0.037, 0.049, 0.063, 0.081, 0.104];
      for (let k = 0; k < taps.length; k++) {
        const idx = Math.floor((taps[k] + (c ? 0.0017 : 0)) * sr);
        if (idx < n - 3) {
          const amp = (0.85 - k * 0.08) * (rng() * 0.5 + 0.6) * (rng() < 0.5 ? -1 : 1);
          ch[idx] += amp;
          ch[idx + 1] += amp * 0.5;
          ch[idx + 2] += amp * 0.22;
        }
      }
      onePoleLP(ch, 0.42);
      onePoleHP(ch, 0.985);
      // Normalise-ish so reverb send levels stay predictable across sample rates.
      let peak = 0;
      for (let i = 0; i < n; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > peak) peak = a; }
      if (peak > 1e-6) {
        const g = 0.62 / peak;
        for (let i = 0; i < n; i++) ch[i] *= g;
      }
    }
    return ir;
  }

  /** Short filtered noise transient with an arbitrary amplitude envelope. */
  function makeBurst(ac, seconds, seed, shape) {
    const sr = ac.sampleRate;
    const n = Math.max(16, Math.floor(sr * seconds));
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(seed);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      ch[i] = (rng() * 2 - 1) * shape(t, i / sr);
    }
    return b;
  }

  function makeExhaustPops(ac) {
    const pops = [];
    for (let k = 0; k < 5; k++) {
      const dur = 0.045 + k * 0.018;
      const sharp = 40 + k * 26;
      const b = makeBurst(ac, dur, 0xf00d + k * 977, function (t) {
        const attack = t < 0.006 ? t / 0.006 : 1;
        return attack * Math.exp(-t * sharp) * (0.85 + 0.15 * Math.sin(t * 140));
      });
      const ch = b.getChannelData(0);
      onePoleLP(ch, k < 2 ? 0.55 : 0.34);
      onePoleHP(ch, 0.90);
      pops.push(b);
    }
    return pops;
  }

  function makeFlutter(ac) {
    // Wastegate chatter: amplitude-modulated air noise at ~52 Hz with decay.
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 0.42);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0x9a11ee);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const am = 0.42 + 0.58 * Math.pow(Math.max(0, Math.sin(TWO_PI * 52 * t)), 1.6);
      const env = Math.exp(-t * 7.5) * smoothstep(0, 0.012, t);
      ch[i] = (rng() * 2 - 1) * am * env;
    }
    onePoleHP(ch, 0.93);
    onePoleLP(ch, 0.7);
    return b;
  }

  function makeThump(ac) {
    // Kerb strike: low body thud + tyre-wall slap.
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 0.22);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0x7f00b1);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const body = Math.sin(TWO_PI * (95 - 45 * Math.min(1, t * 12)) * t) * Math.exp(-t * 26);
      const slap = (rng() * 2 - 1) * Math.exp(-t * 65);
      const rattle = (rng() * 2 - 1) * Math.exp(-t * 16) * 0.25;
      ch[i] = body * 0.8 + slap * 0.55 + rattle;
    }
    onePoleLP(ch, 0.5);
    return b;
  }

  function makeClick(ac) {
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 0.035);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0xc11c);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ch[i] = (rng() * 2 - 1) * Math.exp(-t * 320) + Math.sin(TWO_PI * 2400 * t) * Math.exp(-t * 220) * 0.4;
    }
    onePoleHP(ch, 0.72);
    return b;
  }

  function makeCarbonCrack(ac) {
    // Sharp splintering: dense stochastic micro-transients.
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 0.30);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0xca7b04);
    let hold = 0, val = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if (hold <= 0) { val = (rng() * 2 - 1); hold = 1 + Math.floor(rng() * 5); }
      hold--;
      const spikes = rng() < 0.02 ? (rng() * 2 - 1) * 2.5 : 0;
      ch[i] = (val * 0.55 + spikes) * Math.exp(-t * 17) * smoothstep(0, 0.002, t);
    }
    onePoleHP(ch, 0.88);
    return b;
  }

  function makeThud(ac) {
    // Chassis / bodywork mass impact.
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 0.55);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0x7d0d51);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = 62 - 34 * Math.min(1, t * 5);
      const body = Math.sin(TWO_PI * f * t) * Math.exp(-t * 9.5);
      const sub = Math.sin(TWO_PI * 38 * t) * Math.exp(-t * 5.5) * 0.6;
      const grit = (rng() * 2 - 1) * Math.exp(-t * 40) * 0.35;
      ch[i] = body + sub + grit;
    }
    onePoleLP(ch, 0.22);
    return b;
  }

  function makeGravel(ac) {
    // Loopable gravel/grass scrabble.
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 1.5);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0x9ac1e1);
    let hold = 0, val = 0;
    for (let i = 0; i < n; i++) {
      if (hold <= 0) { val = (rng() * 2 - 1) * (0.4 + rng() * 0.6); hold = 1 + Math.floor(rng() * 9); }
      hold--;
      ch[i] = val;
    }
    onePoleLP(ch, 0.55);
    loopSmooth(ch, sr);
    return b;
  }

  function makeCrank(ac) {
    // Starter motor: whirr + compression pulses that speed up.
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 1.05);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0xc0a11c);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const rate = 6 + 16 * clamp01(t / 0.9);
      phase += rate / sr;
      const pulse = Math.pow(Math.max(0, Math.sin(TWO_PI * phase)), 3);
      const whirr = Math.sin(TWO_PI * (620 + 460 * clamp01(t / 0.9)) * t) * 0.22;
      const air = (rng() * 2 - 1) * 0.5;
      const env = smoothstep(0, 0.05, t) * (1 - smoothstep(0.85, 1.05, t));
      ch[i] = (pulse * (0.75 + air * 0.6) + whirr) * env;
    }
    onePoleLP(ch, 0.4);
    return b;
  }

  function makeSquelch(ac) {
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 0.09);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0x5911cd);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ch[i] = (rng() * 2 - 1) * Math.exp(-t * 42) * (t < 0.004 ? t / 0.004 : 1);
    }
    onePoleHP(ch, 0.80);
    return b;
  }

  function makePsst(ac) {
    // DRS actuator: pneumatic release.
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 0.17);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0xd25);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = smoothstep(0, 0.004, t) * Math.exp(-t * 22);
      ch[i] = (rng() * 2 - 1) * env;
    }
    onePoleHP(ch, 0.90);
    return b;
  }

  function makeThunk(ac) {
    // DRS flap closing against its stop.
    const sr = ac.sampleRate;
    const n = Math.floor(sr * 0.14);
    const b = ac.createBuffer(1, n, sr);
    const ch = b.getChannelData(0);
    const rng = makeRng(0x77aa31);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ch[i] = (Math.sin(TWO_PI * 240 * t) * 0.7 + (rng() * 2 - 1) * 0.6) * Math.exp(-t * 48);
    }
    onePoleLP(ch, 0.5);
    return b;
  }

  function buildAllBuffers(ac) {
    makeNoiseBuffers(ac);
    if (S.useReverb) {
      try { BUF.ir = makeImpulseResponse(ac, budget.irSeconds); } catch (e) { BUF.ir = null; }
    }
    BUF.pops = makeExhaustPops(ac);
    BUF.flutter = makeFlutter(ac);
    BUF.thump = makeThump(ac);
    BUF.click = makeClick(ac);
    BUF.crack = makeCarbonCrack(ac);
    BUF.thud = makeThud(ac);
    BUF.gravel = makeGravel(ac);
    BUF.crank = makeCrank(ac);
    BUF.squelch = makeSquelch(ac);
    BUF.psst = makePsst(ac);
    BUF.thunk = makeThunk(ac);
  }

  /* ============================ node helpers ============================ */

  function reg(node) { if (node) S.nodes.push(node); return node; }
  function regSrc(node) { if (node) S.sources.push(node); return node; }

  function gain(v) { const g = S.ac.createGain(); g.gain.value = isNum(v) ? v : 1; return reg(g); }

  function filter(type, freq, q, gainDb) {
    const f = S.ac.createBiquadFilter();
    f.type = type;
    if (isNum(freq)) f.frequency.value = clamp(freq, 10, S.ac.sampleRate * 0.48);
    if (isNum(q)) f.Q.value = q;
    if (isNum(gainDb)) f.gain.value = gainDb;
    return reg(f);
  }

  function osc(type, freq, detune) {
    const o = S.ac.createOscillator();
    o.type = type || 'sine';
    if (isNum(freq)) o.frequency.value = Math.max(0.0001, freq);
    if (isNum(detune)) o.detune.value = detune;
    reg(o); regSrc(o);
    return o;
  }

  function loopSource(buffer, rate, offsetFrac) {
    const s = S.ac.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = isNum(rate) ? rate : 1;
    reg(s); regSrc(s);
    const off = buffer && isNum(offsetFrac) ? buffer.duration * clamp01(offsetFrac) : 0;
    s._apexStartOffset = off;
    return s;
  }

  /* ============================= graph build ============================= */

  function buildGraph() {
    const ac = S.ac;
    const now = ac.currentTime;

    /* --- master chain ------------------------------------------------- */
    G.master = gain(S.muted ? 0 : S.volMaster);
    G.master.connect(ac.destination);

    G.comp = ac.createDynamicsCompressor();
    reg(G.comp);
    G.comp.threshold.value = -13;
    G.comp.knee.value = 22;
    G.comp.ratio.value = 5.5;
    G.comp.attack.value = 0.004;
    G.comp.release.value = 0.22;
    G.comp.connect(G.master);

    G.mixBus = gain(1);
    G.mixBus.connect(G.comp);

    /* --- world chain (everything that lives "out there") --------------- */
    G.cabinHP = filter('highpass', S.mixHp, 0.7);
    G.cabinHP.connect(G.mixBus);

    G.cabinLP = filter('lowpass', S.mixLp, 0.55);
    G.cabinLP.connect(G.cabinHP);

    G.worldBus = gain(1);
    G.worldBus.connect(G.cabinLP);

    /* --- reverb -------------------------------------------------------- */
    if (S.useReverb && BUF.ir) {
      try {
        G.convolver = ac.createConvolver();
        reg(G.convolver);
        G.convolver.normalize = true;
        G.convolver.buffer = BUF.ir;

        G.reverbSend = gain(0.16);
        G.reverbReturn = gain(0.75);

        G.worldBus.connect(G.reverbSend);
        G.reverbSend.connect(G.convolver);
        G.convolver.connect(G.reverbReturn);
        G.reverbReturn.connect(G.comp);
      } catch (e) {
        G.convolver = null; G.reverbSend = null; G.reverbReturn = null;
      }
    }

    /* --- UI bus (dry, no cabin filtering) ------------------------------ */
    G.uiBus = gain(S.volUI);
    G.uiBus.connect(G.mixBus);

    /* --- engine chain --------------------------------------------------- */
    G.engineOut = gain(S.volEngine * 0.0001);   // silent until startEngine()
    G.engineOut.connect(G.worldBus);

    G.limiterCut = gain(1);
    G.limiterCut.connect(G.engineOut);

    G.shiftCut = gain(1);
    G.shiftCut.connect(G.limiterCut);

    G.engineCore = gain(1);
    G.engineCore.connect(G.shiftCut);

    // Pit-limiter stutter: square LFO modulating limiterCut.gain.
    G.limiterDepth = gain(0);
    G.limiterLfo = osc('square', 17.5);
    G.limiterLfo.connect(G.limiterDepth);
    G.limiterDepth.connect(G.limiterCut.gain);

    // Exhaust FX (pops, flutter) bypass the ignition cuts so they still fire
    // during shifts and on the limiter.
    G.exhaustFx = gain(1);
    G.exhaustFx.connect(G.engineOut);

    /* Tone shaping of the additive stack: a soft pipe resonance and a gentle
       top-end roll-off keep it from sounding like a buzzsaw. */
    G.engineShapeLP = filter('lowpass', 9000, 0.55);
    G.engineShapeLP.connect(G.engineCore);

    G.enginePeak = filter('peaking', 2450, 1.1, 4.0);
    G.enginePeak.connect(G.engineShapeLP);

    G.engineLowShelf = filter('lowshelf', 140, 0.7, 3.5);
    G.engineLowShelf.connect(G.enginePeak);

    G.engineTone = gain(0.34);
    G.engineTone.connect(G.engineLowShelf);

    G.bankA = gain(0.55);
    G.bankB = gain(0.5);
    G.bankA.connect(G.engineTone);
    G.bankB.connect(G.engineTone);

    buildPartials();

    /* --- intake honk ---------------------------------------------------- */
    G.intakeGain = gain(0.0001);
    G.intakeGain.connect(G.engineCore);

    G.intakeBP = filter('bandpass', 640, 3.4);
    G.intakeBP.connect(G.intakeGain);

    G.intakeSub = filter('lowpass', 2200, 0.8);
    G.intakeSub.connect(G.intakeBP);

    G.intakeOsc = osc('sawtooth', 210, -3);
    G.intakeOsc.connect(G.intakeSub);

    /* --- turbo ---------------------------------------------------------- */
    G.turboGain = gain(0.0001);
    G.turboGain.connect(G.engineCore);

    G.turboOsc = osc('sine', 1400);
    G.turboOsc.connect(G.turboGain);

    G.turboNoiseGain = gain(0.0001);
    G.turboNoiseGain.connect(G.engineCore);

    G.turboNoiseBP = filter('bandpass', 3600, 9);
    G.turboNoiseBP.connect(G.turboNoiseGain);

    G.turboNoiseSrc = loopSource(BUF.white, 1.0, 0.11);
    G.turboNoiseSrc.connect(G.turboNoiseBP);

    /* --- MGU-K / MGU-H whine -------------------------------------------- */
    G.mguGain = gain(0.0001);
    G.mguGain.connect(G.engineCore);

    G.mguFilter = filter('bandpass', 4200, 2.2);
    G.mguFilter.connect(G.mguGain);

    G.mguOsc = osc('sine', 2600);
    G.mguOsc.connect(G.mguFilter);
    G.mguOsc2 = osc('sine', 3900, 9);
    const mgu2g = gain(0.45);
    G.mguOsc2.connect(mgu2g);
    mgu2g.connect(G.mguFilter);

    /* --- tyres ---------------------------------------------------------- */
    G.tyreBus = gain(1);
    G.tyreBus.connect(G.worldBus);

    G.squealGain = gain(0.0001);
    G.squealGain.connect(G.tyreBus);
    G.squealBP2 = filter('bandpass', 2600, 9);
    G.squealBP2.connect(G.squealGain);
    G.squealBP = filter('bandpass', 1300, 11);
    G.squealBP.connect(G.squealBP2);
    G.squealSrc = loopSource(BUF.white, 0.93, 0.31);
    G.squealSrc.connect(G.squealBP);

    G.scrubGain = gain(0.0001);
    G.scrubGain.connect(G.tyreBus);
    G.scrubBP = filter('bandpass', 420, 1.05);
    G.scrubBP.connect(G.scrubGain);
    G.scrubSrc = loopSource(BUF.pink, 1.07, 0.57);
    G.scrubSrc.connect(G.scrubBP);

    G.wetGain = gain(0.0001);
    G.wetGain.connect(G.tyreBus);
    G.wetHP = filter('highpass', 2100, 0.7);
    G.wetHP.connect(G.wetGain);
    const wetTilt = filter('peaking', 5200, 0.8, 4);
    wetTilt.connect(G.wetHP);
    G.wetSrc = loopSource(BUF.white, 1.19, 0.73);
    G.wetSrc.connect(wetTilt);

    G.offGain = gain(0.0001);
    G.offGain.connect(G.tyreBus);
    G.offBP = filter('bandpass', 260, 0.9);
    G.offBP.connect(G.offGain);
    G.offSrc = loopSource(BUF.gravel, 1.0, 0.2);
    G.offSrc.connect(G.offBP);

    /* --- wind ----------------------------------------------------------- */
    G.windBus = gain(1);
    G.windBus.connect(G.worldBus);

    G.windGain = gain(0.0001);
    G.windGain.connect(G.windBus);
    G.windLP = filter('lowpass', 900, 0.8);
    G.windLP.connect(G.windGain);
    G.windSrc = loopSource(BUF.pink, 1.0, 0.13);
    G.windSrc.connect(G.windLP);

    G.windBuffetGain = gain(0.0001);
    G.windBuffetGain.connect(G.windBus);
    G.windBP = filter('bandpass', 380, 1.6);
    G.windBP.connect(G.windBuffetGain);
    const windSrc2 = loopSource(BUF.pink, 0.71, 0.63);
    windSrc2.connect(G.windBP);

    /* --- ambience (rain) ------------------------------------------------ */
    G.ambBus = gain(1);
    G.ambBus.connect(G.worldBus);

    G.rainGain = gain(0.0001);
    G.rainGain.connect(G.ambBus);
    G.rainHP = filter('highpass', 1400, 0.6);
    G.rainHP.connect(G.rainGain);
    const rainLP = filter('lowpass', 9000, 0.7);
    rainLP.connect(G.rainHP);
    G.rainSrc = loopSource(BUF.white, 0.86, 0.41);
    G.rainSrc.connect(rainLP);

    /* --- AI + SFX buses -------------------------------------------------- */
    G.aiBus = gain(1);
    G.aiBus.connect(G.worldBus);

    G.sfxBus = gain(1);
    G.sfxBus.connect(G.worldBus);

    buildShotPool();
    buildImpactPool();
    buildAiVoices();
    buildRadioChain();

    /* --- start every persistent source ---------------------------------- */
    for (let i = 0; i < S.sources.length; i++) {
      const s = S.sources[i];
      if (s._apexStarted) continue;
      try {
        if (s._apexStartOffset !== undefined) s.start(now, s._apexStartOffset);
        else s.start(now);
        s._apexStarted = true;
      } catch (e) { /* already started or unsupported */ }
    }

    applyMix(S.mix, 0.001);
  }

  /* --------------------------- additive stack --------------------------- */

  function buildPartials() {
    const count = S.harmonicCount;
    const nyq = S.ac.sampleRate * 0.5;
    for (let b = 0; b < 2; b++) {
      const bus = b === 0 ? G.bankA : G.bankB;
      for (let i = 0; i < count; i++) {
        const h = HARMONICS[i];
        const g = gain(0.0001);
        g.connect(bus);
        // Slight inharmonic detune per partial + per bank → firing irregularity.
        const baseDet = (b === 0 ? -1 : 1) * (3.5 + h.m * 0.28);
        const o = osc('sine', 200 * h.m, baseDet);
        o.connect(g);
        partials.push({
          osc: o, gain: g, m: h.m, lo: h.lo, hi: h.hi, half: h.half,
          bank: b, baseDet: baseDet, nyq: nyq,
        });
      }
    }
  }

  /* ------------------------------ shot pool ----------------------------- */

  function buildShotPool() {
    const n = S.shotPoolSize;
    for (let i = 0; i < n; i++) {
      const g = gain(0.0001);
      const f = filter('bandpass', 1200, 1.2);
      f.connect(g);
      g.connect(G.exhaustFx);
      shotVoices.push({ gain: g, filter: f, dest: G.exhaustFx, until: 0 });
    }
  }
  let shotCursor = 0;

  /**
   * Fire a one-shot buffer through a pooled filter+gain. Only the
   * AudioBufferSourceNode is allocated (WebAudio requires a fresh one).
   */
  function shot(buffer, level, rate, freq, q, type, dest, when) {
    if (!buffer || !S.ready) return;
    const ac = S.ac;
    const t = when || ac.currentTime;
    const v = shotVoices[shotCursor];
    shotCursor = (shotCursor + 1) % shotVoices.length;
    if (!v) return;
    try {
      if (dest && v.dest !== dest) {
        try { v.gain.disconnect(); } catch (e) { /* ignore */ }
        v.gain.connect(dest);
        v.dest = dest;
      }
      v.filter.type = type || 'bandpass';
      v.filter.frequency.setValueAtTime(clamp(freq || 1200, 20, ac.sampleRate * 0.46), t);
      v.filter.Q.setValueAtTime(clamp(q || 1.2, 0.05, 40), t);
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(clamp(level, 0, 4), t);
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = clamp(rate || 1, 0.06, 6);
      src.connect(v.filter);
      src.onended = _selfDisconnect;
      src.start(t);
      src.stop(t + buffer.duration / src.playbackRate.value + 0.02);
      v.until = t + buffer.duration;
    } catch (e) { /* never let a one-shot break the frame */ }
  }

  /* ----------------------------- impact pool ---------------------------- */

  function buildImpactPool() {
    const ac = S.ac;
    for (let i = 0; i < 4; i++) {
      let panner = null;
      try {
        panner = ac.createPanner();
        reg(panner);
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 6;
        panner.maxDistance = 400;
        panner.rolloffFactor = 1.0;
        panner.connect(G.sfxBus);
      } catch (e) { panner = null; }
      const g = gain(1);
      const f = filter('lowpass', 18000, 0.7);
      f.connect(g);
      if (panner) g.connect(panner); else g.connect(G.sfxBus);
      impactVoices.push({ gain: g, filter: f, panner: panner });
    }
  }
  let impactCursor = 0;

  /* ------------------------------ AI voices ----------------------------- */

  function makeEngineWave(ac, openness) {
    // PeriodicWave harmonics are integer multiples, so the AI oscillator runs
    // at half the firing frequency: index 1 == half order, index 2 == firing.
    const n = 34;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let i = 0; i < S.harmonicCount; i++) {
      const h = HARMONICS[i];
      const idx = Math.round(h.m * 2);
      if (idx < 1 || idx >= n) continue;
      let w = lerp(h.lo, h.hi, openness);
      if (h.half) w *= lerp(1.35, 0.85, openness);
      imag[idx] += w;
    }
    // Sprinkle a little extra top end for the hard wave so a passing car sizzles.
    if (openness > 0.5) {
      for (let idx = 18; idx < n; idx += 2) imag[idx] += 0.05 * (1 - (idx - 18) / (n - 18));
    }
    try {
      return ac.createPeriodicWave(real, imag, { disableNormalization: false });
    } catch (e) {
      try { return ac.createPeriodicWave(real, imag); } catch (e2) { return null; }
    }
  }

  function buildAiVoices() {
    const ac = S.ac;
    const waveSoft = makeEngineWave(ac, 0.12);
    const waveHard = makeEngineWave(ac, 1.0);

    for (let i = 0; i < S.aiVoiceCount; i++) {
      let panner = null;
      try {
        panner = ac.createPanner();
        reg(panner);
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 7;
        panner.maxDistance = 600;
        panner.rolloffFactor = 1.15;
        panner.coneInnerAngle = 110;
        panner.coneOuterAngle = 330;
        panner.coneOuterGain = 0.45;
        panner.connect(G.aiBus);
      } catch (e) {
        panner = null;
      }

      const out = gain(0.0001);
      if (panner) out.connect(panner); else out.connect(G.aiBus);

      // Air absorption: cutoff falls with distance.
      const air = filter('lowpass', 16000, 0.6);
      air.connect(out);

      const softG = gain(1);
      const hardG = gain(0.0001);
      softG.connect(air);
      hardG.connect(air);

      const oSoft = osc('sine', 180);
      const oHard = osc('sine', 180);
      if (waveSoft) { try { oSoft.setPeriodicWave(waveSoft); } catch (e) { oSoft.type = 'sawtooth'; } }
      else oSoft.type = 'triangle';
      if (waveHard) { try { oHard.setPeriodicWave(waveHard); } catch (e) { oHard.type = 'sawtooth'; } }
      else oHard.type = 'sawtooth';
      oSoft.connect(softG);
      oHard.connect(hardG);

      let noiseGain = null;
      if (S.useAiNoise) {
        noiseGain = gain(0.0001);
        const nbp = filter('bandpass', 1800, 0.9);
        nbp.connect(noiseGain);
        noiseGain.connect(air);
        const ns = loopSource(BUF.pink, 0.9 + i * 0.05, (i * 0.17) % 1);
        ns.connect(nbp);
      }

      aiVoices.push({
        panner: panner, out: out, air: air,
        softG: softG, hardG: hardG,
        oSoft: oSoft, oHard: oHard,
        noiseGain: noiseGain,
        carId: null, car: null,
        px: 0, py: 0, pz: 0,
        active: false, fadeOut: false, swapTimer: 0,
      });
    }
  }

  /* ------------------------------ radio chain ---------------------------- */

  function buildRadioChain() {
    const ac = S.ac;
    try {
      G.radioOut = gain(0.0001);
      G.radioOut.connect(G.uiBus);

      // Communication-grade band limiting + soft clip.
      const hp = filter('highpass', 380, 0.8);
      const lp = filter('lowpass', 2900, 0.9);
      const bite = filter('peaking', 1650, 1.4, 6);

      G.radioShaper = ac.createWaveShaper();
      reg(G.radioShaper);
      const cn = 1024;
      const curve = new Float32Array(cn);
      for (let i = 0; i < cn; i++) {
        const x = (i / (cn - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 3.2) * 0.85;
      }
      G.radioShaper.curve = curve;
      G.radioShaper.oversample = '2x';

      hp.connect(lp);
      lp.connect(bite);
      bite.connect(G.radioShaper);
      G.radioShaper.connect(G.radioOut);
      G.radioBand = hp;

      // Three parallel vowel formants shared by all radio calls.
      G.radioFormants = [];
      const fSpec = [[520, 7, 1.0], [1180, 9, 0.62], [2450, 11, 0.34]];
      for (let i = 0; i < fSpec.length; i++) {
        const f = filter('bandpass', fSpec[i][0], fSpec[i][1]);
        const g = gain(fSpec[i][2]);
        f.connect(g);
        g.connect(G.radioBand);
        G.radioFormants.push({ filter: f, gain: g });
      }
    } catch (e) {
      G.radioOut = null;
      G.radioFormants = null;
    }
  }

  /* ================================ mixing =============================== */

  function resolveMix(mode) {
    if (typeof mode !== 'string') return null;
    const key = mode.toLowerCase().replace(/[^a-z]/g, '');
    if (MIX_PRESETS[key]) return key;
    if (MIX_ALIASES[key] && MIX_PRESETS[MIX_ALIASES[key]]) return MIX_ALIASES[key];
    return null;
  }

  function applyMix(m, tau) {
    if (!S.ready || !m) return;
    const now = S.ac.currentTime;
    const t = tau || 0.28;
    spf(G.cabinLP.frequency, S.mixLp, now, t, 200, S.ac.sampleRate * 0.46);
    spf(G.cabinHP.frequency, S.mixHp, now, t, 20, 1200);
    if (G.reverbSend) sp(G.reverbSend.gain, 0.16 * m.rev, now, t);
    if (G.uiBus) sp(G.uiBus.gain, S.volUI * (m.ui === undefined ? 1 : m.ui), now, 0.05);
  }

  /* ============================ engine control =========================== */

  function firingFrequency(rpm) {
    return (rpm / 60) * (S.cylinders * 0.5);
  }

  /** Re-weight every partial from rpm / load / overrun. Runs at ~30 Hz. */
  function updatePartials(now) {
    const open = Math.pow(S.load, 0.72);
    const ov = S.overrun;
    const rn = S.rpmN;

    // Formant emphasis sweeps upward with revs — the "opening up" effect.
    const formant1 = 780 + rn * 620;
    const formant2 = 2200 + rn * 1500;
    const nyqLimit = S.ac.sampleRate * 0.45;

    const f0 = firingFrequency(S.rpm);
    const lvl = (0.24 + 0.76 * open) * (0.42 + 0.58 * rn);

    // Firing-order irregularity: the two banks pull apart, more so low down.
    const irregA = -S.irregular * 6.5;
    const irregB = S.irregular * 9.0;

    for (let i = 0; i < partials.length; i++) {
      const p = partials[i];
      const f = f0 * p.m;
      let g;
      if (f > nyqLimit || f < 8) {
        g = 0;
      } else {
        g = lerp(p.lo, p.hi, open);

        // Overrun: half orders bloom, integer orders hollow out.
        if (p.half) g *= (1 + ov * 0.62);
        else g *= (1 - ov * 0.34 * clamp01(p.m / 4));

        // Moving formants.
        const d1 = (f - formant1) / 520;
        const d2 = (f - formant2) / 1150;
        g *= 1 + 0.75 * Math.exp(-d1 * d1) + 0.45 * Math.exp(-d2 * d2);

        // Natural high-order roll-off that recedes as revs climb.
        g *= 1 / (1 + Math.pow(p.m / (4.2 + rn * 5.6), 1.85));

        // Anti-alias fade near Nyquist.
        if (f > nyqLimit * 0.7) g *= 1 - smoothstep(nyqLimit * 0.7, nyqLimit, f);

        g *= lvl;
        // Bank B slightly quieter so the pair reads as one engine.
        if (p.bank === 1) g *= 0.86;
      }
      sp(p.gain.gain, g, now, 0.035);
      sp(p.osc.detune, p.baseDet + (p.bank === 0 ? irregA : irregB), now, 0.06);
    }
  }

  /** Per-frame pitch tracking. Exactly one param write per partial. */
  function updatePartialPitch(now) {
    const f0 = firingFrequency(S.rpm);
    const nyq = S.ac.sampleRate * 0.49;
    for (let i = 0; i < partials.length; i++) {
      const p = partials[i];
      spf(p.osc.frequency, f0 * p.m, now, 0.018, 5, nyq);
    }
  }

  function triggerShiftCut(hard) {
    if (!S.ready || !S.engineRunning) return;
    const now = S.ac.currentTime;
    const p = G.shiftCut.gain;
    try {
      p.cancelScheduledValues(now);
      p.setValueAtTime(1, now);
      p.linearRampToValueAtTime(hard ? 0.06 : 0.35, now + 0.007);
      p.setValueAtTime(hard ? 0.06 : 0.35, now + (hard ? 0.042 : 0.02));
      p.linearRampToValueAtTime(1, now + (hard ? 0.10 : 0.06));
    } catch (e) { /* ignore */ }
  }

  function crackle(intensity, count) {
    if (!BUF.pops) return;
    const n = Math.max(1, count | 0);
    const ac = S.ac;
    for (let i = 0; i < n; i++) {
      const k = (S.rng() * BUF.pops.length) | 0;
      const when = ac.currentTime + i * (0.012 + S.rng() * 0.045);
      const lvl = intensity * (0.45 + S.rng() * 0.75) * S.crackleScale;
      shot(BUF.pops[k], lvl, 0.78 + S.rng() * 0.6,
        900 + S.rng() * 2600, 0.9 + S.rng() * 2.2, 'bandpass', G.exhaustFx, when);
    }
  }

  /* ============================== AI voices ============================== */

  function assignAiVoices(cars, player) {
    if (!aiVoices.length) return;
    const count = Math.min(MAX_CARS, cars.length);
    let m = 0;
    for (let i = 0; i < count; i++) {
      const c = cars[i];
      if (!c || c === player || c.isPlayer) continue;
      const p = c.position;
      if (!p) continue;
      const dx = p.x - S.lx, dy = p.y - S.ly, dz = p.z - S.lz;
      _carDist[m] = dx * dx + dy * dy + dz * dz;
      _carIdx[m] = i;
      m++;
    }
    // Partial selection sort for the nearest N — no allocation.
    const want = Math.min(aiVoices.length, m);
    for (let a = 0; a < want; a++) {
      let best = a;
      for (let b = a + 1; b < m; b++) if (_carDist[b] < _carDist[best]) best = b;
      if (best !== a) {
        const td = _carDist[a]; _carDist[a] = _carDist[best]; _carDist[best] = td;
        const ti = _carIdx[a]; _carIdx[a] = _carIdx[best]; _carIdx[best] = ti;
      }
      _pickIdx[a] = _carIdx[a];
    }
    _pickCount = want;

    // Keep voices already playing one of the picks; retire the rest.
    for (let v = 0; v < aiVoices.length; v++) {
      const voice = aiVoices[v];
      let keep = -1;
      if (voice.car) {
        for (let k = 0; k < _pickCount; k++) {
          if (cars[_pickIdx[k]] === voice.car) { keep = k; break; }
        }
      }
      if (keep >= 0) { _pickIdx[keep] = -1; voice.fadeOut = false; }
      else if (voice.car) { voice.fadeOut = true; }
    }
    // Hand free picks to idle/fading voices.
    for (let k = 0; k < _pickCount; k++) {
      const idx = _pickIdx[k];
      if (idx < 0) continue;
      const car = cars[idx];
      let target = null;
      for (let v = 0; v < aiVoices.length; v++) {
        const voice = aiVoices[v];
        if (!voice.car) { target = voice; break; }
      }
      if (!target) {
        for (let v = 0; v < aiVoices.length; v++) {
          const voice = aiVoices[v];
          if (voice.fadeOut && voice.swapTimer <= 0) { target = voice; break; }
        }
      }
      if (target) {
        target.car = car;
        target.carId = car && car.id !== undefined ? car.id : null;
        target.fadeOut = false;
        target.swapTimer = 0.05;
        const p = car.position;
        if (p) { target.px = p.x; target.py = p.y; target.pz = p.z; }
      }
    }
  }

  function updateAiVoice(voice, dt, now, mix, slow) {
    const car = voice.car;
    if (!car || !car.position) {
      sp(voice.out.gain, 0.0001, now, 0.08);
      return;
    }
    const p = car.position;
    const dx = p.x - S.lx, dy = p.y - S.ly, dz = p.z - S.lz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;

    // Panner position.
    if (voice.panner) {
      if (voice.panner.positionX) {
        sp(voice.panner.positionX, p.x, now, 0.02);
        sp(voice.panner.positionY, p.y, now, 0.02);
        sp(voice.panner.positionZ, p.z, now, 0.02);
      } else if (voice.panner.setPosition) {
        try { voice.panner.setPosition(p.x, p.y, p.z); } catch (e) { /* ignore */ }
      }
      // Orientation from the car quaternion (local +Z forward).
      const q = slow ? car.quaternion : null;
      if (q) {
        _fwd.x = 2 * (q.x * q.z + q.w * q.y);
        _fwd.y = 2 * (q.y * q.z - q.w * q.x);
        _fwd.z = 1 - 2 * (q.x * q.x + q.y * q.y);
        if (voice.panner.orientationX) {
          sp(voice.panner.orientationX, _fwd.x, now, 0.05);
          sp(voice.panner.orientationY, _fwd.y, now, 0.05);
          sp(voice.panner.orientationZ, _fwd.z, now, 0.05);
        } else if (voice.panner.setOrientation) {
          try { voice.panner.setOrientation(_fwd.x, _fwd.y, _fwd.z); } catch (e) { /* ignore */ }
        }
      }
    }

    // Engine state of this car.
    const rpm = isNum(car.rpm) ? car.rpm : S.idleRpm;
    const thr = isNum(car.throttle) ? clamp01(car.throttle) : 0.3;
    const rn = clamp01((rpm - S.idleRpm * 0.55) / (S.maxRpm - S.idleRpm * 0.55));
    const base = firingFrequency(rpm) * 0.5;   // PeriodicWave runs at half order

    // Doppler from radial velocity along the source→listener unit vector.
    const inv = 1 / dist;
    _sv.x = dx * inv; _sv.y = dy * inv; _sv.z = dz * inv;
    let cents = 0;
    const cv = car.velocity;
    if (cv) {
      const vs = cv.x * _sv.x + cv.y * _sv.y + cv.z * _sv.z;
      const vl = S.lvx * _sv.x + S.lvy * _sv.y + S.lvz * _sv.z;
      const num = SPEED_OF_SOUND - vl;
      const den = SPEED_OF_SOUND - vs;
      if (den > 30 && num > 30) {
        const ratio = num / den;
        cents = clamp(1200 * Math.log2(ratio), -700, 700);
      }
    }

    spf(voice.oSoft.frequency, base, now, 0.03, 6, 6000);
    spf(voice.oHard.frequency, base, now, 0.03, 6, 6000);
    sp(voice.oSoft.detune, cents - 5, now, 0.04);
    sp(voice.oHard.detune, cents + 6, now, 0.04);

    const open = Math.pow(thr, 0.7);
    if (slow) {
      sp(voice.softG.gain, (1 - open) * 0.9 + 0.08, now, 0.06);
      sp(voice.hardG.gain, open * 1.05 + 0.02, now, 0.06);

      // Air absorption: distant cars lose their top end.
      const airCut = clamp(19000 * Math.exp(-dist / 150), 700, 18000);
      spf(voice.air.frequency, airCut, now, 0.12, 200, S.ac.sampleRate * 0.46);

      if (voice.noiseGain) {
        const spd = isNum(car.speed) ? car.speed : 0;
        const tyreish = clamp01(spd / 85) * 0.09;
        sp(voice.noiseGain.gain, tyreish * (voice.fadeOut ? 0 : 1), now, 0.12);
      }
    }

    let lvl = (0.16 + 0.84 * open) * (0.35 + 0.65 * rn) * 0.5;
    lvl *= mix.ai;
    if (voice.fadeOut) lvl = 0;
    // A little near-field boost so a car alongside really shouts.
    lvl *= 1 + 0.35 * clamp01(1 - dist / 25);
    sp(voice.out.gain, Math.max(0.00005, lvl), now, voice.fadeOut ? 0.05 : 0.09);

    if (voice.fadeOut) {
      voice.swapTimer -= dt;
      if (voice.swapTimer <= 0) { voice.car = null; voice.carId = null; }
    } else if (voice.swapTimer > 0) {
      voice.swapTimer -= dt;
    }
  }

  /* ============================== listener =============================== */

  function updateListener(camera, dt, now) {
    if (!camera) return;
    let px = 0, py = 0, pz = 0;
    let fx = 0, fy = 0, fz = -1;
    let ux = 0, uy = 1, uz = 0;

    const mw = camera.matrixWorld;
    if (mw && mw.elements) {
      const e = mw.elements;
      px = e[12]; py = e[13]; pz = e[14];
      // three.js cameras look down local -Z.
      fx = -e[8]; fy = -e[9]; fz = -e[10];
      ux = e[4]; uy = e[5]; uz = e[6];
      const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
    } else if (camera.position) {
      px = camera.position.x; py = camera.position.y; pz = camera.position.z;
    } else {
      return;
    }

    if (!isNum(px) || !isNum(py) || !isNum(pz)) return;

    if (S.listenerInit && dt > 1e-4) {
      const invDt = 1 / dt;
      const nvx = (px - S.lx) * invDt;
      const nvy = (py - S.ly) * invDt;
      const nvz = (pz - S.lz) * invDt;
      // Smooth: raw camera deltas are noisy and would make Doppler warble.
      const k = 1 - Math.exp(-dt / 0.06);
      S.lvx += (nvx - S.lvx) * k;
      S.lvy += (nvy - S.lvy) * k;
      S.lvz += (nvz - S.lvz) * k;
    } else {
      S.listenerInit = true;
    }
    S.lx = px; S.ly = py; S.lz = pz;

    const L = S.ac.listener;
    if (!L) return;
    if (L.positionX) {
      sp(L.positionX, px, now, 0.015);
      sp(L.positionY, py, now, 0.015);
      sp(L.positionZ, pz, now, 0.015);
      sp(L.forwardX, fx, now, 0.03);
      sp(L.forwardY, fy, now, 0.03);
      sp(L.forwardZ, fz, now, 0.03);
      sp(L.upX, ux, now, 0.05);
      sp(L.upY, uy, now, 0.05);
      sp(L.upZ, uz, now, 0.05);
    } else {
      try {
        if (L.setPosition) L.setPosition(px, py, pz);
        if (L.setOrientation) L.setOrientation(fx, fy, fz, ux, uy, uz);
      } catch (e) { /* ignore */ }
    }
  }

  /* =============================== tyres ================================= */

  const _wheelStat = {
    slipAngle: 0, slipRatio: 0, locked: 0, spinning: 0,
    load: 0, contact: 0, kerb: 0, offroad: 0, wet: 0,
  };

  function gatherWheels(player, weather) {
    const w = player && player.wheels;
    _wheelStat.slipAngle = 0; _wheelStat.slipRatio = 0;
    _wheelStat.locked = 0; _wheelStat.spinning = 0;
    _wheelStat.load = 0; _wheelStat.contact = 0;
    _wheelStat.kerb = 0; _wheelStat.offroad = 0;
    _wheelStat.wet = weather && isNum(weather.trackWetness) ? clamp01(weather.trackWetness) : 0;
    if (!w || !w.length) return;
    const n = w.length;
    for (let i = 0; i < n; i++) {
      const wh = w[i];
      if (!wh) continue;
      if (wh.contact === false) continue;
      _wheelStat.contact++;
      const sa = isNum(wh.slipAngle) ? Math.abs(wh.slipAngle) : 0;
      const sr = isNum(wh.slipRatio) ? Math.abs(wh.slipRatio) : 0;
      if (sa > _wheelStat.slipAngle) _wheelStat.slipAngle = sa;
      if (sr > _wheelStat.slipRatio) _wheelStat.slipRatio = sr;
      if (wh.lockedUp) _wheelStat.locked++;
      if (wh.spinning) _wheelStat.spinning++;
      if (isNum(wh.load)) _wheelStat.load += wh.load;
      const s = wh.surface;
      if (s === 'kerb') _wheelStat.kerb++;
      else if (s === 'grass' || s === 'gravel' || s === 'astro') _wheelStat.offroad++;
    }
    if (_wheelStat.contact > 0) _wheelStat.load /= _wheelStat.contact;
  }

  function updateTyres(dt, now, mix, slow) {
    const spd = S.speed;
    const gate = smoothstep(2.0, 9.0, spd);
    const wet = _wheelStat.wet;

    // Lateral squeal — resonant, centre frequency climbs with slip angle then
    // detunes downward as the tyre gives up and starts to slide.
    const saDeg = _wheelStat.slipAngle * 57.2958;
    const squealCurve = smoothstep(2.6, 8.0, saDeg) * (1 - smoothstep(15, 30, saDeg) * 0.55);
    const loadN = clamp01(_wheelStat.load / 4200);
    let squealTarget = squealCurve * gate * (0.35 + 0.65 * loadN) * (1 - wet * 0.72);
    squealTarget *= clamp01(0.35 + 0.65 * clamp01(spd / 40));

    // Longitudinal scrub / lock-up roar — broader and lower.
    const lockAmt = clamp01(_wheelStat.slipRatio * 1.35) + _wheelStat.locked * 0.28;
    const spinAmt = _wheelStat.spinning * 0.22;
    let scrubTarget = clamp01(lockAmt + spinAmt) * gate * (0.4 + 0.6 * loadN) * (1 - wet * 0.45);

    // Water film hiss replaces rubber squeal on a wet track.
    let wetTarget = wet * gate * clamp01(spd / 55) * 0.55;
    wetTarget *= 0.55 + 0.45 * clamp01(_wheelStat.slipRatio * 2 + saDeg / 20);

    // Off-track surface.
    let offTarget = clamp01(_wheelStat.offroad / 4) * gate * clamp01(spd / 30);

    S.squeal = approach(S.squeal, squealTarget, dt, squealTarget > S.squeal ? 0.045 : 0.12);
    S.scrub = approach(S.scrub, scrubTarget, dt, scrubTarget > S.scrub ? 0.03 : 0.1);
    S.wetHiss = approach(S.wetHiss, wetTarget, dt, 0.18);
    S.offroad = approach(S.offroad, offTarget, dt, 0.08);

    const squealF = 780 + smoothstep(2, 14, saDeg) * 1250 + clamp01(spd / 80) * 260;
    const squealF2 = squealF * 2.02 + 120;
    spf(G.squealBP.frequency, squealF, now, 0.05, 120, 9000);
    spf(G.squealBP2.frequency, squealF2, now, 0.05, 200, 14000);
    spf(G.squealBP.Q, 7 + 8 * squealCurve, now, 0.1, 0.5, 30);
    spf(G.squealBP2.Q, 5 + 6 * squealCurve, now, 0.1, 0.5, 30);
    sp(G.squealGain.gain, Math.max(0.00005, S.squeal * 0.38 * mix.tyre), now, 0.04);

    const scrubF = 190 + clamp01(spd / 70) * 420 + lockAmt * 150;
    spf(G.scrubBP.frequency, scrubF, now, 0.06, 60, 4000);
    spf(G.scrubBP.Q, 0.85 + lockAmt * 0.8, now, 0.1, 0.2, 8);
    sp(G.scrubGain.gain, Math.max(0.00005, S.scrub * 0.46 * mix.tyre), now, 0.045);

    if (slow) {
      spf(G.wetHP.frequency, 1500 + clamp01(spd / 80) * 2600, now, 0.12, 300, 12000);
      sp(G.wetGain.gain, Math.max(0.00005, S.wetHiss * 0.34 * mix.tyre), now, 0.12);

      spf(G.offBP.frequency, 200 + clamp01(spd / 45) * 520, now, 0.08, 60, 3000);
      if (G.offSrc && G.offSrc.playbackRate) {
        spf(G.offSrc.playbackRate, 0.6 + clamp01(spd / 60) * 1.1, now, 0.1, 0.1, 4);
      }
      sp(G.offGain.gain, Math.max(0.00005, S.offroad * 0.5 * mix.tyre), now, 0.06);
    }
  }

  /* ================================ wind ================================= */

  function updateWind(dt, now, mix, weather, drs, slow) {
    const spd = S.speed;
    const sn = clamp01(spd / 95);
    const windAmb = weather && isNum(weather.windSpeed) ? clamp01(weather.windSpeed / 22) : 0;

    const level = (Math.pow(sn, 1.75) * 0.62 + windAmb * 0.08) * mix.wind * (drs ? 1.12 : 1.0);
    sp(G.windGain.gain, Math.max(0.00005, level), now, 0.09);
    spf(G.windLP.frequency, 340 + sn * 3900, now, 0.12, 120, 16000);

    // Buffet: low rumble that grows with speed and gusting.
    const buffet = (Math.pow(sn, 2.2) * 0.30 + windAmb * 0.10) * mix.wind;
    sp(G.windBuffetGain.gain, Math.max(0.00005, buffet), now, 0.12);
    spf(G.windBP.frequency, 220 + sn * 340, now, 0.15, 60, 2000);

    // Rain ambience — changes over seconds, so the slow tick is plenty.
    if (slow) {
      const rain = weather && isNum(weather.rainIntensity) ? clamp01(weather.rainIntensity) : 0;
      const rainLvl = rain * 0.16 * mix.amb;
      sp(G.rainGain.gain, Math.max(0.00005, rainLvl), now, 0.5);
      spf(G.rainHP.frequency, 1100 + rain * 1400, now, 0.5, 300, 9000);
    }
  }

  /* ============================ engine update ============================ */

  function updateEngine(dt, now, player, mix, slow) {
    const maxRpm = S.maxRpm;
    const rpmRaw = isNum(player.rpm) ? clamp(player.rpm, 0, maxRpm * 1.15) : S.idleRpm;
    const thr = isNum(player.throttle) ? clamp01(player.throttle) : 0;
    const brk = isNum(player.brake) ? clamp01(player.brake) : 0;

    S.rpmPrev = S.rpm;
    // Light smoothing keeps the pitch glide musical without lagging behind.
    S.rpm = approach(S.rpm, rpmRaw, dt, 0.022);
    S.rpmN = clamp01((S.rpm - S.idleRpm * 0.5) / (maxRpm - S.idleRpm * 0.5));

    S.loadRaw = thr;
    S.load = approach(S.load, thr, dt, thr > S.load ? 0.035 : 0.075);

    // Overrun grows on a closed throttle at revs, decays fast on reapplication.
    const overTarget = (1 - smoothstep(0.02, 0.22, thr)) * smoothstep(0.30, 0.62, S.rpmN) * smoothstep(3, 14, S.speed);
    S.overrun = approach(S.overrun, overTarget, dt, overTarget > S.overrun ? 0.09 : 0.18);

    // Combustion irregularity: more at low rpm, smooths out at the top end.
    S.irregTarget = (S.rng() * 2 - 1) * (0.55 + 0.45 * (1 - S.rpmN));
    S.irregular = approach(S.irregular, S.irregTarget, dt, 0.055);

    updatePartialPitch(now);

    /* ----- intake honk ----- */
    const f0 = firingFrequency(S.rpm);
    spf(G.intakeOsc.frequency, f0 * 0.5, now, 0.02, 5, 6000);
    const intakeCentre = 330 + S.rpmN * 1150 + S.load * 130;
    spf(G.intakeBP.frequency, intakeCentre, now, 0.05, 90, 8000);
    const intakeLvl = Math.pow(S.load, 0.55) * (0.13 + 0.16 * S.rpmN) * (1 - S.overrun * 0.7);
    sp(G.intakeGain.gain, Math.max(0.00005, intakeLvl), now, 0.05);

    /* ----- turbo spool (lags throttle with a real time constant) ----- */
    const boostTarget = clamp01(thr * (0.22 + 0.78 * S.rpmN));
    const boostTau = boostTarget > S.boost ? 0.38 : 0.17;
    S.boost = approach(S.boost, boostTarget, dt, boostTau);

    const whistle = 850 + S.boost * 5400 + S.rpmN * 900;
    spf(G.turboOsc.frequency, whistle, now, 0.07, 200, 16000);
    const turboLvl = Math.pow(S.boost, 1.7) * 0.075;
    sp(G.turboGain.gain, Math.max(0.00005, turboLvl), now, 0.08);
    sp(G.turboNoiseGain.gain, Math.max(0.00005, Math.pow(S.boost, 1.35) * 0.055), now, 0.09);

    /* ----- MGU-K / MGU-H whine ----- */
    let deploy = 0;
    const ers = player.ers;
    if (ers) {
      if (ers.deploying) deploy = 1;
      else if (isNum(ers.deploy)) deploy = clamp01(ers.deploy);
      if (ers.mode === 'overtake' || ers.mode === 'hotlap') deploy = Math.max(deploy, 0.85);
    }
    S.ersDeploy = approach(S.ersDeploy, deploy, dt, 0.22);
    const mguF = 620 + S.rpmN * 5200;
    spf(G.mguOsc.frequency, mguF, now, 0.04, 100, 17000);
    spf(G.mguOsc2.frequency, mguF * 1.5, now, 0.04, 100, 19000);
    const mguLvl = (0.012 + 0.030 * S.ersDeploy) * (0.25 + 0.75 * S.rpmN) * (0.35 + 0.65 * S.load);
    sp(G.mguGain.gain, Math.max(0.00005, mguLvl), now, 0.09);

    /* ----- wastegate flutter on lift ----- */
    const thrDrop = S.throttlePrev - thr;
    if (thrDrop > 0.28 && S.boost > 0.35 && S.engineRunning) {
      shot(BUF.flutter, 0.30 * S.boost, 0.85 + S.rng() * 0.4, 2400 + S.rng() * 1400, 1.4, 'bandpass', G.exhaustFx);
      S.crackleEnergy = Math.max(S.crackleEnergy, 0.55 + 0.45 * S.rpmN);
    }
    S.throttlePrev = thr;

    /* ----- overrun crackle scheduling ----- */
    if (S.overrun > 0.35 && S.engineRunning) {
      S.crackleEnergy = Math.max(S.crackleEnergy, S.overrun * (0.5 + 0.5 * S.rpmN));
    }
    S.crackleEnergy = approach(S.crackleEnergy, 0, dt, 0.55);
    if (S.crackleEnergy > 0.06 && S.engineRunning && S.crackleScale > 0) {
      S.crackleTimer -= dt;
      if (S.crackleTimer <= 0) {
        S.crackleTimer = 0.022 + S.rng() * 0.085 * (1.6 - S.crackleEnergy);
        if (S.rng() < 0.55 + 0.45 * S.crackleEnergy) {
          crackle(0.16 * S.crackleEnergy * (0.6 + 0.4 * brk), 1);
        }
      }
    }

    /* ----- pit limiter stutter ----- */
    let lim = false;
    if (player.pitLimiter) lim = true;
    else if (player.limiter) lim = true;
    else if (player.pitLimiterActive) lim = true;
    if (lim !== S.limiterOn) {
      S.limiterOn = lim;
    }
    sp(G.limiterCut.gain, S.limiterOn ? 0.60 : 1.0, now, 0.05);
    sp(G.limiterDepth.gain, S.limiterOn ? 0.38 : 0.0, now, 0.05);

    /* ----- gear change detection ----- */
    const gear = isNum(player.gear) ? player.gear : S.gearPrev;
    if (gear !== S.gearPrev) {
      const up = gear > S.gearPrev && !(S.gearPrev <= 0 && gear <= 0);
      if (S.engineRunning && Math.abs(gear - S.gearPrev) < 4) doGearShift(up);
      S.gearPrev = gear;
    }

    /* ----- DRS detection ----- */
    const drs = !!player.drs;
    if (drs !== S.drsPrev) {
      if (S.engineRunning) doDrs(drs);
      S.drsPrev = drs;
    }

    /* ----- master engine level + camera mix ----- */
    const target = S.engineRunning ? S.volEngine * mix.engine : 0.0001;
    sp(G.engineOut.gain, Math.max(0.0001, target), now, S.engineRunning ? 0.10 : 0.25);

    // Exhaust tone opens with load: sharper, more top end under power.
    if (slow) {
      spf(G.engineShapeLP.frequency, 4200 + S.load * 6200 + S.rpmN * 3400, now, 0.10, 500, 19000);
      sp(G.enginePeak.gain, 2.5 + 4.0 * S.load - S.overrun * 2.0, now, 0.10);
      spf(G.enginePeak.frequency, 1900 + S.rpmN * 1500, now, 0.10, 300, 12000);
      sp(G.engineLowShelf.gain, 2.0 + 3.5 * S.load, now, 0.12);
      spf(G.turboNoiseBP.frequency, whistle * 1.15 + 900, now, 0.09, 400, 17000);
      spf(G.turboNoiseBP.Q, 6 + S.boost * 8, now, 0.12, 1, 24);
      spf(G.intakeBP.Q, 2.6 + 2.4 * S.load, now, 0.1, 0.4, 14);
      spf(G.mguFilter.frequency, mguF * 1.1, now, 0.06, 200, 18000);
      spf(G.limiterLfo.frequency, 15.5 + S.rpmN * 8, now, 0.15, 4, 60);
    }
  }

  function doGearShift(up) {
    if (!S.ready) return;
    const now = S.ac.currentTime;
    triggerShiftCut(up);
    // Paddle / dog-ring click.
    shot(BUF.click, up ? 0.34 : 0.28, up ? 1.12 : 0.94, up ? 3400 : 2500, 1.1, 'bandpass', G.sfxBus, now);
    // Mechanical thunk through the chassis.
    shot(BUF.thump, 0.11, 1.9, 320, 1.4, 'bandpass', G.sfxBus, now + 0.004);
    if (up) {
      // Upshift bang out of the exhaust.
      crackle(0.30 * (0.4 + 0.6 * S.rpmN), 2);
      S.crackleEnergy = Math.max(S.crackleEnergy, 0.35 * S.rpmN);
    } else {
      // Downshift blip + a burst of crackle on the reopened throttle.
      const p = G.engineCore.gain;
      try {
        p.cancelScheduledValues(now);
        p.setValueAtTime(1, now);
        p.linearRampToValueAtTime(1.34, now + 0.035);
        p.linearRampToValueAtTime(1.0, now + 0.20);
      } catch (e) { /* ignore */ }
      crackle(0.34 * (0.35 + 0.65 * S.rpmN), 3);
      S.crackleEnergy = Math.max(S.crackleEnergy, 0.75);
    }
  }

  function doDrs(open) {
    if (!S.ready) return;
    const now = S.ac.currentTime;
    if (open) {
      shot(BUF.psst, 0.30, 1.0, 3200, 1.0, 'highpass', G.sfxBus, now);
      shot(BUF.thunk, 0.16, 1.35, 900, 1.0, 'bandpass', G.sfxBus, now + 0.055);
    } else {
      shot(BUF.psst, 0.18, 1.25, 2400, 1.0, 'highpass', G.sfxBus, now);
      shot(BUF.thunk, 0.30, 0.82, 520, 1.2, 'lowpass', G.sfxBus, now + 0.02);
    }
  }

  /* =============================== kerbs ================================= */

  function updateKerbs(dt, now) {
    const onKerb = _wheelStat.kerb > 0;
    S.kerbActive = approach(S.kerbActive, onKerb ? 1 : 0, dt, onKerb ? 0.02 : 0.08);
    if (!onKerb || S.speed < 3) { S.kerbPhase = 0; return; }
    // Kerb ribs are ~0.5 m apart; the strike rate is speed / pitch.
    const pitch = 0.52;
    const rate = S.speed / pitch;
    S.kerbPhase += rate * dt;
    if (S.kerbPhase >= 1) {
      S.kerbPhase -= Math.floor(S.kerbPhase);
      const intensity = clamp01(0.25 + _wheelStat.kerb * 0.22 + clamp01(S.speed / 70) * 0.4);
      playKerbInternal(intensity);
    }
  }

  function playKerbInternal(intensity) {
    const i = clamp01(intensity);
    shot(BUF.thump, 0.16 + 0.34 * i, 0.85 + S.rng() * 0.45,
      140 + S.rng() * 220, 1.1, 'lowpass', G.sfxBus);
    if (S.rng() < 0.45) {
      shot(BUF.pops ? BUF.pops[1] : null, 0.05 + 0.09 * i, 1.4 + S.rng() * 0.7,
        1800 + S.rng() * 1800, 1.6, 'bandpass', G.sfxBus);
    }
  }

  /* ============================ UI + one-shots =========================== */

  /** Generic melodic blip. Allocates only for the (rare) UI event itself. */
  function tone(type, f0, f1, dur, level, dest, delay, detune) {
    if (!S.ready) return;
    const ac = S.ac;
    const t0 = ac.currentTime + (delay || 0);
    try {
      const o = ac.createOscillator();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(Math.max(1, f0), t0);
      if (isNum(f1) && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
      if (isNum(detune)) o.detune.value = detune;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t0 + Math.min(0.012, dur * 0.25));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(dest || G.uiBus);
      o._apexChain = [g];
      o.onended = _chainDisconnect;
      o.start(t0);
      o.stop(t0 + dur + 0.03);
    } catch (e) { /* ignore */ }
  }

  const UI_SOUNDS = {
    click: function () {
      tone('square', 1320, 1180, 0.045, 0.10, G.uiBus, 0);
      shot(BUF.click, 0.10, 1.6, 4200, 1.0, 'highpass', G.uiBus);
    },
    hover: function () {
      tone('sine', 880, 1240, 0.055, 0.045, G.uiBus, 0);
    },
    confirm: function () {
      tone('triangle', 660, 660, 0.09, 0.12, G.uiBus, 0);
      tone('triangle', 990, 990, 0.13, 0.11, G.uiBus, 0.075);
      tone('sine', 1320, 1320, 0.18, 0.055, G.uiBus, 0.075);
    },
    back: function () {
      tone('triangle', 760, 760, 0.07, 0.10, G.uiBus, 0);
      tone('triangle', 480, 440, 0.14, 0.09, G.uiBus, 0.055);
    },
    countdown: function () {
      tone('sine', 660, 660, 0.30, 0.20, G.uiBus, 0);
      tone('sine', 1320, 1320, 0.26, 0.055, G.uiBus, 0);
      tone('sine', 330, 330, 0.34, 0.09, G.uiBus, 0);
    },
    lightsout: function () {
      tone('sine', 1046, 1046, 0.55, 0.24, G.uiBus, 0);
      tone('sine', 1568, 1568, 0.50, 0.12, G.uiBus, 0.01);
      tone('sine', 523, 523, 0.62, 0.14, G.uiBus, 0);
      shot(BUF.psst, 0.16, 0.7, 900, 0.8, 'lowpass', G.uiBus);
    },
    flag: function () {
      tone('sine', 1174, 1174, 0.42, 0.16, G.uiBus, 0);
      tone('sine', 1568, 1568, 0.55, 0.13, G.uiBus, 0.11);
      tone('sine', 2093, 2093, 0.70, 0.075, G.uiBus, 0.22);
    },
    penalty: function () {
      tone('sawtooth', 233, 220, 0.20, 0.13, G.uiBus, 0);
      tone('sawtooth', 156, 148, 0.28, 0.12, G.uiBus, 0.14);
      tone('square', 117, 110, 0.30, 0.07, G.uiBus, 0.14);
    },
    error: function () {
      tone('square', 200, 150, 0.18, 0.12, G.uiBus, 0);
    },
    tick: function () {
      shot(BUF.click, 0.08, 2.2, 5200, 1.0, 'highpass', G.uiBus);
    },
  };

  /* ============================== team radio ============================= */

  const RADIO_KINDS = {
    box:    { syll: 5, pitch: 118, urgency: 0.5 },
    push:   { syll: 4, pitch: 132, urgency: 0.85 },
    info:   { syll: 8, pitch: 110, urgency: 0.25 },
    yellow: { syll: 5, pitch: 126, urgency: 0.8 },
    blue:   { syll: 4, pitch: 120, urgency: 0.55 },
    in:     { syll: 6, pitch: 114, urgency: 0.4 },
    out:    { syll: 3, pitch: 122, urgency: 0.5 },
    warn:   { syll: 6, pitch: 138, urgency: 0.95 },
    praise: { syll: 7, pitch: 128, urgency: 0.7 },
    strategy: { syll: 9, pitch: 108, urgency: 0.3 },
  };

  function playRadioInternal(kind) {
    if (!S.ready || !G.radioOut || !G.radioFormants) return;
    const ac = S.ac;
    const spec = RADIO_KINDS[kind] || RADIO_KINDS.info;
    const t0 = ac.currentTime + 0.02;

    try {
      // Duck the world a touch so the call cuts through.
      sp(G.worldBus.gain, 0.62, t0, 0.08);
      sp(G.radioOut.gain, 0.85, t0, 0.02);

      shot(BUF.squelch, 0.22, 1.0, 2600, 0.9, 'highpass', G.uiBus, t0);

      const syll = spec.syll + ((S.rng() * 3) | 0);
      const env = ac.createGain();
      env.gain.setValueAtTime(0.0001, t0);

      const o = ac.createOscillator();
      o.type = 'sawtooth';
      const base = spec.pitch * (0.9 + S.rng() * 0.25);
      o.frequency.setValueAtTime(base, t0);

      o.connect(env);
      for (let i = 0; i < G.radioFormants.length; i++) env.connect(G.radioFormants[i].filter);

      let t = t0 + 0.06;
      for (let i = 0; i < syll; i++) {
        const dur = 0.075 + S.rng() * 0.11 * (1.3 - spec.urgency * 0.5);
        const amp = 0.16 + S.rng() * 0.20 * (0.6 + spec.urgency * 0.6);
        env.gain.setValueAtTime(Math.max(0.0001, env.gain.value), t);
        env.gain.linearRampToValueAtTime(amp, t + dur * 0.28);
        env.gain.linearRampToValueAtTime(amp * 0.6, t + dur * 0.72);
        env.gain.linearRampToValueAtTime(0.004, t + dur);
        // Intonation contour: falls toward the end of the phrase.
        const p = base * (1 + (S.rng() - 0.35) * 0.28) * (1 - i / (syll * 2.6));
        o.frequency.setValueAtTime(Math.max(50, p), t);
        o.frequency.linearRampToValueAtTime(Math.max(50, p * (0.94 + S.rng() * 0.12)), t + dur);
        t += dur + 0.018 + S.rng() * 0.05;
      }
      const end = t + 0.05;
      env.gain.linearRampToValueAtTime(0.0001, end);

      o._apexChain = [env];
      o.onended = _chainDisconnect;
      o.start(t0);
      o.stop(end + 0.05);

      shot(BUF.squelch, 0.17, 1.3, 3200, 0.9, 'highpass', G.uiBus, end);

      // Restore the world mix after the call.
      sp(G.worldBus.gain, 1.0, end + 0.06, 0.18);
      sp(G.radioOut.gain, 0.0001, end + 0.14, 0.12);
    } catch (e) { /* never break on a radio call */ }
  }

  /* ============================== impacts ================================ */

  function playImpactInternal(strength, pos) {
    if (!S.ready) return;
    const s = clamp01(isNum(strength) ? strength : 0.5);
    const ac = S.ac;
    const now = ac.currentTime;
    const v = impactVoices[impactCursor];
    impactCursor = (impactCursor + 1) % impactVoices.length;
    if (!v) return;

    try {
      if (v.panner && pos && isNum(pos.x)) {
        if (v.panner.positionX) {
          v.panner.positionX.setValueAtTime(pos.x, now);
          v.panner.positionY.setValueAtTime(pos.y, now);
          v.panner.positionZ.setValueAtTime(pos.z, now);
        } else if (v.panner.setPosition) {
          v.panner.setPosition(pos.x, pos.y, pos.z);
        }
      } else if (v.panner) {
        // No position given → put it right on the listener.
        if (v.panner.positionX) {
          v.panner.positionX.setValueAtTime(S.lx, now);
          v.panner.positionY.setValueAtTime(S.ly, now);
          v.panner.positionZ.setValueAtTime(S.lz, now);
        } else if (v.panner.setPosition) {
          v.panner.setPosition(S.lx, S.ly, S.lz);
        }
      }

      spf(v.filter.frequency, 900 + s * 12000, now, 0.005, 200, 19000);
      sp(v.gain.gain, clamp(0.35 + s * 0.9, 0, 1.6), now, 0.004);

      const dest = v.filter;
      // Low body mass.
      playInto(BUF.thud, dest, 0.55 + s * 0.85, 0.78 + (1 - s) * 0.35, now);
      // Carbon splinter — only really present on bigger hits.
      if (s > 0.12) playInto(BUF.crack, dest, (0.20 + s * 0.95) * s, 0.85 + s * 0.5, now + 0.004);
      // Broadband slam.
      playInto(BUF.pops ? BUF.pops[4] : null, dest, 0.30 + s * 0.7, 0.55 + s * 0.5, now);
      if (s > 0.45) {
        playInto(BUF.crack, dest, s * 0.55, 0.6, now + 0.05 + S.rng() * 0.06);
        playInto(BUF.thump, dest, s * 0.6, 0.7, now + 0.09 + S.rng() * 0.08);
      }
      // Big hits stall the engine note momentarily.
      if (s > 0.6 && S.engineRunning) {
        const p = G.shiftCut.gain;
        p.cancelScheduledValues(now);
        p.setValueAtTime(1, now);
        p.linearRampToValueAtTime(0.25, now + 0.01);
        p.linearRampToValueAtTime(1, now + 0.22);
      }
    } catch (e) { /* ignore */ }
  }

  /** Play a buffer straight into a node with a per-shot gain. */
  function playInto(buffer, dest, level, rate, when) {
    if (!buffer || !dest) return;
    const ac = S.ac;
    try {
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = clamp(rate || 1, 0.06, 6);
      const g = ac.createGain();
      g.gain.setValueAtTime(clamp(level, 0, 4), when);
      src.connect(g);
      g.connect(dest);
      src._apexChain = [g];
      src.onended = _chainDisconnect;
      src.start(when);
      src.stop(when + buffer.duration / src.playbackRate.value + 0.05);
    } catch (e) { /* ignore */ }
  }

  /* ============================== lifecycle ============================== */

  function makeContext() {
    if (O.context) return O.context;
    const Ctor = (typeof window !== 'undefined')
      ? (window.AudioContext || window.webkitAudioContext)
      : (typeof globalThis !== 'undefined' ? (globalThis.AudioContext || globalThis.webkitAudioContext) : null);
    if (!Ctor) return null;
    let ac = null;
    try {
      ac = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      try { ac = new Ctor(); } catch (e2) { ac = null; }
    }
    return ac;
  }

  function init() {
    if (S.initPromise) return S.initPromise;
    S.initPromise = new Promise(function (resolve) {
      if (S.disposed) { resolve(false); return; }
      let ac = null;
      try {
        ac = makeContext();
      } catch (e) {
        S.lastError = e; ac = null;
      }
      if (!ac) { S.failed = true; resolve(false); return; }

      S.ac = ac;
      S.ownsContext = !O.context;

      const finish = function () {
        try {
          buildAllBuffers(ac);
          buildGraph();
          S.ready = true;
          resolve(true);
        } catch (e) {
          S.lastError = e;
          S.failed = true;
          S.ready = false;
          try { teardown(); } catch (e2) { /* ignore */ }
          resolve(false);
        }
      };

      // A user gesture should let this resume immediately; if it doesn't we
      // still build the graph so a later resume() just works.
      if (ac.state === 'suspended' && ac.resume) {
        let settled = false;
        const go = function () { if (settled) return; settled = true; finish(); };
        try {
          const pr = ac.resume();
          if (pr && typeof pr.then === 'function') pr.then(go, go);
          else go();
        } catch (e) { go(); }
        // Safety net for browsers that never settle the resume promise.
        if (typeof setTimeout === 'function') setTimeout(go, 400);
      } else {
        finish();
      }
    });
    return S.initPromise;
  }

  function teardown() {
    for (let i = 0; i < S.sources.length; i++) {
      const s = S.sources[i];
      try { if (s.stop) s.stop(); } catch (e) { /* ignore */ }
    }
    for (let i = 0; i < S.nodes.length; i++) {
      try { S.nodes[i].disconnect(); } catch (e) { /* ignore */ }
    }
    S.sources.length = 0;
    S.nodes.length = 0;
    partials.length = 0;
    aiVoices.length = 0;
    shotVoices.length = 0;
    impactVoices.length = 0;
    BUF.white = null; BUF.pink = null; BUF.ir = null; BUF.pops = null;
    BUF.flutter = null; BUF.thump = null; BUF.click = null; BUF.crack = null;
    BUF.thud = null; BUF.gravel = null; BUF.crank = null; BUF.squelch = null;
    BUF.psst = null; BUF.thunk = null;
    for (const k in G) { if (Object.prototype.hasOwnProperty.call(G, k)) G[k] = null; }
  }

  /* ================================ update =============================== */

  function update(dt, ctx) {
    if (!S.ready || S.disposed) return;
    const ac = S.ac;
    if (!ac || ac.state === 'closed') return;
    // Nothing can be scheduled on a suspended context — bail cheaply.
    if (ac.state === 'suspended') return;

    let d = isNum(dt) ? dt : 0.016;
    if (d <= 0) d = 0.0001;
    if (d > 0.25) d = 0.25;
    S.time += d;

    const c = ctx || null;
    const now = ac.currentTime;

    /* ---- camera mix -------------------------------------------------- */
    try {
      const key = resolveMix(c && c.cameraMode);
      if (key && key !== S.mixKey) {
        S.mixKey = key;
        S.mix = MIX_PRESETS[key];
        S.mixJustChanged = true;
      }
      const m = S.mix;
      S.mixLp = approach(S.mixLp, m.lp, d, 0.35);
      S.mixHp = approach(S.mixHp, m.hp, d, 0.35);
      S.mixDirty = Math.abs(S.mixLp - m.lp) > 1 || Math.abs(S.mixHp - m.hp) > 0.05;
      if (S.mixDirty || S.mixJustChanged) {
        S.mixJustChanged = false;
        spf(G.cabinLP.frequency, S.mixLp, now, 0.08, 200, ac.sampleRate * 0.46);
        spf(G.cabinHP.frequency, S.mixHp, now, 0.08, 20, 1200);
        if (G.reverbSend) sp(G.reverbSend.gain, 0.16 * m.rev, now, 0.3);
      }
    } catch (e) { /* ignore */ }

    const mix = S.mix;

    /* ---- slow tick: everything that doesn't need 60 Hz resolution ------ */
    S.slowAcc += d;
    let slow = false;
    if (S.slowAcc >= RATE_SLOW) { S.slowAcc = 0; slow = true; }

    /* ---- listener ----------------------------------------------------- */
    try { updateListener(c && c.camera, d, now); } catch (e) { /* ignore */ }

    /* ---- player car --------------------------------------------------- */
    const player = c && c.player ? c.player : null;
    if (player) {
      try {
        S.speed = isNum(player.speed) ? Math.abs(player.speed) : S.speed;
        S.speedN = clamp01(S.speed / 95);
        gatherWheels(player, c && c.weather);
        updateEngine(d, now, player, mix, slow);
        if (slow) updatePartials(now);
        updateTyres(d, now, mix, slow);
        updateWind(d, now, mix, c && c.weather, !!player.drs, slow);
        updateKerbs(d, now);
      } catch (e) { S.lastError = e; }
    } else {
      // No player (menus, replays): fade the car-bound layers away.
      try {
        sp(G.squealGain.gain, 0.00005, now, 0.2);
        sp(G.scrubGain.gain, 0.00005, now, 0.2);
        sp(G.wetGain.gain, 0.00005, now, 0.2);
        sp(G.offGain.gain, 0.00005, now, 0.2);
        sp(G.windGain.gain, 0.00005, now, 0.3);
        sp(G.windBuffetGain.gain, 0.00005, now, 0.3);
      } catch (e) { /* ignore */ }
    }

    /* ---- AI positional voices ------------------------------------------ */
    if (aiVoices.length) {
      try {
        const cars = c && c.cars;
        S.aiAcc += d;
        if (cars && cars.length && S.aiAcc >= RATE_AI) {
          S.aiAcc = 0;
          assignAiVoices(cars, player);
        }
        for (let i = 0; i < aiVoices.length; i++) updateAiVoice(aiVoices[i], d, now, mix, slow);
      } catch (e) { S.lastError = e; }
    }
  }

  /* ================================= API ================================= */

  function startEngine() {
    if (!S.ready || S.engineRunning) return;
    S.engineRunning = true;
    try {
      const now = S.ac.currentTime;
      S.rpm = S.idleRpm * 0.35;
      S.gearPrev = 0;
      // Starter motor, then the engine catches.
      shot(BUF.crank, 0.34, 1.0, 1400, 0.9, 'lowpass', G.sfxBus, now);
      sp(G.engineOut.gain, Math.max(0.0001, S.volEngine * S.mix.engine), now + 0.62, 0.16);
      crackle(0.30, 3);
    } catch (e) { /* ignore */ }
  }

  function stopEngine() {
    if (!S.ready || !S.engineRunning) return;
    S.engineRunning = false;
    try {
      const now = S.ac.currentTime;
      sp(G.engineOut.gain, 0.0001, now, 0.30);
      sp(G.limiterDepth.gain, 0, now, 0.05);
      sp(G.limiterCut.gain, 1, now, 0.05);
      S.limiterOn = false;
      crackle(0.12, 2);
    } catch (e) { /* ignore */ }
  }

  function playUI(name) {
    if (!S.ready) return;
    const fn = UI_SOUNDS[name];
    try { if (fn) fn(); else UI_SOUNDS.click(); } catch (e) { /* ignore */ }
  }

  function setMasterVolume(v) {
    S.volMaster = clamp01(isNum(v) ? v : 0);
    if (!S.ready) return;
    try { sp(G.master.gain, S.muted ? 0 : S.volMaster, S.ac.currentTime, 0.05); } catch (e) { /* ignore */ }
  }

  function setEngineVolume(v) {
    S.volEngine = clamp01(isNum(v) ? v : 0);
    if (!S.ready) return;
    try {
      const target = S.engineRunning ? S.volEngine * S.mix.engine : 0.0001;
      sp(G.engineOut.gain, Math.max(0.0001, target), S.ac.currentTime, 0.06);
    } catch (e) { /* ignore */ }
  }

  function setUIVolume(v) {
    S.volUI = clamp01(isNum(v) ? v : 0);
    if (!S.ready) return;
    try { sp(G.uiBus.gain, S.volUI, S.ac.currentTime, 0.05); } catch (e) { /* ignore */ }
  }

  function setMuted(b) {
    S.muted = !!b;
    if (!S.ready) return;
    try { sp(G.master.gain, S.muted ? 0 : S.volMaster, S.ac.currentTime, 0.04); } catch (e) { /* ignore */ }
  }

  function suspend() {
    if (!S.ac || !S.ac.suspend) return Promise.resolve(false);
    try {
      const p = S.ac.suspend();
      if (p && typeof p.then === 'function') return p.then(function () { return true; }, function () { return false; });
      return Promise.resolve(true);
    } catch (e) { return Promise.resolve(false); }
  }

  function resume() {
    if (!S.ac || !S.ac.resume) return Promise.resolve(false);
    try {
      const p = S.ac.resume();
      if (p && typeof p.then === 'function') return p.then(function () { return true; }, function () { return false; });
      return Promise.resolve(true);
    } catch (e) { return Promise.resolve(false); }
  }

  function dispose() {
    if (S.disposed) return;
    S.disposed = true;
    S.ready = false;
    S.engineRunning = false;
    try { teardown(); } catch (e) { /* ignore */ }
    if (S.ac && S.ownsContext && S.ac.close && S.ac.state !== 'closed') {
      try {
        const p = S.ac.close();
        if (p && typeof p.catch === 'function') p.catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }
    S.ac = null;
  }

  /* ------------------------------- public -------------------------------- */

  const api = {
    init: init,
    update: update,
    startEngine: startEngine,
    stopEngine: stopEngine,
    playUI: playUI,

    playImpact: function (strength, pos) {
      try { playImpactInternal(strength, pos); } catch (e) { /* ignore */ }
    },
    playKerb: function (intensity) {
      if (!S.ready) return;
      try { playKerbInternal(isNum(intensity) ? intensity : 0.5); } catch (e) { /* ignore */ }
    },
    playGearShift: function (up) {
      if (!S.ready) return;
      try { doGearShift(up !== false); } catch (e) { /* ignore */ }
    },
    playDRS: function (open) {
      if (!S.ready) return;
      try { doDrs(!!open); } catch (e) { /* ignore */ }
    },
    playRadio: function (kind) {
      try { playRadioInternal(kind); } catch (e) { /* ignore */ }
    },

    setMasterVolume: setMasterVolume,
    setEngineVolume: setEngineVolume,
    setUIVolume: setUIVolume,
    setMuted: setMuted,
    suspend: suspend,
    resume: resume,
    dispose: dispose,

    /* ------------ extras (optional, safe to ignore) ------------ */

    /** Force the camera mix immediately (update() also derives it from ctx). */
    setCameraMode: function (mode) {
      const key = resolveMix(mode);
      if (!key) return false;
      S.mixKey = key;
      S.mix = MIX_PRESETS[key];
      if (S.ready) { try { applyMix(S.mix, 0.2); } catch (e) { /* ignore */ } }
      return true;
    },

    /** Fire a burst of exhaust crackle manually (e.g. scripted cutscenes). */
    playCrackle: function (intensity, count) {
      if (!S.ready) return;
      try { crackle(clamp01(isNum(intensity) ? intensity : 0.5), count || 3); } catch (e) { /* ignore */ }
    },

    /** Pit-limiter stutter can also be driven explicitly. */
    setPitLimiter: function (on) {
      S.limiterOn = !!on;
      if (!S.ready) return;
      try {
        const now = S.ac.currentTime;
        sp(G.limiterCut.gain, S.limiterOn ? 0.60 : 1.0, now, 0.05);
        sp(G.limiterDepth.gain, S.limiterOn ? 0.38 : 0.0, now, 0.05);
      } catch (e) { /* ignore */ }
    },

    /** Diagnostics for the debug overlay. Allocation-free (returns live refs). */
    getDiagnostics: function () {
      _diag.ready = S.ready;
      _diag.state = S.ac ? S.ac.state : 'none';
      _diag.sampleRate = S.ac ? S.ac.sampleRate : 0;
      _diag.partials = partials.length;
      _diag.aiVoices = aiVoices.length;
      _diag.rpm = S.rpm;
      _diag.load = S.load;
      _diag.boost = S.boost;
      _diag.overrun = S.overrun;
      _diag.squeal = S.squeal;
      _diag.scrub = S.scrub;
      _diag.mix = S.mixKey;
      _diag.tier = tierName;
      _diag.reverb = !!G.convolver;
      _diag.error = S.lastError ? String(S.lastError && S.lastError.message ? S.lastError.message : S.lastError) : null;
      return _diag;
    },

    get context() { return S.ac; },
    get muted() { return S.muted; },
    get running() { return S.engineRunning; },
    get masterVolume() { return S.volMaster; },
    get engineVolume() { return S.volEngine; },
    get uiVolume() { return S.volUI; },
  };

  const _diag = {
    ready: false, state: 'none', sampleRate: 0, partials: 0, aiVoices: 0,
    rpm: 0, load: 0, boost: 0, overrun: 0, squeal: 0, scrub: 0,
    mix: 'chase', tier: tierName, reverb: false, error: null,
  };

  Object.defineProperty(api, 'ready', {
    enumerable: true,
    get: function () { return S.ready; },
  });

  return api;
}

export default createAudio;

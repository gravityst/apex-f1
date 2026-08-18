/**
 * APEX F1 — In-race HUD.
 * =====================================================================================
 * A DOM + CSS heads-up display with a single <canvas> minimap. Resolution independent,
 * GPU friendly (transform/opacity animation only), and completely self contained: the
 * module builds every element it needs inside the `root` element it is handed and
 * injects nothing globally. The caller is responsible for one thing only:
 *
 *     <link rel="stylesheet" href="./styles/hud.css">
 *
 * Zero side effects at import time. No network access. No three.js dependency.
 *
 * Public factory
 * --------------
 *   createHUD(root, opts) -> {
 *     update(dt, ctx), setTrackOutline(points), showMessage(text, kind, ms),
 *     showFlag(kind), setVisible(b), setCameraMode(name), setUnits(u),
 *     setTeamAccent(hex), resize(), dispose(),
 *     // extras (safe to ignore)
 *     flashSector(i, kind, seconds), setLapCounter(lap, total), setPosition(p, of),
 *     clearMessages(), isCompact(), el
 *   }
 *
 * The HUD is defensive by design: every subsystem updates inside its own guard, and a
 * subsystem that throws repeatedly is quietly retired rather than being allowed to take
 * the frame loop down with it.
 */

import { TEAMS, TYRE_COMPOUNDS } from './teams.js';

/* ═════════════════════════════════════════════════════════════════════════════════════
   Module scope constants + scratch (never allocate inside update())
   ═════════════════════════════════════════════════════════════════════════════════════ */

const SVGNS = 'http://www.w3.org/2000/svg';

const TEAM_BY_ID = (() => {
  const m = new Map();
  try {
    for (let i = 0; i < TEAMS.length; i++) m.set(TEAMS[i].id, TEAMS[i]);
  } catch (e) { /* teams data unavailable — colours fall back to neutral grey */ }
  return m;
})();

const COMPOUNDS = (() => {
  try { return TYRE_COMPOUNDS || {}; } catch (e) { return {}; }
})();

const MS_PER_S = 3.6;                 // m/s -> km/h
const MPH_PER_MS = 2.2369362920544;   // m/s -> mph
const RAD2DEG = 57.29577951308232;

const ERS_MODE_NAMES = ['OFF', 'BUILD', 'BALANCED', 'ATTACK', 'HOTLAP'];

const FLAG_KINDS = {
  green:        { label: 'GREEN FLAG',      sub: 'TRACK CLEAR' },
  yellow:       { label: 'YELLOW FLAG',     sub: 'SLOW DOWN — NO OVERTAKING' },
  doubleyellow: { label: 'DOUBLE YELLOW',   sub: 'HAZARD — BE PREPARED TO STOP' },
  blue:         { label: 'BLUE FLAG',       sub: 'LET LEADERS THROUGH' },
  red:          { label: 'RED FLAG',        sub: 'SESSION STOPPED' },
  chequered:    { label: 'CHEQUERED FLAG',  sub: 'END OF RACE' },
  sc:           { label: 'SAFETY CAR',      sub: 'DEPLOYED — NO OVERTAKING' },
  vsc:          { label: 'VIRTUAL SC',      sub: 'DELTA POSITIVE' },
};

// Tyre-temperature gradient: deep blue (cold) -> cyan -> green (optimal) -> amber -> red.
const TEMP_RAMP = [
  [0.00,  38,  86, 190],
  [0.22,  54, 150, 226],
  [0.40,  46, 206, 190],
  [0.52,  46, 214, 110],
  [0.62,  92, 224,  74],
  [0.74, 214, 210,  58],
  [0.86, 246, 150,  40],
  [1.00, 240,  52,  44],
];

// Wear ring gradient: fresh green -> amber -> red as life depletes.
const WEAR_RAMP = [
  [0.00, 236,  56,  52],
  [0.25, 246, 150,  40],
  [0.55, 224, 204,  56],
  [1.00,  56, 214, 112],
];

const SECTOR_TINTS = ['#5cc8ff', '#ffcf5c', '#ff7d94'];

// Pre-allocated scratch — reused every frame, never re-created.
const _v2 = { x: 0, z: 0 };
const _sortBuf = [];
const _tmpRGB = { r: 0, g: 0, b: 0 };

/* ═════════════════════════════════════════════════════════════════════════════════════
   Tiny helpers
   ═════════════════════════════════════════════════════════════════════════════════════ */

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function num(v, fb) { return (typeof v === 'number' && isFinite(v)) ? v : fb; }
function lerp(a, b, t) { return a + (b - a) * t; }

/** Frame-rate independent exponential smoothing. */
function damp(cur, target, rate, dt) {
  const t = 1 - Math.exp(-rate * dt);
  return cur + (target - cur) * t;
}

function mk(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

function mkSvg(tag, attrs, parent) {
  const n = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

/** Text write that skips the DOM entirely when the string has not changed. */
function setText(n, s) { if (n && n.__v !== s) { n.__v = s; n.textContent = s; } }
/** Class write that skips the DOM when unchanged. Always pass the FULL class string. */
function setCls(n, s) { if (n && n.__c !== s) { n.__c = s; n.className = s; } }
/** Style write guarded by a cached previous value. */
function setSty(n, prop, v) {
  if (!n) return;
  const k = '__s_' + prop;
  if (n[k] !== v) { n[k] = v; n.style.setProperty(prop, v); }
}
function setAttr(n, name, v) {
  if (!n) return;
  const k = '__a_' + name;
  if (n[k] !== v) { n[k] = v; n.setAttribute(name, v); }
}

/** Parse #rgb / #rrggbb into `out`. Returns null (leaving `out` untouched) if invalid. */
function hexToRgb(hex, out) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim();
  if (h.charCodeAt(0) === 35) h = h.slice(1);
  if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length < 6) return null;
  h = h.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const v = parseInt(h, 16);
  if (!isFinite(v)) return null;
  out.r = (v >> 16) & 255; out.g = (v >> 8) & 255; out.b = v & 255;
  return out;
}

function rampColor(ramp, t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < ramp.length; i++) {
    const b = ramp[i];
    if (t <= b[0] || i === ramp.length - 1) {
      const a = ramp[i - 1];
      const span = b[0] - a[0] || 1;
      const k = clamp((t - a[0]) / span, 0, 1);
      const r = (a[1] + (b[1] - a[1]) * k) | 0;
      const g = (a[2] + (b[2] - a[2]) * k) | 0;
      const bl = (a[3] + (b[3] - a[3]) * k) | 0;
      return 'rgb(' + r + ',' + g + ',' + bl + ')';
    }
  }
  return 'rgb(136,136,136)';
}

function fmtLap(sec) {
  if (!isFinite(sec) || sec <= 0 || sec > 5999) return '--:--.---';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const si = Math.floor(s);
  const ms = Math.floor((s - si) * 1000 + 0.5);
  const msc = ms >= 1000 ? 999 : ms;
  return m + ':' + (si < 10 ? '0' : '') + si + '.' + (msc < 100 ? (msc < 10 ? '00' : '0') : '') + msc;
}

function fmtShort(sec) {
  if (!isFinite(sec)) return '--.---';
  const a = Math.abs(sec);
  if (a >= 60) return fmtLap(sec);
  return a.toFixed(3);
}

function fmtSigned(sec, dp) {
  if (!isFinite(sec)) return '--.--';
  const d = dp == null ? 2 : dp;
  const s = Math.abs(sec).toFixed(d);
  return (sec >= 0 ? '+' : '−') + s;
}

function abbrevName(name) {
  const p = String(name).trim().split(/\s+/);
  const last = p.length ? p[p.length - 1] : String(name);
  return last.slice(0, 3).toUpperCase();
}

function teamOf(car) {
  if (!car) return null;
  const t = car.team;
  if (t && typeof t === 'object' && t.colors) return t;
  if (typeof t === 'string') { const f = TEAM_BY_ID.get(t); if (f) return f; }
  const id = car.teamId || car.team_id || (car.driver && (car.driver.teamId));
  if (id) { const f = TEAM_BY_ID.get(id); if (f) return f; }
  const dt = car.driver && car.driver.team;
  if (dt && typeof dt === 'object' && dt.colors) return dt;
  return null;
}

function teamColor(car) {
  const t = teamOf(car);
  if (t && t.colors && t.colors.primary) return t.colors.primary;
  if (car && typeof car.color === 'string') return car.color;
  return '#8b93a1';
}

function teamAccentColor(car) {
  const t = teamOf(car);
  if (t && t.colors && t.colors.accent) return t.colors.accent;
  return '#ffffff';
}

function driverCode(car) {
  if (!car) return '———';
  const d = car.driver;
  if (d) {
    if (typeof d === 'string') return abbrevName(d);
    if (d.short) return String(d.short).toUpperCase();
    if (d.code) return String(d.code).toUpperCase();
    if (d.name) return abbrevName(d.name);
  }
  if (car.short) return String(car.short).toUpperCase();
  if (car.code) return String(car.code).toUpperCase();
  if (car.name) return abbrevName(car.name);
  const n = num(car.num, NaN);
  if (isFinite(n)) return '#' + n;
  return '———';
}

function carNumber(car) {
  if (!car) return '';
  let n = num(car.num, NaN);
  if (!isFinite(n) && car.driver && typeof car.driver === 'object') n = num(car.driver.num, NaN);
  if (!isFinite(n)) n = num(car.number, NaN);
  return isFinite(n) ? String(n | 0) : '';
}

function compoundInfo(id) {
  if (!id) return null;
  const key = String(id).toLowerCase();
  if (COMPOUNDS[key]) return COMPOUNDS[key];
  for (const k in COMPOUNDS) {
    const c = COMPOUNDS[k];
    if (c && c.short && String(c.short).toLowerCase() === key) return c;
  }
  return null;
}

/** World XZ of a car, tolerant of the `position` overload in the state contract. */
function worldXZ(car, out) {
  if (!car) return false;
  const p = car.position;
  if (p && typeof p === 'object' && typeof p.x === 'number' && typeof p.z === 'number') {
    out.x = p.x; out.z = p.z; return true;
  }
  const q = car.pos || car.worldPos || car.worldPosition;
  if (q && typeof q === 'object' && typeof q.x === 'number' && typeof q.z === 'number') {
    out.x = q.x; out.z = q.z; return true;
  }
  return false;
}

/** Classification position, tolerant of `position` being either a Vector3 or a number. */
function racePosOf(car) {
  if (!car) return 0;
  if (isFinite(car.racePosition)) return car.racePosition | 0;
  if (typeof car.position === 'number' && isFinite(car.position)) return car.position | 0;
  if (isFinite(car.raceP)) return car.raceP | 0;
  if (isFinite(car.classification)) return car.classification | 0;
  return 0;
}

function lapDistOf(car) {
  if (!car) return 0;
  return num(car.lapDistance, num(car.s, num(car.trackS, 0)));
}

function lapOf(car) {
  if (!car) return 0;
  return num(car.lap, num(car.currentLap, num(car.laps, 0)));
}

/* ═════════════════════════════════════════════════════════════════════════════════════
   No-op stub, returned when the HUD cannot be constructed at all.
   ═════════════════════════════════════════════════════════════════════════════════════ */

function stubHUD() {
  const noop = function () {};
  return {
    update: noop, setTrackOutline: noop, showMessage: noop, showFlag: noop,
    setVisible: noop, setCameraMode: noop, setUnits: noop, setTeamAccent: noop,
    resize: noop, dispose: noop, flashSector: noop, setLapCounter: noop,
    setPosition: noop, clearMessages: noop, isCompact: function () { return false; },
    el: null, ok: false,
  };
}

/* ═════════════════════════════════════════════════════════════════════════════════════
   FACTORY
   ═════════════════════════════════════════════════════════════════════════════════════ */

export function createHUD(root, opts) {
  if (!root || typeof root !== 'object' || typeof root.appendChild !== 'function') return stubHUD();
  if (typeof document === 'undefined') return stubHUD();

  const O = opts || {};
  const compactWidth   = num(O.compactWidth, 820);
  const shortHeight    = num(O.shortHeight, 560);
  const showFps        = O.showFps !== false;
  const showTelemetry  = O.showTelemetry !== false;
  const showTower      = O.showTower !== false;
  const towerRows      = clamp((num(O.towerRows, 5) | 0), 3, 9);
  const minimapSize    = clamp(num(O.minimapSize, 196), 110, 420);
  const wearIsRemaining = O.wearIsRemaining === true;
  const maxG           = clamp(num(O.maxG, 5), 2, 8);
  const trailLen       = clamp((num(O.gTrail, 18) | 0), 4, 40);
  const defaultRpmMax  = num(O.rpmMax, 15000);

  let units = (O.units === 'imperial' || O.units === 'mph') ? 'imperial' : 'metric';
  let disposed = false;
  let visible = true;
  let compact = false;
  let shortMode = false;
  let lastDt = 0.0166;
  let clock = 0;                 // HUD-local time, advanced by dt (pauses with the game)

  /* ── failure guards ───────────────────────────────────────────────────────────── */
  /**
   * Restart a CSS animation without the classic `void node.offsetWidth` reflow trick.
   * Two class names map to two identical-but-differently-named keyframe sets, so
   * alternating between them changes the computed animation-name and the animation
   * restarts — with zero forced synchronous layout. This matters: gear changes fire
   * several times a second and a full-document reflow each time is not affordable.
   */
  function restartAnim(node, base, clsA, clsB) {
    if (!node) return;
    node.__ab = !node.__ab;
    setCls(node, base + ' ' + (node.__ab ? clsA : clsB));
  }

  const failCount = Object.create(null);
  function guard(name, fn) {
    if (failCount[name] > 6) return;
    try { fn(); } catch (e) { failCount[name] = (failCount[name] || 0) + 1; }
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     DOM CONSTRUCTION
     ═══════════════════════════════════════════════════════════════════════════════ */

  const hud = mk('div', 'apx-hud', root);
  hud.setAttribute('aria-hidden', 'true');

  /* ---------------------------------------------------------------- TOP LEFT ---- */
  const tl = mk('div', 'apx-corner apx-tl', hud);

  const posLapRow = mk('div', 'apx-poslap', tl);

  const posBox = mk('div', 'apx-panel apx-posbox', posLapRow);
  mk('span', 'apx-pos-p', posBox, 'P');
  const posNum = mk('span', 'apx-pos-n', posBox, '–');
  const posOf = mk('span', 'apx-pos-of', posBox, '/20');

  const lapBox = mk('div', 'apx-panel apx-lapbox', posLapRow);
  mk('span', 'apx-lap-l', lapBox, 'LAP');
  const lapNum = mk('span', 'apx-lap-n', lapBox, '1');
  const lapOfEl = mk('span', 'apx-lap-of', lapBox, '/1');

  const tower = mk('div', 'apx-panel apx-tower', tl);
  const towerHead = mk('div', 'apx-tower-head', tower);
  mk('span', 'apx-th-p', towerHead, 'POS');
  mk('span', 'apx-th-d', towerHead, 'DRIVER');
  mk('span', 'apx-th-g', towerHead, 'INT');
  const towerBody = mk('div', 'apx-tower-body', tower);
  if (!showTower) tower.style.display = 'none';

  const rows = [];
  for (let i = 0; i < towerRows; i++) {
    const r = mk('div', 'apx-trow', towerBody);
    const bar = mk('i', 'apx-trow-bar', r);
    const p = mk('span', 'apx-trow-p', r, '');
    const num2 = mk('span', 'apx-trow-num', r, '');
    const code = mk('span', 'apx-trow-code', r, '');
    const tyre = mk('span', 'apx-trow-tyre', r, '');
    const gap = mk('span', 'apx-trow-gap', r, '');
    rows.push({ root: r, bar, p, num: num2, code, tyre, gap });
  }

  /* -------------------------------------------------------------- TOP CENTRE ---- */
  const tc = mk('div', 'apx-corner apx-tc', hud);
  const timePanel = mk('div', 'apx-panel apx-times', tc);

  const curWrap = mk('div', 'apx-cur-wrap', timePanel);
  mk('span', 'apx-cur-l', curWrap, 'CURRENT');
  const curTime = mk('span', 'apx-cur', curWrap, '--:--.---');

  const subWrap = mk('div', 'apx-times-sub', timePanel);
  const lastWrap = mk('div', 'apx-tsub', subWrap);
  mk('span', 'apx-tsub-l', lastWrap, 'LAST');
  const lastTime = mk('span', 'apx-tsub-v', lastWrap, '--:--.---');
  const bestWrap = mk('div', 'apx-tsub apx-tsub-best', subWrap);
  mk('span', 'apx-tsub-l', bestWrap, 'BEST');
  const bestTime = mk('span', 'apx-tsub-v', bestWrap, '--:--.---');

  const deltaWrap = mk('div', 'apx-delta', timePanel);
  const deltaTrack = mk('div', 'apx-delta-track', deltaWrap);
  const deltaFill = mk('div', 'apx-delta-fill', deltaTrack);
  mk('div', 'apx-delta-mid', deltaTrack);
  const deltaTicks = mk('div', 'apx-delta-ticks', deltaTrack);
  for (let i = 0; i < 4; i++) mk('i', 'apx-dt', deltaTicks);
  const deltaVal = mk('div', 'apx-delta-val', deltaWrap, '−.---');

  const secWrap = mk('div', 'apx-sectors', timePanel);
  const secPips = [];
  for (let i = 0; i < 3; i++) {
    const sp = mk('div', 'apx-sec', secWrap);
    mk('span', 'apx-sec-l', sp, 'S' + (i + 1));
    const v = mk('span', 'apx-sec-v', sp, '--.---');
    secPips.push({ root: sp, v });
  }

  /* --------------------------------------------------------------- TOP RIGHT ---- */
  const tr = mk('div', 'apx-corner apx-tr', hud);
  const mapPanel = mk('div', 'apx-panel apx-map', tr);
  const mapCanvas = mk('canvas', 'apx-map-canvas', mapPanel);
  const mapLegend = mk('div', 'apx-map-legend', mapPanel);
  const legendChips = [];
  for (let i = 0; i < 3; i++) {
    const c = mk('span', 'apx-chip', mapLegend, 'S' + (i + 1));
    c.style.setProperty('--chip', SECTOR_TINTS[i]);
    legendChips.push(c);
  }
  const drsChip = mk('span', 'apx-chip apx-chip-drs', mapLegend, 'DRS');

  /* ------------------------------------------------------------- LEFT COLUMN ---- */
  const left = mk('div', 'apx-side apx-left', hud);
  if (!showTelemetry) left.style.display = 'none';

  const pedals = mk('div', 'apx-panel apx-pedals', left);

  const thrCol = mk('div', 'apx-ped apx-ped-thr', pedals);
  const thrTrack = mk('div', 'apx-ped-track', thrCol);
  const thrFill = mk('div', 'apx-ped-fill', thrTrack);
  mk('span', 'apx-ped-l', thrCol, 'THR');

  const brkCol = mk('div', 'apx-ped apx-ped-brk', pedals);
  const brkTrack = mk('div', 'apx-ped-track', brkCol);
  const brkFill = mk('div', 'apx-ped-fill', brkTrack);
  mk('span', 'apx-ped-l', brkCol, 'BRK');

  const steerBox = mk('div', 'apx-panel apx-steer', left);
  const steerArc = mk('div', 'apx-steer-arc', steerBox);
  mk('i', 'apx-steer-centre', steerArc);
  const steerBar = mk('div', 'apx-steer-bar', steerArc);
  mk('i', 'apx-steer-grip', steerBar);
  const steerVal = mk('div', 'apx-steer-val', steerBox, '0°');

  const gBox = mk('div', 'apx-panel apx-gplot', left);
  const gPlot = mk('div', 'apx-g-plot', gBox);
  mk('i', 'apx-g-ring apx-g-r1', gPlot);
  mk('i', 'apx-g-ring apx-g-r2', gPlot);
  mk('i', 'apx-g-ring apx-g-r3', gPlot);
  mk('i', 'apx-g-cross apx-g-cx', gPlot);
  mk('i', 'apx-g-cross apx-g-cy', gPlot);
  const gTrailDots = [];
  for (let i = 0; i < trailLen; i++) gTrailDots.push(mk('i', 'apx-g-dot', gPlot));
  const gBall = mk('i', 'apx-g-ball', gPlot);
  const gVal = mk('div', 'apx-g-val', gBox, '0.0 g');
  const gLabels = mk('div', 'apx-g-labels', gBox);
  mk('span', 'apx-g-lab apx-g-lab-t', gLabels, 'BRK');
  mk('span', 'apx-g-lab apx-g-lab-b', gLabels, 'ACC');

  /* ------------------------------------------------------------ RIGHT COLUMN ---- */
  const right = mk('div', 'apx-side apx-right', hud);

  const tyrePanel = mk('div', 'apx-panel apx-tyres', right);
  const tyreHead = mk('div', 'apx-panel-head', tyrePanel);
  mk('span', '', tyreHead, 'TYRES');
  const tyreAge = mk('span', 'apx-panel-head-v', tyreHead, '');
  const tyreGrid = mk('div', 'apx-tyre-grid', tyrePanel);
  const tyres = [];
  const TYRE_LABELS = ['FL', 'FR', 'RL', 'RR'];
  const RING_R = 21;
  const RING_C = 2 * Math.PI * RING_R;
  for (let i = 0; i < 4; i++) {
    const cell = mk('div', 'apx-tyre', tyreGrid);
    const svg = mkSvg('svg', { viewBox: '0 0 52 52', class: 'apx-tyre-ring' }, cell);
    mkSvg('circle', {
      cx: 26, cy: 26, r: RING_R, fill: 'none',
      stroke: 'rgba(255,255,255,0.12)', 'stroke-width': 3.5,
    }, svg);
    const ring = mkSvg('circle', {
      cx: 26, cy: 26, r: RING_R, fill: 'none',
      stroke: '#38d670', 'stroke-width': 3.5, 'stroke-linecap': 'round',
      transform: 'rotate(-90 26 26)',
      'stroke-dasharray': RING_C.toFixed(2),
      'stroke-dashoffset': '0',
    }, svg);
    const body = mk('div', 'apx-tyre-body', cell);
    const letter = mk('span', 'apx-tyre-letter', body, '–');
    const corner = mk('span', 'apx-tyre-corner', cell, TYRE_LABELS[i]);
    const temp = mk('span', 'apx-tyre-temp', cell, '--°');
    tyres.push({ root: cell, ring, body, letter, temp, corner, lastCol: '', lastRing: '' });
  }

  const meters = mk('div', 'apx-panel apx-meters', right);

  const fuelRow = mk('div', 'apx-meter apx-meter-fuel', meters);
  const fuelTop = mk('div', 'apx-meter-top', fuelRow);
  mk('span', 'apx-meter-l', fuelTop, 'FUEL');
  const fuelVal = mk('span', 'apx-meter-v', fuelTop, '-- kg');
  const fuelTrack = mk('div', 'apx-meter-track', fuelRow);
  const fuelFill = mk('div', 'apx-meter-fill', fuelTrack);
  const fuelSub = mk('div', 'apx-meter-sub', fuelRow, '');

  const ersRow = mk('div', 'apx-meter apx-meter-ers', meters);
  const ersTop = mk('div', 'apx-meter-top', ersRow);
  mk('span', 'apx-meter-l', ersTop, 'ERS');
  const ersVal = mk('span', 'apx-meter-v', ersTop, '--%');
  const ersTrack = mk('div', 'apx-meter-track', ersRow);
  const ersFill = mk('div', 'apx-meter-fill', ersTrack);
  const ersSegs = mk('div', 'apx-meter-segs', ersTrack);
  for (let i = 0; i < 7; i++) mk('i', '', ersSegs);
  const ersMode = mk('div', 'apx-meter-sub apx-ers-mode', ersRow, 'BALANCED');

  const biasRow = mk('div', 'apx-meter apx-meter-bias', meters);
  const biasTop = mk('div', 'apx-meter-top', biasRow);
  mk('span', 'apx-meter-l', biasTop, 'B.BIAS');
  const biasVal = mk('span', 'apx-meter-v', biasTop, '--.-%');
  const biasTrack = mk('div', 'apx-meter-track apx-bias-track', biasRow);
  const biasMark = mk('div', 'apx-bias-mark', biasTrack);
  mk('div', 'apx-bias-mid', biasTrack);

  /* ----------------------------------------------------------- BOTTOM CENTRE ---- */
  const bc = mk('div', 'apx-bc', hud);

  // --- curved RPM / shift-light strip -------------------------------------------
  const RPM_CX = 210, RPM_CY = 980, RPM_R = 940;
  const RPM_A0 = -101 * Math.PI / 180;
  const RPM_A1 = -79 * Math.PI / 180;
  const RPM_LEN = RPM_R * (RPM_A1 - RPM_A0);

  const rpmSvg = mkSvg('svg', {
    viewBox: '0 0 420 76', class: 'apx-rpm', preserveAspectRatio: 'xMidYMid meet',
  }, bc);
  const defs = mkSvg('defs', null, rpmSvg);
  const gradId = 'apxRpmGrad_' + Math.floor(Math.random() * 0x7fffffff).toString(36);
  const grad = mkSvg('linearGradient', {
    id: gradId, gradientUnits: 'userSpaceOnUse', x1: 30, y1: 0, x2: 390, y2: 0,
  }, defs);
  mkSvg('stop', { offset: '0',    'stop-color': '#12d16b' }, grad);
  mkSvg('stop', { offset: '0.34', 'stop-color': '#8ede3c' }, grad);
  mkSvg('stop', { offset: '0.58', 'stop-color': '#ffcc33' }, grad);
  mkSvg('stop', { offset: '0.80', 'stop-color': '#ff8a1e' }, grad);
  mkSvg('stop', { offset: '1',    'stop-color': '#ff2f2f' }, grad);

  function arcPoint(a, r) {
    return { x: RPM_CX + Math.cos(a) * r, y: RPM_CY + Math.sin(a) * r };
  }
  const pA = arcPoint(RPM_A0, RPM_R);
  const pB = arcPoint(RPM_A1, RPM_R);
  const arcD = 'M ' + pA.x.toFixed(2) + ' ' + pA.y.toFixed(2) +
               ' A ' + RPM_R + ' ' + RPM_R + ' 0 0 1 ' + pB.x.toFixed(2) + ' ' + pB.y.toFixed(2);

  mkSvg('path', {
    d: arcD, fill: 'none', stroke: 'rgba(0,0,0,0.75)',
    'stroke-width': 21, 'stroke-linecap': 'round', class: 'apx-rpm-case',
  }, rpmSvg);
  mkSvg('path', {
    d: arcD, fill: 'none', stroke: 'rgba(255,255,255,0.09)',
    'stroke-width': 15, 'stroke-linecap': 'round', class: 'apx-rpm-bg',
  }, rpmSvg);
  const rpmFill = mkSvg('path', {
    d: arcD, fill: 'none', stroke: 'url(#' + gradId + ')',
    'stroke-width': 15, 'stroke-linecap': 'round', class: 'apx-rpm-fill',
    'stroke-dasharray': RPM_LEN.toFixed(2) + ' ' + (RPM_LEN + 8).toFixed(2),
    'stroke-dashoffset': RPM_LEN.toFixed(2),
  }, rpmSvg);
  const rpmShift = mkSvg('path', {
    d: arcD, fill: 'none', stroke: '#43c9ff',
    'stroke-width': 15, 'stroke-linecap': 'round', class: 'apx-rpm-shift',
  }, rpmSvg);

  const PIP_N = 15;
  const pips = [];
  for (let i = 0; i < PIP_N; i++) {
    const t = PIP_N === 1 ? 0.5 : i / (PIP_N - 1);
    const a = RPM_A0 + (RPM_A1 - RPM_A0) * (0.035 + t * 0.93);
    const p = arcPoint(a, RPM_R + 26);
    const c = mkSvg('circle', {
      cx: p.x.toFixed(2), cy: p.y.toFixed(2), r: 4.6, class: 'apx-pip',
    }, rpmSvg);
    pips.push({ node: c, state: -1 });
  }

  const bcRow = mk('div', 'apx-bc-row', bc);

  const drsCol = mk('div', 'apx-drs-col', bcRow);
  const drsPill = mk('div', 'apx-drs', drsCol, 'DRS');
  const limPill = mk('div', 'apx-lim', drsCol, 'PIT LIMITER');

  const gearWrap = mk('div', 'apx-gear-wrap', bcRow);
  const gearNum = mk('div', 'apx-gear', gearWrap, 'N');
  const gearGhost = mk('div', 'apx-gear-ghost', gearWrap, '');

  const speedCol = mk('div', 'apx-speed', bcRow);
  const speedVal = mk('div', 'apx-speed-v', speedCol, '0');
  const speedUnit = mk('div', 'apx-speed-u', speedCol, 'km/h');
  const speedSub = mk('div', 'apx-speed-sub', speedCol, '0 mph');

  /* --------------------------------------------------------------- OVERLAYS ---- */
  const flagFx = mk('div', 'apx-flagfx', hud);
  const flagBanner = mk('div', 'apx-flagbanner', hud);
  const flagLabel = mk('div', 'apx-flagbanner-l', flagBanner, '');
  const flagSub = mk('div', 'apx-flagbanner-s', flagBanner, '');

  const msgBox = mk('div', 'apx-msg', hud);
  const msgInner = mk('div', 'apx-msg-inner', msgBox, '');
  const msgSub = mk('div', 'apx-msg-sub', msgBox, '');

  const lightsBox = mk('div', 'apx-lights', hud);
  const lightCells = [];
  for (let i = 0; i < 5; i++) {
    const col = mk('div', 'apx-light-col', lightsBox);
    const t = mk('i', 'apx-light apx-light-top', col);
    const b = mk('i', 'apx-light apx-light-bot', col);
    lightCells.push({ top: t, bot: b });
  }

  const status = mk('div', 'apx-status', hud);
  const camLabel = mk('span', 'apx-stat apx-cam', status, 'CHASE');
  const tierLabel = mk('span', 'apx-stat apx-tier', status, '');
  const fpsLabel = mk('span', 'apx-stat apx-fps', status, '-- FPS');
  if (!showFps) fpsLabel.style.display = 'none';

  /* ═══════════════════════════════════════════════════════════════════════════════
     STATE
     ═══════════════════════════════════════════════════════════════════════════════ */

  // Smoothed / animated display values
  const S = {
    rpmFrac: 0, speed: 0, thr: 0, brk: 0, steer: 0,
    gx: 0, gy: 0, delta: 0, deltaShown: 0,
    fuel: 0, ers: 0, bias: 0.56, fps: 60,
    shiftPhase: 0, gearPrev: null,
  };

  // Delta / lap tracking
  const DELTA_N = 384;
  const D = {
    best: new Float32Array(DELTA_N),
    cur: new Float32Array(DELTA_N),
    haveBest: false,
    lastIdx: -1,
    lapT: 0,
    prevS: 0,
    prevLap: -1,
    bestLap: NaN,
    lastLap: NaN,
    trackLen: 0,
    started: false,
    /* True once we have observed a lap from its own start line. Guards against
       publishing a bogus "lap time" or sector time for the partial lap that is in
       progress when the HUD is first attached (mid-session join, replay scrub, etc). */
    lapValid: false,
  };
  D.best.fill(-1); D.cur.fill(-1);

  // Sector tracking
  const SEC = {
    bounds: null,          // [b1, b2] interior boundaries
    idx: 0,                // current sector index 0..2
    startT: 0,
    pb: [NaN, NaN, NaN],
    last: [NaN, NaN, NaN],
    flashUntil: [0, 0, 0],
    kinds: ['', '', ''],
  };

  // G-force trail ring buffer
  const trail = {
    head: 0,
    x: new Float32Array(trailLen),
    y: new Float32Array(trailLen),
    filled: 0,
    acc: 0,
  };

  // Message queue
  const msgQueue = [];
  let msgActive = null;
  let msgUntil = 0;

  // Flags
  let flagKind = '';
  let flagUntil = 0;
  let lastRaceFlag = null;

  // Minimap
  const MAP = {
    pts: null,          // Float32Array [x,z,...] world
    cum: null,          // Float32Array cumulative length
    n: 0,
    total: 0,
    scale: 1, ox: 0, oy: 0,
    dpr: 1, w: 0, h: 0,
    ctx: null,
    stat: null,         // static layer canvas
    statCtx: null,
    dirty: true,
    metaKey: '',
    sectors: null,
    drs: null,
    trackLen: 0,
  };
  try { MAP.ctx = mapCanvas.getContext('2d', { alpha: true }); } catch (e) { MAP.ctx = null; }

  // Throttling accumulators
  let accSlow = 0, accMap = 0, accVSlow = 0, accTrail = 0;

  // Cached derived values shared between subsystems within a frame
  let gapAheadSec = Infinity;
  let gapBehindSec = Infinity;
  let carsCount = 0;

  /* ═══════════════════════════════════════════════════════════════════════════════
     THEME / ACCENT
     ═══════════════════════════════════════════════════════════════════════════════ */

  function setTeamAccent(hex) {
    try {
      const c = hexToRgb(hex, _tmpRGB);
      if (!c) return;                  // invalid colour: keep whatever tint is live
      const css = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
      hud.style.setProperty('--accent', css);
      hud.style.setProperty('--accent-rgb', c.r + ',' + c.g + ',' + c.b);
      // A brightened variant for glows and thin lines over dark plates.
      const br = Math.min(255, (c.r * 0.45 + 255 * 0.55) | 0);
      const bg = Math.min(255, (c.g * 0.45 + 255 * 0.55) | 0);
      const bb = Math.min(255, (c.b * 0.45 + 255 * 0.55) | 0);
      hud.style.setProperty('--accent-lit', 'rgb(' + br + ',' + bg + ',' + bb + ')');
      const dr = (c.r * 0.42) | 0, dg = (c.g * 0.42) | 0, db = (c.b * 0.42) | 0;
      hud.style.setProperty('--accent-dim', 'rgb(' + dr + ',' + dg + ',' + db + ')');
      MAP.dirty = true;
    } catch (e) { /* accent stays at the stylesheet default */ }
  }

  try {
    if (O.accent) setTeamAccent(O.accent);
    else if (O.teamId) {
      const t = TEAM_BY_ID.get(O.teamId);
      if (t && t.colors) setTeamAccent(t.colors.accent || t.colors.primary);
    }
  } catch (e) { /* default accent */ }

  /* ═══════════════════════════════════════════════════════════════════════════════
     LAYOUT / RESIZE
     ═══════════════════════════════════════════════════════════════════════════════ */

  function applyRootClass() {
    let cls = 'apx-hud';
    if (!visible) cls += ' apx-hidden';
    if (compact) cls += ' apx-compact';
    if (shortMode) cls += ' apx-short';
    setCls(hud, cls);
  }

  function applyLayout() {
    let w = 0, h = 0;
    try {
      const r = root.getBoundingClientRect();
      w = r.width || root.clientWidth || 0;
      h = r.height || root.clientHeight || 0;
    } catch (e) { /* ignore */ }
    if (!w) w = (typeof window !== 'undefined' ? window.innerWidth : 1280) || 1280;
    if (!h) h = (typeof window !== 'undefined' ? window.innerHeight : 720) || 720;

    compact = w < compactWidth;
    shortMode = h < shortHeight;
    applyRootClass();

    // Scale everything down gracefully on tight viewports.
    let scale = 1;
    if (w < 1180) scale = clamp(0.62 + (w - 380) * 0.00048, 0.6, 1);
    if (h < 700) scale = Math.min(scale, clamp(0.62 + (h - 380) * 0.0012, 0.6, 1));
    setSty(hud, '--hud-scale', scale.toFixed(3));

    // Size the minimap first — it is part of the top-right cluster we are about to measure.
    resizeMinimap(w);

    // The three top clusters are anchored left / centre / right and will collide on very
    // narrow viewports. Measure their real (untransformed) widths and shrink the scale
    // until the row fits. offsetWidth ignores the CSS transform, so this converges in one
    // pass and only ever runs on resize.
    try {
      const need = tl.offsetWidth + tc.offsetWidth + tr.offsetWidth + 34;
      const avail = w - 24;
      if (need > 8 && avail > 40 && need * scale > avail) {
        scale = clamp(avail / need, 0.40, scale);
        setSty(hud, '--hud-scale', scale.toFixed(3));
      }
    } catch (e) { /* measurement unavailable — keep the heuristic scale */ }
  }

  function resizeMinimap(viewW) {
    if (!MAP.ctx) return;
    let size = minimapSize;
    if (viewW && viewW < compactWidth) size = Math.max(96, minimapSize * 0.66);
    let dpr = 1;
    try { dpr = clamp(num(window.devicePixelRatio, 1), 1, 2.5); } catch (e) { dpr = 1; }

    const px = Math.round(size * dpr);
    if (MAP.w !== size || MAP.dpr !== dpr) {
      MAP.w = size; MAP.h = size; MAP.dpr = dpr;
      mapCanvas.width = px; mapCanvas.height = px;
      mapCanvas.style.width = size + 'px';
      mapCanvas.style.height = size + 'px';
      if (!MAP.stat) {
        MAP.stat = document.createElement('canvas');
        try { MAP.statCtx = MAP.stat.getContext('2d', { alpha: true }); } catch (e) { MAP.statCtx = null; }
      }
      if (MAP.stat) { MAP.stat.width = px; MAP.stat.height = px; }
      MAP.dirty = true;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     MINIMAP
     ═══════════════════════════════════════════════════════════════════════════════ */

  function setTrackOutline(points) {
    try {
      if (!points || !points.length) {
        MAP.pts = null; MAP.n = 0; MAP.dirty = true; return;
      }
      const n = points.length | 0;
      const pts = new Float32Array(n * 2);
      let ok = 0;
      for (let i = 0; i < n; i++) {
        const p = points[i];
        let x, z;
        if (Array.isArray(p)) { x = num(p[0], NaN); z = num(p[1], NaN); }
        else if (p && typeof p === 'object') { x = num(p.x, NaN); z = num(p.z !== undefined ? p.z : p.y, NaN); }
        else continue;
        if (!isFinite(x) || !isFinite(z)) continue;
        pts[ok * 2] = x; pts[ok * 2 + 1] = z; ok++;
      }
      if (ok < 3) { MAP.pts = null; MAP.n = 0; MAP.dirty = true; return; }

      MAP.pts = pts;
      MAP.n = ok;

      const cum = new Float32Array(ok + 1);
      let acc = 0;
      for (let i = 0; i < ok; i++) {
        const j = (i + 1) % ok;
        const dx = pts[j * 2] - pts[i * 2];
        const dz = pts[j * 2 + 1] - pts[i * 2 + 1];
        cum[i] = acc;
        acc += Math.sqrt(dx * dx + dz * dz);
      }
      cum[ok] = acc;
      MAP.cum = cum;
      MAP.total = acc || 1;
      MAP.dirty = true;
    } catch (e) {
      MAP.pts = null; MAP.n = 0; MAP.dirty = true;
    }
  }

  function computeMapTransform() {
    const pts = MAP.pts, n = MAP.n;
    if (!pts || n < 3) return false;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const w = MAP.w * MAP.dpr, h = MAP.h * MAP.dpr;
    const pad = 12 * MAP.dpr;
    const spanX = Math.max(1e-3, maxX - minX);
    const spanZ = Math.max(1e-3, maxZ - minZ);
    const sc = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ);
    MAP.scale = sc;
    MAP.ox = (w - spanX * sc) * 0.5 - minX * sc;
    MAP.oy = (h - spanZ * sc) * 0.5 - minZ * sc;
    return true;
  }

  function mapX(x) { return x * MAP.scale + MAP.ox; }
  function mapY(z) { return z * MAP.scale + MAP.oy; }

  /** Index into the outline for a normalised lap fraction 0..1. */
  function outlineIndexAt(frac) {
    const n = MAP.n;
    if (!n) return 0;
    let f = frac % 1;
    if (f < 0) f += 1;
    const target = f * MAP.total;
    // binary search on cumulative length
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (MAP.cum[mid] < target) lo = mid + 1; else hi = mid;
    }
    return clamp(lo - 1, 0, n - 1);
  }

  function outlinePointAt(frac, out) {
    const n = MAP.n;
    if (!n) { out.x = 0; out.z = 0; return false; }
    const i = outlineIndexAt(frac);
    const j = (i + 1) % n;
    const segLen = Math.max(1e-4, (i + 1 <= n ? MAP.cum[i + 1] : MAP.total) - MAP.cum[i]);
    let f = frac % 1; if (f < 0) f += 1;
    const t = clamp((f * MAP.total - MAP.cum[i]) / segLen, 0, 1);
    out.x = lerp(MAP.pts[i * 2], MAP.pts[j * 2], t);
    out.z = lerp(MAP.pts[i * 2 + 1], MAP.pts[j * 2 + 1], t);
    return true;
  }

  function strokeRange(c, fromFrac, toFrac) {
    const n = MAP.n;
    if (!n) return;
    let a = fromFrac % 1; if (a < 0) a += 1;
    let b = toFrac % 1; if (b < 0) b += 1;
    const i0 = outlineIndexAt(a);
    let count;
    if (b >= a) count = Math.max(1, Math.round((b - a) * n));
    else count = Math.max(1, Math.round((1 - a + b) * n));
    count = Math.min(count + 1, n);
    c.beginPath();
    for (let k = 0; k <= count; k++) {
      const idx = (i0 + k) % n;
      const px = mapX(MAP.pts[idx * 2]);
      const py = mapY(MAP.pts[idx * 2 + 1]);
      if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.stroke();
  }

  function strokeFull(c) {
    const n = MAP.n;
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const px = mapX(MAP.pts[idx * 2]);
      const py = mapY(MAP.pts[idx * 2 + 1]);
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
    c.stroke();
  }

  function buildStaticMap() {
    const c = MAP.statCtx;
    if (!c || !MAP.pts || MAP.n < 3) return;
    const w = MAP.w * MAP.dpr, h = MAP.h * MAP.dpr;
    c.clearRect(0, 0, w, h);

    const dpr = MAP.dpr;
    c.lineJoin = 'round';
    c.lineCap = 'round';

    // Outer casing (dark halo so the map reads over anything)
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.lineWidth = 9 * dpr;
    strokeFull(c);

    // Asphalt body
    c.strokeStyle = 'rgba(150,158,172,0.60)';
    c.lineWidth = 5.4 * dpr;
    strokeFull(c);

    // Inner darker core for depth
    c.strokeStyle = 'rgba(24,28,36,0.55)';
    c.lineWidth = 2.0 * dpr;
    strokeFull(c);

    // DRS zones — bright accent under the sector line. Requires a known track length
    // to convert `s` metres into outline fractions.
    const L = MAP.trackLen;
    const haveL = L > 1;
    if (haveL && MAP.drs && MAP.drs.length) {
      c.lineWidth = 6.2 * dpr;
      c.strokeStyle = 'rgba(0,224,122,0.92)';
      c.shadowColor = 'rgba(0,224,122,0.6)';
      c.shadowBlur = 6 * dpr;
      for (let i = 0; i < MAP.drs.length; i++) {
        const z = MAP.drs[i];
        const a = num(z.startS, NaN), b = num(z.endS, NaN);
        if (!isFinite(a) || !isFinite(b)) continue;
        strokeRange(c, a / L, b / L);
      }
      c.shadowBlur = 0;
    }

    // Sector-coloured overlay
    const secs = haveL ? MAP.sectors : null;
    c.lineWidth = 2.2 * dpr;
    if (secs && secs.length >= 2) {
      const b1 = secs[0] / L, b2 = secs[1] / L;
      c.strokeStyle = SECTOR_TINTS[0]; strokeRange(c, 0, b1);
      c.strokeStyle = SECTOR_TINTS[1]; strokeRange(c, b1, b2);
      c.strokeStyle = SECTOR_TINTS[2]; strokeRange(c, b2, 1);
    } else {
      c.strokeStyle = 'rgba(220,228,240,0.5)';
      strokeFull(c);
    }

    // Sector boundary ticks + start/finish line
    function tickAt(frac, color, len, width) {
      const n = MAP.n;
      const i = outlineIndexAt(frac);
      const j = (i + 1) % n;
      const ax = MAP.pts[i * 2], az = MAP.pts[i * 2 + 1];
      const bx = MAP.pts[j * 2], bz = MAP.pts[j * 2 + 1];
      let dx = bx - ax, dz = bz - az;
      const m = Math.hypot(dx, dz) || 1;
      dx /= m; dz /= m;
      const px = mapX(ax), py = mapY(az);
      const nx = -dz * len * dpr, ny = dx * len * dpr;
      c.beginPath();
      c.moveTo(px - nx, py - ny);
      c.lineTo(px + nx, py + ny);
      c.strokeStyle = color;
      c.lineWidth = width * dpr;
      c.stroke();
    }
    if (secs && secs.length >= 2) {
      tickAt(secs[0] / L, 'rgba(255,255,255,0.55)', 4.5, 1.6);
      tickAt(secs[1] / L, 'rgba(255,255,255,0.55)', 4.5, 1.6);
    }
    tickAt(0, '#ffffff', 6.5, 2.6);
  }

  function drawMinimap(ctx) {
    const c = MAP.ctx;
    if (!c) return;
    const w = MAP.w * MAP.dpr, h = MAP.h * MAP.dpr;
    c.clearRect(0, 0, w, h);
    if (!MAP.pts || MAP.n < 3) return;
    if (MAP.dirty) {
      if (!computeMapTransform()) return;
      buildStaticMap();
      MAP.dirty = false;
    }
    if (MAP.stat) { try { c.drawImage(MAP.stat, 0, 0); } catch (e) { /* ignore */ } }

    const cars = ctx && ctx.cars;
    const player = ctx && ctx.player;
    const dpr = MAP.dpr;
    const L = MAP.trackLen || 1;

    function dot(car, isPlayer) {
      if (!car) return;
      let px, py;
      if (worldXZ(car, _v2)) { px = mapX(_v2.x); py = mapY(_v2.z); }
      else {
        const s = lapDistOf(car);
        if (!outlinePointAt(s / L, _v2)) return;
        px = mapX(_v2.x); py = mapY(_v2.z);
      }
      if (!isFinite(px) || !isFinite(py)) return;
      const r = (isPlayer ? 4.6 : 3.2) * dpr;
      const retired = car.retired === true || car.dnf === true;

      c.beginPath();
      c.arc(px, py, r + 1.6 * dpr, 0, 6.2831853);
      c.fillStyle = 'rgba(0,0,0,0.85)';
      c.fill();

      c.beginPath();
      c.arc(px, py, r, 0, 6.2831853);
      c.fillStyle = retired ? 'rgba(90,94,104,0.7)' : teamColor(car);
      c.fill();

      if (isPlayer) {
        c.beginPath();
        c.arc(px, py, r + 2.6 * dpr, 0, 6.2831853);
        c.strokeStyle = '#ffffff';
        c.lineWidth = 1.7 * dpr;
        c.stroke();
      } else if (car.inPit === true || car.inPitLane === true) {
        c.beginPath();
        c.arc(px, py, r + 2.2 * dpr, 0, 6.2831853);
        c.strokeStyle = 'rgba(255,255,255,0.55)';
        c.lineWidth = 1.1 * dpr;
        c.stroke();
      }
    }

    if (cars && cars.length) {
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i];
        if (car === player || (car && car.isPlayer)) continue;
        dot(car, false);
      }
    }
    dot(player, true);
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     TIMING / DELTA / SECTORS
     ═══════════════════════════════════════════════════════════════════════════════ */

  function resetLapTrace() {
    D.cur.fill(-1);
    D.lastIdx = -1;
  }

  function commitBestTrace() {
    D.best.set(D.cur);
    // Forward-fill any gaps so lookups never land on -1 in the middle of the lap.
    let last = -1;
    for (let i = 0; i < DELTA_N; i++) {
      if (D.best[i] >= 0) last = D.best[i];
      else if (last >= 0) D.best[i] = last;
    }
    D.haveBest = true;
  }

  /** Fraction of the lap the running trace actually recorded. Cheap: once per lap. */
  function traceCoverage() {
    let n = 0;
    for (let i = 0; i < DELTA_N; i++) if (D.cur[i] >= 0) n++;
    return n / DELTA_N;
  }

  function bestTraceAt(frac) {
    const f = clamp(frac, 0, 0.999999);
    const x = f * DELTA_N;
    const i = x | 0;
    const j = Math.min(DELTA_N - 1, i + 1);
    const a = D.best[i], b = D.best[j];
    if (a < 0) return NaN;
    if (b < 0) return a;
    return lerp(a, b, x - i);
  }

  function updateTiming(dt, ctx, player) {
    const race = ctx.race || null;
    const track = ctx.track || null;
    // A new track object invalidates the cached sector/DRS geometry.
    if (track !== lastTrackRef) {
      lastTrackRef = track;
      SEC.bounds = null;
      MAP.sectors = null;
      MAP.drs = null;
      MAP.dirty = true;
    }

    const L = num(track && track.length, num(D.trackLen, 0)) || num(race && race.trackLength, 0);
    if (L > 0) {
      if (MAP.trackLen !== L) { MAP.trackLen = L; MAP.dirty = true; }
      D.trackLen = L;
    }
    const len = D.trackLen || 1;

    const s = clamp(lapDistOf(player), 0, len);
    const lapNo = lapOf(player) || num(race && (race.lap !== undefined ? race.lap : race.currentLap), 0);

    const running = !race || race.state === undefined ||
      race.state === 'racing' || race.state === 'running' || race.state === 'green' ||
      race.state === 'flying' || race.state === 'race';

    if (running) D.lapT += dt;

    // Lap boundary detection: distance wrap OR lap counter increment. A raw distance
    // jump only counts when the player was genuinely near the end of a plausible lap —
    // otherwise a teleport, pit reset or session restart would fake a lap time.
    let wrapped = false;
    let teleported = false;
    if (D.started) {
      if (lapNo > D.prevLap && D.prevLap >= 0) wrapped = true;
      else if (s < D.prevS - len * 0.5) {
        if (D.prevS > len * 0.7 && D.lapT > 12) wrapped = true;
        else teleported = true;
      }
    } else {
      D.started = true;
      D.prevLap = lapNo;
      D.prevS = s;
      D.lapT = 0;
      SEC.startT = 0;
      SEC.idx = 0;
      // Attaching on (or just after) the start line means lap 1 is fully observable.
      D.lapValid = s < len * 0.02;
    }

    // Sector boundary set (recomputed only when the track changes).
    if (track && track.sectors && SEC.bounds === null) {
      const raw = track.sectors;
      const interior = [];
      for (let i = 0; i < raw.length; i++) {
        const v = num(raw[i], NaN);
        if (isFinite(v) && v > len * 0.005 && v < len * 0.995) interior.push(v);
      }
      interior.sort(function (a, b) { return a - b; });
      SEC.bounds = interior.length >= 2 ? [interior[0], interior[1]] : [len / 3, (len * 2) / 3];
      MAP.sectors = SEC.bounds;
      MAP.dirty = true;
    }
    if (track && track.drsZones && MAP.drs !== track.drsZones) {
      MAP.drs = track.drsZones;
      MAP.dirty = true;
    }

    // ── sector crossings ───────────────────────────────────────────────────────
    if (SEC.bounds && !wrapped && s >= D.prevS) {
      for (let i = 0; i < 2; i++) {
        const b = SEC.bounds[i];
        if (D.prevS < b && s >= b && SEC.idx === i) {
          finishSector(i, D.lapT - SEC.startT);
          SEC.startT = D.lapT;
          SEC.idx = i + 1;
        }
      }
    }

    if (wrapped) {
      // Close the final sector.
      if (SEC.idx === 2) finishSector(2, D.lapT - SEC.startT);
      const raceLast = num(race && (race.lastLapTime !== undefined ? race.lastLapTime : race.lastLap), NaN);
      const trusted = isFinite(raceLast) && raceLast > 5 && raceLast < 1200;
      const lapTime = trusted ? raceLast : D.lapT;
      // Two independent sanity gates so a teleport, a dropped frame batch or a garbage
      // state object can never poison the best-lap reference:
      //   coverage  — did we actually record samples across the whole lap?
      //   plausible — no car improves on its own best by more than 40% in one lap.
      const coverage = traceCoverage();
      const plausible = !isFinite(D.bestLap) || lapTime > D.bestLap * 0.6;
      const wellObserved = D.lapValid && coverage >= 0.85 && plausible;
      if (isFinite(lapTime) && lapTime > 5 && plausible && (wellObserved || trusted)) {
        D.lastLap = lapTime;
        if (!isFinite(D.bestLap) || lapTime < D.bestLap) {
          D.bestLap = lapTime;
          // The delta reference is only meaningful for a lap we tracked end to end.
          if (wellObserved) commitBestTrace();
          flashBest();
        }
      }
      D.lapValid = true;
      resetLapTrace();
      D.lapT = 0;
      SEC.startT = 0;
      SEC.idx = 0;
    } else if (teleported) {
      // Position discontinuity without a completed lap: abandon the running trace so we
      // never publish a bogus lap or delta, but keep the stored best reference intact.
      resetLapTrace();
      D.lapT = 0;
      SEC.startT = 0;
      SEC.idx = 0;
    }

    // ── record the running trace ───────────────────────────────────────────────
    const frac = clamp(s / len, 0, 0.999999);
    const idx = clamp((frac * DELTA_N) | 0, 0, DELTA_N - 1);
    if (idx !== D.lastIdx) {
      if (D.lastIdx >= 0 && idx > D.lastIdx) {
        for (let i = D.lastIdx + 1; i <= idx; i++) D.cur[i] = D.lapT;
      } else {
        D.cur[idx] = D.lapT;
      }
      D.lastIdx = idx;
    }

    D.prevS = s;
    D.prevLap = lapNo;

    // ── delta ──────────────────────────────────────────────────────────────────
    let delta = NaN;
    const extDelta = num(race && (race.delta !== undefined ? race.delta : race.deltaToBest),
      num(player && player.delta, NaN));
    if (isFinite(extDelta)) delta = extDelta;
    else if (D.haveBest) {
      const bt = bestTraceAt(frac);
      if (isFinite(bt)) delta = D.lapT - bt;
    }

    // ── readouts ───────────────────────────────────────────────────────────────
    const curT = num(race && (race.lapTime !== undefined ? race.lapTime : race.currentLapTime), D.lapT);
    setText(curTime, fmtLap(curT));

    const lastT = num(race && (race.lastLapTime !== undefined ? race.lastLapTime : race.lastLap), D.lastLap);
    setText(lastTime, fmtLap(lastT));

    // The race module is authoritative, but the HUD must never advertise a "best" that
    // is slower than a lap it watched the player set.
    let bestT = num(race && (race.bestLapTime !== undefined ? race.bestLapTime : race.bestLap), NaN);
    if (!isFinite(bestT) || (isFinite(D.bestLap) && D.bestLap < bestT)) bestT = D.bestLap;
    setText(bestTime, fmtLap(bestT));

    // Delta bar — smooth, centre-origin scaleX.
    const range = num(O.deltaRange, 2.0);
    if (isFinite(delta)) {
      S.delta = delta;
      S.deltaShown = damp(S.deltaShown, delta, 9, dt);
      const k = clamp(S.deltaShown / range, -1, 1);
      const mag = Math.abs(k);
      setSty(deltaFill, 'transform', 'scaleX(' + mag.toFixed(4) + ')');
      setSty(deltaFill, 'transform-origin', k < 0 ? 'right center' : 'left center');
      setSty(deltaFill, 'left', k < 0 ? '0' : '50%');
      setSty(deltaFill, 'right', k < 0 ? '50%' : '0');
      setCls(deltaFill, 'apx-delta-fill ' + (S.deltaShown < -0.003 ? 'is-up' : (S.deltaShown > 0.003 ? 'is-down' : 'is-flat')));
      setText(deltaVal, fmtSigned(S.deltaShown, 3));
      setCls(deltaVal, 'apx-delta-val ' + (S.deltaShown < -0.003 ? 'is-up' : (S.deltaShown > 0.003 ? 'is-down' : 'is-flat')));
    } else {
      setSty(deltaFill, 'transform', 'scaleX(0)');
      setCls(deltaFill, 'apx-delta-fill is-flat');
      setText(deltaVal, 'NO REF');
      setCls(deltaVal, 'apx-delta-val is-flat');
    }

    // Sector pip decay
    for (let i = 0; i < 3; i++) {
      const live = (SEC.idx === i && !wrapped);
      let cls = 'apx-sec';
      if (SEC.kinds[i]) cls += ' is-' + SEC.kinds[i];
      if (clock < SEC.flashUntil[i]) cls += ' is-flash';
      if (live) cls += ' is-live';
      setCls(secPips[i].root, cls);
    }
  }

  function finishSector(i, t) {
    if (!isFinite(t) || t <= 0.2 || i < 0 || i > 2) return;
    // Never publish a sector from the partial lap we joined mid-flight.
    if (!D.lapValid) return;
    SEC.last[i] = t;
    let kind = 'yellow';
    const pb = SEC.pb[i];
    if (!isFinite(pb) || t < pb) { SEC.pb[i] = t; kind = 'green'; }
    // Purple when it also beats the session-wide reference the race module supplies.
    const ov = sessionSectorRef(i);
    if (isFinite(ov) && t <= ov + 1e-4) kind = 'purple';
    SEC.kinds[i] = kind;
    SEC.flashUntil[i] = clock + 3.2;
    setText(secPips[i].v, fmtShort(t));
  }

  let sessionSectors = null;
  let lastTrackRef = null;
  function sessionSectorRef(i) {
    const a = sessionSectors;
    if (a && isFinite(a[i])) return a[i];
    return NaN;
  }

  function flashBest() {
    restartAnim(bestWrap, 'apx-tsub apx-tsub-best', 'is-new-a', 'is-new-b');
    restartAnim(curWrap, 'apx-cur-wrap', 'is-purple-a', 'is-purple-b');
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     TIMING TOWER
     ═══════════════════════════════════════════════════════════════════════════════ */

  function progressOf(car, len) {
    return lapOf(car) * len + lapDistOf(car);
  }

  function updateTower(ctx, player) {
    const cars = ctx.cars;
    const len = D.trackLen || 1;
    gapAheadSec = Infinity;
    gapBehindSec = Infinity;

    if (!showTower) return;
    if (!cars || !cars.length) {
      for (let i = 0; i < rows.length; i++) setCls(rows[i].root, 'apx-trow is-empty');
      return;
    }

    _sortBuf.length = 0;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c) _sortBuf.push(c);
    }
    carsCount = _sortBuf.length;

    // Prefer an authoritative classification if the race module publishes one.
    let havePositions = true;
    for (let i = 0; i < _sortBuf.length; i++) {
      if (racePosOf(_sortBuf[i]) <= 0) { havePositions = false; break; }
    }
    if (havePositions) {
      _sortBuf.sort(function (a, b) { return racePosOf(a) - racePosOf(b); });
    } else {
      _sortBuf.sort(function (a, b) {
        const ra = a.retired === true || a.dnf === true;
        const rb = b.retired === true || b.dnf === true;
        if (ra !== rb) return ra ? 1 : -1;
        return progressOf(b, len) - progressOf(a, len);
      });
    }

    const n = _sortBuf.length;
    let pIdx = -1;
    for (let i = 0; i < n; i++) {
      const c = _sortBuf[i];
      if (c === player || c.isPlayer === true) { pIdx = i; break; }
    }
    if (pIdx < 0) pIdx = 0;

    const half = (rows.length / 2) | 0;
    let start = clamp(pIdx - half, 0, Math.max(0, n - rows.length));

    function intervalTo(aheadCar, car) {
      if (!aheadCar || !car) return NaN;
      const explicit = num(car.interval, num(car.gapToAhead, NaN));
      if (isFinite(explicit)) return explicit;
      const dp = progressOf(aheadCar, len) - progressOf(car, len);
      if (!isFinite(dp)) return NaN;
      const v = Math.max(14, num(car.speed, 55));
      return dp / v;
    }

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const idx = start + r;
      if (idx >= n) { setCls(row.root, 'apx-trow is-empty'); continue; }
      const car = _sortBuf[idx];
      const isP = (idx === pIdx);
      const retired = car.retired === true || car.dnf === true;
      const inPit = car.inPit === true || car.inPitLane === true || car.pitting === true;

      let cls = 'apx-trow';
      if (isP) cls += ' is-player';
      else if (idx < pIdx) cls += ' is-ahead';
      else cls += ' is-behind';
      if (retired) cls += ' is-out';
      if (inPit) cls += ' is-pit';
      setCls(row.root, cls);

      setSty(row.bar, 'background', teamColor(car));
      setText(row.p, String(idx + 1));
      setText(row.num, carNumber(car));
      setText(row.code, driverCode(car));

      const comp = compoundInfo(car.tyreCompound || car.compound);
      if (comp) {
        setText(row.tyre, comp.short || '');
        setSty(row.tyre, 'color', comp.color || '#fff');
      } else {
        setText(row.tyre, '');
      }

      let gapStr;
      if (retired) gapStr = 'DNF';
      else if (inPit) gapStr = 'PIT';
      else if (idx === 0) gapStr = 'LEADER';
      else {
        const ahead = _sortBuf[idx - 1];
        const lapDiff = Math.floor(lapOf(ahead)) - Math.floor(lapOf(car));
        if (lapDiff >= 1) gapStr = '+' + lapDiff + 'L';
        else {
          const iv = intervalTo(ahead, car);
          gapStr = isFinite(iv) ? '+' + Math.abs(iv).toFixed(3) : '--.---';
        }
      }
      setText(row.gap, gapStr);

      if (isP) {
        if (idx > 0) gapAheadSec = Math.abs(num(intervalTo(_sortBuf[idx - 1], car), Infinity));
        if (idx < n - 1) gapBehindSec = Math.abs(num(intervalTo(car, _sortBuf[idx + 1]), Infinity));
      }
    }

    // Position + lap counter
    const pp = havePositions ? racePosOf(player) || (pIdx + 1) : (pIdx + 1);
    setText(posNum, pp > 0 ? String(pp) : '–');
    setText(posOf, '/' + n);
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     CORE TELEMETRY (per frame)
     ═══════════════════════════════════════════════════════════════════════════════ */

  function updateCore(dt, ctx, player) {
    const race = ctx.race || null;

    // ---- speed --------------------------------------------------------------
    const spd = Math.max(0, num(player && player.speed, 0));
    S.speed = damp(S.speed, spd, 22, dt);
    const kmh = S.speed * MS_PER_S;
    const mph = S.speed * MPH_PER_MS;
    if (units === 'imperial') {
      setText(speedVal, String(Math.round(mph)));
      setText(speedUnit, 'mph');
      setText(speedSub, Math.round(kmh) + ' km/h');
    } else {
      setText(speedVal, String(Math.round(kmh)));
      setText(speedUnit, 'km/h');
      setText(speedSub, Math.round(mph) + ' mph');
    }

    // ---- gear ---------------------------------------------------------------
    const g = player ? player.gear : 0;
    let gearStr;
    if (g === -1 || g === 'R') gearStr = 'R';
    else if (!g || g === 0) gearStr = 'N';
    else gearStr = String(g | 0);
    if (gearStr !== S.gearPrev) {
      S.gearPrev = gearStr;
      setText(gearNum, gearStr);
      setText(gearGhost, gearStr);
      restartAnim(gearNum, 'apx-gear', 'is-shift-a', 'is-shift-b');
    }

    // ---- rpm / shift lights -------------------------------------------------
    const rpmMax = num(player && (player.rpmMax || player.maxRpm || player.rpmLimit || player.redline), defaultRpmMax);
    const shiftRpm = num(player && player.shiftRpm, rpmMax * 0.945);
    const rpm = clamp(num(player && player.rpm, 0), 0, rpmMax * 1.08);
    const frac = rpmMax > 0 ? clamp(rpm / rpmMax, 0, 1) : 0;
    S.rpmFrac = damp(S.rpmFrac, frac, 30, dt);

    const dash = RPM_LEN * (1 - S.rpmFrac);
    setAttr(rpmFill, 'stroke-dashoffset', dash.toFixed(1));

    const shifting = rpm >= shiftRpm && rpmMax > 0;
    if (shifting) {
      S.shiftPhase += dt * 22;
      const on = (S.shiftPhase % 2) < 1.05;
      setSty(rpmShift, 'opacity', on ? '1' : '0');
      setAttr(rpmShift, 'stroke-dashoffset', '0');
      setAttr(rpmShift, 'stroke-dasharray', RPM_LEN.toFixed(1) + ' ' + (RPM_LEN + 8).toFixed(1));
    } else {
      S.shiftPhase = 0;
      setSty(rpmShift, 'opacity', '0');
    }

    // Pips: 0=off, 1=green, 2=amber, 3=red, 4=blue(shift)
    const litN = Math.round(S.rpmFrac * PIP_N * 1.02);
    for (let i = 0; i < PIP_N; i++) {
      let st;
      if (shifting) st = 4;
      else if (i >= litN) st = 0;
      else if (i < 6) st = 1;
      else if (i < 11) st = 2;
      else st = 3;
      const p = pips[i];
      if (p.state !== st) {
        p.state = st;
        p.node.setAttribute('class',
          st === 0 ? 'apx-pip' :
          st === 1 ? 'apx-pip is-g' :
          st === 2 ? 'apx-pip is-a' :
          st === 3 ? 'apx-pip is-r' : 'apx-pip is-b');
      }
    }
    setCls(rpmSvg, 'apx-rpm' + (shifting ? ' is-shift' : ''));

    // ---- pedals -------------------------------------------------------------
    if (showTelemetry) {
      const thr = clamp(num(player && player.throttle, 0), 0, 1);
      const brk = clamp(num(player && player.brake, 0), 0, 1);
      S.thr = damp(S.thr, thr, 34, dt);
      S.brk = damp(S.brk, brk, 34, dt);
      setSty(thrFill, 'transform', 'scaleY(' + S.thr.toFixed(3) + ')');
      setSty(brkFill, 'transform', 'scaleY(' + S.brk.toFixed(3) + ')');

      // ---- steering ---------------------------------------------------------
      const st = clamp(num(player && player.steer, 0), -1, 1);
      S.steer = damp(S.steer, st, 26, dt);
      // Positive steer = left in this project's convention; the wheel rotates left.
      const deg = -S.steer * 118;
      setSty(steerBar, 'transform', 'rotate(' + deg.toFixed(2) + 'deg)');
      const swDeg = Math.abs(S.steer) * 240;
      setText(steerVal, (S.steer > 0.02 ? 'L ' : (S.steer < -0.02 ? 'R ' : '')) + Math.round(swDeg) + '°');

      // ---- G plot -----------------------------------------------------------
      const gf = player && player.gForce;
      const lat = num(gf && gf.lat, 0);
      const lon = num(gf && gf.lon, 0);
      S.gx = damp(S.gx, lat, 20, dt);
      S.gy = damp(S.gy, lon, 20, dt);
      const R = 46; // plot radius in css px (matches --gplot-r)
      const gxp = clamp(S.gx / maxG, -1.15, 1.15) * R;
      const gyp = clamp(S.gy / maxG, -1.15, 1.15) * R;
      // Accel pushes the ball down, braking up.
      setSty(gBall, 'transform', 'translate3d(' + gxp.toFixed(2) + 'px,' + gyp.toFixed(2) + 'px,0)');
      const mag = Math.hypot(S.gx, S.gy);
      setText(gVal, mag.toFixed(1) + ' g');

      accTrail += dt;
      if (accTrail >= 0.033) {
        accTrail = 0;
        trail.x[trail.head] = gxp;
        trail.y[trail.head] = gyp;
        trail.head = (trail.head + 1) % trailLen;
        if (trail.filled < trailLen) trail.filled++;
        for (let i = 0; i < trailLen; i++) {
          const dot = gTrailDots[i];
          // age: 0 = newest
          let age = (trail.head - 1 - i + trailLen * 2) % trailLen;
          const src = (trail.head - 1 - age + trailLen * 2) % trailLen;
          if (age >= trail.filled) { setSty(dot, 'opacity', '0'); continue; }
          const k = 1 - age / trailLen;
          setSty(dot, 'transform',
            'translate3d(' + trail.x[src].toFixed(1) + 'px,' + trail.y[src].toFixed(1) + 'px,0) scale(' + (0.35 + k * 0.65).toFixed(2) + ')');
          setSty(dot, 'opacity', (k * k * 0.72).toFixed(3));
        }
      }
    }

    // ---- DRS ----------------------------------------------------------------
    updateDRS(ctx, player, race);

    // ---- pit limiter --------------------------------------------------------
    const lim = player && (player.pitLimiter === true || player.limiter === true ||
      (player.inPitLane === true && Math.abs(num(player.speed, 0)) > 1));
    setCls(limPill, 'apx-lim' + (lim ? ' is-on' : ''));
  }

  function drsZoneState(track, s) {
    const z = track && track.drsZones;
    if (!z || !z.length) return 0;
    function inRange(a, b, v) {
      if (!isFinite(a) || !isFinite(b)) return false;
      if (b >= a) return v >= a && v <= b;
      return v >= a || v <= b;   // wraps the start/finish line
    }
    for (let i = 0; i < z.length; i++) {
      const zone = z[i];
      if (!zone) continue;
      const a = num(zone.startS, NaN), b = num(zone.endS, NaN);
      if (inRange(a, b, s)) return 2;
      const dS = num(zone.detectS, NaN);
      if (isFinite(dS) && inRange(dS, a, s)) return 1;
    }
    return 0;
  }

  function updateDRS(ctx, player, race) {
    const open = player ? (player.drs === true || player.drsOpen === true ||
      (typeof player.drs === 'number' && player.drs > 0.5)) : false;

    let avail;
    if (player && typeof player.drsAvailable === 'boolean') avail = player.drsAvailable;
    else if (player && typeof player.drsArmed === 'boolean') avail = player.drsArmed;
    else {
      const enabled = !race || race.drsEnabled !== false;
      const zs = drsZoneState(ctx.track, lapDistOf(player));
      avail = enabled && zs === 2 && gapAheadSec <= 1.0;
    }

    let cls = 'apx-drs';
    if (open) cls += ' is-open';
    else if (avail) cls += ' is-avail';
    setCls(drsPill, cls);
    setText(drsPill, open ? 'DRS OPEN' : 'DRS');
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     TYRES / FUEL / ERS / BIAS  (10 Hz)
     ═══════════════════════════════════════════════════════════════════════════════ */

  function updateSlow(ctx, player) {
    const wheels = player && player.wheels;
    const comp = compoundInfo(player && (player.tyreCompound || player.compound));
    const letter = comp ? (comp.short || '–') : '–';
    const optT = comp ? num(comp.optimalTemp, 100) : 100;
    const winT = comp ? num(comp.tempWindow, 26) : 26;
    const compColor = comp ? (comp.color || '#e8e8e8') : '#c8ccd4';

    for (let i = 0; i < 4; i++) {
      const t = tyres[i];
      const w = wheels && wheels[i];
      const temp = num(w && w.temp, NaN);
      const wearRaw = clamp(num(w && w.wear, 0), 0, 1);
      const life = wearIsRemaining ? wearRaw : (1 - wearRaw);

      // Temperature colour — normalised so optimal sits at 0.55 of the ramp.
      let tc;
      if (isFinite(temp)) {
        const nrm = (temp - optT) / (winT || 26);
        const t01 = clamp(0.55 + nrm * 0.30, 0, 1);
        tc = rampColor(TEMP_RAMP, t01);
      } else {
        tc = 'rgb(90,96,108)';
      }
      if (t.lastCol !== tc) { t.lastCol = tc; t.body.style.background = tc; }

      const off = RING_C * (1 - clamp(life, 0, 1));
      setAttr(t.ring, 'stroke-dashoffset', off.toFixed(2));
      const rc = rampColor(WEAR_RAMP, life);
      if (t.lastRing !== rc) { t.lastRing = rc; t.ring.setAttribute('stroke', rc); }

      setText(t.letter, letter);
      setSty(t.letter, 'color', isFinite(temp) && temp > optT + winT * 0.5 ? '#150a06' : '#0a0d12');
      setText(t.temp, isFinite(temp) ? Math.round(temp) + '°' : '--°');

      let cls = 'apx-tyre';
      if (w) {
        if (w.lockedUp === true) cls += ' is-lock';
        else if (w.spinning === true) cls += ' is-spin';
        if (w.contact === false) cls += ' is-air';
      }
      if (life < 0.15) cls += ' is-crit';
      else if (life < 0.32) cls += ' is-warn';
      setCls(t.root, cls);
    }

    // Compound + stint age in the tyre panel header
    let ageStr = '';
    const stint = num(player && (player.stintLaps !== undefined ? player.stintLaps : player.tyreAge), NaN);
    if (isFinite(stint)) ageStr = (stint | 0) + ' LAP' + ((stint | 0) === 1 ? '' : 'S');
    if (comp) ageStr = (comp.name ? comp.name.toUpperCase() : letter) + (ageStr ? ' · ' + ageStr : '');
    setText(tyreAge, ageStr);
    setSty(tyreAge, 'color', compColor);

    // ---- fuel ---------------------------------------------------------------
    const fuel = num(player && player.fuel, NaN);
    const fuelCap = num(player && (player.fuelCapacity || player.fuelMax), num(O.fuelCapacity, 110));
    if (isFinite(fuel)) {
      const f01 = clamp(fuel / (fuelCap || 110), 0, 1);
      S.fuel = f01;
      setSty(fuelFill, 'transform', 'scaleX(' + f01.toFixed(3) + ')');
      setText(fuelVal, fuel.toFixed(1) + ' kg');
      const perLap = num(player && player.fuelPerLap, num(O.fuelPerLap, 1.9));
      const lapsLeft = perLap > 0 ? fuel / perLap : NaN;
      setText(fuelSub, isFinite(lapsLeft) ? ('≈ ' + lapsLeft.toFixed(1) + ' LAPS') : '');
      setCls(fuelRow, 'apx-meter apx-meter-fuel' + (f01 < 0.10 ? ' is-crit' : (f01 < 0.22 ? ' is-warn' : '')));
    } else {
      setText(fuelVal, '-- kg');
      setText(fuelSub, '');
    }

    // ---- ERS ----------------------------------------------------------------
    const ers = player && player.ers;
    const charge = clamp(num(ers && ers.charge, num(player && player.ersCharge, 0)), 0, 1);
    S.ers = charge;
    setSty(ersFill, 'transform', 'scaleX(' + charge.toFixed(3) + ')');
    setText(ersVal, Math.round(charge * 100) + '%');
    let mode = ers && ers.mode;
    if (typeof mode === 'number') mode = ERS_MODE_NAMES[clamp(mode | 0, 0, ERS_MODE_NAMES.length - 1)];
    if (typeof mode !== 'string' || !mode) mode = 'BALANCED';
    setText(ersMode, String(mode).toUpperCase());
    const deploying = !!(ers && ers.deploying);
    setCls(ersRow, 'apx-meter apx-meter-ers' + (deploying ? ' is-deploy' : '') + (charge < 0.12 ? ' is-crit' : ''));

    // ---- brake bias ---------------------------------------------------------
    let bias = num(player && player.brakeBias, NaN);
    if (!isFinite(bias)) bias = num(player && player.setup && player.setup.brakeBias, NaN);
    if (!isFinite(bias)) bias = S.bias;
    if (bias > 1.5) bias /= 100;              // accept 54.5 as well as 0.545
    bias = clamp(bias, 0.30, 0.80);
    S.bias = bias;
    setText(biasVal, (bias * 100).toFixed(1) + '% F');
    // Map 45%..65% across the track for a readable throw. The marker element spans the
    // full track width and carries its visible tick on ::before at x=0, so translating
    // it by a percentage of its own width == a percentage of the track. Transform only.
    const bp = clamp((bias - 0.45) / 0.20, 0, 1);
    setSty(biasMark, 'transform', 'translate3d(' + (bp * 100).toFixed(2) + '%,0,0)');
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     LAP COUNTER / FLAGS / MESSAGES / LIGHTS / STATUS
     ═══════════════════════════════════════════════════════════════════════════════ */

  function setLapCounter(lap, total) {
    const l = clamp(num(lap, 1) | 0, 0, 999);
    const t = clamp(num(total, 1) | 0, 0, 999);
    setText(lapNum, String(Math.max(1, l)));
    setText(lapOfEl, '/' + Math.max(1, t));
    const remaining = t - l;
    setCls(lapBox, 'apx-panel apx-lapbox' + (remaining <= 0 ? ' is-final' : (remaining <= 3 ? ' is-close' : '')));
  }

  function setPosition(p, of) {
    const v = num(p, NaN);
    setText(posNum, isFinite(v) && v > 0 ? String(v | 0) : '–');
    const o = num(of, NaN);
    if (isFinite(o)) setText(posOf, '/' + (o | 0));
  }

  function showFlag(kind) {
    try {
      const k = (typeof kind === 'string' && FLAG_KINDS[kind]) ? kind : '';
      if (k === flagKind) return;
      flagKind = k;
      if (!k) {
        setCls(flagFx, 'apx-flagfx');
        setCls(flagBanner, 'apx-flagbanner');
        return;
      }
      const info = FLAG_KINDS[k];
      setText(flagLabel, info.label);
      setText(flagSub, info.sub);
      setCls(flagFx, 'apx-flagfx is-on is-' + k);
      setCls(flagBanner, 'apx-flagbanner is-on is-' + k);
      flagUntil = (k === 'green') ? clock + 3.0 : clock + 1e9;
    } catch (e) { /* flag overlay unavailable */ }
  }

  function showMessage(text, kind, ms) {
    try {
      if (text == null) return;
      const entry = {
        text: String(text),
        kind: (typeof kind === 'string' && kind) ? kind : 'info',
        ms: clamp(num(ms, 2600), 400, 30000),
      };
      // High-priority kinds jump the queue.
      if (entry.kind === 'penalty' || entry.kind === 'flag' || entry.kind === 'red') {
        msgQueue.unshift(entry);
        if (msgActive) msgUntil = Math.min(msgUntil, clock + 0.25);
      } else {
        msgQueue.push(entry);
        if (msgQueue.length > 8) msgQueue.shift();
      }
      if (!msgActive) pumpMessages();
    } catch (e) { /* messages unavailable */ }
  }

  function clearMessages() {
    msgQueue.length = 0;
    msgActive = null;
    setCls(msgBox, 'apx-msg');
  }

  function pumpMessages() {
    if (msgQueue.length === 0) {
      if (msgActive) {
        msgActive = null;
        setCls(msgBox, 'apx-msg');
      }
      return;
    }
    const e = msgQueue.shift();
    msgActive = e;
    msgUntil = clock + e.ms / 1000;
    setText(msgInner, e.text);
    // Suppress the kicker when it just repeats the headline.
    const sub = MSG_SUBS[e.kind] || '';
    setText(msgSub, sub && sub.toUpperCase() === e.text.toUpperCase() ? '' : sub);
    setCls(msgBox, 'apx-msg');
    // One forced reflow so the entry transition replays. Messages are rare (a handful
    // per race), so this is not on any hot path.
    void msgBox.offsetWidth;
    setCls(msgBox, 'apx-msg is-on is-' + e.kind);
  }

  const MSG_SUBS = {
    penalty: 'STEWARDS',
    pit: 'PIT WINDOW',
    fastlap: 'FASTEST LAP',
    drs: 'DRS',
    flag: '',
    warn: '',
    info: '',
  };

  function updateMessages() {
    if (msgActive && clock >= msgUntil) pumpMessages();
    if (flagKind === 'green' && clock >= flagUntil) showFlag(null);
  }

  function updateLights(ctx) {
    const race = ctx.race;
    const lights = race ? num(race.lights, num(race.startLights, NaN)) : NaN;
    const st = race && race.state;
    const inCountdown = st === 'countdown' || st === 'lights' || st === 'formation' ||
      st === 'grid' || st === 'starting';
    const show = isFinite(lights) && lights >= 0 && (inCountdown || lights > 0);
    setCls(lightsBox, 'apx-lights' + (show ? ' is-on' : ''));
    if (!show) return;
    const lit = clamp(lights | 0, 0, 5);
    for (let i = 0; i < 5; i++) {
      const on = i < lit;
      setCls(lightCells[i].top, 'apx-light apx-light-top' + (on ? ' is-lit' : ''));
      setCls(lightCells[i].bot, 'apx-light apx-light-bot' + (on ? ' is-lit' : ''));
    }
  }

  function updateStatus(ctx, interval) {
    let f = num(ctx.fps, NaN);
    if (!isFinite(f)) f = lastDt > 0 ? 1 / lastDt : 60;
    S.fps = damp(S.fps, f, 3.5, Math.min(interval, 0.5));
    setText(fpsLabel, Math.round(S.fps) + ' FPS');
    setCls(fpsLabel, 'apx-stat apx-fps' + (S.fps < 28 ? ' is-bad' : (S.fps < 50 ? ' is-warn' : '')));

    const q = ctx.quality;
    if (q && typeof q.tier === 'string') setText(tierLabel, q.tier.toUpperCase());
    else setText(tierLabel, '');
  }

  function updateWeatherTint(ctx) {
    const w = ctx.weather;
    if (!w) return;
    const wet = clamp(num(w.trackWetness, 0), 0, 1);
    setSty(hud, '--wet', wet.toFixed(2));
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     PUBLIC UPDATE
     ═══════════════════════════════════════════════════════════════════════════════ */

  function update(dt, ctx) {
    if (disposed || !visible) return;
    let d = num(dt, 0.016);
    if (d < 0) d = 0;
    if (d > 0.25) d = 0.25;
    if (d > 0.0005) lastDt = d;
    clock += d;
    if (!ctx) return;

    const player = ctx.player || null;

    guard('core', function () { updateCore(d, ctx, player); });
    guard('timing', function () { updateTiming(d, ctx, player); });
    guard('msg', updateMessages);

    accSlow += d;
    if (accSlow >= 0.1) {
      const s = accSlow; accSlow = 0;
      guard('tower', function () { updateTower(ctx, player); });
      guard('slow', function () { updateSlow(ctx, player); });
      guard('lights', function () { updateLights(ctx); });
      guard('weather', function () { updateWeatherTint(ctx); });
      guard('lapcount', function () {
        const race = ctx.race;
        const lap = num(race && (race.lap !== undefined ? race.lap : race.currentLap), lapOf(player));
        const tot = num(race && (race.totalLaps !== undefined ? race.totalLaps : race.laps), NaN);
        setLapCounter(Math.max(1, lap | 0), isFinite(tot) ? tot : Math.max(1, lap | 0));
        // Session-wide sector reference for purple flashes.
        if (race) {
          const sb = race.bestSectors || race.sessionBestSectors || race.overallSectors;
          if (Array.isArray(sb)) sessionSectors = sb;
        }
        // Race-driven flag changes.
        if (race) {
          let f = race.flag || race.flagState || null;
          if (race.safetyCar === true && !f) f = 'sc';
          else if (race.virtualSafetyCar === true && !f) f = 'vsc';
          if (f !== lastRaceFlag) {
            lastRaceFlag = f;
            showFlag(typeof f === 'string' ? f : null);
          }
        }
      });
      if (s > 1) accSlow = 0;
    }

    accMap += d;
    const mapInterval = (ctx.quality && ctx.quality.tier === 'low') ? 0.066 : 0.033;
    if (accMap >= mapInterval) {
      accMap = 0;
      guard('map', function () { drawMinimap(ctx); });
    }

    accVSlow += d;
    if (accVSlow >= 0.4) {
      const iv = accVSlow;
      accVSlow = 0;
      guard('status', function () { updateStatus(ctx, iv); });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     REMAINING PUBLIC API
     ═══════════════════════════════════════════════════════════════════════════════ */

  function setVisible(b) {
    visible = b !== false;
    applyRootClass();
  }

  function setCameraMode(name) {
    const n = (typeof name === 'string' && name) ? name : '';
    setText(camLabel, n.toUpperCase());
    setCls(camLabel, 'apx-stat apx-cam' + (n ? '' : ' is-empty'));
  }

  function setUnits(u) {
    units = (u === 'imperial' || u === 'mph' || u === 'us') ? 'imperial' : 'metric';
  }

  /**
   * Drive a sector flash externally. `timeSec`, when finite, is shown as the sector time.
   * kind: 'purple' (session best) | 'green' (personal best) | 'yellow' (slower).
   */
  function flashSector(i, kind, timeSec) {
    const idx = clamp(num(i, 0) | 0, 0, 2);
    const k = (kind === 'purple' || kind === 'green' || kind === 'yellow') ? kind : 'yellow';
    SEC.kinds[idx] = k;
    SEC.flashUntil[idx] = clock + 3.2;
    const t = num(timeSec, NaN);
    if (isFinite(t) && t > 0) {
      SEC.last[idx] = t;
      if (!isFinite(SEC.pb[idx]) || t < SEC.pb[idx]) SEC.pb[idx] = t;
      setText(secPips[idx].v, fmtShort(t));
    }
    return idx;
  }

  function resize() {
    guard('layout', applyLayout);
  }

  let ro = null;
  const onWinResize = function () { resize(); };
  try {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', onWinResize, { passive: true });
      window.addEventListener('orientationchange', onWinResize, { passive: true });
    }
  } catch (e) { /* no window resize hookup */ }
  try {
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onWinResize);
      ro.observe(root);
    }
  } catch (e) { ro = null; }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('resize', onWinResize);
        window.removeEventListener('orientationchange', onWinResize);
      }
    } catch (e) { /* ignore */ }
    try { if (ro) { ro.disconnect(); ro = null; } } catch (e) { /* ignore */ }
    try {
      if (MAP.stat) { MAP.stat.width = 0; MAP.stat.height = 0; }
      MAP.stat = null; MAP.statCtx = null; MAP.ctx = null;
      MAP.pts = null; MAP.cum = null;
      mapCanvas.width = 0; mapCanvas.height = 0;
    } catch (e) { /* ignore */ }
    try {
      rows.length = 0;
      tyres.length = 0;
      pips.length = 0;
      gTrailDots.length = 0;
      secPips.length = 0;
      legendChips.length = 0;
      msgQueue.length = 0;
      _sortBuf.length = 0;
    } catch (e) { /* ignore */ }
    try { if (hud.parentNode) hud.parentNode.removeChild(hud); } catch (e) { /* ignore */ }
  }

  /* ── initial paint ─────────────────────────────────────────────────────────── */
  guard('init', function () {
    applyLayout();
    setCameraMode(O.cameraMode || 'CHASE');
    setLapCounter(1, num(O.totalLaps, 1));
    setText(posNum, '–');
    setText(posOf, '/20');
    setCls(drsPill, 'apx-drs');
    for (let i = 0; i < rows.length; i++) setCls(rows[i].root, 'apx-trow is-empty');
    if (Array.isArray(O.trackOutline)) setTrackOutline(O.trackOutline);
    if (O.visible === false) setVisible(false);
  });

  return {
    update,
    setTrackOutline,
    showMessage,
    showFlag,
    setVisible,
    setCameraMode,
    setUnits,
    setTeamAccent,
    resize,
    dispose,
    // extras
    flashSector,
    setLapCounter,
    setPosition,
    clearMessages,
    isCompact: function () { return compact; },
    el: hud,
    ok: true,
  };
}

/**
 * APEX F1 — Front-end screens (everything that is not the in-race HUD).
 *
 * Builds every non-HUD screen as DOM inside a caller-supplied root:
 *   loading | title | setup | garage | pause | results | settings | controls | error
 *
 * Zero side effects at import time. No three.js needed here.
 * Styling lives in styles/ui.css (auto-linked if the host page forgot it).
 */

import { TEAMS as BUILTIN_TEAMS, TYRE_COMPOUNDS } from '../game/teams.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Module-scope constants (frozen, allocation-free at runtime)
 * ──────────────────────────────────────────────────────────────────────────*/

const NS_SVG = 'http://www.w3.org/2000/svg';

const SCREEN_IDS = ['loading', 'title', 'setup', 'garage', 'pause', 'results', 'settings', 'controls', 'error'];

const FOCUSABLE = 'button:not(:disabled):not([tabindex="-1"]),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]';

const LOADING_STATUS = [
  'IGNITING POWER UNIT',
  'COMPILING SHADER PROGRAMS',
  'LAYING TARMAC',
  'MAPPING RACING LINE',
  'CALIBRATING TYRE MODEL',
  'RIGGING SUSPENSION GEOMETRY',
  'SEEDING GRANDSTAND CROWD',
  'BUILDING WEATHER SYSTEM',
  'BRIEFING RACE ENGINEERS',
  'WARMING BRAKE DISCS',
  'SYNCHRONISING TELEMETRY',
  'ARMING THE START LIGHTS',
];

const DIFFICULTIES = [
  { id: 'rookie',   name: 'Rookie',   pace: '92%',  blurb: 'Forgiving field, generous aids. Learn the lines without being punished.' },
  { id: 'pro',      name: 'Pro',      pace: '96%',  blurb: 'A race-ready grid. Mistakes cost real time and real places.' },
  { id: 'ace',      name: 'Ace',      pace: '99%',  blurb: 'Championship pace. The AI defends, dives and uses ERS against you.' },
  { id: 'legend',   name: 'Legend',   pace: '100%', blurb: 'Peak field, zero errors, ruthless racecraft. Every tenth is earned.' },
  { id: 'adaptive', name: 'Adaptive', pace: 'AUTO', blurb: 'The AI learns your pace — it measures your sector times lap by lap and settles just where it hurts.' },
];

const WEATHERS = [
  { id: 'clear',     name: 'Clear',      sub: 'Dry · high track temp',      icon: 'sun' },
  { id: 'cloudy',    name: 'Cloudy',     sub: 'Dry · cooler surface',       icon: 'cloud' },
  { id: 'lightrain', name: 'Light Rain', sub: 'Damp · intermediates',       icon: 'drizzle' },
  { id: 'storm',     name: 'Storm',      sub: 'Standing water · full wets', icon: 'storm' },
  { id: 'dynamic',   name: 'Dynamic',    sub: 'Live front — it will turn',  icon: 'dynamic' },
];

const LAP_PRESETS = [
  { pct: 3,  name: '3%',  sub: 'Sprint dash' },
  { pct: 5,  name: '5%',  sub: 'Short run' },
  { pct: 10, name: '10%', sub: 'Standard' },
  { pct: 25, name: '25%', sub: 'Long run' },
  { pct: 50, name: '50%', sub: 'Endurance' },
];

const ERS_MODES = [
  { id: 'harvest',  name: 'Harvest',  sub: 'Recharge · save for later', delta: 0.32,  drain: -0.30 },
  { id: 'balanced', name: 'Balanced', sub: 'Auto deploy on exits',      delta: 0.00,  drain: 0.00 },
  { id: 'attack',   name: 'Attack',   sub: 'Full deploy on straights',  delta: -0.19, drain: 0.55 },
  { id: 'qualy',    name: 'Qualifying', sub: 'Everything, one lap',     delta: -0.41, drain: 1.00 },
];

const CAMERA_MODES = [
  { v: 'chase',   t: 'Chase' },
  { v: 'tv',      t: 'Broadcast' },
  { v: 'bumper',  t: 'Bumper' },
  { v: 'cockpit', t: 'Cockpit' },
  { v: 'helmet',  t: 'Helmet' },
];

const QUALITY_TIERS = [
  { v: 'low',    t: 'Low' },
  { v: 'medium', t: 'Medium' },
  { v: 'high',   t: 'High' },
  { v: 'ultra',  t: 'Ultra' },
  { v: 'auto',   t: 'Auto' },
];

const POINTS_TABLE = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

const DEFAULT_SETTINGS = {
  quality: 'auto',
  resolutionScale: 1.0,
  postFX: true,
  shadows: true,
  particles: 0.8,
  reflections: true,
  fov: 78,
  motionBlur: true,
  showFps: false,
  volumeMaster: 0.8,
  volumeEngine: 0.85,
  volumeUI: 0.6,
  units: 'kmh',
  cameraMode: 'chase',
  tractionControl: 'medium',
  abs: true,
  racingLine: 'corners',
  autoGearbox: true,
  touchLayout: 'wheel',
  steerSensitivity: 1.0,
};

const KEYMAP_ROWS = [
  [
    { k: 'ESC', w: 1.3, act: 'pause' }, { k: '1', act: 'ers' }, { k: '2', act: 'ers' }, { k: '3', act: 'ers' }, { k: '4', act: 'ers' },
    { k: '5' }, { k: '6' }, { k: '7' }, { k: '8' }, { k: '9' }, { k: '0' },
  ],
  [
    { k: 'TAB', w: 1.5, act: 'ui' }, { k: 'Q', act: 'sys' }, { k: 'W', act: 'drive' }, { k: 'E', act: 'sys' }, { k: 'R', act: 'sys' },
    { k: 'T', act: 'ui' }, { k: 'Y' }, { k: 'U' }, { k: 'I' }, { k: 'O' }, { k: 'P', act: 'pause' },
  ],
  [
    { k: 'CAPS', w: 1.8 }, { k: 'A', act: 'drive' }, { k: 'S', act: 'drive' }, { k: 'D', act: 'drive' }, { k: 'F' },
    { k: 'G' }, { k: 'H', act: 'ui' }, { k: 'J' }, { k: 'K' }, { k: 'L', act: 'ui' },
  ],
  [
    { k: 'SHIFT', w: 2.3, act: 'gear' }, { k: 'Z' }, { k: 'X' }, { k: 'C', act: 'cam' }, { k: 'V', act: 'cam' },
    { k: 'B' }, { k: 'N' }, { k: 'M', act: 'ui' }, { k: ',' }, { k: '.' },
  ],
  [
    { k: 'CTRL', w: 1.6, act: 'gear' }, { k: 'ALT', w: 1.2 }, { k: 'SPACE', w: 6, act: 'sys' }, { k: 'ALT', w: 1.2 }, { k: 'CTRL', w: 1.6, act: 'gear' },
  ],
];

const KEY_BINDINGS = [
  { keys: 'W / ↑',        act: 'drive', label: 'Throttle',       note: 'Analogue ramp — feather it out of slow corners' },
  { keys: 'S / ↓',        act: 'drive', label: 'Brake',          note: 'Trail off as you turn in to rotate the car' },
  { keys: 'A / ←',        act: 'drive', label: 'Steer left',     note: 'Speed-sensitive rate limiting' },
  { keys: 'D / →',        act: 'drive', label: 'Steer right',    note: 'Hold for a slower, smoother rack' },
  { keys: 'SHIFT',        act: 'gear',  label: 'Upshift',        note: 'Ignored while auto-gearbox is on' },
  { keys: 'CTRL',         act: 'gear',  label: 'Downshift',      note: 'Blipped automatically' },
  { keys: 'SPACE',        act: 'sys',   label: 'DRS',            note: 'Only arms inside a detection zone within 1.0s' },
  { keys: 'E',            act: 'sys',   label: 'ERS overtake',   note: 'Hold for maximum deployment' },
  { keys: 'Q',            act: 'sys',   label: 'Pit limiter',    note: 'Auto-engages on pit entry' },
  { keys: 'R',            act: 'sys',   label: 'Recover to track', note: 'Costs a time penalty if abused' },
  { keys: '1 – 4',        act: 'ers',   label: 'ERS mode',       note: 'Harvest / Balanced / Attack / Qualifying' },
  { keys: 'C',            act: 'cam',   label: 'Cycle camera',   note: 'Chase · Broadcast · Bumper · Cockpit · Helmet' },
  { keys: 'V',            act: 'cam',   label: 'Look behind',    note: 'Hold' },
  { keys: 'H',            act: 'ui',    label: 'Toggle HUD',     note: 'For clean replays and screenshots' },
  { keys: 'M',            act: 'ui',    label: 'Track map',      note: 'Expanded live map' },
  { keys: 'T',            act: 'ui',    label: 'Telemetry',      note: 'Traces for throttle, brake, steering, speed' },
  { keys: 'TAB',          act: 'ui',    label: 'Timing screen',  note: 'Hold to view the full classification' },
  { keys: 'P / ESC',      act: 'pause', label: 'Pause',          note: 'Freezes the simulation' },
];

const PAD_MAP = [
  { x: 168, y: 112, side: 'l', ly: 60,  t: 'Left stick',    s: 'Steering' },
  { x: 200, y: 156, side: 'l', ly: 196, t: 'D-pad',         s: 'ERS mode · brake bias' },
  { x: 140, y: 44,  side: 'l', ly: 24,  t: 'LB / LT',       s: 'Downshift · brake' },
  { x: 320, y: 44,  side: 'r', ly: 24,  t: 'RB / RT',       s: 'Upshift · throttle' },
  { x: 300, y: 128, side: 'r', ly: 178, t: 'A / ✕',         s: 'DRS' },
  { x: 318, y: 110, side: 'r', ly: 138, t: 'B / ○',         s: 'ERS overtake' },
  { x: 282, y: 110, side: 'r', ly: 98,  t: 'X / □',         s: 'Pit limiter' },
  { x: 300, y: 92,  side: 'r', ly: 58,  t: 'Y / △',         s: 'Camera' },
  { x: 262, y: 152, side: 'r', ly: 208, t: 'Right stick',   s: 'Look around' },
  { x: 230, y: 100, side: 'l', ly: 130, t: 'Start / Select', s: 'Pause · HUD' },
];

const TOUCH_LAYOUTS = [
  {
    id: 'wheel', name: 'Wheel',
    blurb: 'A virtual steering wheel sits under your left thumb; drag it round the arc. Throttle and brake are stacked pads on the right. The most precise option once you learn the travel.',
  },
  {
    id: 'buttons', name: 'Buttons',
    blurb: 'Discrete left/right steering pads with a rate-limited ramp, throttle and brake on the right. Predictable and forgiving on small screens.',
  },
  {
    id: 'tilt', name: 'Tilt',
    blurb: 'Steer by tilting the device — calibrated the moment the lights go out. Throttle is a tap-and-hold pad, brake is the second pad. Frees the whole screen for the track.',
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Tiny DOM / math helpers (pure, module scope)
 * ──────────────────────────────────────────────────────────────────────────*/

let _uid = 0;
const nextId = () => 'apx' + (++_uid).toString(36);

function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined && txt !== null) n.textContent = String(txt);
  return n;
}

function sv(tag, attrs) {
  const n = document.createElementNS(NS_SVG, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  return n;
}

function add(parent, child) { parent.appendChild(child); return child; }

function setText(node, v) { if (node && node.textContent !== v) node.textContent = v; }

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function fmtLap(sec) {
  const s = num(sec, 0);
  if (!(s > 0) || !Number.isFinite(s)) return '—.———';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const rs = r.toFixed(3);
  return m > 0 ? m + ':' + (r < 10 ? '0' : '') + rs : rs;
}

function fmtDelta(d) {
  if (!Number.isFinite(d)) return '';
  const s = Math.abs(d).toFixed(3);
  return (d > 0 ? '+' : d < 0 ? '−' : '') + s;
}

function fmtClock(hoursFloat) {
  const h = clamp(num(hoursFloat, 14), 0, 24);
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return pad2(hh) + ':' + pad2(mm);
}

function daypartName(h) {
  if (h < 5.2) return 'Night';
  if (h < 7.0) return 'Dawn';
  if (h < 10.0) return 'Morning';
  if (h < 15.5) return 'Midday';
  if (h < 18.0) return 'Afternoon';
  if (h < 19.6) return 'Golden hour';
  if (h < 21.0) return 'Dusk';
  return 'Night';
}

function skyGradient(h) {
  const stops = [
    [0.0, '#05070f', '#0a1024'],
    [5.0, '#0a1024', '#241a3a'],
    [6.4, '#3a2350', '#c86a3c'],
    [7.6, '#7c5aa8', '#e8a15c'],
    [10.0, '#2e6fc4', '#9fc9ee'],
    [14.0, '#1f6ad4', '#bfe0fb'],
    [17.2, '#2a63b0', '#f0c07a'],
    [18.8, '#8a3f6a', '#f2803c'],
    [20.0, '#3a2050', '#a03a52'],
    [21.6, '#0d1128', '#231a3e'],
    [24.0, '#05070f', '#0a1024'],
  ];
  const hh = clamp(num(h, 14), 0, 24);
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (hh >= stops[i][0] && hh <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const span = (b[0] - a[0]) || 1;
  const t = clamp((hh - a[0]) / span, 0, 1);
  return 'linear-gradient(180deg,' + mixHex(a[1], b[1], t) + ' 0%,' + mixHex(a[2], b[2], t) + ' 100%)';
}

function hex2rgb(hex) {
  let s = String(hex || '#000').replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const v = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(v)) return [0, 0, 0];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mixHex(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b);
  const r = Math.round(lerp(A[0], B[0], t));
  const g = Math.round(lerp(A[1], B[1], t));
  const bl = Math.round(lerp(A[2], B[2], t));
  return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

function rgba(hex, a) {
  const c = hex2rgb(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
}

/** Deterministic 32-bit hash of a string — used for stable procedural fallbacks. */
function hashStr(s) {
  let h = 2166136261 >>> 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function seededRand(seed) {
  let s = seed >>> 0 || 1;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return (s >>> 0) / 4294967296; };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Circuit data normalisation — tolerant of many plausible shapes
 * ──────────────────────────────────────────────────────────────────────────*/

function variance(arr, off, stride) {
  let mean = 0, n = 0;
  for (let i = off; i < arr.length; i += stride) { mean += arr[i]; n++; }
  if (!n) return 0;
  mean /= n;
  let v = 0;
  for (let i = off; i < arr.length; i += stride) { const d = arr[i] - mean; v += d * d; }
  return v / n;
}

function readFlat(arr) {
  const out = [];
  let stride = 2;
  if (arr.length % 3 === 0) {
    // Prefer XYZ when the middle component is comparatively flat (elevation).
    const v0 = variance(arr, 0, 3), v1 = variance(arr, 1, 3), v2 = variance(arr, 2, 3);
    stride = (v1 <= 0.12 * Math.max(v0, v2, 1e-9)) ? 3 : (arr.length % 2 === 0 ? 2 : 3);
  }
  for (let i = 0; i + stride - 1 < arr.length; i += stride) {
    out.push({ x: +arr[i], z: stride === 3 ? +arr[i + 2] : +arr[i + 1] });
  }
  return out;
}

function readPointArray(arr) {
  const out = [];
  if (!arr) return out;
  if (ArrayBuffer.isView(arr)) return readFlat(arr).filter(finitePt);
  if (!Array.isArray(arr) || !arr.length) return out;
  if (typeof arr[0] === 'number') return readFlat(arr).filter(finitePt);
  for (let i = 0; i < arr.length; i++) {
    let p = arr[i];
    if (!p) continue;
    if (p.pos) p = p.pos; else if (p.position) p = p.position; else if (p.point) p = p.point;
    if (Array.isArray(p) || ArrayBuffer.isView(p)) {
      out.push({ x: +p[0], z: p.length >= 3 ? +p[2] : +p[1] });
    } else if (typeof p === 'object') {
      const x = +(p.x !== undefined ? p.x : (p.X !== undefined ? p.X : p[0]));
      const z = +(p.z !== undefined ? p.z : (p.Z !== undefined ? p.Z : (p.y !== undefined ? p.y : p[1])));
      out.push({ x: x, z: z });
    }
  }
  return out.filter(finitePt);
}

function finitePt(p) { return p && Number.isFinite(p.x) && Number.isFinite(p.z); }

const POINT_KEYS = ['points', 'centerline', 'centreline', 'spline', 'path', 'nodes', 'controlPoints', 'outline', 'shape', 'racingLine', 'waypoints'];

function circuitPoints(circuit) {
  if (!circuit) return [];
  for (let i = 0; i < POINT_KEYS.length; i++) {
    const pts = readPointArray(circuit[POINT_KEYS[i]]);
    if (pts.length >= 4) return pts;
  }
  if (circuit.geometry) {
    for (let i = 0; i < POINT_KEYS.length; i++) {
      const pts = readPointArray(circuit.geometry[POINT_KEYS[i]]);
      if (pts.length >= 4) return pts;
    }
  }
  return proceduralLoop(circuit && (circuit.id || circuit.name) || 'apex');
}

/** Stable, plausible-looking closed loop so a card is never blank. */
function proceduralLoop(seedKey) {
  const rnd = seededRand(hashStr(seedKey));
  const lobes = 3 + Math.floor(rnd() * 4);
  const ph = [];
  for (let i = 0; i < 5; i++) ph.push(rnd() * Math.PI * 2);
  const amp = [0.30 + rnd() * 0.22, 0.16 + rnd() * 0.16, 0.08 + rnd() * 0.10];
  const N = 220;
  const out = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 1
      + amp[0] * Math.sin(a * lobes + ph[0])
      + amp[1] * Math.sin(a * (lobes + 2) + ph[1])
      + amp[2] * Math.sin(a * (lobes + 5) + ph[2]);
    out.push({ x: Math.cos(a) * r * 1000, z: Math.sin(a) * r * (0.62 + rnd() * 0.0) * 1000 });
  }
  return out;
}

function circuitLength(circuit) {
  if (!circuit) return 5000;
  const direct = num(circuit.length, NaN);
  if (Number.isFinite(direct) && direct > 200) return direct;
  const alt = num(circuit.lengthM, num(circuit.distance, num(circuit.lapLength, NaN)));
  if (Number.isFinite(alt) && alt > 200) return alt;
  const km = num(circuit.lengthKm, NaN);
  if (Number.isFinite(km) && km > 0.2) return km * 1000;
  const pts = circuitPoints(circuit);
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    L += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return L > 200 ? L : 5000;
}

function circuitTurns(circuit) {
  if (!circuit) return 16;
  if (Number.isFinite(circuit.turns)) return circuit.turns | 0;
  if (Array.isArray(circuit.turns)) return circuit.turns.length;
  if (Array.isArray(circuit.corners)) return circuit.corners.length;
  if (Number.isFinite(circuit.corners)) return circuit.corners | 0;
  return 12 + (hashStr(circuit.id || circuit.name) % 9);
}

function lapRecordSeconds(circuit) {
  if (!circuit) return 0;
  const r = circuit.lapRecord || circuit.record || circuit.bestLap;
  if (r == null) return 0;
  if (typeof r === 'number') return r > 0 ? r : 0;
  if (typeof r === 'string') return parseTimeStr(r);
  if (typeof r === 'object') {
    if (typeof r.time === 'number') return r.time;
    if (typeof r.time === 'string') return parseTimeStr(r.time);
    if (typeof r.seconds === 'number') return r.seconds;
  }
  return 0;
}

function lapRecordHolder(circuit) {
  const r = circuit && (circuit.lapRecord || circuit.record || circuit.bestLap);
  if (r && typeof r === 'object') {
    const who = r.driver || r.holder || r.name || '';
    const yr = r.year || r.season || '';
    return [who, yr].filter(Boolean).join(' · ');
  }
  return '';
}

function parseTimeStr(s) {
  const m = String(s).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  return (m[1] ? +m[1] * 60 : 0) + (+m[2] || 0);
}

function circuitFullLaps(circuit) {
  const declared = num(circuit && (circuit.laps || circuit.raceLaps), NaN);
  if (Number.isFinite(declared) && declared > 0) return declared | 0;
  return Math.max(1, Math.ceil(305000 / circuitLength(circuit)));
}

function circuitName(c) { return (c && (c.name || c.title || c.id)) || 'Unnamed Circuit'; }
function circuitPlace(c) {
  if (!c) return '';
  return [c.location || c.city || c.region, c.country || c.nation].filter(Boolean).join(', ');
}

function normalizeCircuits(input) {
  let list = [];
  try {
    if (Array.isArray(input)) list = input.slice();
    else if (input && typeof input === 'object') {
      if (Array.isArray(input.circuits)) list = input.circuits.slice();
      else if (Array.isArray(input.CIRCUITS)) list = input.CIRCUITS.slice();
      else list = Object.keys(input).map((k) => {
        const v = input[k];
        return (v && typeof v === 'object') ? (v.id ? v : Object.assign({ id: k }, v)) : null;
      }).filter(Boolean);
    }
  } catch (e) { list = []; }
  list = list.filter((c) => c && typeof c === 'object');
  if (!list.length) {
    list = [{
      id: 'apex-proving-ground',
      name: 'Apex Proving Ground',
      country: 'Test Facility',
      location: 'Sector 0',
      length: 5140,
      turns: 15,
      laps: 58,
      lapRecord: { time: 84.612, driver: 'Reference Lap', year: '' },
    }];
  }
  return list.map((c, i) => (c.id ? c : Object.assign({ id: 'circuit-' + i }, c)));
}

function normalizeTeams(input) {
  let list = [];
  try {
    if (Array.isArray(input)) list = input.slice();
    else if (input && typeof input === 'object') {
      if (Array.isArray(input.TEAMS)) list = input.TEAMS.slice();
      else if (Array.isArray(input.teams)) list = input.teams.slice();
      else list = Object.keys(input).map((k) => input[k]).filter((v) => v && typeof v === 'object' && v.drivers);
    }
  } catch (e) { list = []; }
  list = list.filter((t) => t && typeof t === 'object' && Array.isArray(t.drivers) && t.drivers.length);
  return list.length ? list : BUILTIN_TEAMS;
}

function teamColors(team) {
  const c = (team && team.colors) || {};
  return {
    primary: c.primary || '#1a1f2b',
    secondary: c.secondary || '#0b0e14',
    accent: c.accent || '#ff2d20',
    trim: c.trim || '#ffffff',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Procedural SVG builders
 * ──────────────────────────────────────────────────────────────────────────*/

/** Resample a closed polyline down to at most `max` points, evenly by index. */
function decimate(pts, max) {
  if (pts.length <= max) return pts;
  const out = [];
  const step = pts.length / max;
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  return out;
}

/** Closed Catmull–Rom → cubic bezier path string. */
function smoothPath(pts) {
  const n = pts.length;
  if (n < 3) return '';
  let d = 'M' + pts[0].X.toFixed(2) + ',' + pts[0].Y.toFixed(2);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1x = p1.X + (p2.X - p0.X) / 6, c1y = p1.Y + (p2.Y - p0.Y) / 6;
    const c2x = p2.X - (p3.X - p1.X) / 6, c2y = p2.Y - (p3.Y - p1.Y) / 6;
    d += 'C' + c1x.toFixed(2) + ',' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ',' + c2y.toFixed(2) + ' ' + p2.X.toFixed(2) + ',' + p2.Y.toFixed(2);
  }
  return d + 'Z';
}

/**
 * Draw a circuit outline from its raw point data.
 * @param {Object} circuit
 * @param {Object} [o] { w, h, pad, detail, accent, showStart, showSectors }
 * @returns {SVGElement}
 */
function buildTrackSVG(circuit, o) {
  const W = (o && o.w) || 200;
  const H = (o && o.h) || 128;
  const pad = (o && o.pad) || 14;
  const accent = (o && o.accent) || 'var(--apx-accent)';
  const svg = sv('svg', { class: 'apx-trk', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', focusable: 'false' });
  try {
    let pts = decimate(circuitPoints(circuit), (o && o.detail) || 120);
    if (pts.length < 4) pts = decimate(proceduralLoop(circuit && circuit.id), 120);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const spanX = Math.max(1e-6, maxX - minX), spanZ = Math.max(1e-6, maxZ - minZ);
    const s = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanZ);
    const ox = (W - spanX * s) * 0.5 - minX * s;
    const oy = (H - spanZ * s) * 0.5 - minZ * s;

    const mapped = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) mapped[i] = { X: pts[i].x * s + ox, Y: pts[i].z * s + oy };

    const d = smoothPath(mapped);
    if (!d) return svg;

    const gid = nextId();
    const defs = add(svg, sv('defs'));
    const grad = add(defs, sv('linearGradient', { id: gid + 'g', x1: '0', y1: '0', x2: '1', y2: '1' }));
    add(grad, sv('stop', { offset: '0', 'stop-color': accent, 'stop-opacity': '1' }));
    add(grad, sv('stop', { offset: '1', 'stop-color': accent, 'stop-opacity': '0.35' }));

    add(svg, sv('path', { class: 'apx-trk-halo', d: d, fill: 'none', stroke: accent, 'stroke-width': '7', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: '0.10' }));
    add(svg, sv('path', { class: 'apx-trk-base', d: d, fill: 'none', stroke: 'rgba(255,255,255,0.16)', 'stroke-width': '4.2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    add(svg, sv('path', { class: 'apx-trk-line', d: d, fill: 'none', stroke: 'url(#' + gid + 'g)', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    if (!o || o.showStart !== false) {
      const a = mapped[0], b = mapped[1 % mapped.length];
      let dx = b.X - a.X, dy = b.Y - a.Y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy * 5.2, ny = dx * 5.2;
      add(svg, sv('line', {
        class: 'apx-trk-sf', x1: (a.X - nx).toFixed(2), y1: (a.Y - ny).toFixed(2),
        x2: (a.X + nx).toFixed(2), y2: (a.Y + ny).toFixed(2),
        stroke: '#ffffff', 'stroke-width': '2.4', 'stroke-linecap': 'round', opacity: '0.9',
      }));
    }
    if (o && o.showSectors) {
      for (let k = 1; k <= 2; k++) {
        const p = mapped[Math.floor(mapped.length * (k / 3)) % mapped.length];
        add(svg, sv('circle', { cx: p.X.toFixed(2), cy: p.Y.toFixed(2), r: '2.1', fill: 'rgba(255,255,255,0.75)' }));
      }
    }
  } catch (e) { /* a blank outline is acceptable; never break the card */ }
  return svg;
}

/** Top-down single-seater silhouette painted in a team's livery. */
function buildCarSVG(team) {
  const c = teamColors(team);
  const svg = sv('svg', { class: 'apx-car', viewBox: '0 0 120 250', 'aria-hidden': 'true', focusable: 'false' });
  try {
    const id = nextId();
    const defs = add(svg, sv('defs'));
    const g = add(defs, sv('linearGradient', { id: id + 'b', x1: '0', y1: '0', x2: '0', y2: '1' }));
    add(g, sv('stop', { offset: '0', 'stop-color': c.primary }));
    add(g, sv('stop', { offset: '0.55', 'stop-color': mixHex(c.primary, '#000000', 0.18) }));
    add(g, sv('stop', { offset: '1', 'stop-color': c.secondary }));

    const tyre = (x, y, w, h) => add(svg, sv('rect', { x: x, y: y, width: w, height: h, rx: 3, fill: '#0d0d0f', stroke: 'rgba(255,255,255,0.10)', 'stroke-width': '0.8' }));
    // Rear tyres
    tyre(14, 172, 18, 42); tyre(88, 172, 18, 42);
    // Front tyres
    tyre(19, 44, 15, 34); tyre(86, 44, 15, 34);
    // Front wing
    add(svg, sv('rect', { x: 16, y: 8, width: 88, height: 13, rx: 2, fill: c.secondary }));
    add(svg, sv('rect', { x: 16, y: 11, width: 88, height: 4, rx: 1.5, fill: c.accent, opacity: '0.9' }));
    add(svg, sv('rect', { x: 13, y: 3, width: 7, height: 24, rx: 2, fill: mixHex(c.primary, '#ffffff', 0.10) }));
    add(svg, sv('rect', { x: 100, y: 3, width: 7, height: 24, rx: 2, fill: mixHex(c.primary, '#ffffff', 0.10) }));
    // Sidepods
    add(svg, sv('path', { d: 'M30,112 C24,116 22,128 23,142 L26,168 C27,174 32,176 38,174 L42,116 Z', fill: mixHex(c.primary, '#000000', 0.28) }));
    add(svg, sv('path', { d: 'M90,112 C96,116 98,128 97,142 L94,168 C93,174 88,176 82,174 L78,116 Z', fill: mixHex(c.primary, '#000000', 0.28) }));
    // Main body
    add(svg, sv('path', {
      d: 'M60,20 C56,20 54,28 53,38 L50,88 C44,90 41,96 41,106 L41,152 C41,162 45,170 51,174 L49,214 C49,226 53,236 60,236 C67,236 71,226 71,214 L69,174 C75,170 79,162 79,152 L79,106 C79,96 76,90 70,88 L67,38 C66,28 64,20 60,20 Z',
      fill: 'url(#' + id + 'b)', stroke: 'rgba(255,255,255,0.10)', 'stroke-width': '0.9',
    }));
    // Livery stripe
    add(svg, sv('path', { d: 'M56,24 L64,24 L67,120 L66,176 L54,176 L53,120 Z', fill: c.accent, opacity: '0.92' }));
    add(svg, sv('rect', { x: 44, y: 128, width: 32, height: 3, fill: c.trim, opacity: '0.5' }));
    add(svg, sv('rect', { x: 44, y: 136, width: 32, height: 2, fill: c.trim, opacity: '0.3' }));
    // Halo + cockpit
    add(svg, sv('ellipse', { cx: 60, cy: 104, rx: 9, ry: 13, fill: '#08090c' }));
    add(svg, sv('path', { d: 'M48,110 A12,12 0 0 1 72,110', fill: 'none', stroke: '#121418', 'stroke-width': '3.6', 'stroke-linecap': 'round' }));
    // Engine cover fin + rear wing
    add(svg, sv('path', { d: 'M58,176 L62,176 L63,220 L57,220 Z', fill: mixHex(c.primary, '#ffffff', 0.14) }));
    add(svg, sv('rect', { x: 20, y: 222, width: 80, height: 12, rx: 2, fill: c.secondary }));
    add(svg, sv('rect', { x: 20, y: 225, width: 80, height: 4, rx: 1.5, fill: c.accent, opacity: '0.85' }));
    add(svg, sv('rect', { x: 17, y: 216, width: 7, height: 26, rx: 2, fill: mixHex(c.primary, '#ffffff', 0.08) }));
    add(svg, sv('rect', { x: 96, y: 216, width: 7, height: 26, rx: 2, fill: mixHex(c.primary, '#ffffff', 0.08) }));
  } catch (e) { /* silhouette optional */ }
  return svg;
}

/** Driver helmet, side profile, painted from driver.helmet. */
function buildHelmetSVG(helmet) {
  const h = helmet || {};
  const base = h.base || '#2a2f3a';
  const stripe = h.stripe || '#ffffff';
  const visor = h.visor || '#101010';
  const svg = sv('svg', { class: 'apx-helm', viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' });
  try {
    const id = nextId();
    const defs = add(svg, sv('defs'));
    const cp = add(defs, sv('clipPath', { id: id + 'c' }));
    add(cp, sv('path', { d: 'M11,53 C11,28 30,11 52,11 C75,11 90,28 90,50 L90,66 C90,77 83,85 71,87 L34,89 C20,89 11,79 11,66 Z' }));
    const gr = add(defs, sv('linearGradient', { id: id + 'g', x1: '0', y1: '0', x2: '0.3', y2: '1' }));
    add(gr, sv('stop', { offset: '0', 'stop-color': mixHex(base, '#ffffff', 0.22) }));
    add(gr, sv('stop', { offset: '1', 'stop-color': mixHex(base, '#000000', 0.25) }));

    const grp = add(svg, sv('g', { 'clip-path': 'url(#' + id + 'c)' }));
    add(grp, sv('rect', { x: 0, y: 0, width: 100, height: 100, fill: 'url(#' + id + 'g)' }));
    add(grp, sv('path', { d: 'M8,40 L94,34 L94,48 L8,55 Z', fill: stripe, opacity: '0.95' }));
    add(grp, sv('path', { d: 'M8,58 L94,52 L94,58 L8,64 Z', fill: stripe, opacity: '0.35' }));
    add(grp, sv('path', { d: 'M34,38 L88,35 L90,58 L42,62 C35,62 32,57 32,50 Z', fill: visor }));
    add(grp, sv('path', { d: 'M38,40 L84,37.5 L85,44 L38,47 Z', fill: '#ffffff', opacity: '0.12' }));
    add(svg, sv('path', { d: 'M11,53 C11,28 30,11 52,11 C75,11 90,28 90,50 L90,66 C90,77 83,85 71,87 L34,89 C20,89 11,79 11,66 Z', fill: 'none', stroke: 'rgba(0,0,0,0.5)', 'stroke-width': '1.6' }));
  } catch (e) { /* helmet optional */ }
  return svg;
}

function buildWeatherIcon(kind) {
  const svg = sv('svg', { class: 'apx-wx-icon', viewBox: '0 0 40 40', 'aria-hidden': 'true', focusable: 'false' });
  const S = 'currentColor';
  try {
    if (kind === 'sun') {
      add(svg, sv('circle', { cx: 20, cy: 20, r: 7.5, fill: 'none', stroke: S, 'stroke-width': 2 }));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        add(svg, sv('line', {
          x1: (20 + Math.cos(a) * 11.5).toFixed(1), y1: (20 + Math.sin(a) * 11.5).toFixed(1),
          x2: (20 + Math.cos(a) * 15.5).toFixed(1), y2: (20 + Math.sin(a) * 15.5).toFixed(1),
          stroke: S, 'stroke-width': 2, 'stroke-linecap': 'round',
        }));
      }
    } else if (kind === 'cloud') {
      add(svg, sv('path', { d: 'M11,26 A6,6 0 0 1 12,14 A8,8 0 0 1 27,15 A5.5,5.5 0 0 1 29,26 Z', fill: 'none', stroke: S, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    } else if (kind === 'drizzle' || kind === 'storm') {
      add(svg, sv('path', { d: 'M11,22 A6,6 0 0 1 12,10 A8,8 0 0 1 27,11 A5.5,5.5 0 0 1 29,22 Z', fill: 'none', stroke: S, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      const drops = kind === 'storm' ? [12, 17, 22, 27] : [14, 20, 26];
      for (let i = 0; i < drops.length; i++) {
        add(svg, sv('line', { x1: drops[i], y1: 26, x2: drops[i] - 3, y2: 34, stroke: S, 'stroke-width': 2, 'stroke-linecap': 'round' }));
      }
      if (kind === 'storm') add(svg, sv('path', { d: 'M22,24 L17,32 L21,32 L18,38', fill: 'none', stroke: S, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    } else {
      add(svg, sv('path', { d: 'M6,20 A14,14 0 0 1 34,20', fill: 'none', stroke: S, 'stroke-width': 2, 'stroke-linecap': 'round' }));
      add(svg, sv('path', { d: 'M34,20 A14,14 0 0 1 6,20', fill: 'none', stroke: S, 'stroke-width': 2, 'stroke-dasharray': '3 4', 'stroke-linecap': 'round' }));
      add(svg, sv('path', { d: 'M30,14 L34,20 L28,21', fill: 'none', stroke: S, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
  } catch (e) { /* icon optional */ }
  return svg;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Setup performance model — drives the garage lap-time estimate
 * ──────────────────────────────────────────────────────────────────────────*/

const REFERENCE_SETUP = { tyre: 'medium', ersMode: 'balanced', brakeBias: 57, wingFront: 25, wingRear: 25 };

function baseLapSeconds(circuit) {
  const rec = lapRecordSeconds(circuit);
  if (rec > 25) return rec;
  const L = circuitLength(circuit);
  const density = circuitTurns(circuit) / Math.max(0.5, L / 1000);
  const avg = clamp(66 - density * 4.4, 36, 68);
  return L / avg;
}

/** Where a circuit wants its total downforce (front+rear, 2..100). */
function circuitDownforceTarget(circuit) {
  const L = circuitLength(circuit);
  const density = circuitTurns(circuit) / Math.max(0.5, L / 1000);
  return clamp(18 + density * 12.5, 16, 88);
}

function weatherPenalty(weather, wetTyre) {
  let p = 0, wet = 0;
  if (weather === 'cloudy') { p = 0.15; wet = 0; }
  else if (weather === 'lightrain') { p = 4.6; wet = 0.42; }
  else if (weather === 'storm') { p = 11.5; wet = 0.92; }
  else if (weather === 'dynamic') { p = 1.4; wet = 0.20; }
  if (wet > 0.05) {
    if (wetTyre === 'wet') p -= wet * 6.6;
    else if (wetTyre === 'inter') p -= wet * 5.0;
    else p += wet * 9.5;
  } else if (wetTyre === 'wet') p += 7.4;
  else if (wetTyre === 'inter') p += 3.6;
  return p;
}

/**
 * Model a representative flying lap for the current configuration.
 * Deterministic, cheap and monotonic so the readout feels honest.
 */
function lapModel(cfg, circuit, team, driver) {
  const base = baseLapSeconds(circuit);
  const comp = TYRE_COMPOUNDS[cfg.tyre] || TYRE_COMPOUNDS.medium;
  const grip = num(comp.grip, 0.96);
  let t = base;

  // Compound grip: ~18s of lap time hangs off a full unit of grip.
  t += (1.0 - grip) * 17.5;

  // Aero: distance from the circuit's ideal total downforce, plus balance.
  const target = circuitDownforceTarget(circuit);
  const total = num(cfg.wingFront, 25) + num(cfg.wingRear, 25);
  t += Math.abs(total - target) * 0.026;
  const balance = num(cfg.wingRear, 25) - num(cfg.wingFront, 25);
  t += Math.abs(balance - 2.5) * 0.014;

  // Brake bias: ~57% forward is neutral; going far either way costs.
  t += Math.abs(num(cfg.brakeBias, 57) - 57) * 0.052;

  // Energy deployment strategy.
  const ers = ERS_MODES.find((m) => m.id === cfg.ersMode) || ERS_MODES[1];
  t += ers.delta;

  // Conditions.
  t += weatherPenalty(cfg.weather, cfg.tyre);
  const hour = num(cfg.timeOfDay, 15);
  const heat = Math.cos(((hour - 14.5) / 24) * Math.PI * 2);
  t += heat * 0.28;                    // hot midday track = a touch slower
  if (hour < 6.4 || hour > 20.4) t += 0.22;

  // Machinery and driver.
  const perf = num(team && team.performance, 0.9);
  const skill = num(driver && driver.skill, 0.9);
  t *= 1 + (0.965 - perf) * 0.85;
  t *= 1 + (0.95 - skill) * 0.42;

  return Math.max(18, t);
}

function referenceLap(cfg, circuit, team, driver) {
  const ref = {
    tyre: REFERENCE_SETUP.tyre, ersMode: REFERENCE_SETUP.ersMode,
    brakeBias: REFERENCE_SETUP.brakeBias, wingFront: REFERENCE_SETUP.wingFront,
    wingRear: REFERENCE_SETUP.wingRear, weather: cfg.weather, timeOfDay: cfg.timeOfDay,
  };
  return lapModel(ref, circuit, team, driver);
}

/** Five 0..1 setup traits shown as bars in the garage. */
function setupTraits(cfg) {
  const wf = num(cfg.wingFront, 25), wr = num(cfg.wingRear, 25);
  const total = wf + wr;
  const comp = TYRE_COMPOUNDS[cfg.tyre] || TYRE_COMPOUNDS.medium;
  const ers = ERS_MODES.find((m) => m.id === cfg.ersMode) || ERS_MODES[1];
  const bias = num(cfg.brakeBias, 57);
  return {
    topSpeed: clamp(1 - (total - 4) / 92, 0, 1),
    cornering: clamp((total - 4) / 92, 0, 1),
    stability: clamp(0.42 + (wr - wf) / 60 + (58 - bias) / 40 * 0.22, 0, 1),
    tyreLife: clamp(1.12 - num(comp.wearRate, 1) * 0.52 - (total / 200), 0, 1),
    energy: clamp(0.5 - num(ers.drain, 0) * 0.45, 0, 1),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reusable control widgets
 * ──────────────────────────────────────────────────────────────────────────*/

function syncRange(input) {
  const mn = +input.min, mx = +input.max, v = +input.value;
  const p = mx > mn ? ((v - mn) / (mx - mn)) * 100 : 0;
  input.style.setProperty('--p', p.toFixed(2) + '%');
}

/**
 * Builds seg / slider / toggle controls that report to `notify(key, value)`
 * and register a silent setter in `registry` for updateSettings().
 */
function makeControls(registry, notify) {
  function head(label, hintText, valueNode) {
    const h = el('div', 'apx-ctl-head');
    add(h, el('span', 'apx-lbl', label));
    if (valueNode) add(h, valueNode);
    else if (hintText) add(h, el('span', 'apx-hint', hintText));
    return h;
  }

  return {
    seg(key, label, options, value, hint) {
      const wrap = el('div', 'apx-ctl apx-ctl--seg');
      add(wrap, head(label, hint));
      const grp = add(wrap, el('div', 'apx-seg'));
      grp.setAttribute('role', 'radiogroup');
      grp.setAttribute('aria-label', label);
      const btns = [];
      const apply = (v, silent) => {
        for (let i = 0; i < btns.length; i++) {
          const on = btns[i].dataset.v === String(v);
          btns[i].classList.toggle('is-on', on);
          btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
          btns[i].tabIndex = on ? 0 : -1;
        }
        if (!silent) notify(key, v);
      };
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        const b = add(grp, el('button', 'apx-seg-btn', o.t));
        b.type = 'button';
        b.dataset.v = String(o.v);
        b.setAttribute('role', 'radio');
        if (o.hint) b.title = o.hint;
        b.addEventListener('click', () => apply(o.v, false));
        btns.push(b);
      }
      grp.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        const cur = btns.findIndex((b) => b.classList.contains('is-on'));
        const nx = clamp(cur + (ev.key === 'ArrowRight' ? 1 : -1), 0, btns.length - 1);
        if (nx !== cur) { apply(btns[nx].dataset.v, false); btns[nx].focus(); }
        ev.preventDefault(); ev.stopPropagation();
      });
      apply(value, true);
      if (registry) registry.set(key, (v) => apply(v, true));
      return wrap;
    },

    slider(key, label, min, max, step, value, fmt, hint) {
      const wrap = el('div', 'apx-ctl apx-ctl--slider');
      const valNode = el('span', 'apx-val', '');
      add(wrap, head(label, hint, valNode));
      const input = add(wrap, el('input', 'apx-range'));
      input.type = 'range';
      input.min = String(min); input.max = String(max); input.step = String(step);
      input.setAttribute('aria-label', label);
      const render = (v) => { setText(valNode, fmt ? fmt(v) : String(v)); };
      const apply = (v, silent) => {
        const nv = clamp(num(v, min), min, max);
        input.value = String(nv);
        syncRange(input);
        render(+input.value);
        if (!silent) notify(key, +input.value);
      };
      input.addEventListener('input', () => { syncRange(input); render(+input.value); notify(key, +input.value); });
      input.addEventListener('change', () => { syncRange(input); render(+input.value); });
      if (hint) add(wrap, el('p', 'apx-ctl-note', hint));
      apply(value, true);
      if (registry) registry.set(key, (v) => apply(v, true));
      return wrap;
    },

    toggle(key, label, value, hint) {
      const b = el('button', 'apx-ctl apx-ctl--toggle');
      b.type = 'button';
      b.setAttribute('role', 'switch');
      const txt = add(b, el('span', 'apx-toggle-text'));
      add(txt, el('span', 'apx-lbl', label));
      if (hint) add(txt, el('span', 'apx-hint', hint));
      const sw = add(b, el('span', 'apx-switch'));
      add(sw, el('i'));
      let cur = !!value;
      const apply = (v, silent) => {
        cur = !!v;
        b.classList.toggle('is-on', cur);
        b.setAttribute('aria-checked', cur ? 'true' : 'false');
        if (!silent) notify(key, cur);
      };
      b.addEventListener('click', () => apply(!cur, false));
      apply(cur, true);
      if (registry) registry.set(key, (v) => apply(v, true));
      return b;
    },
  };
}

function bar(value, label, cls) {
  const w = el('div', 'apx-bar' + (cls ? ' ' + cls : ''));
  add(w, el('span', 'apx-bar-lbl', label));
  const t = add(w, el('span', 'apx-bar-track'));
  const f = add(t, el('i'));
  f.style.transform = 'scaleX(' + clamp(num(value, 0), 0, 1).toFixed(3) + ')';
  w._fill = f;
  return w;
}

function setBar(barEl, v) {
  if (barEl && barEl._fill) barEl._fill.style.transform = 'scaleX(' + clamp(num(v, 0), 0, 1).toFixed(3) + ')';
}

function sectionTitle(index, title, sub) {
  const h = el('header', 'apx-sec-head');
  add(h, el('span', 'apx-sec-idx', index));
  const t = add(h, el('div', 'apx-sec-text'));
  add(t, el('h3', 'apx-sec-title', title));
  if (sub) add(t, el('p', 'apx-sec-sub', sub));
  return h;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Factory
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * @param {HTMLElement} root  host element (menus fill it / the viewport)
 * @param {Object} opts { circuits, teams, settings, contained, cssHref, injectCss, version }
 * @returns {Object} menus API
 */
export function createMenus(root, opts) {
  const o = opts || {};
  const host = root && root.appendChild ? root : (typeof document !== 'undefined' ? document.body : null);
  if (!host) throw new Error('createMenus: no DOM root available');

  const circuits = normalizeCircuits(o.circuits);
  const teams = normalizeTeams(o.teams);

  const settings = Object.assign({}, DEFAULT_SETTINGS, o.settings || {});

  const state = {
    screen: null,
    prev: null,
    returnTo: 'title',
    visible: false,
    disposed: false,
    mode: 'quick',
    loadTarget: 0,
    loadShown: 0,
    loadLabel: '',
    loadLabelLocked: false,
    statusIndex: 0,
    px: 0, py: 0, tpx: 0, tpy: 0,
    standings: [],
    resultsMeta: null,
    reduced: false,
  };

  const config = {
    mode: 'quick',
    circuitId: circuits[0].id,
    teamId: teams[0].id,
    driverIndex: 0,
    difficulty: 'pro',
    lapPercent: 10,
    laps: 5,
    weather: 'clear',
    timeOfDay: 15.0,
    tyre: 'medium',
    ersMode: 'balanced',
    brakeBias: 57,
    wingFront: 24,
    wingRear: 27,
  };

  const listeners = new Map();
  const settingsReg = new Map();
  const garageReg = new Map();
  const setupReg = new Map();
  const timers = [];
  let rafId = 0;
  let ro = null;
  let statusTimer = 0;

  try { state.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { state.reduced = false; }

  /* ── event bus ── */
  function on(evt, cb) {
    if (typeof cb !== 'function') return () => {};
    let set = listeners.get(evt);
    if (!set) { set = new Set(); listeners.set(evt, set); }
    set.add(cb);
    return () => { const s = listeners.get(evt); if (s) s.delete(cb); };
  }
  function emit(evt, payload) {
    const set = listeners.get(evt);
    if (!set) return;
    set.forEach((cb) => { try { cb(payload); } catch (e) { /* a bad listener must not kill the UI */ } });
  }

  /* ── stylesheet safety net ── */
  try {
    if (o.injectCss !== false && !document.querySelector('link[data-apx-ui],link[href*="ui.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = o.cssHref || 'styles/ui.css';
      link.setAttribute('data-apx-ui', '1');
      link.addEventListener('error', () => { try { injectFallbackCSS(); } catch (e2) { /* noop */ } });
      document.head.appendChild(link);
    }
  } catch (e) { /* styling is progressive enhancement */ }

  /* ── root scaffold ── */
  const container = el('div', 'apx-menus' + (o.contained ? ' apx-menus--contained' : ''));
  container.setAttribute('data-screen', 'none');
  container.hidden = true;

  const bg = add(container, el('div', 'apx-bg'));
  try {
    add(bg, el('div', 'apx-bg-aurora'));
    add(bg, el('div', 'apx-bg-weave'));
    const lines = add(bg, el('div', 'apx-bg-lines'));
    if (!state.reduced) {
      for (let i = 0; i < 22; i++) {
        const s = add(lines, el('i'));
        s.style.setProperty('--t', (i * 7 + (hashStr('l' + i) % 60)) + '%');
        s.style.setProperty('--d', (2.4 + (hashStr('d' + i) % 900) / 200).toFixed(2) + 's');
        s.style.setProperty('--dl', (-(hashStr('x' + i) % 700) / 100).toFixed(2) + 's');
        s.style.setProperty('--w', (6 + (hashStr('w' + i) % 26)) + 'vw');
        s.style.setProperty('--o', (0.10 + (hashStr('o' + i) % 60) / 130).toFixed(2));
      }
    }
    add(bg, el('div', 'apx-bg-grid'));
    add(bg, el('div', 'apx-bg-vign'));
    add(bg, el('div', 'apx-bg-grain'));
  } catch (e) { /* decorative only */ }

  const veil = add(container, el('div', 'apx-veil'));
  const stack = add(container, el('div', 'apx-stack'));

  host.appendChild(container);

  /* ── screen registry ── */
  const screens = Object.create(null);
  function registerScreen(id, node) {
    node.classList.add('apx-screen');
    node.setAttribute('data-screen-id', id);
    node.setAttribute('role', 'group');
    stack.appendChild(node);
    screens[id] = node;
    return node;
  }

  /* ── keyboard navigation ── */
  function visibleFocusables(scope) {
    const out = [];
    let list;
    try { list = scope.querySelectorAll(FOCUSABLE); } catch (e) { return out; }
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.disabled) continue;
      if (n.tabIndex === -1) continue;
      if (!n.offsetParent && n.style.position !== 'fixed') continue;
      if (n.closest && n.closest('[hidden]')) continue;
      out.push(n);
    }
    return out;
  }

  function navigate(dir) {
    const scr = screens[state.screen];
    if (!scr) return false;
    const items = visibleFocusables(scr);
    if (!items.length) return false;
    const active = document.activeElement;
    if (!active || !scr.contains(active)) { items[0].focus({ preventScroll: false }); return true; }
    const ar = active.getBoundingClientRect();
    const ax = ar.left + ar.width / 2, ay = ar.top + ar.height / 2;
    let best = null, bestScore = Infinity;
    for (let i = 0; i < items.length; i++) {
      const n = items[i];
      if (n === active) continue;
      const r = n.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dx = cx - ax, dy = cy - ay;
      let along, across;
      if (dir === 'down') { along = dy; across = Math.abs(dx); }
      else if (dir === 'up') { along = -dy; across = Math.abs(dx); }
      else if (dir === 'right') { along = dx; across = Math.abs(dy); }
      else { along = -dx; across = Math.abs(dy); }
      if (along < 6) continue;
      const score = along + across * 2.1;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (!best) return false;
    best.focus({ preventScroll: false });
    try { best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* noop */ }
    return true;
  }

  function onKeyDown(ev) {
    if (state.disposed || !state.visible) return;
    const k = ev.key;
    if (k === 'Escape') { ev.preventDefault(); goBack(); return; }
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
      const a = document.activeElement;
      if (a && a.tagName === 'INPUT' && a.type === 'range' && (k === 'ArrowLeft' || k === 'ArrowRight')) return;
      if (a && a.getAttribute && a.getAttribute('role') === 'radio' && (k === 'ArrowLeft' || k === 'ArrowRight')) return;
      const dir = k.slice(5).toLowerCase();
      if (navigate(dir)) ev.preventDefault();
      return;
    }
    if (k === 'Enter' || k === ' ') {
      const a = document.activeElement;
      if (a && a.tagName === 'BUTTON') return;   // native activation
      if (a && a.classList && a.classList.contains('apx-card')) { ev.preventDefault(); a.click(); }
    }
  }

  function goBack() {
    switch (state.screen) {
      case 'setup': show('title'); break;
      case 'garage': show('setup'); break;
      case 'settings': case 'controls': show(state.returnTo || 'title'); break;
      case 'pause': emit('resume'); hide(); break;
      case 'results': break;
      default: break;
    }
  }

  container.addEventListener('keydown', onKeyDown);

  function onPointerMove(ev) {
    if (state.reduced) return;
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    state.tpx = ((ev.clientX / w) - 0.5) * 2;
    state.tpy = ((ev.clientY / h) - 0.5) * 2;
  }
  container.addEventListener('pointermove', onPointerMove, { passive: true });

  /* ══════════════════════════════════════════════════════════════════════════
   * SCREEN — LOADING
   * ════════════════════════════════════════════════════════════════════════*/
  const ui = {};
  try {
    const s = el('section', 'apx-screen--loading');
    const inner = add(s, el('div', 'apx-load'));

    const mark = add(inner, el('div', 'apx-wordmark apx-wordmark--load'));
    const apex = add(mark, el('span', 'apx-wordmark-main'));
    'APEX'.split('').forEach((ch, i) => {
      const c = add(apex, el('span', 'apx-wm-ch', ch));
      c.style.setProperty('--i', String(i));
    });
    add(mark, el('span', 'apx-wordmark-f1', 'F1'));
    add(inner, el('p', 'apx-wordmark-sub', 'Formula Racing Simulator'));

    const barWrap = add(inner, el('div', 'apx-load-bar'));
    const track = add(barWrap, el('div', 'apx-load-track'));
    ui.loadFill = add(track, el('div', 'apx-load-fill'));
    add(ui.loadFill, el('span', 'apx-load-fill-tip'));
    const meta = add(barWrap, el('div', 'apx-load-meta'));
    ui.loadLabel = add(meta, el('span', 'apx-load-status', LOADING_STATUS[0]));
    ui.loadLabel.setAttribute('aria-live', 'polite');
    ui.loadPct = add(meta, el('span', 'apx-load-pct', '0'));
    const pctUnit = el('em', 'apx-pct-unit', '%');
    ui.loadPct.appendChild(pctUnit);

    const ticks = add(barWrap, el('div', 'apx-load-ticks'));
    for (let i = 0; i <= 20; i++) {
      const t = add(ticks, el('i', i % 5 === 0 ? 'is-major' : ''));
      t.style.setProperty('--t', (i * 5) + '%');
    }

    ui.loadHint = add(inner, el('p', 'apx-load-hint', 'Tip · Trail the brake into slow corners to rotate the car without scrubbing the fronts.'));
    registerScreen('loading', s);
  } catch (e) { /* loading screen degrades to nothing */ }

  const LOAD_TIPS = [
    'Trail the brake into slow corners to rotate the car without scrubbing the fronts.',
    'DRS only arms if you are within one second at the detection point.',
    'A softer compound is worth over a second a lap — for about ten laps.',
    'Move brake bias rearward in the wet to stop the fronts locking.',
    'Short-shift out of slow corners on cold tyres to avoid wheelspin.',
    'Rear wing buys you corner speed and costs you the straight. Choose.',
    'Harvest through the twisty sector, deploy where the lap actually gains.',
    'The racing line assist shows braking points — turn it to corners-only when ready.',
  ];

  /* ══════════════════════════════════════════════════════════════════════════
   * SCREEN — TITLE
   * ════════════════════════════════════════════════════════════════════════*/
  try {
    const s = el('section', 'apx-screen--title');
    const inner = add(s, el('div', 'apx-title'));

    const head = add(inner, el('div', 'apx-title-head'));
    add(head, el('p', 'apx-eyebrow', 'Season 01 · Ten constructors · Twenty drivers'));
    const big = add(head, el('h1', 'apx-title-mark'));
    'APEX'.split('').forEach((ch, i) => {
      const c = add(big, el('span', 'apx-kin', ch));
      c.style.setProperty('--i', String(i));
    });
    const f1 = add(big, el('span', 'apx-kin apx-kin--accent', 'F1'));
    f1.style.setProperty('--i', '4');
    add(head, el('p', 'apx-title-tag', 'Every tenth is a decision.'));

    const menu = add(inner, el('nav', 'apx-mainmenu'));
    menu.setAttribute('aria-label', 'Main menu');
    const MENU_ITEMS = [
      { id: 'quick', label: 'Quick Race', sub: 'One circuit, one result', act: () => { config.mode = 'quick'; state.mode = 'quick'; show('setup'); } },
      { id: 'champ', label: 'Championship', sub: 'Run the full season', act: () => { config.mode = 'championship'; state.mode = 'championship'; show('setup'); } },
      { id: 'tt', label: 'Time Trial', sub: 'Empty track, purple sectors', act: () => { config.mode = 'timetrial'; state.mode = 'timetrial'; show('setup'); } },
      { id: 'set', label: 'Settings', sub: 'Graphics, audio, aids', act: () => { state.returnTo = 'title'; show('settings'); } },
      { id: 'ctl', label: 'Controls', sub: 'Keyboard, gamepad, touch', act: () => { state.returnTo = 'title'; show('controls'); } },
    ];
    MENU_ITEMS.forEach((m, i) => {
      const b = add(menu, el('button', 'apx-menu-item'));
      b.type = 'button';
      b.dataset.menu = m.id;
      b.style.setProperty('--i', String(i));
      if (i === 0) b.setAttribute('data-autofocus', '1');
      add(b, el('span', 'apx-menu-idx', pad2(i + 1)));
      const tx = add(b, el('span', 'apx-menu-text'));
      add(tx, el('span', 'apx-menu-label', m.label));
      add(tx, el('span', 'apx-menu-sub', m.sub));
      add(b, el('span', 'apx-menu-chev'));
      b.addEventListener('click', () => { try { m.act(); } catch (e) { /* noop */ } });
    });

    const foot = add(inner, el('div', 'apx-title-foot'));
    add(foot, el('span', 'apx-hint', 'Arrows to move · Enter to select · Esc to go back'));
    add(foot, el('span', 'apx-hint apx-hint--dim', 'APEX F1 ' + (o.version || 'v1.0') + ' · WebGL2'));

    registerScreen('title', s);
  } catch (e) { /* noop */ }

  /* ── selection lookups ── */
  function currentCircuit() { return circuits.find((c) => c.id === config.circuitId) || circuits[0]; }
  function currentTeam() { return teams.find((t) => t.id === config.teamId) || teams[0]; }
  function currentDriver() {
    const t = currentTeam();
    const idx = clamp(config.driverIndex | 0, 0, Math.max(0, t.drivers.length - 1));
    return t.drivers[idx] || t.drivers[0];
  }
  function computedLaps() {
    const full = circuitFullLaps(currentCircuit());
    return Math.max(1, Math.round(full * (num(config.lapPercent, 10) / 100)));
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * SCREEN — SETUP
   * ════════════════════════════════════════════════════════════════════════*/
  try {
    const s = el('section', 'apx-screen--setup apx-scroller');
    const inner = add(s, el('div', 'apx-page'));

    /* Header */
    const hd = add(inner, el('header', 'apx-page-head'));
    const backBtn = add(hd, el('button', 'apx-back'));
    backBtn.type = 'button';
    backBtn.setAttribute('aria-label', 'Back to main menu');
    add(backBtn, el('span', 'apx-back-arrow', '‹'));
    add(backBtn, el('span', null, 'Back'));
    backBtn.addEventListener('click', () => show('title'));
    const hdText = add(hd, el('div', 'apx-page-headtext'));
    ui.setupMode = add(hdText, el('p', 'apx-eyebrow', 'Quick Race'));
    add(hdText, el('h2', 'apx-page-title', 'Race Weekend Setup'));

    const setupCtl = makeControls(setupReg, (key, value) => {
      config[key] = value;
      if (key === 'timeOfDay') updateTimeOfDay();
      refreshSetup();
    });

    /* — 1. Circuit — */
    const secC = add(inner, el('section', 'apx-sec'));
    add(secC, sectionTitle('01', 'Circuit', 'Twenty layouts, each with its own downforce demand'));
    const cgrid = add(secC, el('div', 'apx-grid apx-grid--circuits'));
    ui.circuitCards = [];
    circuits.forEach((c, i) => {
      const card = add(cgrid, el('button', 'apx-card apx-card--circuit'));
      card.type = 'button';
      card.dataset.id = c.id;
      card.style.setProperty('--i', String(i));
      card.setAttribute('aria-pressed', 'false');

      const art = add(card, el('div', 'apx-card-art'));
      add(art, buildTrackSVG(c, { w: 220, h: 132, pad: 16, showSectors: true }));
      add(art, el('span', 'apx-card-badge', String(i + 1).padStart(2, '0')));

      const body = add(card, el('div', 'apx-card-body'));
      add(body, el('h4', 'apx-card-title', circuitName(c)));
      add(body, el('p', 'apx-card-sub', circuitPlace(c) || 'Grand Prix Circuit'));

      const stats = add(body, el('dl', 'apx-statrow'));
      const stat = (k, v) => { add(stats, el('dt', 'apx-lbl', k)); add(stats, el('dd', 'apx-num', v)); };
      stat('Length', (circuitLength(c) / 1000).toFixed(3) + ' km');
      stat('Turns', String(circuitTurns(c)));
      stat('Race', circuitFullLaps(c) + ' laps');

      const rec = add(body, el('div', 'apx-record'));
      add(rec, el('span', 'apx-lbl', 'Lap record'));
      const recTime = lapRecordSeconds(c);
      add(rec, el('span', 'apx-mono', recTime > 0 ? fmtLap(recTime) : fmtLap(baseLapSeconds(c))));
      const holder = lapRecordHolder(c);
      if (holder) add(rec, el('span', 'apx-hint', holder));

      card.addEventListener('click', () => {
        config.circuitId = c.id;
        config.laps = computedLaps();
        refreshSetup();
      });
      ui.circuitCards.push(card);
    });

    /* — 2. Team — */
    const secT = add(inner, el('section', 'apx-sec'));
    add(secT, sectionTitle('02', 'Constructor', 'Chassis pace, reliability and two very different drivers'));
    const tgrid = add(secT, el('div', 'apx-grid apx-grid--teams'));
    ui.teamCards = [];
    teams.forEach((t, i) => {
      const col = teamColors(t);
      const card = add(tgrid, el('button', 'apx-card apx-card--team'));
      card.type = 'button';
      card.dataset.id = t.id;
      card.style.setProperty('--i', String(i));
      card.style.setProperty('--team-primary', col.primary);
      card.style.setProperty('--team-secondary', col.secondary);
      card.style.setProperty('--team-accent', col.accent);
      card.setAttribute('aria-pressed', 'false');

      const swatch = add(card, el('div', 'apx-livery'));
      add(swatch, el('i', 'apx-livery-a'));
      add(swatch, el('i', 'apx-livery-b'));
      add(swatch, el('i', 'apx-livery-c'));
      add(swatch, buildCarSVG(t));

      const body = add(card, el('div', 'apx-card-body'));
      const th = add(body, el('div', 'apx-team-head'));
      add(th, el('span', 'apx-team-short', t.short || (t.name || '').slice(0, 3).toUpperCase()));
      const tt = add(th, el('div'));
      add(tt, el('h4', 'apx-card-title', t.name || t.id));
      add(tt, el('p', 'apx-card-sub', (t.engine ? t.engine + ' · ' : '') + (t.base || '')));

      const perf = add(body, el('div', 'apx-perf'));
      add(perf, bar(num(t.performance, 0.85), 'Pace'));
      add(perf, bar(num(t.reliability, 0.9), 'Reliability'));

      const dl = add(body, el('div', 'apx-team-drivers'));
      (t.drivers || []).forEach((d, di) => {
        const row = add(dl, el('span', 'apx-team-driver'));
        add(row, el('em', 'apx-driver-num', '#' + d.num));
        add(row, el('span', null, d.name));
      });

      if (Array.isArray(t.sponsors) && t.sponsors.length) {
        const sp = add(body, el('div', 'apx-sponsors'));
        t.sponsors.slice(0, 3).forEach((n) => add(sp, el('span', 'apx-sponsor', n)));
      }

      card.addEventListener('click', () => {
        config.teamId = t.id;
        config.driverIndex = 0;
        rebuildDriverPicker();
        refreshSetup();
      });
      ui.teamCards.push(card);
    });

    /* — 3. Driver — */
    const secD = add(inner, el('section', 'apx-sec'));
    add(secD, sectionTitle('03', 'Driver', 'Skill, aggression, consistency and wet-weather craft'));
    ui.driverWrap = add(secD, el('div', 'apx-grid apx-grid--drivers'));

    function rebuildDriverPicker() {
      const wrap = ui.driverWrap;
      if (!wrap) return;
      while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
      const t = currentTeam();
      const col = teamColors(t);
      ui.driverCards = [];
      (t.drivers || []).forEach((d, di) => {
        const card = add(wrap, el('button', 'apx-card apx-card--driver'));
        card.type = 'button';
        card.dataset.idx = String(di);
        card.style.setProperty('--team-accent', col.accent);
        card.style.setProperty('--team-primary', col.primary);
        card.setAttribute('aria-pressed', 'false');

        const hl = add(card, el('div', 'apx-driver-helm'));
        add(hl, buildHelmetSVG(d.helmet));

        const body = add(card, el('div', 'apx-card-body'));
        const nh = add(body, el('div', 'apx-driver-head'));
        add(nh, el('span', 'apx-driver-bignum', String(d.num)));
        const nt = add(nh, el('div'));
        add(nt, el('h4', 'apx-card-title', d.name));
        add(nt, el('p', 'apx-card-sub', (d.short || '') + (d.country ? ' · ' + d.country : '')));

        const st = add(body, el('div', 'apx-driver-stats'));
        add(st, bar(num(d.skill, 0.85), 'Skill'));
        add(st, bar(num(d.aggression, 0.7), 'Aggression'));
        add(st, bar(num(d.consistency, 0.85), 'Consistency'));
        add(st, bar(num(d.wet, 0.85), 'Wet'));

        card.addEventListener('click', () => { config.driverIndex = di; refreshSetup(); });
        ui.driverCards.push(card);
      });
      refreshDriverSelection();
    }
    ui.rebuildDriverPicker = rebuildDriverPicker;

    /* — 4. Session — */
    const secS = add(inner, el('section', 'apx-sec'));
    add(secS, sectionTitle('04', 'Session', 'Difficulty, distance and the sky above it'));
    const panel = add(secS, el('div', 'apx-panel apx-panel--session'));

    /* Difficulty */
    const diffWrap = add(panel, el('div', 'apx-field'));
    add(diffWrap, el('span', 'apx-lbl', 'Difficulty'));
    const diffGrid = add(diffWrap, el('div', 'apx-chips apx-chips--diff'));
    ui.diffChips = [];
    DIFFICULTIES.forEach((d) => {
      const b = add(diffGrid, el('button', 'apx-chip apx-chip--tall'));
      b.type = 'button';
      b.dataset.v = d.id;
      add(b, el('span', 'apx-chip-name', d.name));
      add(b, el('span', 'apx-chip-num', d.pace));
      b.addEventListener('click', () => { config.difficulty = d.id; refreshSetup(); });
      ui.diffChips.push(b);
    });
    ui.diffBlurb = add(diffWrap, el('p', 'apx-ctl-note', DIFFICULTIES[1].blurb));

    /* Race length */
    const lapWrap = add(panel, el('div', 'apx-field'));
    const lapHead = add(lapWrap, el('div', 'apx-ctl-head'));
    add(lapHead, el('span', 'apx-lbl', 'Race length'));
    ui.lapValue = add(lapHead, el('span', 'apx-val', '5 laps'));
    const lapGrid = add(lapWrap, el('div', 'apx-chips'));
    ui.lapChips = [];
    LAP_PRESETS.forEach((p) => {
      const b = add(lapGrid, el('button', 'apx-chip'));
      b.type = 'button';
      b.dataset.v = String(p.pct);
      add(b, el('span', 'apx-chip-name', p.name));
      add(b, el('span', 'apx-chip-sub', p.sub));
      b.addEventListener('click', () => { config.lapPercent = p.pct; refreshSetup(); });
      ui.lapChips.push(b);
    });

    /* Weather */
    const wxWrap = add(panel, el('div', 'apx-field'));
    add(wxWrap, el('span', 'apx-lbl', 'Weather'));
    const wxGrid = add(wxWrap, el('div', 'apx-chips apx-chips--wx'));
    ui.wxChips = [];
    WEATHERS.forEach((w) => {
      const b = add(wxGrid, el('button', 'apx-chip apx-chip--wx'));
      b.type = 'button';
      b.dataset.v = w.id;
      add(b, buildWeatherIcon(w.icon));
      add(b, el('span', 'apx-chip-name', w.name));
      add(b, el('span', 'apx-chip-sub', w.sub));
      b.addEventListener('click', () => { config.weather = w.id; refreshSetup(); });
      ui.wxChips.push(b);
    });

    /* Time of day */
    const todWrap = add(panel, el('div', 'apx-field apx-field--tod'));
    ui.todSky = add(todWrap, el('div', 'apx-sky'));
    ui.todSkySun = add(ui.todSky, el('i', 'apx-sky-sun'));
    add(ui.todSky, el('span', 'apx-sky-horizon'));
    const todCtl = setupCtl.slider('timeOfDay', 'Time of day', 0, 24, 0.25, config.timeOfDay, (v) => fmtClock(v) + ' · ' + daypartName(v));
    add(todWrap, todCtl);

    function updateTimeOfDay() {
      try {
        const h = num(config.timeOfDay, 15);
        if (ui.todSky) ui.todSky.style.background = skyGradient(h);
        if (ui.todSkySun) {
          const t = clamp((h - 5.5) / 13.5, -0.15, 1.15);
          ui.todSkySun.style.left = (clamp(t, 0, 1) * 100).toFixed(1) + '%';
          ui.todSkySun.style.top = (78 - Math.sin(clamp(t, 0, 1) * Math.PI) * 62).toFixed(1) + '%';
          ui.todSkySun.style.opacity = (h > 4.8 && h < 20.6) ? '1' : '0.15';
        }
      } catch (e) { /* noop */ }
    }
    ui.updateTimeOfDay = updateTimeOfDay;

    /* Footer summary */
    const foot = add(inner, el('div', 'apx-setup-foot'));
    const sum = add(foot, el('div', 'apx-summary'));
    function sumItem(label) {
      const w = add(sum, el('div', 'apx-summary-item'));
      add(w, el('span', 'apx-lbl', label));
      const v = add(w, el('strong', 'apx-summary-val', '—'));
      return v;
    }
    ui.sumCircuit = sumItem('Circuit');
    ui.sumTeam = sumItem('Team');
    ui.sumDriver = sumItem('Driver');
    ui.sumLaps = sumItem('Distance');
    ui.sumWx = sumItem('Conditions');

    const acts = add(foot, el('div', 'apx-actions'));
    const skip = add(acts, el('button', 'apx-btn apx-btn--ghost', 'Skip to grid'));
    skip.type = 'button';
    skip.addEventListener('click', () => emit('start', getConfig()));
    const toGarage = add(acts, el('button', 'apx-btn apx-btn--primary'));
    toGarage.type = 'button';
    toGarage.setAttribute('data-autofocus', '1');
    add(toGarage, el('span', null, 'To the garage'));
    add(toGarage, el('span', 'apx-btn-chev', '›'));
    toGarage.addEventListener('click', () => show('garage'));

    registerScreen('setup', s);
    rebuildDriverPicker();
    updateTimeOfDay();
  } catch (e) { /* setup screen failed — other screens still work */ }

  /* ══════════════════════════════════════════════════════════════════════════
   * SCREEN — GARAGE
   * ════════════════════════════════════════════════════════════════════════*/
  try {
    const s = el('section', 'apx-screen--garage');
    const inner = add(s, el('div', 'apx-garage'));

    /* Left: live 3D preview host — intentionally left EMPTY for the caller. */
    const stageCol = add(inner, el('div', 'apx-garage-stage'));
    const stageHead = add(stageCol, el('header', 'apx-page-head apx-page-head--tight'));
    const gBack = add(stageHead, el('button', 'apx-back'));
    gBack.type = 'button';
    add(gBack, el('span', 'apx-back-arrow', '‹'));
    add(gBack, el('span', null, 'Setup'));
    gBack.addEventListener('click', () => show('setup'));
    const gHeadText = add(stageHead, el('div', 'apx-page-headtext'));
    ui.garageTeamLine = add(gHeadText, el('p', 'apx-eyebrow', 'Garage'));
    ui.garageTitle = add(gHeadText, el('h2', 'apx-page-title', 'Car Setup'));

    const preview = add(stageCol, el('div', 'apx-preview'));
    // The caller injects its own <canvas> here. Never touched again by this module.
    ui.preview = add(preview, el('div'));
    ui.preview.id = 'garage-preview';
    ui.preview.className = 'apx-preview-host';
    ui.preview.setAttribute('aria-label', 'Live car preview');

    const overlay = add(preview, el('div', 'apx-preview-overlay'));
    ui.previewNum = add(overlay, el('span', 'apx-preview-num', '—'));
    ui.previewName = add(overlay, el('span', 'apx-preview-name', '—'));
    add(preview, el('span', 'apx-preview-corner apx-preview-corner--tl'));
    add(preview, el('span', 'apx-preview-corner apx-preview-corner--tr'));
    add(preview, el('span', 'apx-preview-corner apx-preview-corner--bl'));
    add(preview, el('span', 'apx-preview-corner apx-preview-corner--br'));

    /* Estimate strip */
    const est = add(stageCol, el('div', 'apx-estimate'));
    const estL = add(est, el('div', 'apx-estimate-main'));
    add(estL, el('span', 'apx-lbl', 'Projected flying lap'));
    ui.estTime = add(estL, el('strong', 'apx-bignum', '—.———'));
    const estR = add(est, el('div', 'apx-estimate-side'));
    ui.estDelta = add(estR, el('span', 'apx-delta', '+0.000'));
    ui.estNote = add(estR, el('span', 'apx-hint', 'vs. baseline setup'));

    const traitWrap = add(stageCol, el('div', 'apx-traits'));
    ui.traitBars = {
      topSpeed: add(traitWrap, bar(0.5, 'Top speed')),
      cornering: add(traitWrap, bar(0.5, 'Cornering')),
      stability: add(traitWrap, bar(0.5, 'Stability')),
      tyreLife: add(traitWrap, bar(0.5, 'Tyre life')),
      energy: add(traitWrap, bar(0.5, 'Energy margin')),
    };

    /* Right: setup controls */
    const panelCol = add(inner, el('div', 'apx-garage-panel apx-scroller'));

    const garageCtl = makeControls(garageReg, (key, value) => {
      config[key] = value;
      refreshGarage();
      emit('garageChanged', { key: key, value: value, config: getConfig() });
    });

    /* Tyres */
    const tyreSec = add(panelCol, el('div', 'apx-panel'));
    add(tyreSec, el('h3', 'apx-panel-title', 'Tyre compound'));
    const tyreGrid = add(tyreSec, el('div', 'apx-tyres'));
    ui.tyreBtns = [];
    Object.keys(TYRE_COMPOUNDS).forEach((k) => {
      const c = TYRE_COMPOUNDS[k];
      const b = add(tyreGrid, el('button', 'apx-tyre'));
      b.type = 'button';
      b.dataset.v = k;
      b.style.setProperty('--tyre', c.color);
      const disc = add(b, el('span', 'apx-tyre-disc'));
      add(disc, el('em', null, c.short));
      add(b, el('span', 'apx-tyre-name', c.name));
      const gripPct = Math.round(num(c.grip, 0.9) * 100);
      add(b, el('span', 'apx-tyre-meta', 'Grip ' + gripPct + ' · Wear ' + num(c.wearRate, 1).toFixed(2) + '×'));
      b.addEventListener('click', () => {
        config.tyre = k;
        refreshGarage();
        emit('garageChanged', { key: 'tyre', value: k, config: getConfig() });
      });
      ui.tyreBtns.push(b);
    });
    ui.tyreNote = add(tyreSec, el('p', 'apx-ctl-note', ''));

    /* ERS */
    const ersSec = add(panelCol, el('div', 'apx-panel'));
    add(ersSec, el('h3', 'apx-panel-title', 'Energy deployment'));
    const ersGrid = add(ersSec, el('div', 'apx-chips apx-chips--ers'));
    ui.ersBtns = [];
    ERS_MODES.forEach((m) => {
      const b = add(ersGrid, el('button', 'apx-chip'));
      b.type = 'button';
      b.dataset.v = m.id;
      add(b, el('span', 'apx-chip-name', m.name));
      add(b, el('span', 'apx-chip-sub', m.sub));
      b.addEventListener('click', () => {
        config.ersMode = m.id;
        refreshGarage();
        emit('garageChanged', { key: 'ersMode', value: m.id, config: getConfig() });
      });
      ui.ersBtns.push(b);
    });

    /* Aero + brakes */
    const aeroSec = add(panelCol, el('div', 'apx-panel'));
    add(aeroSec, el('h3', 'apx-panel-title', 'Aerodynamics & brakes'));
    add(aeroSec, garageCtl.slider('wingFront', 'Front wing', 1, 50, 1, config.wingFront,
      (v) => String(v), 'Higher for front-end bite; too much and the rear steps out.'));
    add(aeroSec, garageCtl.slider('wingRear', 'Rear wing', 1, 50, 1, config.wingRear,
      (v) => String(v), 'Rear downforce buys corner speed and costs top speed.'));
    add(aeroSec, garageCtl.slider('brakeBias', 'Brake bias', 50, 70, 0.5, config.brakeBias,
      (v) => v.toFixed(1) + '% F', 'Forward for stopping power, rearward to save the fronts in the wet.'));
    ui.aeroNote = add(aeroSec, el('p', 'apx-ctl-note', ''));

    /* Circuit reference */
    const refSec = add(panelCol, el('div', 'apx-panel apx-panel--ref'));
    add(refSec, el('h3', 'apx-panel-title', 'Circuit reference'));
    ui.refTrack = add(refSec, el('div', 'apx-ref-track'));
    const refStats = add(refSec, el('dl', 'apx-statrow apx-statrow--wide'));
    function refStat(k) {
      add(refStats, el('dt', 'apx-lbl', k));
      return add(refStats, el('dd', 'apx-num', '—'));
    }
    ui.refName = add(refSec, el('p', 'apx-ref-name', '—'));
    ui.refLength = refStat('Length');
    ui.refTurns = refStat('Turns');
    ui.refLaps = refStat('Laps');
    ui.refDF = refStat('Downforce');

    /* Go */
    const goWrap = add(panelCol, el('div', 'apx-garage-go'));
    const goBtn = add(goWrap, el('button', 'apx-btn apx-btn--primary apx-btn--huge'));
    goBtn.type = 'button';
    goBtn.setAttribute('data-autofocus', '1');
    const lights = add(goBtn, el('span', 'apx-lights'));
    for (let i = 0; i < 5; i++) { const l = add(lights, el('i')); l.style.setProperty('--i', String(i)); }
    add(goBtn, el('span', null, 'Lights out'));
    goBtn.addEventListener('click', () => emit('start', getConfig()));

    registerScreen('garage', s);
  } catch (e) { /* garage optional */ }

  /* ══════════════════════════════════════════════════════════════════════════
   * SCREEN — PAUSE
   * ════════════════════════════════════════════════════════════════════════*/
  try {
    const s = el('section', 'apx-screen--pause');
    const box = add(s, el('div', 'apx-pausebox'));
    add(box, el('p', 'apx-eyebrow', 'Session paused'));
    add(box, el('h2', 'apx-pause-title', 'Box, box.'));
    ui.pauseMeta = add(box, el('p', 'apx-pause-meta', ''));

    const list = add(box, el('div', 'apx-pause-menu'));
    const items = [
      { label: 'Resume', sub: 'Back to the car', primary: true, act: () => { emit('resume'); hide(); } },
      { label: 'Restart', sub: 'Reset to the grid', act: () => { emit('restart'); hide(); } },
      { label: 'Settings', sub: 'Graphics, audio, aids', act: () => { state.returnTo = 'pause'; show('settings'); } },
      { label: 'Controls', sub: 'Remind me of the keys', act: () => { state.returnTo = 'pause'; show('controls'); } },
      { label: 'Quit to menu', sub: 'Abandon the session', danger: true, act: () => { emit('quit'); show('title'); } },
    ];
    items.forEach((it, i) => {
      const b = add(list, el('button', 'apx-menu-item apx-menu-item--compact' + (it.danger ? ' is-danger' : '') + (it.primary ? ' is-primary' : '')));
      b.type = 'button';
      b.style.setProperty('--i', String(i));
      if (it.primary) b.setAttribute('data-autofocus', '1');
      const tx = add(b, el('span', 'apx-menu-text'));
      add(tx, el('span', 'apx-menu-label', it.label));
      add(tx, el('span', 'apx-menu-sub', it.sub));
      add(b, el('span', 'apx-menu-chev'));
      b.addEventListener('click', () => { try { it.act(); } catch (e) { /* noop */ } });
    });
    add(box, el('p', 'apx-hint apx-hint--dim', 'Esc resumes'));
    registerScreen('pause', s);
  } catch (e) { /* noop */ }

  /* ══════════════════════════════════════════════════════════════════════════
   * SCREEN — RESULTS
   * ════════════════════════════════════════════════════════════════════════*/
  try {
    const s = el('section', 'apx-screen--results apx-scroller');
    const inner = add(s, el('div', 'apx-page'));

    const hd = add(inner, el('header', 'apx-page-head'));
    const hdText = add(hd, el('div', 'apx-page-headtext'));
    ui.resEyebrow = add(hdText, el('p', 'apx-eyebrow', 'Race classification'));
    ui.resTitle = add(hdText, el('h2', 'apx-page-title', 'Final Classification'));

    const hero = add(inner, el('div', 'apx-podium'));
    ui.podium = [];
    [1, 0, 2].forEach((slot) => {
      const p = add(hero, el('div', 'apx-podium-step apx-podium-step--' + (slot + 1)));
      p.style.setProperty('--i', String(slot));
      add(p, el('span', 'apx-podium-pos', String(slot + 1)));
      const nm = add(p, el('strong', 'apx-podium-name', '—'));
      const tm = add(p, el('span', 'apx-podium-team', '—'));
      const tmBar = add(p, el('i', 'apx-podium-bar'));
      ui.podium[slot] = { root: p, name: nm, team: tm, bar: tmBar };
    });

    const tableWrap = add(inner, el('div', 'apx-table-wrap'));
    const table = add(tableWrap, el('table', 'apx-table'));
    const thead = add(table, el('thead'));
    const hr = add(thead, el('tr'));
    ['Pos', 'No', 'Driver', 'Constructor', 'Time / Gap', 'Best lap', 'Tyres', 'Pts'].forEach((h, i) => {
      const th = add(hr, el('th', 'apx-th apx-th--' + i, h));
      if (i >= 4) th.classList.add('apx-th--num');
    });
    ui.resBody = add(table, el('tbody'));

    const legend = add(inner, el('div', 'apx-res-legend'));
    add(legend, el('span', 'apx-legend-chip apx-legend-chip--fl', 'Fastest lap'));
    add(legend, el('span', 'apx-hint', 'Purple denotes the fastest lap of the race — worth an extra point inside the top ten.'));

    const acts = add(inner, el('div', 'apx-actions apx-actions--results'));
    const toMenu = add(acts, el('button', 'apx-btn apx-btn--ghost', 'Main menu'));
    toMenu.type = 'button';
    toMenu.addEventListener('click', () => { emit('quit'); show('title'); });
    const again = add(acts, el('button', 'apx-btn apx-btn--ghost', 'Restart race'));
    again.type = 'button';
    again.addEventListener('click', () => { emit('restart'); hide(); });
    const nextBtn = add(acts, el('button', 'apx-btn apx-btn--primary'));
    nextBtn.type = 'button';
    nextBtn.setAttribute('data-autofocus', '1');
    add(nextBtn, el('span', null, 'Next race'));
    add(nextBtn, el('span', 'apx-btn-chev', '›'));
    nextBtn.addEventListener('click', () => emit('nextRace', getConfig()));

    registerScreen('results', s);
  } catch (e) { /* noop */ }

  /* ── results rendering ── */
  function teamById(id) { return teams.find((t) => t.id === id); }

  function rowTeamInfo(r) {
    const t = (r.team && typeof r.team === 'object') ? r.team : teamById(r.teamId || r.team);
    if (t) return { name: t.name || t.id, color: teamColors(t).accent, primary: teamColors(t).primary };
    const nm = r.teamName || r.constructor || (typeof r.team === 'string' ? r.team : '—');
    return { name: nm, color: r.teamColor || r.color || 'var(--apx-accent)', primary: r.teamColor || '#222' };
  }

  function renderStandings() {
    const body = ui.resBody;
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    const rows = state.standings || [];
    let fastestIdx = -1, fastestVal = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const b = num(rows[i].best !== undefined ? rows[i].best : rows[i].bestLap, NaN);
      if (Number.isFinite(b) && b > 0 && b < fastestVal) { fastestVal = b; fastestIdx = i; }
      if (rows[i].fastest === true) fastestIdx = i;
    }

    rows.forEach((r, i) => {
      const tr = add(body, el('tr', 'apx-tr'));
      tr.style.setProperty('--i', String(i));
      const pos = num(r.pos !== undefined ? r.pos : r.position, i + 1);
      if (r.isPlayer) tr.classList.add('is-player');
      const ti = rowTeamInfo(r);
      tr.style.setProperty('--row-team', ti.color);

      add(tr, el('td', 'apx-td apx-td--pos', String(pos)));
      add(tr, el('td', 'apx-td apx-td--no', r.num !== undefined ? String(r.num) : '—'));

      const dtd = add(tr, el('td', 'apx-td apx-td--driver'));
      add(dtd, el('span', 'apx-td-name', r.driver || r.driverName || r.name || '—'));
      if (r.short) add(dtd, el('span', 'apx-td-short', r.short));

      const ttd = add(tr, el('td', 'apx-td apx-td--team'));
      add(ttd, el('i', 'apx-teambar'));
      add(ttd, el('span', null, ti.name));

      let timeTxt = '—';
      if (r.status && String(r.status).toLowerCase() !== 'finished') timeTxt = String(r.status).toUpperCase();
      else if (typeof r.time === 'string') timeTxt = r.time;
      else if (Number.isFinite(num(r.time, NaN)) && pos === 1) timeTxt = fmtLap(r.time);
      else if (Number.isFinite(num(r.gap, NaN))) timeTxt = '+' + num(r.gap, 0).toFixed(3);
      else if (typeof r.gap === 'string') timeTxt = r.gap;
      else if (Number.isFinite(num(r.time, NaN))) timeTxt = fmtLap(r.time);
      add(tr, el('td', 'apx-td apx-td--time apx-mono', timeTxt));

      const bl = num(r.best !== undefined ? r.best : r.bestLap, NaN);
      const btd = add(tr, el('td', 'apx-td apx-td--best apx-mono', Number.isFinite(bl) && bl > 0 ? fmtLap(bl) : '—'));
      if (i === fastestIdx) { btd.classList.add('is-fastest'); tr.classList.add('has-fastest'); }

      const tyd = add(tr, el('td', 'apx-td apx-td--tyres'));
      const used = Array.isArray(r.tyres) ? r.tyres : (Array.isArray(r.tyresUsed) ? r.tyresUsed : []);
      if (used.length) {
        used.slice(0, 6).forEach((k) => {
          const key = String(k).toLowerCase();
          const c = TYRE_COMPOUNDS[key] || TYRE_COMPOUNDS[key[0] === 's' ? 'soft' : 'medium'];
          const short = (c && c.short) || (String(k).charAt(0) || '?').toUpperCase();
          const pill = add(tyd, el('span', 'apx-tyrepill', short));
          pill.style.setProperty('--tyre', (c && c.color) || '#999');
        });
      } else add(tyd, el('span', 'apx-hint', '—'));

      const classified = !r.status || String(r.status).toLowerCase() === 'finished';
      let pts = num(r.points !== undefined ? r.points : r.pts, NaN);
      if (!Number.isFinite(pts)) {
        pts = (classified && pos >= 1 && pos <= POINTS_TABLE.length) ? POINTS_TABLE[pos - 1] : 0;
        if (classified && i === fastestIdx && pos <= 10) pts += 1;
      }
      const ptd = add(tr, el('td', 'apx-td apx-td--pts apx-num', pts > 0 ? String(pts) : '–'));
      if (pts > 0) ptd.classList.add('has-points');
    });

    for (let k = 0; k < 3; k++) {
      const p = ui.podium && ui.podium[k];
      if (!p) continue;
      const r = rows[k];
      if (!r) { p.root.classList.add('is-empty'); setText(p.name, '—'); setText(p.team, '—'); continue; }
      p.root.classList.remove('is-empty');
      const ti = rowTeamInfo(r);
      setText(p.name, r.driver || r.driverName || r.name || '—');
      setText(p.team, ti.name);
      p.bar.style.background = ti.color;
      p.root.style.setProperty('--row-team', ti.color);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * SCREEN — SETTINGS
   * ════════════════════════════════════════════════════════════════════════*/
  try {
    const s = el('section', 'apx-screen--settings apx-scroller');
    const inner = add(s, el('div', 'apx-page'));

    const hd = add(inner, el('header', 'apx-page-head'));
    const back = add(hd, el('button', 'apx-back'));
    back.type = 'button';
    add(back, el('span', 'apx-back-arrow', '‹'));
    add(back, el('span', null, 'Back'));
    back.addEventListener('click', () => show(state.returnTo || 'title'));
    const hdText = add(hd, el('div', 'apx-page-headtext'));
    add(hdText, el('p', 'apx-eyebrow', 'Configuration'));
    add(hdText, el('h2', 'apx-page-title', 'Settings'));

    const sctl = makeControls(settingsReg, (key, value) => {
      settings[key] = value;
      emit('settingChanged', { key: key, value: value });
    });

    const cols = add(inner, el('div', 'apx-settings-grid'));

    /* Graphics */
    const g = add(cols, el('div', 'apx-panel'));
    add(g, el('h3', 'apx-panel-title', 'Graphics'));
    add(g, sctl.seg('quality', 'Quality preset', QUALITY_TIERS, settings.quality, 'Auto profiles your device on the first lap'));
    add(g, sctl.slider('resolutionScale', 'Resolution scale', 0.5, 2, 0.05, settings.resolutionScale,
      (v) => Math.round(v * 100) + '%', 'Render below native and upscale to claw back frames.'));
    add(g, sctl.slider('particles', 'Particle density', 0, 1, 0.05, settings.particles,
      (v) => Math.round(v * 100) + '%', 'Spray, sparks, tyre smoke and marbles.'));
    add(g, sctl.toggle('shadows', 'Shadows', settings.shadows, 'Cascaded shadow maps'));
    add(g, sctl.toggle('postFX', 'Post-processing', settings.postFX, 'Bloom, tonemapping, chromatic edge'));
    add(g, sctl.toggle('reflections', 'Reflections', settings.reflections, 'Screen-space bodywork and wet tarmac'));
    add(g, sctl.toggle('motionBlur', 'Motion blur', settings.motionBlur, 'Per-object velocity blur'));
    add(g, sctl.toggle('showFps', 'Performance counter', settings.showFps, 'Frame time overlay'));

    /* Camera & display */
    const d = add(cols, el('div', 'apx-panel'));
    add(d, el('h3', 'apx-panel-title', 'Camera & display'));
    add(d, sctl.seg('cameraMode', 'Default camera', CAMERA_MODES, settings.cameraMode));
    add(d, sctl.slider('fov', 'Field of view', 40, 115, 1, settings.fov,
      (v) => Math.round(v) + '°', 'Wider reads speed better; narrower helps you place the car.'));
    add(d, sctl.seg('units', 'Units', [{ v: 'kmh', t: 'km/h' }, { v: 'mph', t: 'mph' }], settings.units));

    /* Audio */
    const a = add(cols, el('div', 'apx-panel'));
    add(a, el('h3', 'apx-panel-title', 'Audio'));
    add(a, sctl.slider('volumeMaster', 'Master volume', 0, 1, 0.01, settings.volumeMaster, (v) => Math.round(v * 100) + ''));
    add(a, sctl.slider('volumeEngine', 'Engine volume', 0, 1, 0.01, settings.volumeEngine, (v) => Math.round(v * 100) + ''));
    add(a, sctl.slider('volumeUI', 'Interface volume', 0, 1, 0.01, settings.volumeUI, (v) => Math.round(v * 100) + ''));

    /* Driving aids */
    const aid = add(cols, el('div', 'apx-panel'));
    add(aid, el('h3', 'apx-panel-title', 'Driving aids'));
    add(aid, sctl.seg('tractionControl', 'Traction control',
      [{ v: 'off', t: 'Off' }, { v: 'medium', t: 'Medium' }, { v: 'full', t: 'Full' }], settings.tractionControl,
      'Cuts torque when the rears light up'));
    add(aid, sctl.seg('racingLine', 'Racing line',
      [{ v: 'off', t: 'Off' }, { v: 'corners', t: 'Corners' }, { v: 'full', t: 'Full' }], settings.racingLine,
      'Braking markers and the ideal line'));
    add(aid, sctl.toggle('abs', 'Anti-lock brakes', settings.abs, 'Stops the fronts flat-spotting'));
    add(aid, sctl.toggle('autoGearbox', 'Automatic gearbox', settings.autoGearbox, 'Shifts for you at the limiter'));
    add(aid, sctl.slider('steerSensitivity', 'Steering sensitivity', 0.3, 2, 0.05, settings.steerSensitivity,
      (v) => v.toFixed(2) + '×', 'Applies to keyboard, gamepad and touch.'));

    registerScreen('settings', s);
  } catch (e) { /* noop */ }

  /* ══════════════════════════════════════════════════════════════════════════
   * SCREEN — CONTROLS
   * ════════════════════════════════════════════════════════════════════════*/
  try {
    const s = el('section', 'apx-screen--controls apx-scroller');
    const inner = add(s, el('div', 'apx-page'));

    const hd = add(inner, el('header', 'apx-page-head'));
    const back = add(hd, el('button', 'apx-back'));
    back.type = 'button';
    add(back, el('span', 'apx-back-arrow', '‹'));
    add(back, el('span', null, 'Back'));
    back.addEventListener('click', () => show(state.returnTo || 'title'));
    const hdText = add(hd, el('div', 'apx-page-headtext'));
    add(hdText, el('p', 'apx-eyebrow', 'Input reference'));
    add(hdText, el('h2', 'apx-page-title', 'Controls'));

    const cctl = makeControls(settingsReg, (key, value) => {
      settings[key] = value;
      emit('settingChanged', { key: key, value: value });
      if (key === 'touchLayout') updateTouchBlurb(value);
    });

    /* Keyboard */
    const kb = add(inner, el('div', 'apx-panel'));
    add(kb, el('h3', 'apx-panel-title', 'Keyboard'));
    const board = add(kb, el('div', 'apx-keyboard'));
    KEYMAP_ROWS.forEach((row) => {
      const r = add(board, el('div', 'apx-krow'));
      row.forEach((k) => {
        const key = add(r, el('span', 'apx-key' + (k.act ? ' is-act apx-key--' + k.act : ''), k.k));
        key.style.setProperty('--w', String(k.w || 1));
      });
    });
    const arrows = add(kb, el('div', 'apx-arrows'));
    add(arrows, el('span', 'apx-key is-act apx-key--drive apx-key--up', '↑'));
    const arrowRow = add(arrows, el('div', 'apx-krow'));
    add(arrowRow, el('span', 'apx-key is-act apx-key--drive', '←'));
    add(arrowRow, el('span', 'apx-key is-act apx-key--drive', '↓'));
    add(arrowRow, el('span', 'apx-key is-act apx-key--drive', '→'));

    const legend = add(kb, el('div', 'apx-key-legend'));
    [['drive', 'Driving'], ['gear', 'Gearbox'], ['sys', 'Car systems'], ['ers', 'ERS modes'], ['cam', 'Camera'], ['ui', 'Interface'], ['pause', 'Session']]
      .forEach((p) => {
        const c = add(legend, el('span', 'apx-legend-item'));
        add(c, el('i', 'apx-legend-dot apx-key--' + p[0]));
        add(c, el('span', null, p[1]));
      });

    const bindList = add(kb, el('dl', 'apx-bindings'));
    KEY_BINDINGS.forEach((b) => {
      const dt = add(bindList, el('dt', 'apx-binding-key apx-key--' + b.act, b.keys));
      const dd = add(bindList, el('dd', 'apx-binding-desc'));
      add(dd, el('strong', null, b.label));
      add(dd, el('span', 'apx-hint', b.note));
    });

    /* Gamepad */
    const gp = add(inner, el('div', 'apx-panel'));
    add(gp, el('h3', 'apx-panel-title', 'Gamepad'));
    const padSvg = sv('svg', { class: 'apx-pad', viewBox: '0 0 460 236', 'aria-label': 'Gamepad layout' });
    try {
      add(padSvg, sv('rect', { x: 132, y: 30, width: 30, height: 16, rx: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, opacity: 0.75 }));
      add(padSvg, sv('rect', { x: 306, y: 30, width: 30, height: 16, rx: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, opacity: 0.75 }));
      add(padSvg, sv('path', {
        d: 'M180,54 C150,54 132,72 126,100 L108,164 C100,192 118,212 142,212 C160,212 172,200 180,186 L192,164 L276,164 L288,186 C296,200 308,212 326,212 C350,212 368,192 360,164 L342,100 C336,72 318,54 288,54 Z',
        fill: 'rgba(255,255,255,0.035)', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round',
      }));
      add(padSvg, sv('circle', { cx: 168, cy: 112, r: 19, fill: 'rgba(255,255,255,0.05)', stroke: 'currentColor', 'stroke-width': 1.5 }));
      add(padSvg, sv('circle', { cx: 168, cy: 112, r: 8, fill: 'currentColor', opacity: 0.5 }));
      add(padSvg, sv('circle', { cx: 262, cy: 152, r: 17, fill: 'rgba(255,255,255,0.05)', stroke: 'currentColor', 'stroke-width': 1.5 }));
      add(padSvg, sv('circle', { cx: 262, cy: 152, r: 7, fill: 'currentColor', opacity: 0.5 }));
      add(padSvg, sv('path', { d: 'M194,142 h12 v-12 h12 v12 h12 v12 h-12 v12 h-12 v-12 h-12 z', transform: 'translate(-6,2)', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
      [[300, 92, 'Y'], [318, 110, 'B'], [282, 110, 'X'], [300, 128, 'A']].forEach((b) => {
        add(padSvg, sv('circle', { cx: b[0], cy: b[1], r: 9, fill: 'rgba(255,255,255,0.05)', stroke: 'currentColor', 'stroke-width': 1.4 }));
        const t = add(padSvg, sv('text', { x: b[0], y: b[1] + 3.6, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': '9', 'font-weight': '700' }));
        t.textContent = b[2];
      });
      add(padSvg, sv('circle', { cx: 217, cy: 100, r: 5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }));
      add(padSvg, sv('circle', { cx: 243, cy: 100, r: 5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }));

      PAD_MAP.forEach((m) => {
        const lx = m.side === 'l' ? 12 : 448;
        const anchor = m.side === 'l' ? 'start' : 'end';
        const elbowX = m.side === 'l' ? 96 : 372;
        add(padSvg, sv('polyline', {
          points: m.x + ',' + m.y + ' ' + elbowX + ',' + m.ly + ' ' + (m.side === 'l' ? lx + 4 : lx - 4) + ',' + m.ly,
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1, opacity: 0.32, 'stroke-linejoin': 'round',
        }));
        const t1 = add(padSvg, sv('text', { x: lx, y: m.ly - 3, 'text-anchor': anchor, class: 'apx-pad-t' }));
        t1.textContent = m.t;
        const t2 = add(padSvg, sv('text', { x: lx, y: m.ly + 9, 'text-anchor': anchor, class: 'apx-pad-s' }));
        t2.textContent = m.s;
      });
    } catch (e) { /* diagram degrades */ }
    add(gp, padSvg);
    add(gp, el('p', 'apx-ctl-note', 'Any XInput or standard-mapping controller is detected automatically. Triggers are read as analogue axes, so throttle and brake are fully progressive. Rumble follows kerb strikes, lock-ups and wheelspin.'));

    /* Touch */
    const tc = add(inner, el('div', 'apx-panel'));
    add(tc, el('h3', 'apx-panel-title', 'Touch'));
    add(tc, cctl.seg('touchLayout', 'Layout', TOUCH_LAYOUTS.map((t) => ({ v: t.id, t: t.name })), settings.touchLayout));
    const touchDemo = add(tc, el('div', 'apx-touchdemo'));
    ui.touchStage = add(touchDemo, el('div', 'apx-touch-stage'));
    ui.touchLeft = add(ui.touchStage, el('div', 'apx-touch-zone apx-touch-zone--l'));
    ui.touchRight = add(ui.touchStage, el('div', 'apx-touch-zone apx-touch-zone--r'));
    add(ui.touchRight, el('span', 'apx-touch-pad apx-touch-pad--throttle', 'THR'));
    add(ui.touchRight, el('span', 'apx-touch-pad apx-touch-pad--brake', 'BRK'));
    ui.touchBlurb = add(tc, el('p', 'apx-ctl-note', TOUCH_LAYOUTS[0].blurb));
    add(tc, cctl.slider('steerSensitivity', 'Steering sensitivity', 0.3, 2, 0.05, settings.steerSensitivity,
      (v) => v.toFixed(2) + '×', 'Lower is calmer at speed; higher gives quicker hands in slow corners.'));
    add(tc, el('p', 'apx-ctl-note', 'A DRS button appears on the right rail only while a zone is armed. Swipe down anywhere with two fingers to open the pit menu.'));

    function updateTouchBlurb(v) {
      const layout = TOUCH_LAYOUTS.find((t) => t.id === v) || TOUCH_LAYOUTS[0];
      setText(ui.touchBlurb, layout.blurb);
      if (ui.touchStage) ui.touchStage.setAttribute('data-layout', layout.id);
      if (ui.touchLeft) {
        while (ui.touchLeft.firstChild) ui.touchLeft.removeChild(ui.touchLeft.firstChild);
        if (layout.id === 'wheel') add(ui.touchLeft, el('span', 'apx-touch-wheel'));
        else if (layout.id === 'buttons') {
          add(ui.touchLeft, el('span', 'apx-touch-pad apx-touch-pad--left', '◀'));
          add(ui.touchLeft, el('span', 'apx-touch-pad apx-touch-pad--right', '▶'));
        } else add(ui.touchLeft, el('span', 'apx-touch-tilt', 'TILT'));
      }
    }
    ui.updateTouchBlurb = updateTouchBlurb;
    updateTouchBlurb(settings.touchLayout);

    registerScreen('controls', s);
  } catch (e) { /* noop */ }

  /* ══════════════════════════════════════════════════════════════════════════
   * SCREEN — ERROR
   * ════════════════════════════════════════════════════════════════════════*/
  try {
    const s = el('section', 'apx-screen--error');
    const box = add(s, el('div', 'apx-errbox'));
    add(box, el('div', 'apx-err-flag'));
    add(box, el('p', 'apx-eyebrow', 'Session stopped'));
    add(box, el('h2', 'apx-err-title', 'Red flag'));
    ui.errMsg = add(box, el('p', 'apx-err-msg', 'Something went wrong while building the session.'));
    const det = add(box, el('details', 'apx-err-details'));
    add(det, el('summary', null, 'Technical detail'));
    ui.errDetail = add(det, el('pre', 'apx-err-pre', ''));
    const acts = add(box, el('div', 'apx-actions'));
    const menuBtn = add(acts, el('button', 'apx-btn apx-btn--ghost', 'Main menu'));
    menuBtn.type = 'button';
    menuBtn.addEventListener('click', () => { emit('quit'); show('title'); });
    const rl = add(acts, el('button', 'apx-btn apx-btn--primary', 'Reload'));
    rl.type = 'button';
    rl.setAttribute('data-autofocus', '1');
    rl.addEventListener('click', () => { try { window.location.reload(); } catch (e) { /* noop */ } });
    registerScreen('error', s);
  } catch (e) { /* noop */ }

  /* ══════════════════════════════════════════════════════════════════════════
   * REFRESH / SYNC
   * ════════════════════════════════════════════════════════════════════════*/

  function markSelected(list, matchFn) {
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const on = !!matchFn(list[i], i);
      list[i].classList.toggle('is-on', on);
      list[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function refreshDriverSelection() {
    markSelected(ui.driverCards, (b) => (b.dataset.idx | 0) === (config.driverIndex | 0));
  }

  function refreshSetup() {
    try {
      config.laps = computedLaps();
      markSelected(ui.circuitCards, (b) => b.dataset.id === config.circuitId);
      markSelected(ui.teamCards, (b) => b.dataset.id === config.teamId);
      refreshDriverSelection();
      markSelected(ui.diffChips, (b) => b.dataset.v === config.difficulty);
      markSelected(ui.lapChips, (b) => (+b.dataset.v) === num(config.lapPercent, 10));
      markSelected(ui.wxChips, (b) => b.dataset.v === config.weather);

      const diff = DIFFICULTIES.find((d) => d.id === config.difficulty) || DIFFICULTIES[1];
      setText(ui.diffBlurb, diff.blurb);

      const c = currentCircuit(), t = currentTeam(), d = currentDriver();
      const full = circuitFullLaps(c);
      setText(ui.lapValue, config.laps + ' of ' + full + ' laps · ' + ((circuitLength(c) * config.laps) / 1000).toFixed(1) + ' km');
      setText(ui.sumCircuit, circuitName(c));
      setText(ui.sumTeam, t.name || t.id);
      setText(ui.sumDriver, (d ? d.name : '—'));
      setText(ui.sumLaps, config.laps + ' laps');
      const wx = WEATHERS.find((w) => w.id === config.weather) || WEATHERS[0];
      setText(ui.sumWx, wx.name + ' · ' + fmtClock(config.timeOfDay));
      setText(ui.setupMode, config.mode === 'championship' ? 'Championship — Round 1'
        : config.mode === 'timetrial' ? 'Time Trial' : 'Quick Race');
      if (ui.updateTimeOfDay) ui.updateTimeOfDay();
      refreshGarage();
    } catch (e) { /* keep the UI alive */ }
  }

  function refreshGarage() {
    try {
      const c = currentCircuit(), t = currentTeam(), d = currentDriver();
      const col = teamColors(t);

      markSelected(ui.tyreBtns, (b) => b.dataset.v === config.tyre);
      markSelected(ui.ersBtns, (b) => b.dataset.v === config.ersMode);

      const scr = screens.garage;
      if (scr) {
        scr.style.setProperty('--team-primary', col.primary);
        scr.style.setProperty('--team-accent', col.accent);
        scr.style.setProperty('--team-secondary', col.secondary);
      }
      setText(ui.garageTeamLine, (t.name || '') + ' · ' + (t.engine || 'Power unit'));
      setText(ui.garageTitle, 'Car Setup');
      setText(ui.previewNum, d ? String(d.num) : '—');
      setText(ui.previewName, d ? d.name : '—');

      const lap = lapModel(config, c, t, d);
      const ref = referenceLap(config, c, t, d);
      setText(ui.estTime, fmtLap(lap));
      const delta = lap - ref;
      setText(ui.estDelta, fmtDelta(delta));
      if (ui.estDelta) {
        ui.estDelta.classList.toggle('is-good', delta < -0.005);
        ui.estDelta.classList.toggle('is-bad', delta > 0.005);
      }
      const comp = TYRE_COMPOUNDS[config.tyre] || TYRE_COMPOUNDS.medium;
      setText(ui.estNote, 'on ' + comp.name.toLowerCase() + ' vs. baseline setup');

      const tr = setupTraits(config);
      if (ui.traitBars) {
        setBar(ui.traitBars.topSpeed, tr.topSpeed);
        setBar(ui.traitBars.cornering, tr.cornering);
        setBar(ui.traitBars.stability, tr.stability);
        setBar(ui.traitBars.tyreLife, tr.tyreLife);
        setBar(ui.traitBars.energy, tr.energy);
      }

      const stintLaps = Math.max(1, Math.round(28 / Math.max(0.35, num(comp.wearRate, 1)) * (1 - (config.wingFront + config.wingRear) / 320)));
      setText(ui.tyreNote, comp.name + ' · optimum ' + num(comp.optimalTemp, 100) + '°C ±' + num(comp.tempWindow, 25)
        + ' · roughly ' + stintLaps + ' representative laps before the cliff.');

      const target = circuitDownforceTarget(c);
      const total = num(config.wingFront, 25) + num(config.wingRear, 25);
      const diffDF = total - target;
      setText(ui.aeroNote, 'This layout asks for about ' + Math.round(target) + ' total downforce. You are running '
        + Math.round(total) + ' — ' + (Math.abs(diffDF) < 3 ? 'right in the window.'
          : diffDF > 0 ? 'draggy on the straights.' : 'quick in a straight line, nervous through the corners.'));

      if (ui.refTrack && ui.refTrack.dataset.cid !== c.id) {
        while (ui.refTrack.firstChild) ui.refTrack.removeChild(ui.refTrack.firstChild);
        ui.refTrack.appendChild(buildTrackSVG(c, { w: 240, h: 150, pad: 16, showSectors: true }));
        ui.refTrack.dataset.cid = c.id;
      }
      setText(ui.refName, circuitName(c));
      setText(ui.refLength, (circuitLength(c) / 1000).toFixed(3) + ' km');
      setText(ui.refTurns, String(circuitTurns(c)));
      setText(ui.refLaps, String(config.laps));
      setText(ui.refDF, Math.round(target) + ' pts');
    } catch (e) { /* keep the UI alive */ }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * ANIMATION TICK (loading easing + background parallax only)
   * ════════════════════════════════════════════════════════════════════════*/
  function tick() {
    if (state.disposed) { rafId = 0; return; }
    rafId = requestAnimationFrame(tick);

    if (!state.reduced) {
      state.px += (state.tpx - state.px) * 0.06;
      state.py += (state.tpy - state.py) * 0.06;
      bg.style.setProperty('--px', state.px.toFixed(4));
      bg.style.setProperty('--py', state.py.toFixed(4));
    }

    if (state.screen === 'loading') {
      const d = state.loadTarget - state.loadShown;
      state.loadShown += d * (state.reduced ? 1 : 0.12);
      if (Math.abs(state.loadTarget - state.loadShown) < 0.0008) state.loadShown = state.loadTarget;
      const p = clamp(state.loadShown, 0, 1);
      if (ui.loadFill) ui.loadFill.style.transform = 'scaleX(' + p.toFixed(4) + ')';
      const whole = Math.round(p * 100);
      if (ui.loadPct && ui.loadPct.firstChild && ui.loadPct.firstChild.nodeValue !== String(whole)) {
        ui.loadPct.firstChild.nodeValue = String(whole);
      }
    } else if (state.screen !== 'title') {
      stopTickIfIdle();
    }
  }

  function startTick() {
    if (state.disposed || rafId) return;
    rafId = requestAnimationFrame(tick);
  }
  function stopTickIfIdle() {
    if (state.screen === 'loading' || state.screen === 'title') return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }
  function stopTick() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  function startStatusRotation() {
    stopStatusRotation();
    if (state.reduced) return;
    statusTimer = setInterval(() => {
      if (state.loadLabelLocked || state.screen !== 'loading') return;
      state.statusIndex = (state.statusIndex + 1) % LOADING_STATUS.length;
      if (ui.loadLabel) {
        ui.loadLabel.classList.remove('is-in');
        setText(ui.loadLabel, LOADING_STATUS[state.statusIndex]);
        void ui.loadLabel.offsetWidth;
        ui.loadLabel.classList.add('is-in');
      }
      if (ui.loadHint && state.statusIndex % 3 === 0) {
        setText(ui.loadHint, 'Tip · ' + LOAD_TIPS[(state.statusIndex / 3 | 0) % LOAD_TIPS.length]);
      }
    }, 1900);
    timers.push(statusTimer);
  }
  function stopStatusRotation() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = 0; }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * SHOW / HIDE
   * ════════════════════════════════════════════════════════════════════════*/
  function applyScreenData(id, data) {
    if (!data) return;
    try {
      if (id === 'error') {
        const msg = (typeof data === 'string') ? data
          : (data.message || (data.error && data.error.message) || 'Unknown failure.');
        setText(ui.errMsg, msg);
        const detail = data.detail || data.stack || (data.error && data.error.stack) || '';
        if (ui.errDetail) {
          setText(ui.errDetail, String(detail || 'No further detail available.'));
          const det = ui.errDetail.parentNode;
          if (det) det.hidden = !detail;
        }
      } else if (id === 'results') {
        state.resultsMeta = data;
        const rows = data.rows || data.classification || data.standings || data.results;
        if (Array.isArray(rows)) state.standings = rows.slice();
        setText(ui.resTitle, data.title || 'Final Classification');
        const bits = [];
        if (data.circuitName) bits.push(data.circuitName);
        else bits.push(circuitName(currentCircuit()));
        if (data.laps) bits.push(data.laps + ' laps');
        else bits.push(config.laps + ' laps');
        if (data.round) bits.push('Round ' + data.round);
        setText(ui.resEyebrow, bits.join(' · '));
        renderStandings();
      } else if (id === 'pause') {
        const bits = [];
        if (data.lap && data.totalLaps) bits.push('Lap ' + data.lap + ' / ' + data.totalLaps);
        if (data.position) bits.push('P' + data.position);
        if (data.circuitName) bits.push(data.circuitName);
        if (typeof data.message === 'string') bits.push(data.message);
        setText(ui.pauseMeta, bits.length ? bits.join('  ·  ') : (circuitName(currentCircuit()) + '  ·  ' + config.laps + ' laps'));
      } else if (id === 'loading') {
        if (typeof data.label === 'string') setLoadingProgress(state.loadTarget, data.label);
        if (typeof data.progress === 'number') setLoadingProgress(data.progress, data.label);
      }
    } catch (e) { /* data shape tolerated */ }
  }

  function show(screenId, data) {
    if (state.disposed) return;
    let id = String(screenId || '').toLowerCase();
    if (SCREEN_IDS.indexOf(id) === -1 || !screens[id]) id = screens.title ? 'title' : SCREEN_IDS.find((k) => screens[k]);
    if (!id) return;

    if (state.screen !== id) state.prev = state.screen;

    for (let i = 0; i < SCREEN_IDS.length; i++) {
      const k = SCREEN_IDS[i];
      const n = screens[k];
      if (!n) continue;
      const on = (k === id);
      n.classList.toggle('is-active', on);
      n.setAttribute('aria-hidden', on ? 'false' : 'true');
      if (!on) n.scrollTop = 0;
    }

    state.screen = id;
    state.visible = true;
    container.hidden = false;
    container.setAttribute('data-screen', id);
    container.classList.toggle('is-overlay', id === 'pause');

    applyScreenData(id, data);

    if (id === 'setup' || id === 'garage') refreshSetup();
    if (id === 'results' && !state.standings.length) { try { renderStandings(); } catch (e) { /* noop */ } }

    if (id === 'loading') { startStatusRotation(); } else { stopStatusRotation(); }
    if (id === 'loading' || id === 'title') startTick(); else stopTick();

    if (id === 'pause') emit('pause');
    if (id === 'settings') emit('settings');

    // Move focus after layout so scroll anchoring behaves.
    try {
      const target = screens[id].querySelector('[data-autofocus]') || visibleFocusables(screens[id])[0];
      if (target) {
        const t = setTimeout(() => { try { target.focus({ preventScroll: true }); } catch (e) { /* noop */ } }, 30);
        timers.push(t);
      }
    } catch (e) { /* noop */ }

    resize();
  }

  function hide() {
    if (state.disposed) return;
    state.visible = false;
    state.screen = null;
    container.hidden = true;
    container.classList.remove('is-overlay');
    container.setAttribute('data-screen', 'none');
    for (let i = 0; i < SCREEN_IDS.length; i++) {
      const n = screens[SCREEN_IDS[i]];
      if (n) { n.classList.remove('is-active'); n.setAttribute('aria-hidden', 'true'); }
    }
    stopStatusRotation();
    stopTick();
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * PUBLIC API
   * ════════════════════════════════════════════════════════════════════════*/
  function setLoadingProgress(p01, label) {
    if (state.disposed) return;
    const p = clamp(num(p01, 0), 0, 1);
    state.loadTarget = p;
    if (typeof label === 'string' && label.length) {
      state.loadLabelLocked = true;
      state.loadLabel = label;
      if (ui.loadLabel) {
        ui.loadLabel.classList.remove('is-in');
        setText(ui.loadLabel, label.toUpperCase());
        try { void ui.loadLabel.offsetWidth; } catch (e) { /* noop */ }
        ui.loadLabel.classList.add('is-in');
      }
    }
    if (state.reduced && ui.loadFill) {
      state.loadShown = p;
      ui.loadFill.style.transform = 'scaleX(' + p.toFixed(4) + ')';
      if (ui.loadPct && ui.loadPct.firstChild) ui.loadPct.firstChild.nodeValue = String(Math.round(p * 100));
    }
    if (state.screen === 'loading') startTick();
  }

  function updateSettings(obj) {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach((k) => {
      settings[k] = obj[k];
      const setter = settingsReg.get(k);
      if (setter) { try { setter(obj[k]); } catch (e) { /* noop */ } }
    });
    if (ui.updateTouchBlurb && obj.touchLayout !== undefined) {
      try { ui.updateTouchBlurb(obj.touchLayout); } catch (e) { /* noop */ }
    }
  }

  function setStandings(rows) {
    state.standings = Array.isArray(rows) ? rows.slice() : [];
    try { renderStandings(); } catch (e) { /* noop */ }
  }

  function getConfig() {
    const c = currentCircuit(), t = currentTeam(), d = currentDriver();
    return {
      circuitId: c ? c.id : null,
      teamId: t ? t.id : null,
      driverIndex: clamp(config.driverIndex | 0, 0, Math.max(0, (t && t.drivers ? t.drivers.length : 1) - 1)),
      difficulty: config.difficulty,
      laps: computedLaps(),
      weather: config.weather,
      timeOfDay: num(config.timeOfDay, 15),
      tyre: config.tyre,
      ersMode: config.ersMode,
      brakeBias: num(config.brakeBias, 57),
      wingFront: num(config.wingFront, 25) | 0,
      wingRear: num(config.wingRear, 25) | 0,
      // extras — safe for callers to ignore
      mode: config.mode,
      lapPercent: num(config.lapPercent, 10),
      totalRaceLaps: circuitFullLaps(c),
      driverNumber: d ? d.num : null,
      driverName: d ? d.name : null,
      teamName: t ? t.name : null,
      circuitName: circuitName(c),
      estimatedLap: lapModel(config, c, t, d),
    };
  }

  function resize() {
    if (state.disposed) return;
    try {
      const w = container.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1024);
      const h = container.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 768);
      container.style.setProperty('--apx-vh', (h * 0.01).toFixed(3) + 'px');
      container.classList.toggle('is-narrow', w < 760);
      container.classList.toggle('is-tiny', w < 430);
      container.classList.toggle('is-short', h < 620);
      const ranges = container.querySelectorAll('input.apx-range');
      for (let i = 0; i < ranges.length; i++) syncRange(ranges[i]);
    } catch (e) { /* noop */ }
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    stopTick();
    stopStatusRotation();
    for (let i = 0; i < timers.length; i++) { clearTimeout(timers[i]); clearInterval(timers[i]); }
    timers.length = 0;
    try { container.removeEventListener('keydown', onKeyDown); } catch (e) { /* noop */ }
    try { container.removeEventListener('pointermove', onPointerMove); } catch (e) { /* noop */ }
    try { if (ro) { ro.disconnect(); ro = null; } } catch (e) { /* noop */ }
    try { if (container.parentNode) container.parentNode.removeChild(container); } catch (e) { /* noop */ }
    listeners.clear();
    settingsReg.clear();
    garageReg.clear();
    setupReg.clear();
    for (const k in screens) delete screens[k];
    for (const k in ui) delete ui[k];
  }

  try {
    if (typeof ResizeObserver !== 'undefined') {
      let pending = false;
      ro = new ResizeObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; resize(); });
      });
      ro.observe(container);
    }
  } catch (e) { ro = null; }

  /* Initial paint */
  try { refreshSetup(); } catch (e) { /* noop */ }
  resize();

  const api = {
    show: show,
    hide: hide,
    setLoadingProgress: setLoadingProgress,
    on: on,
    updateSettings: updateSettings,
    setStandings: setStandings,
    getConfig: getConfig,
    dispose: dispose,
    resize: resize,
    // extras
    root: container,
    garagePreview: ui.preview || null,
  };
  Object.defineProperty(api, 'current', { get() { return state.screen; }, enumerable: true });
  Object.defineProperty(api, 'settings', { get() { return Object.assign({}, settings); }, enumerable: false });

  return api;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Emergency stylesheet — only injected if styles/ui.css cannot be loaded.
 * ──────────────────────────────────────────────────────────────────────────*/
function injectFallbackCSS() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('apx-fallback-css')) return;
  const s = document.createElement('style');
  s.id = 'apx-fallback-css';
  s.textContent = [
    '.apx-menus{position:fixed;inset:0;z-index:50;color:#f2f4f8;font-family:ui-sans-serif,system-ui,sans-serif;background:#05060a}',
    '.apx-menus[hidden]{display:none}',
    '.apx-menus--contained{position:absolute}',
    '.apx-stack{position:absolute;inset:0}',
    '.apx-screen{position:absolute;inset:0;display:none;overflow:auto;padding:24px}',
    '.apx-screen.is-active{display:block}',
    '.apx-btn,.apx-menu-item,.apx-card,.apx-chip,.apx-seg-btn,.apx-tyre{min-height:44px;background:#12151d;color:inherit;border:1px solid #2a2f3a;cursor:pointer}',
    '.apx-btn--primary{background:#ff2d20;color:#fff;font-weight:700}',
    '.apx-card.is-on,.apx-chip.is-on,.apx-seg-btn.is-on,.apx-tyre.is-on{outline:2px solid #ff2d20}',
    '.apx-bg,.apx-veil{display:none}',
    '.apx-table{width:100%;border-collapse:collapse}',
    '.apx-td,.apx-th{padding:8px;border-bottom:1px solid #232833;text-align:left}',
  ].join('\n');
  document.head.appendChild(s);
}

export { TYRE_COMPOUNDS };
export default createMenus;

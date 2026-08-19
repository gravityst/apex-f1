/**
 * APEX F1 — Unified input.
 *
 * Keyboard, gamepad and touch all resolve into one normalised state object.
 * Touch offers three steering layouts (relative drag, on-screen wheel, tilt)
 * plus an assisted-throttle mode that makes the game genuinely playable
 * one-thumbed on a phone.
 */
import * as THREE from 'three';

const KEYMAP = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  shiftUp: ['KeyE', 'ShiftRight', 'BracketRight'],
  shiftDown: ['KeyQ', 'ShiftLeft', 'BracketLeft'],
  drs: ['Space'],
  ers: ['KeyX'],
  camera: ['KeyC'],
  look: ['KeyB'],
  pit: ['KeyP'],
  reset: ['KeyR'],
  pause: ['Escape'],
};

export function createControls(opts = {}) {
  const el = opts.element || document.body;
  const touchRoot = opts.touchRoot || document.body;

  const state = {
    throttle: 0, brake: 0, steer: 0,
    shiftUp: false, shiftDown: false,
    drs: false, ers: false, pit: false,
    camera: false, look: 0, pause: false, reset: false,
    source: 'keyboard',
    usingGamepad: false,
  };
  const held = new Set();
  const pressed = new Set();

  const settings = {
    layout: 'drag',            // 'drag' | 'wheel' | 'tilt'
    sensitivity: 1.0,
    assistThrottle: false,
    steerSpeed: 6.2,
    steerReturn: 9.0,
    deadzone: 0.10,
    invertTilt: false,
  };
  Object.assign(settings, opts.settings || {});

  const isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches
    || navigator.maxTouchPoints > 1;

  // ---- keyboard -----------------------------------------------------------
  const onKeyDown = (e) => {
    if (e.repeat) return;
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    held.add(e.code); pressed.add(e.code);
    state.source = 'keyboard';
    for (const list of Object.values(KEYMAP)) if (list.includes(e.code)) { e.preventDefault(); break; }
  };
  const onKeyUp = (e) => held.delete(e.code);
  const onBlur = () => { held.clear(); };
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const anyHeld = (names) => names.some((n) => held.has(n));
  const anyPressed = (names) => names.some((n) => pressed.has(n));

  // ---- touch --------------------------------------------------------------
  let touchUI = null;
  let steerTouch = null, steerOrigin = 0, steerRaw = 0;
  let tiltZero = null, tiltValue = 0;
  const zones = {};

  function buildTouchUI() {
    if (touchUI) return;
    const root = document.createElement('div');
    root.className = 'apex-touch';
    root.innerHTML = `
      <div class="tc-steer" data-zone="steer">
        <div class="tc-wheel"><div class="tc-wheel-inner"></div><div class="tc-wheel-mark"></div></div>
        <div class="tc-steer-hint">STEER</div>
      </div>
      <div class="tc-pedals">
        <div class="tc-btn tc-brake" data-zone="brake"><span>BRAKE</span></div>
        <div class="tc-btn tc-throttle" data-zone="throttle"><span>GAS</span></div>
      </div>
      <div class="tc-aux">
        <div class="tc-mini" data-zone="drs"><span>DRS</span></div>
        <div class="tc-mini" data-zone="ers"><span>ERS</span></div>
        <div class="tc-mini" data-zone="camera"><span>CAM</span></div>
        <div class="tc-mini" data-zone="pit"><span>PIT</span></div>
      </div>
      <div class="tc-shifts">
        <div class="tc-mini tc-shift" data-zone="shiftDown"><span>&minus;</span></div>
        <div class="tc-mini tc-shift" data-zone="shiftUp"><span>+</span></div>
      </div>`;
    touchRoot.appendChild(root);
    touchUI = root;
    root.querySelectorAll('[data-zone]').forEach((n) => { zones[n.dataset.zone] = n; });

    const active = new Map();      // pointerId -> zone name
    const zoneAt = (x, y) => {
      for (const [name, node] of Object.entries(zones)) {
        if (name === 'steer') continue;
        const r = node.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return name;
      }
      const sr = zones.steer.getBoundingClientRect();
      if (x >= sr.left && x <= sr.right && y >= sr.top && y <= sr.bottom) return 'steer';
      return null;
    };
    const down = (e) => {
      for (const t of e.changedTouches ? e.changedTouches : [e]) {
        const id = t.identifier != null ? t.identifier : t.pointerId;
        const name = zoneAt(t.clientX, t.clientY);
        if (!name) continue;
        active.set(id, name);
        state.source = 'touch';
        if (name === 'steer') { steerTouch = id; steerOrigin = t.clientX; }
        else {
          zones[name].classList.add('on');
          if (name === 'shiftUp') pressed.add('__shiftUp');
          if (name === 'shiftDown') pressed.add('__shiftDown');
          if (name === 'camera') pressed.add('__camera');
          if (name === 'pit') pressed.add('__pit');
        }
      }
      e.preventDefault();
    };
    const move = (e) => {
      for (const t of e.changedTouches ? e.changedTouches : [e]) {
        const id = t.identifier != null ? t.identifier : t.pointerId;
        if (id === steerTouch) {
          const sr = zones.steer.getBoundingClientRect();
          if (settings.layout === 'wheel') {
            const cx = sr.left + sr.width / 2, cy = sr.top + sr.height * 0.62;
            steerRaw = THREE.MathUtils.clamp(Math.atan2(t.clientX - cx, Math.max(30, cy - t.clientY)) * 1.55, -1, 1);
          } else {
            const span = Math.min(190, sr.width * 0.44);
            steerRaw = THREE.MathUtils.clamp((t.clientX - steerOrigin) / span, -1, 1);
          }
        }
      }
      e.preventDefault();
    };
    const up = (e) => {
      for (const t of e.changedTouches ? e.changedTouches : [e]) {
        const id = t.identifier != null ? t.identifier : t.pointerId;
        const name = active.get(id);
        if (name && name !== 'steer') zones[name].classList.remove('on');
        if (id === steerTouch) { steerTouch = null; steerRaw = 0; }
        active.delete(id);
      }
      e.preventDefault();
    };
    root.addEventListener('touchstart', down, { passive: false });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', up, { passive: false });
    root.addEventListener('touchcancel', up, { passive: false });
    touchUI._handlers = { down, move, up, active };
    touchUI._isDown = (name) => [...active.values()].includes(name);
  }

  // tilt steering
  function onOrient(e) {
    if (settings.layout !== 'tilt') return;
    const g = e.gamma;             // left/right tilt in degrees
    if (g == null) return;
    if (tiltZero == null) tiltZero = g;
    const raw = (g - tiltZero) / 26;
    tiltValue = THREE.MathUtils.clamp(settings.invertTilt ? -raw : raw, -1, 1);
    state.source = 'touch';
  }
  window.addEventListener('deviceorientation', onOrient);

  async function requestTilt() {
    try {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        const r = await DOE.requestPermission();
        return r === 'granted';
      }
      return true;
    } catch { return false; }
  }

  // ---- gamepad ------------------------------------------------------------
  let padSteer = 0, padThrottle = 0, padBrake = 0;
  const padPrev = {};
  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) { state.usingGamepad = false; return false; }
    const dz = (v) => (Math.abs(v) < settings.deadzone ? 0 : (v - Math.sign(v) * settings.deadzone) / (1 - settings.deadzone));
    padSteer = dz(pad.axes[0] || 0);
    // triggers: buttons 6/7 on standard mapping, axes on some drivers
    const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
    const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
    padThrottle = Math.max(rt, pad.buttons[0]?.pressed ? 1 : 0);
    padBrake = Math.max(lt, pad.buttons[1]?.pressed ? 1 : 0);
    const edge = (i) => {
      const now = !!pad.buttons[i]?.pressed;
      const was = padPrev[i];
      padPrev[i] = now;
      return now && !was;
    };
    if (edge(5)) pressed.add('__shiftUp');
    if (edge(4)) pressed.add('__shiftDown');
    if (edge(2)) pressed.add('__drs');
    if (edge(3)) pressed.add('__camera');
    if (edge(9)) pressed.add('Escape');
    state.drsHeld = !!pad.buttons[2]?.pressed;
    const active = Math.abs(padSteer) > 0.02 || padThrottle > 0.02 || padBrake > 0.02;
    if (active) { state.usingGamepad = true; state.source = 'gamepad'; }
    return state.usingGamepad;
  }

  // ---- per-frame resolve --------------------------------------------------
  let steerSmooth = 0;
  function update(dt) {
    const padActive = pollGamepad();

    // Every source is read every frame and the strongest wins. Branching on a
    // sticky "source" field means one stray touch or a phantom gamepad can
    // silently kill the keyboard for the rest of the session.
    const kbLeft = anyHeld(KEYMAP.left) ? 1 : 0;
    const kbRight = anyHeld(KEYMAP.right) ? 1 : 0;
    const kbSteer = kbRight - kbLeft;
    const kbThrottle = anyHeld(KEYMAP.throttle) ? 1 : 0;
    const kbBrake = anyHeld(KEYMAP.brake) ? 1 : 0;

    const touchActive = !!touchUI && touchUI.style.display !== 'none';
    const tSteer = touchActive ? (settings.layout === 'tilt' ? tiltValue : steerRaw) : 0;
    const tThrottleDown = touchActive && touchUI._isDown('throttle');
    const tBrakeDown = touchActive && touchUI._isDown('brake');
    const tBrake = tBrakeDown ? 1 : 0;
    const tThrottle = touchActive
      ? (settings.assistThrottle ? (tBrakeDown ? 0 : 1) : (tThrottleDown ? 1 : 0))
      : 0;

    // --- steering: take whichever source is actually deflected ---
    let targetSteer = kbSteer;
    let analog = false;
    if (Math.abs(tSteer) > Math.abs(targetSteer)) { targetSteer = tSteer; analog = settings.layout !== 'drag'; }
    if (padActive && Math.abs(padSteer) > Math.abs(targetSteer)) { targetSteer = padSteer; analog = true; }
    targetSteer = THREE.MathUtils.clamp(targetSteer * settings.sensitivity, -1, 1);

    if (analog) {
      steerSmooth += (targetSteer - steerSmooth) * Math.min(1, dt * 22);
    } else {
      // digital sources need a rate limit or the car is undriveable
      const rate = (targetSteer === 0 ? settings.steerReturn : settings.steerSpeed);
      steerSmooth += THREE.MathUtils.clamp(targetSteer - steerSmooth, -rate * dt, rate * dt);
    }
    state.steer = THREE.MathUtils.clamp(steerSmooth, -1, 1);

    // --- pedals: strongest input across all sources ---
    state.throttle = Math.max(kbThrottle, tThrottle, padActive ? padThrottle : 0);
    state.brake = Math.max(kbBrake, tBrake, padActive ? padBrake : 0);

    // --- discrete ---
    state.shiftUp = anyPressed(KEYMAP.shiftUp) || pressed.has('__shiftUp');
    state.shiftDown = anyPressed(KEYMAP.shiftDown) || pressed.has('__shiftDown');
    state.camera = anyPressed(KEYMAP.camera) || pressed.has('__camera');
    state.pause = anyPressed(KEYMAP.pause);
    state.reset = anyPressed(KEYMAP.reset);
    state.pit = anyPressed(KEYMAP.pit) || pressed.has('__pit');
    state.ers = anyHeld(KEYMAP.ers) || (touchUI && touchUI._isDown('ers'));
    state.drs = anyHeld(KEYMAP.drs) || state.drsHeld || (touchUI && touchUI._isDown('drs'));
    state.look = anyHeld(KEYMAP.look) ? 1 : 0;

    pressed.clear();
    return state;
  }

  // ---- api ----------------------------------------------------------------
  function setTouchVisible(v) {
    if (v) buildTouchUI();
    if (touchUI) {
      touchUI.style.display = v ? '' : 'none';
      touchUI.classList.toggle('tc-auto-gears', !settings.manualGears);
    }
    // Drive the layout off a real class rather than a `pointer: coarse` media
    // query — touch laptops report coarse, some phones report fine, and it is
    // untestable in a desktop browser emulating a phone.
    try { document.body.classList.toggle('apex-touch-on', !!v); } catch {}
  }
  function setManualGears(on) {
    settings.manualGears = !!on;
    if (touchUI) touchUI.classList.toggle('tc-auto-gears', !on);
  }
  function setLayout(l) {
    settings.layout = l;
    if (touchUI) touchUI.classList.toggle('tc-layout-wheel', l === 'wheel');
    if (l === 'tilt') { tiltZero = null; requestTilt(); }
  }
  function updateWheelVisual() {
    if (!touchUI) return;
    const w = touchUI.querySelector('.tc-wheel');
    if (w) w.style.transform = `rotate(${state.steer * 62}deg)`;
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('deviceorientation', onOrient);
    if (touchUI) touchUI.remove();
    touchUI = null;
  }

  return {
    state, settings, update, dispose, isTouch,
    setTouchVisible, setLayout, updateWheelVisual, requestTilt, setManualGears,
    setSensitivity: (v) => { settings.sensitivity = v; },
    setAssistThrottle: (v) => { settings.assistThrottle = v; },
    get touchElement() { return touchUI; },
    KEYMAP,
  };
}

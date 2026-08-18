/**
 * APEX F1 — Renderer, camera rig and quality management.
 */
import * as THREE from 'three';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

export const QUALITY_TIERS = {
  low:    { tier: 'low',    pixelRatio: 1.0,  shadows: false, shadowMapSize: 512,  postFX: false, particles: 0.25, anisotropy: 1,  crowdDensity: 0.0, reflections: false, drawDistance: 1400 },
  medium: { tier: 'medium', pixelRatio: 1.0,  shadows: true,  shadowMapSize: 1024, postFX: true,  particles: 0.55, anisotropy: 4,  crowdDensity: 0.35, reflections: false, drawDistance: 2200 },
  high:   { tier: 'high',   pixelRatio: 1.5,  shadows: true,  shadowMapSize: 2048, postFX: true,  particles: 1.0,  anisotropy: 8,  crowdDensity: 0.8, reflections: true, drawDistance: 3200 },
  ultra:  { tier: 'ultra',  pixelRatio: 2.0,  shadows: true,  shadowMapSize: 4096, postFX: true,  particles: 1.0,  anisotropy: 16, crowdDensity: 1.0, reflections: true, drawDistance: 4500 },
};

export function detectQuality() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'low';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    if (mobile) return (cores >= 6 && mem >= 4) ? 'medium' : 'low';
    if (/SwiftShader|Software|llvmpipe/i.test(rendererName)) return 'low';
    if (cores >= 8 && mem >= 8) return 'high';
    return 'medium';
  } catch { return 'medium'; }
}

export function createEngine(canvas, opts = {}) {
  const quality = { ...(QUALITY_TIERS[opts.quality] || QUALITY_TIERS.high) };

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: quality.tier !== 'low',
    powerPreference: 'high-performance',
    stencil: false, alpha: false,
    logarithmicDepthBuffer: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.info.autoReset = true;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9fb6cc, 620, quality.drawDistance);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.22, quality.drawDistance * 1.6);
  camera.position.set(0, 4, -12);

  // ---- camera rig ---------------------------------------------------------
  const MODES = ['tv', 'chase', 'cockpit', 'helmet', 'bumper', 'cinematic'];
  const rig = {
    mode: 'chase',
    modeIndex: 1,
    fovBase: 62,
    shake: 0,
    lookBack: 0,
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    smoothPos: new THREE.Vector3(),
    smoothLook: new THREE.Vector3(),
    initialised: false,
    seatOffset: new THREE.Vector3(0, 0.72, 0.16),
  };

  const CAM = {
    chase:    { back: 8.4, up: 2.75, look: 9.0, stiff: 7.0, lookStiff: 9.5, fovAdd: 12, roll: 0.30 },
    tv:       { back: 12.5, up: 4.6, look: 14.0, stiff: 3.2, lookStiff: 5.0, fovAdd: 6, roll: 0.10 },
    cockpit:  { back: -0.30, up: 1.10, look: 22.0, stiff: 28, lookStiff: 22, fovAdd: 16, roll: 0.85 },
    helmet:   { back: -0.34, up: 1.14, look: 20.0, stiff: 34, lookStiff: 16, fovAdd: 20, roll: 1.0 },
    bumper:   { back: -2.55, up: 0.52, look: 24.0, stiff: 30, lookStiff: 24, fovAdd: 18, roll: 0.55 },
    cinematic:{ back: 0, up: 0, look: 0, stiff: 0, lookStiff: 0, fovAdd: 0, roll: 0 },
  };

  let cineTimer = 0, cineAnchor = new THREE.Vector3(), cineNext = 0;

  function updateCamera(dt, car, track, extra = {}) {
    if (!car) return;
    const cfg = CAM[rig.mode] || CAM.chase;
    const speed = car.speed;

    if (rig.mode === 'cinematic') {
      cineTimer += dt;
      if (cineTimer > cineNext) {
        cineTimer = 0; cineNext = 3.5 + Math.random() * 3.5;
        const sm = track.sample(car.lapDistance + 70 + Math.random() * 90);
        const side = Math.random() < 0.5 ? -1 : 1;
        cineAnchor.copy(sm.pos)
          .addScaledVector(sm.lateral, side * (sm.width + 9 + Math.random() * 22))
          .add(_v.set(0, 3 + Math.random() * 11, 0));
      }
      rig.pos.copy(cineAnchor);
      rig.look.copy(car.position);
      camera.position.lerp(rig.pos, Math.min(1, dt * 4));
      rig.smoothLook.lerp(rig.look, Math.min(1, dt * 7));
      camera.lookAt(rig.smoothLook);
      const d = camera.position.distanceTo(car.position);
      camera.fov = THREE.MathUtils.clamp(2 * Math.atan(26 / Math.max(12, d)) * 180 / Math.PI, 18, 55);
      camera.updateProjectionMatrix();
      return;
    }

    const back = rig.lookBack > 0.5 ? -cfg.back * 0.55 : cfg.back;
    // desired position in car space
    _v.set(0, cfg.up, -back).applyQuaternion(car.quaternion).add(car.position);
    // let the camera hang out on the outside of the corner a touch
    if (rig.mode === 'chase' || rig.mode === 'tv') {
      _v.addScaledVector(car.right, -car.gForce.lat * 0.30);
      _v.y += Math.min(1.2, speed * 0.006);
    }
    rig.pos.copy(_v);

    // look-at target ahead of the car, biased toward where the track goes
    const laneAhead = Math.min(track.length * 0.2, cfg.look + speed * 0.42);
    const sm = track.sample(car.lapDistance + laneAhead);
    _v2.copy(car.position).addScaledVector(car.forward, cfg.look);
    _v2.lerp(sm.pos, rig.mode === 'cockpit' || rig.mode === 'helmet' ? 0.42 : 0.30);
    if (rig.lookBack > 0.5) _v2.copy(car.position).addScaledVector(car.forward, -cfg.look * 0.6);
    rig.look.copy(_v2);

    if (!rig.initialised) { rig.smoothPos.copy(rig.pos); rig.smoothLook.copy(rig.look); rig.initialised = true; }

    const isOnboard = rig.mode === 'cockpit' || rig.mode === 'helmet' || rig.mode === 'bumper';
    if (isOnboard) {
      // rigidly attached — no lag, or it feels like jelly
      camera.position.copy(rig.pos);
      rig.smoothLook.lerp(rig.look, Math.min(1, dt * cfg.lookStiff));
    } else {
      rig.smoothPos.lerp(rig.pos, Math.min(1, dt * cfg.stiff));
      rig.smoothLook.lerp(rig.look, Math.min(1, dt * cfg.lookStiff));
      camera.position.copy(rig.smoothPos);
    }

    // orientation with banking/roll from the car
    camera.up.set(0, 1, 0).applyQuaternion(_q.copy(car.quaternion)).lerp(UP, 1 - cfg.roll).normalize();
    camera.lookAt(rig.smoothLook);

    // head movement under g in onboard views
    if (isOnboard) {
      const lat = THREE.MathUtils.clamp(car.gForce.lat, -4, 4);
      const lon = THREE.MathUtils.clamp(car.gForce.lon, -5, 3);
      _q2.setFromAxisAngle(camera.up, -lat * 0.016);
      camera.quaternion.premultiply(_q2);
      _q2.setFromAxisAngle(_v3.set(1, 0, 0).applyQuaternion(camera.quaternion), lon * 0.010);
      camera.quaternion.premultiply(_q2);
    }

    // speed-driven FOV and shake
    const speedN = THREE.MathUtils.clamp(speed / 95, 0, 1.15);
    const targetFov = rig.fovBase + cfg.fovAdd * speedN * speedN;
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 3.4);

    rig.shake = Math.max(rig.shake * (1 - dt * 4.5), 0);
    const rough = (extra.kerb || 0) * 0.55 + (car.bottomedOut || 0) * 0.30;
    const amp = (rig.shake * 0.5 + rough * 0.10 + speedN * 0.014) * (isOnboard ? 1.5 : 0.55);
    if (amp > 0.0005) {
      const t = performance.now() * 0.001;
      camera.position.x += Math.sin(t * 47.3) * amp;
      camera.position.y += Math.sin(t * 61.7) * amp * 1.2;
      camera.position.z += Math.sin(t * 39.1) * amp * 0.6;
    }
    camera.updateProjectionMatrix();
  }

  function setMode(m) {
    if (typeof m === 'number') { rig.modeIndex = ((m % MODES.length) + MODES.length) % MODES.length; }
    else { const i = MODES.indexOf(m); if (i >= 0) rig.modeIndex = i; }
    rig.mode = MODES[rig.modeIndex];
    rig.initialised = false;
    return rig.mode;
  }
  function cycleMode() { return setMode(rig.modeIndex + 1); }

  // ---- sizing -------------------------------------------------------------
  let width = 1, height = 1;
  function resize(w, h) {
    width = Math.max(1, w | 0); height = Math.max(1, h | 0);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // narrow phones need a wider vertical FOV or you can't see the apex
    const aspect = width / height;
    rig.fovBase = aspect < 1.0 ? 74 : aspect < 1.5 ? 66 : 62;
    camera.updateProjectionMatrix();
  }

  function setQuality(name) {
    const q = QUALITY_TIERS[name];
    if (!q) return quality;
    Object.assign(quality, q);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio * (opts.resScale || 1)));
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.needsUpdate = true;
    scene.fog.far = quality.drawDistance;
    camera.far = quality.drawDistance * 1.6;
    camera.updateProjectionMatrix();
    resize(width, height);
    return quality;
  }
  function setResolutionScale(s) {
    opts.resScale = s;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio * s));
  }

  return {
    renderer, scene, camera, quality, rig,
    updateCamera, setMode, cycleMode, resize, setQuality, setResolutionScale,
    MODES,
    get size() { return { width, height }; },
    dispose() { renderer.dispose(); },
  };
}

/**
 * APEX F1 — application bootstrap and game loop.
 *
 * Every optional subsystem is initialised defensively: if one fails the game
 * keeps running without it rather than showing a black screen.
 */
import * as THREE from 'three';
import { createEngine, detectQuality, QUALITY_TIERS } from './core/engine.js';
import { createTrack } from './track/track.js';
import { CIRCUITS, getCircuit } from './track/circuits.js';
import { createVehicle } from './physics/vehicle.js';
import { createAIDriver, DIFFICULTY } from './ai/driver.js';
import { createRace, fmt } from './game/race.js';
import { TEAMS, GRID, TYRE_COMPOUNDS } from './game/teams.js';
import { createControls } from './input/controls.js';

const canvas = document.getElementById('scene');
const hudRoot = document.getElementById('hud-root');
const menuRoot = document.getElementById('menu-root');
const touchRoot = document.getElementById('touch-root');

const SAVE_KEY = 'apex-f1-settings-v1';
const PHYS_HZ = 120;
const PHYS_DT = 1 / PHYS_HZ;

const settings = Object.assign({
  quality: 'auto', resolutionScale: 1, postFX: true, shadows: true,
  particles: 1, fov: 0, motionBlur: true,
  masterVolume: 0.8, engineVolume: 0.8, uiVolume: 0.7,
  units: 'kmh', camera: 'chase',
  tc: 0.45, abs: 0.55, autoGear: true, stability: 0.45, racingLineAid: 'full',
  touchLayout: 'drag', steerSensitivity: 1, assistThrottle: false,
}, loadSettings());

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- lazy modules
const mod = {};
async function loadModules(progress) {
  const list = [
    ['sky', () => import('./render/sky.js')],
    ['geometry', () => import('./track/geometry.js')],
    ['carModel', () => import('./render/carModel.js')],
    ['driverModel', () => import('./render/driver.js')],
    ['particles', () => import('./render/particles.js')],
    ['weather', () => import('./render/weather.js')],
    ['effects', () => import('./render/effects.js')],
    ['audio', () => import('./game/audio.js')],
    ['hud', () => import('./game/hud.js')],
    ['menus', () => import('./game/menus.js')],
  ];
  for (let i = 0; i < list.length; i++) {
    const [name, load] = list[i];
    try { mod[name] = await load(); }
    catch (err) { console.warn(`[apex] module "${name}" failed to load`, err); mod[name] = null; }
    progress((i + 1) / list.length);
  }
}

// ---------------------------------------------------------------- app state
const app = {
  engine: null, controls: null, menus: null, hud: null, audio: null,
  sky: null, weather: null, postfx: null, particles: null, world: null,
  track: null, circuit: null, race: null,
  cars: [], ais: [], models: [], player: null,
  running: false, paused: false, screen: 'loading',
  accumulator: 0, last: 0, fps: 60, frames: 0, fpsTime: 0,
  config: null, ready: false,
};
// Build stamp — so a stale copy is obvious at a glance instead of being
// mistaken for a bug. Shown on the title screen and readable as __APEX.build.
app.build = '0820-1717';
window.__APEX = app;
// Exposed for debugging and automated smoke tests.
app.startRace = (cfg) => startRace(cfg);
// Drive one simulation step directly. requestAnimationFrame is suspended in a
// background tab, so without this the game cannot be exercised or debugged
// unless the window happens to be visible.
app.tick = (dt) => {
  const input = app.controls ? app.controls.update(dt) : null;
  if (app.running && !app.paused && !app.contextLost) stepSimulation(dt, input);
  return input;
};
app.showScreen = (n, d) => showScreen(n, d);

function qualityName() {
  return settings.quality === 'auto' ? detectQuality() : settings.quality;
}

// ---------------------------------------------------------------- boot
async function boot() {
  app.engine = createEngine(canvas, { quality: qualityName(), resScale: settings.resolutionScale });
  resize();

  // A lost WebGL context is the classic "everything vanished into a coloured
  // void". Tell the player what happened instead of leaving them driving
  // blind, and restore automatically when the browser hands the context back.
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    app.contextLost = true;
    app.running = false;
    try { app.hud?.showMessage?.('GRAPHICS CONTEXT LOST — RECOVERING', 'warn', 6000); } catch {}
    console.warn('[apex] WebGL context lost');
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    app.contextLost = false;
    console.warn('[apex] WebGL context restored — rebuilding');
    worldCache.clear();
    try { app.hud?.showMessage?.('GRAPHICS RESTORED', 'info', 2500); } catch {}
    if (app.config) startRace(app.config);
  }, false);

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(resize, 250), { passive: true });

  app.controls = createControls({
    element: canvas, touchRoot,
    settings: {
      layout: settings.touchLayout,
      sensitivity: settings.steerSensitivity,
      assistThrottle: settings.assistThrottle,
    },
  });
  app.controls.setManualGears(!settings.autoGear);
  if (app.controls.isTouch) { app.controls.setTouchVisible(true); app.controls.setTouchVisible(false); }

  await loadModules((p) => { if (app.menus) app.menus.setLoadingProgress(p * 0.5, 'Loading systems'); });

  if (mod.menus) {
    try {
      app.menus = mod.menus.createMenus(menuRoot, { circuits: CIRCUITS, teams: TEAMS, settings });
      wireMenus();
    } catch (err) { console.warn('[apex] menus failed', err); }
  }
  if (mod.hud) {
    try { app.hud = mod.hud.createHUD(hudRoot, { units: settings.units }); app.hud.setVisible(false); }
    catch (err) { console.warn('[apex] hud failed', err); }
  }
  if (mod.audio) {
    try { app.audio = mod.audio.createAudio({}); } catch (err) { console.warn('[apex] audio failed', err); }
  }

  app.ready = true;
  try {
    const el = document.querySelector('.apx-build, #apex-build') || (() => {
      const d = document.createElement('div');
      d.id = 'apex-build';
      d.style.cssText = 'position:fixed;left:8px;bottom:6px;z-index:300;'
        + 'font:600 10px/1 ui-monospace,monospace;letter-spacing:.08em;'
        + 'color:rgba(255,255,255,.34);pointer-events:none';
      document.body.appendChild(d);
      return d;
    })();
    el.textContent = 'build ' + app.build;
  } catch { /* non-fatal */ }
  showScreen('title');
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- garage preview
// A small self-contained scene showing the selected car and driver, rendered
// into the container the menus module leaves empty.
const garage = { renderer: null, scene: null, camera: null, model: null, driver: null, raf: 0, host: null, key: '' };

function stopGaragePreview() {
  if (garage.raf) cancelAnimationFrame(garage.raf);
  garage.raf = 0;
  if (garage.renderer && garage.renderer.domElement.parentNode) {
    garage.renderer.domElement.parentNode.removeChild(garage.renderer.domElement);
  }
}

function startGaragePreview(teamId, driverIndex) {
  const host = document.getElementById('garage-preview')
    || menuRoot.querySelector('.garage-preview, [data-garage-preview]');
  if (!host || !mod.carModel) return;
  const team = TEAMS.find((t) => t.id === teamId) || TEAMS[0];
  const driver = team.drivers[driverIndex] || team.drivers[0];
  const key = `${team.id}|${driver.num}`;

  stopGaragePreview();
  try {
    if (!garage.renderer) {
      garage.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      garage.renderer.outputColorSpace = THREE.SRGBColorSpace;
      garage.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      garage.renderer.toneMappingExposure = 1.0;
      garage.scene = new THREE.Scene();
      garage.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
      // Three-point lighting so the carbon and clearcoat actually read.
      const key1 = new THREE.DirectionalLight(0xffffff, 3.2); key1.position.set(4, 6, 6);
      const key2 = new THREE.DirectionalLight(0x9fc0ff, 1.5); key2.position.set(-6, 3, -4);
      const rim = new THREE.DirectionalLight(0xffd9a0, 2.0); rim.position.set(0, 2, -8);
      garage.scene.add(key1, key2, rim, new THREE.HemisphereLight(0xdfe9ff, 0x202024, 0.9));
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(7, 48),
        new THREE.MeshStandardMaterial({ color: 0x0d1016, roughness: 0.35, metalness: 0.1 }),
      );
      floor.rotation.x = -Math.PI / 2; floor.position.y = -0.02;
      garage.scene.add(floor);
    }
    if (garage.key !== key) {
      if (garage.model) { try { garage.scene.remove(garage.model.group); garage.model.dispose?.(); } catch {} }
      garage.model = mod.carModel.createCarModel({ team, driver, quality: app.engine.quality });
      garage.scene.add(garage.model.group);
      if (mod.driverModel && garage.model.cockpitAnchor) {
        try {
          garage.driver = mod.driverModel.createDriver({ driver, team, quality: app.engine.quality });
          if (garage.driver?.group) garage.model.cockpitAnchor.add(garage.driver.group);
        } catch {}
      }
      garage.key = key;
    }
    // The panel ships very short; a car needs a sane aspect to read at all.
    if (!host.style.minHeight) {
      host.style.minHeight = 'min(46vh, 340px)';
      host.style.position = host.style.position || 'relative';
    }
    host.appendChild(garage.renderer.domElement);
    garage.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
    garage.host = host;

    let angle = 0.6;
    const tick = () => {
      garage.raf = requestAnimationFrame(tick);
      const w = host.clientWidth || 480, h = host.clientHeight || 270;
      if (garage.renderer.domElement.width !== w || garage.renderer.domElement.height !== h) {
        garage.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        garage.renderer.setSize(w, h, false);
        garage.camera.aspect = w / h;
        garage.camera.updateProjectionMatrix();
      }
      angle += 0.0042;
      const r = 7.6;
      garage.camera.position.set(Math.sin(angle) * r, 1.75, Math.cos(angle) * r);
      garage.camera.lookAt(0, 0.55, 0);
      if (garage.driver?.setSteer) garage.driver.setSteer(Math.sin(angle * 1.7) * 0.45);
      garage.renderer.render(garage.scene, garage.camera);
    };
    tick();
  } catch (err) { console.warn('[apex] garage preview failed', err); }
}

function showScreen(name, data) {
  app.screen = name;
  if (app.menus) { try { name === 'race' ? app.menus.hide() : app.menus.show(name, data); } catch {} }
  if (app.hud) { try { app.hud.setVisible(name === 'race'); } catch {} }
  if (app.controls) app.controls.setTouchVisible(name === 'race' && app.controls.isTouch);
  if (name === 'garage') {
    const cfg = (app.menus && app.menus.getConfig && app.menus.getConfig()) || {};
    startGaragePreview(cfg.teamId || TEAMS[0].id, cfg.driverIndex || 0);
  } else stopGaragePreview();
  hudRoot.setAttribute('aria-hidden', name === 'race' ? 'false' : 'true');
  document.body.classList.toggle('in-race', name === 'race');
}

function wireMenus() {
  const on = (ev, cb) => { try { app.menus.on(ev, cb); } catch {} };
  on('start', (cfg) => startRace(cfg));
  on('restart', () => startRace(app.config));
  on('resume', () => { app.paused = false; showScreen('race'); app.audio?.resume?.(); });
  on('quit', () => { teardownRace(); showScreen('title'); });
  on('nextRace', () => { teardownRace(); showScreen('setup'); });
  on('settingChanged', ({ key, value }) => applySetting(key, value));
  on('garageChanged', (cfg) => {
    if (app.screen === 'garage' && cfg && (cfg.teamId || cfg.driverIndex != null)) {
      startGaragePreview(cfg.teamId || TEAMS[0].id, cfg.driverIndex || 0);
    }
  });
}

function applySetting(key, value) {
  settings[key] = value;
  saveSettings();
  switch (key) {
    case 'quality':
      app.engine.setQuality(value === 'auto' ? detectQuality() : value);
      app.postfx?.setQuality?.(app.engine.quality);
      app.particles?.setQuality?.(app.engine.quality);
      app.sky?.setQuality?.(app.engine.quality);
      app.world?.setQuality?.(app.engine.quality);
      break;
    case 'resolutionScale': app.engine.setResolutionScale(value); break;
    case 'postFX': app.postfx?.setEnabled?.(value); break;
    case 'shadows': app.engine.renderer.shadowMap.enabled = !!value; break;
    case 'masterVolume': app.audio?.setMasterVolume?.(value); break;
    case 'engineVolume': app.audio?.setEngineVolume?.(value); break;
    case 'uiVolume': app.audio?.setUIVolume?.(value); break;
    case 'units': app.hud?.setUnits?.(value); break;
    case 'camera': app.engine.setMode(value); break;
    case 'racingLineAid':
      app.guide?.setMode(value === 'off' ? 'off' : value === 'corners' ? 'corners' : 'full');
      break;
    case 'fov': app.engine.rig.fovBase = 62 + value; break;
    case 'touchLayout': app.controls?.setLayout?.(value); break;
    case 'steerSensitivity': app.controls?.setSensitivity?.(value); break;
    case 'assistThrottle': app.controls?.setAssistThrottle?.(value); break;
    case 'autoGear':
      if (app.player) app.player.aids.autoGear = value;
      app.controls?.setManualGears?.(!value);
      break;
    case 'tc': case 'abs': case 'stability':
      if (app.player) app.player.aids[key] = value;
      break;
    default: break;
  }
}

// ---------------------------------------------------------------- race setup
const worldCache = new Map();   // circuitId -> built world (rebuilding costs ~10s)

function teardownRace() {
  app.running = false;
  // Keep the world alive in the cache; only detach it from the scene.
  if (app.world && !worldCache.has(app.world._circuitId)) {
    if (app.world.dispose) { try { app.world.dispose(); } catch {} }
  }
  for (const m of app.models) { try { m.dispose?.(); } catch {} }
  if (app.engine) {
    const scene = app.engine.scene;
    for (let i = scene.children.length - 1; i >= 0; i--) scene.remove(scene.children[i]);
  }
  app.audio?.stopEngine?.();
  if (app.pitLane) { try { app.pitLane.dispose(); } catch {} app.pitLane = null; }
  if (app.guide) { try { app.guide.dispose(); } catch {} app.guide = null; }
  app.cars = []; app.ais = []; app.models = []; app.player = null;
  app.race = null; app.track = null; app.world = null;
}

async function startRace(cfg) {
  cfg = Object.assign({
    circuitId: CIRCUITS[0].id, teamId: TEAMS[0].id, driverIndex: 0,
    difficulty: 'adaptive', laps: 5, weather: 'clear', timeOfDay: null,
    tyre: 'medium', ersMode: 1, brakeBias: 0.575, wingFront: 0.5, wingRear: 0.5,
  }, cfg || {});
  app.config = cfg;
  teardownRace();
  showScreen('loading');
  const step = (p, label) => { app._stage = label; try { app.menus?.setLoadingProgress(p, label); } catch {} };
  step(0.05, 'Surveying circuit');
  await nextFrame();

  const circuit = getCircuit(cfg.circuitId) || CIRCUITS[0];
  app.circuit = circuit;
  app.track = createTrack(circuit);
  step(0.25, 'Solving racing line');
  await nextFrame();

  const engine = app.engine;
  const scene = engine.scene;
  const quality = engine.quality;

  app._stage = 'sky';
  // ---- sky + lighting ----
  if (mod.sky) {
    try {
      app.sky = mod.sky.createSky(engine.renderer, scene, { quality });
      if (app.sky.sunLight) scene.add(app.sky.sunLight);
      if (app.sky.hemiLight) scene.add(app.sky.hemiLight);
      if (app.sky.fillLight) scene.add(app.sky.fillLight);
    } catch (err) { console.warn('[apex] sky failed', err); app.sky = null; }
  }
  if (!app.sky) {
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
    sun.position.set(280, 420, 180); sun.castShadow = quality.shadows;
    if (sun.shadow) {
      sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
      const c = sun.shadow.camera; c.left = -160; c.right = 160; c.top = 160; c.bottom = -160;
      c.near = 1; c.far = 900; sun.shadow.bias = -0.0008;
    }
    scene.add(sun, new THREE.HemisphereLight(0x9fc5ff, 0x4a4437, 1.15));
    app.sky = { sunLight: sun, update() {}, getFogColor: () => new THREE.Color(0x9fb6cc) };
  }
  step(0.4, 'Building circuit');
  await nextFrame();

  // Floodlit night circuits still need a floor of ambient light or the track is
  // genuinely too dark to drive. Scaled by time of day in updateVisuals().
  app.ambient = new THREE.AmbientLight(0xaebfd6, 0.25);
  scene.add(app.ambient);

  app._stage = 'weather';
  // ---- weather effects ----
  if (mod.weather) {
    try { app.weather = mod.weather.createWeather(scene, engine.camera, { quality }); }
    catch (err) { console.warn('[apex] weather failed', err); app.weather = null; }
  }

  app._stage = 'world';
  // ---- track world ----
  const cacheKey = `${circuit.id}|${quality.tier}`;
  if (worldCache.has(cacheKey)) {
    app.world = worldCache.get(cacheKey);
    if (app.world?.group) scene.add(app.world.group);
  } else if (mod.geometry) {
    try {
      app.world = mod.geometry.buildTrackWorld(circuit, app.track.curve, {
        quality,
        wetnessUniform: app.weather?.getWetnessUniform?.(),
        puddleMask: app.weather?.getPuddleMask?.(),
      });
      if (app.world?.group) scene.add(app.world.group);
      if (app.world) {
        // Only ever keep ONE built world. Each holds a full set of geometry and
        // textures; letting them pile up exhausts VRAM and can drop the WebGL
        // context, which presents as "the graphics didn't load".
        for (const [k, w] of worldCache) {
          if (k !== cacheKey) { try { w.dispose?.(); } catch {} worldCache.delete(k); }
        }
        app.world._circuitId = cacheKey;
        worldCache.set(cacheKey, app.world);
      }
    } catch (err) { console.warn('[apex] track world failed', err); app.world = null; }
  }
  if (!app.world) buildFallbackWorld(scene);
  polishWorldLook(app.world);
  try {
    if (app.guide) { app.guide.dispose(); app.guide = null; }
    app.guide = buildRacingGuide(scene, app.track);
    app.guide.setMode(settings.racingLineAid === 'off' ? 'off'
      : settings.racingLineAid === 'corners' ? 'corners' : 'full');
  } catch (err) { console.warn('[apex] racing guide failed', err); app.guide = null; }
  try {
    if (app.pitLane) { app.pitLane.dispose(); app.pitLane = null; }
    app.pitLane = buildPitLane(scene, app.track, circuit);
  } catch (err) { console.warn('[apex] pit lane build failed', err); }
  step(0.62, 'Assembling cars');
  await nextFrame();

  app._stage = 'grid';
  // ---- grid ----
  const playerTeam = TEAMS.find((t) => t.id === cfg.teamId) || TEAMS[0];
  const playerDriver = playerTeam.drivers[cfg.driverIndex] || playerTeam.drivers[0];
  const entries = GRID.slice();
  // player first on the entry list, rest ordered by car performance
  entries.sort((a, b) => (b.team.performance + b.skill) - (a.team.performance + a.skill));
  const playerEntry = entries.find((e) => e.teamId === playerTeam.id && e.num === playerDriver.num) || entries[0];

  let sharedDriver = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const isPlayer = e === playerEntry;
    const car = createVehicle({
      track: app.track, team: e.team, driver: e, isPlayer,
      tyre: isPlayer ? cfg.tyre : (i < 10 ? 'medium' : 'hard'),
    });
    const slot = app.track.startGrid[Math.min(i, app.track.startGrid.length - 1)];
    car.reset(slot.s, slot.lateral, slot.heading);
    car.gridIndex = i;
    if (isPlayer) {
      app.player = car;
      car.aids.tc = settings.tc; car.aids.abs = settings.abs;
      car.aids.autoGear = settings.autoGear; car.aids.stability = settings.stability;
      car.cfg.brakeBias = cfg.brakeBias;
    } else {
      app.ais.push(createAIDriver(car, app.track, { difficulty: cfg.difficulty, gridIndex: i }));
    }
    app.cars.push(car);

    // visual model
    let model = null;
    if (mod.carModel) {
      try {
        model = mod.carModel.createCarModel({ team: e.team, driver: e, quality });
        if (model?.group) scene.add(model.group);
        if (mod.driverModel && model?.cockpitAnchor) {
          try {
            if (isPlayer) {
              const dm = mod.driverModel.createDriver({ driver: e, team: e.team, quality });
              if (dm?.group) { model.cockpitAnchor.add(dm.group); model.driverFigure = dm; }
            } else {
              // AI drivers are only ever seen from outside; clone one shared rig
              // (geometry and materials are shared by clone()) instead of
              // building twenty, which costs ~3 s of load time.
              if (!sharedDriver) sharedDriver = mod.driverModel.createDriver({ driver: e, team: e.team, quality });
              if (sharedDriver?.group) model.cockpitAnchor.add(sharedDriver.group.clone(true));
            }
          } catch {}
        }
      } catch (err) { if (i === 0) console.warn('[apex] car model failed', err); model = null; }
    }
    if (!model) model = buildFallbackCar(scene, e.team);
    app.models.push(model);
    if (i % 5 === 0) { step(0.62 + 0.22 * (i / entries.length), 'Assembling cars'); await nextFrame(); }
  }

  app._stage = 'particles';
  // ---- particles + post ----
  if (mod.particles) {
    try { app.particles = mod.particles.createParticles(scene, { quality }); }
    catch (err) { console.warn('[apex] particles failed', err); app.particles = null; }
  }
  if (mod.effects && settings.postFX) {
    try {
      app.postfx = mod.effects.createPostFX(engine.renderer, scene, engine.camera, {
        quality,
        // The stock tier is far too hazy in daylight: tight bloom only on real
        // highlights (sun, brake glow, sparks), and almost no lens dirt.
        bloomStrength: 0.20, bloomRadius: 0.26, bloomThreshold: 0.96,
        dirt: 0.10, vignette: 0.40, chromatic: 0.30, grain: 0.022,
        motionBlur: settings.motionBlur ? 0.75 : 0,
      });
    } catch (err) { console.warn('[apex] postfx failed', err); app.postfx = null; }
  }
  step(0.92, 'Formation lap');
  await nextFrame();

  app._stage = 'director';
  // ---- race director ----
  app.race = createRace({
    track: app.track, cars: app.cars, circuit,
    laps: cfg.laps, weather: cfg.weather,
    onEvent: (text, kind) => {
      try { app.hud?.showMessage(text, kind, kind === 'lightsout' ? 1600 : 2600); } catch {}
      if (kind === 'lightsout') app.audio?.playUI?.('lightsout');
      else if (kind === 'penalty') app.audio?.playUI?.('penalty');
    },
  });
  if (cfg.timeOfDay != null) app.race.weather.timeOfDay = cfg.timeOfDay;
  else app.race.weather.timeOfDay = circuit.ambience?.defaultTimeOfDay ?? 14.5;

  try { app.hud?.setTrackOutline(app.track.outline); } catch {}
  try { app.hud?.setTeamAccent?.(playerTeam.colors.primary); } catch {}

  engine.setMode(settings.camera);
  engine.rig.initialised = false;

  // audio needs a user gesture; startRace is always reached from a click/tap
  app._stage = 'audio';
  if (app.audio && !app.audio.ready) {
    // Never let audio init block the race starting.
    try { await Promise.race([app.audio.init(), new Promise((r) => setTimeout(r, 1500))]); } catch {}
  }
  app.audio?.setMasterVolume?.(settings.masterVolume);
  app.audio?.startEngine?.();

  // First-run tutorial for the racing guide. Shown for the first few races and
  // then never again, so it teaches without nagging.
  try {
    const seen = Number(localStorage.getItem('apex-guide-seen') || 0);
    if (settings.racingLineAid !== 'off' && seen < 3) {
      localStorage.setItem('apex-guide-seen', String(seen + 1));
      const tips = [
        ['FOLLOW THE ARROWS — THEY MARK THE FASTEST LINE', 'info', 3200],
        ['GREEN = FULL THROTTLE', 'info', 2600],
        ['YELLOW = EASE OFF, CORNER AHEAD', 'warn', 2600],
        ['RED = BRAKE HARD', 'penalty', 3000],
      ];
      tips.forEach(([text, kind, ms], i) => {
        setTimeout(() => { try { app.hud?.showMessage?.(text, kind, ms); } catch {} }, 900 + i * 2900);
      });
    }
  } catch { /* private mode */ }

  // Start every race from a clean input state — a latched key from the menus
  // or a previous race would otherwise drive the car on its own.
  try { app.controls?.reset?.(); } catch {}

  step(1, 'Ready');
  app.running = true;
  app.paused = false;
  app.last = performance.now();
  app.accumulator = 0;
  showScreen('race');
  app.race.startCountdown();
}

/**
 * Yield to the browser between loading stages. requestAnimationFrame does NOT
 * fire in a background tab, so racing it against a timer keeps loading alive if
 * the player switches away mid-load.
 */
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 40);
  });
}

/**
 * Trackside look pass.
 *
 * The run-off materials tile a small texture over hundreds of metres, so at
 * race distances the grass and gravel read as flat sheets of colour. This adds
 * multi-scale variation in WORLD space — independent of whatever UV convention
 * the geometry uses — plus mown stripes on the grass, which is what actually
 * makes a verge look like a real one on television.
 */
const GROUND_NOISE_GLSL = `
float apxH21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float apxVN(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(apxH21(i), apxH21(i + vec2(1.0, 0.0)), f.x),
             mix(apxH21(i + vec2(0.0, 1.0)), apxH21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float apxFBM(vec2 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * apxVN(p); p *= 2.03; a *= 0.5; }
  return s;
}
`;

function groundDetail(mat, opts) {
  if (!mat || mat.userData.__apxDetail) return;
  mat.userData.__apxDetail = true;
  const o = Object.assign({ large: 0.010, small: 0.13, amount: 0.42, stripes: 0, tint: [1, 1, 1] }, opts || {});
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, renderer) => {
    if (prev) { try { prev(sh, renderer); } catch {} }
    // These materials already carry an onBeforeCompile of their own (the wet
    // track effect), which consumes the usual `#include <common>` anchor. So
    // declare at the top of the source and hook a late, always-present chunk.
    sh.vertexShader = 'varying vec3 vApxW;\n' + sh.vertexShader;
    if (sh.vertexShader.indexOf('#include <project_vertex>') !== -1) {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\n  vApxW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    }
    sh.fragmentShader = 'varying vec3 vApxW;\n' + GROUND_NOISE_GLSL + sh.fragmentShader;
    if (sh.fragmentShader.indexOf('#include <dithering_fragment>') !== -1) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
      {
        vec2 wp = vApxW.xz;
        float nBig = apxFBM(wp * ${o.large.toFixed(4)});
        float nSml = apxFBM(wp * ${o.small.toFixed(4)});
        float v = mix(nBig, nSml, 0.35);
        gl_FragColor.rgb *= (1.0 - ${o.amount.toFixed(3)} * 0.5) + ${o.amount.toFixed(3)} * v;
        gl_FragColor.rgb *= vec3(${o.tint[0].toFixed(3)}, ${o.tint[1].toFixed(3)}, ${o.tint[2].toFixed(3)});
        ${o.stripes > 0 ? `
        float mow = 0.5 + 0.5 * sin(wp.x * 0.052 + wp.z * 0.031);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * vec3(1.10, 1.05, 0.86), mow * ${o.stripes.toFixed(3)});
        ` : ''}
      }`);
    }
  };
  mat.needsUpdate = true;
}

function polishWorldLook(world) {
  const m = world && world.materials;
  if (!m) return;
  try {
    groundDetail(m.grass, { large: 0.009, small: 0.16, amount: 0.52, stripes: 0.30, tint: [0.94, 1.0, 0.86] });
    groundDetail(m.gravel, { large: 0.020, small: 0.30, amount: 0.46, tint: [1.0, 0.97, 0.90] });
    groundDetail(m.astro, { large: 0.030, small: 0.40, amount: 0.28, tint: [0.90, 1.0, 0.90] });
    groundDetail(m.concrete, { large: 0.012, small: 0.20, amount: 0.24 });
  } catch (err) { console.warn('[apex] ground detail skipped', err); }
}

/**
 * Build a visible pit lane.
 *
 * The track geometry module only paints entry/exit guide lines, so without this
 * the pit lane is an invisible strip of grass. Surface, markings, separating
 * wall and garages are all generated here.
 */
function buildPitLane(scene, track, circuit) {
  const group = new THREE.Group();
  const pit = track.pit;
  const span = (pit.exitS - pit.entryS + track.length) % track.length;
  const HALF = 4.0;
  const sideSign = pit.side === 'right' ? 1 : -1;   // CONSTANT: never taken from
                                                    // the ramping lane offset
  // Only build where the lane has actually separated from the racing surface;
  // the entry/exit ramps pass close to the track and anything drawn there
  // (especially the wall) ends up standing on the circuit itself.
  const CLEAR = HALF + 1.0;
  const isClear = (f) => {
    const s2 = pit.entryS + span * f;
    return Math.abs(pit.lane(s2)) >= track.sample(s2).width + CLEAR;
  };
  let f0 = -1, f1 = -1;
  for (let i = 0; i <= 400; i++) { const f = i / 400; if (isClear(f)) { f0 = f; break; } }
  for (let i = 400; i >= 0; i--) { const f = i / 400; if (isClear(f)) { f1 = f; break; } }
  if (f0 < 0 || f1 <= f0) return { group, dispose() {} };

  const STEPS = Math.max(24, Math.round((span * (f1 - f0)) / 6));
  const pos = [], uv = [], idx = [], wallPos = [], wallIdx = [];
  for (let i = 0; i <= STEPS; i++) {
    const f = f0 + (f1 - f0) * (i / STEPS);
    const s2 = pit.entryS + span * f;
    const sm = track.sample(s2);
    const off = pit.lane(s2);
    const cx = sm.pos.x + sm.lateral.x * off;
    const cy = sm.pos.y + sm.lateral.y * off + 0.015;
    const cz = sm.pos.z + sm.lateral.z * off;
    for (let j = -1; j <= 1; j += 2) {
      pos.push(cx + sm.lateral.x * HALF * j, cy, cz + sm.lateral.z * HALF * j);
      uv.push((j + 1) * 0.5, (span * f) / 26);
    }
    // wall sits a fixed distance outside the TRACK edge, not off the lane centre
    const wLat = sideSign * (sm.width + 2.0);
    wallPos.push(sm.pos.x + sm.lateral.x * wLat, sm.pos.y + sm.lateral.y * wLat, sm.pos.z + sm.lateral.z * wLat,
                 sm.pos.x + sm.lateral.x * wLat, sm.pos.y + sm.lateral.y * wLat + 1.05, sm.pos.z + sm.lateral.z * wLat);
  }
  for (let i = 0; i < STEPS; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    wallIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3, a + 1, a + 2, a, a + 3, a + 2, a + 1);
  }

  // --- pit lane surface: asphalt with the fast-lane and box lines painted on
  const pc = document.createElement('canvas'); pc.width = 256; pc.height = 512;
  const px = pc.getContext('2d');
  px.fillStyle = '#33363b'; px.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 40 + Math.random() * 34;
    px.fillStyle = `rgba(${v},${v + 2},${v + 5},0.32)`;
    px.fillRect(Math.random() * 256, Math.random() * 512, 2, 2);
  }
  px.fillStyle = '#e9e9e6'; px.fillRect(10, 0, 7, 512); px.fillRect(239, 0, 7, 512);
  px.fillStyle = '#e8c23a'; px.fillRect(96, 0, 5, 512);
  px.fillStyle = '#e9e9e6';
  for (let b = 0; b < 4; b++) {
    const y = 40 + b * 128;
    px.fillRect(150, y, 80, 5); px.fillRect(150, y + 96, 80, 5); px.fillRect(150, y, 5, 101);
  }
  const laneTex = new THREE.CanvasTexture(pc);
  laneTex.wrapS = laneTex.wrapT = THREE.RepeatWrapping;
  laneTex.colorSpace = THREE.SRGBColorSpace;
  laneTex.anisotropy = 8;
  const laneMat = new THREE.MeshStandardMaterial({ map: laneTex, roughness: 0.9 });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const lane = new THREE.Mesh(g, laneMat);
  lane.receiveShadow = true;
  group.add(lane);

  // --- separating wall, painted with a sponsor band
  const wc = document.createElement('canvas'); wc.width = 128; wc.height = 64;
  const wx = wc.getContext('2d');
  wx.fillStyle = '#dededa'; wx.fillRect(0, 0, 128, 64);
  wx.fillStyle = '#c8102e'; wx.fillRect(0, 52, 128, 12);
  wx.fillStyle = '#1c2733'; wx.fillRect(8, 12, 112, 28);
  wx.fillStyle = '#e9edf2'; wx.font = 'bold 17px sans-serif'; wx.textAlign = 'center';
  wx.fillText('APEX', 64, 33);
  const wallTex = new THREE.CanvasTexture(wc);
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
  wallTex.repeat.set(Math.max(6, Math.round(span * (f1 - f0) / 9)), 1);
  wallTex.colorSpace = THREE.SRGBColorSpace;
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.78, side: THREE.DoubleSide });
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  wg.setIndex(wallIdx); wg.computeVertexNormals();
  const wall = new THREE.Mesh(wg, wallMat);
  wall.castShadow = true; wall.receiveShadow = true;
  group.add(wall);

  // --- garages set back on the far side of the lane
  const boxGeo = new THREE.BoxGeometry(7.5, 4.2, 9);
  const mats = [];
  for (let i = 0; i < 10; i++) {
    const f = f0 + (f1 - f0) * (0.10 + i * 0.085);
    if (f > f1) break;
    const s2 = pit.entryS + span * f;
    const sm = track.sample(s2);
    const off = pit.lane(s2);
    const t = TEAMS[i % TEAMS.length];
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(t.colors.primary).multiplyScalar(0.55), roughness: 0.85,
    });
    mats.push(mat);
    const box = new THREE.Mesh(boxGeo, mat);
    const lat = off + sideSign * (HALF + 5.0);
    box.position.set(sm.pos.x + sm.lateral.x * lat, sm.pos.y + 2.1, sm.pos.z + sm.lateral.z * lat);
    box.rotation.y = Math.atan2(sm.tangent.x, sm.tangent.z);
    box.castShadow = true; box.receiveShadow = true;
    group.add(box);
  }

  group.matrixAutoUpdate = false;
  group.updateMatrix();
  scene.add(group);
  return {
    group,
    dispose() {
      g.dispose(); wg.dispose(); boxGeo.dispose();
      laneTex.dispose(); wallTex.dispose(); laneMat.dispose(); wallMat.dispose();
      for (const m of mats) m.dispose();
      scene.remove(group);
    },
  };
}

/**
 * The racing guide — a coloured line painted along the ideal line, telling you
 * where to go and, more importantly, WHEN TO BRAKE.
 *
 *   green   full throttle
 *   yellow  ease off, corner coming
 *   red     brake hard, now
 *
 * The colours are not hand-placed: they come from the same look-ahead braking
 * solver the AI uses, comparing the speed you can carry here against the
 * slowest point ahead. So the red always starts exactly where a good driver
 * would actually hit the brakes.
 */
function buildRacingGuide(scene, track) {
  const STATIONS = Math.max(400, Math.round(track.length / 6));
  const HALF_W = 0.85;
  const RAISE = 0.035;

  // --- chevron texture: arrows pointing the way, on a faint band -----------
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 64, 128);
  x.fillStyle = 'rgba(255,255,255,0.16)';
  x.fillRect(6, 0, 52, 128);                    // the band itself
  x.fillStyle = 'rgba(255,255,255,0.95)';       // the chevron
  x.beginPath();
  x.moveTo(32, 16); x.lineTo(56, 62); x.lineTo(44, 62);
  x.lineTo(32, 38); x.lineTo(20, 62); x.lineTo(8, 62);
  x.closePath(); x.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  // --- decide the action at every station ---------------------------------
  const GREEN = new THREE.Color(0x24d15e);
  const AMBER = new THREE.Color(0xf5c518);
  const RED = new THREE.Color(0xff2f34);
  const pos = [], uv = [], col = [], idx = [];
  const actions = new Float32Array(STATIONS + 1);

  for (let i = 0; i <= STATIONS; i++) {
    const s = (i / STATIONS) * track.length;
    const v = track.targetSpeed(s);
    let demand = 0, slowest = v;
    for (let d = 12; d < 320; d += 12) {
      const vl = track.targetSpeed(s + d);
      if (d <= 190) slowest = Math.min(slowest, vl);
      if (vl >= v) continue;
      const need = (v * v - vl * vl) / (2 * d);
      const cap = 14 + v * 0.36;              // the car's real braking capability
      demand = Math.max(demand, need / cap);
    }
    // Yellow has to be a real warning zone, not the instant between green and
    // red: a corner that will cost you a chunk of speed within ~190 m earns an
    // amber stretch even before the braking demand itself climbs.
    const drop = (v - slowest) / Math.max(1, v);
    actions[i] = Math.max(demand, drop * 0.62);
  }
  // Smooth so the colour bands read as zones rather than flickering stripes.
  for (let pass = 0; pass < 2; pass++) {
    const tmp = actions.slice();
    for (let i = 0; i <= STATIONS; i++) {
      const a = tmp[(i - 1 + STATIONS) % STATIONS], b = tmp[(i + 1) % STATIONS];
      actions[i] = (a + 2 * tmp[i] + b) / 4;
    }
  }

  const colAt = (d) => (d > 0.46 ? RED : d > 0.11 ? AMBER : GREEN);
  let vLen = 0;
  const prev = new THREE.Vector3();
  for (let i = 0; i <= STATIONS; i++) {
    const s = (i / STATIONS) * track.length;
    const sm = track.sample(s);
    const off = track.racingLine(s);
    const cx = sm.pos.x + sm.lateral.x * off;
    const cy = sm.pos.y + sm.lateral.y * off + RAISE;
    const cz = sm.pos.z + sm.lateral.z * off;
    if (i > 0) vLen += Math.hypot(cx - prev.x, cz - prev.z);
    prev.set(cx, cy, cz);
    const k = colAt(actions[i]);
    for (let j = -1; j <= 1; j += 2) {
      pos.push(cx + sm.lateral.x * HALF_W * j, cy, cz + sm.lateral.z * HALF_W * j);
      uv.push((j + 1) * 0.5, vLen / 7);        // a chevron roughly every 7 m
      col.push(k.r, k.g, k.b);
    }
  }
  for (let i = 0; i < STATIONS; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // Unlit, so it reads as paint and stays legible in shadow, at night and in rain.
  const mat = new THREE.MeshBasicMaterial({
    map: tex, vertexColors: true, transparent: true, opacity: 0.92,
    depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  scene.add(mesh);

  let mode = 'full';
  return {
    mesh,
    /** 'off' | 'corners' (only the braking zones) | 'full' */
    setMode(m) {
      mode = m || 'full';
      mesh.visible = mode !== 'off';
      mat.opacity = mode === 'corners' ? 0.0 : 0.92;
      if (mode === 'corners') {
        // Fade the green away and leave only the warnings.
        const a = geo.getAttribute('color');
        for (let i = 0; i <= STATIONS; i++) {
          const show = actions[i] > 0.11 ? 1 : 0;
          const k = colAt(actions[i]);
          for (let j = 0; j < 2; j++) {
            const n = (i * 2 + j) * 3;
            a.array[n] = k.r * show; a.array[n + 1] = k.g * show; a.array[n + 2] = k.b * show;
          }
        }
        a.needsUpdate = true;
        mat.opacity = 0.92;
      }
    },
    update(dt) { tex.offset.y -= dt * 0.55; },   // chevrons flow forward
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); scene.remove(mesh); },
  };
}

// ---------------------------------------------------------------- fallbacks
function buildFallbackWorld(scene) {
  const t = app.track;
  const N = 900, across = 6;
  const pos = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const sm = t.sample((i / N) * t.length);
    for (let j = 0; j <= across; j++) {
      const u = (j / across) * 2 - 1;
      const p = sm.pos.clone().addScaledVector(sm.lateral, u * sm.width);
      pos.push(p.x, p.y + 0.01, p.z);
    }
  }
  const row = across + 1;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const road = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.92 }));
  road.receiveShadow = true;
  // Give the ground a real texture — a flat green plane reads as "the game
  // failed to load" even when everything else is working.
  const gc = document.createElement('canvas'); gc.width = gc.height = 256;
  const gx = gc.getContext('2d');
  gx.fillStyle = '#46603a'; gx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 28 + Math.random() * 55;
    gx.fillStyle = `rgba(${v + 26},${v + 46},${v + 16},0.5)`;
    gx.fillRect(Math.random() * 256, Math.random() * 256, 2, 1 + Math.random() * 3);
  }
  const gTex = new THREE.CanvasTexture(gc);
  gTex.wrapS = gTex.wrapT = THREE.RepeatWrapping;
  gTex.repeat.set(420, 420);
  gTex.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000),
    new THREE.MeshStandardMaterial({ map: gTex, color: 0xffffff, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.35; ground.receiveShadow = true;
  const group = new THREE.Group(); group.add(ground, road);
  scene.add(group);
  app.world = { group, roadMesh: road, outline: t.outline, dispose() { g.dispose(); } };
}

function buildFallbackCar(scene, team) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.55, 5.4),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(team.colors.primary), metalness: 0.4, roughness: 0.35 }),
  );
  body.position.y = 0.45; body.castShadow = true;
  group.add(body);
  const wheels = [];
  const wg = new THREE.CylinderGeometry(0.36, 0.36, 0.34, 18);
  const wm = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.9 });
  for (const [x, z] of [[-0.81, 1.64], [0.81, 1.64], [-0.78, -1.96], [0.78, -1.96]]) {
    const w = new THREE.Mesh(wg, wm);
    w.rotation.z = Math.PI / 2; w.castShadow = true;
    const pivot = new THREE.Group(); pivot.position.set(x, 0.36, z); pivot.add(w);
    group.add(pivot); wheels.push(pivot);
  }
  scene.add(group);
  return {
    group, wheels,
    update(state) {
      for (let i = 0; i < 4; i++) {
        const w = state.wheels[i];
        wheels[i].rotation.y = w.steerAngle;
        wheels[i].children[0].rotation.x = w.spinAngle;
      }
    },
    dispose() { wg.dispose(); wm.dispose(); scene.remove(group); },
  };
}

// ---------------------------------------------------------------- loop
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  app.engine?.resize(w, h);
  app.postfx?.setSize?.(w, h);
  app.hud?.resize?.();
  app.menus?.resize?.();
}

const _tmpV = new THREE.Vector3();

function frame(now) {
  requestAnimationFrame(frame);
  const dtRaw = Math.min(0.1, (now - app.last) / 1000) || 0;
  app.last = now;

  app.frames++; app.fpsTime += dtRaw;
  if (app.fpsTime >= 0.5) { app.fps = app.frames / app.fpsTime; app.frames = 0; app.fpsTime = 0; }

  const input = app.controls ? app.controls.update(dtRaw) : null;

  if (app.running && !app.paused && !app.contextLost) {
    if (input?.pause) { pauseRace(); }
    else {
      stepSimulation(dtRaw, input);
      updateVisuals(dtRaw);
    }
  }
  render(dtRaw);
}

function pauseRace() {
  app.paused = true;
  app.audio?.suspend?.();
  showScreen('pause');
}

function stepSimulation(dtRaw, input) {
  const race = app.race;
  if (!race) return;
  const world = { weather: race.weather, altitude: app.circuit?.ambience?.altitude || 0 };

  // ---- player input -> car ----
  const p = app.player;
  if (p && input) {
    const racing = race.state === 'racing';
    // Every input device (keyboard D, gamepad stick right, touch drag right)
    // means "+ = right". The vehicle's body frame puts +X on the car's LEFT, so
    // a positive steer command turns it left. Negate at this boundary so the
    // player's right is the car's right.
    // The AI is NOT negated: it derives its steer from a target expressed in
    // the same body frame, so it is already self-consistent.
    p.input.steer = -input.steer;
    // W is ALWAYS the throttle and S is ALWAYS the brake. Reverse is a gear,
    // selected with its own key (Z / the REV button) — swapping the pedals
    // under the player was confusing and made the brake look broken.
    if (racing && p.aids.autoGear && input.reverse) {
      if (p.gear === -1) {
        p.gear = 1;
        try { app.hud?.showMessage?.('FORWARD', 'info', 1200); } catch {}
      } else if (p.speed < 2.5) {
        p.gear = -1;
        try { app.hud?.showMessage?.('REVERSE', 'warn', 1600); } catch {}
      } else {
        try { app.hud?.showMessage?.('SLOW DOWN TO REVERSE', 'warn', 1200); } catch {}
      }
    }
    // Leave reverse automatically once rolling forward again.
    if (p.gear === -1 && p.velocity.dot(p.forward) > 2.0) p.gear = 1;

    p.throttle = racing ? input.throttle : 0;
    p.brake = racing ? input.brake : 1;
    p.input.throttle = p.throttle;
    p.input.brake = p.brake;
    p.input.drsRequest = input.drs;
    if (input.ers) p.ers.mode = 3; else p.ers.mode = 1;
    if (p.aids.autoGear) p.autoGear(dtRaw);
    else { if (input.shiftUp) p.shift(1); if (input.shiftDown) p.shift(-1); }
    if (input.camera) {
      const m = app.engine.cycleMode();
      settings.camera = m; saveSettings();
      app.hud?.setCameraMode?.(m);
      app.audio?.playUI?.('click');
    }
    if (input.pit) p.input.pitRequest = !p.input.pitRequest;
    if (input.reset) {
      // Recovery must work at any speed — needing to be almost stopped is
      // useless precisely when you are sliding backwards down an escape road.
      if (race.recoverToTrack) race.recoverToTrack(p);
      else { const s = p.lapDistance; p.reset(s, app.track.racingLine(s), null); }
      app.hud?.showMessage?.('RECOVERED', 'info', 1200);
    }
    app.controls.updateWheelVisual();
  }

  // ---- AI ----
  const aiCtx = { cars: app.cars, weather: race.weather, race, playerPace: race.playerPace };
  for (const ai of app.ais) {
    try { ai.update(dtRaw, aiCtx); } catch (err) { /* one bad driver must not stop the race */ }
  }

  // ---- hold the field until the lights go out ----
  if (race.state === 'grid' || race.state === 'countdown') {
    for (const car of app.cars) {
      car.throttle = 0; car.brake = 1;
      car.input.throttle = 0; car.input.brake = 1;
      if (!car.isPlayer) car.input.steer = 0;
      // Sitting on the grid on the brakes: pin them so nothing creeps or
      // settles into a neighbour before the lights go out.
      car.velocity.set(0, 0, 0);
      car.angularVelocity.set(0, 0, 0);
      for (const w of car.wheels) w.omega = 0;
    }
  }

  // ---- fixed-step physics ----
  app.accumulator += dtRaw;
  let steps = 0;
  while (app.accumulator >= PHYS_DT && steps < 6) {
    for (const car of app.cars) {
      if (car.retired) { car.throttle = 0; car.brake = 1; }
      car.step(PHYS_DT, world);
    }
    app.accumulator -= PHYS_DT;
    steps++;
  }
  if (steps === 6) app.accumulator = 0;   // don't spiral on a slow frame

  try { race.update(dtRaw); } catch (err) { console.warn('[apex] race director', err); }

  if (race.state === 'finished' && app.screen === 'race') {
    app.running = false;
    showScreen('results', buildResults());
  }
}

function buildResults() {
  const rows = app.race.classification.map((e) => ({
    position: e.position,
    driver: e.car.driver.name,
    short: e.car.driver.short,
    number: e.car.driver.num,
    team: e.car.team.name,
    color: e.car.team.colors.primary,
    time: e.finished ? fmt(e.finishTime - app.race.startedAt) : (e.retired ? 'DNF' : '—'),
    gap: e.position === 1 ? '' : (isFinite(e.gapToLeader) ? `+${e.gapToLeader.toFixed(3)}` : ''),
    bestLap: isFinite(e.bestLap) ? fmt(e.bestLap) : '—',
    tyres: e.tyresUsed.map((t) => TYRE_COMPOUNDS[t]?.short || '?').join(' '),
    points: e.points || 0,
    isPlayer: e.car.isPlayer,
    fastest: app.race.fastestLap.car === e.car,
  }));
  return { rows, fastestLap: app.race.fastestLap, circuit: app.circuit };
}

// ---------------------------------------------------------------- visuals
function updateVisuals(dt) {
  const race = app.race, engine = app.engine, cam = engine.camera;
  const player = app.player;
  const w = race.weather;

  // sky + lighting follow the player so shadows stay tight
  try { app.sky?.update?.(w, dt, player ? player.position : cam.position); } catch {}
  if (app.ambient) {
    // 0 at midday, full at night, with a smooth dusk/dawn ramp.
    const h = w.timeOfDay;
    const night = THREE.MathUtils.clamp(
      Math.max((6.6 - h) / 1.6, (h - 18.4) / 1.6), 0, 1,
    );
    app.ambient.intensity = 0.16 + night * 1.35;
    app.ambient.color.setHex(night > 0.5 ? 0x9fb4d8 : 0xbfd0e4);
  }
  if (engine.scene.fog && app.sky?.getFogColor) {
    const c = app.sky.getFogColor();
    // Take the sky's horizon colour but keep it a shade deeper — used raw it is
    // almost white and bleaches the whole skyline.
    if (c) engine.scene.fog.color.copy(c).multiplyScalar(0.80);
  }
  try { app.world?.setWetness?.(w.trackWetness); } catch {}
  try { app.world?.update?.(dt, cam); } catch {}
  try { app.guide?.update(dt); } catch {}
  try { app.weather?.update?.(w, app.cars, cam, dt); } catch {}

  // car models
  for (let i = 0; i < app.cars.length; i++) {
    const car = app.cars[i], model = app.models[i];
    if (!model) continue;
    model.group.position.copy(car.position);
    model.group.quaternion.copy(car.quaternion);
    try { model.update?.(car, dt); } catch {}
    try { model.driverFigure?.update?.(car, dt); model.driverFigure?.setSteer?.(car.steerAngle * 3.2); } catch {}
    if (model.setLOD) {
      const d = model.group.position.distanceTo(cam.position);
      try { model.setLOD(d < 25 ? 0 : d < 80 ? 1 : 2); } catch {}
    }
  }

  // particle emission driven by real tyre state
  if (app.particles) {
    for (const car of app.cars) {
      for (const wheel of car.wheels) {
        if (!wheel.contact) continue;
        const slip = wheel.slipSpeed;
        if ((wheel.lockedUp || wheel.spinning) && slip > 5) {
          _tmpV.copy(car.velocity).multiplyScalar(0.25);
          try { app.particles.emitTyreSmoke(wheel.contactPoint, _tmpV, Math.min(1, slip / 26), w.trackWetness); } catch {}
        }
        if (w.trackWetness > 0.12 && car.speed > 12 && !wheel.front) {
          _tmpV.copy(car.velocity).multiplyScalar(-0.20);
          try { app.particles.emitSpray(wheel.contactPoint, _tmpV, w.trackWetness * Math.min(1, car.speed / 55)); } catch {}
        }
        if (wheel.surface === 'grass' || wheel.surface === 'gravel') {
          _tmpV.copy(car.velocity).multiplyScalar(-0.3);
          try {
            if (wheel.surface === 'grass') app.particles.emitGrass(wheel.contactPoint, _tmpV, Math.min(1, car.speed / 30));
            else app.particles.emitDust(wheel.contactPoint, _tmpV, Math.min(1, car.speed / 30), wheel.surface);
          } catch {}
        }
      }
      if (car.bottomedOut > 0.15 && car.speed > 25) {
        _tmpV.copy(car.velocity).multiplyScalar(-0.4);
        try { app.particles.emitSparks(car.position, _tmpV, car.bottomedOut); } catch {}
      }
    }
    try { app.particles.update(dt, cam); } catch {}
  }

  // camera
  if (player) {
    engine.rig.lookBack = app.controls?.state.look || 0;
    if (player.lastImpact > 0.02) { engine.rig.shake = Math.max(engine.rig.shake, player.lastImpact); player.lastImpact *= 0.6; }
    try { engine.updateCamera(dt, player, app.track, { kerb: player.kerbRumble }); } catch {}
  }

  // post fx
  if (app.postfx) {
    const sp = player ? THREE.MathUtils.clamp(player.speed / 92, 0, 1) : 0;
    try {
      app.postfx.setSpeedBlur?.(settings.motionBlur ? sp * sp : 0);
      app.postfx.setChromatic?.(sp * 0.6);
      if (w.lightning > 0.05) app.postfx.setFlash?.(0xdfe8ff, w.lightning);
      if (player?.lastImpact > 0.05) app.postfx.setImpact?.(player.lastImpact);
    } catch {}
  }

  // Wrong-way warning, throttled so it does not spam the message queue.
  if (player && player.wrongWay) {
    app._wrongWayMsg = (app._wrongWayMsg || 0) - dt;
    if (app._wrongWayMsg <= 0) {
      app._wrongWayMsg = 1.2;
      try { app.hud?.showMessage?.('WRONG WAY', 'warn', 1100); } catch {}
    }
  } else app._wrongWayMsg = 0;

  // audio + hud
  try {
    app.audio?.update?.(dt, {
      player, cars: app.cars, camera: cam, weather: w, race,
      cameraMode: engine.rig.mode,
    });
  } catch {}
  try {
    app.hud?.update?.(dt, {
      player, cars: app.cars, race, track: app.track, weather: w,
      input: app.controls?.state, quality: engine.quality, fps: app.fps,
      entry: app.race.entry(player),
    });
  } catch {}
  if (app.world?.startLights) {
    try { race.lights > 0 ? app.world.startLights.set(race.lights) : app.world.startLights.off(); } catch {}
  }
}

function render(dt) {
  const engine = app.engine;
  if (!engine) return;
  if (app.postfx && app.postfx.enabled !== false) {
    try { app.postfx.render(dt); return; } catch (err) { app.postfx = null; }
  }
  engine.renderer.render(engine.scene, engine.camera);
}

// ---------------------------------------------------------------- go
boot().catch((err) => {
  console.error('[apex] boot failed', err);
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#05070c;color:#fff;font:600 15px/1.6 system-ui,sans-serif;padding:32px;text-align:center;z-index:999';
  el.innerHTML = `<div><div style="font-size:26px;letter-spacing:.25em;margin-bottom:14px">APEX F1</div>
    <div style="opacity:.75;max-width:460px">This browser could not start the game.<br>${String(err && err.message || err)}</div>
    <button onclick="location.reload()" style="margin-top:22px;padding:12px 26px;background:#ff2d55;color:#fff;border:0;border-radius:8px;font:inherit;cursor:pointer">Reload</button></div>`;
  document.body.appendChild(el);
});

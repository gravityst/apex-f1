/**
 * APEX F1 — Vehicle dynamics.
 *
 * A proper rigid-body car: raycast suspension, Pacejka Magic Formula tyres with
 * combined-slip friction ellipse, load-sensitive grip, aero downforce/drag with
 * ground effect, an 8-speed driveline with a limited-slip diff, per-tyre thermal
 * and wear models, ERS and DRS.
 *
 * Body frame: +X right, +Y up, +Z forward.
 */
import * as THREE from 'three';
import { TYRE_COMPOUNDS } from '../game/teams.js';

// ---- scratch (module scope: never allocate in step()) ----------------------
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3();
const _air = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m3 = new THREE.Matrix3();
const _dq = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

export const CHASSIS = {
  mass: 798,                 // kg, car + driver, no fuel
  wheelbase: 3.600,
  trackFront: 1.620,
  trackRear: 1.560,
  cgHeight: 0.290,
  cgBias: 0.455,             // fraction of mass on the front axle
  frontalArea: 1.50,
  length: 5.63, width: 2.00,
  // aero
  ClA: 4.60,                 // lift(down) coefficient x area
  CdA: 1.30,
  aeroBalance: 0.455,        // fraction of downforce at the front axle
  drsDragDelta: -0.30,
  drsLiftDelta: -1.35,
  groundEffectRef: 0.055,    // ride height (m) at which ground effect is nominal
  // suspension
  springFront: 195000, springRear: 172000,   // N/m — F1 is brutally stiff
  damperFront: 12500, damperRear: 11200,
  arbFront: 46000, arbRear: 30000,
  restLength: 0.135, travel: 0.075,
  // wheels
  wheelRadiusF: 0.360, wheelRadiusR: 0.372,
  wheelInertia: 1.35,
  // brakes
  brakeTorqueMax: 27000,     // Nm total
  brakeBias: 0.575,
  // steering
  maxSteer: 0.370,           // rad at the roadwheel (~21.2 deg)
  steerSpeedFalloff: 0.42,
  // driveline
  gearRatios: [13.50, 11.75, 10.22, 8.89, 7.74, 6.73, 5.86, 5.10],
  reverseRatio: -11.0,
  driveEfficiency: 0.94,
  diffLock: 0.55,
  idleRpm: 4200, revLimit: 15000, shiftRpm: 14300,
  // energy
  fuelStart: 100, fuelPerMJ: 0.0000000283,
  ersCapacity: 4.0e6,        // J
  ersMaxPower: 120000,       // W
  ersHarvestPower: 160000,   // W
};

/** Engine torque (Nm at the crank) vs rpm — a modern turbo-hybrid V6 shape. */
const TORQUE_CURVE = [
  [0, 80], [2000, 205], [4000, 320], [6000, 420], [7500, 470],
  [9000, 500], [10500, 512], [11500, 505], [12500, 474], [13500, 432],
  [14500, 378], [15000, 340], [15600, 0],
];  // peak ~620 kW at 12500 rpm — 830 hp ICE, ~1000 hp with ERS deployed
function engineTorque(rpm) {
  if (rpm <= 0) return TORQUE_CURVE[0][1];
  for (let i = 1; i < TORQUE_CURVE.length; i++) {
    if (rpm < TORQUE_CURVE[i][0]) {
      const [r0, t0] = TORQUE_CURVE[i - 1], [r1, t1] = TORQUE_CURVE[i];
      return t0 + (t1 - t0) * ((rpm - r0) / (r1 - r0));
    }
  }
  return 0;
}

// ---- Pacejka Magic Formula -------------------------------------------------
const PJ = {
  // longitudinal
  Bx: 12.0, Cx: 1.62, Ex: 0.38,
  // lateral
  By: 17.5, Cy: 1.36, Ey: -1.10,
  loadSens: 0.140,           // exponent: µ ~ (Fz0/Fz)^loadSens
  Fz0: 2400,                 // reference vertical load, N
  // Rear tyres are 405 mm wide against 305 mm at the front. That larger
  // contact patch is what stops an F1 car being permanently oversteery, since
  // the rear axle also carries the greater share of the load.
  Fz0Front: 2150,
  Fz0Rear: 2980,
  muBase: 1.90,
};
function magic(x, B, C, E, D) {
  const Bx = B * x;
  return D * Math.sin(C * Math.atan(Bx - E * (Bx - Math.atan(Bx))));
}

let _uid = 0;

export function createVehicle(opts = {}) {
  const track = opts.track;
  const team = opts.team;
  const driver = opts.driver;
  const cfg = Object.assign({}, CHASSIS, opts.setup || {});

  const perf = team?.performance ?? 0.95;
  // Constructor pace is expressed as small, believable deltas — never a raw
  // top-speed multiplier, which would look fake.
  const perfPower = 0.955 + perf * 0.055;
  const perfAero = 0.930 + perf * 0.085;

  const wheelDefs = [
    { name: 'FL', x: -cfg.trackFront / 2, z: cfg.wheelbase * cfg.cgBias, front: true },
    { name: 'FR', x: cfg.trackFront / 2, z: cfg.wheelbase * cfg.cgBias, front: true },
    { name: 'RL', x: -cfg.trackRear / 2, z: -cfg.wheelbase * (1 - cfg.cgBias), front: false },
    { name: 'RR', x: cfg.trackRear / 2, z: -cfg.wheelbase * (1 - cfg.cgBias), front: false },
  ];

  const car = {
    id: _uid++,
    isPlayer: !!opts.isPlayer,
    team, driver,
    name: driver?.name ?? 'Driver',
    cfg,

    // rigid body
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, 1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),

    mass: cfg.mass + cfg.fuelStart,
    fuel: cfg.fuelStart,

    // controls
    input: { throttle: 0, brake: 0, steer: 0, drsRequest: false, ersMode: 1, shiftUp: false, shiftDown: false, pitRequest: false },
    throttle: 0, brake: 0, steer: 0, steerAngle: 0,

    // driveline
    gear: 1, rpm: cfg.idleRpm, clutch: 1, shiftTimer: 0, lastShiftUp: true,
    engineOn: true, limiter: false, pitLimiter: false, stalled: false,

    // energy
    ers: { charge: 0.72, deploying: false, mode: 1, harvest: 0, deploy: 0 },
    drs: false, drsAvailable: false, drsAllowed: false,

    // tyres
    tyreCompound: opts.tyre || 'medium',
    wheels: wheelDefs.map((w) => ({
      name: w.name, front: w.front,
      local: new THREE.Vector3(w.x, cfg.restLength + 0.12, w.z),
      radius: w.front ? cfg.wheelRadiusF : cfg.wheelRadiusR,
      omega: 0, spinAngle: 0, steerAngle: 0,
      susLength: cfg.restLength, susVel: 0, compression: 0,
      contact: false, load: 0, surface: 'asphalt', surfaceGrip: 1,
      slipRatio: 0, slipAngle: 0, slipRelax: 0, absCut: 0, absActive: false, surfLift: 0,
      fx: 0, fy: 0,
      temp: 80, coreTemp: 78, wear: 0,
      lockedUp: false, spinning: false,
      worldPos: new THREE.Vector3(),
      contactPoint: new THREE.Vector3(),
      contactNormal: new THREE.Vector3(0, 1, 0),
      slipSpeed: 0, load0: 0,
    })),

    // race telemetry
    speed: 0, gForce: { lat: 0, lon: 0, vert: 1 },
    lapDistance: 0, prevLapDistance: 0, lap: 0, racePosition: 1,
    onTrack: true, offTrackTimer: 0, lateral: 0,
    damage: { frontWing: 0, rearWing: 0, floor: 0, total: 0 },
    aeroScale: 1,
    airborne: false, bottomedOut: 0, kerbRumble: 0,
    slipstream: 0, dirtyAir: 0,
    aids: { tc: 0.45, abs: 0.30, autoGear: true, stability: 0.45 },
    lastImpact: 0, impactCooldown: 0,
    inPit: false, pitState: 'none', pitTimer: 0,
    _hintS: 0,
  };

  // ---- inertia tensor -----------------------------------------------------
  function updateInertia() {
    const m = car.mass;
    car.Ipitch = m * (0.62 * 0.62 + 4.6 * 4.6) / 12;
    car.Iyaw = m * (cfg.width * cfg.width + 4.6 * 4.6) / 12 * 0.86;
    car.Iroll = m * (cfg.width * cfg.width + 0.62 * 0.62) / 12;
  }
  updateInertia();

  // ---- helpers ------------------------------------------------------------
  /**
   * Maximum useful roadwheel angle at a given speed: the kinematic angle for
   * the tightest radius the grip allows, plus roughly the slip angle at peak.
   * Shared with the AI so the two never disagree about available lock.
   */
  function usableSteer(v) {
    // Fitted to measured peak-grip lock: 10 deg at 22 m/s, 6 deg at 33-50,
    // 4 deg at 69. Beyond the peak the fronts simply scrub — at 250 km/h,
    // 20 deg of lock pulls 2.46 g against 3.49 g at 4 deg. A little headroom is
    // left above the peak so the car can still be rotated deliberately.
    const usable = (3.40 / Math.max(6, v) + 0.021) * 1.20;
    return Math.min(cfg.maxSteer, Math.max(0.07, usable));
  }

  function refreshBasis() {
    car.right.set(1, 0, 0).applyQuaternion(car.quaternion);
    car.up.set(0, 1, 0).applyQuaternion(car.quaternion);
    car.forward.set(0, 0, 1).applyQuaternion(car.quaternion);
  }

  function reset(s, lateral, heading) {
    const sm = track.sample(s);
    car.position.copy(sm.pos).addScaledVector(sm.lateral, lateral || 0);
    // Place the car at its true static ride height. Spawning it 0.2 m high and
    // letting it drop makes the whole grid settle and creep before the start.
    const staticDefl = (cfg.mass + cfg.fuelStart) * 9.81 * 0.25
      / ((cfg.springFront + cfg.springRear) * 0.5);
    car.position.y += cfg.wheelRadiusF + (cfg.restLength - staticDefl) - (cfg.restLength + 0.12);
    const h = heading != null ? heading : Math.atan2(sm.tangent.x, sm.tangent.z);
    car.quaternion.setFromAxisAngle(AXIS_Y, h);
    car.velocity.set(0, 0, 0);
    car.angularVelocity.set(0, 0, 0);
    car.gear = 1; car.rpm = cfg.idleRpm; car.speed = 0;
    car.fuel = cfg.fuelStart; car.mass = cfg.mass + car.fuel;
    car.ers.charge = 0.72;
    car.lapDistance = s; car.prevLapDistance = s; car.lap = 0;
    car.damage.frontWing = car.damage.rearWing = car.damage.floor = car.damage.total = 0;
    car.aeroScale = 1;
    car._hintS = s;
    for (const w of car.wheels) {
      w.omega = 0; w.slipRatio = 0; w.slipAngle = 0; w.slipRelax = 0;
      w.susLength = cfg.restLength; w.susVel = 0; w.wear = 0;
      w.temp = 80; w.coreTemp = 78; w.load = 0;
    }
    updateInertia();
    refreshBasis();
  }

  function setTyre(compound) {
    car.tyreCompound = compound;
    for (const w of car.wheels) { w.wear = 0; w.temp = 70; w.coreTemp = 68; }
  }

  // ---- forces accumulators ------------------------------------------------
  const force = new THREE.Vector3();
  const torque = new THREE.Vector3();
  const _fr = new THREE.Vector3();   // dedicated: applyForceAt is called with _a/_b/_e
  const _ft = new THREE.Vector3();
  function applyForceAt(fv, worldPoint) {
    force.add(fv);
    _fr.subVectors(worldPoint, car.position);
    _ft.crossVectors(_fr, fv);
    torque.add(_ft);
  }

  // ---- the step -----------------------------------------------------------
  const SUB = 2;
  function step(dt, world) {
    const h = dt / SUB;
    for (let i = 0; i < SUB; i++) integrate(h, world);
    postStep(dt, world);
    // Safety net: if the solver ever produces a non-finite state (a wild
    // off-track excursion, a bad collision impulse), recover onto the track
    // instead of freezing the whole game.
    if (!isFinite(car.position.x + car.position.y + car.position.z
                + car.velocity.x + car.velocity.y + car.velocity.z
                + car.quaternion.x + car.quaternion.w + car.speed)) {
      const s = isFinite(car._hintS) ? car._hintS : 0;
      reset(s, track.racingLine(s), null);
      car.recovered = (car.recovered || 0) + 1;
    }
  }

  function integrate(dt, world) {
    const weather = world?.weather || { trackWetness: 0, windSpeed: 0, windDir: 0, rainIntensity: 0 };
    const rho = 1.225 * (1 - (world?.altitude || 0) * 0.00009);
    force.set(0, 0, 0);
    torque.set(0, 0, 0);
    refreshBasis();

    // ---------- gravity ----------
    force.y -= car.mass * 9.81;

    // ---------- steering ----------
    const speed = car.velocity.length();
    car.speed = speed;
    // The most steering the front tyres can actually USE. Allowing more does not
    // turn the car harder — it saturates the fronts and washes them wide, which
    // reads as the car sliding around instead of steering. Measured: at 120 km/h
    // half lock pulled 3.50 g while full lock pulled only 2.91 g.
    const targetSteer = car.input.steer * (car.usableSteerOverride || usableSteer(speed));
    // finite steering rate — you cannot snap the wheel instantly
    const rate = 8.5 + 6.0 * (1 - Math.min(1, speed / 60));
    car.steerAngle += THREE.MathUtils.clamp(targetSteer - car.steerAngle, -rate * dt, rate * dt);
    car.steer = car.steerAngle / cfg.maxSteer;
    // Ackermann
    const wb = cfg.wheelbase;
    const sa = car.steerAngle;
    let steerL = sa, steerR = sa;
    if (Math.abs(sa) > 1e-4) {
      const R = wb / Math.tan(Math.abs(sa));
      const inner = Math.atan(wb / Math.max(2, R - cfg.trackFront / 2));
      const outer = Math.atan(wb / (R + cfg.trackFront / 2));
      if (sa > 0) { steerL = inner; steerR = outer; } else { steerL = -outer; steerR = -inner; }
    }
    car.wheels[0].steerAngle = steerL;
    car.wheels[1].steerAngle = steerR;
    car.wheels[2].steerAngle = 0;
    car.wheels[3].steerAngle = 0;

    // ---------- aero ----------
    const damageAero = 1 - Math.min(0.55, car.damage.frontWing * 0.30 + car.damage.rearWing * 0.26 + car.damage.floor * 0.18);
    car.aeroScale = damageAero;
    // relative airspeed (wind matters in the wet / on straights)
    _air.copy(car.velocity);
    if (weather.windSpeed) {
      _air.x -= Math.sin(weather.windDir) * weather.windSpeed * 0.55;
      _air.z -= Math.cos(weather.windDir) * weather.windSpeed * 0.55;
    }
    const vAir = _air.length();
    const vLongAir = Math.max(0, _air.dot(car.forward));

    // ground effect: downforce climbs as the floor gets closer to the road
    const rideF = (car.wheels[0].susLength + car.wheels[1].susLength) * 0.5;
    const rideR = (car.wheels[2].susLength + car.wheels[3].susLength) * 0.5;
    const rideAvg = Math.max(0.012, (rideF * 0.5 + rideR * 0.5) - 0.075);
    const ge = THREE.MathUtils.clamp(Math.pow(cfg.groundEffectRef / rideAvg, 0.55), 0.60, 1.25);

    let ClA = cfg.ClA * perfAero * damageAero * ge;
    let CdA = cfg.CdA;
    if (car.drs) { ClA += cfg.drsLiftDelta; CdA += cfg.drsDragDelta; }
    // slipstream: the car ahead punches a hole in the air
    CdA *= (1 - car.slipstream * 0.29);
    ClA *= (1 - car.dirtyAir * 0.22);
    // wings stall a little at extreme yaw
    const yawAir = Math.abs(Math.atan2(_air.dot(car.right), Math.max(1, vLongAir)));
    ClA *= (1 - Math.min(0.35, yawAir * 0.55));

    const qd = 0.5 * rho * vLongAir * vLongAir;
    const downforce = qd * ClA;
    const drag = qd * CdA + 0.5 * rho * vAir * vAir * 0.10 * yawAir;

    // downforce at the centre of pressure (so it loads the axles correctly)
    const copZ = cfg.wheelbase * (cfg.aeroBalance - (1 - cfg.cgBias));
    _b.copy(car.up).multiplyScalar(-downforce);
    _c.copy(car.position).addScaledVector(car.forward, copZ).addScaledVector(car.up, 0.28);
    applyForceAt(_b, _c);
    if (vAir > 0.1) {
      _b.copy(_air).multiplyScalar(-drag / vAir);
      applyForceAt(_b, car.position);
    }
    car.downforce = downforce;
    car.drag = drag;

    // ---------- suspension + tyres ----------
    const compound = TYRE_COMPOUNDS[car.tyreCompound] || TYRE_COMPOUNDS.medium;
    const wetness = weather.trackWetness || 0;
    let totalLoad = 0;
    let anyContact = false;
    let bottomed = 0;
    let kerbHit = 0;

    // anti-roll bar needs both sides, so compute compressions first
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      _a.copy(w.local).applyQuaternion(car.quaternion).add(car.position);
      w.worldPos.copy(_a);
      _b.copy(car.up).multiplyScalar(-1);           // down in body frame

      // ground plane from the track (banked), with the road surface under the wheel
      const pr = track.project(_a, car._hintS);
      const sm = track.sample(pr.s);
      const groundY = sm.pos.y + sm.lateral.y * pr.lateral;
      _c.set(_a.x, groundY, _a.z);
      _d.copy(sm.normal);
      const denom = _b.dot(_d);
      let dist;
      if (denom > -1e-4) {
        dist = (_a.y - groundY) / Math.max(0.2, car.up.y);
      } else {
        _e.subVectors(_c, _a);
        dist = _e.dot(_d) / denom;
      }
      const surf = track.surfaceAt(pr.s, pr.lateral);
      // Kerbs and gravel sit at a different height, but applying that as an
      // instantaneous step is catastrophic: crossing the boundary at 70 m/s
      // moves the ground 45 mm within a single substep, which drives the
      // damper velocity to its clamp and fires the car metres into the air.
      // Ramp the lift instead — over ~80 ms, which is a few metres of travel.
      const liftTarget = surf.type === 'kerb' ? 0.045 : surf.type === 'gravel' ? -0.030 : 0;
      if (w.surfLift === undefined) w.surfLift = liftTarget;
      w.surfLift += (liftTarget - w.surfLift) * Math.min(1, dt * 12);
      dist -= w.surfLift;

      const newLen = THREE.MathUtils.clamp(dist - w.radius, 0.0, cfg.restLength + cfg.travel);
      w.contactNormal.copy(_d);
      w.surface = surf.type;
      w.surfaceGrip = surf.grip;
      w.surfaceRough = surf.roughness;
      w.surfaceDrag = surf.drag;

      const airborne = dist - w.radius >= cfg.restLength + cfg.travel - 1e-4;
      w.susVel = (newLen - w.susLength) / Math.max(1e-5, dt);
      w.susLength = newLen;
      w.compression = THREE.MathUtils.clamp((cfg.restLength - newLen) / cfg.travel, -1, 1.4);
      w.contact = !airborne;
      if (w.contact) anyContact = true;
      if (newLen <= 0.0005 && !airborne) bottomed = Math.max(bottomed, Math.min(1, Math.abs(w.susVel) * 0.35));
      if (surf.type === 'kerb' && w.contact) kerbHit = Math.max(kerbHit, surf.roughness);
      w._pr = pr.lateral;
      w._prs = pr.s;
    }
    const _hs = track.project(car.position, car._hintS).s;
    if (isFinite(_hs)) car._hintS = _hs;
    car.bottomedOut = bottomed;
    car.kerbRumble = kerbHit;
    car.airborne = !anyContact;

    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      const partner = car.wheels[i ^ 1];
      const k = w.front ? cfg.springFront : cfg.springRear;
      const cD = w.front ? cfg.damperFront : cfg.damperRear;
      const arb = w.front ? cfg.arbFront : cfg.arbRear;

      let Fz = 0;
      if (w.contact) {
        const defl = cfg.restLength - w.susLength;
        const springF = k * defl;
        // The damper velocity MUST be clamped. On a landing, susVel can reach
        // travel/dt (~50 m/s), and 12.5 kNs/m of damping would then produce a
        // 600 kN spike that fires the car into orbit.
        const vDamp = THREE.MathUtils.clamp(w.susVel, -4.0, 4.0);
        const damperF = -cD * vDamp * (vDamp < 0 ? 1.45 : 1.0); // firmer in bump
        const arbF = arb * (defl - (cfg.restLength - partner.susLength)) * 0.5;
        const bump = w.susLength < 0.012 ? (0.012 - w.susLength) * 4.0e5 : 0;
        // Total corner load is bounded too — roughly 8 g of vertical load.
        Fz = THREE.MathUtils.clamp(springF + damperF + arbF + bump, 0, 26000);
        _a.copy(w.contactNormal).multiplyScalar(Fz);
        applyForceAt(_a, w.worldPos);
      }
      w.load0 = Fz;
      w.load = Fz;
      totalLoad += Fz;
    }

    // ---------- driveline ----------
    const rearOmega = (car.wheels[2].omega + car.wheels[3].omega) * 0.5;
    const ratio = car.gear > 0 ? cfg.gearRatios[car.gear - 1] : car.gear < 0 ? cfg.reverseRatio : 0;
    let engineRpm = cfg.idleRpm;
    if (car.gear !== 0 && car.clutch > 0.02) {
      engineRpm = Math.max(cfg.idleRpm, Math.abs(rearOmega * ratio) * 60 / (2 * Math.PI));
    }
    car.rpm += (engineRpm - car.rpm) * Math.min(1, dt * 26);
    car.rpm = THREE.MathUtils.clamp(car.rpm, 0, cfg.revLimit + 400);

    // rev limiter + pit limiter
    let throttle = car.throttle;
    car.limiter = false;
    if (car.rpm > cfg.revLimit) {
      car.limiter = true;
      throttle *= Math.max(0, 1 - (car.rpm - cfg.revLimit) / 260);
    }
    if (car.pitLimiter) {
      const limit = (track.pit && track.pit.speedLimit) || 22.2;
      // A real limiter is a stuttering rev cut, not a smooth clamp.
      if (car.speed > limit) throttle = 0;
      else if (car.speed > limit - 1.2) throttle = Math.min(throttle, 0.18);
      else throttle = Math.min(throttle, 0.55);
    }

    // Traction control: cut torque when the driven wheels break away.
    if (car.aids.tc > 0) {
      const srR = Math.max(car.wheels[2].slipRatio, car.wheels[3].slipRatio);
      const allow = 0.24 - car.aids.tc * 0.13;     // full TC holds ~0.11 slip
      if (srR > allow) {
        const cut = THREE.MathUtils.clamp((srR - allow) * (1.6 + car.aids.tc * 3.0), 0, 1);
        throttle *= (1 - cut * (0.45 + car.aids.tc * 0.50));
      }
    }
    car.tcActive = throttle < car.throttle - 0.02;

    // Reverse is short and deliberately limited — an F1 car does not do 100 km/h
    // backwards, and letting it makes recovery feel broken rather than helpful.
    if (car.gear < 0) {
      const revSpeed = -car.velocity.dot(car.forward);
      if (revSpeed > 9.0) throttle = 0;
      else if (revSpeed > 7.0) throttle = Math.min(throttle, 0.25);
    }

    let tq = engineTorque(car.rpm) * throttle * perfPower;
    // engine braking on a closed throttle
    if (throttle < 0.06 && car.rpm > cfg.idleRpm) tq -= (car.rpm / cfg.revLimit) * 118;
    if (car.fuel <= 0) tq = Math.min(tq, 0);
    if (!car.engineOn) tq = 0;

    // ERS deployment
    car.ers.deploying = false;
    car.ers.deploy = 0;
    if (car.ers.mode > 0 && car.ers.charge > 0.005 && throttle > 0.55 && car.rpm > 6000) {
      const modeScale = [0, 0.55, 1.0, 1.0][Math.min(3, car.ers.mode)];
      const p = cfg.ersMaxPower * modeScale;
      const omegaE = (car.rpm * 2 * Math.PI) / 60;
      if (omegaE > 1) {
        tq += p / omegaE;
        car.ers.charge -= (p * dt) / cfg.ersCapacity;
        car.ers.deploying = true;
        car.ers.deploy = p;
      }
    }
    car.ers.charge = THREE.MathUtils.clamp(car.ers.charge, 0, 1);

    // fuel burn
    if (tq > 0 && car.engineOn) {
      const powerW = tq * (car.rpm * 2 * Math.PI) / 60;
      car.fuel = Math.max(0, car.fuel - powerW * dt * 2.4e-8);
    }

    // torque to the rear wheels through a limited-slip diff
    let driveTorque = tq * ratio * cfg.driveEfficiency * car.clutch;
    if (car.gear === 0) driveTorque = 0;
    const dOmega = car.wheels[2].omega - car.wheels[3].omega;
    const lock = THREE.MathUtils.clamp(dOmega * cfg.diffLock * 26, -Math.abs(driveTorque) * 0.5 - 60, Math.abs(driveTorque) * 0.5 + 60);
    const tqL = driveTorque * 0.5 - lock;
    const tqR = driveTorque * 0.5 + lock;

    // brakes
    const brakeTotal = car.brake * cfg.brakeTorqueMax * (car.pitLimiter ? 1 : 1);
    const brakeF = brakeTotal * cfg.brakeBias * 0.5;
    const brakeR = brakeTotal * (1 - cfg.brakeBias) * 0.5;

    // ---------- per-wheel tyre forces ----------
    let ersHarvest = 0;
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      // contact patch velocity
      _a.subVectors(w.worldPos, car.position);
      _a.y -= w.susLength + w.radius * 0.5;
      _b.crossVectors(car.angularVelocity, _a).add(car.velocity);

      // wheel heading in world
      _q2.setFromAxisAngle(car.up, w.steerAngle);
      _c.copy(car.forward).applyQuaternion(_q2);
      _d.copy(car.right).applyQuaternion(_q2);
      // project onto the contact plane
      _c.addScaledVector(w.contactNormal, -_c.dot(w.contactNormal)).normalize();
      _d.addScaledVector(w.contactNormal, -_d.dot(w.contactNormal)).normalize();

      const vLong = _b.dot(_c);
      const vLat = _b.dot(_d);
      const vAbs = Math.max(Math.abs(vLong), 0.6);

      // slip ratio + slip angle (with relaxation length so it doesn't chatter)
      const sr = THREE.MathUtils.clamp((w.omega * w.radius - vLong) / vAbs, -3.2, 3.2);
      const saRaw = Math.atan2(-vLat, vAbs);
      const relax = 0.42;
      const relaxRate = Math.min(1, (Math.abs(vLong) * dt) / relax + dt * 5);
      w.slipRelax += (saRaw - w.slipRelax) * relaxRate;
      const sa2 = w.slipRelax;
      w.slipRatio = sr;
      w.slipAngle = sa2;
      w.slipSpeed = Math.hypot(w.omega * w.radius - vLong, vLat);

      let Fx = 0, Fy = 0;
      if (w.contact && w.load > 1) {
        // --- friction coefficient ---
        // Load sensitivity as a power law — a linear falloff extrapolates
        // absurdly at the 12 kN per-corner loads an F1 car sees under downforce.
        const fz0 = w.front ? PJ.Fz0Front : PJ.Fz0Rear;
        let mu = PJ.muBase * Math.pow(fz0 / Math.max(400, w.load), PJ.loadSens);
        mu = THREE.MathUtils.clamp(mu, 0.45, PJ.muBase * 1.12);
        mu *= compound.grip;
        mu *= w.surfaceGrip;

        // Temperature and wear are tracked for the HUD but deliberately have
        // only a light touch on grip. Letting them drive it produced races that
        // fell apart on their own — tyres cooking, grip vanishing, cars
        // spinning off — for reasons a player could neither see nor control.
        mu *= 1 - Math.min(0.10, w.wear * 0.10);

        // wet
        if (wetness > 0.01) {
          const isWetTyre = compound.wetGrip != null;
          if (isWetTyre) {
            const ideal = (compound.minWet + compound.maxWet) * 0.5;
            const off = Math.abs(wetness - ideal) / Math.max(0.2, compound.maxWet - compound.minWet);
            mu *= THREE.MathUtils.clamp(1.0 - Math.max(0, off - 0.5) * 0.55, 0.55, 1.0);
            if (wetness < compound.minWet * 0.6) mu *= 0.80;  // wets overheat on a dry line
          } else {
            mu *= (1 - wetness * 0.42);
            // aquaplaning: standing water lifts the contact patch at speed
            const aqua = Math.max(0, wetness - 0.55) * Math.max(0, (Math.abs(vLong) - 42) / 55);
            mu *= Math.max(0.12, 1 - aqua * 1.9);
          }
        }
        w.mu = mu;

        // Deliberate tuning choice: braking grip is boosted over the strict
        // tyre model. The realistic figure is correct but reads as weak and
        // unsatisfying to drive, and stopping the car is the single thing a
        // player judges the handling by. Cornering grip is untouched.
        const D = mu * w.load * (sr < -0.02 ? 1.34 : 1.0);
        const Fx0 = magic(sr, PJ.Bx, PJ.Cx, PJ.Ex, D);
        const Fy0 = magic(sa2, PJ.By, PJ.Cy, PJ.Ey, D);

        // combined slip — friction ellipse clamp
        const mag = Math.hypot(Fx0, Fy0);
        if (mag > D && mag > 1e-3) {
          const k = D / mag;
          Fx = Fx0 * k; Fy = Fy0 * k;
        } else { Fx = Fx0; Fy = Fy0; }

        // low-speed damping so the car settles instead of jittering
        if (Math.abs(vLong) < 1.2) {
          Fy -= vLat * w.load * 0.30;
          Fx -= (vLong - w.omega * w.radius) * w.load * 0.08;
        }
        // rolling resistance + surface drag
        Fx -= Math.sign(vLong) * w.load * (0.012 + w.surfaceDrag);

        w.fx = Fx; w.fy = Fy;

        _e.copy(_c).multiplyScalar(Fx).addScaledVector(_d, Fy);
        _f.copy(w.worldPos).addScaledVector(w.contactNormal, -(w.susLength + w.radius));
        applyForceAt(_e, _f);
        w.contactPoint.copy(_f);
      } else {
        w.fx = 0; w.fy = 0;
        w.mu = 0;
      }

      // --- wheel angular dynamics ---
      const drive = i === 2 ? tqL : i === 3 ? tqR : 0;
      const brakeCap = w.front ? brakeF : brakeR;
      let net = drive - Fx * w.radius;
      // brake torque opposes rotation and must not spin the wheel backwards
      const omegaAfter = w.omega + (net / cfg.wheelInertia) * dt;
      let bt = brakeCap;
      if (car.aids.abs > 0 && w.contact && Math.abs(vLong) > 3) {
        // Proportional slip servo. The previous integrating version wound up to
        // its 0.96 ceiling within three frames of the brake being touched and
        // then bled off at 0.018/frame, so the first moment of braking produced
        // about 1 g instead of 4.6 g — the pedal felt dead. This responds
        // symmetrically and never removes more than 80% of the torque, so hard
        // braking stays hard while the wheel is kept near peak slip.
        const target = -(0.10 + 0.05 * (1 - car.aids.abs));
        const over = target - sr;                       // >0 once past the peak
        const want = THREE.MathUtils.clamp(over * 16.0, 0, 0.95);
        w.absCut += (want - w.absCut) * Math.min(1, dt * 45);
        bt *= (1 - w.absCut);
        w.absActive = w.absCut > 0.05;
      } else { w.absCut = 0; w.absActive = false; }
      const maxStop = Math.abs(omegaAfter) * cfg.wheelInertia / Math.max(1e-5, dt);
      bt = Math.min(bt, maxStop);
      net -= Math.sign(omegaAfter || w.omega || 1) * bt;
      w.omega += (net / cfg.wheelInertia) * dt;
      if (!w.contact) w.omega *= (1 - dt * 0.35);
      w.spinAngle += w.omega * dt;

      // regen harvest under braking on the rear axle
      if (!w.front && car.brake > 0.05 && w.omega > 4) {
        const p = Math.min(cfg.ersHarvestPower * 0.5, bt * w.omega);
        ersHarvest += p;
      }

      w.lockedUp = w.contact && sr < -0.22 && Math.abs(vLong) > 4;
      w.spinning = w.contact && sr > 0.22 && !w.front;

      // --- tyre thermal + wear ---
      // Calibrated so a tyre warms from cold to its window over ~1.5 laps and a
      // race stint (~25 laps) puts a soft around 70-85% worn.
      const slipPower = Math.abs(Fx * (w.omega * w.radius - vLong)) + Math.abs(Fy * vLat);
      const ambient = (world && world.weather ? world.weather.trackTemp : 34) - wetness * 16;
      const airflow = 0.55 + Math.abs(vLong) * 0.032;
      const heat = slipPower * 2.3e-4                       // friction work
                 + w.load * Math.abs(vLong) * 9.0e-6        // rolling deflection
                 + Math.abs(w.load) * 2.0e-5;               // static load
      const cool = (w.temp - ambient) * 0.070 * airflow;
      w.temp += (heat * compound.warmup - cool) * dt;
      w.temp = THREE.MathUtils.clamp(w.temp, -10, 205);
      w.coreTemp += (w.temp - w.coreTemp) * dt * 0.30;

      const overheat = Math.max(0, w.temp - (compound.optimalTemp + compound.tempWindow));
      const wearRate = (slipPower * 0.9e-8 + Math.abs(Fy * vLat) * 0.5e-8) * compound.wearRate;
      w.wear = Math.min(1, w.wear + wearRate * dt);
    }
    car.ers.harvest = ersHarvest;
    if (car.brake > 0.05) car.ers.charge = Math.min(1, car.ers.charge + (ersHarvest * dt) / cfg.ersCapacity);

    // ---------- stability control aid ----------
    if (car.aids.stability > 0) {
      const yawRate = car.angularVelocity.dot(car.up);
      const desired = (car.speed / Math.max(2.4, cfg.wheelbase)) * Math.tan(car.steerAngle);
      const err = desired - yawRate;
      torque.addScaledVector(car.up, err * car.aids.stability * car.mass * 1.45);
    }

    // ---------- integrate ----------
    _a.copy(force).multiplyScalar(dt / car.mass);
    car.velocity.add(_a);
    car.position.addScaledVector(car.velocity, dt);

    // angular: body-frame with gyroscopic term
    _b.copy(torque).applyQuaternion(_q.copy(car.quaternion).invert());
    _c.copy(car.angularVelocity).applyQuaternion(_q);
    const Ix = car.Ipitch, Iy = car.Iyaw, Iz = car.Iroll;
    const gx = (Iy - Iz) * _c.y * _c.z;
    const gy = (Iz - Ix) * _c.z * _c.x;
    const gz = (Ix - Iy) * _c.x * _c.y;
    _d.set((_b.x - gx) / Ix, (_b.y - gy) / Iy, (_b.z - gz) / Iz);
    _c.addScaledVector(_d, dt);
    // angular damping keeps it civilised
    _c.multiplyScalar(1 - Math.min(0.35, dt * (car.airborne ? 0.9 : 1.7)));
    car.angularVelocity.copy(_c).applyQuaternion(car.quaternion);

    const w2 = car.angularVelocity;
    _dq.set(w2.x * dt * 0.5, w2.y * dt * 0.5, w2.z * dt * 0.5, 0).multiply(car.quaternion);
    car.quaternion.x += _dq.x; car.quaternion.y += _dq.y;
    car.quaternion.z += _dq.z; car.quaternion.w += _dq.w;
    car.quaternion.normalize();

    // hard floor: never let the car sink through the world
    const gp = track.project(car.position, car._hintS);
    const gsm = track.sample(gp.s);
    const floorY = gsm.pos.y + gsm.lateral.y * gp.lateral;
    const minY = floorY + 0.045;
    if (car.position.y < minY) {
      car.position.y = minY;
      if (car.velocity.y < 0) car.velocity.y *= -0.10;
      if (car.velocity.y > 6) car.velocity.y = 6;
    }
    // Nothing in this simulation should ever exceed ~430 km/h; if it does the
    // solver has diverged and we bleed it off rather than launch the car.
    if (car.velocity.lengthSq() > 120 * 120) car.velocity.setLength(120);
    const angSq = car.angularVelocity.lengthSq();
    if (angSq > 100) car.angularVelocity.setLength(10);
    car.lateral = gp.lateral;
    car.mass = cfg.mass + car.fuel;
  }

  // ---- keep the car planted ----------------------------------------------
  // An F1 car does not fly or tumble. Rather than hoping the force model never
  // misbehaves, the car is constrained to a sane band above the road and to a
  // sane attitude relative to it. This removes the entire class of "thrown into
  // the air" and "rolled over" failures outright.
  const _roadUp = new THREE.Vector3();
  const _tiltAxis = new THREE.Vector3();
  const _tiltQ = new THREE.Quaternion();
  const MAX_RIDE = 0.55;      // m above the road surface
  const MIN_RIDE = 0.06;
  const MAX_TILT = 0.26;      // ~15 deg away from the road normal

  function constrainToRoad(dt) {
    const pr = track.project(car.position, car._hintS);
    const sm = track.sample(pr.s);
    const roadY = sm.pos.y + sm.lateral.y * pr.lateral;
    const ride = car.position.y - roadY;
    if (ride > MAX_RIDE) {
      car.position.y = roadY + MAX_RIDE;
      if (car.velocity.y > 0) car.velocity.y = 0;
    } else if (ride < MIN_RIDE) {
      car.position.y = roadY + MIN_RIDE;
      if (car.velocity.y < 0) car.velocity.y *= -0.05;
    }
    if (car.velocity.y > 4) car.velocity.y = 4;
    if (car.velocity.y < -14) car.velocity.y = -14;

    // Limit tilt away from the road normal so the car can never barrel-roll.
    _roadUp.copy(sm.normal);
    const d = THREE.MathUtils.clamp(car.up.dot(_roadUp), -1, 1);
    const tilt = Math.acos(d);
    if (tilt > MAX_TILT) {
      _tiltAxis.crossVectors(car.up, _roadUp);
      if (_tiltAxis.lengthSq() > 1e-8) {
        _tiltAxis.normalize();
        _tiltQ.setFromAxisAngle(_tiltAxis, Math.min(tilt - MAX_TILT, dt * 9));
        car.quaternion.premultiply(_tiltQ).normalize();
        car.angularVelocity.multiplyScalar(0.6);
        refreshBasis();
      }
    }
  }

  // ---- per-frame bookkeeping ---------------------------------------------
  function postStep(dt, world) {
    refreshBasis();
    constrainToRoad(dt);
    const pr = track.project(car.position, car._hintS);
    car.prevLapDistance = car.lapDistance;
    const prev = car.lapDistance;
    car.lapDistance = pr.s;
    car.lateral = pr.lateral;
    car.onTrack = Math.abs(pr.lateral) <= track.sample(pr.s).width + 0.9;
    if (!car.onTrack) car.offTrackTimer += dt; else car.offTrackTimer = Math.max(0, car.offTrackTimer - dt * 2);

    // lap counter — only a genuine forward crossing of the line counts
    const d = track.delta(prev, car.lapDistance);
    if (prev > track.length * 0.75 && car.lapDistance < track.length * 0.25 && d > 0) car.lap++;
    else if (prev < track.length * 0.25 && car.lapDistance > track.length * 0.75 && d < 0) car.lap--;

    // g-forces (what the driver actually feels)
    _a.copy(car.velocity);
    const vLong = _a.dot(car.forward);
    if (car._prevVLong == null) car._prevVLong = vLong;
    const aLon = (vLong - car._prevVLong) / Math.max(1e-4, dt);
    car._prevVLong = vLong;
    const yawRate = car.angularVelocity.dot(car.up);
    const aLat = yawRate * vLong;
    car.gForce.lat += (aLat / 9.81 - car.gForce.lat) * Math.min(1, dt * 13);
    car.gForce.lon += (aLon / 9.81 - car.gForce.lon) * Math.min(1, dt * 13);
    car.gForce.vert = car.up.y;

    car.speed = car.velocity.length();
    if (car.impactCooldown > 0) car.impactCooldown -= dt;

    // auto-gearbox / shift logic
    if (car.shiftTimer > 0) {
      car.shiftTimer -= dt;
      car.clutch = THREE.MathUtils.clamp(1 - car.shiftTimer / 0.055, 0.05, 1);
    } else car.clutch = 1;
  }

  // ---- gear control -------------------------------------------------------
  function shift(dir) {
    if (car.shiftTimer > 0) return false;
    const next = car.gear + dir;
    if (next < -1 || next > cfg.gearRatios.length) return false;
    if (next === 0 && car.speed > 3) return false;
    car.gear = next;
    car.shiftTimer = dir > 0 ? 0.048 : 0.062;
    car.lastShiftUp = dir > 0;
    if (dir < 0) car.rpm = Math.min(cfg.revLimit, car.rpm * 1.18);
    return true;
  }

  function autoGear(dt) {
    if (!car.aids.autoGear || car.shiftTimer > 0) return;
    if (car.gear < 0) return;   // reverse is selected deliberately; leave it
    if (car.gear === 0 && car.throttle > 0.1) { car.gear = 1; return; }
    if (car.gear <= 0) return;
    // Shift on ROAD SPEED, not engine rpm. Under wheelspin the rpm pegs the
    // rev limiter and the gearbox climbs to 8th while the car sits still,
    // leaving it with no torque and unable to move at all.
    const vLong = Math.abs(car.velocity.dot(car.forward));
    const rpmFor = (gear) => (vLong / cfg.wheelRadiusR) * cfg.gearRatios[gear - 1] * 60 / (2 * Math.PI);
    if (car.gear < cfg.gearRatios.length && rpmFor(car.gear) > cfg.shiftRpm) shift(1);
    else if (car.gear > 1 && rpmFor(car.gear - 1) < cfg.shiftRpm * 0.86) shift(-1);
  }

  /**
   * Register a collision.
   * @param applyVelocity  false when the caller has already applied a proper
   *   shared impulse (car-to-car). Letting both cars each reflect their own
   *   velocity independently is not a collision — it manufactures energy and
   *   flings them apart.
   */
  function impact(normal, relSpeed, point, isCar, applyVelocity = true) {
    const strength = THREE.MathUtils.clamp(relSpeed / 34, 0, 1);
    if (car.impactCooldown <= 0 && strength > 0.05) {
      car.lastImpact = strength;
      car.impactCooldown = 0.12;
      const nose = _a.subVectors(point, car.position).dot(car.forward);
      if (nose > 1.0) car.damage.frontWing = Math.min(1, car.damage.frontWing + strength * (isCar ? 0.16 : 0.55));
      else if (nose < -1.0) car.damage.rearWing = Math.min(1, car.damage.rearWing + strength * (isCar ? 0.11 : 0.44));
      else car.damage.floor = Math.min(1, car.damage.floor + strength * (isCar ? 0.12 : 0.30));
      car.damage.total = (car.damage.frontWing + car.damage.rearWing + car.damage.floor) / 3;
    }
    if (!applyVelocity) return;
    // velocity response
    const vn = car.velocity.dot(normal);
    if (vn < 0) {
      const restitution = isCar ? 0.24 : 0.30;
      car.velocity.addScaledVector(normal, -vn * (1 + restitution));
      // scrub speed on a wall strike
      if (!isCar) car.velocity.multiplyScalar(1 - Math.min(0.42, strength * 0.60));
      car.angularVelocity.multiplyScalar(0.72);
      _b.subVectors(point, car.position);
      _c.crossVectors(_b, _a.copy(normal).multiplyScalar(-vn * car.mass * 0.05));
      _c.multiplyScalar(1 / car.Iyaw);
      if (_c.lengthSq() > 0.36) _c.setLength(0.6);   // never spin from one hit
      car.angularVelocity.add(_c);
    }
  }

  Object.assign(car, { reset, step, shift, autoGear, impact, setTyre, refreshBasis, engineTorque, updateInertia, usableSteer });
  return car;
}

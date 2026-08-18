/**
 * APEX F1 — AI racing driver.
 *
 * A pure-pursuit line follower with a proper look-ahead braking solver, plus
 * racecraft: slipstreaming, DRS, overtaking, one-move defending, collision
 * avoidance, tyre/fuel management and human-shaped mistakes.
 *
 * Adaptive difficulty: each driver carries a `pace` multiplier that drifts
 * toward a target derived from the player's own measured lap pace, so the field
 * brackets the player instead of rubber-banding onto them.
 */
import * as THREE from 'three';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3();
const _qi = new THREE.Quaternion();

export const DIFFICULTY = {
  rookie:   { base: 0.800, spread: 0.030, mistakes: 1.85, adaptive: false, label: 'Rookie' },
  pro:      { base: 0.868, spread: 0.026, mistakes: 1.15, adaptive: false, label: 'Pro' },
  ace:      { base: 0.925, spread: 0.022, mistakes: 0.72, adaptive: false, label: 'Ace' },
  legend:   { base: 0.962, spread: 0.016, mistakes: 0.36, adaptive: false, label: 'Legend' },
  adaptive: { base: 0.895, spread: 0.030, mistakes: 0.90, adaptive: true,  label: 'Adaptive' },
};

export function createAIDriver(car, track, opts = {}) {
  const d = car.driver || {};
  const diff = DIFFICULTY[opts.difficulty] || DIFFICULTY.adaptive;
  const gridIndex = opts.gridIndex ?? 0;

  // Talent spread across the field: the driver's own rating plus a stable
  // per-entry offset so the order isn't identical every race.
  const talent = (d.skill ?? 0.85);
  const rnd = mulberry(1337 + car.id * 7919 + gridIndex * 104729);
  const seedOffset = (rnd() - 0.5) * 2 * diff.spread;

  const ai = {
    car, track,
    difficulty: opts.difficulty || 'adaptive',
    isAdaptive: diff.adaptive,
    talent,
    aggression: d.aggression ?? 0.75,
    consistency: d.consistency ?? 0.88,
    wetSkill: d.wet ?? 0.85,

    // pace multiplier applied to the reference speed profile
    pace: diff.base + seedOffset + (talent - 0.88) * 0.070,
    paceTarget: 0,
    basePace: diff.base + seedOffset + (talent - 0.88) * 0.070,

    // racecraft state
    mode: 'race',            // 'race' | 'attack' | 'defend' | 'avoid' | 'recover' | 'pit'
    lineOffset: 0,           // metres away from the racing line
    lineOffsetTarget: 0,
    target: new THREE.Vector3(),
    steerFilter: 0,
    prevCrossErr: null,
    crossErr: 0,
    throttleFilter: 0,
    brakeFilter: 0,

    // human imperfection
    reaction: 0.09 + (1 - talent) * 0.22,
    reactionTimer: 0,
    mistakeTimer: 4 + rnd() * 14,
    mistakeActive: 0,
    mistakeKind: 'none',
    driftPhase: rnd() * Math.PI * 2,

    // strategy
    plannedStops: 1,
    pitting: false,
    tyreTarget: 'medium',
    fuelSave: 0,
    lastLapTime: 0,
    _rnd: rnd,
    _lastS: car.lapDistance,
  };

  // ---- adaptive difficulty ------------------------------------------------
  /**
   * @param playerPace  ratio of the player's clean-lap pace to the reference
   *                    profile (1.0 == exactly on the reference).
   */
  function adapt(playerPace, dt) {
    if (!ai.isAdaptive || !playerPace) {
      ai.paceTarget = ai.basePace;
    } else {
      // Bracket the player: fast drivers sit above them, slower ones below,
      // so there is always someone to chase and someone chasing.
      const rank = (gridIndex / 19) - 0.5;              // -0.5 .. +0.5
      const spread = 0.055;
      ai.paceTarget = THREE.MathUtils.clamp(
        playerPace - rank * spread + (talent - 0.88) * 0.045,
        0.74, 0.995,
      );
    }
    // Drift slowly — a visible snap would read as cheating.
    ai.pace += THREE.MathUtils.clamp(ai.paceTarget - ai.pace, -dt * 0.012, dt * 0.012);
  }

  // ---- main update --------------------------------------------------------
  function update(dt, ctx) {
    const c = ai.car;
    const cars = ctx.cars || [];
    const weather = ctx.weather || { trackWetness: 0, rainIntensity: 0 };
    const race = ctx.race || {};

    adapt(ctx.playerPace, dt);

    const s = c.lapDistance;
    const v = c.speed;

    // ---------- grip budget this driver believes it has ----------
    const wet = weather.trackWetness || 0;
    const wetPace = 1 - wet * (0.20 - ai.wetSkill * 0.11);
    const wearAvg = (c.wheels[2].wear + c.wheels[3].wear) * 0.5;
    const wearPace = 1 - wearAvg * 0.055;
    const damagePace = 1 - c.damage.total * 0.22;
    let pace = ai.pace * wetPace * wearPace * damagePace;

    // If we are actually on grass or gravel, back right off — chasing a dry
    // racing-line speed target on a 0.5 grip surface just ends in the wall.
    const surfGrip = (c.wheels[0].surfaceGrip + c.wheels[2].surfaceGrip) * 0.5;
    if (surfGrip < 0.92) pace *= THREE.MathUtils.clamp(0.42 + surfGrip * 0.55, 0.42, 1);

    // Formation/standing start and safety car neutralise pace.
    // Nobody moves before the lights go out. Without this the whole field
    // accelerates through the countdown and rear-ends the grid.
    if (race.state === 'grid' || race.state === 'countdown') {
      c.throttle = 0; c.brake = 1;
      c.input.throttle = 0; c.input.brake = 1; c.input.steer = 0;
      ai.throttleFilter = 0; ai.brakeFilter = 1; ai.steerFilter = 0;
      c.gear = 1;
      return;
    }
    if (race.state === 'formation') pace *= 0.42;
    if (race.safetyCar) pace *= 0.58;

    // ---------- mistakes ----------
    ai.mistakeTimer -= dt;
    if (ai.mistakeTimer <= 0) {
      const chance = (1 - ai.consistency) * diff.mistakes * (1 + wet * 1.5);
      ai.mistakeTimer = 7 + ai._rnd() * 22;
      if (ai._rnd() < chance) {
        ai.mistakeActive = 0.5 + ai._rnd() * 1.4;
        const r = ai._rnd();
        ai.mistakeKind = r < 0.42 ? 'wide' : r < 0.72 ? 'late' : r < 0.9 ? 'lockup' : 'snap';
      }
    }
    if (ai.mistakeActive > 0) ai.mistakeActive -= dt;
    const mist = ai.mistakeActive > 0 ? ai.mistakeKind : 'none';

    // ---------- situational awareness ----------
    let ahead = null, aheadGap = Infinity;
    let behind = null, behindGap = Infinity;
    let sideL = null, sideR = null;
    for (let i = 0; i < cars.length; i++) {
      const o = cars[i];
      if (o === c || o.retired) continue;
      const gap = track.delta(s, o.lapDistance);
      const latDelta = o.lateral - c.lateral;
      if (gap > 0 && gap < 90 && gap < aheadGap) { aheadGap = gap; ahead = o; }
      if (gap < 0 && gap > -60 && -gap < behindGap) { behindGap = -gap; behind = o; }
      if (Math.abs(gap) < 7.4) {
        if (latDelta < -0.8 && latDelta > -6.0) sideL = o;
        if (latDelta > 0.8 && latDelta < 6.0) sideR = o;
      }
    }
    ai.ahead = ahead; ai.aheadGap = aheadGap;

    // slipstream + dirty air
    if (ahead && aheadGap < 55 && Math.abs(ahead.lateral - c.lateral) < 6) {
      c.slipstream = THREE.MathUtils.clamp(1 - aheadGap / 55, 0, 1) * 0.9;
      c.dirtyAir = aheadGap < 26 ? THREE.MathUtils.clamp(1 - aheadGap / 26, 0, 1) : 0;
    } else { c.slipstream *= 0.9; c.dirtyAir *= 0.9; }

    // ---------- choose a mode + lateral offset ----------
    const baseLine = track.racingLine(s);
    let offset = 0;
    ai.mode = 'race';

    if (ahead && aheadGap < 34) {
      const closing = v - ahead.speed;
      const canAttack = closing > -1.5 && (c.drs || aheadGap < 18 || closing > 2.5);
      if (canAttack && ai.aggression > 0.35) {
        ai.mode = 'attack';
        // Pick the side with more room, biased by where the track goes next.
        const sm = track.sample(s + 60);
        const nextCurv = track.lineCurvature(s + 80);
        const insideSign = nextCurv > 0 ? -1 : 1;
        const room = sm.width - 1.4;
        const preferred = (ahead.lateral > 0 ? -1 : 1);
        const sign = Math.abs(nextCurv) > 0.004 ? insideSign : preferred;
        offset = THREE.MathUtils.clamp(baseLine + sign * (2.6 + ai.aggression * 1.7), -room, room) - baseLine;
      } else if (aheadGap < 12) {
        // Too close and can't pass: back out slightly to protect the tyres.
        ai.mode = 'avoid';
        offset = (ahead.lateral > c.lateral ? -1 : 1) * 1.6;
        pace *= 0.985;
      }
    }
    if (behind && behindGap < 16 && ai.mode === 'race' && ai.aggression > 0.5) {
      // One defensive move: take the inside of the next corner.
      const nextCurv = track.lineCurvature(s + 70);
      if (Math.abs(nextCurv) > 0.003) {
        ai.mode = 'defend';
        const sm = track.sample(s + 40);
        const insideSign = nextCurv > 0 ? -1 : 1;
        offset = THREE.MathUtils.clamp(baseLine + insideSign * 1.9, -(sm.width - 1.4), sm.width - 1.4) - baseLine;
      }
    }
    // hard collision avoidance beats everything
    if (sideL || sideR) {
      ai.mode = 'avoid';
      offset += (sideL ? 1 : 0) * 2.1 + (sideR ? -1 : 0) * 2.1;
    }
    if (mist === 'wide') offset += Math.sin(ai.driftPhase + race.time * 1.3) * 2.4;

    ai.lineOffsetTarget = offset;
    ai.lineOffset += (ai.lineOffsetTarget - ai.lineOffset) * Math.min(1, dt * 2.4);

    // pit lane overrides the line entirely
    if (ai.pitting && track.pit.contains(s)) {
      ai.mode = 'pit';
      ai.lineOffset = track.pit.lane(s) - baseLine;
      c.pitLimiter = true;
    } else if (!track.pit.contains(s)) c.pitLimiter = false;

    // ---------- steering: pure pursuit ----------
    const lookDist = THREE.MathUtils.clamp(6 + v * 0.38, 10, 45);
    const aimS = s + lookDist;
    const sm = track.sample(aimS);
    const aimOffset = track.racingLine(aimS) + ai.lineOffset;
    _v.copy(sm.pos).addScaledVector(sm.lateral, aimOffset);
    ai.target.copy(_v);

    _qi.copy(c.quaternion).invert();
    _w.copy(_v).sub(c.position).applyQuaternion(_qi);

    // Geometric pure pursuit: delta = atan(2 L sin(alpha) / Ld). Solving for
    // the roadwheel angle directly is inherently stable, where a raw
    // proportional term on the bearing oscillates and eventually spins the car.
    const alpha = Math.atan2(_w.x, Math.max(2.0, _w.z));
    const Ld = Math.max(6, Math.hypot(_w.x, _w.z));
    const L = c.cfg.wheelbase;
    let delta = Math.atan2(2 * L * Math.sin(alpha), Ld);

    // Map the roadwheel angle back through the car's speed-sensitive steering
    // reduction so a command of 1.0 really means full available lock.
    const sf = 1 / (1 + Math.pow(v / 42, 1.7) * c.cfg.steerSpeedFalloff);
    const effMax = Math.max(0.05, c.cfg.maxSteer * (0.30 + 0.70 * sf));
    let steer = delta / effMax;

    // Cross-track PD. Pure pursuit alone is pure feedforward: with a long
    // look-ahead it corrects a lateral error far too weakly, so once the car
    // is off line it never comes back and simply drives off the circuit.
    const targetLat = track.racingLine(s) + ai.lineOffset;
    const crossErr = c.lateral - targetLat;              // + = right of target
    if (ai.prevCrossErr == null) ai.prevCrossErr = crossErr;
    const crossRate = (crossErr - ai.prevCrossErr) / Math.max(1e-4, dt);
    ai.prevCrossErr = crossErr;
    ai.crossErr = crossErr;
    steer -= THREE.MathUtils.clamp(crossErr * 0.28 + crossRate * 0.30, -1.2, 1.2);

    // Damp the yaw rate, and catch a slide with a bounded correction.
    const yawRate = c.angularVelocity.dot(c.up);
    steer -= yawRate * 0.17;
    const slipRear = (c.wheels[2].slipAngle + c.wheels[3].slipAngle) * 0.5;
    const catch_ = THREE.MathUtils.clamp(slipRear * (1.5 * talent), -0.55, 0.55);
    steer -= catch_ * (mist === 'snap' ? 0.15 : 1);
    if (mist === 'snap') steer += Math.sin(race.time * 9) * 0.20;

    ai.steerFilter += (steer - ai.steerFilter) * Math.min(1, dt * (20 + talent * 14));
    c.input.steer = THREE.MathUtils.clamp(ai.steerFilter, -1, 1);
    ai.slipRear = slipRear;

    // ---------- speed target + look-ahead braking ----------
    let vTarget = track.targetSpeed(s + 8) * pace;
    // Braking solver: scan forward, find the tightest constraint we can still make.
    let brakeDemand = 0;
    const aBrakeCap = (14 + v * 0.36) * (1 - wet * 0.30) * (0.90 + talent * 0.13);
    const margin = 1.0 + (1 - talent) * 0.42 + (mist === 'late' ? -0.30 : 0);
    for (let dAhead = 12; dAhead < 340; dAhead += 12) {
      const vl = track.targetSpeed(s + dAhead) * pace;
      if (vl >= v) continue;
      const needed = (v * v - vl * vl) / (2 * dAhead);
      const ratio = needed / (aBrakeCap / Math.max(0.5, margin));
      if (ratio > brakeDemand) brakeDemand = ratio;
      // NOTE: do NOT clamp vTarget to a distant corner's limit — that would
      // make the car crawl down the whole straight at corner speed. The
      // look-ahead's only job is to decide when to start braking.
    }

    // don't drive into the back of someone
    if (ahead && aheadGap < 40) {
      const closing = v - ahead.speed;
      const safe = 7.5 + v * 0.16 + (ai.mode === 'attack' ? -2.2 : 0);
      if (aheadGap < safe && closing > 0) brakeDemand = Math.max(brakeDemand, 0.55 + closing * 0.09);
      else if (closing > 0) {
        const ttc = (aheadGap - safe) / Math.max(0.4, closing);
        if (ttc < 2.4) brakeDemand = Math.max(brakeDemand, (2.4 - ttc) * 0.70);
      }
    }
    if (ai.mode === 'pit') vTarget = Math.min(vTarget, track.pit.speedLimit - 0.4);

    // ---------- pedals ----------
    let throttle = 0, brake = 0;
    if (brakeDemand > 0.30) {
      brake = THREE.MathUtils.clamp((brakeDemand - 0.30) * 1.55, 0, 1);
      throttle = 0;
    } else {
      const err = vTarget - v;
      throttle = THREE.MathUtils.clamp(err * 0.42 + 0.10, 0, 1);
      if (err < -1.2) brake = THREE.MathUtils.clamp(-err * 0.075, 0, 0.42);
    }
    if (mist === 'lockup') brake = Math.min(1, brake * 1.9 + 0.25);
    // Slide recovery: ease off progressively. A hard cut couples into the yaw
    // and sets up a fishtailing limit cycle.
    const slideMag = Math.abs(slipRear);
    if (slideMag > 0.13) {
      throttle *= THREE.MathUtils.clamp(1 - (slideMag - 0.13) * 1.8, 0.30, 1);
      if (slideMag > 0.34) brake = 0;
    }
    // Off-line recovery: if we are a long way from the racing line, calm down
    // and rejoin rather than trying to race from the grass.
    const lineErr = Math.abs(c.lateral - baseLine);
    if (lineErr > 4.0) {
      const k = THREE.MathUtils.clamp((lineErr - 4.0) / 8, 0, 1);
      throttle *= (1 - k * 0.55);
      vTarget = Math.min(vTarget, track.targetSpeed(s) * (1 - k * 0.35));
    }
    // fuel/tyre management lifts a little
    if (ai.fuelSave > 0) throttle *= (1 - ai.fuelSave * 0.14);

    // corner-exit traction discipline: don't just mash it
    const exitCurv = Math.abs(track.lineCurvature(s + 12));
    if (exitCurv > 0.006 && throttle > 0.3) {
      const grip = 1 - Math.min(0.55, exitCurv * 55) * (1 - talent * 0.45);
      throttle = Math.min(throttle, 0.32 + grip * 0.68);
    }

    ai.throttleFilter += (throttle - ai.throttleFilter) * Math.min(1, dt * 9);
    ai.brakeFilter += (brake - ai.brakeFilter) * Math.min(1, dt * 24);
    c.throttle = THREE.MathUtils.clamp(ai.throttleFilter, 0, 1);
    c.brake = THREE.MathUtils.clamp(ai.brakeFilter, 0, 1);
    c.input.throttle = c.throttle;
    c.input.brake = c.brake;

    // ---------- gearbox + systems ----------
    c.aids.autoGear = true;
    c.autoGear(dt);

    // DRS whenever it's legal and we're committed
    c.input.drsRequest = c.drsAvailable && c.throttle > 0.75 && Math.abs(c.steer) < 0.28;

    // ERS: deploy hard when attacking or on a straight, harvest otherwise
    const straightish = Math.abs(track.lineCurvature(s + 30)) < 0.0035;
    if (ai.mode === 'attack' && c.ers.charge > 0.18) c.ers.mode = 3;
    else if (straightish && c.ers.charge > 0.42) c.ers.mode = 2;
    else if (c.ers.charge < 0.12) c.ers.mode = 0;
    else c.ers.mode = 1;

    ai._lastS = s;
  }

  ai.update = update;
  ai.setDifficulty = (name) => {
    const nd = DIFFICULTY[name] || DIFFICULTY.adaptive;
    ai.difficulty = name; ai.isAdaptive = nd.adaptive;
    ai.basePace = nd.base + seedOffset + (talent - 0.88) * 0.070;
    if (!nd.adaptive) ai.pace = ai.basePace;
  };
  return ai;
}

/** Small deterministic PRNG so a given grid slot always behaves the same way. */
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

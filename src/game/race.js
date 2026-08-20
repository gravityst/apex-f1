/**
 * APEX F1 — Race director.
 *
 * Owns session state, lap/sector timing, the classification, DRS legality,
 * flags and the safety car, penalties, pit stops, car-to-car and car-to-barrier
 * collisions, dynamic weather, and the player-pace measurement that drives
 * adaptive AI difficulty.
 */
import * as THREE from 'three';
import { TYRE_COMPOUNDS } from './teams.js';

const _n = new THREE.Vector3(), _p = new THREE.Vector3(), _r = new THREE.Vector3();
const _ax = new THREE.Vector3(), _bx = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export function createRace(opts) {
  const track = opts.track;
  const cars = opts.cars;
  const circuit = opts.circuit;

  const race = {
    track, cars, circuit,
    state: 'grid',            // grid | countdown | racing | finished | aborted
    time: 0,
    lights: 0,                // 0..5 red lights lit
    totalLaps: opts.laps ?? 10,
    startedAt: 0,
    safetyCar: false, vsc: false, scTimer: 0,
    yellowSectors: [false, false, false],
    redFlag: false,
    fastestLap: { time: Infinity, car: null },
    classification: [],
    events: [],
    finishedCount: 0,
    weather: makeWeather(opts.weather, circuit),
    _tmp: [],
    onEvent: opts.onEvent || (() => {}),
  };

  // ---- per-car race entry -------------------------------------------------
  const entry = new Map();
  for (const c of cars) {
    entry.set(c, {
      car: c,
      lap: 0, lapStart: 0, lastLap: 0, bestLap: Infinity,
      sector: 0, sectorStart: 0,
      sectors: [0, 0, 0], bestSectors: [Infinity, Infinity, Infinity],
      lastSectors: [0, 0, 0],
      // Seed distance by grid slot so the classification is correct on the grid,
      // before anyone has covered any distance.
      totalDistance: -(c.gridIndex || 0) * 0.001, prevS: c.lapDistance,
      position: 1, gapToLeader: 0, gapAhead: 0, interval: 0,
      retired: false, finished: false, finishTime: 0,
      pitStops: 0, inPitLane: false, pitBoxTimer: 0, pitState: 'none',
      pitCommitted: false, pitLaneTime: 0, wrongWay: false, wrongWayTimer: 0, stuckTimer: 0,
      penalties: 0, penaltyTime: 0, warnings: 0,
      trackLimitStrikes: 0, offTrackSince: -1,
      drsEligible: false, drsArmed: false, drsZone: -1,
      tyreLaps: 0, tyresUsed: [c.tyreCompound],
      points: 0,
      cleanLaps: [],
    });
  }
  race.entry = (c) => entry.get(c);

  // ---- weather ------------------------------------------------------------
  function makeWeather(spec, circ) {
    const preset = {
      clear:     { condition: 'clear', rainIntensity: 0, cloud: 0.08 },
      cloudy:    { condition: 'cloudy', rainIntensity: 0, cloud: 0.55 },
      overcast:  { condition: 'overcast', rainIntensity: 0, cloud: 0.85 },
      lightrain: { condition: 'lightrain', rainIntensity: 0.35, cloud: 0.9 },
      rain:      { condition: 'rain', rainIntensity: 0.72, cloud: 0.95 },
      storm:     { condition: 'storm', rainIntensity: 1.0, cloud: 1.0 },
    };
    const dynamic = spec === 'dynamic';
    const base = preset[dynamic ? 'cloudy' : (spec || 'clear')] || preset.clear;
    return {
      ...base,
      dynamic,
      trackWetness: base.rainIntensity > 0 ? base.rainIntensity * 0.7 : 0,
      puddles: 0,
      windSpeed: 3 + Math.random() * 7,
      windDir: Math.random() * Math.PI * 2,
      temperature: 24 - (base.cloud * 6),
      trackTemp: 40 - (base.cloud * 12) - (base.rainIntensity * 12),
      timeOfDay: circ?.ambience?.defaultTimeOfDay ?? 14.5,
      lightning: 0,
      _target: null, _timer: 60 + Math.random() * 120,
    };
  }

  function updateWeather(dt) {
    const w = race.weather;
    if (w.dynamic) {
      w._timer -= dt;
      if (w._timer <= 0) {
        w._timer = 70 + Math.random() * 160;
        const chance = (circuit?.ambience?.rainChance ?? 0.25);
        const r = Math.random();
        const order = ['clear', 'cloudy', 'overcast', 'lightrain', 'rain', 'storm'];
        let idx = order.indexOf(w.condition);
        if (idx < 0) idx = 1;
        // random walk, biased toward the circuit's climate
        idx += (r < 0.5 + chance * 0.3 ? 1 : -1);
        idx = THREE.MathUtils.clamp(idx, 0, r < chance ? 5 : 3);
        w._target = order[idx];
        race.log(`Weather changing: ${order[idx]}`, 'info');
      }
      if (w._target) {
        const targetRain = { clear: 0, cloudy: 0, overcast: 0, lightrain: 0.35, rain: 0.72, storm: 1.0 }[w._target];
        const targetCloud = { clear: 0.08, cloudy: 0.55, overcast: 0.85, lightrain: 0.9, rain: 0.95, storm: 1.0 }[w._target];
        w.rainIntensity += THREE.MathUtils.clamp(targetRain - w.rainIntensity, -dt * 0.045, dt * 0.045);
        w.cloud += THREE.MathUtils.clamp(targetCloud - w.cloud, -dt * 0.05, dt * 0.05);
        if (Math.abs(w.rainIntensity - targetRain) < 0.02) { w.condition = w._target; w._target = null; }
      }
    }
    // The track wets and dries on its own clock — much slower than the rain.
    const wetTarget = w.rainIntensity > 0.02 ? Math.min(1, w.rainIntensity * 0.95 + 0.06) : 0;
    const rate = w.rainIntensity > 0.02 ? 0.030 : 0.011;   // dries slower than it wets
    w.trackWetness += THREE.MathUtils.clamp(wetTarget - w.trackWetness, -dt * rate, dt * rate * 2.2);
    w.trackWetness = THREE.MathUtils.clamp(w.trackWetness, 0, 1);
    w.puddles = Math.max(0, w.trackWetness - 0.45) / 0.55;
    w.trackTemp += ((38 - w.cloud * 12 - w.rainIntensity * 14) - w.trackTemp) * dt * 0.05;
    if (w.condition === 'storm' && Math.random() < dt * 0.10) w.lightning = 1;
    w.lightning = Math.max(0, w.lightning - dt * 3);
    w.windDir += (Math.random() - 0.5) * dt * 0.08;
  }

  race.log = (text, kind) => {
    race.events.push({ text, kind, t: race.time });
    if (race.events.length > 40) race.events.shift();
    race.onEvent(text, kind);
  };

  // ---- start procedure ----------------------------------------------------
  let lightTimer = 0, holdTimer = 0;
  function startCountdown() {
    race.state = 'countdown';
    race.lights = 0; lightTimer = 0; holdTimer = 0;
  }
  race.startCountdown = startCountdown;

  function updateCountdown(dt) {
    lightTimer += dt;
    if (race.lights < 5) {
      if (lightTimer >= 1.0) { lightTimer = 0; race.lights++; if (race.lights === 5) holdTimer = 0.9 + Math.random() * 2.1; }
    } else {
      holdTimer -= dt;
      if (holdTimer <= 0) {
        race.lights = 0;
        race.state = 'racing';
        race.startedAt = race.time;
        for (const c of cars) { const e = entry.get(c); e.lapStart = race.time; e.sectorStart = race.time; }
        race.log('LIGHTS OUT', 'lightsout');
      }
    }
  }

  // ---- timing -------------------------------------------------------------
  function updateTiming(dt) {
    for (const c of cars) {
      const e = entry.get(c);
      if (e.retired || e.finished) continue;
      const s = c.lapDistance;
      const d = track.delta(e.prevS, s);
      if (d > 0 && d < track.length * 0.5) e.totalDistance += d;

      // line crossing
      const crossed = e.prevS > track.length * 0.7 && s < track.length * 0.3;
      if (crossed && race.state === 'racing') {
        const lapTime = race.time - e.lapStart;
        if (e.lap > 0 && lapTime > 8) {
          e.lastLap = lapTime;
          finishSector(e, 2);
          e.lastSectors = e.sectors.slice();
          const clean = c.offTrackTimer < 0.15 && c.lastImpact < 0.05 && !e.inPitLane;
          if (lapTime < e.bestLap) e.bestLap = lapTime;
          if (clean) { e.cleanLaps.push(lapTime); if (e.cleanLaps.length > 5) e.cleanLaps.shift(); }
          if (lapTime < race.fastestLap.time && clean) {
            race.fastestLap = { time: lapTime, car: c };
            race.log(`${c.driver.short} FASTEST LAP ${fmt(lapTime)}`, 'fastlap');
          }
        }
        e.lap++;
        e.tyreLaps++;
        e.lapStart = race.time;
        e.sector = 0; e.sectorStart = race.time;
        if (e.lap > race.totalLaps) finishCar(e);
      }

      // sectors
      const sec = track.sectorOf(s);
      if (sec !== e.sector && !crossed) {
        if (sec === e.sector + 1) { finishSector(e, e.sector); e.sector = sec; e.sectorStart = race.time; }
        else e.sector = sec;
      }
      e.prevS = s;
    }
  }
  function finishSector(e, idx) {
    const t = race.time - e.sectorStart;
    if (t > 1 && idx >= 0 && idx < 3) {
      e.sectors[idx] = t;
      if (t < e.bestSectors[idx]) e.bestSectors[idx] = t;
    }
  }
  function finishCar(e) {
    e.finished = true;
    e.finishTime = race.time;
    e.car.throttle = 0;
    race.finishedCount++;
    if (race.finishedCount === 1) race.log('CHEQUERED FLAG', 'chequered');
  }

  // ---- positions ----------------------------------------------------------
  function updatePositions() {
    const list = race._tmp;
    list.length = 0;
    for (const c of cars) list.push(entry.get(c));
    list.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.retired !== b.retired) return a.retired ? 1 : -1;
      return b.totalDistance - a.totalDistance;
    });
    const leader = list[0];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      e.position = i + 1;
      e.car.racePosition = i + 1;
      const dist = leader.totalDistance - e.totalDistance;
      const v = Math.max(12, e.car.speed);
      e.gapToLeader = e.finished && leader.finished ? e.finishTime - leader.finishTime : dist / v;
      if (i > 0) {
        const prev = list[i - 1];
        e.interval = (prev.totalDistance - e.totalDistance) / v;
        e.lapsDown = Math.floor((prev.totalDistance - e.totalDistance) / track.length);
      } else { e.interval = 0; e.lapsDown = 0; }
    }
    race.classification = list.slice();
  }

  // ---- DRS ----------------------------------------------------------------
  function updateDRS() {
    const wetBan = race.weather.trackWetness > 0.30;
    for (const c of cars) {
      const e = entry.get(c);
      const s = c.lapDistance;
      // arm at a detection point if within 1.0s of the car ahead
      const detected = track.atDRSDetect(e.prevS, s);
      if (detected >= 0) {
        let gapTime = Infinity;
        for (const o of cars) {
          if (o === c) continue;
          const oe = entry.get(o);
          if (oe.retired) continue;
          const gap = track.delta(s, o.lapDistance);
          if (gap > 0 && gap < 200) gapTime = Math.min(gapTime, gap / Math.max(14, c.speed));
        }
        e.drsArmed = gapTime <= 1.0;
      }
      const zone = track.inDRS(s);
      const legal = zone >= 0 && e.drsArmed && !race.safetyCar && !race.vsc && !wetBan
        && race.state === 'racing' && e.lap >= 2 && !e.inPitLane;
      c.drsAvailable = legal;
      c.drs = legal && c.input.drsRequest;
      if (zone < 0) { /* leaving the zone disarms nothing; detection re-arms */ }
      e.drsZone = zone;
    }
  }

  // ---- track limits + penalties ------------------------------------------
  function updateLimits(dt) {
    for (const c of cars) {
      const e = entry.get(c);
      if (e.retired || e.finished) continue;
      const w = track.sample(c.lapDistance).width;
      const fullyOff = Math.abs(c.lateral) > w + 1.9;
      // A car committed to the pits is legitimately off the racing surface —
      // it must not collect track-limits strikes on the way in or out.
      // Only police limits for a car actually racing. One parked in the gravel
      // or crawling back on gains nothing, and stacking penalties on it just
      // punishes a single bad moment over and over.
      const racingPace = c.speed > 14 && !e.wrongWay;
      if (fullyOff && racingPace && !e.inPitLane && !e.pitCommitted && race.state === 'racing') {
        if (e.offTrackSince < 0) e.offTrackSince = race.time;
        else if (race.time - e.offTrackSince > 0.35) {
          e.offTrackSince = race.time + 2.5;    // debounce
          e.trackLimitStrikes++;
          if (c.isPlayer) {
            if (e.trackLimitStrikes % 3 === 0) {
              e.penalties++; e.penaltyTime += 5;
              race.log('5 SECOND PENALTY — TRACK LIMITS', 'penalty');
            } else race.log(`TRACK LIMITS ${e.trackLimitStrikes}/3`, 'warn');
          }
        }
      } else if (!fullyOff) e.offTrackSince = -1;

      // Pit-lane speeding — only for a car that actually committed to the pits,
      // and only after a short grace period so entering at speed isn't punished
      // before the driver has had a chance to slow down.
      if (e.inPitLane && race.state === 'racing') {
        e.pitLaneTime = (e.pitLaneTime || 0) + dt;
        if (e.pitLaneTime > 1.6 && c.speed > track.pit.speedLimit + 1.5 && !e._speedFlag) {
          e._speedFlag = true; e.penalties++; e.penaltyTime += 5;
          if (c.isPlayer) race.log('PIT LANE SPEEDING — 5s PENALTY', 'penalty');
        }
      } else { e._speedFlag = false; e.pitLaneTime = 0; }
    }
  }

  // ---- pit stops ----------------------------------------------------------
  function updatePits(dt) {
    for (const c of cars) {
      const e = entry.get(c);
      const laneOff = track.pit.lane(c.lapDistance);
      const inRegion = track.pit.contains(c.lapDistance);

      // A car is in the pit lane only if it DELIBERATELY entered it. The lane
      // sits out in the run-off, so a purely geometric test flags anyone who
      // runs wide anywhere near the pit straight — which then hands them a
      // pit-lane speeding penalty for a simple off-track moment.
      const wantsPit = c.isPlayer ? !!c.input.pitRequest : !!c.wantsPit;
      if (!inRegion && Math.abs(c.lateral) < track.sample(c.lapDistance).width + 3) {
        e.pitCommitted = false;
      }
      else if (!e.pitCommitted && wantsPit) {
        // Commit only near the entry, and only if actually heading for the lane.
        const intoLane = ((c.lapDistance - track.pit.entryS + track.length) % track.length) < 120;
        if (intoLane) e.pitCommitted = true;
      }
      const inLane = e.pitCommitted
        && inRegion
        && Math.abs(laneOff) > 6
        && Math.abs(c.lateral - laneOff) < 4.5;
      e.inPitLane = inLane;
      if (!inLane) { if (e.pitState === 'done') e.pitState = 'none'; continue; }

      const boxS = track.pit.boxS[Math.min(track.pit.boxS.length - 1, e.position - 1)];
      const atBox = Math.abs(track.delta(c.lapDistance, boxS)) < 3.2;
      if (e.pitState === 'none' && atBox && c.speed < 9) {
        e.pitState = 'stopped';
        e.pitBoxTimer = 2.1 + Math.random() * 0.9 + (c.damage.frontWing > 0.4 ? 9 : 0);
        e.pitStops++;
      }
      if (e.pitState === 'stopped') {
        c.velocity.multiplyScalar(0.001);
        c.throttle = 0; c.brake = 1;
        e.pitBoxTimer -= dt;
        if (e.pitBoxTimer <= 0) {
          e.pitState = 'done';
          const wet = race.weather.trackWetness;
          const target = wet > 0.55 ? 'wet' : wet > 0.15 ? 'inter' : (e.pitTyreTarget || pickDryTyre(e));
          c.setTyre(target);
          e.tyresUsed.push(target);
          e.tyreLaps = 0;
          c.damage.frontWing = 0; c.damage.rearWing = 0;
          c.damage.total = c.damage.floor / 3;
          c.fuel = Math.min(c.cfg.fuelStart, c.fuel + 0);
          if (c.isPlayer) race.log(`TYRES: ${TYRE_COMPOUNDS[target].name.toUpperCase()}`, 'pit');
        }
      }
    }
  }
  function pickDryTyre(e) {
    const used = new Set(e.tyresUsed);
    if (!used.has('medium')) return 'medium';
    if (!used.has('hard')) return 'hard';
    return 'soft';
  }

  // ---- collisions ---------------------------------------------------------
  const HALF_L = 2.82, HALF_W = 1.00;
  function updateCollisions(dt) {
    // barriers
    for (const c of cars) {
      const e = entry.get(c);
      if (e.retired) continue;
      const limit = track.wallAt(c.lapDistance);
      const over = Math.abs(c.lateral) - limit;
      if (over > 30) {
        // The barrier is a corridor around the centreline, which cannot contain
        // a car that has reached the infield of a circuit that loops back on
        // itself — from there it can wander indefinitely. Put it back.
        recoverToTrack(c);
        if (c.isPlayer) race.log('RECOVERED TO TRACK', 'info');
      } else if (over > 0) {
        const sm = track.sample(c.lapDistance);
        const sign = Math.sign(c.lateral);
        _n.copy(sm.lateral).multiplyScalar(-sign);      // inward normal
        const vn = c.velocity.dot(_n);
        c.position.addScaledVector(sm.lateral, -sign * over);
        _p.copy(c.position).addScaledVector(sm.lateral, sign * 1.0);
        // Only a genuine impact if the car is moving INTO the barrier. Resting
        // against it would otherwise scrub speed every single frame and pin the
        // car there permanently with the throttle wide open.
        if (vn < -0.8) c.impact(_n, Math.abs(vn), _p, false);
        else if (vn < 0) c.velocity.addScaledVector(_n, -vn);
        if (c.isPlayer && Math.abs(vn) > 12) race.log('CONTACT — BARRIER', 'warn');
      }
    }
    // car to car — only pairs that are actually near each other on the lap
    const sorted = race.classification;
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i].car;
      if (sorted[i].retired) continue;
      for (let j = i + 1; j < Math.min(sorted.length, i + 5); j++) {
        const b = sorted[j].car;
        if (sorted[j].retired) continue;
        _r.subVectors(b.position, a.position);
        const distSq = _r.lengthSq();
        if (distSq > 42) continue;
        const dist = Math.sqrt(Math.max(1e-6, distSq));
        // separating-axis-lite: project onto each car's forward/right
        _ax.copy(a.forward); _bx.copy(a.right);
        const alon = Math.abs(_r.dot(_ax)), alat = Math.abs(_r.dot(_bx));
        if (alon > HALF_L * 2 || alat > HALF_W * 2) continue;
        const pen = Math.min(HALF_L * 2 - alon, HALF_W * 2 - alat);
        if (pen <= 0) continue;
        // Resolve in the horizontal plane only. A normal with a vertical
        // component makes a concertina'd grid launch cars into the sky.
        _n.set(_r.x, 0, _r.z);
        const hLen = _n.length();
        if (hLen < 1e-4) _n.set(1, 0, 0); else _n.multiplyScalar(1 / hLen);
        const relV = _p.subVectors(b.velocity, a.velocity).dot(_n);
        const push = Math.min(pen * 0.5 + 0.01, 0.45);   // never teleport a car
        a.position.addScaledVector(_n, -push);
        b.position.addScaledVector(_n, push);
        if (relV < 0) {
          _p.copy(a.position).addScaledVector(_n, HALF_W);
          // One shared impulse between the pair, with a low restitution — F1
          // cars scrape and nudge, they do not bounce off each other. Having
          // each car independently reflect its own velocity (what this used to
          // do) creates energy and throws them both away from the contact.
          const ma = a.mass, mb = b.mass;
          const e = 0.10;
          const j = Math.min(-(1 + e) * relV / (1 / ma + 1 / mb), 30000);
          a.velocity.addScaledVector(_n, -j / ma);
          b.velocity.addScaledVector(_n, j / mb);
          // A bounded yaw disturbance, not a launch.
          const spin = Math.min(j / 120000, 0.45);
          const sideA = Math.sign(_r.dot(a.right)) || 1;
          const sideB = Math.sign(_r.dot(b.right)) || 1;
          a.angularVelocity.y -= spin * sideA;
          b.angularVelocity.y += spin * sideB;
          a.impact(_n, -relV, _p, true, false);
          _n.multiplyScalar(-1);
          b.impact(_n, -relV, _p, true, false);
          _n.multiplyScalar(-1);
          const sev = Math.abs(relV);
          if (sev > 9 && (a.isPlayer || b.isPlayer)) race.log('CONTACT', 'warn');
          if (sev > 34) {
            for (const cc of [a, b]) {
              if (cc.damage.total > 0.92 && Math.random() < 0.10) retire(entry.get(cc), 'accident damage');
            }
          }
        }
      }
    }
  }
  function retire(e, reason) {
    if (e.retired) return;
    e.retired = true;
    e.car.retired = true;
    e.car.throttle = 0; e.car.brake = 1;
    race.log(`${e.car.driver.short} RETIRES — ${reason}`, 'warn');
    maybeSafetyCar();
  }
  race.retire = retire;

  function maybeSafetyCar() {
    if (race.safetyCar || race.vsc || race.state !== 'racing') return;
    if (Math.random() < 0.45) {
      race.safetyCar = true; race.scTimer = 32 + Math.random() * 30;
      race.log('SAFETY CAR DEPLOYED', 'sc');
    } else {
      race.vsc = true; race.scTimer = 16 + Math.random() * 14;
      race.log('VIRTUAL SAFETY CAR', 'vsc');
    }
  }
  function updateSafetyCar(dt) {
    if (!race.safetyCar && !race.vsc) return;
    race.scTimer -= dt;
    if (race.scTimer <= 0) {
      if (race.safetyCar) race.log('SAFETY CAR IN THIS LAP — GREEN', 'green');
      else race.log('VSC ENDING — GREEN', 'green');
      race.safetyCar = false; race.vsc = false;
    }
  }

  // ---- stuck cars ---------------------------------------------------------
  // A car beached in a gravel trap or facing the wrong way must not hold the
  // whole session open forever.
  function updateStuck(dt) {
    if (race.state !== 'racing') return;
    for (const c of cars) {
      const e = entry.get(c);
      if (e.retired || e.finished) continue;

      // Which way is this car pointing round the lap?
      const tang = track.sample(c.lapDistance).tangent;
      e.wrongWay = c.forward.dot(tang) < -0.25 && c.speed > 3;
      c.wrongWay = e.wrongWay;

      // Braking to a standstill ON the track is something a driver chooses to
      // do; it must not be mistaken for being beached. Only a car that is off
      // the surface, pointing the wrong way, or otherwise unable to move counts.
      const halfW = track.sample(c.lapDistance).width;
      const offSurface = Math.abs(c.lateral) > halfW + 1.0;
      const deliberateStop = c.isPlayer && c.brake > 0.5 && !offSurface && !e.wrongWay;
      const beached = c.speed < 2.2 && !e.inPitLane && e.pitState !== 'stopped' && !deliberateStop;
      if (beached) {
        e.stuckTimer = (e.stuckTimer || 0) + dt;
        // A player pinned against a barrier with the throttle open must not sit
        // there for twenty seconds collecting penalties.
        const limit = c.isPlayer ? 3.5 : 10;
        if (e.stuckTimer > limit) {
          if (c.isPlayer) {
            recoverToTrack(c);
            e.stuckTimer = 0;
            race.log('RECOVERED TO TRACK', 'info');
          } else retire(e, 'beached');
        }
      } else e.stuckTimer = 0;

      // Driving the wrong way for a sustained period also gets a recovery.
      if (e.wrongWay) {
        e.wrongWayTimer = (e.wrongWayTimer || 0) + dt;
        if (c.isPlayer && e.wrongWayTimer > 4) {
          recoverToTrack(c);
          e.wrongWayTimer = 0;
          race.log('WRONG WAY — RECOVERED', 'warn');
        }
      } else e.wrongWayTimer = 0;
    }
  }

  /**
   * Put a car back on the racing line pointing the right way.
   * Deliberately does NOT call reset(): that is the race-start path and would
   * wipe the lap count, fuel load, tyre wear, damage and ERS charge.
   */
  function recoverToTrack(c) {
    const s2 = c.lapDistance;
    const sm = track.sample(s2);
    const lat = track.racingLine(s2);
    const keep = Math.min(c.speed, 18);
    c.position.copy(sm.pos).addScaledVector(sm.lateral, lat);
    c.position.y += 0.28;
    c.quaternion.setFromAxisAngle(UP, Math.atan2(sm.tangent.x, sm.tangent.z));
    if (c.refreshBasis) c.refreshBasis();
    c.velocity.copy(c.forward).multiplyScalar(keep);
    c.angularVelocity.set(0, 0, 0);
    for (const w of c.wheels) {
      w.omega = keep / Math.max(0.1, w.radius);
      w.slipRelax = 0; w.absCut = 0; w.susVel = 0;
    }
    c.gear = keep > 8 ? 2 : 1;
    const e = entry.get(c);
    if (e) { e.offTrackSince = -1; e.stuckTimer = 0; e.wrongWayTimer = 0; }
  }
  race.recoverToTrack = recoverToTrack;

  // ---- reliability --------------------------------------------------------
  function updateReliability(dt) {
    if (race.state !== 'racing') return;
    for (const c of cars) {
      const e = entry.get(c);
      if (e.retired || e.finished || c.isPlayer) continue;
      const rel = c.team?.reliability ?? 0.95;
      const risk = (1 - rel) * 0.000035 * (1 + c.damage.total * 3);
      if (Math.random() < risk * dt * 60) retire(e, Math.random() < 0.5 ? 'power unit' : 'hydraulics');
    }
  }

  // ---- player pace (feeds adaptive AI) -----------------------------------
  const paceState = { value: 0, samples: [], live: 0 };
  function updatePlayerPace(dt) {
    const player = cars.find((c) => c.isPlayer);
    if (!player) return;
    const e = entry.get(player);
    const ref = track.referenceLapTime;
    // Completed clean laps are the strongest signal.
    if (e.cleanLaps.length) {
      const best = Math.min(...e.cleanLaps);
      paceState.value = THREE.MathUtils.clamp(ref / best, 0.55, 1.15);
    }
    // Within the first lap, fall back to a live speed-vs-reference ratio so the
    // AI is already calibrated before the player has set a time.
    const refV = track.targetSpeed(player.lapDistance);
    const live = THREE.MathUtils.clamp(player.speed / Math.max(12, refV), 0.4, 1.25);
    paceState.live += (live - paceState.live) * Math.min(1, dt * 0.22);
    race.playerPace = e.cleanLaps.length
      ? paceState.value * 0.82 + paceState.live * 0.18
      : paceState.live;
  }

  // ---- main ---------------------------------------------------------------
  function update(dt) {
    race.time += dt;
    updateWeather(dt);
    if (race.state === 'countdown') updateCountdown(dt);
    if (race.state === 'grid' || race.state === 'countdown') {
      for (const c of cars) { c.throttle = 0; c.brake = 1; }
    }
    updateTiming(dt);
    updatePositions();
    updateDRS();
    updatePits(dt);
    updateLimits(dt);
    updateCollisions(dt);
    updateSafetyCar(dt);
    updateStuck(dt);
    updateReliability(dt);
    updatePlayerPace(dt);

    if (race.state === 'racing') {
      const active = race.classification.filter((e) => !e.retired && !e.finished);
      if (active.length === 0) {
        race.state = 'finished';
        for (const e of race.classification) {
          if (e.position <= 10 && !e.retired) e.points = POINTS[e.position - 1] || 0;
        }
        race.log('RACE COMPLETE', 'info');
      }
    }
  }

  race.update = update;
  race.entryList = () => race.classification;
  race.fmt = fmt;
  return race;
}

export function fmt(t) {
  if (!isFinite(t) || t <= 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}
export function fmtGap(t) {
  if (!isFinite(t)) return '--';
  return `+${t.toFixed(3)}`;
}

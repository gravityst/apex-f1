# APEX F1 — Architecture Contract

**Engine:** three.js r185 (vendored, `vendor/three/`). WebGL2. Zero external/CDN deps. No build step.
**Modules:** native ESM. Import three as `import * as THREE from 'three';` and addons as
`import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';`
(an importmap in index.html maps `three` and `three/addons/`).

## Units & conventions
- Metres, kilograms, seconds, radians. Y is up. Right-handed.
- Track lies roughly in the XZ plane; Y carries elevation.
- Car forward is +Z in its local space. Steering angle > 0 turns left.
- All angles radians. Speed internally m/s (HUD converts to km/h / mph).

## Global namespace rules
- Every module is side-effect free at import time except where noted. Export factory
  functions / classes only. NEVER touch `window` except in `main.js`.
- No `console.log` in hot paths.
- Everything must degrade gracefully: if a feature can't init, `try/catch` and continue.

## Quality tiers
A global quality object is passed to renderers:
```js
{ tier: 'low'|'medium'|'high'|'ultra', pixelRatio: Number, shadows: Boolean,
  shadowMapSize: Number, postFX: Boolean, particles: Number /*0..1 density*/,
  anisotropy: Number, crowdDensity: Number, reflections: Boolean }
```

## Track sampling API (implemented in src/track/track.js — provided to you)
```js
track.length                  // metres, closed loop
track.sample(s)               // s in metres, wraps. Returns cached-safe object:
  // { pos: Vector3, tangent: Vector3, normal: Vector3 (up), lateral: Vector3 (right),
  //   width: Number (half-width, m), banking: Number (rad), curvature: Number (1/m) }
track.project(worldPos)       // -> { s, lateral (signed m, +right), height, onTrack: Boolean }
track.surfaceAt(s, lateral)   // -> { type:'asphalt'|'kerb'|'astro'|'grass'|'gravel'|'concrete'|'pit',
                              //      grip: 0..1, roughness: 0..1, drag: 0..1 }
track.racingLine(s)           // -> lateral offset (m) of ideal line at s
track.targetSpeed(s)          // -> m/s ideal speed at s for grip=1.0 reference car
track.drsZones                // [{ detectS, startS, endS }]
track.sectors                 // [s0, s1, s2] sector boundary distances
track.pit                     // { entryS, exitS, boxS: [..], speedLimit, lane: fn(s)->lateral }
track.startGrid               // [{ pos: Vector3, heading: Number }] x20
```

## Weather state (owned by src/game/race.js, read by everyone)
```js
{ condition:'clear'|'cloudy'|'overcast'|'lightrain'|'rain'|'storm',
  rainIntensity: 0..1, trackWetness: 0..1, puddles: 0..1,
  windSpeed: m/s, windDir: rad, temperature: C, trackTemp: C,
  timeOfDay: 0..24 (float hours), transitionTarget: {..} }
```

## Car public state (each car, produced by src/physics/vehicle.js)
```js
{ id, isPlayer, team, driver,
  position: Vector3, quaternion: Quaternion, velocity: Vector3,
  speed: m/s, rpm, gear (-1=R,0=N,1..8), throttle 0..1, brake 0..1, steer -1..1,
  drs: Boolean, ers: {charge 0..1, deploying: Boolean, mode},
  wheels: [{ worldPos: Vector3, radius, spinAngle, steerAngle, slipRatio, slipAngle,
             load: N, contact: Boolean, surface: String, temp: C, wear: 0..1,
             lockedUp: Boolean, spinning: Boolean, compression: 0..1 }],  // FL,FR,RL,RR
  gForce: {lat, lon}, fuel: kg, tyreCompound, lapDistance: s, lap, position: raceP }
```

## Module contracts (each agent writes exactly one)
See the per-module spec in your task prompt. Do not create files outside the ones assigned.

## Fictional teams (NO real-world marks anywhere)
Defined in `src/game/teams.js`. Ten invented constructors with invented drivers,
invented liveries, invented sponsor wordmarks. Never reference a real F1 team,
driver, sponsor, engine supplier, or circuit name.

# APEX F1

A hyper-realistic Formula 1 racing simulator that runs entirely in the browser.
No install, no plugins, no build step — open the link and drive.

**▶ Play: https://gravityst.github.io/apex-f1/**

Works on desktop (keyboard / gamepad) and on phones and tablets (touch).

---

## What's actually simulated

This is not an arcade racer with a speed value and a turn rate. The car is a
rigid body with four independently simulated wheels, and every number below was
validated against real Formula 1 reference data before shipping.

| Measurement | APEX F1 | Real F1 |
|---|---|---|
| Top speed | 332 km/h | 330–345 |
| Downforce at top speed | 30.4 kN (≈3.1 t) | ≈3 t |
| Braking 300 → 0 km/h | 122 m, peak 4.6 g | ≈120 m, 5–6 g |
| Peak lateral grip | ≈3.6 g | 3–5 g |
| Tyre operating temp | 78–95 °C | 80–110 °C |
| Fuel burn | ≈1.8 kg/lap | ≈1.7 kg/lap |

**Tyres** use the Pacejka Magic Formula for longitudinal and lateral force, with
a combined-slip friction ellipse, load sensitivity as a power law, per-axle
contact patches (the rear tyres are 405 mm against 305 mm at the front — without
that the car is permanently oversteery), a relaxation length so forces build
rather than snap, and per-corner thermal and wear models. Lock a wheel and you
get a flat spot and smoke; overheat them and grip fades.

**Aerodynamics** model downforce and drag separately, with ground effect that
scales on ride height, DRS that trades downforce for straight-line speed,
slipstream that reduces the drag of the car behind, and dirty air that costs the
following car front-end grip.

**Suspension** is a raycast spring/damper per corner with anti-roll bars, bump
stops and asymmetric bump/rebound damping, so weight transfer, kerb strikes and
bottoming-out all emerge from the physics rather than being scripted.

**Drivetrain**: 8-speed gearbox, limited-slip differential, a real turbo-hybrid
torque curve peaking around 620 kW, ERS deployment and harvesting, and a fuel
load that changes the car's mass as the race goes on.

Driving aids (traction control, ABS, stability, auto gearbox) are all adjustable
from off to full — turn ABS off and the car locks up and takes 30 % longer to
stop, exactly as it should.

## Adaptive AI

Nineteen AI drivers, each with their own skill, aggression, consistency and
wet-weather rating. They follow a racing line solved offline by true
minimum-curvature optimisation — the line swings properly out–in–out through a
corner and is measurably wider than the centreline at the apex.

They steer with geometric pure pursuit plus a cross-track PD correction, brake
using a look-ahead solver against their own grip budget, slipstream and use DRS,
defend with a single move, avoid contact, manage tyres and fuel, and make
occasional human mistakes weighted by their consistency rating.

On **Adaptive** difficulty the field continuously measures your pace against the
circuit's reference lap and re-targets itself to bracket you — some drivers
faster, some slower — so there is always someone to chase and someone chasing.
The adjustment drifts slowly and is capped, so it never feels like rubber-banding.

## Everything else

- **5 circuits**, each hand-built: a fast seaside track, a night street circuit,
  a brutal elevation-change track, a long jungle lap, and a low-downforce desert
  autodrome. All verified for smooth, drivable geometry.
- **Dynamic weather** — rain that wets and dries the track on its own clock,
  spray from the cars ahead, aquaplaning, wet/intermediate/slick compounds, and
  a full day/night cycle with atmospheric-scattering skies.
- **Race director** — lap and sector timing, live classification, DRS detection
  zones, flags, safety car and VSC, track-limit and pit-lane penalties, pit
  stops with tyre changes, reliability failures and championship points.
- **Procedural everything** — the cars, the driver figure in the cockpit, the
  circuits and all textures are generated in code. Nothing is downloaded.
- **Procedural audio** — the engine is additive synthesis driven by rpm and
  load, with turbo spool, overrun crackle, an MGU-K whine, slip-driven tyre
  noise and positional audio for the cars around you. No audio files.

## Controls

**Keyboard** — `W`/`↑` throttle · `S`/`↓` brake · `A`/`D` or `←`/`→` steer ·
`E`/`Q` shift up/down · `Space` DRS · `X` ERS · `C` camera · `B` look back ·
`P` pit · `R` recover · `Esc` pause

**Gamepad** — triggers for throttle and brake, left stick to steer, shoulder
buttons to shift.

**Touch** — drag anywhere on the left to steer (or switch to an on-screen wheel
or tilt steering in Settings), pedals on the right. Turn on assisted throttle in
Settings to play one-thumbed.

## Tech

Three.js r185, vendored into the repo — the game has zero external dependencies
and makes no network requests at runtime. Native ES modules, no bundler, no
build step. Ships as static files.

## A note on names

Every team, driver, sponsor, engine and circuit in this game is invented.
Any resemblance to a real racing organisation is coincidental. This is an
independent fan project and is not affiliated with, endorsed by, or connected to
Formula 1, the FIA, or any real racing team.

## Licence

MIT for the game code. Three.js is included under its own MIT licence
(`vendor/three/LICENSE`).

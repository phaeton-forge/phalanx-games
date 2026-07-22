# Drone Survival — MVP Design

Target repo: `phaeton-forge/phalanx-games`, new top-level folder `drone-survival/`.
This doc: `docs/superpowers/specs/2026-07-22-drone-survival-design.md`.

## Goal

A single-player 3D arena survival game (Vampire Survivors loop) built on the Phalanx engine.
The player pilots a hover drone, enemies attack in fixed waves, kills grant XP, level-ups offer
a choice of new abilities or upgrades. Survive all 15 waves to win; death ends the run.

## Choices locked in

- **Single-player, deterministic local sim.** No server, no netcode. `GameWorld` driven locally
  at 20 TPS (matches abilities-playground). Fixed-point math (`@phalanx-engine/math` FP) for all
  simulation state; seeded `GameRandom` for all sim randomness. Determinism is preserved so
  replays/multiplayer can be added later.
- **Renderer: Three.js**, not Babylon. All ability hooks/cues (AutoAttack, Volt, Missile, SAU)
  already exist in `phalanx-engine/abilities-playground` as Three.js code. We copy/adapt that
  code rather than rewrite it for Babylon. From `arena-shooter` (Babylon) we port **patterns
  only**: InputManager, TouchControls/VirtualJoystick, WaveSystem FSM, camera follow, HUD flow.
- **Movement & physics from abilities-playground**: `PhysicsWorld` (XZ-plane, worldBounds,
  collision filter), SoA physics/transform stores, velocity-driven movement, gravity enabled
  globally but opted into only by SAU shrapnel.
- **All units hover.** Simulation stays 2D (XZ). Hover is purely visual: each unit's mesh sits
  at a per-type `hoverHeight` with a cosmetic bob/tilt applied by a frame-time system.
  No unit ever renders as standing on the ground.
- **Fixed 15 waves.** Kill-all-to-advance with a short pause between waves (arena-shooter model).
  Victory after wave 15. Wave composition is a declarative table — balance is data, not code.
- **XP is granted directly on kill** (no XP gems). HP pickups drop from enemies (arena-shooter
  model: drop chance, despawn timer, heal on touch) with a magnet radius.
- **Desktop + mobile from day one.** WASD/arrows + a single virtual movement joystick,
  centered on screen for comfort; the whole screen is the touch surface and the joystick is
  invisible until the player touches (current arena-shooter behavior). No aiming input at
  all — every weapon self-targets. Level-up cards clickable/tappable.
- **3D models are real GLB assets** (Blender): player drone, 3 enemies, SAU turret, arena.
  Asset loading follows the **chapaev model**: a centralized `AssetManager` downloads every
  manifest entry (GLB models + textures) with retry/backoff before the game starts — a
  `LoaderOverlay` spinner blocks until `preloadAll()` resolves; gameplay code reads cached
  assets synchronously. A `?fallbackMeshes=1` dev flag runs on primitive meshes while real
  GLBs are not committed yet.
- **Adaptive graphics quality, chapaev model**: device-tier presets (low/medium/high picked
  once at startup from GPU/memory heuristics, `?quality=` override) + runtime
  `AdaptivePerformance` FPS-based dynamic resolution scaling. Both copied from
  `chapaev/src/rendering/`.
- **Abilities reuse the existing roster** from abilities-playground `abilityDefinitions.ts`:
  `Ability.AutoAttack`, `Ability.Volt.ChainLightning`, `Ability.MissileVolley` (+ new AoE
  splash), `Ability.SAU.Artillery` (as a deployable stationary turret). The ranged enemy
  gets a **dedicated projectile ability** `Ability.EnemyPlasma.Shot` (own color/speed/damage,
  declared separately from the player's AutoAttack). `Ability.PlasmaTank.MachineGun` is NOT
  used: it deals instant hitscan damage that cannot be dodged, which breaks the genre's core
  promise that positioning avoids damage.
- **Dynamic magnitude calculation in `phalanx-abilities`** (engine extension, implemented
  first): modifiers accept an optional pure FP `calculation` function (Unreal GAS
  ModMagnitudeCalculation analog) evaluated by the engine at effect-application time, plus an
  optional `setByCaller` payload (`ReadonlyMap<string, any>`) on `applyEffect`. Ability
  damage scales with ability-level
  attributes through these calculations — no per-level effect-id variants anywhere.
- Docs and code comments in English, matching repo convention.

## Non-goals (MVP)

- No multiplayer, no lockstep client/server (sim stays deterministic, that's enough).
- No HealAura, no support enemies, no boss.
- No meta-progression between runs, no unlocks, no save games.
- No endless mode, no difficulty settings.
- No audio (stretch goal at the end, not blocking).
- No pathfinding — arena is an open floor; steering is straight-line.

## Game design

### Player drone

| Param | Value |
|---|---|
| Max HP | 100 |
| Move speed | 14 u/s |
| Collision radius | 1.2 |
| Hover height (visual) | 2.5 |
| Contact i-frames | 12 ticks (0.6 s) after taking contact damage |

The drone is always the only entity on team 0. Enemies are team 1.
On enemy contact the player takes that enemy's `contactDamage`, gains i-frames, and physics
push resolves the overlap (no knockback on the player except from Breacher charge).

### Enemies (3 types)

All hover. HP scales per wave: `hp = round(baseHp * (1 + 0.06 * (wave - 1)))`.
Contact damage does NOT scale (pressure comes from count + composition).

| | **Scrab** (swarm chaser) | **Plasma Walker** (ranged) | **Breacher** (charging elite) |
|---|---|---|---|
| Role | Numbers pressure, feeds XP | Forces movement, area denial | Telegraphed burst threat |
| Base HP | 20 | 60 | 160 |
| Speed | 10 u/s | 8 u/s | 6 u/s (34 u/s during charge) |
| Radius | 0.9 | 1.1 | 1.6 |
| Contact damage | 10 | 10 | 10 (25 during charge + knockback) |
| Attack | contact only | `Ability.EnemyPlasma.Shot`, stops at range 26, plasma bolt 22 u/s, 6 dmg | charge FSM (below) |
| XP | 1 | 3 | 8 |
| First appears | wave 1 | wave 3 | wave 5 |

**Breacher FSM** (deterministic, tick-based):
1. `APPROACH` — steer toward player at 6 u/s. When XZ distance ≤ 15 → `WINDUP`.
2. `WINDUP` — 20 ticks. Stop, lock charge direction = normalized vector to player's position
   at windup start tick. Visual telegraph (nose tilt + engine glow ramp, cosmetic).
3. `CHARGE` — 18 ticks at 34 u/s along the locked direction (≈ 30 units). On player hit:
   25 damage + knockback impulse 40 to the player, transition to `RECOVER` immediately.
4. `RECOVER` — 30 ticks drifting (velocity zero). Then back to `APPROACH`.

Optional `explodeOnDeath` flag in the enemy definition (default **off**): 15 dmg in radius 6.
Ships implemented but disabled; flipped on only if the Breacher underperforms in playtests.

### Player abilities & upgrades

`Ability.AutoAttack` is innate (level 1 at run start). Up to **3 more** abilities can be
acquired from level-up cards: Volt, Missile, SAU Turret. Every ability has 4 levels.
Activation is timer-driven by `PlayerAbilitySystem` (per-ability tick cooldowns in a component,
scaled by level) — NOT by tag-based cooldown effects, so upgrades never fight static effect
definitions. Damage scaling uses the new **dynamic magnitude calculation**: each ability's
level lives as an attribute on its owner (`Attribute.AbilityLevel.AutoAttack/Volt/Missile/SAU`),
and each damage effect declares one `calculation` that multiplies the base magnitude by a
per-level FP multiplier map, read from the **source** entity's level attribute at application
time. Volt's per-jump falloff is passed via the `setByCaller` payload (jump index → FP falloff
table lookup). All calculation inputs are FP; determinism is unaffected.

| Ability | L1 | L2 | L3 | L4 |
|---|---|---|---|---|
| **AutoAttack** — projectile at nearest enemy in range 30 | 18 dmg, cd 20 ticks | cd 14 | 27 dmg | twin shot (2 projectiles, ±6°) |
| **Volt** — chain lightning, hits closest then jumps (single-target hits in sequence, per-hit falloff 0.75, jump radius 20) | 40 dmg, 3 jumps, cd 80 | 4 jumps | cd 56 | 60 base dmg |
| **Missile** — homing missile volley + NEW splash AoE on impact (this is the AoE tool) | 1 missile, 32 impact + 12 splash r4, cd 100 | 2 missiles | splash 20, r5 | 3 missiles, cd 80 |
| **SAU Turret** — deploys a stationary artillery bot at the player's position; turret self-targets like playground SAU (shell → primary AoE + shrapnel secondary AoE) | 1 turret, lifetime 240 ticks, fires every 80, cd 300 | turret fires every 60 | 2 turrets simultaneously | lifetime 400, primary dmg 68 |

Volt is explicitly **not** AoE: each hit strikes exactly one target, sequentially
(`CHAIN_LIGHTNING_JUMP_DELAY_TICKS` between jumps), as in the playground implementation.

### XP & level-ups

- XP on kill: Scrab 1, Walker 3, Breacher 8. Total XP in a full clear: **738**
  (204 Scrabs + 82 Walkers + 36 Breachers, see wave table).
- XP to next level (from level n): `10, 15, 22, 30, 40, 52, 66, 82, 100, 120, 142` —
  cumulative 679 → a full clear ends around **level 12** (11 picks). The pool holds 15
  distinct picks (3 new abilities + 12 upgrades), so builds must specialize.
- On level-up: `world.pause()`, overlay shows **3 distinct cards** drawn seeded-random from:
  new abilities (if a slot is free) ∪ upgrades of owned abilities below L4. If the pool has
  fewer than 3 entries, pad with a `Repair +25 HP` card. Click/tap/1-2-3 keys → apply →
  `world.resume()`. Multiple pending level-ups resolve one at a time.

### Waves

Declarative table (`config/waves.ts`), spawn on arena perimeter ≥ 25 units from the player:

| Wave | Scrab | Walker | Breacher | | Wave | Scrab | Walker | Breacher |
|---|---|---|---|---|---|---|---|---|
| 1 | 6 | – | – | | 9 | 14 | 6 | 3 |
| 2 | 8 | – | – | | 10 | 16 | 7 | 3 |
| 3 | 8 | 2 | – | | 11 | 16 | 8 | 4 |
| 4 | 10 | 3 | – | | 12 | 18 | 8 | 4 |
| 5 | 10 | 4 | 1 | | 13 | 18 | 9 | 5 |
| 6 | 12 | 4 | 1 | | 14 | 20 | 10 | 5 |
| 7 | 12 | 5 | 2 | | 15 | 22 | 10 | 6 |
| 8 | 14 | 6 | 2 | | | | | |

Wave FSM (ported from arena-shooter): `LOADING → PLAYING ⇄ WAVE_CLEAR_PAUSE → VICTORY/GAME_OVER`.
Clear pause 100 ticks (5 s). Wave spawn is staggered: enemies enter in spawn packets every
20 ticks (packets of up to 6) so late waves don't materialize as one instant wall.

### Pickups

- Any enemy death: 15% chance to drop a repair kit at its position.
- Heal 25 HP, despawn after 360 ticks, pickup radius 1.5, magnet radius 6
  (kit accelerates toward player at 20 u/s when inside magnet radius).

### Arena & camera

- Arena: open square **120 × 120** world units, GLB visual from Blender (floor + border walls
  + dressing). Physics containment via `worldBounds`; walls are visual only.
- Camera: perspective, above and slightly behind the drone (height ≈ 55, Z offset ≈ −26,
  looking at the drone), frame-time lerp follow (arena-shooter CameraSystem pattern).

### 3D asset contract (Blender)

GLB, Y-up, −Z forward (three.js convention: model's face points −Z; factory applies yaw),
1 Blender unit = 1 world unit, origin at visual center of mass (hover models float around
their origin; no ground-plane offset baked in). Single material per model preferred,
≤ 8k tris per unit, ≤ 60k tris arena. Files: `drone.glb`, `scrab.glb`, `plasma_walker.glb`,
`breacher.glb`, `sau_turret.glb`, `arena.glb` in `drone-survival/public/models/`.
All models and textures are listed in a central `AssetManifest`; the game does not start
until every entry is downloaded (chapaev model: retry with backoff, loader overlay, final
failure shows a retry screen). Primitive fallbacks (sphere/box/cone, playground `unitVisuals`
style) exist behind the `?fallbackMeshes=1` dev flag only.

## Architecture

```
drone-survival/
  src/core/        Game (loop glue), SimulationContainer (world+physics+abilities wiring),
                   InputManager, GameRandom
  src/rendering/   AssetManager + AssetManifest, qualitySettings, AdaptivePerformance,
                   textureQuality (all copied from chapaev)
  src/config/      constants, abilityDefinitions (extended combatDefs), enemyDefinitions,
                   waves, upgrades
  src/components/  ComponentType + game components
  src/systems/     tick: input, player movement, enemy AI (chase/ranged/breacher), player
                   abilities, projectiles, missiles, volt, artillery, contact damage, health,
                   death, XP, waves, pickups
                   frame: interpolation, render sync, camera, hover bob, cue-driven VFX
  src/hooks/       autoAttack, missileVolley, voltChainLightning, sauArtillery (adapted from
                   abilities-playground), enemyPlasmaShot (new, dedicated enemy attack)
  src/cues/        copied from abilities-playground (Three.js)
  src/ui/          HUD, LevelUpOverlay, screens, LoaderOverlay, TouchControls, VirtualJoystick
  public/models/   *.glb
```

Copy-don't-import: playground hooks/systems/cues are app code inside `phalanx-engine`,
not published packages. MVP copies the needed files into `drone-survival` (with attribution
headers). Extracting a shared `@phalanx-engine/gameplay-kit` package is a post-MVP refactor.

Engine dependency: the dynamic magnitude calculation + `setByCaller` extension lands in
`phalanx-engine/phalanx-abilities` as a separate, backward-compatible PR (plan Task 0)
before any game code is written; the game consumes the bumped package version.

## Testing

- Engine unit tests (in `phalanx-engine/phalanx-abilities`): `calculation` evaluated for
  Instant/Periodic/Duration paths, snapshot semantics, `setByCaller` plumbing, determinism
  (same inputs → same FP outputs), backward compatibility (modifiers without `calculation`
  behave exactly as before).
- Game unit tests (vitest): XP thresholds/economy invariants, wave table totals, upgrade pool
  drawing (never offers >L4, pads with Repair, cards distinct), Breacher FSM transitions,
  per-level damage multiplier maps (monotonic, FP-exact).
- Determinism smoke test: run N scripted ticks twice with the same seed & scripted input,
  assert identical FP position hashes.
- Manual playtest checklist per task (see plan).

## Success criteria

1. `pnpm dev` in `drone-survival/` starts the game; start screen → run → death/victory screens.
2. Full 15-wave run is winnable by a competent player; wave 1 is losable only intentionally.
3. All 4 player abilities acquirable and visibly upgraded through 4 levels; Walker fires
   plasma the player can dodge; Breacher telegraph is readable and dodgeable.
4. Runs at 60 fps render / 20 TPS sim on a mid-range laptop with max on-screen entities
   (wave 15 + 2 turrets + missiles); works with touch controls on a phone.
5. Sim is deterministic (smoke test passes); no floats in tick-time game state.
6. Game boots only after all manifest assets are downloaded (loader overlay while fetching);
   `?fallbackMeshes=1` runs on primitives for development.
7. Graphics quality auto-adapts: tier presets at startup + runtime resolution scaling under
   FPS pressure (chapaev `AdaptivePerformance`).

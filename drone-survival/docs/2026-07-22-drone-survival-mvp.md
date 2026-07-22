# Drone Survival MVP Implementation Plan

Spec: `docs/superpowers/specs/2026-07-22-drone-survival-design.md` — read it first; this plan
implements it exactly. Target repo: `phaeton-forge/phalanx-games`, new folder `drone-survival/`.
Reference codebases (read, then copy/adapt — do not invent parallel implementations):

- `phalanx-engine/abilities-playground` — simulation stack: FP math, SoA stores, PhysicsWorld
  wiring, ability system (`combatDefs`, hooks, cues), MovementSystem, projectile/missile/volt/SAU
  systems, UnitFactory/unitDefinitions pattern. **This is the source of truth for physics,
  movement and abilities.**
- `phalanx-games/arena-shooter` — game-shell patterns: standalone `GameWorld` loop (no server),
  InputManager, TouchControls/VirtualJoystick, WaveSystem FSM, HealthSystem/PickupSystem,
  CameraSystem follow, GameRandom. **Patterns only — arena-shooter is Babylon; this game is
  Three.js like the playground.**
- `phalanx-games/chapaev` — asset & rendering-quality infrastructure to copy nearly verbatim:
  `rendering/AssetManager.ts` (centralized blocking preload with retry/backoff),
  `rendering/AssetManifest.ts`, `ui/LoaderOverlay.ts`, `rendering/qualitySettings.ts`
  (device-tier presets), `rendering/AdaptivePerformance.ts` (runtime FPS-based resolution
  scaling), `rendering/textureQuality.ts`.
- `phalanx-engine/phalanx-abilities` — the engine package extended by Task 0 (dynamic
  magnitude calculation). Key files: `types/ModifierOp.ts`, `types/EffectDef.ts`,
  `types/ActiveEffectInstance.ts`, `systems/EffectApplicationSystem.ts`,
  `systems/EffectTickSystem.ts`, `systems/AttributeAggregationSystem.ts`,
  `api/AbilitySystemFacade.ts`.

## Global Constraints

1. **Determinism.** Every value read or written during `processTick` is `FixedPoint`, `int`, or
   derived from `GameRandom` (seeded). No `Math.random`, no float arithmetic, no `Date.now()`,
   no iteration over unordered containers in tick systems. Frame systems (interpolation, render
   sync, camera, bob, VFX) may use floats freely but must never write sim state.
2. **20 TPS.** All durations in this plan are in ticks at 20 TPS unless stated otherwise.
3. **Copy with attribution.** Files copied from abilities-playground keep a header comment
   `// Adapted from phalanx-engine/abilities-playground <path>`. Keep names/structure aligned so
   diffs stay reviewable. Do not "improve" copied systems beyond what tasks require.
4. **Tunables live in `src/config/`.** No magic numbers inside systems — every gameplay number
   in this plan lands in `constants.ts`, `enemyDefinitions.ts`, `waves.ts` or `upgrades.ts`.
5. **TypeScript strict**, ESLint/prettier configs copied from arena-shooter. Match the
   playground's ECS idioms (`GameSystem`, `SoAComponentStore`, `queryEntities`).
6. **Every task ends green**: `pnpm typecheck && pnpm lint && pnpm test` pass and the manual
   verification steps for that task are performed in `pnpm dev`.
7. Commit per task: `drone-survival: Task N — <name>`.

## File map

```
drone-survival/
  index.html  package.json  tsconfig.json  vite.config.ts
  public/models/{drone,scrab,plasma_walker,breacher,sau_turret,arena}.glb   (required at boot; dev runs ?fallbackMeshes=1 until committed)
  src/main.ts
  src/core/Game.ts  SimulationContainer.ts  InputManager.ts  GameRandom.ts
  src/rendering/AssetManager.ts  AssetManifest.ts  qualitySettings.ts  AdaptivePerformance.ts  textureQuality.ts
  src/config/constants.ts  abilityDefinitions.ts  enemyDefinitions.ts  waves.ts  upgrades.ts
  src/components/ComponentType.ts  index.ts  (+ one file per component)
  src/systems/  (tick + frame systems, one class per file, barrel index.ts)
  src/hooks/AutoAttack.ts  MissileVolley.ts  VoltChainLightning.ts  SauArtillery.ts  EnemyPlasmaShot.ts
  src/cues/   (copied from playground + MissileSplashCue)
  src/entities/Projectile.ts  Missile.ts  ArtilleryShell.ts  Shrapnel.ts  (copied)
  src/ui/HUD.ts  LevelUpOverlay.ts  Screens.ts  LoaderOverlay.ts  TouchControls.ts  VirtualJoystick.ts  hud.css
  test/  (vitest specs)
```

---

### Task 0: `phalanx-abilities` — dynamic magnitude calculation (engine PR, lands first)

**Repo: `phaeton-forge/phalanx-engine`** — a separate, self-contained PR to the
`phalanx-abilities` package. Backward compatible: definitions without the new fields behave
bit-for-bit as before (abilities-playground must pass untouched). The game consumes the new
package version; no game task starts before this merges.

**Files:** `src/types/MagnitudeCalculation.ts` (new), `src/types/ModifierOp.ts`,
`src/types/ActiveEffectInstance.ts`, `src/components/ActiveEffectsComponent.ts`
(PendingEffectAdd), `src/api/AbilitySystemFacade.ts`, `src/systems/EffectApplicationSystem.ts`,
`src/systems/EffectTickSystem.ts`, `src/systems/AttributeAggregationSystem.ts`, tests.

1. **Types** (Unreal GAS ModMagnitudeCalculation analog, function-based):

```ts
// types/MagnitudeCalculation.ts
export interface AttributeReader {
  /** `current` value of an attribute; throws on unknown id (mirrors registry.indexOf). */
  get(attributeId: string): FixedPoint;
  has(attributeId: string): boolean;
}
export interface MagnitudeCalcContext {
  /** Static magnitude declared on the modifier — the base value to transform. */
  baseMagnitude: FixedPoint;
  /** Attributes of the effect's source entity; null when sourceEntityId is -1/despawned. */
  source: AttributeReader | null;
  /** Attributes of the target entity the effect is being applied to. */
  target: AttributeReader;
  /** Per-application payload from applyEffect (SetByCaller analog); null if none.
   *  Values are game-defined (`any`) for developer convenience; anything fed into FP math
   *  must already be FP/int — determinism is the calculation author's responsibility. */
  setByCaller: ReadonlyMap<string, any> | null;
  effectId: string;
  attributeId: string;
}
/** MUST be pure and FP-only: no floats, no Math.random, no Date, no external state. */
export type MagnitudeCalculation = (ctx: MagnitudeCalcContext) => FixedPoint;
```

   `Modifier` gains optional `calculation?: MagnitudeCalculation`. Functions in definitions
   are existing precedent (ability hooks) — all clients register identical static code, so
   determinism holds.
2. **SetByCaller plumbing**: `AbilitySystemFacade.applyEffect(target, effectId,
   sourceEntityId?, setByCaller?: ReadonlyMap<string, any>)`; `PendingEffectAdd` and
   `ActiveEffectInstance` carry `setByCaller` through (null default).
3. **Snapshot evaluation — the single semantic rule**: every modifier's effective magnitude
   is computed **once, at application time**, inside `EffectApplicationSystem.applyOne`
   (after `validateEffectOrThrow`, before any mutation):
   `effective[i] = modifier.calculation ? calculation(ctx) : modifier.magnitude`.
   - **Instant**: `applyInstant` uses `effective[i]` instead of `modifier.magnitude`.
   - **Duration**: `effective[]` (raw FP values) is stored on the `ActiveEffectInstance`
     (`capturedMagnitudes: number[] | null`); `AttributeAggregationSystem.applyModifier`
     reads the captured value when present, else `modifier.magnitude`. Source may die while
     the effect persists — captured values make aggregation independent of source lifetime.
   - **Periodic**: captured at application like Duration; `EffectTickSystem` per-period
     firings reuse `capturedMagnitudes` (documented: per-firing recompute is a post-MVP
     option, not silently different).
   - Source entity resolution: via entityManager by `sourceEntityId`; a despawned source
     yields `source: null` — calculations must handle it (fall back to `baseMagnitude`).
4. **Errors**: a `calculation` that throws propagates (same loud-failure philosophy as
   unknown effect ids); document that calculations must not throw for valid game states.
5. **Tests** (package unit tests): Instant/Duration/Periodic each with a calculation reading
   source attribute, target attribute, and setByCaller; snapshot semantics (changing the
   source attribute after application does not change a Duration modifier); null-source
   fallback; backward compat (no `calculation` → aggregation byte-identical to before —
   reuse an existing aggregation test with unchanged expectations).
6. **Documentation & skills update (mandatory, same PR)**:
   - `phalanx-abilities/README.md`: new "Dynamic magnitudes" section — `Modifier.calculation`,
     `MagnitudeCalcContext`, `setByCaller`, snapshot semantics (application-time capture),
     purity/FP rules, null-source fallback, a worked ability-level example.
   - `.cursor/skills/phalanx-abilities/SKILL.md`: same API surface for agents — updated
     `applyEffect` signature, when to use `calculation` vs static magnitude vs setByCaller,
     determinism constraints.
7. Bump package version; `pnpm -r typecheck && pnpm -r test` green including
   abilities-playground (untouched behavior).

**Verify:** engine repo CI green; playground runs unchanged (manual smoke: volt/SAU demo
scenes); a scratch test in the package demonstrates the spec's flagship case — damage effect
whose magnitude = base × levelMultiplier(source `Attribute.AbilityLevel.X`); README and
SKILL.md diffs are part of the PR (reviewer checklist item).

---

**✅ STATUS: DONE.** Implemented in `phalanx-abilities` v0.2.0 (types, modifier plumbing,
snapshot capture/reuse in `EffectApplicationSystem`/`EffectTickSystem`/
`AttributeAggregationSystem`, `setByCaller`, README + SKILL.md updates, 81/81 package tests
green, abilities-playground consumer re-verified untouched: typecheck clean, 53/53 tests pass).

**Design deviation from this spec (deliberate, post-implementation):** the spec above defines a
per-entity `AttributeReader` interface (`get`/`has`), with `EffectApplicationSystem` wrapping
each source/target `AttributesComponent` in a `ComponentAttributeReader` instance just for
`MagnitudeCalcContext.source`/`target`. After shipping and reviewing this, we decided it was
overengineered for a single-owner codebase: game code calling `applyEffect` already holds the
`AbilitySystemFacade` (`abilities`) and knows how to read attributes/tags through it — a parallel
reader abstraction that only exists for magnitude calculations added a type to learn and an
allocation per effect application for no real benefit.

We replaced it with a simpler shape:
- `MagnitudeCalcContext` now carries `sourceEntityId: number`, `targetEntityId: number`, and
  `abilities: AbilityStateReader` instead of `source`/`target: AttributeReader | null`.
- `AbilityStateReader` is a narrow **structural** interface (`tryGetAttribute`, `hasTag` — the
  two read-only methods every game system already calls on the facade). No wrapper object is
  constructed: `EffectApplicationSystem` passes the live `AbilitySystemFacade` straight through,
  typed as `AbilityStateReader` purely to hide mutating methods (`applyEffect`,
  `activateAbility`) from calculations at compile time, keeping the "calculations must be pure"
  rule enforceable by the type system without adding a runtime class.
- `ComponentAttributeReader` and the per-entity reader abstraction were deleted entirely.
- Null/despawned source handling simplified accordingly: `abilities.tryGetAttribute(sourceEntityId, ...)`
  naturally returns `undefined` for both a missing entity and `NO_SOURCE_ENTITY_ID` (`-1`), so
  calculations no longer branch on an explicit `null` reader — they just handle `undefined`.

Snapshot semantics, `setByCaller`, and all other behavior described above are unchanged.

### Task 1: Project scaffold

**Files:** `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`,
lint/prettier configs.

- Mirror arena-shooter's `package.json` scripts (`dev`, `build`, `typecheck`, `lint`, `test`)
  and its `@phalanx-engine/*` dependency mechanism (same versions/protocol as arena-shooter
  uses in this repo). Deps: `three`, `@types/three`, devDeps: `vitest`, `typescript`, `vite`.
- Packages used: `@phalanx-engine/ecs`, `@phalanx-engine/math`, `@phalanx-engine/physics`,
  `@phalanx-engine/abilities`. **Not** `@phalanx-engine/client` / `server` — single-player.
- `index.html`: fullscreen canvas `#game-canvas`, `<div id="ui-root">` overlay for HTML UI,
  viewport meta for mobile (`user-scalable=no, viewport-fit=cover`), `touch-action: none` on
  the canvas.
- `src/main.ts`: instantiate `Game`, call `game.init()`. Hot-reload disposes the old game.

**Verify:** `pnpm dev` renders an empty Three.js scene (sky-color clear, one light) at 60 fps;
typecheck/lint/test pass.

### Task 2: Config + components skeleton

**Files:** `src/config/constants.ts`, `src/components/ComponentType.ts`,
`src/components/*.ts`, `src/components/index.ts`.

`constants.ts` — every number from the spec, grouped and commented. Key blocks:

```ts
export const TICK_RATE = 20;
export const RANDOM_SEED = 1337;                 // fixed for MVP; UI reroll post-MVP
export const ARENA_SIZE = 120;                   // square, worldBounds ±60
export const PLAYER_MAX_HP = 100;
export const PLAYER_SPEED = FP.FromFloat(14);
export const PLAYER_RADIUS = FP.FromFloat(1.2);
export const PLAYER_HOVER_HEIGHT = 2.5;          // visual only (float ok)
export const PLAYER_IFRAME_TICKS = 12;
export const ENEMY_HP_SCALE_PER_WAVE = 0.06;     // hp = round(base*(1+0.06*(wave-1)))
export const ENEMY_SPAWN_MIN_DIST = FP.FromFloat(25);
export const SPAWN_PACKET_SIZE = 6;
export const SPAWN_PACKET_INTERVAL_TICKS = 20;
export const WAVE_CLEAR_PAUSE_TICKS = 100;
export const WAVE_INTRO_DELAY_TICKS = 60;
export const TOTAL_WAVES = 15;
export const PICKUP_DROP_CHANCE = 0.15;          // compared against GameRandom float
export const PICKUP_HEAL = 25;
export const PICKUP_LIFETIME_TICKS = 360;
export const PICKUP_RADIUS = FP.FromFloat(1.5);
export const PICKUP_MAGNET_RADIUS = FP.FromFloat(6);
export const PICKUP_MAGNET_SPEED = FP.FromFloat(20);
export const ENEMY_PLASMA_SPEED = 22;            // dodgeable (player is 14)
export const ENEMY_PLASMA_DAMAGE = 6;
export const ENEMY_PLASMA_LIFETIME_TICKS = 90;
export const XP_PER_KILL = { scrab: 1, plasmaWalker: 3, breacher: 8 } as const;
export const XP_THRESHOLDS = [10, 15, 22, 30, 40, 52, 66, 82, 100, 120, 142] as const;
export const physicsConfig = { subSteps: 3, gridCellSize: 8, maxVelocity: 190, pushStrength: 12, gravity: 10 };
export const cameraConfig = { height: 55, zOffset: -26, lerpSpeed: 5 };
```

(Projectile/missile/SAU numeric blocks are copied verbatim from playground `constants.ts` in
Task 6; don't duplicate them here.)

`ComponentType` enum (string values, one namespace):
`Transform, PhysicsBody, Interpolation, Mesh, HealthBar, Team, UnitStats, TargetState,
SimulationState, PlayerInput, PlayerProgress, PlayerAbilities, EnemyAI, BreacherState,
ContactDamage, IFrames, Projectile, Missile, ArtilleryShell, ShrapnelPayload, DeployedTurret,
Pickup, Wave, HoverBob, EntityType, AbilityRuntime(engine-owned), …` — extend as tasks require,
never reuse a value.

Components introduced now (data-only classes, playground style):

```ts
class PlayerProgressComponent { level = 1; xp = 0; kills = 0; pendingLevelUps = 0; }
class PlayerAbilitiesComponent {
  // abilityId -> state; AutoAttack present from start at level 1
  abilities = new Map<PlayerAbilityId, { level: number; cooldownLeft: number }>();
}
class ContactDamageComponent { constructor(public damage: number) {} }
class IFramesComponent { ticksLeft = 0; }
class EnemyAIComponent { constructor(public kind: EnemyKind) {} }
class BreacherStateComponent {
  state: 'APPROACH'|'WINDUP'|'CHARGE'|'RECOVER' = 'APPROACH';
  ticksLeft = 0; chargeDirX = FP._0; chargeDirZ = FP._0;
}
class PickupComponent { lifetimeLeft = PICKUP_LIFETIME_TICKS; }
class WaveComponent {
  state: 'LOADING'|'PLAYING'|'WAVE_CLEAR_PAUSE'|'VICTORY'|'GAME_OVER' = 'LOADING';
  currentWave = 0; totalWaves = TOTAL_WAVES; enemiesAlive = 0; waveTimer = WAVE_INTRO_DELAY_TICKS;
  spawnQueue: EnemyKind[] = []; spawnTimer = 0;   // staggered packets
}
class SimulationStateComponent { active = false; gameOver = false; victory = false; }
class HoverBobComponent { constructor(public baseHeight: number, public phase: number) {} } // frame-only
```

**Verify:** typecheck passes; `test/config.spec.ts` asserts `XP_THRESHOLDS.length === 11` and
wave-table invariants placeholder (filled in Task 12).

### Task 3: Core services — GameRandom, InputManager, AssetManager

**Files:** `src/core/GameRandom.ts`, `src/core/InputManager.ts`, `src/ui/TouchControls.ts`,
`src/ui/VirtualJoystick.ts`, `src/rendering/AssetManager.ts`, `src/rendering/AssetManifest.ts`,
`src/ui/LoaderOverlay.ts`, `src/rendering/qualitySettings.ts`,
`src/rendering/AdaptivePerformance.ts`, `src/rendering/textureQuality.ts`.

- `GameRandom`: copy from arena-shooter (`initialize(seed)`, `intRange`, `floatRange`,
  `chance(p)` added). All sim randomness flows through it: spawn positions, drop rolls, card
  draws, volt jump target selection already uses its own seeded path in the copied hook — keep.
- `InputManager`: port from arena-shooter, **deleting** aim/fire/reload (no aiming in this
  game). Keep: WASD/arrows → `moveX/moveZ` (FP), TouchControls with a **single movement
  joystick, centered on screen**; the whole screen is the touch surface and the joystick UI
  is hidden until a touch is active (current arena-shooter behavior — port it). Right
  joystick, double-tap, aim getters — deleted. Keep `endTick()` no-op hook for future
  one-shot inputs.
- `AssetManager` — **copy chapaev's `rendering/AssetManager.ts`** (retry with exponential
  backoff, `preloadAll()` promise, synchronous cached getters, `dispose()`), then extend with
  a GLB category via `GLTFLoader`:

```ts
type ModelKey = 'drone'|'scrab'|'plasmaWalker'|'breacher'|'sauTurret'|'arena';
interface ModelAsset { key: ModelKey; path: string; scale: number; yawOffset: number; }
// AssetManifest.ts: MODEL_MANIFEST: readonly ModelAsset[]  (+ TEXTURE_MANIFEST if any
// standalone textures appear; GLB-embedded textures need no manifest rows)
class AssetManager {
  preloadAll(): Promise<void>;                    // blocks startup, chapaev semantics
  instantiateModel(key: ModelKey): THREE.Object3D; // fresh clone; throws if not preloaded
}
```

  **The game does not start until `preloadAll()` resolves** (LoaderOverlay spinner, copied
  from chapaev, shown meanwhile; final retry-exhausted failure renders a retry screen).
  Exception: `?fallbackMeshes=1` skips the model manifest and makes `instantiateModel` return
  playground-style primitives — the dev path while GLBs aren't committed. Apply
  `applyTextureQuality` (chapaev `textureQuality.ts`) to every texture found in loaded GLB
  scenes (traverse materials).
- Graphics quality — **copy chapaev's `qualitySettings.ts` + `AdaptivePerformance.ts`**
  unchanged except: storage key `drone-survival.quality`, presets reviewed for this game
  (bloom stays available for cue VFX; shadows may be disabled entirely on low). Consumed in
  Task 5 when the renderer is created (`detectQualityTier()` → preset → renderer/pixel-ratio
  settings; `AdaptivePerformance` stepped every frame in the render loop).

**Verify:** dev build: pressing WASD logs direction vector; on a phone (or devtools touch
emulation) touching anywhere shows the centered joystick and yields moveX/moveY, releasing
hides it; loader overlay shows
until manifest resolves and the game refuses to start on a permanently failing URL (retry
screen); `?fallbackMeshes=1` boots with primitives; `?quality=low|medium|high` picks the tier
(console tier log).

### Task 4: Ability definitions for Drone Survival

**Files:** `src/config/abilityDefinitions.ts`.

Start from a copy of playground `abilityDefinitions.ts`, then:

1. **Delete** HealAura, Cube (slow/speed beam) and the whole PlasmaTank machine-gun block
   (attributes/effects/abilities/tags). The machine gun is hitscan — instant, undodgeable
   damage — and is banned from this game by design.
2. **Keep** unchanged: `Health`, `MaxHealth`, `AttackSpeedMultiplier` attributes;
   `Effect.Death`; volt, missile, SAU effect/ability blocks and their constants
   (`CHAIN_LIGHTNING_*`, `SAU_*`, `ROCKET_*` renamed `MISSILE_*` where local).
   `MAX_UNIT_HEALTH = 300` (Breacher wave-15 HP ≈ 294 must fit under the Health clamp).
3. **Ability-level attributes** (Task 0 machinery): `Attribute.AbilityLevel.AutoAttack`,
   `.Volt`, `.Missile`, `.SAU` — default 1, min 1, max 4, integer FP. Present on the player
   (and `.SAU` on turrets). Level-ups apply `Effect.AbilityLevelUp.<X>` (Instant, Add +1,
   Override-capped by max — clamp in the attribute def like Health/MaxHealth).
4. **One damage effect per source, magnitude via `calculation`** — per-level FP multiplier
   maps live in `upgrades.ts` and are imported by the definitions:

```ts
// upgrades.ts (data): DMG_MULT: Record<PlayerAbilityKey, readonly FixedPoint[]>  (index = level-1)
// AutoAttack [1, 1, 1.5, 1.5]  Volt [1, 1, 1, 1.5]  MissileSplash [1, 1, 1.667, 1.667]
// SauPrimary [1, 1, 1, 1.511]  MissileImpact [1, 1, 1, 1]  (flat — splash carries scaling)
const byAbilityLevel = (attr: string, mult: readonly FixedPoint[]): MagnitudeCalculation =>
  ({ baseMagnitude, source }) => {
    const level = source?.has(attr) ? FP.ToInt(source.get(attr)) : 1;
    return FP.Mul(baseMagnitude, mult[level - 1] ?? FP.One);
  };
```

   - `Effect.Damage.AutoAttack` (−18, calc `byAbilityLevel(AutoAttack)` → −27 at L3+).
   - `Effect.Damage.Volt` (−40 base, calc = level mult × falloff:
     `FALLOFF[setByCaller.get('Volt.JumpIndex')]`, FP table `[1, 0.75, 0.5625, 0.4219, 0.3164]`;
     missing setByCaller ⇒ jump 0). One effect covers primary hit and every jump.
   - `Effect.Damage.Missile.Impact` (−32, flat); **new** `Effect.Damage.Missile.Splash`
     (−12, calc: L3+ × 1.667 ≈ −20; splash **radius** by level comes from `upgrades.ts` in the
     collision system, not the effect).
   - `Effect.Damage.SAU.Primary` (−45, calc: L4 × 1.511 ≈ −68); `Effect.Damage.SAU.Secondary`
     (−20, flat).
   - Flat effects without calculations: `Effect.Damage.Contact.Scrab` (−10), `.Walker` (−10),
     `.BreacherCharge` (−25), `Effect.Damage.EnemyPlasma` (−6), `Effect.Heal.Pickup` (+25),
     `Effect.Damage.BreacherExplosion` (−15, unused while flag off).
   - Damage sources must pass the correct `sourceEntityId` (player or turret) through
     projectiles/missiles/shells so calculations read the right level attribute at
     application time.
5. **New enemy ability** `Ability.EnemyPlasma.Shot`: declared independently of the player's
   AutoAttack (own hook `EnemyPlasmaShot`, own constants `ENEMY_PLASMA_*`, own projectile
   color/material key). Fires one plasma bolt toward the target's current position at
   `ENEMY_PLASMA_SPEED` carrying `Effect.Damage.EnemyPlasma`.
6. **Player abilities**: keep `Ability.AutoAttack`, `Ability.MissileVolley`,
   `Ability.Volt.ChainLightning`, `Ability.SAU.Artillery` with their hooks, **without**
   `cooldownEffectId`/`activationBlockedTags` for player-driven ones (PlayerAbilitySystem
   owns cooldowns; the Walker keeps the unit-def `autoAttack.cooldownTicks` pattern).
7. Export `PlayerAbilityId = 'Ability.AutoAttack' | 'Ability.Volt.ChainLightning' |
   'Ability.MissileVolley' | 'Ability.SAU.Deploy'` (note: `SAU.Deploy` is a *game action* —
   deploying spawns a turret entity that owns `Ability.SAU.Artillery`; see Task 11).

**Verify:** `test/abilityDefinitions.spec.ts`: definitions compile via `defineAbilitySystem`;
calculation unit tests — AutoAttack magnitude at levels 1–4 equals −18/−18/−27/−27 FP-exact;
Volt at jump index 0..4 follows the falloff table; missing setByCaller/source fall back to
base; `Ability.PlasmaTank.MachineGun` is absent from the registry.

### Task 5: SimulationContainer + Game loop shell

**Files:** `src/core/SimulationContainer.ts`, `src/core/Game.ts`.

`SimulationContainer` — adapt from playground:

- `GameWorld({ componentTypes, tickRate: TICK_RATE })` (arena-shooter standalone mode — no
  `tickFrameProvider`), pooling for `projectile`, `missile`, `artilleryShell`, `shrapnel`
  (playground pool sizes ×1.5 — VS entity counts) **+ `enemy` pools per kind** (scrab 60,
  walker 24, breacher 12) and `pickup` (24).
- `PhysicsWorld` from playground config with `ARENA_SIZE` worldBounds and
  `gravity: physicsConfig.gravity` (shrapnel-only, as documented in playground constants).
- Collision filter (merge playground + arena-shooter rules):
  - dead units never collide; shrapnel collides with nothing (landing resolved geometrically);
  - projectile↔projectile never; projectile↔same-team never (player projectiles pass over
    the player, enemy plasma passes over enemies);
  - enemy↔enemy **do** collide (physics push keeps the swarm from stacking — this is the
    playground default behavior, keep it);
  - pickup collides only with the player.
- `createAbilitySystem(world, { definitions, cues, hooks })` — cue map copied from playground
  minus deleted cues, plus `Cue.Missile.Splash` (Task 10); hooks from `src/hooks/`.
- **Tick system order** (registerSystems first array) — deviations from this order are bugs:

```
PlayerInputSystem            // input → PlayerInputComponent
PlayerMovementSystem         // input → player velocity
EnemyAISystem                // scrab/walker steering + walker TargetState/fire timer
BreacherAISystem             // FSM, writes velocity/charge
PlayerAbilitySystem          // cooldown timers → ability activations (hooks fire here)
MissileLauncherSystem        // (copied) volley bookkeeping
VoltAttackSystem + ChainLightningJumpSystem   // (copied)
TurretSystem                 // deployed turret lifetime + its artillery timer
ProjectileMovementSystem     // (copied)
MissileTargetingSystem + MissileMovementSystem  // (copied)
ArtilleryShellSystem         // (copied)
gravitySystem                // engine
physicsSystem                // engine
ShrapnelLandingSystem        // (copied)
ProjectileCollisionSystem    // (adapted: splash, enemy plasma vs player)
ContactDamageSystem          // enemy↔player touch damage + i-frames
PickupSystem                 // magnet + collect
HealthSystem                 // clamps, death detection → emits events
DeathSystem                  // (adapted) XP grant, drops, despawn/pool return
XPLevelSystem                // thresholds → pendingLevelUps
WaveSystem                   // FSM + staggered spawn queue
GameStateSystem              // player dead / wave 15 clear → SimulationState flags
ProjectileDespawnQueueSystem // (copied)
```

  Frame array: `interpolationSystem` (engine), `RenderSyncSystem` (copied),
  `CameraFollowSystem`, `HoverBobSystem`, `HealthBarSystem` (copied playground behavior).
- `Game.ts` (arena-shooter pattern): owns renderer/scene/camera. Boot sequence:
  `detectQualityTier()` → create renderer from the preset (pixel-ratio cap, antialias,
  shadows) → show `LoaderOverlay` → `await assetManager.preloadAll()` (hide overlay; on
  retry-exhausted failure show retry screen and do NOT start the world) →
  `world.start({ beforeTick, afterTick(inputManager.endTick, cleanup), afterFrame(render,
  AdaptivePerformance.step, HUD update) })`. `pause()/resume()` passthroughs for the level-up
  overlay, `dispose()`.

**Verify:** game boots to an empty arena floor plane; `world` ticks (log tick counter);
pause/resume via temporary hotkey `P` freezes/unfreezes the tick counter without stopping
rendering.

### Task 6: Copy the playground combat stack

**Files:** `src/entities/{Projectile,Missile,ArtilleryShell,Shrapnel}.ts`,
`src/systems/{ProjectileMovementSystem,ProjectileCollisionSystem,ProjectileDespawnQueueSystem,
MissileLauncherSystem,MissileTargetingSystem,MissileMovementSystem,ArtilleryShellSystem,
ShrapnelLandingSystem,ShrapnelSpinSystem,RenderSyncSystem,RotationSystem,DeathSystem}.ts`,
`src/cues/*` (all remaining playground cues), `src/hooks/{AutoAttack,MissileVolley,
VoltChainLightning,EnemyPlasmaShot,SauArtillery}.ts` (EnemyPlasmaShot = AutoAttack hook
adapted: own constants, color, effect id), missile/SAU/projectile constant
blocks appended to `src/config/constants.ts`.

- Copy verbatim where possible; the only allowed edits in this task are import paths,
  removed HealAura/Cube references, and renamed constants. Functional changes to these files
  happen in later tasks (10, 11) with their own diffs — keeps review clean.
- `DeathSystem`: strip playground team-victory logic (game over handled by GameStateSystem).

**Verify:** typecheck/lint pass; game still boots (systems registered but idle — nothing
spawns yet).

### Task 7: Player drone — entity, movement, camera

**Files:** `src/core/PlayerFactory.ts`, `src/systems/PlayerInputSystem.ts`,
`src/systems/PlayerMovementSystem.ts`, `src/systems/CameraFollowSystem.ts`,
`src/systems/HoverBobSystem.ts`.

- `PlayerFactory.create(world, abilities, assets, scene)`: entity with Transform (0,0,0),
  PhysicsBody (radius `PLAYER_RADIUS`, mass 2), Team 0, UnitStats (alive), abilities init
  component (`Health/MaxHealth = 100`, abilities: `['Ability.AutoAttack']`, tags `['Team.0']`),
  `PlayerInput`, `PlayerProgress`, `PlayerAbilities` (AutoAttack L1, cooldownLeft 0), `IFrames`,
  Mesh (`assetManager.instantiateModel('drone')`; under `?fallbackMeshes=1` a playground-style
  sphere + forward marker), `HoverBob(PLAYER_HOVER_HEIGHT, 0)`, Interpolation, HealthBar.
  Abilities init also grants the level attributes `Attribute.AbilityLevel.*` (all default 1).
- `PlayerInputSystem` / `PlayerMovementSystem`: arena-shooter port (normalize diagonal,
  `body.setVelocity(vx*PLAYER_SPEED, 0, vz*PLAYER_SPEED)`). Movement is camera-relative-north
  (W = −Z world; camera yaw is fixed so no basis rotation needed).
- Player mesh yaw: rotate toward current velocity (frame system, cosmetic slerp; drone strafes
  visually banking ±0.25 rad on X/Z — part of HoverBobSystem).
- `CameraFollowSystem` (frame): three.js PerspectiveCamera at
  `(player.x, cameraConfig.height, player.z + cameraConfig.zOffset)`, lookAt player visual
  position, exponential lerp `min(1, dt*lerpSpeed)`.
- `HoverBobSystem` (frame): `mesh.y = baseHeight + 0.25*sin(t*2.2 + phase)`, plus the banking
  above. Reads interpolated visual positions only.

**Verify:** drone hovers and bobs at height 2.5, WASD and touch joystick move it at 14 u/s,
clamped by worldBounds at ±60; camera follows smoothly; no tick-state floats introduced
(hover/banking live in frame systems only).

### Task 8: Enemies — definitions, factory, Scrab & Walker AI

**Files:** `src/config/enemyDefinitions.ts`, `src/core/EnemyFactory.ts`,
`src/systems/EnemyAISystem.ts`, `src/systems/ContactDamageSystem.ts`.

`enemyDefinitions.ts` (playground unitDefinitions pattern):

```ts
export type EnemyKind = 'scrab' | 'plasmaWalker' | 'breacher';
export interface EnemyDefinition {
  kind: EnemyKind; baseHp: number; speed: FixedPoint; radius: FixedPoint; mass: number;
  contactDamageEffectId: string; xp: number; hoverHeight: number; modelKey: ModelKey;
  stopRange: FixedPoint;            // 0 for melee
  attack?: { abilityId: 'Ability.EnemyPlasma.Shot'; cooldownTicks: number; range: FixedPoint };
  explodeOnDeath?: { radius: FixedPoint; effectId: string };  // breacher, disabled by default
}
```

Values from the spec table. Walker: `stopRange 26`, `attack.cooldownTicks 10`, `range 30`.

- `EnemyFactory.spawn(kind, wave, pos)`: pooled entity; HP = `round(baseHp * (1 +
  ENEMY_HP_SCALE_PER_WAVE*(wave-1)))` (FP-safe integer math: scale by 100), Team 1, tags
  `['Team.1']`, `EnemyAI(kind)`, `ContactDamage`, `TargetState` (target = player id),
  `HoverBob(hoverHeight, GameRandom phase)`, mesh via `instantiateModel(def.modelKey)`
  (`?fallbackMeshes=1` primitives: scrab = small tetra, walker = turret-ish capsule,
  breacher = stretched box).
  Breacher additionally gets `BreacherState`.
- `EnemyAISystem` (scrab + walker only; breacher has its own system):
  adapt playground `MovementSystem.getDesiredDirection` — steer FP-normalized toward player,
  stop at `stopRange` (walker), else keep closing. Walker firing: playground unit-def
  `autoAttack` pattern — tick down per-entity attack timer; when 0 and player within
  `attack.range`, activate `Ability.EnemyPlasma.Shot` (dedicated hook fires one dodgeable
  plasma projectile toward the player's current position, speed `ENEMY_PLASMA_SPEED`;
  hitscan is banned — never reuse PlasmaTank.MachineGun).
- `ContactDamageSystem`: for each enemy overlapping the player (XZ distance ≤ radii sum) and
  player `IFrames.ticksLeft === 0`: apply the enemy's contact damage effect via ability
  system, set `IFrames.ticksLeft = PLAYER_IFRAME_TICKS`. Breacher applies
  `.BreacherCharge` effect + knockback impulse 40 only while `state === 'CHARGE'` (checked
  via BreacherState), else nothing (its own task wires this — here handle scrab/walker).
  Decrement `IFrames` here too.

**Verify (with temporary debug spawner, hotkeys 1/2):** scrabs converge on the moving player
and deal 10 contact damage with visible i-frame blink (frame system tints player mesh);
walkers stop at range 26 and fire dodgeable plasma (player outruns bolts laterally); plasma
damages only the player; enemies push each other without stacking.

### Task 9: Breacher FSM

**Files:** `src/systems/BreacherAISystem.ts`, `ContactDamageSystem` (breacher branch),
telegraph visuals in `src/cues/BreacherTelegraphCue.ts` or frame-side material tween.

- FSM exactly per spec (APPROACH 6 u/s → WINDUP 20 ticks locked dir → CHARGE 18 ticks 34 u/s
  → RECOVER 30 ticks). Implementation notes:
  - During WINDUP/RECOVER velocity is zeroed every tick (playground MovementSystem style).
  - CHARGE writes velocity = `chargeDir * 34` each tick; hitting worldBounds ends CHARGE early
    (position clamped by physics; detect via `ticksLeft` or boundary contact) → RECOVER.
  - On player hit during CHARGE (ContactDamageSystem): `.BreacherCharge` (−25), knockback
    impulse 40 along charge dir via `body.applyImpulse`, breacher → RECOVER.
  - `explodeOnDeath` implemented behind the definition flag (default off): DeathSystem checks
    flag, applies `Effect.Damage.BreacherExplosion` to the player if within radius 6, emits a
    cue. Covered by unit test, not enabled in config.
- Telegraph (cosmetic): WINDUP ramps emissive on engine material + nose tilt; CHARGE leaves a
  short trail (reuse missile exhaust cue with different color if trivial, else skip trail).

**Verify:** breacher approaches, visibly telegraphs ~1 s, charges in a straight line ~30 units;
standing still gets you hit (25 + knockback), sidestepping during windup dodges it; unit test
`test/breacher.spec.ts` drives a scripted world and asserts the state timeline tick-by-tick.

### Task 10: Player abilities — PlayerAbilitySystem, AutoAttack, Volt, Missile splash

**Files:** `src/systems/PlayerAbilitySystem.ts`, edits to `src/hooks/AutoAttack.ts`,
`src/hooks/MissileVolley.ts`, `src/systems/ProjectileCollisionSystem.ts`,
`src/cues/MissileSplashCue.ts`, `src/config/upgrades.ts` (data only; UI in Task 12).

- `PlayerAbilitySystem.processTick`: for each entry in `PlayerAbilitiesComponent`:
  decrement `cooldownLeft`; at 0 attempt activation, then reset to the ability's
  level-scaled cooldown from `upgrades.ts`:
  - **AutoAttack**: needs nearest living enemy within range 30 (FP distance scan over Team 1;
    deterministic tiebreak by entity id). Activate `Ability.AutoAttack` with that target.
    Hook edit: spawn 1 projectile (L1–3) or 2 at ±6° (L4); projectile carries
    `damageEffectId: 'Effect.Damage.AutoAttack'` **and `sourceEntityId` (the player)** —
    `ProjectileCollisionSystem` applies the effect with that source, so the Task 0
    calculation reads `Attribute.AbilityLevel.AutoAttack` **at impact time** (mid-flight
    level-ups apply automatically; snapshot happens at effect application, by design).
  - **Volt**: needs any enemy within `VOLT_DETECTION_RANGE`; activation identical to
    playground VoltAttackSystem flow, but jump count by level (3 or 4) from `upgrades.ts`.
    Every hit (primary + each jump) applies the single `Effect.Damage.Volt` with
    `setByCaller: { 'Volt.JumpIndex': n }` (plain int) — the calculation multiplies level mult ×
    falloff-table entry. ChainLightningJumpSystem passes the jump index it already tracks.
  - **Missile**: fire `missileCount(level)` missiles at up to that many distinct nearest
    enemies (playground volley pattern). Splash: missile impact applies
    `Effect.Damage.Missile.Impact` to the struck enemy plus `Effect.Damage.Missile.Splash`
    (magnitude scales via calculation; **radius** from `upgrades.ts` by level) to every other
    Team-1 unit within splash radius; emit `Cue.Missile.Splash` (ring flash, adapted from
    SauSecondaryImpactCue). Missiles carry `sourceEntityId` = player.
  - **SAU.Deploy**: Task 11.
- Enemy plasma vs player in the same collision system: enemy projectiles apply
  `Effect.Damage.EnemyPlasma` to the player only.
- `upgrades.ts` — single source of truth for level data (cadence/count/radius here; damage
  multipliers exported to the Task 4 calculations from this same file):

```ts
export const ABILITY_LEVELS: Record<PlayerAbilityId, AbilityLevelDef[]> = {
  'Ability.AutoAttack': [
    { cooldownTicks: 20, projectiles: 1 },
    { cooldownTicks: 14, projectiles: 1 },
    { cooldownTicks: 14, projectiles: 1 },   // damage ×1.5 comes from the calculation
    { cooldownTicks: 14, projectiles: 2 },
  ],
  // ... Volt / Missile / SAU rows exactly per spec table
};
```

**Verify:** with debug-granted abilities: AutoAttack tracks nearest enemy and respects range,
damage jumps 18→27 exactly when L3 is applied (debug HP readout); Volt chains N single-target
hits sequentially with falloff per jump (no AoE); missile splash damages clustered scrabs
around the impact; all cooldowns scale per level (debug hotkey applies
`Effect.AbilityLevelUp.*`); `test/upgrades.spec.ts` asserts table shape (4 levels each,
monotonic power) and multiplier maps match the spec table.

### Task 11: SAU deployable turret

**Files:** `src/systems/TurretSystem.ts`, `src/core/TurretFactory.ts`, `DeployedTurretComponent`,
edits to `src/hooks/SauArtillery.ts` (import paths only — hook logic unchanged).

- Activating `SAU.Deploy` (PlayerAbilitySystem): if active turret count ≥ `maxTurrets(level)`,
  despawn the **oldest** turret first; spawn turret entity at the player's position: static
  PhysicsBody (`isStatic`, radius 2.2), Team 0, Health 140 (enemies can't shoot it in MVP but
  contact-push applies; killable post-MVP), `DeployedTurret{ lifetimeLeft, fireCooldownLeft }`,
  mesh `instantiateModel('sauTurret')` (`?fallbackMeshes=1`: playground SAU shape), abilities
  init with `['Ability.SAU.Artillery']` **and its own `Attribute.AbilityLevel.SAU` set to the
  player's SAU level at deploy time** (turret damage is snapshotted at deploy — the turret is
  the source entity for its shells).
- `TurretSystem.processTick`: decrement lifetime → despawn at 0 (pool return + scene cleanup);
  decrement fire cooldown → at 0, if any Team-1 unit within `SAU_DETECTION_RANGE` and outside
  `SAU_MIN_ENGAGEMENT_RANGE`, activate `Ability.SAU.Artillery` at the nearest valid target
  (deterministic tiebreak), reset to `turretFireCooldown(level)`.
- Shell flight, primary AoE, shrapnel arcs, secondary AoE, shadows/cues: **entirely reused**
  from the copied playground systems (ArtilleryShellSystem, ShrapnelLandingSystem, gravity).
  Shells carry `sourceEntityId` = turret; `Effect.Damage.SAU.Primary`'s calculation reads the
  turret's `Attribute.AbilityLevel.SAU`.
- SAU friendly fire stays `false` — blasts never damage the player or turrets.

**Verify:** deploying drops a turret that shells enemy clumps with the full playground visual
chain (muzzle flash, falling shadow, primary blast, shrapnel secondaries); dead-zone respected
(enemies inside 30 units are not shelled); L3 keeps two turrets alive; lifetimes expire cleanly
with no orphaned meshes (inspect `scene.children` count across 5 deploy cycles).

### Task 12: XP, level-ups, upgrade draw + LevelUpOverlay

**Files:** `src/systems/XPLevelSystem.ts`, `src/core/UpgradeDraw.ts`,
`src/ui/LevelUpOverlay.ts`, edits to `DeathSystem` (XP grant, kill counter, drop roll).

- `DeathSystem` edits: on enemy death — `progress.xp += XP_PER_KILL[kind]`, `kills++`,
  `GameRandom.chance(PICKUP_DROP_CHANCE)` → spawn pickup at death position (Task 13),
  decrement `wave.enemiesAlive`.
- `XPLevelSystem`: while `xp >= XP_THRESHOLDS[level-1]` (last threshold repeats beyond L12):
  subtract, `level++`, `pendingLevelUps++`.
- `UpgradeDraw.draw3(progress, abilities, GameRandom)`: pool = new abilities (if
  `abilities.size < 4`) ∪ owned-below-L4 upgrades; uniform draw without replacement; pad with
  `{ kind: 'repair' }` to 3. Pure function over passed-in state — unit-testable.
- Level-up flow (Game.ts glue): after tick, if `pendingLevelUps > 0` and overlay closed:
  `world.pause()`, `LevelUpOverlay.show(draw3(...))`. On pick: apply (add ability at L1 /
  apply `Effect.AbilityLevelUp.<X>` to the player (+ update the `PlayerAbilities` cadence
  entry) / heal 25 via ability system), `pendingLevelUps--`, `world.resume()` (or
  immediately re-show if more pending). Overlay is HTML/CSS in `#ui-root`: 3 cards with
  ability icon placeholder, name, level pips, effect line; keyboard 1/2/3, click, tap.
- `test/xp.spec.ts`: thresholds sum to 679; wave-table XP totals 738 (import `waves.ts`);
  draw3 never offers L5, never duplicates a card, pads with repair when pool < 3.

**Verify:** killing scrabs fills a debug XP readout; at 10 XP the game pauses, three distinct
cards render, choice applies instantly (new ability starts firing / stats change), game
resumes; chained double level-up shows two overlays back-to-back.

### Task 13: Pickups

**Files:** `src/systems/PickupSystem.ts`, `src/core/PickupFactory.ts`.

- Factory: pooled entity, non-colliding-except-player body (filter from Task 5), spinning
  repair-kit mesh (primitive: green cross/box; frame spin), `Pickup` component.
- System: lifetime countdown → despawn; if XZ distance to player ≤ `PICKUP_MAGNET_RADIUS`,
  set velocity toward player at `PICKUP_MAGNET_SPEED` (FP); if ≤ `PICKUP_RADIUS` + player
  radius: apply `Effect.Heal.Pickup`, despawn (heal clamped by Health max — engine clamp).

**Verify:** kits drop at ~15% rate, are vacuumed from 6 units out, heal 25 (HP bar), expire
after 18 s; overheal impossible.

### Task 14: WaveSystem + GameStateSystem

**Files:** `src/config/waves.ts`, `src/systems/WaveSystem.ts`, `src/systems/GameStateSystem.ts`.

- `waves.ts`: the spec's 15-row table as
  `Array<{ scrab: number; plasmaWalker: number; breacher: number }>` + exported totals for tests.
- `WaveSystem` (arena-shooter FSM + staggered spawning):
  - `LOADING`/`WAVE_CLEAR_PAUSE`: timer → on 0, `currentWave++`, build `spawnQueue` =
    shuffled (GameRandom) list of that wave's kinds, `enemiesAlive = queue.length`, → `PLAYING`.
  - `PLAYING`: every `SPAWN_PACKET_INTERVAL_TICKS` pop up to `SPAWN_PACKET_SIZE` kinds and
    spawn each at a perimeter point ≥ `ENEMY_SPAWN_MIN_DIST` from the player (arena-shooter
    perimeter algorithm, GameRandom); when `enemiesAlive === 0 && spawnQueue.length === 0`:
    wave 15 → `VICTORY`, else → `WAVE_CLEAR_PAUSE` (100 ticks).
- `GameStateSystem`: player Health ≤ 0 → `wave.state = 'GAME_OVER'`,
  `simState.gameOver = true`; `VICTORY` → `simState.victory = true`. Game.ts watches simState
  in afterFrame → shows end screen, `world.stop()`.

**Verify:** full run spawns per table (debug fast-forward hotkey ok); packets arrive staggered;
victory triggers after wave 15 clear; dying mid-run shows game over with stats;
`test/waves.spec.ts` asserts totals (204/82/36) and first-appearance waves (walker 3,
breacher 5).

### Task 15: HUD + screens

**Files:** `src/ui/HUD.ts`, `src/ui/Screens.ts`, `src/ui/hud.css`.

HTML/CSS overlay (not canvas GUI): top-left HP bar + numeric; top full-width XP bar + level
badge; top-right `Wave 7/15` + enemies-remaining; bottom-left owned-ability icons with level
pips. Start screen (title, Start button, controls hint), Game Over / Victory screens (wave
reached, kills, time, Restart button → full `Game` re-instantiation with same seed).
Mobile: HUD scales via `clamp()`; safe-area insets respected.

**Verify:** all HUD values live-update; restart produces an identical wave-1 opening
(determinism visible); UI legible on a 375 px-wide phone viewport.

### Task 16: Arena GLB + model integration + visual polish pass

**Files:** `src/core/ArenaBuilder.ts`, manifest entries, `HealthBarSystem`, dev fallback
meshes.

- `ArenaBuilder`: builds arena from `instantiateModel('arena')` (`?fallbackMeshes=1`: flat
  plane 120×120 + border boxes + grid texture), hemisphere + directional light (shadow
  settings from the quality preset), fog for depth.
- Wire all six GLBs through the manifest (scale/yaw); verify hover heights per model;
  health bars (copied playground HealthBar) above enemies only when damaged.
- Perf pass: wave-15 stress scene (debug spawn) ≥ 55 fps on mid hardware **on each quality
  tier**; confirm `AdaptivePerformance` downscales resolution under artificial GPU load and
  recovers; pooled entities verified returned (pool stats debug overlay).

**Verify:** with GLBs committed the game boots through the loader and every model appears
without code changes; a deliberately broken manifest URL blocks startup with the retry
screen; `?fallbackMeshes=1` still plays on primitives.

### Task 17: Determinism + final test sweep

**Files:** `test/determinism.spec.ts`, `test/` gaps.

- Headless world (no renderer — SimulationContainer must construct with a null-scene shim or
  factory flag that skips mesh creation): run 1200 scripted ticks (fixed input script: move
  pattern + debug ability grants) twice from seed; hash all FP transform/health state each
  100 ticks; assert equal.
- Fill any spec-coverage gaps (checklist below), fix flaky pool reuse issues found by the run.

**Verify:** `pnpm test` green including determinism; manual full playthrough win + loss.

---

## Spec coverage checklist

- [ ] Single-player, 20 TPS FP sim, seeded randomness (Tasks 2, 3, 5, 17)
- [ ] Three.js renderer, playground combat stack copied (Tasks 5, 6)
- [ ] Hovering player drone, WASD + touch joystick, camera follow (Tasks 3, 7)
- [ ] 3 enemies: Scrab chase / Walker ranged plasma / Breacher charge FSM (+ off-by-default
      death explosion) with per-wave HP scaling (Tasks 8, 9)
- [ ] Contact damage + i-frames + knockback (Tasks 8, 9)
- [ ] Dynamic magnitude calculation + setByCaller in phalanx-abilities, backward compatible
      (Task 0)
- [ ] AutoAttack innate; Volt sequential chain; Missile + splash AoE; SAU deployable turret;
      4 levels each, damage via ability-level calculations (Tasks 0, 4, 10, 11)
- [ ] Walker fires dedicated dodgeable `Ability.EnemyPlasma.Shot` — no hitscan anywhere
      (Tasks 4, 8)
- [ ] XP on kill, thresholds, 3-card level-up overlay with pause (Task 12)
- [ ] HP pickups with magnet (Task 13)
- [ ] 15 declarative waves, staggered spawns, victory/defeat flow (Task 14)
- [ ] HUD, start/end screens, restart (Task 15)
- [ ] Blocking asset preload (chapaev AssetManager + LoaderOverlay), `?fallbackMeshes=1` dev
      flag, arena model (Tasks 3, 16)
- [ ] Adaptive graphics: quality tiers + runtime resolution scaling, 60 fps budget
      (Tasks 3, 5, 16)
- [ ] Unit + determinism tests (Tasks 2, 4, 9, 10, 12, 14, 17)

## Self-review notes

- Cooldowns are component-timer-driven (not tag effects) **by design** — static effect defs
  can't express per-level cooldowns; don't "fix" this back to `cooldownEffectId`.
- Volt must stay sequential single-target; the AoE niche belongs to Missile splash and SAU.
- Enemy pools + staggered spawn packets exist because wave 15 peaks at 38 units plus
  projectiles/shrapnel; don't spawn a wave in one tick.
- `MAX_UNIT_HEALTH = 300` bound exists for the Health-attribute clamp — recheck if enemy HP
  scaling or wave count changes.
- Damage scaling lives in Task 0 calculations + `upgrades.ts` multiplier maps — there are NO
  per-level effect variants (`Effect.*.L1..L4`); don't reintroduce them.
- Hitscan damage is banned game-wide: every damage source is a dodgeable projectile, splash,
  or telegraphed contact. That's why PlasmaTank.MachineGun was deleted, not reused.
- The only new combat mechanics vs playground are: missile splash, contact damage/i-frames,
  Breacher FSM, turret deploy/lifetime, enemy plasma shot. Everything else is reuse — resist
  scope creep.

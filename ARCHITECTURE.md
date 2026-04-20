# H4KKEN Architecture

## Stack

- **Runtime / package manager**: Bun
- **Bundler**: Vite
- **Renderer**: Babylon.js 8 (left-handed coordinate system, Y-up)
- **Language**: TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`, no `any`)
- **Lint / format / typecheck**: `bun run fix` (biome → tsc → tsc server → knip), stops on first failure

---

## Coordinate system

Babylon.js is **left-handed, Y-up**. Do not set `scene.useRightHandedSystem`.

```
Camera at Z = -10, looking toward +Z.
+X = screen RIGHT   -X = screen LEFT
+Y = up             -Y = down
```

Player 0 spawns at X = -3 (screen left), Player 1 at X = +3 (screen right).

---

## Source layout

```
src/
├── main.ts               Entry point — creates Game, calls game.init()
├── constants.ts          Shared enums: FIGHTER_STATE, GAME_CONSTANTS, HIT_RESULT
├── Audio.ts              Babylon.js Sound-based SFX + BGM managers
├── Camera.ts             Orbiting fight camera (stays on the -Z side)
├── Input.ts              Keyboard input, double-tap, tap-vs-hold detection
├── Network.ts            WebSocket matchmaking and state sync
├── Stage.ts              Arena geometry, lighting, shadow generator, sky shader
├── UI.ts                 DOM HUD (health bars, timer, announcements, flash effects)
│
├── combat/
│   ├── types.ts          Shared combat types: MoveData, HitResult, FighterLike, LEVEL, …
│   ├── moves.ts          Move data table (MOVES) — all frame data, hitboxes, animations
│   └── CombatSystem.ts   Pure functions: resolveMove, resolveHit, checkHitbox, resolveComboInput
│
├── fighter/
│   ├── animations.ts     ANIM_CONFIG, AnimKey type, ANIM_POOLS, UAL clip name unions
│   └── Fighter.ts        Character class: asset loading, skeleton, animation, physics, state machine
│
└── game/
    ├── BotAI.ts          CPU opponent decision loop
    └── Game.ts           Game loop, state machine (LOADING → MENU → FIGHTING …), round logic
```

### Module responsibilities

| Module | Responsibility |
|--------|----------------|
| `constants.ts` | Single source of truth for string enums (`FIGHTER_STATE`, `HIT_RESULT`) and numeric tuning (`GAME_CONSTANTS`) used across multiple modules |
| `combat/types.ts` | Type hub for the combat subsystem — imported by `moves.ts`, `CombatSystem.ts`, and `Fighter.ts` |
| `combat/moves.ts` | Data-only: the `MOVES` record with every move's frame data, damage, hitbox, and animation binding |
| `combat/CombatSystem.ts` | Stateless functions operating on `FighterLike` values; no Babylon.js imports |
| `fighter/animations.ts` | All animation metadata (`ANIM_CONFIG`), typed clip name unions, pools, and `pickRandom` |
| `fighter/Fighter.ts` | Full fighter entity: Babylon.js asset loading, mesh/skeleton/animation management, physics, state machine |
| `game/BotAI.ts` | Encapsulates bot decision state and produces `InputState` each tick |
| `game/Game.ts` | Orchestrates scene setup, the 60 Hz fixed-step game loop, round management, hit sparks, and rendering |

---

## GLB / character pipeline

### Asset file
- `public/assets/models/beano-character.glb` — Beano character mesh + Mixamo 41-bone skeleton + **261 animation clips** (UAL1 + UAL2, retargeted from Quaternius rig to Mixamo rig via Blender 5 headless).

The Blender retargeting script lives at `/tmp/retarget_combined.py` and maps Quaternius bone names to their Mixamo equivalents (pelvis→Hips, spine_01→Spine, etc.).

### Loading (one-time, shared)
`Fighter.loadAssets(scene)` loads `beano-character.glb` via `SceneLoader.ImportMeshAsync`.

Returns `SharedAssets`:
```ts
interface SharedAssets {
  baseMeshes: AbstractMesh[];              // beano mesh, disabled
  baseSkeleton: Skeleton | null;           // Mixamo 41-bone skeleton
  animGroups: Record<string, AnimationGroup>; // keyed by game name
}
```

### Typed animation config — `ANIM_CONFIG`
All animation mappings live in `ANIM_CONFIG` in `fighter/animations.ts`, typed as `satisfies Record<string, AnimConfig>`.

```ts
const ANIM_CONFIG = {
  idle:     { glb: 'Idle_Loop',     loop: true  },
  walkBack: { glb: 'Walk_Bwd_Loop', loop: true  },
  punch1:   { glb: 'Punch_Jab'                  },
  // …
} satisfies Record<string, AnimConfig>;
```

- `glb` is typed as `(typeof BEANO_CLIPS)[number]` — a misspelled clip name is a **compile error**.
- All 261 clips from UAL1+UAL2 are in a single file; no `src` field needed.
- `loop`, `speed`, `blend` control playback.

**To add a new animation:** add an entry to `ANIM_CONFIG` with the exact GLB clip name. The type system will reject any name not in the `BEANO_CLIPS` union.

### Per-fighter init
`fighter.init(assets)`:
1. Creates a `TransformNode` as the positional root.
2. Clones the skeleton → unlinks bones from base TransformNodes.
3. Clones each base mesh → parents to root, reassigns cloned skeleton.
4. Calls `_cloneAnimGroups` → clones every animation group, remapping bone targets to the cloned skeleton via suffix-based bone name matching.
5. Sets initial Y rotation via `_makeRootQuat(rotY)`.

Player 1 gets a red tint by cloning and modifying `PBRMaterial.albedoColor`.

### Facing / rotation
The Beano/Mixamo model natively faces **-Z**.  
Facing angle is the world-space direction toward the opponent (from `Math.atan2`).

```ts
targetRotY = facingAngle - Math.PI / 2;
```

`RotationAxis(Up, θ)` maps model's -Z to world `(-sin θ, 0, -cos θ)`.  
To face `(cos A, 0, sin A)`: `-sin θ = cos A` → `θ = A - π/2`.

---

## Lighting & shadows

Defined in `Stage.setupLighting()`:
- `HemisphericLight` — low intensity (0.25), **no specular** (`Color3.Black()`). Specular on hemisphere = plastic look.
- `DirectionalLight` — sun, drives the `ShadowGenerator`.
- `ShadowGenerator` — 2048 map, PCF filtering (`usePercentageCloserFiltering`).

Arena floors use `PBRMaterial` (roughness ~0.9, metallic 0).  
Background geometry (trees, mountains, pillars) uses `StandardMaterial` with `specularColor = Color3.Black()`.

Fighter meshes are registered as shadow casters in `Game.createFighters()` via `stage.shadowGenerator`.

Post-processing in `game/Game.ts`:
- `DefaultRenderingPipeline` — bloom.
- `ImageProcessingConfiguration` — ACES tone mapping, contrast 1.2.

---

## Game loop

Fixed timestep at 60 Hz via accumulator in `Game._gameLoop()`:
1. Accumulate `engine.getDeltaTime()`.
2. While accumulator ≥ tick duration: run one logic tick (input → `processInput` → `updatePhysics` → collision → combat).
3. Every frame: `updateVisuals()` on each fighter, `Stage.update()` (flame flicker), `fightCamera.update()`, `updateHitParticles()`.

---

## Audio

`Audio.ts` wraps Babylon.js `Sound`. Requires side-effect imports at the top of the file:
```ts
import '@babylonjs/core/Audio/audioSceneComponent';
import '@babylonjs/core/Audio/audioEngine';
```

- **Spatial sounds** (hit, block) — anchored to world position via `playAt(name, pos)`.
- **Flat sounds** (announcer, KO bell, countdown) — via `play(name)`.
- **Variants** — multiple files per sound name, cycled round-robin to avoid repetition.
- **BGM** — handled separately in `Game.ts` via a plain `HTMLAudioElement` (avoids browser autoplay policy).

---

## Multiplayer

Player 0 is authoritative. Each frame Player 0 sends its full game state to Player 1 via the server (`Network`). Player 1 applies received state via `fighter.deserializeState()`. Both players send their local input every tick.

Round results are sent by P0 only — the server relays them to P1.

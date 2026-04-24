# Character build pipeline

Merges any Mixamo-rigged humanoid mesh with Quaternius's UAL animation packs
into a single `public/assets/models/<id>.glb` the game loads at runtime.

**No Blender addons required** — only stock `bpy.ops`. Works with any Mixamo
auto-rigged FBX that includes a T-pose action.

## Run

```sh
bun run build:character          # incremental — skips Blender steps if outputs are newer
bun run build:character --force  # rebuild everything
```

## Add a new character

1. Upload the mesh to [mixamo.com](https://www.mixamo.com) and auto-rig it.
2. Download the FBX with the T-pose animation (any "Without Skin / T-Pose"
   works; the `mixamo.com` action must sit at frame 1).
3. Register the source in [`characters.ts`](characters.ts):

```ts
export const CHARACTERS: CharacterSource[] = [
  { id: 'character',   fbx: `${process.env.HOME}/tmp/hero-mixamo.fbx` },
  { id: 'cowboy',      fbx: `${process.env.HOME}/tmp/cowboy-mixamo.fbx` },
];
```

4. Run `bun run build:character`. Each entry writes
   `public/assets/models/<id>.glb`.

## Env overrides

| Var          | Default                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `BLENDER`    | `/opt/homebrew/bin/blender`                                                 |
| `UAL1_BLEND` | `~/Documents/Universal Animation Library[Source]/UAL1.blend`                |
| `UAL2_BLEND` | `~/Documents/Universal Animation Library 2[Source]/UAL2.blend`              |

## What each step does

1. **`export_ual_anims.py`** — Blender headless. Opens each UAL `.blend`,
   deletes the Mannequin mesh, writes the rig + all 120+ actions as
   `public/assets/models/ual{1,2}_anims.glb`. Runs once per UAL source
   change; shared across all characters.

2. **`export_mesh.py`** — Blender headless. Imports a Mixamo FBX, bakes the
   T-pose into both the mesh vertex data *and* the skeleton rest pose
   (`bpy.ops.pose.armature_apply`), strips all actions, writes
   `<id>_mesh.glb`. The skeleton-rest bake is what lets the retargeter
   produce clean deformations — without it the retargeter math sees mesh
   T-pose + skeleton A-pose rest and distorts wildly.

3. **`build-character.ts`** — Node/Bun + Babylon `NullEngine`. Loads the
   mesh GLB + the two UAL anim GLBs, creates an `AnimatorAvatar` around the
   mesh, retargets every UAL clip referenced by
   [`src/fighter/animations.ts`](../src/fighter/animations.ts) `ANIM_CONFIG`
   onto the character's Mixamo skeleton using the bone map in
   [`src/fighter/boneMap.ts`](../src/fighter/boneMap.ts). Serializes the
   final scene (mesh + skeleton + retargeted animation groups) to
   `<id>.glb`.

## Notes / gotchas

- Mixamo only rigs thumb + index per hand. UAL's middle/ring/pinky bones
  have no target and get dropped; those fingers follow `hand_l` as a blob.
- `UAL_TO_MIXAMO_BONE_MAP` ([src/fighter/boneMap.ts](../src/fighter/boneMap.ts))
  is the only thing tying UAL bone names to Mixamo. Swap to a different
  rig standard by editing that map.
- `ANIM_CONFIG` in `src/fighter/animations.ts` is the single source of
  truth for which UAL clips actually end up shipped. Adding a new clip
  there → rerun `bun run build:character`.

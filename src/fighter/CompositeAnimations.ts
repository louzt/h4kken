// ============================================================
// H4KKEN - Composite Animation Controller
// Layers bone-filtered clips to create blended poses without
// dedicated GLB clips (e.g. crouching legs + blocking arms).
// ============================================================

import { AnimationGroup, type Scene } from '@babylonjs/core';
import { ANIM_CONFIG, type AnimConfig, type AnimKey } from './animations';

// Strip mesh prefix ("<mesh>-") and rig prefix ("mixamorig:") to get bare bone name
function extractBoneName(fullName: string): string {
  let name = fullName;
  const dashIdx = name.indexOf('-');
  if (dashIdx >= 0) name = name.substring(dashIdx + 1);
  const colonIdx = name.indexOf(':');
  if (colonIdx >= 0) name = name.substring(colonIdx + 1);
  return name;
}

type BoneGroup = 'upper' | 'lower';

const BONE_GROUPS: Record<BoneGroup, Set<string>> = {
  upper: new Set([
    'spine_01',
    'spine_02',
    'spine_03',
    'neck_01',
    'Head',
    'clavicle_l',
    'upperarm_l',
    'lowerarm_l',
    'hand_l',
    'index_01_l',
    'index_02_l',
    'index_03_l',
    'index_04_leaf_l',
    'middle_01_l',
    'middle_02_l',
    'middle_03_l',
    'middle_04_leaf_l',
    'ring_01_l',
    'ring_02_l',
    'ring_03_l',
    'ring_04_leaf_l',
    'pinky_01_l',
    'pinky_02_l',
    'pinky_03_l',
    'pinky_04_leaf_l',
    'thumb_01_l',
    'thumb_02_l',
    'thumb_03_l',
    'thumb_04_leaf_l',
    'clavicle_r',
    'upperarm_r',
    'lowerarm_r',
    'hand_r',
    'index_01_r',
    'index_02_r',
    'index_03_r',
    'index_04_leaf_r',
    'middle_01_r',
    'middle_02_r',
    'middle_03_r',
    'middle_04_leaf_r',
    'ring_01_r',
    'ring_02_r',
    'ring_03_r',
    'ring_04_leaf_r',
    'pinky_01_r',
    'pinky_02_r',
    'pinky_03_r',
    'pinky_04_leaf_r',
    'thumb_01_r',
    'thumb_02_r',
    'thumb_03_r',
    'thumb_04_leaf_r',
  ]),
  lower: new Set([
    'root',
    'pelvis',
    'thigh_l',
    'calf_l',
    'foot_l',
    'ball_l',
    'ball_leaf_l',
    'thigh_r',
    'calf_r',
    'foot_r',
    'ball_r',
    'ball_leaf_r',
  ]),
};

interface CompositeLayer {
  anim: AnimKey;
  bones: BoneGroup;
}

interface CompositeAnimDef {
  layers: readonly CompositeLayer[];
  blend?: number;
}

const COMPOSITE_ANIMS: Record<string, CompositeAnimDef> = {
  crouchBlock: {
    layers: [
      { anim: 'crouchIdle', bones: 'lower' },
      { anim: 'block', bones: 'upper' },
    ],
    blend: 0.06,
  },
};

export function isCompositeAnim(name: string): boolean {
  return name in COMPOSITE_ANIMS;
}

export class CompositeAnimController {
  private _groups = new Map<string, AnimationGroup[]>();
  private _activeKey: string | null = null;

  constructor(
    private _scene: Scene,
    private _playerIndex: number,
  ) {}

  build(animGroups: Record<string, AnimationGroup>): void {
    for (const [key, def] of Object.entries(COMPOSITE_ANIMS)) {
      const layers: AnimationGroup[] = [];
      for (const layer of def.layers) {
        const src = animGroups[layer.anim];
        if (!src) continue;

        const boneSet = BONE_GROUPS[layer.bones];
        const filtered = new AnimationGroup(
          `f${this._playerIndex}_comp_${key}_${layer.bones}`,
          this._scene,
        );
        // Each layer inherits loop from its source animation
        const srcCfg = (ANIM_CONFIG as Record<string, AnimConfig>)[layer.anim];
        filtered.loopAnimation = srcCfg?.loop ?? false;

        for (const ta of src.targetedAnimations) {
          const bone = extractBoneName((ta.target as { name?: string })?.name ?? '');
          if (boneSet.has(bone)) {
            filtered.addTargetedAnimation(ta.animation, ta.target);
          }
        }

        if (filtered.targetedAnimations.length === 0) {
          filtered.dispose();
          continue;
        }

        filtered.stop();
        layers.push(filtered);
      }
      this._groups.set(key, layers);
    }
  }

  play(key: string, speedMult: number, blendOverride?: number): boolean {
    const def = COMPOSITE_ANIMS[key];
    const groups = this._groups.get(key);
    if (!def || !groups || groups.length === 0) return false;

    if (this._activeKey === key) return true;

    this.stop();
    this._activeKey = key;
    const blend = blendOverride ?? def.blend ?? 0.15;

    for (const group of groups) {
      group.enableBlending = true;
      group.blendingSpeed = blend;
      group.speedRatio = speedMult;
      const from = Math.min(group.from, group.to);
      const to = Math.max(group.from, group.to);
      group.start(group.loopAnimation, speedMult, from, to);
    }

    return true;
  }

  stop(): void {
    if (this._activeKey === null) return;
    const groups = this._groups.get(this._activeKey);
    if (groups) {
      for (const group of groups) group.stop();
    }
    this._activeKey = null;
  }
}

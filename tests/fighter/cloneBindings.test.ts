import { describe, expect, test } from 'bun:test';
import {
  boneSuffix,
  buildBoneMap,
  cloneAndPrepareSkeleton,
  remapAnimationTarget,
} from '../../src/fighter/cloneBindings';

class FakeBone {
  linkCalls: null[] = [];

  constructor(public name: string) {}

  linkTransformNode(node: null) {
    this.linkCalls.push(node);
  }
}

describe('cloneBindings', () => {
  test('cloneAndPrepareSkeleton unlinks cloned bones and enables matrix textures', () => {
    const clonedSkeleton = {
      bones: [new FakeBone('slot-mixamorig:Hips'), new FakeBone('slot-mixamorig:Spine')],
      useTextureToStoreBoneMatrices: false,
    };
    const baseSkeleton = {
      clone: () => clonedSkeleton,
    };

    const result = cloneAndPrepareSkeleton(baseSkeleton, 'cs_skeleton_-1.2', 'cs_skel_-1.2', {
      useTextureToStoreBoneMatrices: true,
    });

    expect(result).toBe(clonedSkeleton);
    expect(clonedSkeleton.useTextureToStoreBoneMatrices).toBe(true);
    for (const bone of clonedSkeleton.bones) {
      expect(bone.linkCalls).toEqual([null]);
    }
  });

  test('remapAnimationTarget resolves transform-node targets against cloned bones by suffix', () => {
    expect(boneSuffix('f1-mixamorig:Hips')).toBe('mixamorig:Hips');

    const hips = new FakeBone('slot-mixamorig:Hips');
    const leftHand = new FakeBone('mixamorig:LeftHand');
    const boneByName = buildBoneMap({ bones: [hips, leftHand] });

    expect(remapAnimationTarget({ name: 'mixamorig:Hips' }, boneByName)).toBe(hips);
    expect(remapAnimationTarget({ name: 'mixamorig:LeftHand' }, boneByName)).toBe(leftHand);

    const untouchedTarget = { name: 'CameraRig' };
    expect(remapAnimationTarget(untouchedTarget, boneByName)).toBe(untouchedTarget);
  });
});

interface LinkableBoneLike {
  name: string;
  linkTransformNode(node: null): void;
}

interface CloneBindingSkeletonLike<TBone extends LinkableBoneLike = LinkableBoneLike> {
  bones: TBone[];
  useTextureToStoreBoneMatrices?: boolean;
}

interface CloneableSkeletonLike<
  TSkeleton extends CloneBindingSkeletonLike = CloneBindingSkeletonLike,
> {
  clone(name: string, id: string): TSkeleton;
}

export function boneSuffix(name: string): string {
  const idx = name.indexOf('-');
  return idx >= 0 ? name.substring(idx + 1) : name;
}

function unlinkBonesFromTransformNodes<
  TBone extends LinkableBoneLike,
  TSkeleton extends CloneBindingSkeletonLike<TBone>,
>(skeleton: TSkeleton): void {
  for (const bone of skeleton.bones) {
    bone.linkTransformNode(null);
  }
}

export function cloneAndPrepareSkeleton<
  TBone extends LinkableBoneLike,
  TSkeleton extends CloneBindingSkeletonLike<TBone>,
>(
  baseSkeleton: CloneableSkeletonLike<TSkeleton> | null,
  name: string,
  id: string,
  options?: { useTextureToStoreBoneMatrices?: boolean },
): TSkeleton | null {
  const clonedSkeleton = baseSkeleton?.clone(name, id) ?? null;
  if (!clonedSkeleton) return null;

  unlinkBonesFromTransformNodes(clonedSkeleton);
  if (options?.useTextureToStoreBoneMatrices) {
    clonedSkeleton.useTextureToStoreBoneMatrices = true;
  }
  return clonedSkeleton;
}

export function buildBoneMap<TBone extends { name: string }>(
  skeleton: { bones: TBone[] } | null,
): Map<string, TBone> {
  const boneByName = new Map<string, TBone>();
  if (!skeleton) return boneByName;

  for (const bone of skeleton.bones) {
    boneByName.set(boneSuffix(bone.name), bone);
  }
  return boneByName;
}

export function remapAnimationTarget<TTarget>(
  target: TTarget,
  boneByName: Map<string, unknown>,
): TTarget | unknown {
  if (target && typeof target === 'object' && 'name' in target) {
    const mapped = boneByName.get(boneSuffix((target as { name: string }).name));
    if (mapped) return mapped;
  }
  return target;
}

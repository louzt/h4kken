// UAL (UE5 Mannequin) bone name → Beano Mixamo bone name.
// Used by Babylon's AnimatorAvatar to retarget UAL animations onto Beano's
// Mixamo-rigged mesh. Source names are the Rigify DEF / UE5 names that UAL's
// glTF exports (pelvis, upperarm_l, etc.). Target names are Beano's Mixamo
// bones (mixamorig:Hips, mixamorig:LeftArm, etc.).
//
// Unmapped UAL bones (middle / ring / pinky finger segments, leaf bones, CTRL
// bones) are skipped by the retargeter. Those UAL animations animate bones
// Beano doesn't have — his fingers follow mixamorig:LeftHand as a blob.
export const UAL_TO_MIXAMO_BONE_MAP = new Map<string, string>([
  ['pelvis', 'mixamorig:Hips'],
  ['spine_01', 'mixamorig:Spine'],
  ['spine_02', 'mixamorig:Spine1'],
  ['spine_03', 'mixamorig:Spine2'],
  ['neck_01', 'mixamorig:Neck'],
  ['Head', 'mixamorig:Head'],

  ['clavicle_l', 'mixamorig:LeftShoulder'],
  ['upperarm_l', 'mixamorig:LeftArm'],
  ['lowerarm_l', 'mixamorig:LeftForeArm'],
  ['hand_l', 'mixamorig:LeftHand'],
  ['thumb_01_l', 'mixamorig:LeftHandThumb1'],
  ['thumb_02_l', 'mixamorig:LeftHandThumb2'],
  ['thumb_03_l', 'mixamorig:LeftHandThumb3'],
  ['index_01_l', 'mixamorig:LeftHandIndex1'],
  ['index_02_l', 'mixamorig:LeftHandIndex2'],
  ['index_03_l', 'mixamorig:LeftHandIndex3'],

  ['clavicle_r', 'mixamorig:RightShoulder'],
  ['upperarm_r', 'mixamorig:RightArm'],
  ['lowerarm_r', 'mixamorig:RightForeArm'],
  ['hand_r', 'mixamorig:RightHand'],
  ['thumb_01_r', 'mixamorig:RightHandThumb1'],
  ['thumb_02_r', 'mixamorig:RightHandThumb2'],
  ['thumb_03_r', 'mixamorig:RightHandThumb3'],
  ['index_01_r', 'mixamorig:RightHandIndex1'],
  ['index_02_r', 'mixamorig:RightHandIndex2'],
  ['index_03_r', 'mixamorig:RightHandIndex3'],

  ['thigh_l', 'mixamorig:LeftUpLeg'],
  ['calf_l', 'mixamorig:LeftLeg'],
  ['foot_l', 'mixamorig:LeftFoot'],
  ['ball_l', 'mixamorig:LeftToeBase'],
  ['thigh_r', 'mixamorig:RightUpLeg'],
  ['calf_r', 'mixamorig:RightLeg'],
  ['foot_r', 'mixamorig:RightFoot'],
  ['ball_r', 'mixamorig:RightToeBase'],
]);

// ============================================================
// H4KKEN - Fighter (Model, Animation, State Machine, Physics)
// ============================================================

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import {
  FIGHTER_STATE, GAME_CONSTANTS, CombatSystem, MOVES, HIT_RESULT, LEVEL
} from './Combat.js';

const GC = GAME_CONSTANTS;

// Animation file mapping
const ANIM_FILES = {
  idle:         'Arnold_Idle.fbx',
  combatIdle:   'Arnold_Combat_Idle.fbx',
  crouchIdle:   'Arnold_Crouch_Idle.fbx',
  crouchWalk:   'Arnold_Crouch_Walk.fbx',
  walk:         'Arnold_Walk.fbx',
  walkBack:     'Arnold_Walk_Backwards.fbx',
  walkLeft:     'Arnold_Walk_Left.fbx',
  walkRight:    'Arnold_Walk_Right.fbx',
  run:          'Arnold_Run.fbx',
  runBack:      'Arnold_Run_back.fbx',
  sprint:       'Arnold_Sprint.fbx',
  jump:         'Arnold_Jump.fbx',
  falling:      'Arnold_Falling.fbx',
  landing:      'Arnold_Landing.fbx',
  punch1:       'Arnold_Punch_01.fbx',
  punch2:       'Arnold_Punch_02.fbx',
  heavyPunch:   'Arnold_Heavy_Punch.fbx',
  hurt1:        'Arnold_Hurt_01.fbx',
  hurt2:        'Arnold_Hurt_02.fbx',
  leanRight:    'Arnold_Lean_Right.fbx',
  leanLeft:     'Arnold_Left_Left.fbx',
  victory:      'Arnold_Victory.fbx',
};

export class Fighter {
  constructor(playerIndex, scene) {
    this.playerIndex = playerIndex;
    this.scene = scene;

    // Visual
    this.model = null;
    this.mixer = null;
    this.animations = {};
    this.actions = {};
    this.currentAction = null;
    this.skeleton = null;

    // State
    this.state = FIGHTER_STATE.IDLE;
    this.previousState = FIGHTER_STATE.IDLE;
    this.position = new THREE.Vector3(playerIndex === 0 ? -3 : 3, 0, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    // facing is always 1 for both players: right key = forward (toward opponent).
    // The camera always shows the local player on the left, so right=forward
    // is the correct screen-space mapping for everyone.
    this.facing = 1;
    // Fight-axis angle: radians from +X axis toward opponent in world XZ plane
    this.facingAngle = playerIndex === 0 ? 0 : Math.PI;
    this.health = GC.MAX_HEALTH;
    this.maxHealth = GC.MAX_HEALTH;

    // Combat
    this.currentMove = null;
    this.moveFrame = 0;
    this.hasHitThisMove = false;
    this.isBlocking = false;
    this.isCrouching = false;
    this.isGrounded = true;
    this.comboCount = 0;
    this.comboDamage = 0;
    this.comboTimer = 0;
    this.stunFrames = 0;
    this.wins = 0;

    // Getup / knockdown
    this.knockdownTimer = 0;
    this.getupTimer = 0;

    // Sidestep
    this.sideStepDir = 0;
    this.sideStepTimer = 0;

    // Dash
    this.dashTimer = 0;
    this.isRunning = false;
    this.runFrames = 0;

    // Landing
    this.landingTimer = 0;

    // Hit effect
    this.hitFlash = 0;
    this._cachedMaterials = null; // cached for fast hit-flash updates

    // Root bone reference (for root motion constraint)
    this.rootBone = null;
    this.rootBoneBindX = 0;
    this.rootBoneBindZ = 0;
  }

  /**
   * Retarget animation clip track names to match the target model's node hierarchy.
   * FBX animation files may use different path prefixes for the same bones.
   */
  static retargetClip(clip, validNodeNames) {
    for (const track of clip.tracks) {
      const propMatch = track.name.match(
        /\.(position|quaternion|scale|morphTargetInfluences|visible)(\[.*\])?$/
      );
      if (!propMatch) continue;

      const propPart = propMatch[0];
      const nodePart = track.name.substring(0, track.name.length - propPart.length);

      if (validNodeNames.has(nodePart)) continue;

      const parts = nodePart.split('/');
      let matched = false;
      for (let j = 1; j < parts.length; j++) {
        const candidate = parts.slice(j).join('/');
        if (validNodeNames.has(candidate)) {
          track.name = candidate + propPart;
          matched = true;
          break;
        }
      }

      if (!matched && parts.length > 1) {
        const last = parts[parts.length - 1];
        if (validNodeNames.has(last)) {
          track.name = last + propPart;
        }
      }
    }
    return clip;
  }

  /**
   * Trim a clip to the region where actual motion occurs.
   * Many AnimPack FBX files store the real animation in the last ~1-3 seconds
   * with the rest being a static held pose.
   * @param {THREE.AnimationClip} clip
   * @param {number} [padBefore=0.1] extra seconds before detected motion start
   * @returns {THREE.AnimationClip} new trimmed clip
   */
  static trimClip(clip, padBefore = 0.1) {
    const threshold = 0.005; // minimum rotation-velocity to count as motion

    // 1. Find earliest time across ALL quaternion tracks (excluding root/pelvis)
    //    where meaningful rotation change occurs
    let firstMotion = clip.duration;
    let lastMotion = 0;

    for (const track of clip.tracks) {
      if (!track.name.includes('.quaternion')) continue;
      // Skip root/pelvis to avoid detecting subtle sway as "motion"
      if (track.name.startsWith('root.') || track.name.startsWith('pelvis.')) continue;

      const times = track.times;
      const vals = track.values;
      const stride = 4; // quaternion
      for (let i = 1; i < times.length; i++) {
        const dt = times[i] - times[i - 1];
        if (dt <= 0) continue;
        let diff = 0;
        for (let c = 0; c < stride; c++) {
          const d = vals[i * stride + c] - vals[(i - 1) * stride + c];
          diff += d * d;
        }
        const vel = Math.sqrt(diff) / dt;
        if (vel > threshold) {
          if (times[i - 1] < firstMotion) firstMotion = times[i - 1];
          if (times[i] > lastMotion) lastMotion = times[i];
        }
      }
    }

    // If no significant motion found, or dead section is trivial (< 0.15 s), keep as is
    if (firstMotion >= lastMotion || firstMotion < 0.15) return clip;

    const trimStart = Math.max(0, firstMotion - padBefore);
    const trimEnd = clip.duration; // keep to end

    // 2. Build new tracks trimmed to [trimStart, trimEnd], re-based to time 0
    const newTracks = [];
    for (const track of clip.tracks) {
      const times = track.times;
      const vals = track.values;
      const valSize = vals.length / times.length;

      // Find index range that overlaps [trimStart, trimEnd]
      let iStart = 0;
      while (iStart < times.length - 1 && times[iStart + 1] < trimStart) iStart++;
      let iEnd = times.length - 1;
      while (iEnd > 0 && times[iEnd - 1] > trimEnd) iEnd--;

      const count = iEnd - iStart + 1;
      if (count < 2) {
        // Keep at least 2 keyframes (start/end with same value)
        const newTimes = new Float32Array([0, trimEnd - trimStart]);
        const newVals = new Float32Array(valSize * 2);
        for (let c = 0; c < valSize; c++) {
          newVals[c] = vals[iStart * valSize + c];
          newVals[valSize + c] = vals[iStart * valSize + c];
        }
        newTracks.push(new THREE.KeyframeTrack(track.name, newTimes, newVals));
        continue;
      }

      const newTimes = new Float32Array(count);
      const newVals = new Float32Array(count * valSize);
      for (let i = 0; i < count; i++) {
        newTimes[i] = times[iStart + i] - trimStart;
        for (let c = 0; c < valSize; c++) {
          newVals[i * valSize + c] = vals[(iStart + i) * valSize + c];
        }
      }
      // Ensure first keyframe is at time 0
      if (newTimes[0] > 0) newTimes[0] = 0;

      newTracks.push(new THREE.KeyframeTrack(track.name, newTimes, newVals));
    }

    const trimmedClip = new THREE.AnimationClip(clip.name, trimEnd - trimStart, newTracks);
    return trimmedClip;
  }

  // Load the base model and all animations
  static async loadAssets(onProgress) {
    const loader = new FBXLoader();
    const basePath = 'assets/models/';
    const texturePath = 'assets/textures/BaseColor.png';
    
    const totalFiles = Object.keys(ANIM_FILES).length + 1;
    let loaded = 0;

    const report = () => {
      loaded++;
      if (onProgress) onProgress(loaded / totalFiles);
    };

    // Load base model
    const baseModel = await loader.loadAsync(basePath + 'Arnold.fbx');
    report();

    // Collect all node names from the base model for animation retargeting
    const validNodeNames = new Set();
    baseModel.traverse(node => {
      if (node.name) validNodeNames.add(node.name);
    });
    console.log('[H4KKEN] Base model nodes:', [...validNodeNames]);

    // Load texture
    const textureLoader = new THREE.TextureLoader();
    const texture = await textureLoader.loadAsync(texturePath);
    texture.colorSpace = THREE.SRGBColorSpace;

    // Apply texture to model
    baseModel.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach(mat => {
            mat.map = texture;
            mat.needsUpdate = true;
          });
        }
      }
    });

    // Load all animations
    const animClips = {};
    const animEntries = Object.entries(ANIM_FILES);
    
    for (let i = 0; i < animEntries.length; i += 4) {
      const batch = animEntries.slice(i, i + 4);
      const results = await Promise.all(
        batch.map(([name, file]) =>
          loader.loadAsync(basePath + file).then(fbx => {
            report();
            return { name, fbx };
          })
        )
      );
      results.forEach(({ name, fbx }) => {
        if (fbx.animations && fbx.animations.length > 0) {
          let clip = fbx.animations[0];
          clip.name = name;

          // Retarget track names to match the base model's skeleton
          Fighter.retargetClip(clip, validNodeNames);

          // Trim clip to active motion range (AnimPack FBX files often
          // pack the real animation in the last ~1s of a 30s timeline)
          const origDur = clip.duration;
          clip = Fighter.trimClip(clip);

          console.log(
            `[H4KKEN] Anim "${name}": ${origDur.toFixed(2)}s → trimmed ${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks`
          );
          animClips[name] = clip;
        } else {
          console.warn(`[H4KKEN] No animation data in ${name}`);
        }
      });
    }

    // Generate procedural kick animations (no kick FBX in asset pack)
    Fighter.createProceduralKicks(baseModel, animClips);

    return { baseModel, animClips, texture };
  }

  /**
   * Build procedural kick AnimationClips by sampling combat-idle first frame
   * as the base pose and layering leg rotations on the correct local-space axes.
   *
   * Bone analysis (from animation data) shows:
   *   - thigh_r/l forward kick is primarily Z-axis rotation in local space
   *   - calf straighten/bend is primarily Z-axis rotation in local space
   *   - spine lean is Z-axis rotation (+Z = lean back, -Z = lean forward)
   *   - UE4 right-side thigh has Z≈180° in T-pose, so axes are mirrored vs left
   *
   * Creates: kickRight, kickLeft, lowKick, sweepKick
   */
  static createProceduralKicks(baseModel, animClips) {
    // 1. Extract first-frame quaternions & positions from combat idle clip
    //    This gives us the fighting-stance as our base pose (not T-pose)
    const idleClip = animClips['combatIdle'];
    const idlePose = {};  // boneName → Quaternion
    const idlePos  = {};  // boneName → Vector3

    for (const track of idleClip.tracks) {
      const dotIdx = track.name.lastIndexOf('.');
      const boneName = track.name.substring(0, dotIdx);
      const prop     = track.name.substring(dotIdx + 1);

      if (prop === 'quaternion' && track.values.length >= 4) {
        idlePose[boneName] = new THREE.Quaternion(
          track.values[0], track.values[1], track.values[2], track.values[3]
        );
      } else if (prop === 'position' && track.values.length >= 3) {
        idlePos[boneName] = new THREE.Vector3(
          track.values[0], track.values[1], track.values[2]
        );
      }
    }

    // Forward-kick rotation axes in bone-local space (derived from jump animation delta analysis)
    // thigh_r: +angle = forward kick,  thigh_l: +angle = forward kick
    const THIGH_R_FWD = new THREE.Vector3( 0.017, -0.322,  0.940).normalize();
    const THIGH_L_FWD = new THREE.Vector3( 0.039,  0.583, -0.808).normalize();
    // Calf extension axis (straighten knee): +angle = extend
    const CALF_R_EXT  = new THREE.Vector3(-0.576, -0.287,  0.749).normalize();
    const CALF_L_EXT  = new THREE.Vector3( 0.576, -0.287,  0.749).normalize(); // mirrored

    // Helper: compute quaternion by applying an axis-angle offset to a base pose
    function offsetQ(boneName, axis, angle) {
      const base = idlePose[boneName];
      if (!base) return new THREE.Quaternion();
      const off = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      return base.clone().multiply(off);
    }

    // Helper: apply Euler offset (for non-critical bones like spine/foot)
    function eulerOffsetQ(boneName, rx, ry, rz) {
      const base = idlePose[boneName];
      if (!base) return new THREE.Quaternion();
      const off = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0));
      return base.clone().multiply(off);
    }

    /**
     * Build a complete kick animation clip.
     * ALL bones in the idle pose get a track (so arms/spine hold fighting stance).
     * Animated bones override their idle values with keyframed motion.
     *
     * @param {string} name - clip name
     * @param {number} duration - clip duration in seconds
     * @param {Object} boneAnims - { boneName: [{ t, q: THREE.Quaternion }, ...], '_pelvisShift': [...] }
     */
    function buildKickClip(name, duration, boneAnims) {
      const tracks = [];
      const animBones = new Set(Object.keys(boneAnims).filter(k => !k.startsWith('_')));

      // Quaternion tracks for every bone
      for (const [boneName, q] of Object.entries(idlePose)) {
        if (animBones.has(boneName)) {
          const kfs = boneAnims[boneName];
          const times  = new Float32Array(kfs.map(kf => kf.t));
          const values = new Float32Array(kfs.length * 4);
          for (let i = 0; i < kfs.length; i++) {
            const qv = kfs[i].q;
            values[i * 4]     = qv.x;
            values[i * 4 + 1] = qv.y;
            values[i * 4 + 2] = qv.z;
            values[i * 4 + 3] = qv.w;
          }
          tracks.push(new THREE.QuaternionKeyframeTrack(
            `${boneName}.quaternion`, times, values
          ));
        } else {
          // Hold idle pose for duration
          tracks.push(new THREE.QuaternionKeyframeTrack(
            `${boneName}.quaternion`,
            new Float32Array([0, duration]),
            new Float32Array([q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w])
          ));
        }
      }

      // Position tracks for every bone
      for (const [boneName, pos] of Object.entries(idlePos)) {
        if (boneAnims['_pelvisShift'] && boneName === 'pelvis') {
          const pk = boneAnims['_pelvisShift'];
          const times  = new Float32Array(pk.map(kf => kf.t));
          const values = new Float32Array(pk.length * 3);
          for (let i = 0; i < pk.length; i++) {
            values[i * 3]     = pos.x + (pk[i].dx || 0);
            values[i * 3 + 1] = pos.y + (pk[i].dy || 0);
            values[i * 3 + 2] = pos.z + (pk[i].dz || 0);
          }
          tracks.push(new THREE.VectorKeyframeTrack(
            'pelvis.position', times, values
          ));
        } else {
          tracks.push(new THREE.VectorKeyframeTrack(
            `${boneName}.position`,
            new Float32Array([0, duration]),
            new Float32Array([pos.x, pos.y, pos.z, pos.x, pos.y, pos.z])
          ));
        }
      }

      const clip = new THREE.AnimationClip(name, duration, tracks);
      console.log(`[H4KKEN] Procedural "${name}": ${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks`);
      return clip;
    }

    // Shorthand: idle (no offset), axis-angle offset, Euler offset
    const idle = (bone) => idlePose[bone] ? idlePose[bone].clone() : new THREE.Quaternion();
    const aa   = (bone, axis, angle) => offsetQ(bone, axis, angle);
    const eu   = (bone, rx, ry, rz)  => eulerOffsetQ(bone, rx, ry, rz);

    // ───────────────── Right Kick (fast mid kick, right leg) ─────────────────
    animClips['kickRight'] = buildKickClip('kickRight', 0.50, {
      'thigh_r': [
        { t: 0.00, q: idle('thigh_r') },
        { t: 0.08, q: aa('thigh_r', THIGH_R_FWD, -0.25) },      // wind-up (pull back)
        { t: 0.20, q: aa('thigh_r', THIGH_R_FWD,  1.35) },      // kick forward
        { t: 0.35, q: aa('thigh_r', THIGH_R_FWD,  1.15) },      // hold
        { t: 0.50, q: idle('thigh_r') },                          // return
      ],
      'calf_r': [
        { t: 0.00, q: idle('calf_r') },
        { t: 0.08, q: aa('calf_r', CALF_R_EXT, -0.5) },         // knee bends during wind-up
        { t: 0.20, q: aa('calf_r', CALF_R_EXT,  0.65) },        // leg extends on kick
        { t: 0.35, q: aa('calf_r', CALF_R_EXT,  0.55) },        // hold extended
        { t: 0.50, q: idle('calf_r') },                           // return
      ],
      'foot_r': [
        { t: 0.00, q: idle('foot_r') },
        { t: 0.20, q: eu('foot_r', -0.3, 0, 0) },               // flex foot
        { t: 0.50, q: idle('foot_r') },
      ],
      // Lean back slightly during kick
      'spine_01': [
        { t: 0.00, q: idle('spine_01') },
        { t: 0.15, q: eu('spine_01', 0, 0, 0.15) },             // lean back
        { t: 0.50, q: idle('spine_01') },
      ],
      // Support leg bends slightly
      'thigh_l': [
        { t: 0.00, q: idle('thigh_l') },
        { t: 0.15, q: aa('thigh_l', THIGH_L_FWD, -0.10) },      // slight support bend
        { t: 0.50, q: idle('thigh_l') },
      ],
      'calf_l': [
        { t: 0.00, q: idle('calf_l') },
        { t: 0.15, q: aa('calf_l', CALF_L_EXT, -0.15) },        // slight knee bend
        { t: 0.50, q: idle('calf_l') },
      ],
      '_pelvisShift': [
        { t: 0.00 },
        { t: 0.15, dy: 2 },
        { t: 0.50 },
      ],
    });

    // ───────────────── Left Kick (power mid kick, left leg) ─────────────────
    animClips['kickLeft'] = buildKickClip('kickLeft', 0.65, {
      'thigh_l': [
        { t: 0.00, q: idle('thigh_l') },
        { t: 0.12, q: aa('thigh_l', THIGH_L_FWD, -0.30) },      // wind-up
        { t: 0.30, q: aa('thigh_l', THIGH_L_FWD,  1.50) },      // powerful kick forward
        { t: 0.45, q: aa('thigh_l', THIGH_L_FWD,  1.25) },      // follow through
        { t: 0.65, q: idle('thigh_l') },
      ],
      'calf_l': [
        { t: 0.00, q: idle('calf_l') },
        { t: 0.12, q: aa('calf_l', CALF_L_EXT, -0.50) },        // knee bends
        { t: 0.30, q: aa('calf_l', CALF_L_EXT,  0.40) },        // extends
        { t: 0.45, q: aa('calf_l', CALF_L_EXT,  0.30) },        // hold
        { t: 0.65, q: idle('calf_l') },
      ],
      'foot_l': [
        { t: 0.00, q: idle('foot_l') },
        { t: 0.30, q: eu('foot_l', -0.35, 0, 0) },              // flex foot
        { t: 0.65, q: idle('foot_l') },
      ],
      'spine_01': [
        { t: 0.00, q: idle('spine_01') },
        { t: 0.20, q: eu('spine_01', 0, 0, 0.18) },             // lean back
        { t: 0.65, q: idle('spine_01') },
      ],
      // Support leg bends
      'thigh_r': [
        { t: 0.00, q: idle('thigh_r') },
        { t: 0.20, q: aa('thigh_r', THIGH_R_FWD, -0.12) },      // brace
        { t: 0.65, q: idle('thigh_r') },
      ],
      '_pelvisShift': [
        { t: 0.00 },
        { t: 0.20, dy: 3 },
        { t: 0.65 },
      ],
    });

    // ───────────────── Low Kick (quick low right leg) ─────────────────
    //   Kick goes low and slightly outward; body drops down
    const LOW_KICK_DIR = new THREE.Vector3(0.05, -0.55, 0.83).normalize(); // forward + outward
    animClips['lowKick'] = buildKickClip('lowKick', 0.45, {
      'thigh_r': [
        { t: 0.00, q: idle('thigh_r') },
        { t: 0.10, q: aa('thigh_r', LOW_KICK_DIR,  0.45) },     // leg goes low/out
        { t: 0.25, q: aa('thigh_r', LOW_KICK_DIR,  0.80) },     // extended low
        { t: 0.45, q: idle('thigh_r') },
      ],
      'calf_r': [
        { t: 0.00, q: idle('calf_r') },
        { t: 0.10, q: aa('calf_r', CALF_R_EXT, -0.25) },        // slightly bent
        { t: 0.25, q: aa('calf_r', CALF_R_EXT,  0.35) },        // extends
        { t: 0.45, q: idle('calf_r') },
      ],
      'spine_01': [
        { t: 0.00, q: idle('spine_01') },
        { t: 0.15, q: eu('spine_01', 0, 0, -0.15) },            // lean forward for low kick
        { t: 0.45, q: idle('spine_01') },
      ],
      // Support leg bends deeper
      'thigh_l': [
        { t: 0.00, q: idle('thigh_l') },
        { t: 0.15, q: aa('thigh_l', THIGH_L_FWD,  0.20) },
        { t: 0.45, q: idle('thigh_l') },
      ],
      'calf_l': [
        { t: 0.00, q: idle('calf_l') },
        { t: 0.15, q: aa('calf_l', CALF_L_EXT, -0.30) },
        { t: 0.45, q: idle('calf_l') },
      ],
      '_pelvisShift': [
        { t: 0.00 },
        { t: 0.15, dy: -5 },
        { t: 0.45 },
      ],
    });

    // ───────────────── Sweep Kick (round sweep, left leg) ─────────────────
    //   Character drops low and sweeps left leg in a wide arc
    const SWEEP_ARC = new THREE.Vector3(0.10, 0.75, -0.65).normalize(); // wide outward arc
    animClips['sweepKick'] = buildKickClip('sweepKick', 0.70, {
      'thigh_l': [
        { t: 0.00, q: idle('thigh_l') },
        { t: 0.10, q: aa('thigh_l', THIGH_L_FWD,  0.30) },      // prep
        { t: 0.25, q: aa('thigh_l', SWEEP_ARC,     0.90) },      // sweep out wide
        { t: 0.45, q: aa('thigh_l', SWEEP_ARC,     0.70) },      // sweep through
        { t: 0.70, q: idle('thigh_l') },
      ],
      'calf_l': [
        { t: 0.00, q: idle('calf_l') },
        { t: 0.25, q: aa('calf_l', CALF_L_EXT,  0.30) },        // extended
        { t: 0.45, q: aa('calf_l', CALF_L_EXT,  0.20) },
        { t: 0.70, q: idle('calf_l') },
      ],
      'spine_01': [
        { t: 0.00, q: idle('spine_01') },
        { t: 0.15, q: eu('spine_01', 0, 0, -0.25) },            // lean forward for sweep
        { t: 0.45, q: eu('spine_01', 0, 0, -0.25) },            // stay leaning
        { t: 0.70, q: idle('spine_01') },
      ],
      // Support leg bends deep for sweep crouch
      'thigh_r': [
        { t: 0.00, q: idle('thigh_r') },
        { t: 0.15, q: aa('thigh_r', THIGH_R_FWD,  0.40) },      // deep crouch
        { t: 0.45, q: aa('thigh_r', THIGH_R_FWD,  0.40) },      // hold
        { t: 0.70, q: idle('thigh_r') },
      ],
      'calf_r': [
        { t: 0.00, q: idle('calf_r') },
        { t: 0.15, q: aa('calf_r', CALF_R_EXT, -0.50) },        // deep bend
        { t: 0.45, q: aa('calf_r', CALF_R_EXT, -0.50) },        // hold
        { t: 0.70, q: idle('calf_r') },
      ],
      '_pelvisShift': [
        { t: 0.00 },
        { t: 0.15, dy: -10 },
        { t: 0.45, dy: -10 },
        { t: 0.70 },
      ],
    });
  }

  init(baseModel, animClips, texture) {
    // Clone the model properly (handles SkinnedMesh + Skeleton)
    this.model = SkeletonUtils.clone(baseModel);
    
    // Scale model
    this.model.scale.set(0.013, 0.013, 0.013);
    
    // Position
    this.model.position.copy(this.position);
    this.model.rotation.y = this.facing > 0 ? Math.PI / 2 : -Math.PI / 2;

    // Apply unique tint for Player 2
    if (this.playerIndex === 1) {
      this.model.traverse(child => {
        if (child.isMesh) {
          // Clone materials to avoid sharing with P1
          if (Array.isArray(child.material)) {
            child.material = child.material.map(m => {
              const cloned = m.clone();
              cloned.color = new THREE.Color(0.6, 0.4, 0.4);
              cloned.emissive = new THREE.Color(0.15, 0.02, 0.02);
              return cloned;
            });
          } else {
            child.material = child.material.clone();
            child.material.color = new THREE.Color(0.6, 0.4, 0.4);
            child.material.emissive = new THREE.Color(0.15, 0.02, 0.02);
          }
        }
      });
    }

    // Find root bone and cache materials for fast per-frame access
    this.rootBone = null;
    const matSet = new Set();
    this.model.traverse(child => {
      if (child.isBone && !this.rootBone) {
        this.rootBone = child;
        this.rootBoneBindX = child.position.x;
        this.rootBoneBindZ = child.position.z;
      }
      if (child.isMesh) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => matSet.add(m));
      }
    });
    this._cachedMaterials = [...matSet];

    // Create animation mixer
    this.mixer = new THREE.AnimationMixer(this.model);

    // Animation categories
    const onceAnimations = new Set([
      'punch1', 'punch2', 'heavyPunch',
      'hurt1', 'hurt2',
      'jump', 'landing', 'victory',
      'leanRight', 'leanLeft',
      'kickRight', 'kickLeft', 'lowKick', 'sweepKick',
    ]);

    // Register all animation clips
    for (const [name, clip] of Object.entries(animClips)) {
      this.animations[name] = clip;
      const action = this.mixer.clipAction(clip);
      this.actions[name] = action;

      action.setEffectiveTimeScale(1);
      action.setEffectiveWeight(0);

      if (onceAnimations.has(name)) {
        action.setLoop(THREE.LoopOnce);
        action.clampWhenFinished = true;
      } else {
        // Explicitly force looping for movement/idle animations
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
    }

    this.scene.add(this.model);

    // Play initial idle
    this.playAnimation('combatIdle', 0.2);
  }

  playAnimation(name, crossfadeDuration = 0.15, speed = 1.0) {
    const newAction = this.actions[name];
    if (!newAction) return;

    if (this.currentAction === newAction && newAction.isRunning()) return;

    newAction.reset();
    newAction.setEffectiveTimeScale(speed);
    newAction.setEffectiveWeight(1);

    if (this.currentAction && this.currentAction !== newAction) {
      // Use fadeOut/fadeIn instead of crossFadeTo to avoid time-scale warping
      this.currentAction.fadeOut(crossfadeDuration);
      newAction.fadeIn(crossfadeDuration);
    }

    newAction.play();
    this.currentAction = newAction;
  }

  reset(startX) {
    this.position.set(startX, 0, 0);
    this.velocity.set(0, 0, 0);
    this.health = GC.MAX_HEALTH;
    this.state = FIGHTER_STATE.IDLE;
    this.currentMove = null;
    this.moveFrame = 0;
    this.hasHitThisMove = false;
    this.isBlocking = false;
    this.isCrouching = false;
    this.isGrounded = true;
    this.comboCount = 0;
    this.comboDamage = 0;
    this.comboTimer = 0;
    this.stunFrames = 0;
    this.knockdownTimer = 0;
    this.getupTimer = 0;
    this.sideStepTimer = 0;
    this.dashTimer = 0;
    this.isRunning = false;
    this.runFrames = 0;
    this.landingTimer = 0;
    this.hitFlash = 0;
    // facing is always 1 (right=forward), facingAngle tracks world direction
    this.facing = 1;
    this.facingAngle = startX < 0 ? 0 : Math.PI;

    this.playAnimation('combatIdle', 0.3);
  }

  // Process input and update fighter state
  processInput(input, opponentPos) {
    // Compute fight-axis angle: direction from this fighter to opponent in world XZ
    const dxWorld = opponentPos.x - this.position.x;
    const dzWorld = opponentPos.z - this.position.z;
    const toOpponentAngle = Math.atan2(dzWorld, dxWorld);

    // Update fight-axis angle (always track opponent, except mid-attack/stun)
    // NOTE: this.facing is FIXED per player (P1=1, P2=-1) — it never changes.
    // The camera always orbits so P2 is screen-right of P1, so the LEFT/RIGHT
    // key mapping must stay constant regardless of world positions.
    const canUpdateFacing = this.state !== FIGHTER_STATE.ATTACKING &&
        this.state !== FIGHTER_STATE.HIT_STUN &&
        this.state !== FIGHTER_STATE.JUGGLE &&
        this.state !== FIGHTER_STATE.KNOCKDOWN;
    if (canUpdateFacing) {
      this.facingAngle = toOpponentAngle;
    }

    // Get relative input (forward/back based on facing)
    const relInput = this.getRelativeInput(input);

    // State machine
    switch (this.state) {
      case FIGHTER_STATE.IDLE:
      case FIGHTER_STATE.WALK_FORWARD:
      case FIGHTER_STATE.WALK_BACKWARD:
        this.handleStandingState(relInput);
        break;
      case FIGHTER_STATE.CROUCH:
      case FIGHTER_STATE.CROUCH_WALK:
        this.handleCrouchState(relInput);
        break;
      case FIGHTER_STATE.JUMP:
      case FIGHTER_STATE.JUMP_FORWARD:
      case FIGHTER_STATE.JUMP_BACKWARD:
      case FIGHTER_STATE.FALLING:
        this.handleAirState(relInput);
        break;
      case FIGHTER_STATE.RUN:
        this.handleRunState(relInput);
        break;
      case FIGHTER_STATE.ATTACKING:
        this.handleAttackState(relInput);
        break;
      case FIGHTER_STATE.HIT_STUN:
      case FIGHTER_STATE.BLOCK_STUN:
        this.handleStunState(relInput);
        break;
      case FIGHTER_STATE.JUGGLE:
        this.handleJuggleState();
        break;
      case FIGHTER_STATE.KNOCKDOWN:
        this.handleKnockdownState();
        break;
      case FIGHTER_STATE.GETUP:
        this.handleGetupState();
        break;
      case FIGHTER_STATE.SIDESTEP:
        this.handleSidestepState();
        break;
      case FIGHTER_STATE.DASH_BACK:
        this.handleDashState();
        break;
      case FIGHTER_STATE.LANDING:
        this.handleLandingState();
        break;
      case FIGHTER_STATE.VICTORY:
      case FIGHTER_STATE.DEFEAT:
        break; // No input handling
    }
  }

  getRelativeInput(input) {
    const rel = { ...input };
    if (this.facing > 0) {
      rel.forward = input.right;
      rel.back = input.left;
      rel.forwardJust = input.rightJust;
      rel.backJust = input.leftJust;
    } else {
      rel.forward = input.left;
      rel.back = input.right;
      rel.forwardJust = input.leftJust;
      rel.backJust = input.rightJust;
    }
    // Map dash direction
    if (this.facing > 0) {
      rel.dashForward = input.dashRight;
      rel.dashBack = input.dashLeft;
    } else {
      rel.dashForward = input.dashLeft;
      rel.dashBack = input.dashRight;
    }
    return rel;
  }

  handleStandingState(input) {
    this.isCrouching = false;
    this.isBlocking = input.back;

    // Try to attack
    const move = CombatSystem.resolveMove(input, this);
    if (move) {
      this.startAttack(move);
      return;
    }

    // Jump
    if (input.upJust) {
      this.velocity.y = GC.JUMP_VELOCITY;
      if (input.forward) {
        this.velocity.x = GC.JUMP_FORWARD_X;
        this.state = FIGHTER_STATE.JUMP_FORWARD;
      } else if (input.back) {
        this.velocity.x = -GC.JUMP_FORWARD_X;
        this.state = FIGHTER_STATE.JUMP_BACKWARD;
      } else {
        this.state = FIGHTER_STATE.JUMP;
      }
      this.isGrounded = false;
      this.playAnimation('jump', 0.1);
      return;
    }

    // Crouch
    if (input.down) {
      this.state = FIGHTER_STATE.CROUCH;
      this.isCrouching = true;
      this.playAnimation('crouchIdle', 0.15);
      return;
    }

    // Sidestep
    if (input.sideStepUp) {
      this.startSidestep(-1);
      return;
    }
    if (input.sideStepDown) {
      this.startSidestep(1);
      return;
    }

    // Dash back
    if (input.dashBack) {
      this.state = FIGHTER_STATE.DASH_BACK;
      this.dashTimer = GC.DASH_BACK_FRAMES;
      this.velocity.x = -GC.DASH_BACK_SPEED;
      this.playAnimation('runBack', 0.1, 1.5);
      return;
    }

    // Dash forward / Run
    if (input.dashForward) {
      this.state = FIGHTER_STATE.RUN;
      this.isRunning = true;
      this.runFrames = 0;
      this.playAnimation('sprint', 0.15);
      return;
    }

    // Walk
    if (input.forward) {
      this.velocity.x = GC.WALK_SPEED;
      this.state = FIGHTER_STATE.WALK_FORWARD;
      this.playAnimation('walk', 0.2);
    } else if (input.back) {
      this.velocity.x = -GC.BACK_WALK_SPEED;
      this.state = FIGHTER_STATE.WALK_BACKWARD;
      this.playAnimation('walkBack', 0.2);
    } else {
      this.velocity.x = 0;
      if (this.state !== FIGHTER_STATE.IDLE) {
        this.state = FIGHTER_STATE.IDLE;
        this.playAnimation('combatIdle', 0.2);
      }
    }
  }

  handleCrouchState(input) {
    this.isCrouching = true;
    this.isBlocking = input.back;

    // Stand up
    if (!input.down) {
      this.isCrouching = false;
      this.state = FIGHTER_STATE.IDLE;
      this.playAnimation('combatIdle', 0.15);
      return;
    }

    // Attack from crouch
    const move = CombatSystem.resolveMove(input, this);
    if (move) {
      this.startAttack(move);
      return;
    }

    // Crouch walk
    if (input.forward) {
      this.velocity.x = GC.CROUCH_WALK_SPEED;
      if (this.state !== FIGHTER_STATE.CROUCH_WALK) {
        this.state = FIGHTER_STATE.CROUCH_WALK;
        this.playAnimation('crouchWalk', 0.2);
      }
    } else if (input.back) {
      this.velocity.x = -GC.CROUCH_WALK_SPEED;
      if (this.state !== FIGHTER_STATE.CROUCH_WALK) {
        this.state = FIGHTER_STATE.CROUCH_WALK;
        this.playAnimation('crouchWalk', 0.2);
      }
    } else {
      this.velocity.x = 0;
      if (this.state !== FIGHTER_STATE.CROUCH) {
        this.state = FIGHTER_STATE.CROUCH;
        this.playAnimation('crouchIdle', 0.15);
      }
    }
  }

  handleAirState(input) {
    // Apply gravity
    this.velocity.y += GC.GRAVITY;

    // Land
    if (this.position.y <= GC.GROUND_Y && this.velocity.y <= 0) {
      this.position.y = GC.GROUND_Y;
      this.velocity.y = 0;
      this.velocity.x = 0;
      this.isGrounded = true;
      this.state = FIGHTER_STATE.LANDING;
      this.landingTimer = GC.LANDING_FRAMES;
      this.playAnimation('landing', 0.1);
    }
  }

  handleRunState(input) {
    this.isBlocking = false;
    this.runFrames++;

    // Attack from run
    if (input.lpJust || input.rpJust || input.lkJust || input.rkJust) {
      const move = CombatSystem.resolveMove(input, this);
      if (move) {
        this.isRunning = false;
        this.startAttack(move);
        return;
      }
    }

    // Stop running
    if (!input.forward || input.back) {
      this.isRunning = false;
      this.state = FIGHTER_STATE.IDLE;
      this.velocity.x = 0;
      this.playAnimation('combatIdle', 0.15);
      return;
    }

    this.velocity.x = GC.RUN_SPEED;
  }

  handleAttackState(input) {
    if (!this.currentMove) {
      this.state = FIGHTER_STATE.IDLE;
      this.playAnimation('combatIdle', 0.15);
      return;
    }

    this.moveFrame++;
    const totalFrames = this.currentMove.startupFrames + this.currentMove.activeFrames + this.currentMove.recoveryFrames;

    // Forward lunge during startup (always toward opponent = positive velocity.x)
    if (this.currentMove.forwardLunge && this.moveFrame <= this.currentMove.startupFrames) {
      this.velocity.x = this.currentMove.forwardLunge;
    } else if (this.moveFrame > this.currentMove.startupFrames + this.currentMove.activeFrames) {
      this.velocity.x *= 0.9;
    }

    // Check for combo input during recovery
    if (this.moveFrame >= this.currentMove.startupFrames + this.currentMove.activeFrames - 2) {
      const comboMove = CombatSystem.resolveComboInput(input, this);
      if (comboMove) {
        this.startAttack(comboMove, true);
        return;
      }
    }

    // Move finished
    if (this.moveFrame >= totalFrames) {
      this.currentMove = null;
      this.moveFrame = 0;
      this.hasHitThisMove = false;
      this.state = FIGHTER_STATE.IDLE;
      this.velocity.x = 0;
      this.playAnimation('combatIdle', 0.15);
    }
  }

  handleStunState() {
    this.stunFrames--;
    if (this.stunFrames <= 0) {
      this.state = FIGHTER_STATE.IDLE;
      this.velocity.x = 0;
      this.playAnimation('combatIdle', 0.15);
    }
    // Apply pushback decay
    this.velocity.x *= GC.PUSHBACK_DECAY;
  }

  handleJuggleState() {
    this.velocity.y += GC.JUGGLE_GRAVITY;
    this.velocity.x *= 0.98;

    // Land from juggle
    if (this.position.y <= GC.GROUND_Y && this.velocity.y <= 0) {
      this.position.y = GC.GROUND_Y;
      this.velocity.y = 0;
      this.velocity.x = 0;
      this.state = FIGHTER_STATE.KNOCKDOWN;
      this.knockdownTimer = 40;
      this.playAnimation('falling', 0.1);
      // Reset combo
      this.comboTimer = 0;
    }
  }

  handleKnockdownState() {
    this.knockdownTimer--;
    if (this.knockdownTimer <= 0) {
      this.state = FIGHTER_STATE.GETUP;
      this.getupTimer = GC.GETUP_FRAMES;
      this.playAnimation('landing', 0.2);
    }
  }

  handleGetupState() {
    this.getupTimer--;
    if (this.getupTimer <= 0) {
      this.state = FIGHTER_STATE.IDLE;
      this.playAnimation('combatIdle', 0.2);
    }
  }

  handleSidestepState() {
    this.sideStepTimer--;
    this.velocity.z = this.sideStepDir * GC.SIDESTEP_SPEED;

    if (this.sideStepTimer <= 0) {
      this.velocity.z = 0;
      this.state = FIGHTER_STATE.IDLE;
      this.playAnimation('combatIdle', 0.15);
    }
  }

  handleDashState() {
    this.dashTimer--;
    if (this.dashTimer <= 0) {
      this.velocity.x = 0;
      this.state = FIGHTER_STATE.IDLE;
      this.playAnimation('combatIdle', 0.15);
    }
  }

  handleLandingState() {
    this.landingTimer--;
    if (this.landingTimer <= 0) {
      this.state = FIGHTER_STATE.IDLE;
      this.playAnimation('combatIdle', 0.15);
    }
  }

  startAttack(move, isCombo = false) {
    this.currentMove = move;
    this.moveFrame = 0;
    this.hasHitThisMove = false;
    this.state = FIGHTER_STATE.ATTACKING;

    const animName = move.animation;

    // Auto-calculate anim speed so the FULL animation plays within the move's duration
    const clip = this.animations[animName];
    const totalFrames = move.startupFrames + move.activeFrames + move.recoveryFrames;
    const moveDuration = totalFrames / 60; // game frames → seconds
    let speed = move.animSpeed || 1.0;
    if (clip && clip.duration > 0 && moveDuration > 0) {
      speed = clip.duration / moveDuration;
      // Clamp to reasonable range to avoid blur or slow-mo
      speed = Math.max(0.3, Math.min(speed, 4.0));
    }

    this.playAnimation(animName, isCombo ? 0.08 : 0.1, speed);
  }

  startSidestep(direction) {
    this.state = FIGHTER_STATE.SIDESTEP;
    this.sideStepDir = direction;
    this.sideStepTimer = GC.SIDESTEP_FRAMES;
    this.playAnimation(direction < 0 ? 'walkLeft' : 'walkRight', 0.1);
  }

  // Called when this fighter gets hit
  onHit(result, attackerFacing) {
    switch (result.type) {
      case 'hit': {
        this.isBlocking = false;
        this.health = Math.max(0, this.health - result.damage);
        this.comboCount = result.comboHits;
        this.comboDamage = (this.comboDamage || 0) + result.damage;
        this.comboTimer = 60; // frames to show combo
        // Pushback: always push defender backward (negative = away from attacker)
        this.velocity.x = -result.pushback;
        this.hitFlash = 6;

        switch (result.onHit) {
          case HIT_RESULT.STAGGER:
          case HIT_RESULT.KNOCKBACK:
            this.state = FIGHTER_STATE.HIT_STUN;
            this.stunFrames = result.hitstun;
            this.playAnimation(Math.random() > 0.5 ? 'hurt1' : 'hurt2', 0.05);
            break;
          case HIT_RESULT.LAUNCH:
            this.state = FIGHTER_STATE.JUGGLE;
            this.velocity.y = result.launchVelocity;
            this.velocity.x = -result.pushback * 0.5;
            this.isGrounded = false;
            this.playAnimation('falling', 0.1);
            break;
          case HIT_RESULT.KNOCKDOWN:
            this.state = FIGHTER_STATE.KNOCKDOWN;
            this.knockdownTimer = 50;
            this.velocity.x = -result.pushback * 1.5;
            this.playAnimation('falling', 0.1);
            break;
          case HIT_RESULT.CRUMPLE:
            this.state = FIGHTER_STATE.HIT_STUN;
            this.stunFrames = result.hitstun + 10;
            this.velocity.x = -result.pushback * 0.3;
            this.playAnimation('hurt1', 0.05, 0.5);
            break;
          case HIT_RESULT.THROW_HIT:
            this.state = FIGHTER_STATE.KNOCKDOWN;
            this.knockdownTimer = 60;
            this.velocity.y = 0.15;
            this.velocity.x = -(result.pushback || 0.3);
            this.isGrounded = false;
            this.playAnimation('falling', 0.1);
            break;
        }
        break;
      }
      case 'blocked': {
        this.health = Math.max(0, this.health - result.chipDamage);
        this.state = FIGHTER_STATE.BLOCK_STUN;
        this.stunFrames = result.blockstun;
        this.velocity.x = -result.pushback;
        this.isBlocking = true;
        // Show blocking animation (use crouchIdle for now to indicate blocking)
        if (this.isCrouching) {
          this.playAnimation('crouchIdle', 0.05);
        } else {
          this.playAnimation('combatIdle', 0.05);
        }
        break;
      }
    }
  }

  // Check if this fighter's current move is hitting the opponent
  isAttackActive() {
    if (this.state !== FIGHTER_STATE.ATTACKING || !this.currentMove) return false;
    if (this.hasHitThisMove) return false;

    const { startupFrames, activeFrames } = this.currentMove;
    return this.moveFrame >= startupFrames && this.moveFrame < startupFrames + activeFrames;
  }

  // Physics update
  updatePhysics() {
    // Project velocity along fight axis into world XZ.
    // velocity.x = speed along the fight axis (toward/away from opponent)
    // velocity.z = speed perpendicular to fight axis (sidestep)
    const cosA = Math.cos(this.facingAngle);
    const sinA = Math.sin(this.facingAngle);
    // perpendicular is 90° rotated: (-sinA, cosA)
    const worldVx = this.velocity.x * cosA + this.velocity.z * (-sinA);
    const worldVz = this.velocity.x * sinA + this.velocity.z * cosA;

    this.position.x += worldVx;
    this.position.y += this.velocity.y;
    this.position.z += worldVz;

    // Ground collision
    if (this.position.y < GC.GROUND_Y) {
      this.position.y = GC.GROUND_Y;
      this.velocity.y = 0;
    }

    // Arena boundaries (circular arena)
    const arenaRadius = GC.ARENA_WIDTH;
    const distFromCenter = Math.sqrt(this.position.x * this.position.x + this.position.z * this.position.z);
    if (distFromCenter > arenaRadius) {
      const scale = arenaRadius / distFromCenter;
      this.position.x *= scale;
      this.position.z *= scale;
    }

    // Z-axis friction (slow to stop, don't snap back to center)
    if (Math.abs(this.velocity.z) > 0.001) {
      this.velocity.z *= 0.9;
    } else {
      this.velocity.z = 0;
    }

    // Combo timer
    if (this.comboTimer > 0) {
      this.comboTimer--;
      if (this.comboTimer <= 0) {
        this.comboCount = 0;
        this.comboDamage = 0;
      }
    }

    // Hit flash
    if (this.hitFlash > 0) this.hitFlash--;
  }

  // Update visual model
  updateVisuals(deltaTime) {
    if (!this.model) return;

    // 1. Run animation mixer FIRST so bone transforms are fresh
    if (this.mixer) {
      this.mixer.update(deltaTime);
    }

    // 2. Constrain root bone XZ to kill animation root-motion drift
    //    (keep Y so crouches / landing squats still work)
    if (this.rootBone) {
      this.rootBone.position.x = this.rootBoneBindX;
      this.rootBone.position.z = this.rootBoneBindZ;
    }

    // 3. Set model world position from game state (overrides any root motion)
    this.model.position.copy(this.position);

    // 4. Facing direction — use facingAngle for smooth rotation toward opponent
    //    Model faces +X in rest pose, so rotation.y = PI/2 - facingAngle maps correctly
    const targetRotY = Math.PI / 2 - this.facingAngle;
    // Smooth rotation with short-arc interpolation
    let diff = targetRotY - this.model.rotation.y;
    // Normalize to [-PI, PI]
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    this.model.rotation.y += diff * 0.2;

    // 5. Hit flash effect — uses cached material array (no traversal)
    if (this.hitFlash >= 0 && this._cachedMaterials) {
      const flashActive = this.hitFlash > 0;
      const p2Tint = this.playerIndex === 1;
      for (let i = 0; i < this._cachedMaterials.length; i++) {
        const m = this._cachedMaterials[i];
        if (flashActive) {
          m.emissive.setScalar(0.5);
        } else if (p2Tint) {
          m.emissive.set(0.15, 0.02, 0.02);
        } else {
          m.emissive.setScalar(0);
        }
      }
      if (!flashActive) this.hitFlash = -1;
    }

    // 6. Blocking visual (slight lean back along fight axis)
    if (this.state === FIGHTER_STATE.BLOCK_STUN) {
      this.model.position.x -= Math.cos(this.facingAngle) * 0.05;
      this.model.position.z -= Math.sin(this.facingAngle) * 0.05;
    }
  }

  // Serialize state for network
  serializeState() {
    // Find the MOVES key for current move (command field is NOT unique across moves)
    let moveKey = null;
    if (this.currentMove) {
      for (const [k, v] of Object.entries(MOVES)) {
        if (v === this.currentMove) { moveKey = k; break; }
      }
    }
    return {
      px: this.position.x,
      py: this.position.y,
      pz: this.position.z,
      vx: this.velocity.x,
      vy: this.velocity.y,
      vz: this.velocity.z,
      state: this.state,
      facing: this.facing,
      facingAngle: this.facingAngle,
      health: this.health,
      moveId: moveKey,
      moveFrame: this.moveFrame,
      hasHitThisMove: this.hasHitThisMove,
      isCrouching: this.isCrouching,
      isBlocking: this.isBlocking,
      comboCount: this.comboCount,
      comboDamage: this.comboDamage,
      stunFrames: this.stunFrames,
      wins: this.wins,
    };
  }

  // Deserialize state from network
  deserializeState(data) {
    this.position.set(data.px, data.py, data.pz);
    this.velocity.set(data.vx, data.vy, data.vz);
    this.facing = data.facing;
    this.facingAngle = data.facingAngle !== undefined ? data.facingAngle : (this.playerIndex === 0 ? 0 : Math.PI);
    this.health = data.health;
    this.isCrouching = data.isCrouching;
    this.isBlocking = data.isBlocking;
    this.comboCount = data.comboCount;
    this.comboDamage = data.comboDamage;
    this.stunFrames = data.stunFrames;
    this.wins = data.wins;

    // Restore current move from network (critical for attack state + hitbox)
    if (data.moveId && MOVES[data.moveId]) {
      this.currentMove = MOVES[data.moveId];
      this.moveFrame = data.moveFrame || 0;
      this.hasHitThisMove = !!data.hasHitThisMove;
    } else {
      this.currentMove = null;
      this.moveFrame = 0;
      this.hasHitThisMove = false;
    }

    // Update state and animation
    if (data.state !== this.state) {
      this.state = data.state;
      this.updateAnimationForState();
    }
  }

  updateAnimationForState() {
    switch (this.state) {
      case FIGHTER_STATE.IDLE:
        this.playAnimation('combatIdle', 0.15);
        break;
      case FIGHTER_STATE.WALK_FORWARD:
        this.playAnimation('walk', 0.15);
        break;
      case FIGHTER_STATE.WALK_BACKWARD:
        this.playAnimation('walkBack', 0.15);
        break;
      case FIGHTER_STATE.CROUCH:
        this.playAnimation('crouchIdle', 0.15);
        break;
      case FIGHTER_STATE.RUN:
        this.playAnimation('sprint', 0.15);
        break;
      case FIGHTER_STATE.JUMP:
      case FIGHTER_STATE.JUMP_FORWARD:
      case FIGHTER_STATE.JUMP_BACKWARD:
        this.playAnimation('jump', 0.1);
        break;
      case FIGHTER_STATE.ATTACKING:
        // Restore attack animation from synced currentMove
        if (this.currentMove) {
          const animName = this.currentMove.animation;
          const clip = this.animations[animName];
          const totalFrames = this.currentMove.startupFrames + this.currentMove.activeFrames + this.currentMove.recoveryFrames;
          const moveDuration = totalFrames / 60;
          let speed = this.currentMove.animSpeed || 1.0;
          if (clip && clip.duration > 0 && moveDuration > 0) {
            speed = clip.duration / moveDuration;
            speed = Math.max(0.3, Math.min(speed, 4.0));
          }
          this.playAnimation(animName, 0.1, speed);
        }
        break;
      case FIGHTER_STATE.HIT_STUN:
      case FIGHTER_STATE.BLOCK_STUN:
        this.playAnimation('hurt1', 0.05);
        break;
      case FIGHTER_STATE.JUGGLE:
      case FIGHTER_STATE.KNOCKDOWN:
        this.playAnimation('falling', 0.1);
        break;
      case FIGHTER_STATE.SIDESTEP:
        this.playAnimation(this.sideStepDir < 0 ? 'walkLeft' : 'walkRight', 0.1);
        break;
      case FIGHTER_STATE.DASH_BACK:
        this.playAnimation('walkBack', 0.1);
        break;
      case FIGHTER_STATE.LANDING:
        this.playAnimation('landing', 0.1);
        break;
      case FIGHTER_STATE.GETUP:
        this.playAnimation('landing', 0.15);
        break;
      case FIGHTER_STATE.VICTORY:
        this.playAnimation('victory', 0.3);
        break;
      case FIGHTER_STATE.DEFEAT:
        this.playAnimation('falling', 0.3);
        break;
    }
  }

  setVictory() {
    this.state = FIGHTER_STATE.VICTORY;
    this.velocity.set(0, 0, 0);
    this.playAnimation('victory', 0.3);
  }

  setDefeat() {
    this.state = FIGHTER_STATE.DEFEAT;
    this.velocity.set(0, 0, 0);
    this.playAnimation('falling', 0.3);
  }
}

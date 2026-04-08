// ============================================================
// H4KKEN - Fighter (Model, Animation, State Machine, Physics)
// ============================================================

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  CombatSystem,
  FIGHTER_STATE,
  GAME_CONSTANTS,
  HIT_RESULT,
  type HitResult,
  MOVES,
  type MoveData,
} from './Combat';
import type { InputState } from './Input';
import type { FighterStateSync } from './Network';

export interface SharedAssets {
  baseModel: THREE.Object3D;
  animClips: Record<string, THREE.AnimationClip>;
  texture: THREE.Texture;
}

const GC = GAME_CONSTANTS;

const ANIM_FILES: Record<string, string> = {
  idle: 'Arnold_Idle.fbx',
  combatIdle: 'Arnold_Combat_Idle.fbx',
  crouchIdle: 'Arnold_Crouch_Idle.fbx',
  crouchWalk: 'Arnold_Crouch_Walk.fbx',
  walk: 'Arnold_Walk.fbx',
  walkBack: 'Arnold_Walk_Backwards.fbx',
  walkLeft: 'Arnold_Walk_Left.fbx',
  walkRight: 'Arnold_Walk_Right.fbx',
  run: 'Arnold_Run.fbx',
  runBack: 'Arnold_Run_back.fbx',
  sprint: 'Arnold_Sprint.fbx',
  jump: 'Arnold_Jump.fbx',
  falling: 'Arnold_Falling.fbx',
  landing: 'Arnold_Landing.fbx',
  punch1: 'Arnold_Punch_01.fbx',
  punch2: 'Arnold_Punch_02.fbx',
  heavyPunch: 'Arnold_Heavy_Punch.fbx',
  hurt1: 'Arnold_Hurt_01.fbx',
  hurt2: 'Arnold_Hurt_02.fbx',
  leanRight: 'Arnold_Lean_Right.fbx',
  leanLeft: 'Arnold_Left_Left.fbx',
  victory: 'Arnold_Victory.fbx',
};

export class Fighter {
  playerIndex: number;
  scene: THREE.Scene;
  model: THREE.Object3D | null;
  mixer: THREE.AnimationMixer | null;
  animations: Record<string, THREE.AnimationClip>;
  actions: Record<string, THREE.AnimationAction>;
  currentAction: THREE.AnimationAction | null;
  skeleton: THREE.Skeleton | null;
  state: string;
  previousState: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  facing: number;
  facingAngle: number;
  health: number;
  maxHealth: number;
  currentMove: MoveData | null;
  moveFrame: number;
  hasHitThisMove: boolean;
  isBlocking: boolean;
  isCrouching: boolean;
  isGrounded: boolean;
  comboCount: number;
  comboDamage: number;
  comboTimer: number;
  stunFrames: number;
  wins: number;
  knockdownTimer: number;
  getupTimer: number;
  sideStepDir: number;
  sideStepTimer: number;
  dashTimer: number;
  isRunning: boolean;
  runFrames: number;
  landingTimer: number;
  hitFlash: number;
  _cachedMaterials: THREE.Material[] | null;
  rootBone: THREE.Bone | null;
  rootBoneBindX: number;
  rootBoneBindZ: number;

  constructor(playerIndex: number, scene: THREE.Scene) {
    this.playerIndex = playerIndex;
    this.scene = scene;

    this.model = null;
    this.mixer = null;
    this.animations = {};
    this.actions = {};
    this.currentAction = null;
    this.skeleton = null;

    this.state = FIGHTER_STATE.IDLE;
    this.previousState = FIGHTER_STATE.IDLE;
    this.position = new THREE.Vector3(playerIndex === 0 ? -3 : 3, 0, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.facing = 1;
    this.facingAngle = playerIndex === 0 ? 0 : Math.PI;
    this.health = GC.MAX_HEALTH;
    this.maxHealth = GC.MAX_HEALTH;

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

    this.knockdownTimer = 0;
    this.getupTimer = 0;

    this.sideStepDir = 0;
    this.sideStepTimer = 0;

    this.dashTimer = 0;
    this.isRunning = false;
    this.runFrames = 0;

    this.landingTimer = 0;

    this.hitFlash = 0;
    this._cachedMaterials = null;

    this.rootBone = null;
    this.rootBoneBindX = 0;
    this.rootBoneBindZ = 0;
  }

  static retargetClip(clip: THREE.AnimationClip, validNodeNames: Set<string>) {
    for (const track of clip.tracks) {
      const propMatch = track.name.match(
        /\.(position|quaternion|scale|morphTargetInfluences|visible)(\[.*\])?$/,
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
        if (last !== undefined && validNodeNames.has(last)) {
          track.name = last + propPart;
        }
      }
    }
    return clip;
  }

  private static quatVelocity(vals: Float32Array, i: number, dt: number): number {
    const stride = 4;
    let diff = 0;
    for (let c = 0; c < stride; c++) {
      const a = vals[i * stride + c];
      const b = vals[(i - 1) * stride + c];
      if (a === undefined || b === undefined) continue;
      const d = a - b;
      diff += d * d;
    }
    return Math.sqrt(diff) / dt;
  }

  private static trackMotionRange(
    track: THREE.KeyframeTrack,
    threshold: number,
    firstMotion: number,
    lastMotion: number,
  ): { firstMotion: number; lastMotion: number } {
    const times = track.times;
    const vals = track.values;
    for (let i = 1; i < times.length; i++) {
      const curr = times[i];
      const prev = times[i - 1];
      if (curr === undefined || prev === undefined) continue;
      const dt = curr - prev;
      if (dt <= 0) continue;
      const vel = Fighter.quatVelocity(vals, i, dt);
      if (vel > threshold) {
        if (prev < firstMotion) firstMotion = prev;
        if (curr > lastMotion) lastMotion = curr;
      }
    }
    return { firstMotion, lastMotion };
  }

  private static findMotionRange(
    clip: THREE.AnimationClip,
    threshold: number,
  ): { firstMotion: number; lastMotion: number } {
    let firstMotion = clip.duration;
    let lastMotion = 0;

    for (const track of clip.tracks) {
      if (!track.name.includes('.quaternion')) continue;
      if (track.name.startsWith('root.') || track.name.startsWith('pelvis.')) continue;
      ({ firstMotion, lastMotion } = Fighter.trackMotionRange(
        track,
        threshold,
        firstMotion,
        lastMotion,
      ));
    }

    return { firstMotion, lastMotion };
  }

  private static buildTrimmedTracks(
    clip: THREE.AnimationClip,
    trimStart: number,
    trimEnd: number,
  ): THREE.KeyframeTrack[] {
    const newTracks: THREE.KeyframeTrack[] = [];

    for (const track of clip.tracks) {
      const times = track.times;
      const vals = track.values;
      const valSize = vals.length / times.length;

      let iStart = 0;
      while (iStart < times.length - 1) {
        const nextTime = times[iStart + 1];
        if (nextTime !== undefined && nextTime < trimStart) {
          iStart++;
        } else {
          break;
        }
      }

      let iEnd = times.length - 1;
      while (iEnd > 0) {
        const prevTime = times[iEnd - 1];
        if (prevTime !== undefined && prevTime > trimEnd) {
          iEnd--;
        } else {
          break;
        }
      }

      const count = iEnd - iStart + 1;
      if (count < 2) {
        const newTimes = new Float32Array([0, trimEnd - trimStart]);
        const newVals = new Float32Array(valSize * 2);
        for (let c = 0; c < valSize; c++) {
          const v = vals[iStart * valSize + c];
          if (v !== undefined) {
            newVals[c] = v;
            newVals[valSize + c] = v;
          }
        }
        newTracks.push(
          new THREE.KeyframeTrack(track.name, Array.from(newTimes), Array.from(newVals)),
        );
        continue;
      }

      const newTimes = new Float32Array(count);
      const newVals = new Float32Array(count * valSize);
      for (let i = 0; i < count; i++) {
        const t = times[iStart + i];
        newTimes[i] = t !== undefined ? t - trimStart : 0;
        for (let c = 0; c < valSize; c++) {
          const v = vals[(iStart + i) * valSize + c];
          if (v !== undefined) newVals[i * valSize + c] = v;
        }
      }
      if ((newTimes[0] ?? 0) > 0) newTimes[0] = 0;

      newTracks.push(
        new THREE.KeyframeTrack(track.name, Array.from(newTimes), Array.from(newVals)),
      );
    }

    return newTracks;
  }

  static trimClip(clip: THREE.AnimationClip, padBefore = 0.1) {
    const threshold = 0.005;
    const { firstMotion, lastMotion } = Fighter.findMotionRange(clip, threshold);

    if (firstMotion >= lastMotion || firstMotion < 0.15) return clip;

    const trimStart = Math.max(0, firstMotion - padBefore);
    const trimEnd = clip.duration;
    const newTracks = Fighter.buildTrimmedTracks(clip, trimStart, trimEnd);

    return new THREE.AnimationClip(clip.name, trimEnd - trimStart, newTracks);
  }

  static async loadAssets(onProgress?: (p: number) => void): Promise<SharedAssets> {
    const loader = new FBXLoader();
    const basePath = 'assets/models/';
    const texturePath = 'assets/textures/BaseColor.png';

    const totalFiles = Object.keys(ANIM_FILES).length + 1;
    let loaded = 0;

    const report = () => {
      loaded++;
      if (onProgress) onProgress(loaded / totalFiles);
    };

    const baseModel = await loader.loadAsync(`${basePath}Arnold.fbx`);
    report();

    const validNodeNames = new Set<string>();
    baseModel.traverse((node) => {
      if (node.name) validNodeNames.add(node.name);
    });
    console.log('[H4KKEN] Base model nodes:', [...validNodeNames]);

    const textureLoader = new THREE.TextureLoader();
    const texture = await textureLoader.loadAsync(texturePath);
    texture.colorSpace = THREE.SRGBColorSpace;

    baseModel.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        const mesh = child as THREE.Mesh;
        if (mesh.material) {
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((mat: THREE.Material) => {
            (mat as THREE.MeshStandardMaterial).map = texture;
            mat.needsUpdate = true;
          });
        }
      }
    });

    const animClips: Record<string, THREE.AnimationClip> = {};
    const animEntries = Object.entries(ANIM_FILES);

    for (let i = 0; i < animEntries.length; i += 4) {
      const batch = animEntries.slice(i, i + 4);
      const results = await Promise.all(
        batch.map(([name, file]) =>
          loader.loadAsync(basePath + file).then((fbx) => {
            report();
            return { name, fbx };
          }),
        ),
      );
      results.forEach(({ name, fbx }) => {
        if (fbx.animations && fbx.animations.length > 0) {
          let clip = fbx.animations[0];
          if (!clip) return;
          clip.name = name;

          Fighter.retargetClip(clip, validNodeNames);

          const origDur = clip.duration;
          clip = Fighter.trimClip(clip);

          console.log(
            `[H4KKEN] Anim "${name}": ${origDur.toFixed(2)}s → trimmed ${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks`,
          );
          animClips[name] = clip;
        } else {
          console.warn(`[H4KKEN] No animation data in ${name}`);
        }
      });
    }

    Fighter.createProceduralKicks(baseModel, animClips);

    return { baseModel, animClips, texture };
  }

  static createProceduralKicks(
    _baseModel: THREE.Object3D,
    animClips: Record<string, THREE.AnimationClip>,
  ) {
    const idleClip = animClips.combatIdle;
    if (!idleClip) return;
    const idlePose: Record<string, THREE.Quaternion> = {};
    const idlePos: Record<string, THREE.Vector3> = {};

    for (const track of idleClip.tracks) {
      const dotIdx = track.name.lastIndexOf('.');
      const boneName = track.name.substring(0, dotIdx);
      const prop = track.name.substring(dotIdx + 1);

      if (prop === 'quaternion' && track.values.length >= 4) {
        idlePose[boneName] = new THREE.Quaternion(
          track.values[0],
          track.values[1],
          track.values[2],
          track.values[3],
        );
      } else if (prop === 'position' && track.values.length >= 3) {
        idlePos[boneName] = new THREE.Vector3(track.values[0], track.values[1], track.values[2]);
      }
    }

    const THIGH_R_FWD = new THREE.Vector3(0.017, -0.322, 0.94).normalize();
    const THIGH_L_FWD = new THREE.Vector3(0.039, 0.583, -0.808).normalize();
    const CALF_R_EXT = new THREE.Vector3(-0.576, -0.287, 0.749).normalize();
    const CALF_L_EXT = new THREE.Vector3(0.576, -0.287, 0.749).normalize();

    function offsetQ(boneName: string, axis: THREE.Vector3, angle: number) {
      const base = idlePose[boneName];
      if (!base) return new THREE.Quaternion();
      const off = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      return base.clone().multiply(off);
    }

    function eulerOffsetQ(boneName: string, rx: number, ry: number, rz: number) {
      const base = idlePose[boneName];
      if (!base) return new THREE.Quaternion();
      const off = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0));
      return base.clone().multiply(off);
    }

    interface BoneKeyframe {
      t: number;
      q?: THREE.Quaternion;
    }
    interface PelvisKeyframe {
      t: number;
      dx?: number;
      dy?: number;
      dz?: number;
    }
    interface KickBoneAnims {
      [bone: string]: BoneKeyframe[] | PelvisKeyframe[] | undefined;
      _pelvisShift?: PelvisKeyframe[];
    }

    function buildKickClip(name: string, duration: number, boneAnims: KickBoneAnims) {
      const tracks: THREE.KeyframeTrack[] = [];
      const animBones = new Set(Object.keys(boneAnims).filter((k) => !k.startsWith('_')));

      for (const [boneName, q] of Object.entries(idlePose)) {
        if (animBones.has(boneName)) {
          const kfs = boneAnims[boneName] as BoneKeyframe[] | undefined;
          if (!kfs) continue;
          const times = new Float32Array(kfs.map((kf) => kf.t));
          const values = new Float32Array(kfs.length * 4);
          for (let i = 0; i < kfs.length; i++) {
            const kf = kfs[i];
            const qv = kf?.q;
            if (!qv) continue;
            values[i * 4] = qv.x;
            values[i * 4 + 1] = qv.y;
            values[i * 4 + 2] = qv.z;
            values[i * 4 + 3] = qv.w;
          }
          tracks.push(
            new THREE.QuaternionKeyframeTrack(
              `${boneName}.quaternion`,
              Array.from(times),
              Array.from(values),
            ),
          );
        } else {
          tracks.push(
            new THREE.QuaternionKeyframeTrack(
              `${boneName}.quaternion`,
              [0, duration],
              [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w],
            ),
          );
        }
      }

      for (const [boneName, pos] of Object.entries(idlePos)) {
        if (boneAnims._pelvisShift && boneName === 'pelvis') {
          const pk = boneAnims._pelvisShift;
          const times = new Float32Array(pk.map((kf) => kf.t));
          const values = new Float32Array(pk.length * 3);
          for (let i = 0; i < pk.length; i++) {
            const pkf = pk[i];
            values[i * 3] = pos.x + (pkf?.dx || 0);
            values[i * 3 + 1] = pos.y + (pkf?.dy || 0);
            values[i * 3 + 2] = pos.z + (pkf?.dz || 0);
          }
          tracks.push(
            new THREE.VectorKeyframeTrack('pelvis.position', Array.from(times), Array.from(values)),
          );
        } else {
          tracks.push(
            new THREE.VectorKeyframeTrack(
              `${boneName}.position`,
              [0, duration],
              [pos.x, pos.y, pos.z, pos.x, pos.y, pos.z],
            ),
          );
        }
      }

      const clip = new THREE.AnimationClip(name, duration, tracks);
      console.log(
        `[H4KKEN] Procedural "${name}": ${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks`,
      );
      return clip;
    }

    const idle = (bone: string) =>
      idlePose[bone] ? idlePose[bone].clone() : new THREE.Quaternion();
    const aa = (bone: string, axis: THREE.Vector3, angle: number) => offsetQ(bone, axis, angle);
    const eu = (bone: string, rx: number, ry: number, rz: number) => eulerOffsetQ(bone, rx, ry, rz);

    animClips.kickRight = buildKickClip('kickRight', 0.5, {
      thigh_r: [
        { t: 0.0, q: idle('thigh_r') },
        { t: 0.08, q: aa('thigh_r', THIGH_R_FWD, -0.25) },
        { t: 0.2, q: aa('thigh_r', THIGH_R_FWD, 1.35) },
        { t: 0.35, q: aa('thigh_r', THIGH_R_FWD, 1.15) },
        { t: 0.5, q: idle('thigh_r') },
      ],
      calf_r: [
        { t: 0.0, q: idle('calf_r') },
        { t: 0.08, q: aa('calf_r', CALF_R_EXT, -0.5) },
        { t: 0.2, q: aa('calf_r', CALF_R_EXT, 0.65) },
        { t: 0.35, q: aa('calf_r', CALF_R_EXT, 0.55) },
        { t: 0.5, q: idle('calf_r') },
      ],
      foot_r: [
        { t: 0.0, q: idle('foot_r') },
        { t: 0.2, q: eu('foot_r', -0.3, 0, 0) },
        { t: 0.5, q: idle('foot_r') },
      ],
      spine_01: [
        { t: 0.0, q: idle('spine_01') },
        { t: 0.15, q: eu('spine_01', 0, 0, 0.15) },
        { t: 0.5, q: idle('spine_01') },
      ],
      thigh_l: [
        { t: 0.0, q: idle('thigh_l') },
        { t: 0.15, q: aa('thigh_l', THIGH_L_FWD, -0.1) },
        { t: 0.5, q: idle('thigh_l') },
      ],
      calf_l: [
        { t: 0.0, q: idle('calf_l') },
        { t: 0.15, q: aa('calf_l', CALF_L_EXT, -0.15) },
        { t: 0.5, q: idle('calf_l') },
      ],
      _pelvisShift: [{ t: 0.0 }, { t: 0.15, dy: 2 }, { t: 0.5 }],
    });

    animClips.kickLeft = buildKickClip('kickLeft', 0.65, {
      thigh_l: [
        { t: 0.0, q: idle('thigh_l') },
        { t: 0.12, q: aa('thigh_l', THIGH_L_FWD, -0.3) },
        { t: 0.3, q: aa('thigh_l', THIGH_L_FWD, 1.5) },
        { t: 0.45, q: aa('thigh_l', THIGH_L_FWD, 1.25) },
        { t: 0.65, q: idle('thigh_l') },
      ],
      calf_l: [
        { t: 0.0, q: idle('calf_l') },
        { t: 0.12, q: aa('calf_l', CALF_L_EXT, -0.5) },
        { t: 0.3, q: aa('calf_l', CALF_L_EXT, 0.4) },
        { t: 0.45, q: aa('calf_l', CALF_L_EXT, 0.3) },
        { t: 0.65, q: idle('calf_l') },
      ],
      foot_l: [
        { t: 0.0, q: idle('foot_l') },
        { t: 0.3, q: eu('foot_l', -0.35, 0, 0) },
        { t: 0.65, q: idle('foot_l') },
      ],
      spine_01: [
        { t: 0.0, q: idle('spine_01') },
        { t: 0.2, q: eu('spine_01', 0, 0, 0.18) },
        { t: 0.65, q: idle('spine_01') },
      ],
      thigh_r: [
        { t: 0.0, q: idle('thigh_r') },
        { t: 0.2, q: aa('thigh_r', THIGH_R_FWD, -0.12) },
        { t: 0.65, q: idle('thigh_r') },
      ],
      _pelvisShift: [{ t: 0.0 }, { t: 0.2, dy: 3 }, { t: 0.65 }],
    });

    const LOW_KICK_DIR = new THREE.Vector3(0.05, -0.55, 0.83).normalize();
    animClips.lowKick = buildKickClip('lowKick', 0.45, {
      thigh_r: [
        { t: 0.0, q: idle('thigh_r') },
        { t: 0.1, q: aa('thigh_r', LOW_KICK_DIR, 0.45) },
        { t: 0.25, q: aa('thigh_r', LOW_KICK_DIR, 0.8) },
        { t: 0.45, q: idle('thigh_r') },
      ],
      calf_r: [
        { t: 0.0, q: idle('calf_r') },
        { t: 0.1, q: aa('calf_r', CALF_R_EXT, -0.25) },
        { t: 0.25, q: aa('calf_r', CALF_R_EXT, 0.35) },
        { t: 0.45, q: idle('calf_r') },
      ],
      spine_01: [
        { t: 0.0, q: idle('spine_01') },
        { t: 0.15, q: eu('spine_01', 0, 0, -0.15) },
        { t: 0.45, q: idle('spine_01') },
      ],
      thigh_l: [
        { t: 0.0, q: idle('thigh_l') },
        { t: 0.15, q: aa('thigh_l', THIGH_L_FWD, 0.2) },
        { t: 0.45, q: idle('thigh_l') },
      ],
      calf_l: [
        { t: 0.0, q: idle('calf_l') },
        { t: 0.15, q: aa('calf_l', CALF_L_EXT, -0.3) },
        { t: 0.45, q: idle('calf_l') },
      ],
      _pelvisShift: [{ t: 0.0 }, { t: 0.15, dy: -5 }, { t: 0.45 }],
    });

    const SWEEP_ARC = new THREE.Vector3(0.1, 0.75, -0.65).normalize();
    animClips.sweepKick = buildKickClip('sweepKick', 0.7, {
      thigh_l: [
        { t: 0.0, q: idle('thigh_l') },
        { t: 0.1, q: aa('thigh_l', THIGH_L_FWD, 0.3) },
        { t: 0.25, q: aa('thigh_l', SWEEP_ARC, 0.9) },
        { t: 0.45, q: aa('thigh_l', SWEEP_ARC, 0.7) },
        { t: 0.7, q: idle('thigh_l') },
      ],
      calf_l: [
        { t: 0.0, q: idle('calf_l') },
        { t: 0.25, q: aa('calf_l', CALF_L_EXT, 0.3) },
        { t: 0.45, q: aa('calf_l', CALF_L_EXT, 0.2) },
        { t: 0.7, q: idle('calf_l') },
      ],
      spine_01: [
        { t: 0.0, q: idle('spine_01') },
        { t: 0.15, q: eu('spine_01', 0, 0, -0.25) },
        { t: 0.45, q: eu('spine_01', 0, 0, -0.25) },
        { t: 0.7, q: idle('spine_01') },
      ],
      thigh_r: [
        { t: 0.0, q: idle('thigh_r') },
        { t: 0.15, q: aa('thigh_r', THIGH_R_FWD, 0.4) },
        { t: 0.45, q: aa('thigh_r', THIGH_R_FWD, 0.4) },
        { t: 0.7, q: idle('thigh_r') },
      ],
      calf_r: [
        { t: 0.0, q: idle('calf_r') },
        { t: 0.15, q: aa('calf_r', CALF_R_EXT, -0.5) },
        { t: 0.45, q: aa('calf_r', CALF_R_EXT, -0.5) },
        { t: 0.7, q: idle('calf_r') },
      ],
      _pelvisShift: [{ t: 0.0 }, { t: 0.15, dy: -10 }, { t: 0.45, dy: -10 }, { t: 0.7 }],
    });
  }

  init(
    baseModel: THREE.Object3D,
    animClips: Record<string, THREE.AnimationClip>,
    _texture: THREE.Texture,
  ) {
    const model = skeletonClone(baseModel);
    this.model = model;

    model.scale.set(0.013, 0.013, 0.013);
    model.position.copy(this.position);
    model.rotation.y = this.facing > 0 ? Math.PI / 2 : -Math.PI / 2;

    if (this.playerIndex === 1) {
      model.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map((m) => {
              const cloned = (m as THREE.MeshStandardMaterial).clone();
              cloned.color = new THREE.Color(0.6, 0.4, 0.4);
              cloned.emissive = new THREE.Color(0.15, 0.02, 0.02);
              return cloned;
            });
          } else {
            mesh.material = (mesh.material as THREE.MeshStandardMaterial).clone();
            (mesh.material as THREE.MeshStandardMaterial).color = new THREE.Color(0.6, 0.4, 0.4);
            (mesh.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(
              0.15,
              0.02,
              0.02,
            );
          }
        }
      });
    }

    this.rootBone = null;
    const matSet = new Set<THREE.Material>();
    model.traverse((child) => {
      if ((child as THREE.Bone).isBone && !this.rootBone) {
        this.rootBone = child as THREE.Bone;
        this.rootBoneBindX = child.position.x;
        this.rootBoneBindZ = child.position.z;
      }
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => {
          matSet.add(m);
        });
      }
    });
    this._cachedMaterials = [...matSet];

    this.mixer = new THREE.AnimationMixer(model);

    const onceAnimations = new Set([
      'punch1',
      'punch2',
      'heavyPunch',
      'hurt1',
      'hurt2',
      'jump',
      'landing',
      'victory',
      'leanRight',
      'leanLeft',
      'kickRight',
      'kickLeft',
      'lowKick',
      'sweepKick',
    ]);

    for (const [name, clip] of Object.entries(animClips)) {
      this.animations[name] = clip;
      const action = this.mixer.clipAction(clip);
      this.actions[name] = action;

      action.setEffectiveTimeScale(1);
      action.setEffectiveWeight(0);

      if (onceAnimations.has(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
    }

    this.scene.add(model);
    this.playAnimation('combatIdle', 0.2);
  }

  playAnimation(name: string, crossfadeDuration = 0.15, speed = 1.0) {
    const newAction = this.actions[name];
    if (!newAction) return;

    if (this.currentAction === newAction && newAction.isRunning()) return;

    newAction.reset();
    newAction.setEffectiveTimeScale(speed);
    newAction.setEffectiveWeight(1);

    if (this.currentAction && this.currentAction !== newAction) {
      this.currentAction.fadeOut(crossfadeDuration);
      newAction.fadeIn(crossfadeDuration);
    }

    newAction.play();
    this.currentAction = newAction;
  }

  reset(startX: number) {
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
    this.facing = 1;
    this.facingAngle = startX < 0 ? 0 : Math.PI;

    this.playAnimation('combatIdle', 0.3);
  }

  processInput(input: InputState, opponentPos: THREE.Vector3) {
    const dxWorld = opponentPos.x - this.position.x;
    const dzWorld = opponentPos.z - this.position.z;
    const toOpponentAngle = Math.atan2(dzWorld, dxWorld);

    const canUpdateFacing =
      this.state !== FIGHTER_STATE.ATTACKING &&
      this.state !== FIGHTER_STATE.HIT_STUN &&
      this.state !== FIGHTER_STATE.JUGGLE &&
      this.state !== FIGHTER_STATE.KNOCKDOWN;
    if (canUpdateFacing) {
      this.facingAngle = toOpponentAngle;
    }

    const relInput = this.getRelativeInput(input);

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
        break;
    }
  }

  getRelativeInput(input: InputState): InputState {
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
    if (this.facing > 0) {
      rel.dashForward = input.dashRight;
      rel.dashBack = input.dashLeft;
    } else {
      rel.dashForward = input.dashLeft;
      rel.dashBack = input.dashRight;
    }
    return rel;
  }

  handleStandingState(input: InputState) {
    this.isCrouching = false;
    this.isBlocking = input.back ?? false;

    const move = CombatSystem.resolveMove(input, this);
    if (move) {
      this.startAttack(move);
      return;
    }

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

    if (input.down) {
      this.state = FIGHTER_STATE.CROUCH;
      this.isCrouching = true;
      this.playAnimation('crouchIdle', 0.15);
      return;
    }

    if (input.sideStepUp) {
      this.startSidestep(-1);
      return;
    }
    if (input.sideStepDown) {
      this.startSidestep(1);
      return;
    }

    if (input.dashBack) {
      this.state = FIGHTER_STATE.DASH_BACK;
      this.dashTimer = GC.DASH_BACK_FRAMES;
      this.velocity.x = -GC.DASH_BACK_SPEED;
      this.playAnimation('runBack', 0.1, 1.5);
      return;
    }

    if (input.dashForward) {
      this.state = FIGHTER_STATE.RUN;
      this.isRunning = true;
      this.runFrames = 0;
      this.playAnimation('sprint', 0.15);
      return;
    }

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

  handleCrouchState(input: InputState) {
    this.isCrouching = true;
    this.isBlocking = input.back ?? false;

    if (!input.down) {
      this.isCrouching = false;
      this.state = FIGHTER_STATE.IDLE;
      this.playAnimation('combatIdle', 0.15);
      return;
    }

    const move = CombatSystem.resolveMove(input, this);
    if (move) {
      this.startAttack(move);
      return;
    }

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

  handleAirState(_input: InputState) {
    this.velocity.y += GC.GRAVITY;

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

  handleRunState(input: InputState) {
    this.isBlocking = false;
    this.runFrames++;

    if (input.lpJust || input.rpJust || input.lkJust || input.rkJust) {
      const move = CombatSystem.resolveMove(input, this);
      if (move) {
        this.isRunning = false;
        this.startAttack(move);
        return;
      }
    }

    if (!input.forward || input.back) {
      this.isRunning = false;
      this.state = FIGHTER_STATE.IDLE;
      this.velocity.x = 0;
      this.playAnimation('combatIdle', 0.15);
      return;
    }

    this.velocity.x = GC.RUN_SPEED;
  }

  handleAttackState(input: InputState) {
    if (!this.currentMove) {
      this.state = FIGHTER_STATE.IDLE;
      this.playAnimation('combatIdle', 0.15);
      return;
    }

    this.moveFrame++;
    const totalFrames =
      this.currentMove.startupFrames +
      this.currentMove.activeFrames +
      this.currentMove.recoveryFrames;

    if (this.currentMove.forwardLunge && this.moveFrame <= this.currentMove.startupFrames) {
      this.velocity.x = this.currentMove.forwardLunge;
    } else if (this.moveFrame > this.currentMove.startupFrames + this.currentMove.activeFrames) {
      this.velocity.x *= 0.9;
    }

    if (this.moveFrame >= this.currentMove.startupFrames + this.currentMove.activeFrames - 2) {
      const comboMove = CombatSystem.resolveComboInput(input, this);
      if (comboMove) {
        this.startAttack(comboMove, true);
        return;
      }
    }

    if (this.moveFrame >= totalFrames) {
      this.currentMove = null;
      this.moveFrame = 0;
      this.hasHitThisMove = false;
      this.state = FIGHTER_STATE.IDLE;
      this.velocity.x = 0;
      this.playAnimation('combatIdle', 0.15);
    }
  }

  handleStunState(_input?: InputState) {
    this.stunFrames--;
    if (this.stunFrames <= 0) {
      this.state = FIGHTER_STATE.IDLE;
      this.velocity.x = 0;
      this.playAnimation('combatIdle', 0.15);
    }
    this.velocity.x *= GC.PUSHBACK_DECAY;
  }

  handleJuggleState() {
    this.velocity.y += GC.JUGGLE_GRAVITY;
    this.velocity.x *= 0.98;

    if (this.position.y <= GC.GROUND_Y && this.velocity.y <= 0) {
      this.position.y = GC.GROUND_Y;
      this.velocity.y = 0;
      this.velocity.x = 0;
      this.state = FIGHTER_STATE.KNOCKDOWN;
      this.knockdownTimer = 40;
      this.playAnimation('falling', 0.1);
      this.comboTimer = 0;
    }
  }

  handleKnockdownState() {
    if (this.position.y > GC.GROUND_Y || this.velocity.y > 0) {
      this.velocity.y += GC.JUGGLE_GRAVITY;
      if (this.position.y <= GC.GROUND_Y && this.velocity.y <= 0) {
        this.position.y = GC.GROUND_Y;
        this.velocity.y = 0;
        this.velocity.x = 0;
        this.isGrounded = true;
      }
    }

    this.knockdownTimer--;
    if (this.knockdownTimer <= 0) {
      this.position.y = GC.GROUND_Y;
      this.velocity.y = 0;
      this.isGrounded = true;
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

  startAttack(move: MoveData, isCombo = false) {
    this.currentMove = move;
    this.moveFrame = 0;
    this.hasHitThisMove = false;
    this.state = FIGHTER_STATE.ATTACKING;

    const animName = move.animation;
    const clip = this.animations[animName];
    const totalFrames = move.startupFrames + move.activeFrames + move.recoveryFrames;
    const moveDuration = totalFrames / 60;
    let speed = move.animSpeed || 1.0;
    if (clip && clip.duration > 0 && moveDuration > 0) {
      speed = clip.duration / moveDuration;
      speed = Math.max(0.3, Math.min(speed, 4.0));
    }

    this.playAnimation(animName, isCombo ? 0.08 : 0.1, speed);
  }

  startSidestep(direction: number) {
    this.state = FIGHTER_STATE.SIDESTEP;
    this.sideStepDir = direction;
    this.sideStepTimer = GC.SIDESTEP_FRAMES;
    this.playAnimation(direction < 0 ? 'walkLeft' : 'walkRight', 0.1);
  }

  onHit(result: HitResult, _attackerFacing: number) {
    switch (result.type) {
      case 'hit': {
        this.isBlocking = false;
        this.health = Math.max(0, this.health - result.damage);
        this.comboCount = result.comboHits;
        this.comboDamage = (this.comboDamage || 0) + result.damage;
        this.comboTimer = 60;
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
        if (this.isCrouching) {
          this.playAnimation('crouchIdle', 0.05);
        } else {
          this.playAnimation('combatIdle', 0.05);
        }
        break;
      }
    }
  }

  isAttackActive() {
    if (this.state !== FIGHTER_STATE.ATTACKING || !this.currentMove) return false;
    if (this.hasHitThisMove) return false;

    const { startupFrames, activeFrames } = this.currentMove;
    return this.moveFrame >= startupFrames && this.moveFrame < startupFrames + activeFrames;
  }

  updatePhysics() {
    const cosA = Math.cos(this.facingAngle);
    const sinA = Math.sin(this.facingAngle);
    const worldVx = this.velocity.x * cosA + this.velocity.z * -sinA;
    const worldVz = this.velocity.x * sinA + this.velocity.z * cosA;

    this.position.x += worldVx;
    this.position.y += this.velocity.y;
    this.position.z += worldVz;

    if (this.position.y < GC.GROUND_Y) {
      this.position.y = GC.GROUND_Y;
      this.velocity.y = 0;
    }

    const arenaRadius = GC.ARENA_WIDTH;
    const distFromCenter = Math.sqrt(
      this.position.x * this.position.x + this.position.z * this.position.z,
    );
    if (distFromCenter > arenaRadius) {
      const scale = arenaRadius / distFromCenter;
      this.position.x *= scale;
      this.position.z *= scale;
    }

    if (Math.abs(this.velocity.z) > 0.001) {
      this.velocity.z *= 0.9;
    } else {
      this.velocity.z = 0;
    }

    if (this.comboTimer > 0) {
      this.comboTimer--;
      if (this.comboTimer <= 0) {
        this.comboCount = 0;
        this.comboDamage = 0;
      }
    }

    if (this.hitFlash > 0) this.hitFlash--;
  }

  updateVisuals(deltaTime: number) {
    if (!this.model) return;

    if (this.mixer) {
      this.mixer.update(deltaTime);
    }

    if (this.rootBone) {
      this.rootBone.position.x = this.rootBoneBindX;
      this.rootBone.position.z = this.rootBoneBindZ;
    }

    this.model.position.copy(this.position);

    const targetRotY = Math.PI / 2 - this.facingAngle;
    let diff = targetRotY - this.model.rotation.y;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    this.model.rotation.y += diff * 0.2;

    if (this.hitFlash >= 0 && this._cachedMaterials) {
      const flashActive = this.hitFlash > 0;
      const p2Tint = this.playerIndex === 1;
      for (let i = 0; i < this._cachedMaterials.length; i++) {
        const m = this._cachedMaterials[i] as THREE.MeshStandardMaterial;
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

    if (this.state === FIGHTER_STATE.BLOCK_STUN) {
      this.model.position.x -= Math.cos(this.facingAngle) * 0.05;
      this.model.position.z -= Math.sin(this.facingAngle) * 0.05;
    }
  }

  serializeState() {
    let moveKey: string | null = null;
    if (this.currentMove) {
      for (const [k, v] of Object.entries(MOVES)) {
        if (v === this.currentMove) {
          moveKey = k;
          break;
        }
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

  deserializeState(data: FighterStateSync) {
    this.position.set(data.px, data.py, data.pz);
    this.velocity.set(data.vx, data.vy, data.vz);
    this.facing = data.facing;
    this.facingAngle =
      data.facingAngle !== undefined ? data.facingAngle : this.playerIndex === 0 ? 0 : Math.PI;
    this.health = data.health;
    this.isCrouching = data.isCrouching;
    this.isBlocking = data.isBlocking;
    this.comboCount = data.comboCount;
    this.comboDamage = data.comboDamage;
    this.stunFrames = data.stunFrames;
    this.wins = data.wins;

    if (data.moveId && MOVES[data.moveId] !== undefined) {
      this.currentMove = MOVES[data.moveId] ?? null;
      this.moveFrame = data.moveFrame || 0;
      this.hasHitThisMove = !!data.hasHitThisMove;
    } else {
      this.currentMove = null;
      this.moveFrame = 0;
      this.hasHitThisMove = false;
    }

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
        if (this.currentMove) {
          const animName = this.currentMove.animation;
          const clip = this.animations[animName];
          const totalFrames =
            this.currentMove.startupFrames +
            this.currentMove.activeFrames +
            this.currentMove.recoveryFrames;
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

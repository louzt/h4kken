// ============================================================
// H4KKEN - Fighter (Model, Animation, State Machine, Physics)
// Babylon.js — GLB assets (Quaternius Universal Animation Library)
// ============================================================

// Side-effect import: registers the glTF/GLB loader plugin with SceneLoader
import '@babylonjs/loaders/glTF';
import {
  type AbstractMesh,
  type AnimationGroup,
  type Bone,
  Color3,
  type ISceneLoaderAsyncResult,
  PBRMaterial,
  Quaternion,
  type Scene,
  SceneLoader,
  type Skeleton,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
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
  baseMeshes: AbstractMesh[];
  baseSkeleton: Skeleton | null;
  animGroups: Record<string, AnimationGroup>;
}

const GC = GAME_CONSTANTS;

// Maps game animation names to animation names inside the GLB file.
// Animations not available in the pack are mapped to a close substitute.
const ANIM_MAP: Record<string, string> = {
  idle: 'Idle_Loop',
  combatIdle: 'Idle_Loop',
  crouchIdle: 'Crouch_Idle_Loop',
  crouchWalk: 'Crouch_Fwd_Loop',
  walk: 'Walk_Loop',
  walkBack: 'Walk_Loop',
  walkLeft: 'Walk_Loop',
  walkRight: 'Walk_Loop',
  run: 'Jog_Fwd_Loop',
  runBack: 'Jog_Fwd_Loop',
  sprint: 'Sprint_Loop',
  jump: 'Jump_Start',
  falling: 'Jump_Loop',
  landing: 'Jump_Land',
  punch1: 'Punch_Jab',
  punch2: 'Punch_Cross',
  heavyPunch: 'Sword_Attack',
  hurt1: 'Hit_Chest',
  hurt2: 'Hit_Head',
  leanRight: 'Idle_Loop',
  leanLeft: 'Idle_Loop',
  victory: 'Dance_Loop',
};

const LOOP_ANIMS = new Set([
  'idle',
  'combatIdle',
  'crouchIdle',
  'crouchWalk',
  'walk',
  'walkBack',
  'walkLeft',
  'walkRight',
  'run',
  'runBack',
  'sprint',
  'falling',
]);

export class Fighter {
  playerIndex: number;
  scene: Scene;
  rootNode: TransformNode | null;
  meshes: AbstractMesh[];
  animGroups: Record<string, AnimationGroup>;
  currentAnimGroup: AnimationGroup | null;
  state: string;
  previousState: string;
  position: Vector3;
  velocity: Vector3;
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
  private _rootRotY = 0;

  constructor(playerIndex: number, scene: Scene) {
    this.playerIndex = playerIndex;
    this.scene = scene;

    this.rootNode = null;
    this.meshes = [];
    this.animGroups = {};
    this.currentAnimGroup = null;

    this.state = FIGHTER_STATE.IDLE;
    this.previousState = FIGHTER_STATE.IDLE;
    // Camera at Z=-10 looks toward +Z. In Babylon left-handed: +X = screen RIGHT, -X = screen LEFT.
    // Player 0 (P1) spawns at X=-3 → screen LEFT (traditional fighting game convention).
    this.position = new Vector3(playerIndex === 0 ? -3 : 3, 0, 0);
    this.velocity = new Vector3(0, 0, 0);
    this.facing = 1;
    // P1 at X=-3 faces +X (toward opponent at X=+3) → angle = 0
    // P2 at X=+3 faces -X (toward opponent at X=-3) → angle = PI
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
  }

  // FBX loader prefixes every bone as "<meshName>-<boneName>".
  // Strip that prefix so we can match bones across different sources.
  private static _boneSuffix(name: string): string {
    const idx = name.indexOf('-');
    return idx >= 0 ? name.substring(idx + 1) : name;
  }

  // GLB (glTF) is Y-up by spec — no axis correction needed.
  // Only the Y rotation for facing direction is applied here.
  private static _makeRootQuat(rotY: number): Quaternion {
    return Quaternion.RotationAxis(Vector3.Up(), rotY);
  }

  private static _unlinkBonesFromTransformNodes(skeleton: Skeleton) {
    for (const bone of skeleton.bones) {
      bone.linkTransformNode(null);
    }
  }

  static async loadAssets(scene: Scene, onProgress?: (p: number) => void): Promise<SharedAssets> {
    const result: ISceneLoaderAsyncResult = await SceneLoader.ImportMeshAsync(
      null,
      '/assets/models/',
      'character.glb',
      scene,
    );
    onProgress?.(1);

    console.log(
      '[H4KKEN] GLB loaded:',
      `meshes=${result.meshes.length}`,
      `skeletons=${result.skeletons.length}`,
      `transformNodes=${result.transformNodes.length}`,
      `animGroups=${result.animationGroups.length}`,
      result.animationGroups.map((ag) => ag.name),
    );

    // Stop all animations — each fighter drives its own cloned groups
    for (const ag of result.animationGroups) ag.stop();

    // Map game animation names to loaded AnimationGroup objects
    const animGroups: Record<string, AnimationGroup> = {};
    for (const [gameName, glbName] of Object.entries(ANIM_MAP)) {
      const found = result.animationGroups.find((ag) => ag.name === glbName);
      if (found) {
        animGroups[gameName] = found;
      } else {
        console.warn(`[H4KKEN] Anim "${gameName}" (GLB: "${glbName}") not found`);
      }
    }

    const baseSkeleton = result.skeletons[0] ?? null;

    // Collect meshes that have geometry (skip the synthetic __root__ node)
    const baseMeshes: AbstractMesh[] = [];
    for (const m of result.meshes) {
      if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
      m.setEnabled(false);
      baseMeshes.push(m);
    }
    for (const n of result.transformNodes) n.setEnabled(false);

    console.log(
      '[H4KKEN] Base meshes:',
      baseMeshes.map((m) => m.name),
      '| skeleton:',
      baseSkeleton?.name ?? 'none',
    );

    return { baseMeshes, baseSkeleton, animGroups };
  }

  init(assets: SharedAssets) {
    const { baseMeshes, baseSkeleton, animGroups } = assets;

    // Each fighter gets a fresh root TransformNode as its positional anchor
    this.rootNode = new TransformNode(`fighter${this.playerIndex}_root`, this.scene);

    const clonedSkeleton = baseSkeleton
      ? baseSkeleton.clone(`skeleton_f${this.playerIndex}`, `skel_${this.playerIndex}`)
      : null;

    if (clonedSkeleton) {
      // Unlink bones from the base TransformNodes so animation drives them directly
      Fighter._unlinkBonesFromTransformNodes(clonedSkeleton);
    }

    // Clone each base mesh, parenting it to this fighter's root node
    this.meshes = [];
    for (const baseMesh of baseMeshes) {
      const cloned = baseMesh.clone(`f${this.playerIndex}_${baseMesh.name}`, this.rootNode);
      if (!cloned) continue;
      cloned.setEnabled(true);
      cloned.receiveShadows = true;
      if (clonedSkeleton && cloned.skeleton) cloned.skeleton = clonedSkeleton;
      this.meshes.push(cloned);
    }

    // Player 2 gets a red tint on its materials
    if (this.playerIndex === 1) {
      for (const mesh of this.meshes) {
        if (!mesh.material) continue;
        const mat = mesh.material.clone(`p2mat_${mesh.name}`);
        if (!mat) continue;
        if (mat instanceof PBRMaterial) {
          mat.albedoColor = new Color3(0.7, 0.3, 0.3);
          mat.emissiveColor = new Color3(0.15, 0.02, 0.02);
        } else if (mat instanceof StandardMaterial) {
          mat.diffuseColor = new Color3(0.7, 0.3, 0.3);
          mat.emissiveColor = new Color3(0.15, 0.02, 0.02);
        }
        mesh.material = mat;
      }
    }

    // Build suffix→Bone map so _cloneAnimGroups can remap targets to cloned bones
    const boneByName = new Map<string, Bone>();
    if (clonedSkeleton) {
      for (const bone of clonedSkeleton.bones) {
        boneByName.set(Fighter._boneSuffix(bone.name), bone);
      }
      console.log(
        `[H4KKEN] F${this.playerIndex} skeleton "${clonedSkeleton.name}":`,
        `${clonedSkeleton.bones.length} bones`,
        `meshes=${this.meshes.length}`,
      );
    }

    this._cloneAnimGroups(animGroups, boneByName);

    this.rootNode.position.copyFrom(this.position);
    // initRotY must match PI/2 + facingAngle used in updateVisuals().
    // P0 facingAngle=0  → PI/2;  P1 facingAngle=PI → -PI/2
    const initRotY = this.playerIndex === 0 ? Math.PI / 2 : -Math.PI / 2;
    this._rootRotY = initRotY;
    this.rootNode.rotationQuaternion = Fighter._makeRootQuat(initRotY);

    this.playAnimation('combatIdle', 0.2);
  }

  private _cloneAnimGroups(
    animGroups: Record<string, AnimationGroup>,
    boneByName: Map<string, Bone>,
  ) {
    for (const [name, srcGroup] of Object.entries(animGroups)) {
      const clonedGroup = srcGroup.clone(`f${this.playerIndex}_${name}`, (target) => {
        if (target && typeof target === 'object' && 'name' in target) {
          const mapped = boneByName.get(Fighter._boneSuffix((target as { name: string }).name));
          if (mapped) return mapped;
        }
        return target;
      });
      clonedGroup.stop();
      clonedGroup.loopAnimation = LOOP_ANIMS.has(name);
      this.animGroups[name] = clonedGroup;
    }
  }

  playAnimation(name: string, _crossfadeDuration = 0.15, speed = 1.0) {
    const newGroup = this.animGroups[name];
    if (!newGroup) return;

    if (this.currentAnimGroup === newGroup && newGroup.isPlaying) return;

    if (this.currentAnimGroup && this.currentAnimGroup !== newGroup) {
      this.currentAnimGroup.stop();
    }

    newGroup.speedRatio = speed;
    newGroup.start(newGroup.loopAnimation, speed);
    this.currentAnimGroup = newGroup;
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
    this.facingAngle = startX > 0 ? Math.PI : 0;
    this._rootRotY = Math.PI / 2 + this.facingAngle;
    if (this.rootNode) {
      this.rootNode.rotationQuaternion = Fighter._makeRootQuat(this._rootRotY);
    }

    this.playAnimation('combatIdle', 0.3);
  }

  processInput(input: InputState, opponentPos: Vector3) {
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
    const group = this.animGroups[animName];
    const totalFrames = move.startupFrames + move.activeFrames + move.recoveryFrames;
    const moveDuration = totalFrames / 60;
    let speed = move.animSpeed || 1.0;
    if (group) {
      const groupDuration = group.to - group.from;
      if (groupDuration > 0 && moveDuration > 0) {
        speed = groupDuration / moveDuration;
        speed = Math.max(0.3, Math.min(speed, 4.0));
      }
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

  private _applyEmissiveFlash(flashActive: boolean) {
    const idleEmissive = this.playerIndex === 1 ? new Color3(0.15, 0.02, 0.02) : Color3.Black();
    const emissive = flashActive ? new Color3(0.5, 0.5, 0.5) : idleEmissive;
    for (const mesh of this.meshes) {
      const mat = mesh.material;
      if (mat instanceof PBRMaterial) {
        mat.emissiveColor = emissive;
      } else if (mat instanceof StandardMaterial) {
        mat.emissiveColor = emissive;
      }
    }
  }

  updateVisuals() {
    if (!this.rootNode) return;

    this.rootNode.position.copyFrom(this.position);

    // Quaternius character natively faces +Z. Facing angle is the world-space direction to opponent.
    // targetRotY = PI/2 + facingAngle rotates the +Z-facing model to look in the facingAngle direction.
    const targetRotY = Math.PI / 2 + this.facingAngle;
    let diff = targetRotY - this._rootRotY;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    this._rootRotY += diff * 0.2;
    this.rootNode.rotationQuaternion = Fighter._makeRootQuat(this._rootRotY);

    if (this.hitFlash >= 0) {
      const flashActive = this.hitFlash > 0;
      this._applyEmissiveFlash(flashActive);
      if (!flashActive) this.hitFlash = -1;
    }

    if (this.state === FIGHTER_STATE.BLOCK_STUN) {
      this.rootNode.position.x -= Math.cos(this.facingAngle) * 0.05;
      this.rootNode.position.z -= Math.sin(this.facingAngle) * 0.05;
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
          const group = this.animGroups[animName];
          const totalFrames =
            this.currentMove.startupFrames +
            this.currentMove.activeFrames +
            this.currentMove.recoveryFrames;
          const moveDuration = totalFrames / 60;
          let speed = this.currentMove.animSpeed || 1.0;
          if (group) {
            const groupDuration = group.to - group.from;
            if (groupDuration > 0 && moveDuration > 0) {
              speed = groupDuration / moveDuration;
              speed = Math.max(0.3, Math.min(speed, 4.0));
            }
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

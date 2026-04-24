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
  Color4,
  DynamicTexture,
  HighlightLayer,
  type Mesh,
  ParticleSystem,
  PBRMaterial,
  Quaternion,
  type Scene,
  SceneLoader,
  type Skeleton,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { HitResult, MoveData } from '../combat/CombatSystem';
import { MOVES } from '../combat/moves';
import { FIGHTER_STATE, GAME_CONSTANTS, HIT_RESULT } from '../constants';
import type { InputState } from '../Input';
import type { FighterStateSync } from '../Network';
import { ANIM_CONFIG, ANIM_POOLS, type AnimConfig, type AnimKey, pickRandom } from './animations';
import { CompositeAnimController, isCompositeAnim } from './CompositeAnimations';
import {
  cancelIntro,
  pickDefeatAnim,
  pickVictoryAnim,
  playIntroAnimation,
  playIntroAnimationExcluding,
  setDefeat,
  setVictory,
} from './FighterSequences';
import {
  handleAirState,
  handleAttackState,
  handleCrouchState,
  handleDashState,
  handleGetupState,
  handleJuggleState,
  handleKnockdownState,
  handleLandingState,
  handleRunState,
  handleSidestepState,
  handleStandingState,
  handleStunState,
} from './FighterStateHandlers';

export interface SharedAssets {
  baseMeshes: AbstractMesh[];
  baseSkeleton: Skeleton | null;
  animGroups: Record<string, AnimationGroup>;
  /** Runtime uniform scale applied to the fighter's root node */
  scale?: number;
}

const GC = GAME_CONSTANTS;

// Reverse lookup: MoveData → key string (for snapshot serialization)
const MOVE_TO_KEY = new Map<MoveData, string>();
for (const [key, move] of Object.entries(MOVES)) {
  MOVE_TO_KEY.set(move, key);
}

export interface FighterSnapshot {
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  state: string;
  previousState: string;
  facing: number;
  facingAngle: number;
  health: number;
  moveId: string | null;
  moveFrame: number;
  hasHitThisMove: boolean;
  isBlocking: boolean;
  isCrouching: boolean;
  isGrounded: boolean;
  comboCount: number;
  comboDamage: number;
  comboTimer: number;
  stunFrames: number;
  knockdownTimer: number;
  getupTimer: number;
  sideStepDir: number;
  sideStepTimer: number;
  dashTimer: number;
  isRunning: boolean;
  runFrames: number;
  landingTimer: number;
  hitFlash: number;
  superMeter: number;
  superPowerActive: boolean;
  superActivationLock: boolean;
  superWasActivatedThisRound: boolean;
  pendingSuperActivation: boolean;
}

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
  superMeter: number;
  superPowerActive: boolean;
  private _superActivationLock: boolean;
  private _superWasActivatedThisRound: boolean;
  _pendingSuperActivation: boolean;
  currentAnimKey: string;
  onSuperDeactivate: (() => void) | null = null;
  private _highlightLayer: HighlightLayer | null;
  private _shimmerActive = false;
  private _superParticles: ParticleSystem | null;
  private _superCoreParticles: ParticleSystem | null;
  private _rootRotY = 0;
  _introActive = false;
  _introTimeout: ReturnType<typeof setTimeout> | null = null;
  private _composite!: CompositeAnimController;
  private _skeleton: Skeleton | null = null;

  // Visual interpolation for remote fighter — smooths rollback corrections
  // so the opponent doesn't visually teleport when mispredictions are corrected.
  // Local fighter stays instant (player expects immediate response to input).
  // [Ref: VALVE-MP] Analogous to Source Engine entity interpolation (cl_interp)
  // [Ref: TAXONOMY] Classified as "Interpolation" technique in Claypool's taxonomy
  isRemote = false;
  private _visualX = 0;
  private _visualY = 0;
  private _visualZ = 0;

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

    this.superMeter = 0;
    this.superPowerActive = false;
    this._superActivationLock = false;
    this._superWasActivatedThisRound = false;
    this._pendingSuperActivation = false;
    this.currentAnimKey = '';
    this._highlightLayer = null;
    this._shimmerActive = false;
    this._superParticles = null;
    this._superCoreParticles = null;
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

  static async loadAssets(
    scene: Scene,
    characterId = 'beano',
    onProgress?: (p: number) => void,
  ): Promise<SharedAssets> {
    // Each <id>.glb is built offline by `bun run build:character`. It contains
    // the character's mesh + Mixamo skeleton (T-pose rest) + every UAL clip
    // referenced by ANIM_CONFIG, already retargeted onto the Mixamo bone names.
    // Animation groups are named after their source UAL clip (e.g. "Walk_Loop"),
    // so ANIM_CONFIG.glb lookup works unchanged.
    const result = await SceneLoader.ImportMeshAsync(
      null,
      '/assets/models/',
      `${characterId}.glb`,
      scene,
    );
    onProgress?.(1);

    for (const ag of result.animationGroups) ag.stop();

    const clipByName = new Map(result.animationGroups.map((ag) => [ag.name, ag]));

    const animGroups: Record<string, AnimationGroup> = {};
    for (const [gameName, cfg] of Object.entries(ANIM_CONFIG) as Array<[string, AnimConfig]>) {
      const found = clipByName.get(cfg.glb);
      if (!found) {
        console.warn(
          `[H4KKEN] Anim "${gameName}" (clip: "${cfg.glb}", src: ${cfg.src ?? 'ual1'}) not found`,
        );
        continue;
      }
      animGroups[gameName] = found;
    }

    const baseSkeleton = result.skeletons[0] ?? null;

    const baseMeshes: AbstractMesh[] = [];
    for (const m of result.meshes) {
      if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
      m.setEnabled(false);
      baseMeshes.push(m);
    }
    for (const n of result.transformNodes) n.setEnabled(false);

    // PBR materials from Mixamo GLBs expect IBL (environment texture) for indirect
    // lighting. Without one, environmentIntensity=1 contributes nothing and the
    // characters look dark compared to the StandardMaterial world. Boost direct light
    // response and drop the missing IBL expectation.
    for (const m of baseMeshes) {
      if (m.material instanceof PBRMaterial) {
        m.material.directIntensity = 2.5;
        m.material.environmentIntensity = 0;
      }
    }

    return { baseMeshes, baseSkeleton, animGroups };
  }

  init(assets: SharedAssets) {
    const { baseMeshes, baseSkeleton, animGroups, scale } = assets;

    // Each fighter gets a fresh root TransformNode as its positional anchor
    this.rootNode = new TransformNode(`fighter${this.playerIndex}_root`, this.scene);
    if (scale !== undefined && scale !== 1.0) {
      // Uniform scale on root. Mesh origin sits at feet, so scaling around (0,0,0)
      // keeps the character grounded.
      this.rootNode.scaling.setAll(scale);
    }

    const clonedSkeleton = baseSkeleton
      ? baseSkeleton.clone(`skeleton_f${this.playerIndex}`, `skel_${this.playerIndex}`)
      : null;
    this._skeleton = clonedSkeleton;

    if (clonedSkeleton) {
      // Unlink cloned bones from the base TransformNodes. The retargeted
      // animations target TransformNodes by name; the per-fighter target
      // remap below rewrites those to point at the cloned bones instead, so
      // the link would just cause all fighters to mirror the base pose.
      Fighter._unlinkBonesFromTransformNodes(clonedSkeleton);
      // Store bone matrices in a GPU texture instead of uploading as uniform arrays.
      // ~10-15% animation performance gain on 65-bone skeletons — the GPU reads
      // matrices from a texture fetch instead of consuming uniform buffer slots.
      clonedSkeleton.useTextureToStoreBoneMatrices = true;
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

    // Build suffix→Bone map so _cloneAnimGroups can remap targets to cloned bones
    const boneByName = new Map<string, Bone>();
    if (clonedSkeleton) {
      for (const bone of clonedSkeleton.bones) {
        boneByName.set(Fighter._boneSuffix(bone.name), bone);
      }
    }

    this._cloneAnimGroups(animGroups, boneByName);
    this._composite = new CompositeAnimController(this.scene, this.playerIndex);
    this._composite.build(this.animGroups);

    this.rootNode.position.copyFrom(this.position);
    // initRotY must match PI/2 - facingAngle used in updateVisuals().
    // P0 facingAngle=0  → PI/2;  P1 facingAngle=PI → -PI/2
    const initRotY = this.playerIndex === 0 ? Math.PI / 2 : -Math.PI / 2;
    this._rootRotY = initRotY;
    this.rootNode.rotationQuaternion = Fighter._makeRootQuat(initRotY);

    this._initSuperEffects();
    this.playAnimation('combatIdle');
  }

  dispose() {
    if (this._introTimeout !== null) {
      clearTimeout(this._introTimeout);
      this._introTimeout = null;
    }
    this._destroySuperEffects();
    this._highlightLayer?.dispose();
    this._highlightLayer = null;
    this._superParticles?.dispose();
    this._superParticles = null;
    this._superCoreParticles?.dispose();
    this._superCoreParticles = null;
    for (const ag of Object.values(this.animGroups)) {
      ag.stop();
      ag.dispose();
    }
    this.animGroups = {};
    this.currentAnimGroup = null;
    for (const mesh of this.meshes) mesh.dispose();
    this.meshes = [];
    this.rootNode?.dispose();
    this.rootNode = null;
    this._skeleton?.dispose();
    this._skeleton = null;
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
      clonedGroup.loopAnimation = (ANIM_CONFIG as Record<string, AnimConfig>)[name]?.loop ?? false;
      this.animGroups[name] = clonedGroup;
    }
  }

  // Canvas-based soft radial gradient texture — makes particles look like glowing fire blobs
  // instead of hard opaque dots.
  private _createFireParticleTexture(): DynamicTexture {
    const size = 64;
    const tex = new DynamicTexture(
      `fireTex_${this.playerIndex}`,
      { width: size, height: size },
      this.scene,
      false,
    );
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const cx = size / 2;
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    // P1 uses a white/neutral texture so the blue color gradients are not tinted by baked-in orange.
    // P2 keeps the fire-orange texture for a natural flame look.
    if (this.playerIndex === 0) {
      grad.addColorStop(0.0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.3, 'rgba(220,235,255,0.9)');
      grad.addColorStop(0.6, 'rgba(180,210,255,0.5)');
      grad.addColorStop(1.0, 'rgba(150,190,255,0)');
    } else {
      grad.addColorStop(0.0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.2, 'rgba(255,220,80,0.9)');
      grad.addColorStop(0.55, 'rgba(255,80,10,0.5)');
      grad.addColorStop(1.0, 'rgba(200,0,0,0)');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    tex.update();
    return tex;
  }

  private _initSuperEffects() {
    if (!this.rootNode) return;
    const isP1 = this.playerIndex === 0;

    // Per-mesh highlight to make the character itself glow
    const hl = new HighlightLayer(`superHL_${this.playerIndex}`, this.scene);
    hl.isEnabled = false;
    hl.innerGlow = true;
    const hlColor = isP1 ? new Color3(0.4, 0.8, 1.0) : new Color3(1.0, 0.55, 0.0);
    for (const mesh of this.meshes) hl.addMesh(mesh as Mesh, hlColor);
    this._highlightLayer = hl;

    const fireTex = this._createFireParticleTexture();
    const pos = this.rootNode.position; // Vector3 ref — updated every frame

    // ── Outer aura: tall rising flame column from the feet ─────────────────
    const aura = new ParticleSystem(`superAura_${this.playerIndex}`, 600, this.scene);
    aura.particleTexture = fireTex;
    aura.emitter = pos;
    // Flat disk at feet — particles shoot upward in a column
    aura.minEmitBox = new Vector3(-0.55, 0.0, -0.55);
    aura.maxEmitBox = new Vector3(0.55, 0.08, 0.55);
    aura.direction1 = new Vector3(-0.3, 5.0, -0.3);
    aura.direction2 = new Vector3(0.3, 10.0, 0.3);
    aura.minLifeTime = 0.55;
    aura.maxLifeTime = 1.1;
    aura.minSize = 0.35;
    aura.maxSize = 0.85;
    // Elongate on Y so particles look like flame tongues
    aura.minScaleX = 0.35;
    aura.maxScaleX = 0.7;
    aura.minScaleY = 2.0;
    aura.maxScaleY = 4.0;
    aura.emitRate = 260;
    aura.blendMode = ParticleSystem.BLENDMODE_ADD;
    aura.gravity = new Vector3(0, 0, 0);
    aura.minAngularSpeed = -2.0;
    aura.maxAngularSpeed = 2.0;
    // Color over lifetime: bright core → colored → fade out
    if (isP1) {
      aura.addColorGradient(0.0, new Color4(1.0, 1.0, 1.0, 1.0));
      aura.addColorGradient(0.2, new Color4(0.5, 0.8, 1.0, 1.0));
      aura.addColorGradient(0.6, new Color4(0.1, 0.4, 1.0, 0.7));
      aura.addColorGradient(1.0, new Color4(0.0, 0.1, 0.8, 0.0));
    } else {
      aura.addColorGradient(0.0, new Color4(1.0, 1.0, 1.0, 1.0));
      aura.addColorGradient(0.2, new Color4(1.0, 0.9, 0.3, 1.0));
      aura.addColorGradient(0.6, new Color4(1.0, 0.35, 0.0, 0.7));
      aura.addColorGradient(1.0, new Color4(0.8, 0.05, 0.0, 0.0));
    }
    // Size over lifetime: grow then shrink (flame tip narrows)
    aura.addSizeGradient(0.0, 0.4);
    aura.addSizeGradient(0.3, 1.0);
    aura.addSizeGradient(1.0, 0.1);
    this._superParticles = aura;

    // ── Inner core: rapid bright sparks crackling around the body ──────────
    const core = new ParticleSystem(`superCore_${this.playerIndex}`, 300, this.scene);
    core.particleTexture = fireTex;
    core.emitter = pos;
    core.minEmitBox = new Vector3(-0.3, 0.1, -0.3);
    core.maxEmitBox = new Vector3(0.3, 1.9, 0.3);
    core.direction1 = new Vector3(-1.2, 1.5, -1.2);
    core.direction2 = new Vector3(1.2, 4.0, 1.2);
    core.minLifeTime = 0.12;
    core.maxLifeTime = 0.35;
    core.minSize = 0.1;
    core.maxSize = 0.28;
    core.emitRate = 200;
    core.blendMode = ParticleSystem.BLENDMODE_ADD;
    core.gravity = new Vector3(0, 0, 0);
    if (isP1) {
      core.addColorGradient(0.0, new Color4(1.0, 1.0, 1.0, 1.0));
      core.addColorGradient(0.4, new Color4(0.6, 0.85, 1.0, 0.9));
      core.addColorGradient(1.0, new Color4(0.2, 0.5, 1.0, 0.0));
    } else {
      core.addColorGradient(0.0, new Color4(1.0, 1.0, 0.8, 1.0));
      core.addColorGradient(0.4, new Color4(1.0, 0.55, 0.1, 0.9));
      core.addColorGradient(1.0, new Color4(1.0, 0.2, 0.0, 0.0));
    }
    this._superCoreParticles = core;
  }

  private _destroySuperEffects() {
    if (this._highlightLayer) this._highlightLayer.isEnabled = false;
    this._shimmerActive = false;
    this._superParticles?.stop();
    this._superCoreParticles?.stop();
  }

  get speedMult(): number {
    return this.superPowerActive ? GC.SUPER_SPEED_MULT : 1;
  }

  activateSuperPower() {
    if (this.superPowerActive || this._pendingSuperActivation || this.superMeter < GC.SUPER_MAX)
      return;
    this._pendingSuperActivation = true;
  }

  applyServerSuperActivation() {
    if (this.superPowerActive) return;
    this.superPowerActive = true;
    this._superActivationLock = true;
    this._superWasActivatedThisRound = true;
    this._pendingSuperActivation = false;
    // Freeze horizontal movement during the activation flash — state handlers are skipped while locked
    this.velocity.x = 0;
    this.velocity.z = 0;
    if (this._highlightLayer) this._highlightLayer.isEnabled = true;
    this._shimmerActive = false;
    this._superParticles?.start();
    this._superCoreParticles?.start();
    if (this.animGroups.superActivate) {
      this.playAnimation('superActivate');
    } else {
      this._superActivationLock = false;
    }
  }

  private _deactivateSuperPower() {
    this.superPowerActive = false;
    this._destroySuperEffects();
    this.onSuperDeactivate?.();
    this.playAnimation('combatIdle');
  }

  playAnimation(name: string, speedOverride?: number, blendOverride?: number) {
    if (isCompositeAnim(name)) {
      const speed = (speedOverride ?? 1.0) * this.speedMult;
      if (this._composite.play(name, speed, blendOverride)) {
        if (this.currentAnimGroup) {
          this.currentAnimGroup.stop();
          this.currentAnimGroup = null;
        }
        this.currentAnimKey = name;
      }
      return;
    }

    this._composite.stop();

    const cfg = (ANIM_CONFIG as Record<string, AnimConfig>)[name];
    const newGroup = this.animGroups[name];
    if (!newGroup) return;

    if (this.currentAnimGroup === newGroup && newGroup.isPlaying) return;

    if (this.currentAnimGroup && this.currentAnimGroup !== newGroup) {
      this.currentAnimGroup.stop();
    }

    const baseSpeed = speedOverride ?? cfg?.speed ?? 1.0;
    // Boost all animation playback during super — except the activation animation itself
    const speed = name === 'superActivate' ? baseSpeed : baseSpeed * this.speedMult;
    const blend = blendOverride ?? cfg?.blend ?? 0.15;

    const from = Math.min(newGroup.from, newGroup.to);
    const to = Math.max(newGroup.from, newGroup.to);

    newGroup.enableBlending = true;
    newGroup.blendingSpeed = blend;
    newGroup.speedRatio = speed;
    newGroup.start(newGroup.loopAnimation, speed, from, to);
    this.currentAnimGroup = newGroup;
    this.currentAnimKey = name;
  }

  reset(startX: number) {
    this.position.set(startX, 0, 0);
    this.velocity.set(0, 0, 0);
    // Snap visual position to simulation position so interpolation doesn't
    // carry over stale offsets from the previous round.
    this._visualX = startX;
    this._visualY = 0;
    this._visualZ = 0;
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
    if (this.superPowerActive || this._superWasActivatedThisRound) {
      this.superMeter = 0;
    }
    this.superPowerActive = false;
    this._superActivationLock = false;
    this._superWasActivatedThisRound = false;
    this._pendingSuperActivation = false;
    this._destroySuperEffects();
    this.facing = 1;
    this.facingAngle = startX > 0 ? Math.PI : 0;
    this._rootRotY = Math.PI / 2 - this.facingAngle;
    if (this.rootNode) {
      this.rootNode.rotationQuaternion = Fighter._makeRootQuat(this._rootRotY);
    }

    this.playAnimation('combatIdle');
  }

  snapshotSim(): FighterSnapshot {
    return {
      px: this.position.x,
      py: this.position.y,
      pz: this.position.z,
      vx: this.velocity.x,
      vy: this.velocity.y,
      vz: this.velocity.z,
      state: this.state,
      previousState: this.previousState,
      facing: this.facing,
      facingAngle: this.facingAngle,
      health: this.health,
      moveId: this.currentMove ? (MOVE_TO_KEY.get(this.currentMove) ?? null) : null,
      moveFrame: this.moveFrame,
      hasHitThisMove: this.hasHitThisMove,
      isBlocking: this.isBlocking,
      isCrouching: this.isCrouching,
      isGrounded: this.isGrounded,
      comboCount: this.comboCount,
      comboDamage: this.comboDamage,
      comboTimer: this.comboTimer,
      stunFrames: this.stunFrames,
      knockdownTimer: this.knockdownTimer,
      getupTimer: this.getupTimer,
      sideStepDir: this.sideStepDir,
      sideStepTimer: this.sideStepTimer,
      dashTimer: this.dashTimer,
      isRunning: this.isRunning,
      runFrames: this.runFrames,
      landingTimer: this.landingTimer,
      hitFlash: this.hitFlash,
      superMeter: this.superMeter,
      superPowerActive: this.superPowerActive,
      superActivationLock: this._superActivationLock,
      superWasActivatedThisRound: this._superWasActivatedThisRound,
      pendingSuperActivation: this._pendingSuperActivation,
    };
  }

  restoreSim(s: FighterSnapshot) {
    this.position.set(s.px, s.py, s.pz);
    this.velocity.set(s.vx, s.vy, s.vz);
    this.state = s.state;
    this.previousState = s.previousState;
    this.facing = s.facing;
    this.facingAngle = s.facingAngle;
    this.health = s.health;
    this.currentMove = s.moveId ? (MOVES[s.moveId] ?? null) : null;
    this.moveFrame = s.moveFrame;
    this.hasHitThisMove = s.hasHitThisMove;
    this.isBlocking = s.isBlocking;
    this.isCrouching = s.isCrouching;
    this.isGrounded = s.isGrounded;
    this.comboCount = s.comboCount;
    this.comboDamage = s.comboDamage;
    this.comboTimer = s.comboTimer;
    this.stunFrames = s.stunFrames;
    this.knockdownTimer = s.knockdownTimer;
    this.getupTimer = s.getupTimer;
    this.sideStepDir = s.sideStepDir;
    this.sideStepTimer = s.sideStepTimer;
    this.dashTimer = s.dashTimer;
    this.isRunning = s.isRunning;
    this.runFrames = s.runFrames;
    this.landingTimer = s.landingTimer;
    this.hitFlash = s.hitFlash;
    this.superMeter = s.superMeter;
    this.superPowerActive = s.superPowerActive;
    this._superActivationLock = s.superActivationLock;
    this._superWasActivatedThisRound = s.superWasActivatedThisRound;
    this._pendingSuperActivation = s.pendingSuperActivation;
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

    if (input.superJust && !this.superPowerActive && this.superMeter >= GC.SUPER_MAX) {
      this.activateSuperPower();
    }
    if (this.superPowerActive) {
      this.superMeter = Math.max(0, this.superMeter - GC.SUPER_DRAIN_RATE);
      if (this.superMeter <= 0) this._deactivateSuperPower();
    }
    if (this._superActivationLock) {
      const ag = this.animGroups.superActivate;
      if (ag?.isPlaying) return;
      this._superActivationLock = false;
      if (this.superPowerActive) this.playAnimation('combatIdle');
    }

    const relInput = this.getRelativeInput(input);

    switch (this.state) {
      case FIGHTER_STATE.IDLE:
      case FIGHTER_STATE.WALK_FORWARD:
      case FIGHTER_STATE.WALK_BACKWARD:
        handleStandingState(this, relInput);
        break;
      case FIGHTER_STATE.CROUCH:
      case FIGHTER_STATE.CROUCH_WALK:
        handleCrouchState(this, relInput);
        break;
      case FIGHTER_STATE.JUMP:
      case FIGHTER_STATE.JUMP_FORWARD:
      case FIGHTER_STATE.JUMP_BACKWARD:
      case FIGHTER_STATE.FALLING:
        handleAirState(this, relInput);
        break;
      case FIGHTER_STATE.RUN:
        handleRunState(this, relInput);
        break;
      case FIGHTER_STATE.ATTACKING:
        handleAttackState(this, relInput);
        break;
      case FIGHTER_STATE.HIT_STUN:
      case FIGHTER_STATE.BLOCK_STUN:
        handleStunState(this, relInput);
        break;
      case FIGHTER_STATE.JUGGLE:
        handleJuggleState(this);
        break;
      case FIGHTER_STATE.KNOCKDOWN:
        handleKnockdownState(this);
        break;
      case FIGHTER_STATE.GETUP:
        handleGetupState(this);
        break;
      case FIGHTER_STATE.SIDESTEP:
        handleSidestepState(this);
        break;
      case FIGHTER_STATE.DASH_BACK:
        handleDashState(this);
        break;
      case FIGHTER_STATE.LANDING:
        handleLandingState(this);
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
      // Math.abs handles GLBs where from > to (would otherwise produce negative speed)
      const groupDuration = Math.abs(group.to - group.from);
      if (groupDuration > 0 && moveDuration > 0) {
        speed = (groupDuration / 60 / moveDuration) * (move.animSpeed || 1.0);
        speed = Math.max(0.3, Math.min(speed, 4.0));
      }
    }
    // combo blend overrides the per-animation default for a tighter chain feel
    this.playAnimation(animName as AnimKey, speed, isCombo ? 0.08 : undefined);
  }

  startSidestep(direction: number) {
    this.state = FIGHTER_STATE.SIDESTEP;
    this.sideStepDir = direction;
    this.sideStepTimer = GC.SIDESTEP_FRAMES;
    this.playAnimation(direction < 0 ? 'dodgeLeft' : 'dodgeRight');
  }

  onHit(result: HitResult, _attackerFacing: number) {
    switch (result.type) {
      case 'hit': {
        this.isBlocking = false;
        const dmg = this.superPowerActive
          ? Math.round(result.damage * GC.SUPER_DAMAGE_IN)
          : result.damage;
        this.health = Math.max(0, this.health - dmg);
        this.comboCount = result.comboHits;
        this.comboDamage = (this.comboDamage || 0) + result.damage;
        this.comboTimer = 60;
        this.velocity.x = -result.pushback;
        this.hitFlash = 6;

        switch (result.onHit) {
          case HIT_RESULT.STAGGER:
            this.state = FIGHTER_STATE.HIT_STUN;
            this.stunFrames = result.hitstun;
            this.playAnimation(pickRandom(ANIM_POOLS.hurtLight));
            break;
          case HIT_RESULT.KNOCKBACK: {
            this.state = FIGHTER_STATE.HIT_STUN;
            this.stunFrames = result.hitstun;
            // UAL2 knockback stumble — visually distinct from light stagger
            this.playAnimation('hurtHeavy');
            break;
          }
          case HIT_RESULT.LAUNCH:
            this.state = FIGHTER_STATE.JUGGLE;
            this.velocity.y = result.launchVelocity;
            this.velocity.x = -result.pushback * 0.5;
            this.isGrounded = false;
            this.playAnimation(pickRandom(ANIM_POOLS.hurtAir));
            break;
          case HIT_RESULT.KNOCKDOWN:
            this.state = FIGHTER_STATE.KNOCKDOWN;
            this.knockdownTimer = 50;
            this.velocity.x = -result.pushback * 1.5;
            this.playAnimation('falling');
            break;
          case HIT_RESULT.CRUMPLE:
            this.state = FIGHTER_STATE.HIT_STUN;
            this.stunFrames = result.hitstun + 10;
            this.velocity.x = -result.pushback * 0.3;
            // Heavy stagger — reuse knockback animation at half speed for crumple feel
            this.playAnimation('hurtHeavy', 0.5);
            break;
          case HIT_RESULT.THROW_HIT:
            this.state = FIGHTER_STATE.KNOCKDOWN;
            this.knockdownTimer = 60;
            this.velocity.y = 0.15;
            this.velocity.x = -(result.pushback || 0.3);
            this.isGrounded = false;
            this.playAnimation('falling');
            break;
        }
        break;
      }
      case 'blocked': {
        this.health = Math.max(0, this.health - result.chipDamage);
        if (!this.superPowerActive) {
          this.superMeter = Math.min(GC.SUPER_MAX, this.superMeter + GC.SUPER_GAIN_BLOCK);
        }
        this.state = FIGHTER_STATE.BLOCK_STUN;
        this.stunFrames = result.blockstun;
        this.velocity.x = -result.pushback;
        this.isBlocking = true;
        // Guard-raise reaction: PunchKick_Enter snaps both arms up into block pose
        this.playAnimation('block', undefined, 0.05);
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
    const idleEmissive = Color3.Black();
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

    // Remote fighter: lerp visual position to smooth rollback corrections.
    // Factor 0.4 converges in 2-3 frames (~33-50ms), fast enough to not feel
    // "floaty" but slow enough to hide typical 1-5 frame rollback teleports.
    // Local fighter: instant position (player expects immediate input response).
    // [Ref: VALVE-MP] Valve defaults to cl_interp=100ms; we use ~50ms because
    //   P2P rollback only corrects mispredictions, not full server authority lag.
    // [Ref: OSAKA] Ishioka shows repeat-last prediction >70% accurate at 1-3f,
    //   so most corrections are <2 frames — lerp 0.4 absorbs them invisibly.
    if (this.isRemote) {
      this._visualX += (this.position.x - this._visualX) * 0.4;
      this._visualY += (this.position.y - this._visualY) * 0.4;
      this._visualZ += (this.position.z - this._visualZ) * 0.4;
      this.rootNode.position.set(this._visualX, this._visualY, this._visualZ);
    } else {
      this.rootNode.position.copyFrom(this.position);
    }

    // Quaternius character natively faces +Z. Facing angle is the world-space direction to opponent.
    // BabylonJS RotationAxis(Up, θ) maps +Z → (sin θ, 0, cos θ). To face direction (cos A, 0, sin A)
    // we need sin θ = cos A and cos θ = sin A, so θ = PI/2 - facingAngle (not PI/2 + facingAngle).
    const targetRotY = Math.PI / 2 - this.facingAngle;
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

    if (this._highlightLayer) {
      const t = Date.now();
      if (this.superPowerActive) {
        // Active: strong pulsing highlight
        const pulse = 0.6 + 0.5 * Math.sin(t / 200);
        this._highlightLayer.blurHorizontalSize = pulse;
        this._highlightLayer.blurVerticalSize = pulse;
      } else {
        // Available (meter full): subtle slow shimmer, no flames
        const available = this.superMeter >= GC.SUPER_MAX && !this._pendingSuperActivation;
        if (available !== this._shimmerActive) {
          this._shimmerActive = available;
          this._highlightLayer.isEnabled = available;
        }
        if (available) {
          const shimmer = 0.2 + 0.12 * Math.sin(t / 700);
          this._highlightLayer.blurHorizontalSize = shimmer;
          this._highlightLayer.blurVerticalSize = shimmer;
        }
      }
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
      superMeter: this.superMeter,
      superPowerActive: this.superPowerActive,
      currentAnimKey: this.currentAnimKey,
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

    if (data.superMeter !== undefined) this.superMeter = data.superMeter;

    if (data.superPowerActive !== undefined && data.superPowerActive !== this.superPowerActive) {
      this.superPowerActive = data.superPowerActive;
      if (this.superPowerActive) {
        if (this._highlightLayer) this._highlightLayer.isEnabled = true;
        this._superParticles?.start();
        this._superCoreParticles?.start();
      } else {
        this._destroySuperEffects();
        this._superActivationLock = false;
      }
    }

    if (data.state !== this.state) {
      this.state = data.state;
      // Use the synced animation key if available; fall back to state-driven choice
      if (data.currentAnimKey && !this._superActivationLock) {
        this.playAnimation(data.currentAnimKey);
      } else {
        this.updateAnimationForState();
      }
    } else if (
      data.currentAnimKey &&
      data.currentAnimKey !== this.currentAnimKey &&
      !this._superActivationLock
    ) {
      this.playAnimation(data.currentAnimKey);
    }
  }

  updateAnimationForState() {
    switch (this.state) {
      case FIGHTER_STATE.IDLE:
        this.playAnimation('combatIdle');
        break;
      case FIGHTER_STATE.WALK_FORWARD:
        this.playAnimation('walk');
        break;
      case FIGHTER_STATE.WALK_BACKWARD:
        this.playAnimation('walkBack');
        break;
      case FIGHTER_STATE.CROUCH:
        this.playAnimation('crouchIdle');
        break;
      case FIGHTER_STATE.RUN:
        this.playAnimation('sprint');
        break;
      case FIGHTER_STATE.JUMP:
      case FIGHTER_STATE.JUMP_FORWARD:
      case FIGHTER_STATE.JUMP_BACKWARD:
        this.playAnimation('jump');
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
            const groupDuration = Math.abs(group.to - group.from);
            if (groupDuration > 0 && moveDuration > 0) {
              speed = (groupDuration / 60 / moveDuration) * (this.currentMove.animSpeed || 1.0);
              speed = Math.max(0.3, Math.min(speed, 4.0));
            }
          }
          this.playAnimation(animName as AnimKey, speed);
        }
        break;
      case FIGHTER_STATE.HIT_STUN:
      case FIGHTER_STATE.BLOCK_STUN:
        this.playAnimation('hurt1');
        break;
      case FIGHTER_STATE.JUGGLE:
        this.playAnimation('falling');
        break;
      case FIGHTER_STATE.KNOCKDOWN:
        this.playAnimation('juggleLand');
        break;
      case FIGHTER_STATE.SIDESTEP:
        this.playAnimation(this.sideStepDir < 0 ? 'walkLeft' : 'walkRight');
        break;
      case FIGHTER_STATE.DASH_BACK:
        this.playAnimation('walkBack');
        break;
      case FIGHTER_STATE.LANDING:
        this.playAnimation('landing');
        break;
      case FIGHTER_STATE.GETUP:
        this.playAnimation('landing');
        break;
      case FIGHTER_STATE.VICTORY:
        this.playAnimation('victory');
        break;
      case FIGHTER_STATE.DEFEAT:
        this.playAnimation('falling');
        break;
    }
  }

  pickVictoryAnim(): AnimKey {
    return pickVictoryAnim(this);
  }

  pickDefeatAnim(matchOver: boolean): AnimKey {
    return pickDefeatAnim(this, matchOver);
  }

  setVictory(animName?: AnimKey): AnimKey {
    return setVictory(this, animName);
  }

  setDefeat(animName?: AnimKey, matchOver = false): AnimKey {
    return setDefeat(this, animName, matchOver);
  }

  playIntroAnimation(): AnimKey {
    return playIntroAnimation(this);
  }

  playIntroAnimationExcluding(exclude: AnimKey): AnimKey {
    return playIntroAnimationExcluding(this, exclude);
  }

  cancelIntro() {
    cancelIntro(this);
  }
}

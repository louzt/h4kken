// ============================================================
// H4KKEN - Combat Types & Shared Enums
// ============================================================

export type AttackLevel = 'high' | 'mid' | 'low' | 'throw';
export type HitResultType = 'stagger' | 'knockback' | 'launch' | 'knockdown' | 'crumple' | 'throw';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MoveData {
  name: string;
  command: string;
  inputDir: string | null;
  level: AttackLevel;
  damage: number;
  chipDamage: number;
  startupFrames: number;
  activeFrames: number;
  recoveryFrames: number;
  hitstun: number;
  blockstun: number;
  onHit: HitResultType;
  pushback: number;
  pushbackOnBlock: number;
  animation: string;
  animSpeed: number;
  hitboxOffset: Vec3;
  hitboxSize: Vec3;
  comboRoutes: string[];
  canChainFrom: string[];
  launchVelocity?: number;
  forwardLunge?: number;
  requiresCrouch?: boolean;
  isHeavy?: boolean;
  throwMove?: boolean;
}

export type HitResultWhiff = { type: 'whiff' };
export type HitResultBlocked = {
  type: 'blocked';
  blockstun: number;
  pushback: number;
  chipDamage: number;
};
export type HitResultHit = {
  type: 'hit';
  damage: number;
  hitstun: number;
  pushback: number;
  onHit: HitResultType;
  launchVelocity: number;
  comboHits: number;
};
export type HitResult = HitResultWhiff | HitResultBlocked | HitResultHit;

// Minimal fighter shape needed by CombatSystem static methods
export interface FighterLike {
  state: string;
  isCrouching: boolean;
  isBlocking: boolean;
  currentMove: MoveData | null;
  moveFrame: number;
  comboCount: number;
  superPowerActive?: boolean;
}

// Attack level shorthand — private to combat module
export const LEVEL = {
  HIGH: 'high',
  MID: 'mid',
  LOW: 'low',
  THROW: 'throw',
} as const;

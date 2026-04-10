// ============================================================
// H4KKEN - Shared Game Constants
// ============================================================

// Master pace multiplier — controls how long rounds feel.
// 1 = original tuning, 2 = twice the HP and super duration.
// Affects: MAX_HEALTH, SUPER_MAX, SUPER_GAIN_BLOCK.
// Does NOT affect movement, physics, or attack frame data.
const PACE_SCALE = 2;

export const HIT_RESULT = {
  STAGGER: 'stagger', // Normal hitstun
  KNOCKBACK: 'knockback', // Push back with stun
  LAUNCH: 'launch', // Launcher into juggle
  KNOCKDOWN: 'knockdown', // Knockdown
  CRUMPLE: 'crumple', // Slow fall crumple
  THROW_HIT: 'throw', // Throw
} as const;

export const FIGHTER_STATE = {
  IDLE: 'idle',
  WALK_FORWARD: 'walkForward',
  WALK_BACKWARD: 'walkBackward',
  CROUCH: 'crouch',
  CROUCH_WALK: 'crouchWalk',
  JUMP: 'jump',
  JUMP_FORWARD: 'jumpForward',
  JUMP_BACKWARD: 'jumpBackward',
  FALLING: 'falling',
  LANDING: 'landing',
  RUN: 'run',
  DASH_BACK: 'dashBack',
  SIDESTEP: 'sidestep',
  ATTACKING: 'attacking',
  BLOCKING: 'blocking',
  HIT_STUN: 'hitStun',
  BLOCK_STUN: 'blockStun',
  JUGGLE: 'juggle',
  KNOCKDOWN: 'knockdown',
  GETUP: 'getup',
  VICTORY: 'victory',
  DEFEAT: 'defeat',
};

export const GAME_CONSTANTS = {
  GRAVITY: -0.025,
  GROUND_Y: 0,
  ARENA_WIDTH: 12,
  ARENA_DEPTH: 5,
  WALK_SPEED: 0.045,
  BACK_WALK_SPEED: 0.035,
  RUN_SPEED: 0.09,
  CROUCH_WALK_SPEED: 0.02,
  JUMP_VELOCITY: 0.28,
  JUMP_FORWARD_X: 0.05,
  SIDESTEP_SPEED: 0.08,
  SIDESTEP_FRAMES: 15,
  DASH_BACK_SPEED: 0.1,
  DASH_BACK_FRAMES: 18,
  PUSHBACK_DECAY: 0.85,
  THROW_RANGE: 1.8,
  MAX_HEALTH: 170 * PACE_SCALE,
  ROUND_TIME: 90,
  ROUNDS_TO_WIN: 2,
  JUGGLE_GRAVITY: -0.018,
  COMBO_SCALING_PER_HIT: 0.88,
  MIN_COMBO_SCALING: 0.2,
  GETUP_FRAMES: 30,
  LANDING_FRAMES: 8,
  WALL_BOUNCE_SPEED: 0.06,
  SUPER_MAX: 600 * PACE_SCALE,
  SUPER_GAIN_BLOCK: 60 * PACE_SCALE,
  SUPER_DRAIN_RATE: 1.0,
  SUPER_DAMAGE_OUT: 1.5,
  SUPER_DAMAGE_IN: 0.75,
};

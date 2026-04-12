// ============================================================
// H4KKEN - Combat Resolution System
// ============================================================

import { FIGHTER_STATE, GAME_CONSTANTS } from '../constants';
import type { InputState } from '../Input';
import { MOVES } from './moves';
import {
  type FighterLike,
  type HitResult,
  type HitResultBlocked,
  type HitResultHit,
  LEVEL,
  type MoveData,
  type Vec3,
} from './types';

// Re-export types used by Game and Fighter so they can import from one place
export type { HitResult, MoveData } from './types';

export namespace CombatSystem {
  function resolveRunningOrThrow(input: InputState, state: string): MoveData | null {
    if (input.lpJust && input.lkJust) return MOVES.throw_cmd ?? null;
    if (state === FIGHTER_STATE.RUN) {
      if (input.lkJust || input.rkJust) return MOVES.slide_attack ?? null;
      if (input.lpJust || input.rpJust) return MOVES.running_attack ?? null;
    }
    return null;
  }

  function resolveAerialAttack(input: InputState): MoveData | null {
    if (input.lkJust || input.rkJust || input.lpJust || input.rpJust) {
      return MOVES.aerial_kick ?? null;
    }
    return null;
  }

  function resolveCrouchingAttack(input: InputState): MoveData | null {
    if (input.rpJust) return MOVES.d_rp ?? null;
    if (input.lpJust) return MOVES.d_lp ?? null;
    if (input.rkJust) return MOVES.d_rk ?? null;
    if (input.lkJust) return MOVES.d_lk ?? null;
    return null;
  }

  function resolveNeutralAttack(input: InputState): MoveData | null {
    if (input.down && input.forward && input.rpJust) return MOVES.df_rp ?? null;
    if (input.forward && input.rpJust) return MOVES.f_rp ?? null;
    if (input.forward && input.lpJust) return MOVES.f_lp ?? null;
    if (input.lpJust) return MOVES.lp ?? null;
    if (input.rpJust) return MOVES.rp ?? null;
    if (input.lkJust) return MOVES.lk ?? null;
    if (input.rkJust) return MOVES.rk ?? null;
    return null;
  }

  export function resolveMove(input: InputState, fighter: FighterLike): MoveData | null {
    const { state, isCrouching } = fighter;

    const noAttackStates = [
      FIGHTER_STATE.HIT_STUN,
      FIGHTER_STATE.BLOCK_STUN,
      FIGHTER_STATE.JUGGLE,
      FIGHTER_STATE.KNOCKDOWN,
      FIGHTER_STATE.GETUP,
      FIGHTER_STATE.LANDING,
      FIGHTER_STATE.VICTORY,
      FIGHTER_STATE.DEFEAT,
    ];
    if (noAttackStates.includes(state)) return null;

    if (state === FIGHTER_STATE.ATTACKING && fighter.currentMove) {
      return resolveComboInput(input, fighter);
    }

    const airStates = [
      FIGHTER_STATE.JUMP,
      FIGHTER_STATE.JUMP_FORWARD,
      FIGHTER_STATE.JUMP_BACKWARD,
      FIGHTER_STATE.FALLING,
    ];
    if (airStates.includes(state)) {
      return resolveAerialAttack(input);
    }

    const runOrThrow = resolveRunningOrThrow(input, state);
    if (runOrThrow) return runOrThrow;

    if (isCrouching || input.down) {
      const crouch = resolveCrouchingAttack(input);
      if (crouch) return crouch;
    }

    return resolveNeutralAttack(input);
  }

  export function resolveComboInput(input: InputState, fighter: FighterLike): MoveData | null {
    const currentMove = fighter.currentMove;
    if (!currentMove) return null;
    const moveFrame = fighter.moveFrame;
    const chainWindowStart = currentMove.startupFrames + currentMove.activeFrames - 2;
    if (moveFrame < chainWindowStart) return null;

    let nextMoveId: string | null = null;
    if (input.lpJust && currentMove.comboRoutes.includes('lp')) nextMoveId = 'lp';
    if (input.rpJust && currentMove.comboRoutes.includes('rp')) nextMoveId = 'rp';
    if (input.lkJust && currentMove.comboRoutes.includes('lk')) nextMoveId = 'lk';
    if (input.rkJust && currentMove.comboRoutes.includes('rk')) nextMoveId = 'rk';

    if (input.down) {
      if (input.rpJust && currentMove.comboRoutes.includes('d_rp')) nextMoveId = 'd_rp';
      if (input.lkJust && currentMove.comboRoutes.includes('d_lk')) nextMoveId = 'd_lk';
      if (input.rkJust && currentMove.comboRoutes.includes('d_rk')) nextMoveId = 'd_rk';
    }

    if (nextMoveId !== null) {
      return MOVES[nextMoveId] ?? null;
    }

    return null;
  }

  function isBlocked(_attacker: FighterLike, defender: FighterLike, move: MoveData): boolean {
    const unblockableStates = [
      FIGHTER_STATE.HIT_STUN,
      FIGHTER_STATE.JUGGLE,
      FIGHTER_STATE.KNOCKDOWN,
      FIGHTER_STATE.GETUP,
    ];
    if (unblockableStates.includes(defender.state)) return false;

    if (!defender.isBlocking) return false;

    if (move.level === LEVEL.THROW) return false;

    if (!defender.isCrouching) {
      if (move.level === LEVEL.LOW) return false;
      return true;
    }

    if (move.level === LEVEL.HIGH) return false;
    if (move.level === LEVEL.MID) return false;
    return true;
  }

  function highWhiffs(move: MoveData, defender: FighterLike): boolean {
    return move.level === LEVEL.HIGH && defender.isCrouching;
  }

  function calculateDamage(baseDamage: number, comboHits: number) {
    if (comboHits <= 1) return baseDamage;
    const scaling = Math.max(
      GAME_CONSTANTS.MIN_COMBO_SCALING,
      GAME_CONSTANTS.COMBO_SCALING_PER_HIT ** (comboHits - 1),
    );
    return Math.round(baseDamage * scaling);
  }

  export function resolveHit(
    attacker: FighterLike,
    defender: FighterLike,
    move: MoveData,
  ): HitResult {
    if (highWhiffs(move, defender)) {
      return { type: 'whiff' };
    }

    if (isBlocked(attacker, defender, move)) {
      return {
        type: 'blocked',
        blockstun: move.blockstun,
        pushback: move.pushbackOnBlock,
        chipDamage: move.chipDamage,
      } satisfies HitResultBlocked;
    }

    const comboHits = (defender.comboCount || 0) + 1;
    let damage = calculateDamage(move.damage, comboHits);
    if (attacker.superPowerActive) {
      damage = Math.round(damage * GAME_CONSTANTS.SUPER_DAMAGE_OUT);
    }

    return {
      type: 'hit',
      damage,
      hitstun: move.hitstun,
      pushback: move.pushback,
      onHit: move.onHit,
      launchVelocity: move.launchVelocity || 0,
      comboHits,
    } satisfies HitResultHit;
  }

  export function checkHitbox(
    attackerPos: Vec3,
    attackerFacingAngle: number,
    move: MoveData,
    defenderPos: Vec3,
    defenderWidth = 0.5,
  ): boolean {
    const cosA = Math.cos(attackerFacingAngle);
    const sinA = Math.sin(attackerFacingAngle);
    const fwdOff = move.hitboxOffset.x;
    const latOff = move.hitboxOffset.z || 0;
    const hbx = attackerPos.x + fwdOff * cosA - latOff * sinA;
    const hby = attackerPos.y + move.hitboxOffset.y;
    const hbz = attackerPos.z + fwdOff * sinA + latOff * cosA;

    const defHalfW = defenderWidth;
    const defH = 1.8;
    const defHalfD = 0.4;

    const overlapX = Math.abs(hbx - defenderPos.x) < move.hitboxSize.x + defHalfW;
    const overlapY =
      hby + move.hitboxSize.y > defenderPos.y && hby - move.hitboxSize.y < defenderPos.y + defH;
    const overlapZ = Math.abs(hbz - defenderPos.z) < move.hitboxSize.z + defHalfD;

    return overlapX && overlapY && overlapZ;
  }
}

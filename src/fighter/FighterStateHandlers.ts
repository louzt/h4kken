// ============================================================
// H4KKEN - Fighter State Handlers
// Plain functions extracted from Fighter to keep Fighter.ts lean.
// Each function receives the Fighter instance as its first argument.
// ============================================================

import { CombatSystem } from '../combat/CombatSystem';
import { FIGHTER_STATE, GAME_CONSTANTS } from '../constants';
import type { InputState } from '../Input';
import type { Fighter } from './Fighter';

const GC = GAME_CONSTANTS;

export function handleStandingState(fighter: Fighter, input: InputState): void {
  fighter.isCrouching = false;
  const wasBlocking = fighter.isBlocking;
  fighter.isBlocking = input.block;

  if (fighter.isBlocking) {
    fighter.velocity.x = 0;
    fighter.state = FIGHTER_STATE.IDLE;
    if (!wasBlocking) {
      fighter.playAnimation('block');
    }
    return;
  }

  if (wasBlocking) {
    fighter.playAnimation('blockExit');
  }

  const move = CombatSystem.resolveMove(input, fighter);
  if (move) {
    fighter.startAttack(move);
    return;
  }

  if (input.upJust) {
    fighter.velocity.y = GC.JUMP_VELOCITY * fighter.speedMult;
    if (input.forward) {
      fighter.velocity.x = GC.JUMP_FORWARD_X * fighter.speedMult;
      fighter.state = FIGHTER_STATE.JUMP_FORWARD;
    } else if (input.back) {
      fighter.velocity.x = -GC.JUMP_FORWARD_X * fighter.speedMult;
      fighter.state = FIGHTER_STATE.JUMP_BACKWARD;
    } else {
      fighter.state = FIGHTER_STATE.JUMP;
    }
    fighter.isGrounded = false;
    fighter.playAnimation('jumpSquat', 6.0, 0.05);
    fighter.animGroups.jumpSquat?.onAnimationGroupEndObservable.addOnce(() => {
      if (!fighter.isGrounded) {
        fighter.playAnimation('jump');
        fighter.animGroups.jump?.onAnimationGroupEndObservable.addOnce(() => {
          if (!fighter.isGrounded && fighter.state !== FIGHTER_STATE.ATTACKING) {
            fighter.playAnimation('falling');
          }
        });
      }
    });
    return;
  }

  if (input.down) {
    fighter.state = FIGHTER_STATE.CROUCH;
    fighter.isCrouching = true;
    if (fighter.animGroups.crouchEnter) {
      fighter.playAnimation('crouchEnter');
      fighter.animGroups.crouchEnter.onAnimationGroupEndObservable.addOnce(() => {
        if (fighter.isCrouching && fighter.state === FIGHTER_STATE.CROUCH) {
          fighter.playAnimation('crouchIdle');
        }
      });
    } else {
      fighter.playAnimation('crouchIdle');
    }
    return;
  }

  if (input.sideStepUp) {
    fighter.startSidestep(1);
    return;
  }
  if (input.sideStepDown) {
    fighter.startSidestep(-1);
    return;
  }

  if (input.dashBack) {
    fighter.state = FIGHTER_STATE.DASH_BACK;
    fighter.dashTimer = GC.DASH_BACK_FRAMES;
    fighter.velocity.x = -GC.DASH_BACK_SPEED * fighter.speedMult;
    fighter.playAnimation('runBack');
    return;
  }

  if (input.dashForward) {
    fighter.state = FIGHTER_STATE.RUN;
    fighter.isRunning = true;
    fighter.runFrames = 0;
    fighter.playAnimation('sprint');
    return;
  }

  if (input.forward) {
    fighter.velocity.x = GC.WALK_SPEED * fighter.speedMult;
    fighter.state = FIGHTER_STATE.WALK_FORWARD;
    fighter.playAnimation('walk');
  } else if (input.back) {
    fighter.velocity.x = -GC.BACK_WALK_SPEED * fighter.speedMult;
    fighter.state = FIGHTER_STATE.WALK_BACKWARD;
    fighter.playAnimation('walkBack');
  } else {
    fighter.velocity.x = 0;
    if (fighter.state !== FIGHTER_STATE.IDLE) {
      fighter.state = FIGHTER_STATE.IDLE;
      fighter.playAnimation('combatIdle');
    }
  }
}

export function handleCrouchState(fighter: Fighter, input: InputState): void {
  fighter.isCrouching = true;
  fighter.isBlocking = input.block;

  if (!input.down) {
    fighter.isCrouching = false;
    fighter.state = FIGHTER_STATE.IDLE;
    if (fighter.animGroups.crouchExit) {
      fighter.playAnimation('crouchExit');
      fighter.animGroups.crouchExit.onAnimationGroupEndObservable.addOnce(() => {
        if (!fighter.isCrouching && fighter.state === FIGHTER_STATE.IDLE) {
          fighter.playAnimation('combatIdle');
        }
      });
    } else {
      fighter.playAnimation('combatIdle');
    }
    return;
  }

  const move = CombatSystem.resolveMove(input, fighter);
  if (move) {
    fighter.startAttack(move);
    return;
  }

  if (input.forward) {
    fighter.velocity.x = GC.CROUCH_WALK_SPEED * fighter.speedMult;
    if (
      fighter.state !== FIGHTER_STATE.CROUCH_WALK ||
      fighter.currentAnimGroup !== fighter.animGroups.crouchWalk
    ) {
      fighter.state = FIGHTER_STATE.CROUCH_WALK;
      fighter.playAnimation('crouchWalk');
    }
  } else if (input.back) {
    fighter.velocity.x = -GC.CROUCH_WALK_SPEED * fighter.speedMult;
    if (
      fighter.state !== FIGHTER_STATE.CROUCH_WALK ||
      fighter.currentAnimGroup !== fighter.animGroups.crouchWalkBack
    ) {
      fighter.state = FIGHTER_STATE.CROUCH_WALK;
      fighter.playAnimation('crouchWalkBack');
    }
  } else {
    fighter.velocity.x = 0;
    if (fighter.state !== FIGHTER_STATE.CROUCH) {
      fighter.state = FIGHTER_STATE.CROUCH;
      fighter.playAnimation(input.block ? 'crouchBlock' : 'crouchIdle');
    } else if (input.block && fighter.currentAnimKey !== 'crouchBlock') {
      fighter.playAnimation('crouchBlock');
    } else if (!input.block && fighter.currentAnimKey === 'crouchBlock') {
      fighter.playAnimation('crouchIdle');
    }
  }
}

export function handleAirState(fighter: Fighter, input: InputState): void {
  const move = CombatSystem.resolveMove(input, fighter);
  if (move) {
    fighter.startAttack(move);
    return;
  }

  fighter.velocity.y += GC.GRAVITY;

  if (fighter.position.y <= GC.GROUND_Y && fighter.velocity.y <= 0) {
    fighter.position.y = GC.GROUND_Y;
    fighter.velocity.y = 0;
    fighter.velocity.x = 0;
    fighter.isGrounded = true;
    fighter.state = FIGHTER_STATE.LANDING;
    fighter.landingTimer = GC.LANDING_FRAMES;
    fighter.playAnimation('landing');
  }
}

export function handleRunState(fighter: Fighter, input: InputState): void {
  fighter.isBlocking = false;
  fighter.runFrames++;

  if (input.lpJust || input.rpJust || input.lkJust || input.rkJust) {
    const move = CombatSystem.resolveMove(input, fighter);
    if (move) {
      fighter.isRunning = false;
      fighter.startAttack(move);
      return;
    }
  }

  if (!input.forward || input.back) {
    fighter.isRunning = false;
    fighter.state = FIGHTER_STATE.IDLE;
    fighter.velocity.x = 0;
    fighter.playAnimation('combatIdle');
    return;
  }

  fighter.velocity.x = GC.RUN_SPEED * fighter.speedMult;
  // Re-sync sprint if something disrupted the animation externally (super transition, etc.)
  if (fighter.currentAnimKey !== 'sprint') {
    fighter.playAnimation('sprint');
  }
}

export function handleAttackState(fighter: Fighter, input: InputState): void {
  if (!fighter.currentMove) {
    fighter.state = FIGHTER_STATE.IDLE;
    fighter.playAnimation('combatIdle');
    return;
  }

  // Keep gravity running during aerial attacks; stick to ground but let the
  // move finish so the full animation plays before transitioning to landing.
  if (!fighter.isGrounded) {
    fighter.velocity.y += GC.GRAVITY;
    if (fighter.position.y <= GC.GROUND_Y && fighter.velocity.y <= 0) {
      fighter.position.y = GC.GROUND_Y;
      fighter.velocity.y = 0;
      fighter.isGrounded = true;
    }
  }

  fighter.moveFrame++;
  const totalFrames =
    fighter.currentMove.startupFrames +
    fighter.currentMove.activeFrames +
    fighter.currentMove.recoveryFrames;

  if (fighter.currentMove.forwardLunge && fighter.moveFrame <= fighter.currentMove.startupFrames) {
    fighter.velocity.x = fighter.currentMove.forwardLunge;
  } else if (
    fighter.moveFrame >
    fighter.currentMove.startupFrames + fighter.currentMove.activeFrames
  ) {
    fighter.velocity.x *= 0.9;
  }

  if (
    fighter.moveFrame >=
    fighter.currentMove.startupFrames + fighter.currentMove.activeFrames - 2
  ) {
    const comboMove = CombatSystem.resolveComboInput(input, fighter);
    if (comboMove) {
      fighter.startAttack(comboMove, true);
      return;
    }
  }

  if (fighter.moveFrame >= totalFrames) {
    fighter.currentMove = null;
    fighter.moveFrame = 0;
    fighter.hasHitThisMove = false;
    fighter.velocity.x = 0;
    if (!fighter.isGrounded) {
      fighter.state = FIGHTER_STATE.FALLING;
      fighter.playAnimation('falling');
    } else {
      fighter.state = FIGHTER_STATE.IDLE;
      fighter.playAnimation('combatIdle');
    }
  }
}

export function handleStunState(fighter: Fighter, input?: InputState): void {
  fighter.stunFrames--;
  if (fighter.stunFrames <= 0) {
    fighter.velocity.x = 0;
    fighter.state = FIGHTER_STATE.IDLE;
    if (input?.block) {
      fighter.isBlocking = true;
      fighter.playAnimation('block');
    } else {
      fighter.isBlocking = false;
      fighter.playAnimation('combatIdle');
    }
  }
  fighter.velocity.x *= GC.PUSHBACK_DECAY;
}

export function handleJuggleState(fighter: Fighter): void {
  fighter.velocity.y += GC.JUGGLE_GRAVITY;
  fighter.velocity.x *= 0.98;

  if (fighter.position.y <= GC.GROUND_Y && fighter.velocity.y <= 0) {
    fighter.position.y = GC.GROUND_Y;
    fighter.velocity.y = 0;
    fighter.velocity.x = 0;
    fighter.state = FIGHTER_STATE.KNOCKDOWN;
    fighter.knockdownTimer = 40;
    fighter.playAnimation('juggleLand');
    fighter.comboTimer = 0;
  }
}

export function handleKnockdownState(fighter: Fighter): void {
  if (fighter.position.y > GC.GROUND_Y || fighter.velocity.y > 0) {
    fighter.velocity.y += GC.JUGGLE_GRAVITY;
    if (fighter.position.y <= GC.GROUND_Y && fighter.velocity.y <= 0) {
      fighter.position.y = GC.GROUND_Y;
      fighter.velocity.y = 0;
      fighter.velocity.x = 0;
      fighter.isGrounded = true;
    }
  }

  fighter.knockdownTimer--;
  if (fighter.knockdownTimer <= 0) {
    fighter.position.y = GC.GROUND_Y;
    fighter.velocity.y = 0;
    fighter.isGrounded = true;
    fighter.state = FIGHTER_STATE.GETUP;
    fighter.getupTimer = GC.GETUP_FRAMES;
    fighter.playAnimation('kipUp');
  }
}

export function handleGetupState(fighter: Fighter): void {
  fighter.getupTimer--;
  if (fighter.getupTimer <= 0) {
    fighter.state = FIGHTER_STATE.IDLE;
    fighter.playAnimation('combatIdle');
  }
}

export function handleSidestepState(fighter: Fighter): void {
  fighter.sideStepTimer--;
  fighter.velocity.z = fighter.sideStepDir * GC.SIDESTEP_SPEED * fighter.speedMult;

  const expectedAnim = fighter.sideStepDir < 0 ? 'dodgeLeft' : 'dodgeRight';
  if (fighter.currentAnimKey !== expectedAnim) {
    fighter.playAnimation(expectedAnim);
  }

  if (fighter.sideStepTimer <= 0) {
    fighter.velocity.z = 0;
    fighter.state = FIGHTER_STATE.IDLE;
    fighter.playAnimation('combatIdle');
  }
}

export function handleDashState(fighter: Fighter): void {
  fighter.dashTimer--;
  if (fighter.currentAnimKey !== 'runBack') {
    fighter.playAnimation('runBack');
  }
  if (fighter.dashTimer <= 0) {
    fighter.velocity.x = 0;
    fighter.state = FIGHTER_STATE.IDLE;
    fighter.playAnimation('combatIdle');
  }
}

export function handleLandingState(fighter: Fighter): void {
  fighter.landingTimer--;
  if (fighter.landingTimer <= 0) {
    fighter.state = FIGHTER_STATE.IDLE;
    fighter.playAnimation('combatIdle');
  }
}

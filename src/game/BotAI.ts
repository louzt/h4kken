// ============================================================
// H4KKEN - Bot AI
// Simple decision-loop CPU opponent
// ============================================================

import { FIGHTER_STATE } from '../constants';
import type { Fighter } from '../fighter/Fighter';
import type { InputState } from '../Input';

export class BotAI {
  private _decisionTimer = 0;
  private _attackCooldown = 0;
  private _heldInput: Partial<InputState> = {};

  getInput(bot: Fighter, opponent: Fighter): InputState {
    const input: InputState = emptyInput();

    // While being hit or blocking, hold back to block — don't try to act
    if (bot.state === FIGHTER_STATE.HIT_STUN || bot.state === FIGHTER_STATE.BLOCK_STUN) {
      input.left = true;
      this._decisionTimer = 20;
      return input;
    }

    // While attacking or in another committed state, don't inject new inputs
    if (
      bot.state === FIGHTER_STATE.ATTACKING ||
      bot.state === FIGHTER_STATE.KNOCKDOWN ||
      bot.state === FIGHTER_STATE.GETUP ||
      bot.state === FIGHTER_STATE.LANDING ||
      bot.state === FIGHTER_STATE.JUGGLE
    ) {
      return input;
    }

    // Tick down timers
    if (this._decisionTimer > 0) {
      this._decisionTimer--;
      if (this._heldInput.right) input.right = true;
      if (this._heldInput.left) input.left = true;
      if (this._heldInput.down) input.down = true;
      return input;
    }
    if (this._attackCooldown > 0) this._attackCooldown--;

    // Make a new decision
    const dx = opponent.position.x - bot.position.x;
    const dz = opponent.position.z - bot.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const rand = Math.random();

    this._heldInput = {};

    if (dist > 3.5) {
      // Too far — approach steadily
      this._heldInput.right = true;
      input.right = true;
      this._decisionTimer = 25;
    } else if (dist > 2.0) {
      // Mid range — approach or probe
      if (rand < 0.55) {
        this._heldInput.right = true;
        input.right = true;
        this._decisionTimer = 20;
      } else if (rand < 0.7 && this._attackCooldown <= 0) {
        input.lpJust = true;
        input.lp = true;
        this._attackCooldown = 45;
        this._decisionTimer = 30;
      } else {
        this._decisionTimer = 15;
      }
    } else {
      // Close range — commit to a move or reposition
      if (rand < 0.28 && this._attackCooldown <= 0) {
        input.lpJust = true;
        input.lp = true;
        this._attackCooldown = 45;
        this._decisionTimer = 30;
      } else if (rand < 0.45 && this._attackCooldown <= 0) {
        input.rpJust = true;
        input.rp = true;
        this._attackCooldown = 50;
        this._decisionTimer = 35;
      } else if (rand < 0.55 && this._attackCooldown <= 0) {
        input.lkJust = true;
        input.lk = true;
        this._attackCooldown = 45;
        this._decisionTimer = 30;
      } else if (rand < 0.65) {
        this._heldInput.left = true;
        input.left = true;
        this._decisionTimer = 20;
      } else if (rand < 0.75) {
        this._heldInput.down = true;
        input.down = true;
        this._decisionTimer = 18;
      } else {
        this._decisionTimer = 20;
      }
    }

    return input;
  }
}

function emptyInput(): InputState {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    block: false,
    lp: false,
    rp: false,
    lk: false,
    rk: false,
    upJust: false,
    downJust: false,
    leftJust: false,
    rightJust: false,
    lpJust: false,
    rpJust: false,
    lkJust: false,
    rkJust: false,
    dashLeft: false,
    dashRight: false,
    sideStepUp: false,
    sideStepDown: false,
    superJust: false,
  };
}

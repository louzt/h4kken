// ============================================================
// H4KKEN - Bot AI
// Aggressive CPU opponent with spacing awareness and combos.
//
// DIRECTION NOTE: velocity is rotated by facingAngle before being
// applied to world position (Fighter.ts ~line 882). This means
// "right" (forward, +velocity.x) always moves toward the opponent
// and "left" (back, -velocity.x) always moves away — for BOTH
// fighters regardless of which side they started on. Never use the
// world-space dx sign to pick left/right here.
// ============================================================

import { FIGHTER_STATE, GAME_CONSTANTS } from '../constants';
import type { Fighter } from '../fighter/Fighter';
import type { InputState } from '../Input';

const GC = GAME_CONSTANTS;

export class BotAI {
  private _decisionTimer = 0;
  private _attackCooldown = 0;
  private _heldInput: Partial<InputState> = {};
  private _comboStep = 0;
  private _comboTimer = 0;
  // Delay before activating super — randomised 1-2 s so it doesn't feel scripted
  private _superDelay = 0;

  getInput(bot: Fighter, opponent: Fighter): InputState {
    const input: InputState = emptyInput();

    // Super power — wait a random 60-120 frames (1-2 s) after meter fills
    if (bot.superMeter >= GC.SUPER_MAX && !bot.superPowerActive && !bot._pendingSuperActivation) {
      if (this._superDelay === 0) {
        this._superDelay = 60 + Math.floor(Math.random() * 61);
      }
      if (--this._superDelay <= 0) {
        this._superDelay = 0;
        input.superJust = true;
        return input;
      }
    } else if (bot.superMeter < GC.SUPER_MAX) {
      this._superDelay = 0;
    }

    // Let attack/knockdown/landing animations finish uninterrupted
    if (
      bot.state === FIGHTER_STATE.ATTACKING ||
      bot.state === FIGHTER_STATE.KNOCKDOWN ||
      bot.state === FIGHTER_STATE.GETUP ||
      bot.state === FIGHTER_STATE.LANDING ||
      bot.state === FIGHTER_STATE.JUGGLE
    ) {
      return input;
    }

    if (bot.state === FIGHTER_STATE.HIT_STUN || bot.state === FIGHTER_STATE.BLOCK_STUN) {
      input.block = true;
      this._decisionTimer = 8;
      this._heldInput = {};
      return input;
    }

    if (this._comboStep > 0 && this._comboTimer > 0) {
      this._comboTimer--;
      return this._driveCombo(input);
    }
    this._comboStep = 0;

    if (this._attackCooldown > 0) this._attackCooldown--;

    if (this._decisionTimer > 0) {
      this._decisionTimer--;
      if (this._heldInput.right) input.right = true;
      if (this._heldInput.left) input.left = true;
      if (this._heldInput.up) input.up = true;
      if (this._heldInput.down) input.down = true;
      if (this._heldInput.block) input.block = true;
      return input;
    }

    const dx = opponent.position.x - bot.position.x;
    const dz = opponent.position.z - bot.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    this._heldInput = {};

    // While super is active: relentless rush — dash in and spam attacks, no caution.
    if (bot.superPowerActive) return this._decidePowerMode(input, dist, dz);

    if (this._shouldBlock(opponent, dist)) {
      input.block = true;
      this._heldInput.block = true;
      return input;
    }

    // Attack reach: offset + hitboxSize + defHalfW ≈ 1.6 (LP) to 1.9 (RK) units.
    // Thresholds match real hitbox math so attacks actually land.
    if (dist > 4.0) return this._decideFar(input);
    if (dist > 1.6) return this._decideMid(input, dz);
    return this._decideClose(input, dz);
  }

  private _shouldBlock(opponent: Fighter, dist: number): boolean {
    if (opponent.state === FIGHTER_STATE.ATTACKING && Math.random() < 0.7) {
      this._decisionTimer = 14;
      return true;
    }
    const rushing =
      dist < 3.0 &&
      (opponent.state === FIGHTER_STATE.RUN ||
        opponent.state === FIGHTER_STATE.WALK_FORWARD ||
        opponent.state === FIGHTER_STATE.JUMP_FORWARD);
    if (rushing && Math.random() < 0.45) {
      this._decisionTimer = 10;
      return true;
    }
    return false;
  }

  // Super active: close distance instantly and attack every opportunity
  private _decidePowerMode(input: InputState, dist: number, dz: number): InputState {
    if (dist > 1.6) {
      // Sprint in — dashRight enters RUN, right also set so handleRunState
      // never sees !forward on the re-evaluation frame and cancels the run.
      input.dashRight = true;
      input.right = true;
      this._heldInput.right = true;
      this._decisionTimer = 40;
      return input;
    }
    // In range — attack on every available frame, no cooldown hesitation
    if (this._attackCooldown <= 0) {
      const r = Math.random();
      if (r < 0.35) {
        input.lpJust = true;
        input.lp = true;
        this._comboStep = 1;
        this._comboTimer = 14;
        this._attackCooldown = 12;
        this._decisionTimer = 4;
      } else if (r < 0.6) {
        input.rpJust = true;
        input.rp = true;
        this._attackCooldown = 12;
        this._decisionTimer = 6;
      } else if (r < 0.8) {
        input.lkJust = true;
        input.lk = true;
        this._attackCooldown = 12;
        this._decisionTimer = 6;
      } else {
        input.rkJust = true;
        input.rk = true;
        this._attackCooldown = 14;
        this._decisionTimer = 8;
      }
    } else {
      // Cooldown ticking — stay on top, nudge Z if needed
      if (Math.abs(dz) > 0.5) {
        if (dz > 0) input.sideStepDown = true;
        else input.sideStepUp = true;
        this._decisionTimer = 3;
      } else {
        input.right = true;
        this._heldInput.right = true;
        this._decisionTimer = 3;
      }
    }
    return input;
  }

  private _decideFar(input: InputState): InputState {
    const rand = Math.random();
    if (rand < 0.5) {
      // Dash forward — dashRight starts RUN state, held right keeps it running
      input.dashRight = true;
      this._heldInput.right = true;
      this._decisionTimer = 18;
    } else if (rand < 0.8) {
      // Run toward opponent
      input.right = true;
      this._heldInput.right = true;
      this._decisionTimer = 14;
    } else if (rand < 0.92) {
      // Jump forward to close distance and add pressure
      input.upJust = true;
      input.up = true;
      this._heldInput.up = true;
      input.right = true;
      this._heldInput.right = true;
      this._decisionTimer = 10;
    } else {
      input.sideStepUp = Math.random() < 0.5;
      input.sideStepDown = !input.sideStepUp;
      this._decisionTimer = 6;
    }
    return input;
  }

  // Approach range (1.6–4.0): attacks won't land here, focus on closing fast
  private _decideMid(input: InputState, dz: number): InputState {
    const rand = Math.random();
    if (rand < 0.5) {
      // Run in — most common action in this range
      input.right = true;
      this._heldInput.right = true;
      this._decisionTimer = 12;
    } else if (rand < 0.75) {
      // Dash run
      input.dashRight = true;
      this._heldInput.right = true;
      this._decisionTimer = 14;
    } else if (rand < 0.88) {
      // Jump in
      input.upJust = true;
      input.up = true;
      this._heldInput.up = true;
      input.right = true;
      this._heldInput.right = true;
      this._decisionTimer = 10;
    } else {
      // Align Z so attacks connect on arrival
      if (dz > 0) input.sideStepDown = true;
      else input.sideStepUp = true;
      this._decisionTimer = 6;
    }
    return input;
  }

  private _decideClose(input: InputState, dz: number): InputState {
    const rand = Math.random();
    if (rand < 0.4 && this._attackCooldown <= 0) {
      // LP combo starter (4-hit chain)
      input.lpJust = true;
      input.lp = true;
      this._comboStep = 1;
      this._comboTimer = 14;
      this._attackCooldown = 22;
      this._decisionTimer = 5;
    } else if (rand < 0.58 && this._attackCooldown <= 0) {
      input.rpJust = true;
      input.rp = true;
      this._attackCooldown = 18;
      this._decisionTimer = 10;
    } else if (rand < 0.72 && this._attackCooldown <= 0) {
      input.lkJust = true;
      input.lk = true;
      this._attackCooldown = 18;
      this._decisionTimer = 10;
    } else if (rand < 0.83 && this._attackCooldown <= 0) {
      input.rkJust = true;
      input.rk = true;
      this._attackCooldown = 24;
      this._decisionTimer = 12;
    } else if (rand < 0.9) {
      // Retreat + block — left = backward = away from opponent
      input.left = true;
      this._heldInput.left = true;
      input.block = true;
      this._heldInput.block = true;
      this._decisionTimer = 10;
    } else if (rand < 0.97) {
      // Sidestep to track opponent's Z position
      if (dz > 0) input.sideStepDown = true;
      else input.sideStepUp = true;
      this._decisionTimer = 6;
    } else {
      // Dash back to reset spacing — dashLeft = dashBack = away
      input.dashLeft = true;
      this._decisionTimer = 8;
    }
    return input;
  }

  // 4-hit combo: LP → RP → LK → RK
  private _driveCombo(input: InputState): InputState {
    switch (this._comboStep) {
      case 1:
        if (this._comboTimer === 9) {
          input.rpJust = true;
          input.rp = true;
          this._comboStep = 2;
          this._comboTimer = 13;
        }
        break;
      case 2:
        if (this._comboTimer === 7) {
          input.lkJust = true;
          input.lk = true;
          this._comboStep = 3;
          this._comboTimer = 11;
        }
        break;
      case 3:
        if (this._comboTimer === 5) {
          input.rkJust = true;
          input.rk = true;
          this._comboStep = 0;
          this._comboTimer = 0;
        }
        break;
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

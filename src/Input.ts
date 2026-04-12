// ============================================================
// H4KKEN - Input Manager
// Tap W/S = sidestep, Hold W = jump, Hold S = crouch
// ============================================================

export interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  block: boolean;
  lp: boolean;
  rp: boolean;
  lk: boolean;
  rk: boolean;
  upJust: boolean;
  downJust: boolean;
  leftJust: boolean;
  rightJust: boolean;
  lpJust: boolean;
  rpJust: boolean;
  lkJust: boolean;
  rkJust: boolean;
  forward?: boolean;
  back?: boolean;
  forwardJust?: boolean;
  backJust?: boolean;
  sideStepUp?: boolean;
  sideStepDown?: boolean;
  dashLeft?: boolean;
  dashRight?: boolean;
  dashForward?: boolean;
  dashBack?: boolean;
  superJust?: boolean;
}

export class InputManager {
  keys: Record<string, boolean>;
  previousKeys: Record<string, boolean>;
  inputBuffer: InputState[];
  bufferSize: number;

  lastTapTime: { left: number; right: number; up: number; down: number };
  doubleTapWindow: number;

  holdThreshold: number;
  upHeldFrames: number;
  downHeldFrames: number;
  upConsumed: boolean;
  downConsumed: boolean;

  frameCount: number;

  constructor() {
    this.keys = {};
    this.previousKeys = {};
    this.inputBuffer = [];
    this.bufferSize = 10;

    this.lastTapTime = { left: 0, right: 0, up: 0, down: 0 };
    this.doubleTapWindow = 12;

    this.holdThreshold = 8;
    this.upHeldFrames = 0;
    this.downHeldFrames = 0;
    this.upConsumed = false;
    this.downConsumed = false;

    this.frameCount = 0;

    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  onKeyDown(e: KeyboardEvent) {
    if (e.repeat) return;
    this.keys[e.code] = true;
  }

  onKeyUp(e: KeyboardEvent) {
    this.keys[e.code] = false;
  }

  getInput(): InputState {
    return {
      up: this.isPressed('KeyW') || this.isPressed('ArrowUp'),
      down: this.isPressed('KeyS') || this.isPressed('ArrowDown'),
      left: this.isPressed('KeyA') || this.isPressed('ArrowLeft'),
      right: this.isPressed('KeyD') || this.isPressed('ArrowRight'),
      block: this.isPressed('Space'),
      lp: this.isPressed('KeyU'),
      rp: this.isPressed('KeyI'),
      lk: this.isPressed('KeyJ'),
      rk: this.isPressed('KeyK'),
      upJust: this.justPressed('KeyW') || this.justPressed('ArrowUp'),
      downJust: this.justPressed('KeyS') || this.justPressed('ArrowDown'),
      leftJust: this.justPressed('KeyA') || this.justPressed('ArrowLeft'),
      rightJust: this.justPressed('KeyD') || this.justPressed('ArrowRight'),
      lpJust: this.justPressed('KeyU'),
      rpJust: this.justPressed('KeyI'),
      lkJust: this.justPressed('KeyJ'),
      rkJust: this.justPressed('KeyK'),
      superJust: this.justPressed('KeyQ'),
    };
  }

  getRelativeInput(rawInput: InputState, facing: number): InputState {
    const rel: InputState = { ...rawInput };
    if (facing > 0) {
      rel.forward = rawInput.right;
      rel.back = rawInput.left;
      rel.forwardJust = rawInput.rightJust;
      rel.backJust = rawInput.leftJust;
    } else {
      rel.forward = rawInput.left;
      rel.back = rawInput.right;
      rel.forwardJust = rawInput.leftJust;
      rel.backJust = rawInput.rightJust;
    }
    return rel;
  }

  isPressed(code: string) {
    return !!this.keys[code];
  }

  justPressed(code: string) {
    return !!this.keys[code] && !this.previousKeys[code];
  }

  setKey(code: string, down: boolean) {
    this.keys[code] = down;
  }

  update(): InputState {
    const input: InputState = this.getInput();
    this.frameCount++;

    // ── Tap-vs-Hold for W (up) ──
    if (input.up) {
      this.upHeldFrames++;
      if (this.upHeldFrames >= this.holdThreshold && !this.upConsumed) {
        input.upJust = true;
        this.upConsumed = true;
      }
      if (this.upHeldFrames < this.holdThreshold) {
        input.upJust = false;
      }
    } else {
      if (this.upHeldFrames > 0 && this.upHeldFrames < this.holdThreshold && !this.upConsumed) {
        input.sideStepUp = true;
      }
      this.upHeldFrames = 0;
      this.upConsumed = false;
    }

    if (this.upHeldFrames > 0 && this.upHeldFrames < this.holdThreshold) {
      input.up = false;
    }

    // ── Tap-vs-Hold for S (down) ──
    if (input.down) {
      this.downHeldFrames++;
      if (this.downHeldFrames < this.holdThreshold) {
        input.down = false;
        input.downJust = false;
      }
    } else {
      if (
        this.downHeldFrames > 0 &&
        this.downHeldFrames < this.holdThreshold &&
        !this.downConsumed
      ) {
        input.sideStepDown = true;
      }
      this.downHeldFrames = 0;
      this.downConsumed = false;
    }

    // ── Double-tap dash detection ──
    if (input.leftJust) {
      if (this.frameCount - this.lastTapTime.left < this.doubleTapWindow) {
        input.dashLeft = true;
      }
      this.lastTapTime.left = this.frameCount;
    }
    if (input.rightJust) {
      if (this.frameCount - this.lastTapTime.right < this.doubleTapWindow) {
        input.dashRight = true;
      }
      this.lastTapTime.right = this.frameCount;
    }

    this.inputBuffer.push({ ...input });
    if (this.inputBuffer.length > this.bufferSize) {
      this.inputBuffer.shift();
    }

    this.previousKeys = { ...this.keys };

    return input;
  }

  checkMotion(motionSequence: string[], buttonCheck: (input: InputState) => boolean) {
    if (this.inputBuffer.length < motionSequence.length + 1) return false;
    const recentInputs = this.inputBuffer.slice(-(motionSequence.length + 1));
    let motionIdx = 0;
    for (let i = 0; i < recentInputs.length - 1 && motionIdx < motionSequence.length; i++) {
      const inp = recentInputs[i];
      const dir = motionSequence[motionIdx];
      if (inp === undefined || dir === undefined) continue;
      if (this.matchDirection(inp, dir)) {
        motionIdx++;
      }
    }
    const lastInput = recentInputs[recentInputs.length - 1];
    if (lastInput === undefined) return false;
    return motionIdx >= motionSequence.length && buttonCheck(lastInput);
  }

  matchDirection(input: InputState, dir: string) {
    switch (dir) {
      case 'down':
        return input.down && !input.forward && !input.back;
      case 'forward':
        return input.forward && !input.down;
      case 'back':
        return input.back && !input.down;
      case 'df':
        return input.down && input.forward;
      case 'db':
        return input.down && input.back;
      default:
        return false;
    }
  }

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}

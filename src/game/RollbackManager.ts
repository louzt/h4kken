import type { FighterSnapshot } from '../fighter/Fighter';
import type { InputState } from '../Input';

interface GameSnapshot {
  f1: FighterSnapshot;
  f2: FighterSnapshot;
  roundTimer: number;
  roundTimerAccum: number;
}

// Callback interface so RollbackManager can drive replay without importing Game
export interface RollbackHost {
  readonly frame: number;
  setFrame(f: number): void;
  snapshotGame(): GameSnapshot;
  restoreGame(snap: GameSnapshot): void;
  runSimStep(p1Input: InputState, p2Input: InputState): void;
  setReplaying(v: boolean): void;
}

// 30 frames ≈ 500ms at 60fps — handles VPN/high-latency play (avg lag ~17f) with ~12f headroom
const MAX_ROLLBACK = 30;

export interface RollbackDiag {
  // Filled by RollbackManager
  rollbacks: number;
  rollbackDepthSum: number;
  mispredictions: number;
  predictionsTotal: number;
  inputLagFramesSum: number; // sum of (localFrame - remoteFrame) at arrival time
  inputLagCount: number;
  // Filled by Game
  stallFrames: number;
  framesAdvanced: number;
  simStepMs: number;
  simStepCount: number;
}

export function makeDiag(): RollbackDiag {
  return {
    rollbacks: 0,
    rollbackDepthSum: 0,
    mispredictions: 0,
    predictionsTotal: 0,
    inputLagFramesSum: 0,
    inputLagCount: 0,
    stallFrames: 0,
    framesAdvanced: 0,
    simStepMs: 0,
    simStepCount: 0,
  };
}

export class RollbackManager {
  private localIndex: 0 | 1;

  // Frame → snapshot (ring buffer kept for MAX_ROLLBACK frames)
  private snapshots = new Map<number, GameSnapshot>();

  // Frame → confirmed input per player
  private localInputs = new Map<number, InputState>();
  private remoteInputs = new Map<number, InputState>();

  // Frame → predicted input that was used for remote player
  private predictedInputs = new Map<number, InputState>();

  private lastConfirmedRemote: InputState | null = null;
  lastConfirmedRemoteFrame = -1;
  // Track how many consecutive frames we've been stalling (for UI hysteresis)
  stallFrameCount = 0;

  diag: RollbackDiag = makeDiag();

  constructor(localPlayerIndex: 0 | 1) {
    this.localIndex = localPlayerIndex;
  }

  hasLocalInput(frame: number): boolean {
    return this.localInputs.has(frame);
  }

  addLocalInput(frame: number, input: InputState) {
    // Don't overwrite if already stored — avoids sending duplicates during a stall
    if (this.localInputs.has(frame)) return;
    this.localInputs.set(frame, input);
  }

  receiveRemoteInput(frame: number, input: InputState, host: RollbackHost) {
    this.remoteInputs.set(frame, input);
    this.lastConfirmedRemote = input;
    if (frame > this.lastConfirmedRemoteFrame) {
      this.lastConfirmedRemoteFrame = frame;
    }

    // How many frames late did this input arrive? (positive = we're ahead of remote)
    const lag = host.frame - frame;
    if (lag >= 0) {
      this.diag.inputLagFramesSum += lag;
      this.diag.inputLagCount++;
    }

    // Check if we predicted this frame and got it wrong
    const predicted = this.predictedInputs.get(frame);
    if (predicted && frame < host.frame) {
      this.diag.predictionsTotal++;
      if (!inputsEqual(predicted, input)) {
        this.diag.mispredictions++;
        this.performRollback(frame, host);
      }
      this.predictedInputs.delete(frame);
    }
  }

  // Returns [p1Input, p2Input] for the given frame.
  // Uses confirmed inputs where available, predicts remote if missing.
  getInputsForFrame(frame: number): [InputState, InputState] | null {
    const local = this.localInputs.get(frame);
    if (!local) return null;

    let remote = this.remoteInputs.get(frame);
    if (!remote) {
      // Predict: repeat last confirmed input (held buttons only)
      remote = this.lastConfirmedRemote ? stripMomentary(this.lastConfirmedRemote) : neutralInput();
      this.predictedInputs.set(frame, remote);
    }

    return this.localIndex === 0 ? [local, remote] : [remote, local];
  }

  saveSnapshot(frame: number, host: RollbackHost) {
    this.snapshots.set(frame, host.snapshotGame());
  }

  shouldStall(currentFrame: number): boolean {
    // Don't stall until we've heard from the remote at least once — avoids false
    // stalls during the connection handshake / countdown phase when inputs haven't
    // started flowing yet.
    if (this.lastConfirmedRemoteFrame < 0) return false;
    const stalling = currentFrame - this.lastConfirmedRemoteFrame > MAX_ROLLBACK;
    this.stallFrameCount = stalling ? this.stallFrameCount + 1 : 0;
    return stalling;
  }

  private performRollback(toFrame: number, host: RollbackHost) {
    const snap = this.snapshots.get(toFrame);
    if (!snap) return;

    const currentFrame = host.frame;
    const depth = currentFrame - toFrame;
    this.diag.rollbacks++;
    this.diag.rollbackDepthSum += depth;

    // 1. Restore state to the mispredicted frame
    host.restoreGame(snap);
    host.setFrame(toFrame);

    // 2. Replay all frames with corrected inputs (visual effects suppressed)
    host.setReplaying(true);
    for (let f = toFrame; f < currentFrame; f++) {
      this.saveSnapshot(f, host);
      const inputs = this.getInputsForFrame(f);
      if (!inputs) break;
      host.runSimStep(inputs[0], inputs[1]);
      host.setFrame(f + 1);
    }
    host.setReplaying(false);
  }

  prune(beforeFrame: number) {
    for (const map of [this.snapshots, this.localInputs, this.remoteInputs, this.predictedInputs]) {
      for (const key of map.keys()) {
        if (key < beforeFrame) map.delete(key);
      }
    }
  }

  reset() {
    this.snapshots.clear();
    this.localInputs.clear();
    this.remoteInputs.clear();
    this.predictedInputs.clear();
    this.lastConfirmedRemote = null;
    this.lastConfirmedRemoteFrame = -1;
    this.stallFrameCount = 0;
  }
}

function neutralInput(): InputState {
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

// Strip one-frame triggers — prediction assumes held buttons continue
function stripMomentary(input: InputState): InputState {
  return {
    ...input,
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

function inputsEqual(a: InputState, b: InputState): boolean {
  return (
    a.up === b.up &&
    a.down === b.down &&
    a.left === b.left &&
    a.right === b.right &&
    a.block === b.block &&
    a.lp === b.lp &&
    a.rp === b.rp &&
    a.lk === b.lk &&
    a.rk === b.rk &&
    a.upJust === b.upJust &&
    a.downJust === b.downJust &&
    a.leftJust === b.leftJust &&
    a.rightJust === b.rightJust &&
    a.lpJust === b.lpJust &&
    a.rpJust === b.rpJust &&
    a.lkJust === b.lkJust &&
    a.rkJust === b.rkJust &&
    a.dashLeft === b.dashLeft &&
    a.dashRight === b.dashRight &&
    a.sideStepUp === b.sideStepUp &&
    a.sideStepDown === b.sideStepDown &&
    a.superJust === b.superJust
  );
}

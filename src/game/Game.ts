// ============================================================
// H4KKEN - Game Manager (Main Game Loop, State, Round Logic)
// Babylon.js
// ============================================================

import {
  type AbstractEngine,
  Color3,
  DefaultRenderingPipeline,
  Engine,
  FreeCamera,
  HardwareScalingOptimization,
  ImageProcessingConfiguration,
  ParticlesOptimization,
  PostProcessesOptimization,
  Scene,
  SceneOptimizer,
  SceneOptimizerOptions,
  ShadowsOptimization,
  Vector3,
  WebGPUEngine,
} from '@babylonjs/core';
import { AudioManager, BgmManager } from '../Audio';
import { FightCamera } from '../Camera';
import { CharSelect } from '../CharSelect';
import { CombatSystem } from '../combat/CombatSystem';
import { GAME_CONSTANTS } from '../constants';
import { CHARACTERS, DEFAULT_P1, DEFAULT_P2 } from '../fighter/characters';
import { Fighter, type SharedAssets } from '../fighter/Fighter';
import { InputManager, type InputState } from '../Input';
import { isTouchDevice, MobileControls, requestLandscapeFullscreen } from '../MobileControls';
import { Network } from '../Network';
import { Stage } from '../Stage';
import { UI } from '../UI';
import { BotAI } from './BotAI';
import { EffectsManager } from './EffectsManager';
import { setupNetworkEvents } from './NetworkEvents';
import type { RollbackHost } from './RollbackManager';
import { makeDiag, type RollbackDiag, RollbackManager } from './RollbackManager';

const GC = GAME_CONSTANTS;

const GAME_STATE = {
  LOADING: 'loading',
  MENU: 'menu',
  CHAR_SELECT: 'charSelect',
  WAITING: 'waiting',
  COUNTDOWN: 'countdown',
  FIGHTING: 'fighting',
  ROUND_END: 'roundEnd',
  MATCH_END: 'matchEnd',
  PRACTICE: 'practice',
};

export class Game {
  state: string;
  canvas: HTMLCanvasElement;
  engine: AbstractEngine;
  scene: Scene;
  camera: FreeCamera;
  input: InputManager;
  fightCamera: FightCamera;
  stage: Stage | null;
  ui: UI;
  network: Network;
  fighters: [Fighter | null, Fighter | null];
  localPlayerIndex: number;
  allCharAssets: Map<string, SharedAssets>;
  charSelect: CharSelect | null = null;
  _pendingMode: 'practice' | 'online' = 'practice';
  _pendingCharId: string = DEFAULT_P1;
  round: number;
  roundTimer: number;
  roundTimerAccum: number;
  isPractice: boolean;
  effects: EffectsManager;
  tickRate: number;
  tickDuration: number;
  frame: number;
  private _simWorker: Worker | null = null;
  rollbackManager: RollbackManager | null;
  private _stallShown = false;
  _isReplaying = false;
  // Diagnostics: accumulated per 5-second window then printed and reset
  private _diag: RollbackDiag = makeDiag();
  private _diagWindowStart = 0;
  private _diagRenderFrames = 0;
  private static readonly DIAG_INTERVAL_FRAMES = 300; // ~5s at 60fps
  audio: AudioManager;
  bgm: BgmManager;
  onResize: () => void;
  _roundResetting: boolean;
  _nextRoundTimeout: ReturnType<typeof setTimeout> | null;
  _lastAnnouncedRound: number;
  _mobileControls: MobileControls | null = null;
  private _pipeline: DefaultRenderingPipeline | null = null;
  private botAI = new BotAI();

  static async create(): Promise<Game> {
    const canvasEl = document.getElementById('game-canvas');
    if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('No canvas element found');
    const engine = await Game._makeEngine(canvasEl);
    return new Game(canvasEl, engine);
  }

  private static async _makeEngine(canvas: HTMLCanvasElement): Promise<AbstractEngine> {
    const mobile = isTouchDevice();
    const antialias = !mobile;
    const options = { antialias, audioEngine: true, powerPreference: 'high-performance' as const };
    // scalingLevel > 1 reduces rendered pixels (faster); < 1 would supersample (slower).
    // On mobile, render at CSS pixel size regardless of device pixel ratio — the browser
    // upscales from there. dpr/2 gives a mild downscale on high-dpi devices (dpr=3 → 1.5).
    const scalingLevel = mobile ? Math.max(1, window.devicePixelRatio / 2) : 1;

    // Skip WebGPU on iOS — Safari claims support but Babylon.js WebGPU has known issues there.
    const isIOS = /iP(hone|ad|od)/i.test(navigator.userAgent);
    if (!isIOS && (await WebGPUEngine.IsSupportedAsync)) {
      const gpu = new WebGPUEngine(canvas, options);
      await gpu.initAsync();
      if (scalingLevel !== 1) gpu.setHardwareScalingLevel(scalingLevel);
      return gpu;
    }
    const eng = new Engine(canvas, antialias, options);
    if (scalingLevel !== 1) eng.setHardwareScalingLevel(scalingLevel);
    return eng;
  }

  private constructor(canvasEl: HTMLCanvasElement, engine: AbstractEngine) {
    this.state = GAME_STATE.LOADING;
    this.canvas = canvasEl;
    this.engine = engine;
    this.engine.setSize(window.innerWidth, window.innerHeight);

    this.scene = new Scene(this.engine);
    this.scene.ambientColor = new Color3(0.1, 0.1, 0.1);
    // No raycasting on mouse-move — the game has no pointer-over mesh interactions.
    this.scene.skipPointerMovePicking = true;
    // The sky sphere covers every pixel every frame — redundant to clear the background first.
    this.scene.autoClear = false;
    this.scene.autoClearDepthAndStencil = false;

    this.camera = new FreeCamera('camera', new Vector3(0, 3, -10), this.scene);
    this.camera.inputs.clear(); // prevent FreeCamera from hijacking WASD/arrow keys
    this.camera.minZ = 0.1;
    this.camera.maxZ = 100;
    this.camera.fov = 0.785; // ~45 degrees in radians

    // Bloom via DefaultRenderingPipeline — stored so SceneOptimizer can disable it.
    // Bloom is skipped on mobile from frame 1: it's the single most expensive effect
    // and the optimizer would kill it within 2s anyway on any struggling device.
    this._pipeline = new DefaultRenderingPipeline('pipeline', true, this.scene, [this.camera]);
    this._pipeline.bloomEnabled = !isTouchDevice();
    this._pipeline.bloomThreshold = 0.82;
    this._pipeline.bloomWeight = 0.35;
    this._pipeline.bloomKernel = 64;
    this._pipeline.bloomScale = 0.5;

    // ACES tone mapping + slight contrast boost — kills the washed-out plastic look
    const imgProc = this.scene.imageProcessingConfiguration;
    imgProc.toneMappingEnabled = true;
    imgProc.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    imgProc.exposure = 1.0;
    imgProc.contrast = 1.2;

    this.input = new InputManager();
    this.fightCamera = new FightCamera(this.camera);
    this.stage = null;
    this.ui = new UI();
    this.network = new Network();
    this.audio = new AudioManager();
    this.bgm = new BgmManager();

    this.fighters = [null, null];
    this.localPlayerIndex = 0;
    this.allCharAssets = new Map<string, SharedAssets>();

    this.round = 1;
    this.roundTimer = GC.ROUND_TIME;
    this.roundTimerAccum = 0;
    this.isPractice = false;
    this._roundResetting = false;
    this._nextRoundTimeout = null;
    this._lastAnnouncedRound = -1;

    this.effects = new EffectsManager(this.scene);

    this.tickRate = 60;
    this.tickDuration = 1 / this.tickRate;
    this.frame = 0;
    this.rollbackManager = null;

    this._stallShown = false;

    this.onResize = this._onResize.bind(this);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', () => {
      // Brief delay — OS needs a moment to finish rotating before we can measure
      setTimeout(() => this.engine.resize(), 200);
    });

    if (isTouchDevice()) {
      this._mobileControls = new MobileControls(this.input);
    }

    this.setupUIEvents();
    setupNetworkEvents(this);
  }

  setupUIEvents() {
    this.ui.btnFindMatch?.addEventListener('click', () => {
      if (isTouchDevice()) requestLandscapeFullscreen();
      this.startCharSelect('online');
    });
    this.ui.btnPractice?.addEventListener('click', () => {
      if (isTouchDevice()) requestLandscapeFullscreen();
      this.startCharSelect('practice');
    });
    this.ui.btnControls?.addEventListener('click', () => this.ui.showScreen('controls-screen'));
    this.ui.btnBackControls?.addEventListener('click', () => this.ui.showScreen('menu-screen'));
    this.ui.btnCancelSearch?.addEventListener('click', () => this.cancelSearch());
  }

  async init() {
    this.ui.setLoadingText('Loading assets...');

    this.stage = new Stage(this.scene);

    const charEntries = Object.values(CHARACTERS);
    let loaded = 0;
    for (const meta of charEntries) {
      const assets = await Fighter.loadAssets(this.scene, meta.id, (p: number) => {
        this.ui.setLoadingProgress((loaded + p) / charEntries.length);
      });
      assets.scale = meta.scale;
      this.allCharAssets.set(meta.id, assets);
      loaded++;
    }

    await this.audio.load(this.scene);
    // Not awaited — MP3 decoding is slow on mobile; menu shows while tracks load.
    this.bgm.load(this.scene);

    this.charSelect = new CharSelect(this.scene, this.camera, this.allCharAssets);
    this.createFighters();

    this.ui.setLoadingProgress(1);
    this.ui.setLoadingText('Ready!');

    try {
      await this.network.connect();
    } catch (_e) {
      console.warn('Could not connect to server. Only practice mode available.');
    }

    setTimeout(() => {
      this.state = GAME_STATE.MENU;
      this.ui.showScreen('menu-screen');
      this._startQualityMonitor();
    }, 500);

    // Render loop (rAF-based) — pauses when the tab is hidden, which is fine.
    this.engine.runRenderLoop(() => this._gameLoop());

    // Simulation heartbeat — runs in a Web Worker so it keeps firing even when
    // the tab is not focused. Each message = one fixed 60fps sim tick.
    this._simWorker = new Worker(new URL('./SimWorker.ts', import.meta.url), { type: 'module' });
    this._simWorker.onmessage = () => this._onSimTick();
  }

  createFighters() {
    this.reinitFighter(0, DEFAULT_P1);
    this.reinitFighter(1, DEFAULT_P2);
  }

  reinitFighter(idx: 0 | 1, charId: string) {
    const assets = this.allCharAssets.get(charId) ?? this.allCharAssets.get(DEFAULT_P1);
    if (!assets) return;
    this.fighters[idx]?.dispose();
    const fighter = new Fighter(idx, this.scene);
    fighter.init(assets);
    this.fighters[idx] = fighter;
    const shadowGen = this.stage?.shadowGenerator;
    if (shadowGen) {
      for (const mesh of fighter.meshes) shadowGen.addShadowCaster(mesh, true);
    }
  }

  startCharSelect(mode: 'practice' | 'online') {
    this.state = GAME_STATE.CHAR_SELECT;
    this._pendingMode = mode;
    for (const f of this.fighters) f?.rootNode?.setEnabled(false);
    this.ui.hideAllScreens();

    if (mode === 'online') {
      if (!this.network.connected) {
        this.ui.showAnnouncement('NOT CONNECTED', 'Server unavailable', 2000);
        this.state = GAME_STATE.MENU;
        this.ui.showScreen('menu-screen');
        return;
      }
      this._pendingCharId = DEFAULT_P1;
      const name = this.ui.playerNameInput?.value || 'Player';
      this.network.joinMatch(name, this._pendingCharId);
    }

    this.charSelect?.show(mode, {
      onConfirm: (p1Id, p2Id) => this._onCharSelectConfirm(p1Id, p2Id),
      onPick: (charId) => {
        this._pendingCharId = charId;
        this.network.sendPick(charId);
      },
      onReady: () => {
        this.network.sendReady();
      },
      onBack: () => {
        if (mode === 'online') this.network.leave();
        this.charSelect?.hide();
        for (const f of this.fighters) f?.rootNode?.setEnabled(true);
        this.state = GAME_STATE.MENU;
        this.ui.showScreen('menu-screen');
      },
    });
  }

  private _onCharSelectConfirm(p1Id: string, p2Id: string) {
    this.charSelect?.hide();
    if (this._pendingMode === 'practice') {
      this.reinitFighter(0, p1Id);
      this.reinitFighter(1, p2Id);
      this.startPractice();
    }
  }

  prepareMatch() {
    if (this._nextRoundTimeout !== null) {
      clearTimeout(this._nextRoundTimeout);
      this._nextRoundTimeout = null;
    }
    this.round = 0;
    this._roundResetting = false;
    this._lastAnnouncedRound = -1;
    this.fighters[0]?.reset(-3);
    this.fighters[1]?.reset(3);
    if (this.fighters[0]) this.fighters[0].wins = 0;
    if (this.fighters[1]) this.fighters[1].wins = 0;
    this.roundTimer = GC.ROUND_TIME;
    this.roundTimerAccum = 0;
    this.ui.updateHealth(
      this.fighters[this.localPlayerIndex]?.health ?? 0,
      this.fighters[1 - this.localPlayerIndex]?.health ?? 0,
      GC.MAX_HEALTH,
    );
    this.ui.updateWins(0, 0, GC.ROUNDS_TO_WIN);
    this.ui.updateTimer(this.roundTimer);
    setTimeout(() => this.playBGM(), 1000);
    this.fightCamera.reset();
    this.frame = 0;
    if (!this.isPractice) {
      this.rollbackManager = new RollbackManager(this.localPlayerIndex as 0 | 1);
      console.log(`[SYNC] Rollback netcode active (RTT=${this.network.rtt}ms)`);
    } else {
      this.rollbackManager = null;
    }
    this._diag = makeDiag();
    this._diagWindowStart = performance.now();
    this._diagRenderFrames = 0;
    this.state = GAME_STATE.COUNTDOWN;
  }

  findMatch(characterId: string) {
    const name = this.ui.playerNameInput?.value || 'Player';
    if (!this.network.connected) {
      this.ui.showAnnouncement('NOT CONNECTED', 'Server unavailable', 2000);
      return;
    }
    this.network.joinMatch(name, characterId);
    this.state = GAME_STATE.WAITING;
  }

  cancelSearch() {
    this.network.leave();
    for (const f of this.fighters) f?.rootNode?.setEnabled(true);
    this.state = GAME_STATE.MENU;
    this.ui.showScreen('menu-screen');
  }

  startPractice() {
    this.isPractice = true;
    this.localPlayerIndex = 0;
    const name = this.ui.playerNameInput?.value || 'Player';
    this.ui.setPlayerNames(name, 'CPU');
    this.ui.hideAllScreens();
    this.ui.showFightHud();
    this._mobileControls?.show();
    this.prepareMatch();
    this.round = 1;
    this.startPracticeCountdown();
  }

  async startPracticeCountdown() {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    this.state = GAME_STATE.COUNTDOWN;
    const roundSfx =
      this.round === 1
        ? 'announce_round1'
        : this.round === 2
          ? 'announce_round2'
          : 'announce_finalround';

    this.ui.showAnnouncement(`ROUND ${this.round}`, '', 1100);
    this.audio.play(roundSfx, 0.63);
    if (this.round === 1) this._startIntroAnimations();

    await sleep(1600);
    this.ui.showAnnouncement('3', '', 900, 'countdown');
    this.audio.play('count_3', 0.63);

    await sleep(900);
    this.ui.showAnnouncement('2', '', 900, 'countdown');
    this.audio.play('count_2', 0.63);

    await sleep(900);
    this.ui.showAnnouncement('1', '', 900, 'countdown');
    this.audio.play('count_1', 0.63);

    await sleep(900);
    this.ui.showAnnouncement('FIGHT!', '', 1000);
    this.audio.play('announce_fight', 0.63);
    this.fighters[0]?.cancelIntro();
    this.fighters[1]?.cancelIntro();
    this.state = GAME_STATE.FIGHTING;
    this._roundResetting = false;
  }

  _startIntroAnimations() {
    const f0 = this.fighters[0];
    const f1 = this.fighters[1];
    if (!f0 || !f1) return;
    const anim0 = f0.playIntroAnimation();
    f1.playIntroAnimationExcluding(anim0);
  }

  // ============================================================
  // GAME LOOP
  // ============================================================

  // Render-only loop (runs via requestAnimationFrame, pauses when tab is hidden).
  // Simulation is driven separately by _onSimTick via the worker heartbeat.
  private _gameLoop() {
    if (this.rollbackManager && this.state === GAME_STATE.FIGHTING) {
      this._diagRenderFrames++;
    }
    const deltaTime = this.engine.getDeltaTime() / 1000;
    this.render(deltaTime);
    this.scene.render();
  }

  // One fixed sim tick, fired by the Web Worker heartbeat at 60fps.
  // Continues running when the tab loses focus (unlike rAF).
  private _onSimTick() {
    if (this.isPractice || !this.rollbackManager) {
      this._fixedUpdatePractice();
      this.frame++;
    } else {
      this._advanceWithRollback();
    }
  }

  // Practice / legacy path: immediate input, no network sync
  private _fixedUpdatePractice() {
    const rawInput = this.input.update();
    if (this.state !== GAME_STATE.FIGHTING && this.state !== GAME_STATE.PRACTICE) return;

    const f1 = this.fighters[0];
    const f2 = this.fighters[1];
    if (!f1 || !f2) return;

    const p2Input = this.botAI.getInput(f2, f1);
    this._runSimulationStep(rawInput, p2Input);
  }

  // Rollback multiplayer: capture input, predict opponent, advance, rollback on misprediction
  private _advanceWithRollback() {
    const rawInput = this.input.update();
    const rm = this.rollbackManager;
    if (this.state !== GAME_STATE.FIGHTING || !rm) return;

    // addLocalInput is idempotent (no-op if already stored), so safe to call every tick.
    // sendSyncInput only fires on the first write for this frame number.
    const isNewFrame = !rm.hasLocalInput(this.frame);
    rm.addLocalInput(this.frame, rawInput);
    if (isNewFrame) this.network.sendSyncInput(this.frame, rawInput);

    // ── Soft frame advantage (GGPO-style) ──
    // Run at most softAdv frames ahead of the last confirmed remote input.
    // Derive from current RTT so low-latency sessions get shallow rollback depth.
    // Min 3 (jitter buffer), max 8 (won't approach MAX_ROLLBACK=30 on normal links).
    const rttFrames = this.network.rtt / 16.67;
    const softAdv = Math.max(3, Math.min(8, Math.ceil(rttFrames) + 2));
    if (rm.lastConfirmedRemoteFrame >= 0 && this.frame - rm.lastConfirmedRemoteFrame > softAdv) {
      return;
    }

    // Check if we've exhausted the rollback window (opponent too far behind).
    // Show SYNCING only after stalling for >12 consecutive frames (~200ms) to
    // avoid visual flicker from brief network jitter.
    const stalling = rm.shouldStall(this.frame);
    const showStall = rm.stallFrameCount > 12;
    if (showStall !== this._stallShown) {
      this._stallShown = showStall;
      this.ui.showStallIndicator(showStall);
    }
    if (stalling) {
      this._diag.stallFrames++;
      return;
    }

    // Save snapshot, then advance with confirmed or predicted inputs
    rm.saveSnapshot(this.frame, this._rollbackHost);
    const inputs = rm.getInputsForFrame(this.frame);
    if (!inputs) return;

    const t0 = performance.now();
    this._runSimulationStep(inputs[0], inputs[1]);
    this._diag.simStepMs += performance.now() - t0;
    this._diag.simStepCount++;
    this._diag.framesAdvanced++;
    this.frame++;

    if (this.frame % 60 === 0) rm.prune(this.frame - 120);

    // Merge rollback manager diag into our window accumulator, then report every 5s
    if (this.frame % Game.DIAG_INTERVAL_FRAMES === 0) {
      this._flushDiag(rm);
    }
  }

  private _flushDiag(rm: RollbackManager) {
    const d = this._diag;
    const rd = rm.diag;
    const windowMs = performance.now() - this._diagWindowStart;
    const fps = this._diagRenderFrames / (windowMs / 1000);

    const avgLag =
      rd.inputLagCount > 0 ? (rd.inputLagFramesSum / rd.inputLagCount).toFixed(1) : '–';
    const avgDepth = rd.rollbacks > 0 ? (rd.rollbackDepthSum / rd.rollbacks).toFixed(1) : '0';
    const mispredPct =
      rd.predictionsTotal > 0 ? Math.round((rd.mispredictions / rd.predictionsTotal) * 100) : 0;
    const avgSim = d.simStepCount > 0 ? (d.simStepMs / d.simStepCount).toFixed(2) : '–';

    // Only log when something is actually wrong — silent on a clean connection
    if (d.stallFrames > 0 || rd.mispredictions > 0) {
      console.warn(
        `[NET] fps=${fps.toFixed(0)} rtt=${this.network.rtt}ms` +
          ` | remoteLag=${avgLag}f avg` +
          ` | stalls=${d.stallFrames}f` +
          ` | rollbacks=${rd.rollbacks} depth=${avgDepth}f` +
          ` | mispred=${mispredPct}%/${rd.predictionsTotal}` +
          ` | simStep=${avgSim}ms`,
      );
    }

    // Reset window
    this._diag = makeDiag();
    rm.diag = makeDiag();
    this._diagWindowStart = performance.now();
    this._diagRenderFrames = 0;
  }

  // Start Babylon.js SceneOptimizer — progressively degrades visual quality
  // until FPS target is met. Called once after asset load. Custom options skip
  // MergeMeshesOptimization (would break animated fighter skeletons).
  //
  // Mobile path skips PostProcessesOptimization entirely: bloom is already off
  // and PostProcessesOptimization would also kill ACES tone mapping, leaving a
  // washed-out image with no remaining visual benefit.
  //
  // Hardware scaling cap: desktop=1.5 (67% CSS res), mobile=1.25 (80% CSS res).
  // The old cap of 2.0 rendered at 25–33% native pixels on high-dpi phones —
  // genuinely worse than PS1 quality. If we can't hit 45fps after bloom+shadow
  // removal, a small resolution nudge is all that's left; the bottleneck at
  // that point is CPU/JS, not GPU fillrate, so bigger scaling doesn't help.
  private _startQualityMonitor(): void {
    const mobile = isTouchDevice();
    const options = new SceneOptimizerOptions(40, 1000); // target 40fps, check every 1s
    if (!mobile) {
      // Desktop: bloom is on, kill it first. On mobile it's already off.
      options.optimizations.push(new PostProcessesOptimization(0));
      options.optimizations.push(new ShadowsOptimization(1));
      options.optimizations.push(new ParticlesOptimization(2));
      options.optimizations.push(new HardwareScalingOptimization(3, 1.5, 0.25));
    } else {
      // Mobile: bloom already off. Kill shadows first, then particles, then
      // a small resolution nudge as absolute last resort.
      options.optimizations.push(new ShadowsOptimization(0));
      options.optimizations.push(new ParticlesOptimization(1));
      options.optimizations.push(new HardwareScalingOptimization(2, 1.25, 0.25));
    }
    new SceneOptimizer(this.scene, options);
  }

  // RollbackHost adapter — lets RollbackManager drive replay without circular deps
  get _rollbackHost(): RollbackHost {
    const game = this;
    return {
      get frame() {
        return game.frame;
      },
      setFrame(f: number) {
        game.frame = f;
      },
      snapshotGame() {
        const f1 = game.fighters[0];
        const f2 = game.fighters[1];
        if (!f1 || !f2) throw new Error('Cannot snapshot: fighters not loaded');
        return {
          f1: f1.snapshotSim(),
          f2: f2.snapshotSim(),
          roundTimer: game.roundTimer,
          roundTimerAccum: game.roundTimerAccum,
        };
      },
      restoreGame(snap) {
        game.fighters[0]?.restoreSim(snap.f1);
        game.fighters[1]?.restoreSim(snap.f2);
        game.roundTimer = snap.roundTimer;
        game.roundTimerAccum = snap.roundTimerAccum;
      },
      runSimStep(p1: InputState, p2: InputState) {
        game._runSimulationStep(p1, p2);
      },
      setReplaying(v: boolean) {
        game._isReplaying = v;
      },
    };
  }

  // Core simulation step shared by practice, multiplayer, and rollback replay.
  // During replay (_isReplaying), visual/audio side effects are suppressed.
  _runSimulationStep(p1Input: InputState, p2Input: InputState) {
    const f1 = this.fighters[0];
    const f2 = this.fighters[1];
    if (!f1 || !f2) return;

    f1.processInput(p1Input, f2.position);
    f2.processInput(p2Input, f1.position);

    for (const fighter of this.fighters) {
      if (!fighter?._pendingSuperActivation || fighter.superPowerActive) continue;
      fighter._pendingSuperActivation = false;
      fighter.applyServerSuperActivation();
    }

    const f1Active = f1.isAttackActive();
    const f2Active = f2.isAttackActive();
    if (f1Active) this.resolveCombat(f1, f2);
    if (f2Active) this.resolveCombat(f2, f1);

    this.resolveFighterCollision(f1, f2);

    f1.updatePhysics();
    f2.updatePhysics();

    if (this.state === GAME_STATE.FIGHTING) {
      this.roundTimerAccum += this.tickDuration;
      if (this.roundTimerAccum >= 1.0) {
        this.roundTimerAccum -= 1.0;
        this.roundTimer--;
        if (!this._isReplaying) this.ui.updateTimer(this.roundTimer);
        if (this.roundTimer <= 0 && !this._isReplaying) this.onTimeUp();
      }
    }

    if (this.state === GAME_STATE.FIGHTING && !this._isReplaying) {
      if (f1.health <= 0 || f2.health <= 0) {
        this.onKO(f1.health <= 0 ? 1 : 0);
      }
    }

    if (!this._isReplaying) this._updateHud(f1, f2);
  }

  private _updateHud(f1: Fighter, f2: Fighter) {
    const local = this.localPlayerIndex === 0 ? f1 : f2;
    const remote = this.localPlayerIndex === 0 ? f2 : f1;
    this.ui.updateHealth(local.health, remote.health, GC.MAX_HEALTH);
    this.ui.updateSuper(local.superMeter, remote.superMeter, GC.SUPER_MAX);
    this.ui.setPowerMode(local.superPowerActive, remote.superPowerActive);

    // Keep BGM in sync with super state. Polling here (not events) is reliable
    // because rollback replay skips audio triggers but _updateHud only runs on
    // non-replay ticks, so it always sees the settled post-rollback fighter state.
    this.bgm.crossfadeTo(f1.superPowerActive || f2.superPowerActive ? 'power' : 'main');

    if (remote.comboCount >= 2 && remote.comboTimer > 0) {
      this.ui.updateCombo(0, remote.comboCount, remote.comboDamage);
    } else {
      this.ui.hideCombo(0);
    }
    if (local.comboCount >= 2 && local.comboTimer > 0) {
      this.ui.updateCombo(1, local.comboCount, local.comboDamage);
    } else {
      this.ui.hideCombo(1);
    }
  }

  resolveCombat(attacker: Fighter, defender: Fighter) {
    if (!attacker.isAttackActive()) return;
    if (!attacker.currentMove) return;
    const move = attacker.currentMove;

    const hit = CombatSystem.checkHitbox(
      attacker.position,
      attacker.facingAngle,
      move,
      defender.position,
    );

    if (!hit) return;

    const result = CombatSystem.resolveHit(attacker, defender, move);

    if (result.type === 'whiff') {
      attacker.hasHitThisMove = true;
      return;
    }

    attacker.hasHitThisMove = true;

    if (result.type === 'hit') {
      defender.onHit(result, attacker.facingAngle);
      if (!this._isReplaying) {
        this.ui.showHitEffect();
        this.fightCamera.shake(0.15, 0.15);
        this.effects.spawnHitSpark(defender.position, attacker.facingAngle);
        const sfx = move.damage <= 12 ? 'hit_light' : 'hit_heavy';
        this.audio.playAt(sfx, defender.position);
      }
    } else if (result.type === 'blocked') {
      defender.onHit(result, attacker.facingAngle);
      if (!this._isReplaying) {
        this.ui.showBlockEffect();
        this.fightCamera.shake(0.05, 0.1);
        this.effects.spawnBlockSpark(defender.position);
        this.audio.playAt('block', defender.position);
      }
    }
  }

  resolveFighterCollision(f1: Fighter, f2: Fighter) {
    const dx = f2.position.x - f1.position.x;
    const dz = f2.position.z - f1.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const minDist = 1.0;

    if (dist < minDist && dist > 0) {
      const overlap = (minDist - dist) / 2;
      const nx = dx / dist;
      const nz = dz / dist;
      f1.position.x -= nx * overlap;
      f1.position.z -= nz * overlap;
      f2.position.x += nx * overlap;
      f2.position.z += nz * overlap;
    }
  }

  // ============================================================
  // ROUND MANAGEMENT
  // ============================================================

  onKO(winnerIdx: number) {
    this.state = GAME_STATE.ROUND_END;
    const winner = this.fighters[winnerIdx];
    const loser = this.fighters[winnerIdx === 0 ? 1 : 0];
    if (!winner || !loser) return;

    winner.wins++;
    const matchOver = winner.wins >= GC.ROUNDS_TO_WIN;
    const victoryAnim = winner.setVictory();
    const defeatAnim = loser.setDefeat(undefined, matchOver);

    this.fightCamera.setDramaticAngle(winner.position);
    this.fightCamera.shake(0.3, 0.3);

    this.audio.play('ko_bell', 0.9);

    this.ui.showAnnouncement('K.O.', '', 2000, 'ko');
    this.ui.updateWins(
      this.fighters[this.localPlayerIndex]?.wins ?? 0,
      this.fighters[1 - this.localPlayerIndex]?.wins ?? 0,
      GC.ROUNDS_TO_WIN,
    );

    // Both clients detect KO at the same sim frame — both send round result
    if (!this.isPractice) {
      this.network.sendRoundResult(
        winnerIdx,
        this.fighters[0]?.wins ?? 0,
        this.fighters[1]?.wins ?? 0,
        matchOver,
        victoryAnim,
        defeatAnim,
      );
    }

    if (matchOver) {
      setTimeout(() => this.onMatchEnd(winnerIdx), 2500);
    } else if (this.isPractice) {
      this._nextRoundTimeout = setTimeout(() => this.startNextRound(), 3000);
    }
    // In multiplayer the server drives the next countdown via 'countdown' events
  }

  onTimeUp() {
    this.state = GAME_STATE.ROUND_END;

    const f1 = this.fighters[0];
    const f2 = this.fighters[1];
    if (!f1 || !f2) return;
    let winnerIdx: number;

    if (f1.health > f2.health) {
      winnerIdx = 0;
    } else if (f2.health > f1.health) {
      winnerIdx = 1;
    } else {
      if (!this.isPractice) {
        this.network.sendRoundResult(-1, f1.wins, f2.wins, false, 'idle', 'idle');
      }
      this.ui.showAnnouncement('DRAW', 'TIME UP', 2000);
      if (this.isPractice) {
        this._nextRoundTimeout = setTimeout(() => this.startNextRound(), 3000);
      }
      return;
    }

    const winner = winnerIdx === 0 ? f1 : f2;
    const loser = winnerIdx === 0 ? f2 : f1;
    winner.wins++;
    const matchOver = winner.wins >= GC.ROUNDS_TO_WIN;
    const victoryAnim = winner.setVictory();
    const defeatAnim = loser.setDefeat(undefined, matchOver);

    this.audio.play('announce_time', 0.63);
    this.ui.showAnnouncement('TIME UP', '', 2000);
    this.ui.updateWins(
      this.fighters[this.localPlayerIndex]?.wins ?? 0,
      this.fighters[1 - this.localPlayerIndex]?.wins ?? 0,
      GC.ROUNDS_TO_WIN,
    );

    if (!this.isPractice) {
      this.network.sendRoundResult(
        winnerIdx,
        this.fighters[0]?.wins ?? 0,
        this.fighters[1]?.wins ?? 0,
        matchOver,
        victoryAnim,
        defeatAnim,
      );
    }

    if (matchOver) {
      setTimeout(() => this.onMatchEnd(winnerIdx), 2500);
    } else if (this.isPractice) {
      this._nextRoundTimeout = setTimeout(() => this.startNextRound(), 3000);
    }
    // In multiplayer the server drives the next countdown via 'countdown' events
  }

  onMatchEnd(winnerIdx: number) {
    this.state = GAME_STATE.MATCH_END;
    this.stopBGM();
    if (winnerIdx === this.localPlayerIndex) {
      this.audio.play('announce_youwin', 0.63);
      this.ui.showAnnouncement('YOU WIN!', '', 0, 'victory');
    } else {
      this.ui.showAnnouncement('YOU LOSE', '', 0, 'victory');
    }

    setTimeout(() => {
      this.ui.hideAnnouncement();
      this.ui.hideFightHud();
      this.ui.showScreen('menu-screen');
      this._mobileControls?.hide();
      this.state = GAME_STATE.MENU;
      this.isPractice = false;
      this.fightCamera.reset();
    }, 4000);
  }

  startNextRound() {
    if (this._roundResetting) return;
    this._roundResetting = true;

    this.round++;
    this.fighters[0]?.reset(-3);
    this.fighters[1]?.reset(3);
    this.roundTimer = GC.ROUND_TIME;
    this.roundTimerAccum = 0;
    this.ui.updateTimer(this.roundTimer);
    this.ui.updateHealth(GC.MAX_HEALTH, GC.MAX_HEALTH, GC.MAX_HEALTH);
    this.ui.updateSuper(0, 0, GC.SUPER_MAX);
    this.ui.setPowerMode(false, false);
    this.bgm.crossfadeTo('main');
    this.fightCamera.reset();

    // Reset input sync state for the new round
    this.frame = 0;
    if (this.rollbackManager) {
      this.rollbackManager.reset();
    }

    if (this.isPractice) {
      this.startPracticeCountdown();
    }
  }

  // ============================================================
  // RENDER
  // ============================================================

  render(deltaTime: number) {
    if (this.state !== GAME_STATE.CHAR_SELECT) {
      const f1 = this.fighters[0];
      const f2 = this.fighters[1];

      if (f1) f1.updateVisuals();
      if (f2) f2.updateVisuals();

      if (f1 && f2) {
        this.fightCamera.update(f1.position, f2.position, deltaTime, this.localPlayerIndex);
      }
    }

    if (this.stage) this.stage.update(deltaTime);
    this.effects.update();
  }

  private _onResize() {
    this.engine.resize();
  }

  playBGM() {
    this.bgm.play();
  }

  stopBGM() {
    this.bgm.stop();
  }
}

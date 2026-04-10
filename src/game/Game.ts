// ============================================================
// H4KKEN - Game Manager (Main Game Loop, State, Round Logic)
// Babylon.js
// ============================================================

import {
  Color3,
  DefaultRenderingPipeline,
  Engine,
  FreeCamera,
  ImageProcessingConfiguration,
  Scene,
  Vector3,
} from '@babylonjs/core';
import { AudioManager, BgmManager } from '../Audio';
import { FightCamera } from '../Camera';
import { CombatSystem } from '../combat/CombatSystem';
import { GAME_CONSTANTS } from '../constants';
import { Fighter, type SharedAssets } from '../fighter/Fighter';
import { InputManager, type InputState } from '../Input';
import { Network } from '../Network';
import { Stage } from '../Stage';
import { UI } from '../UI';
import { BotAI } from './BotAI';
import { EffectsManager } from './EffectsManager';
import { setupNetworkEvents } from './NetworkEvents';
import type { RollbackHost } from './RollbackManager';
import { RollbackManager } from './RollbackManager';

const GC = GAME_CONSTANTS;

const GAME_STATE = {
  LOADING: 'loading',
  MENU: 'menu',
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
  engine: Engine;
  scene: Scene;
  camera: FreeCamera;
  input: InputManager;
  fightCamera: FightCamera;
  stage: Stage | null;
  ui: UI;
  network: Network;
  fighters: [Fighter | null, Fighter | null];
  localPlayerIndex: number;
  sharedAssets: SharedAssets | null;
  round: number;
  roundTimer: number;
  roundTimerAccum: number;
  isPractice: boolean;
  effects: EffectsManager;
  tickRate: number;
  tickDuration: number;
  accumulator: number;
  frame: number;
  rollbackManager: RollbackManager | null;
  private _stallShown = false;
  _isReplaying = false;
  audio: AudioManager;
  bgm: BgmManager;
  onResize: () => void;
  _roundResetting: boolean;
  _nextRoundTimeout: ReturnType<typeof setTimeout> | null;
  _lastAnnouncedRound: number;
  private botAI = new BotAI();

  constructor() {
    this.state = GAME_STATE.LOADING;

    const canvasEl = document.getElementById('game-canvas');
    if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('No canvas element found');
    this.canvas = canvasEl;

    this.engine = new Engine(this.canvas, true, { antialias: true, audioEngine: true });
    this.engine.setSize(window.innerWidth, window.innerHeight);

    this.scene = new Scene(this.engine);
    this.scene.ambientColor = new Color3(0.1, 0.1, 0.1);

    this.camera = new FreeCamera('camera', new Vector3(0, 3, -10), this.scene);
    this.camera.inputs.clear(); // prevent FreeCamera from hijacking WASD/arrow keys
    this.camera.minZ = 0.1;
    this.camera.maxZ = 100;
    this.camera.fov = 0.785; // ~45 degrees in radians

    // Bloom via DefaultRenderingPipeline
    const pipeline = new DefaultRenderingPipeline('pipeline', true, this.scene, [this.camera]);
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.82;
    pipeline.bloomWeight = 0.35;
    pipeline.bloomKernel = 64;
    pipeline.bloomScale = 0.5;

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
    this.sharedAssets = null;

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
    this.accumulator = 0;
    this.frame = 0;
    this.rollbackManager = null;

    this._stallShown = false;

    this.onResize = this._onResize.bind(this);
    window.addEventListener('resize', this.onResize);

    this.setupUIEvents();
    setupNetworkEvents(this);
  }

  setupUIEvents() {
    this.ui.btnFindMatch?.addEventListener('click', () => this.findMatch());
    this.ui.btnPractice?.addEventListener('click', () => this.startPractice());
    this.ui.btnControls?.addEventListener('click', () => this.ui.showScreen('controls-screen'));
    this.ui.btnBackControls?.addEventListener('click', () => this.ui.showScreen('menu-screen'));
    this.ui.btnCancelSearch?.addEventListener('click', () => this.cancelSearch());
  }

  async init() {
    this.ui.setLoadingText('Loading assets...');

    this.stage = new Stage(this.scene);

    this.sharedAssets = await Fighter.loadAssets(this.scene, (progress: number) => {
      this.ui.setLoadingProgress(progress);
    });

    await this.audio.load(this.scene);
    await this.bgm.load(this.scene);

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
    }, 500);

    // Babylon render loop — replaces requestAnimationFrame
    this.engine.runRenderLoop(() => this._gameLoop());
  }

  createFighters() {
    if (!this.sharedAssets) throw new Error('SharedAssets not loaded');

    this.fighters[0] = new Fighter(0, this.scene);
    this.fighters[0].init(this.sharedAssets);

    this.fighters[1] = new Fighter(1, this.scene);
    this.fighters[1].init(this.sharedAssets);

    const onDeactivate = () => {
      if (!this.fighters[0]?.superPowerActive && !this.fighters[1]?.superPowerActive) {
        this.bgm.crossfadeTo('main');
      }
    };
    this.fighters[0].onSuperDeactivate = onDeactivate;
    this.fighters[1].onSuperDeactivate = onDeactivate;

    // Register fighter meshes as shadow casters so they cast onto the arena floor
    const shadowGen = this.stage?.shadowGenerator;
    if (shadowGen) {
      for (const fighter of this.fighters) {
        if (!fighter) continue;
        for (const mesh of fighter.meshes) {
          shadowGen.addShadowCaster(mesh, true);
        }
      }
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
    this.state = GAME_STATE.COUNTDOWN;
  }

  findMatch() {
    const name = this.ui.playerNameInput?.value || 'Player';
    if (!this.network.connected) {
      this.ui.showAnnouncement('NOT CONNECTED', 'Server unavailable', 2000);
      return;
    }
    this.network.joinMatch(name);
    this.state = GAME_STATE.WAITING;
  }

  cancelSearch() {
    this.network.leave();
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
    this.prepareMatch();
    this.round = 1;
    this.startPracticeCountdown();
  }

  startPracticeCountdown() {
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
    setTimeout(() => {
      this.ui.showAnnouncement('3', '', 900, 'countdown');
      this.audio.play('count_3', 0.63);
      setTimeout(() => {
        this.ui.showAnnouncement('2', '', 900, 'countdown');
        this.audio.play('count_2', 0.63);
        setTimeout(() => {
          this.ui.showAnnouncement('1', '', 900, 'countdown');
          this.audio.play('count_1', 0.63);
          setTimeout(() => {
            this.ui.showAnnouncement('FIGHT!', '', 1000);
            this.audio.play('announce_fight', 0.63);
            // Ensure both fighters are in idle before handing control back
            this.fighters[0]?.cancelIntro();
            this.fighters[1]?.cancelIntro();
            this.state = GAME_STATE.FIGHTING;
            this._roundResetting = false;
          }, 900);
        }, 900);
      }, 900);
    }, 1100);
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

  private _gameLoop() {
    const deltaTime = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    this.accumulator += deltaTime;

    while (this.accumulator >= this.tickDuration) {
      this.accumulator -= this.tickDuration;
      if (this.isPractice || !this.rollbackManager) {
        this._fixedUpdatePractice();
        this.frame++;
      } else {
        this._advanceWithRollback();
      }
    }

    this.render(deltaTime);
    this.scene.render();
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

    // Store local input and send to opponent immediately (no delay)
    rm.addLocalInput(this.frame, rawInput);
    this.network.sendSyncInput(this.frame, rawInput);

    // Check if we've exhausted the rollback window (opponent too far behind)
    const stalling = rm.shouldStall(this.frame);
    if (stalling !== this._stallShown) {
      this._stallShown = stalling;
      this.ui.showStallIndicator(stalling);
    }
    if (stalling) return;

    // Save snapshot, then advance with confirmed or predicted inputs
    rm.saveSnapshot(this.frame, this._rollbackHost);
    const inputs = rm.getInputsForFrame(this.frame);
    if (!inputs) return;

    this._runSimulationStep(inputs[0], inputs[1]);
    this.frame++;

    if (this.frame % 60 === 0) rm.prune(this.frame - 120);
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
      if (!this._isReplaying) this.bgm.crossfadeTo('power');
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
    }
    // No _nextRoundTimeout — server drives the next countdown
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
        this.network.sendRoundResult(-1, f1.wins, f2.wins, false, '', '');
      }
      this.ui.showAnnouncement('DRAW', 'TIME UP', 2000);
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
    }
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
    const f1 = this.fighters[0];
    const f2 = this.fighters[1];

    if (f1) f1.updateVisuals();
    if (f2) f2.updateVisuals();

    if (f1 && f2) {
      this.fightCamera.update(f1.position, f2.position, deltaTime, this.localPlayerIndex);
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

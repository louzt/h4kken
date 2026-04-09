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
  type Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import { FightCamera } from './Camera';
import { CombatSystem, FIGHTER_STATE, GAME_CONSTANTS } from './Combat';
import { Fighter, type SharedAssets } from './Fighter';
import { InputManager, type InputState } from './Input';
import { Network } from './Network';
import { Stage } from './Stage';
import { UI } from './UI';

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
  hitParticles: Mesh[];
  _sparkPool: Mesh[];
  _sparkGeo: Mesh;
  _hitMat0: StandardMaterial;
  _hitMat1: StandardMaterial;
  _blockMat: StandardMaterial;
  tickRate: number;
  tickDuration: number;
  accumulator: number;
  frame: number;
  pendingOpponentInput: InputState | null;
  lastOpponentInput: InputState;
  bgm: HTMLAudioElement;
  onResize: () => void;
  _roundResetting: boolean;

  constructor() {
    this.state = GAME_STATE.LOADING;

    const canvasEl = document.getElementById('game-canvas');
    if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('No canvas element found');
    this.canvas = canvasEl;

    this.engine = new Engine(this.canvas, true, { antialias: true });
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

    this.fighters = [null, null];
    this.localPlayerIndex = 0;
    this.sharedAssets = null;

    this.round = 1;
    this.roundTimer = GC.ROUND_TIME;
    this.roundTimerAccum = 0;
    this.isPractice = false;
    this._roundResetting = false;

    this.hitParticles = [];
    this._sparkPool = [];

    // Create a hidden template sphere for sparks — we clone it from the pool
    const sparkTemplate = MeshBuilder.CreateSphere(
      'sparkTemplate',
      { diameter: 0.06, segments: 2 },
      this.scene,
    );
    sparkTemplate.setEnabled(false);
    this._sparkGeo = sparkTemplate;

    this._hitMat0 = new StandardMaterial('hitMat0', this.scene);
    this._hitMat0.diffuseColor = new Color3(1, 0.4, 0);
    this._hitMat0.emissiveColor = new Color3(1, 0.4, 0);
    this._hitMat0.alpha = 1;

    this._hitMat1 = new StandardMaterial('hitMat1', this.scene);
    this._hitMat1.diffuseColor = new Color3(1, 0.8, 0);
    this._hitMat1.emissiveColor = new Color3(1, 0.8, 0);
    this._hitMat1.alpha = 1;

    this._blockMat = new StandardMaterial('blockMat', this.scene);
    this._blockMat.diffuseColor = new Color3(0.267, 0.533, 1);
    this._blockMat.emissiveColor = new Color3(0.267, 0.533, 1);
    this._blockMat.alpha = 1;

    this.tickRate = 60;
    this.tickDuration = 1 / this.tickRate;
    this.accumulator = 0;
    this.frame = 0;

    this.pendingOpponentInput = null;
    this.lastOpponentInput = this.emptyInput();

    this.bgm = new Audio('/assets/music/h4kken-theme.mp3');
    this.bgm.loop = true;
    this.bgm.volume = 0.5;

    this.onResize = this._onResize.bind(this);
    window.addEventListener('resize', this.onResize);

    this.setupUIEvents();
    this.setupNetworkEvents();
  }

  emptyInput(): InputState {
    return {
      up: false,
      down: false,
      left: false,
      right: false,
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
    };
  }

  setupUIEvents() {
    this.ui.btnFindMatch?.addEventListener('click', () => this.findMatch());
    this.ui.btnPractice?.addEventListener('click', () => this.startPractice());
    this.ui.btnControls?.addEventListener('click', () => this.ui.showScreen('controls-screen'));
    this.ui.btnBackControls?.addEventListener('click', () => this.ui.showScreen('menu-screen'));
    this.ui.btnCancelSearch?.addEventListener('click', () => this.cancelSearch());
  }

  setupNetworkEvents() {
    this.network.on('waiting', () => {
      this.ui.showScreen('waiting-screen');
    });

    this.network.on('matched', (msg) => {
      this.localPlayerIndex = msg.playerIndex;
      const myName = this.ui.playerNameInput?.value || 'Player';
      this.ui.setPlayerNames(myName, msg.opponentName);
      this.ui.hideAllScreens();
      this.ui.showFightHud();
      this.prepareMatch();
    });

    this.network.on('countdown', (msg) => {
      if (this.state !== GAME_STATE.ROUND_END && this.state !== GAME_STATE.COUNTDOWN) return;
      if (msg.count === 3) {
        this.startNextRound();
      }
      if (msg.count > 0) {
        this.ui.showAnnouncement(`ROUND ${this.round}`, msg.count.toString(), 900);
      }
      this.state = GAME_STATE.COUNTDOWN;
    });

    this.network.on('fight', () => {
      this.ui.showAnnouncement('FIGHT!', '', 1000);
      this.state = GAME_STATE.FIGHTING;
      this._roundResetting = false;
    });

    this.network.on('opponentInput', (msg) => {
      this.pendingOpponentInput = msg.input;
    });

    this.network.on('roundResult', (msg) => {
      if (this.state === GAME_STATE.FIGHTING) {
        this.state = GAME_STATE.ROUND_END;
        const winnerIdx = msg.winner;
        if (winnerIdx >= 0 && winnerIdx < 2) {
          const winner = this.fighters[winnerIdx];
          const loser = this.fighters[winnerIdx === 0 ? 1 : 0];
          if (!winner || !loser) return;
          winner.wins = winnerIdx === 0 ? msg.p1Wins : msg.p2Wins;
          loser.wins = winnerIdx === 0 ? msg.p2Wins : msg.p1Wins;
          winner.setVictory();
          loser.setDefeat();
          this.fightCamera.setDramaticAngle(winner.position);
          this.fightCamera.shake(0.3, 0.3);
          this.ui.showAnnouncement('K.O.', '', 2000, 'ko');
          this.ui.updateWins(
            this.fighters[this.localPlayerIndex]?.wins ?? 0,
            this.fighters[1 - this.localPlayerIndex]?.wins ?? 0,
            GC.ROUNDS_TO_WIN,
          );
        }
      }
    });

    this.network.on('gameState', (msg) => {
      if (this.localPlayerIndex === 1 && msg.state) {
        const { p1, p2 } = msg.state;
        if (p1 && this.fighters[0]) this.fighters[0].deserializeState(p1);
        if (p2 && this.fighters[1]) this.fighters[1].deserializeState(p2);
        if (msg.state.timer !== undefined) {
          this.roundTimer = msg.state.timer;
          this.ui.updateTimer(this.roundTimer);
        }
        if (msg.state.round !== undefined) {
          this.round = msg.state.round;
        }
      }
    });

    this.network.on('opponentLeft', () => {
      this.stopBGM();
      this.ui.showAnnouncement('OPPONENT LEFT', '', 3000);
      setTimeout(() => {
        this.state = GAME_STATE.MENU;
        this.ui.showScreen('menu-screen');
        this.ui.hideFightHud();
        this.ui.hideAnnouncement();
      }, 3000);
    });

    this.network.on('disconnected', () => {
      if (this.state !== GAME_STATE.MENU && this.state !== GAME_STATE.LOADING) {
        this.stopBGM();
        this.ui.showAnnouncement('DISCONNECTED', '', 3000);
        setTimeout(() => {
          this.state = GAME_STATE.MENU;
          this.ui.showScreen('menu-screen');
          this.ui.hideFightHud();
        }, 3000);
      }
    });
  }

  async init() {
    this.ui.setLoadingText('Loading assets...');

    this.stage = new Stage(this.scene);

    this.sharedAssets = await Fighter.loadAssets(this.scene, (progress: number) => {
      this.ui.setLoadingProgress(progress);
    });

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
    this.round = 1;
    this._roundResetting = false;
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
    this.startPracticeCountdown();
  }

  startPracticeCountdown() {
    let count = 3;
    const tick = () => {
      if (count > 0) {
        this.ui.showAnnouncement(`ROUND ${this.round}`, count.toString(), 900);
        count--;
        setTimeout(tick, 1000);
      } else {
        this.ui.showAnnouncement('FIGHT!', '', 1000);
        this.state = GAME_STATE.FIGHTING;
        this._roundResetting = false;
      }
    };
    this.state = GAME_STATE.COUNTDOWN;
    tick();
  }

  // ============================================================
  // GAME LOOP
  // ============================================================

  private _gameLoop() {
    // engine.getDeltaTime() returns ms; convert to seconds
    const deltaTime = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    this.accumulator += deltaTime;

    while (this.accumulator >= this.tickDuration) {
      this.fixedUpdate();
      this.accumulator -= this.tickDuration;
      this.frame++;
    }

    this.render(deltaTime);
    this.scene.render();
  }

  fixedUpdate() {
    const rawInput = this.input.update();

    if (this.state !== GAME_STATE.FIGHTING && this.state !== GAME_STATE.PRACTICE) return;

    const f1 = this.fighters[0];
    const f2 = this.fighters[1];
    if (!f1 || !f2) return;

    const [p1Input, p2Input] = this.buildInputs(rawInput);

    f1.processInput(p1Input, f2.position);
    f2.processInput(p2Input, f1.position);

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
        this.ui.updateTimer(this.roundTimer);

        if (this.roundTimer <= 0) {
          this.onTimeUp();
        }
      }
    }

    if (this.state === GAME_STATE.FIGHTING) {
      if (f1.health <= 0 || f2.health <= 0) {
        this.onKO(f1.health <= 0 ? 1 : 0);
      }
    }

    const local = this.localPlayerIndex === 0 ? f1 : f2;
    const remote = this.localPlayerIndex === 0 ? f2 : f1;
    this.ui.updateHealth(local.health, remote.health, GC.MAX_HEALTH);

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

    if (!this.isPractice && this.localPlayerIndex === 0 && this.frame % 6 === 0) {
      this.network.sendGameState(this.frame, {
        p1: f1.serializeState(),
        p2: f2.serializeState(),
        timer: this.roundTimer,
        round: this.round,
      });
    }
  }

  private buildInputs(rawInput: InputState): [InputState, InputState] {
    let p1Input: InputState;
    let p2Input: InputState;

    if (this.isPractice) {
      const f2 = this.fighters[1];
      const f1 = this.fighters[0];
      p1Input = rawInput;
      p2Input = f1 && f2 ? this.getSimpleBotInput(f2, f1) : this.emptyInput();
    } else {
      const opponentHeld = { ...this.lastOpponentInput };
      opponentHeld.upJust = false;
      opponentHeld.downJust = false;
      opponentHeld.leftJust = false;
      opponentHeld.rightJust = false;
      opponentHeld.lpJust = false;
      opponentHeld.rpJust = false;
      opponentHeld.lkJust = false;
      opponentHeld.rkJust = false;
      opponentHeld.dashLeft = false;
      opponentHeld.dashRight = false;
      opponentHeld.sideStepUp = false;
      opponentHeld.sideStepDown = false;

      const opInput = this.pendingOpponentInput || opponentHeld;
      if (this.pendingOpponentInput) {
        this.lastOpponentInput = { ...this.pendingOpponentInput };
        this.pendingOpponentInput = null;
      }

      if (this.localPlayerIndex === 0) {
        p1Input = rawInput;
        p2Input = opInput;
        this.network.sendInput(this.frame, this.serializeInput(rawInput));
      } else {
        p1Input = opInput;
        p2Input = rawInput;
        this.network.sendInput(this.frame, this.serializeInput(rawInput));
      }
    }

    return [p1Input, p2Input];
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
      this.ui.showHitEffect();
      this.fightCamera.shake(0.15, 0.15);
      this.spawnHitSpark(defender.position, attacker.facingAngle);
    } else if (result.type === 'blocked') {
      defender.onHit(result, attacker.facingAngle);
      this.ui.showBlockEffect();
      this.fightCamera.shake(0.05, 0.1);
      this.spawnBlockSpark(defender.position);
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

  getSimpleBotInput(bot: Fighter, opponent: Fighter): InputState {
    const input: InputState = this.emptyInput();
    const dx = opponent.position.x - bot.position.x;
    const dz = opponent.position.z - bot.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const rand = Math.random();

    if (dist > 3) {
      input.right = true;
    } else if (dist > 1.5) {
      if (rand < 0.3) {
        input.right = true;
      } else if (rand < 0.5) {
        input.left = true;
      }
      if (rand > 0.95) {
        input.lpJust = true;
        input.lp = true;
      }
    } else {
      if (rand < 0.15) {
        input.lpJust = true;
        input.lp = true;
      } else if (rand < 0.25) {
        input.rpJust = true;
        input.rp = true;
      } else if (rand < 0.3) {
        input.lkJust = true;
        input.lk = true;
      } else if (rand < 0.45) {
        input.left = true;
      } else if (rand < 0.48) {
        input.down = true;
        if (Math.random() < 0.3) {
          input.lkJust = true;
          input.lk = true;
        }
      }
    }

    if (bot.state === FIGHTER_STATE.HIT_STUN || bot.state === FIGHTER_STATE.BLOCK_STUN) {
      input.left = true;
    }

    return input;
  }

  serializeInput(input: InputState): InputState {
    return {
      up: input.up,
      down: input.down,
      left: input.left,
      right: input.right,
      lp: input.lp,
      rp: input.rp,
      lk: input.lk,
      rk: input.rk,
      upJust: input.upJust,
      downJust: input.downJust,
      leftJust: input.leftJust,
      rightJust: input.rightJust,
      lpJust: input.lpJust,
      rpJust: input.rpJust,
      lkJust: input.lkJust,
      rkJust: input.rkJust,
      dashLeft: input.dashLeft,
      dashRight: input.dashRight,
      sideStepUp: input.sideStepUp,
      sideStepDown: input.sideStepDown,
    };
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
    winner.setVictory();
    loser.setDefeat();

    this.fightCamera.setDramaticAngle(winner.position);
    this.fightCamera.shake(0.3, 0.3);

    this.ui.showAnnouncement('K.O.', '', 2000, 'ko');
    this.ui.updateWins(
      this.fighters[this.localPlayerIndex]?.wins ?? 0,
      this.fighters[1 - this.localPlayerIndex]?.wins ?? 0,
      GC.ROUNDS_TO_WIN,
    );

    const matchOver = winner.wins >= GC.ROUNDS_TO_WIN;

    if (!this.isPractice && this.localPlayerIndex === 0) {
      this.network.sendRoundResult(
        winnerIdx,
        this.fighters[0]?.wins ?? 0,
        this.fighters[1]?.wins ?? 0,
        matchOver,
      );
    }

    if (matchOver) {
      setTimeout(() => this.onMatchEnd(winnerIdx), 2500);
    } else {
      setTimeout(() => this.startNextRound(), 3000);
    }
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
      if (!this.isPractice && this.localPlayerIndex === 0) {
        this.network.sendRoundResult(-1, f1.wins, f2.wins, false);
      }
      this.ui.showAnnouncement('DRAW', 'TIME UP', 2000);
      setTimeout(() => this.startNextRound(), 3000);
      return;
    }

    const winner = winnerIdx === 0 ? f1 : f2;
    const loser = winnerIdx === 0 ? f2 : f1;
    winner.wins++;
    winner.setVictory();
    loser.setDefeat();

    this.ui.showAnnouncement('TIME UP', '', 2000);
    this.ui.updateWins(
      this.fighters[this.localPlayerIndex]?.wins ?? 0,
      this.fighters[1 - this.localPlayerIndex]?.wins ?? 0,
      GC.ROUNDS_TO_WIN,
    );

    const matchOver = winner.wins >= GC.ROUNDS_TO_WIN;

    if (!this.isPractice && this.localPlayerIndex === 0) {
      this.network.sendRoundResult(
        winnerIdx,
        this.fighters[0]?.wins ?? 0,
        this.fighters[1]?.wins ?? 0,
        matchOver,
      );
    }

    if (matchOver) {
      setTimeout(() => this.onMatchEnd(winnerIdx), 2500);
    } else {
      setTimeout(() => this.startNextRound(), 3000);
    }
  }

  onMatchEnd(winnerIdx: number) {
    this.state = GAME_STATE.MATCH_END;
    this.stopBGM();
    const winnerName =
      winnerIdx === this.localPlayerIndex
        ? (this.ui.p1Name as HTMLElement).textContent
        : (this.ui.p2Name as HTMLElement).textContent;
    this.ui.showAnnouncement(winnerName || '', 'WINS!', 0, 'victory');

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
    this.fightCamera.reset();

    if (this.isPractice) {
      this.startPracticeCountdown();
    }
  }

  // ============================================================
  // 3D HIT EFFECTS
  // ============================================================

  _getPooledSpark(mat: StandardMaterial): Mesh {
    const pooled = this._sparkPool.pop();
    if (pooled !== undefined) {
      pooled.material = mat;
      pooled.setEnabled(true);
      return pooled;
    }
    const spark = this._sparkGeo.clone('spark');
    spark.material = mat;
    spark.setEnabled(true);
    return spark;
  }

  spawnHitSpark(position: Vector3, attackerFacingAngle: number) {
    const cosA = Math.cos(attackerFacingAngle);
    const sinA = Math.sin(attackerFacingAngle);
    const count = 8;
    for (let i = 0; i < count; i++) {
      const mat = (i & 1) === 0 ? this._hitMat0 : this._hitMat1;
      const spark = this._getPooledSpark(mat);
      spark.position.set(
        position.x + cosA * 0.5,
        position.y + 1.2 + (Math.random() - 0.5) * 0.5,
        position.z + sinA * 0.5 + (Math.random() - 0.5) * 0.3,
      );
      spark.scaling.setAll(1);
      spark.metadata = {
        velocity: new Vector3(
          (Math.random() - 0.3) * 0.15 * cosA,
          Math.random() * 0.12,
          (Math.random() - 0.3) * 0.15 * sinA,
        ),
        life: 1.0,
        decay: 0.04 + Math.random() * 0.03,
        mat,
      };
      this.hitParticles.push(spark);
    }
  }

  spawnBlockSpark(position: Vector3) {
    const count = 4;
    for (let i = 0; i < count; i++) {
      const spark = this._getPooledSpark(this._blockMat);
      spark.position.set(
        position.x,
        position.y + 1.2 + (Math.random() - 0.5) * 0.3,
        position.z + (Math.random() - 0.5) * 0.2,
      );
      spark.scaling.setAll(0.7);
      spark.metadata = {
        velocity: new Vector3(
          (Math.random() - 0.5) * 0.1,
          Math.random() * 0.08,
          (Math.random() - 0.5) * 0.08,
        ),
        life: 1.0,
        decay: 0.06,
        mat: this._blockMat,
      };
      this.hitParticles.push(spark);
    }
  }

  updateHitParticles() {
    for (let i = this.hitParticles.length - 1; i >= 0; i--) {
      const p = this.hitParticles[i];
      if (!p) continue;
      const d = p.metadata as {
        velocity: Vector3;
        life: number;
        decay: number;
        mat: StandardMaterial;
      };
      d.life -= d.decay;
      d.velocity.y -= 0.005;
      p.position.addInPlace(d.velocity);
      d.mat.alpha = d.life;
      p.scaling.setAll(d.life);

      if (d.life <= 0) {
        p.setEnabled(false);
        this._sparkPool.push(p);
        this.hitParticles.splice(i, 1);
      }
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

    this.updateHitParticles();
  }

  private _onResize() {
    this.engine.resize();
  }

  playBGM() {
    if (this.bgm?.paused) {
      this.bgm.currentTime = 0;
      this.bgm.play().catch(() => {});
    }
  }

  stopBGM() {
    if (this.bgm) {
      this.bgm.pause();
      this.bgm.currentTime = 0;
    }
  }
}

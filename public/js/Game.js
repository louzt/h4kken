// ============================================================
// H4KKEN - Game Manager (Main Game Loop, State, Round Logic)
// ============================================================

import * as THREE from 'three';
import { Fighter } from './Fighter.js';
import { CombatSystem, FIGHTER_STATE, GAME_CONSTANTS } from './Combat.js';
import { InputManager } from './Input.js';
import { FightCamera } from './Camera.js';
import { Stage } from './Stage.js';
import { UI } from './UI.js';
import { Network } from './Network.js';

const GC = GAME_CONSTANTS;

export const GAME_STATE = {
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
  constructor() {
    this.state = GAME_STATE.LOADING;
    this.canvas = document.getElementById('game-canvas');

    // Three.js setup
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // manual update only
    this.renderer.shadowMap.needsUpdate = true; // initial render
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);

    // Modules
    this.input = new InputManager();
    this.fightCamera = new FightCamera(this.camera);
    this.stage = null;
    this.ui = new UI();
    this.network = new Network();

    // Fighters
    this.fighters = [null, null];
    this.localPlayerIndex = 0; // Updated on match
    this.sharedAssets = null;

    // Round state
    this.round = 1;
    this.roundTimer = GC.ROUND_TIME;
    this.roundTimerAccum = 0;
    this.isPractice = false;

    // Hit sparks — pooled particles
    this.hitParticles = [];
    this._sparkPool = [];           // reusable spark meshes
    this._sparkGeo = new THREE.SphereGeometry(0.03, 3, 3);
    this._hitMats = [
      new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true }),
      new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true }),
    ];
    this._blockMat = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true });

    // Game loop timing
    this.clock = new THREE.Clock();
    this.tickRate = 60;
    this.tickDuration = 1 / this.tickRate;
    this.accumulator = 0;
    this.frame = 0;

    // Opponent input tracking (for online play)
    this.pendingOpponentInput = null;
    this.lastOpponentInput = this.emptyInput();

    // Background music
    this.bgm = new Audio('/assets/music/h4kken-theme.mp3');
    this.bgm.loop = true;
    this.bgm.volume = 0.5;

    // Bind
    this.gameLoop = this.gameLoop.bind(this);
    this.onResize = this.onResize.bind(this);
    window.addEventListener('resize', this.onResize);

    this.setupUIEvents();
    this.setupNetworkEvents();
  }

  emptyInput() {
    return {
      up: false, down: false, left: false, right: false,
      lp: false, rp: false, lk: false, rk: false,
      upJust: false, downJust: false, leftJust: false, rightJust: false,
      lpJust: false, rpJust: false, lkJust: false, rkJust: false,
      dashLeft: false, dashRight: false,
      sideStepUp: false, sideStepDown: false,
    };
  }

  setupUIEvents() {
    this.ui.btnFindMatch.addEventListener('click', () => this.findMatch());
    this.ui.btnPractice.addEventListener('click', () => this.startPractice());
    this.ui.btnControls.addEventListener('click', () => this.ui.showScreen('controls-screen'));
    this.ui.btnBackControls.addEventListener('click', () => this.ui.showScreen('menu-screen'));
    this.ui.btnCancelSearch.addEventListener('click', () => this.cancelSearch());
  }

  setupNetworkEvents() {
    this.network.on('waiting', () => {
      this.ui.showScreen('waiting-screen');
    });

    this.network.on('matched', (msg) => {
      this.localPlayerIndex = msg.playerIndex;
      const myName = this.ui.playerNameInput.value || 'Player';
      // Left HUD = local player, right HUD = opponent
      this.ui.setPlayerNames(myName, msg.opponentName);
      this.ui.hideAllScreens();
      this.ui.showFightHud();
      this.prepareMatch();
    });

    this.network.on('countdown', (msg) => {
      // Only accept countdown during ROUND_END or COUNTDOWN state
      // to prevent stale countdown events from interrupting a live round
      if (this.state !== GAME_STATE.ROUND_END && this.state !== GAME_STATE.COUNTDOWN) return;
      if (msg.count === 3) {
        // First countdown tick — ensure fighters are reset for the new round
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

    // Server broadcasts round result — ensure both clients transition properly
    this.network.on('roundResult', (msg) => {
      if (this.state === GAME_STATE.FIGHTING) {
        // P2 might not have detected KO locally — force round end
        this.state = GAME_STATE.ROUND_END;
        const winnerIdx = msg.winner;
        if (winnerIdx >= 0 && winnerIdx < 2) {
          const winner = this.fighters[winnerIdx];
          const loser = this.fighters[winnerIdx === 0 ? 1 : 0];
          winner.wins = winnerIdx === 0 ? msg.p1Wins : msg.p2Wins;
          loser.wins = winnerIdx === 0 ? msg.p2Wins : msg.p1Wins;
          winner.setVictory();
          loser.setDefeat();
          this.fightCamera.setDramaticAngle(winner.position);
          this.fightCamera.shake(0.3, 0.3);
          this.ui.showAnnouncement('K.O.', '', 2000, 'ko');
          this.ui.updateWins(this.fighters[this.localPlayerIndex].wins, this.fighters[1 - this.localPlayerIndex].wins, GC.ROUNDS_TO_WIN);
        }
      }
    });

    // P2 receives authoritative game state from P1
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

    // Build stage
    this.stage = new Stage(this.scene);

    // Load fighter assets
    this.sharedAssets = await Fighter.loadAssets((progress) => {
      this.ui.setLoadingProgress(progress);
    });

    // Create fighters
    this.createFighters();

    this.ui.setLoadingProgress(1);
    this.ui.setLoadingText('Ready!');

    // Connect to server
    try {
      await this.network.connect();
    } catch (e) {
      console.warn('Could not connect to server. Only practice mode available.');
    }

    // Show menu
    setTimeout(() => {
      this.state = GAME_STATE.MENU;
      this.ui.showScreen('menu-screen');
    }, 500);

    // Start game loop
    this.gameLoop();
  }

  createFighters() {
    const { baseModel, animClips, texture } = this.sharedAssets;
    
    this.fighters[0] = new Fighter(0, this.scene);
    this.fighters[0].init(baseModel, animClips, texture);

    this.fighters[1] = new Fighter(1, this.scene);
    this.fighters[1].init(baseModel, animClips, texture);
  }

  prepareMatch() {
    this.round = 1;
    this._roundResetting = false;
    this.fighters[0].reset(-3);
    this.fighters[1].reset(3);
    this.fighters[0].wins = 0;
    this.fighters[1].wins = 0;
    this.roundTimer = GC.ROUND_TIME;
    this.roundTimerAccum = 0;
    this.ui.updateHealth(this.fighters[this.localPlayerIndex].health, this.fighters[1 - this.localPlayerIndex].health, GC.MAX_HEALTH);
    this.ui.updateWins(0, 0, GC.ROUNDS_TO_WIN);
    this.ui.updateTimer(this.roundTimer);
    this.playBGM();
    this.fightCamera.reset();
    this.state = GAME_STATE.COUNTDOWN;
  }

  findMatch() {
    const name = this.ui.playerNameInput.value || 'Player';
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
    const name = this.ui.playerNameInput.value || 'Player';
    this.ui.setPlayerNames(name, 'CPU');
    this.ui.hideAllScreens();
    this.ui.showFightHud();
    this.prepareMatch();
    // Start countdown immediately for practice
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

  gameLoop() {
    requestAnimationFrame(this.gameLoop);

    const deltaTime = Math.min(this.clock.getDelta(), 0.05);
    this.accumulator += deltaTime;

    // Fixed timestep simulation
    while (this.accumulator >= this.tickDuration) {
      this.fixedUpdate();
      this.accumulator -= this.tickDuration;
      this.frame++;
    }

    // Variable timestep rendering
    this.render(deltaTime);
  }

  fixedUpdate() {
    // Always poll input to keep previousKeys in sync (prevents stale justPressed on round start)
    const rawInput = this.input.update();

    if (this.state !== GAME_STATE.FIGHTING && this.state !== GAME_STATE.PRACTICE) return;

    const f1 = this.fighters[0];
    const f2 = this.fighters[1];

    // Determine inputs for each fighter
    let p1Input, p2Input;

    if (this.isPractice) {
      // Practice mode: P1 uses keyboard, P2 is a dumb bot
      p1Input = rawInput;
      p2Input = this.getSimpleBotInput(f2, f1);
    } else {
      // Online mode - use last known opponent state, overwrite held keys
      const opponentHeld = { ...this.lastOpponentInput };
      // Clear just-pressed flags from last frame (they only fire once)
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

      // If new input arrived this frame, use it (includes just-pressed)
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

    // Process fighter inputs
    f1.processInput(p1Input, f2.position);
    f2.processInput(p2Input, f1.position);

    // Combat resolution (snapshot active states to allow simultaneous trades)
    const f1Active = f1.isAttackActive();
    const f2Active = f2.isAttackActive();
    if (f1Active) this.resolveCombat(f1, f2);
    if (f2Active) this.resolveCombat(f2, f1);

    // Push fighters apart (no overlap)
    this.resolveFighterCollision(f1, f2);

    // Physics
    f1.updatePhysics();
    f2.updatePhysics();

    // Round timer
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

    // Check for round end
    if (this.state === GAME_STATE.FIGHTING) {
      if (f1.health <= 0 || f2.health <= 0) {
        this.onKO(f1.health <= 0 ? 1 : 0);
      }
    }

    // Update HUD — show local player on left, opponent on right
    const local = this.fighters[this.localPlayerIndex];
    const remote = this.fighters[1 - this.localPlayerIndex];
    this.ui.updateHealth(local.health, remote.health, GC.MAX_HEALTH);

    // Combo display (side 0 = left HUD = local player's combo ON opponent)
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

    // Periodically sync state (P1 authoritative for online)
    if (!this.isPractice && this.localPlayerIndex === 0 && this.frame % 6 === 0) {
      this.network.sendGameState(this.frame, {
        p1: f1.serializeState(),
        p2: f2.serializeState(),
        timer: this.roundTimer,
        round: this.round,
      });
    }
  }

  resolveCombat(attacker, defender) {
    if (!attacker.isAttackActive()) return;

    // Check hitbox collision — project hitbox along attacker's facing angle
    const hit = CombatSystem.checkHitbox(
      attacker.position,
      attacker.facingAngle,
      attacker.currentMove,
      defender.position
    );

    if (!hit) return;

    // Resolve hit
    const result = CombatSystem.resolveHit(attacker, defender, attacker.currentMove);

    if (result.type === 'whiff') {
      attacker.hasHitThisMove = true; // prevent further checks
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

  resolveFighterCollision(f1, f2) {
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

  // Simple practice bot AI
  getSimpleBotInput(bot, opponent) {
    const input = this.emptyInput();
    const dx = opponent.position.x - bot.position.x;
    const dz = opponent.position.z - bot.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // facing is always 1: right = forward, left = back
    const fwd  = 'right';
    const back = 'left';

    // Random behavior changes
    const rand = Math.random();

    // Walk towards opponent if far
    if (dist > 3) {
      input[fwd] = true;
    }
    // At mid range, sometimes approach, sometimes block
    else if (dist > 1.5) {
      if (rand < 0.3) {
        input[fwd] = true;
      } else if (rand < 0.5) {
        // Block (hold back)
        input[back] = true;
      }
      // Occasionally attack
      if (rand > 0.95) {
        input.lpJust = true;
        input.lp = true;
      }
    }
    // Close range - attack or block
    else {
      if (rand < 0.15) {
        input.lpJust = true;
        input.lp = true;
      } else if (rand < 0.25) {
        input.rpJust = true;
        input.rp = true;
      } else if (rand < 0.30) {
        input.lkJust = true;
        input.lk = true;
      } else if (rand < 0.45) {
        // Block
        input[back] = true;
      } else if (rand < 0.48) {
        // Crouch
        input.down = true;
        if (Math.random() < 0.3) {
          input.lkJust = true;
          input.lk = true;
        }
      }
    }

    // React to being hit
    if (bot.state === FIGHTER_STATE.HIT_STUN || bot.state === FIGHTER_STATE.BLOCK_STUN) {
      // Try to block after recovering
      input[back] = true;
    }

    return input;
  }

  serializeInput(input) {
    return {
      up: input.up, down: input.down, left: input.left, right: input.right,
      lp: input.lp, rp: input.rp, lk: input.lk, rk: input.rk,
      upJust: input.upJust, downJust: input.downJust,
      leftJust: input.leftJust, rightJust: input.rightJust,
      lpJust: input.lpJust, rpJust: input.rpJust,
      lkJust: input.lkJust, rkJust: input.rkJust,
      dashLeft: input.dashLeft, dashRight: input.dashRight,
      sideStepUp: input.sideStepUp, sideStepDown: input.sideStepDown,
    };
  }

  // ============================================================
  // ROUND MANAGEMENT
  // ============================================================

  onKO(winnerIdx) {
    this.state = GAME_STATE.ROUND_END;
    const winner = this.fighters[winnerIdx];
    const loser = this.fighters[winnerIdx === 0 ? 1 : 0];

    winner.wins++;
    winner.setVictory();
    loser.setDefeat();

    // Camera dramatic angle
    this.fightCamera.setDramaticAngle(winner.position);
    this.fightCamera.shake(0.3, 0.3);

    this.ui.showAnnouncement('K.O.', '', 2000, 'ko');
    this.ui.updateWins(this.fighters[this.localPlayerIndex].wins, this.fighters[1 - this.localPlayerIndex].wins, GC.ROUNDS_TO_WIN);

    // Check for match end
    const matchOver = winner.wins >= GC.ROUNDS_TO_WIN;

    // Only host (P1) sends roundResult to prevent duplicate server countdowns
    if (!this.isPractice && this.localPlayerIndex === 0) {
      this.network.sendRoundResult(
        winnerIdx,
        this.fighters[0].wins,
        this.fighters[1].wins,
        matchOver
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

    // Player with more health wins
    const f1 = this.fighters[0];
    const f2 = this.fighters[1];
    let winnerIdx;

    if (f1.health > f2.health) {
      winnerIdx = 0;
    } else if (f2.health > f1.health) {
      winnerIdx = 1;
    } else {
      // Draw - no wins awarded, replay the round
      if (!this.isPractice && this.localPlayerIndex === 0) {
        this.network.sendRoundResult(-1, this.fighters[0].wins, this.fighters[1].wins, false);
      }
      this.ui.showAnnouncement('DRAW', 'TIME UP', 2000);
      setTimeout(() => this.startNextRound(), 3000);
      return;
    }

    const winner = this.fighters[winnerIdx];
    const loser = this.fighters[winnerIdx === 0 ? 1 : 0];
    winner.wins++;
    winner.setVictory();
    loser.setDefeat();

    this.ui.showAnnouncement('TIME UP', '', 2000);
    this.ui.updateWins(this.fighters[this.localPlayerIndex].wins, this.fighters[1 - this.localPlayerIndex].wins, GC.ROUNDS_TO_WIN);

    const matchOver = winner.wins >= GC.ROUNDS_TO_WIN;

    // Only host (P1) sends roundResult to prevent duplicate server countdowns
    if (!this.isPractice && this.localPlayerIndex === 0) {
      this.network.sendRoundResult(
        winnerIdx,
        this.fighters[0].wins,
        this.fighters[1].wins,
        matchOver
      );
    }

    if (matchOver) {
      setTimeout(() => this.onMatchEnd(winnerIdx), 2500);
    } else {
      setTimeout(() => this.startNextRound(), 3000);
    }
  }

  onMatchEnd(winnerIdx) {
    this.state = GAME_STATE.MATCH_END;
    this.stopBGM();
    // Left HUD name = local player, right = opponent
    const winnerName = winnerIdx === this.localPlayerIndex
      ? this.ui.p1Name.textContent   // local player won (shown on left)
      : this.ui.p2Name.textContent;  // opponent won (shown on right)
    this.ui.showAnnouncement(winnerName, 'WINS!', 0, 'victory');

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
    // Guard: prevent double-reset if called from both local timer and network event
    if (this._roundResetting) return;
    this._roundResetting = true;

    this.round++;
    this.fighters[0].reset(-3);
    this.fighters[1].reset(3);
    this.roundTimer = GC.ROUND_TIME;
    this.roundTimerAccum = 0;
    this.ui.updateTimer(this.roundTimer);
    this.ui.updateHealth(GC.MAX_HEALTH, GC.MAX_HEALTH, GC.MAX_HEALTH);
    this.fightCamera.reset();

    if (this.isPractice) {
      this.startPracticeCountdown();
    }
    // Online mode: server sends countdown
  }

  // ============================================================
  // 3D HIT EFFECTS
  // ============================================================

  _getPooledSpark(mat) {
    let spark;
    if (this._sparkPool.length > 0) {
      spark = this._sparkPool.pop();
      spark.material = mat;
      spark.visible = true;
    } else {
      spark = new THREE.Mesh(this._sparkGeo, mat);
      this.scene.add(spark);
    }
    return spark;
  }

  spawnHitSpark(position, attackerFacingAngle) {
    const cosA = Math.cos(attackerFacingAngle);
    const sinA = Math.sin(attackerFacingAngle);
    const count = 8;
    for (let i = 0; i < count; i++) {
      const mat = this._hitMats[i & 1];
      const spark = this._getPooledSpark(mat);
      spark.position.set(
        position.x + cosA * 0.5,
        position.y + 1.2 + (Math.random() - 0.5) * 0.5,
        position.z + sinA * 0.5 + (Math.random() - 0.5) * 0.3
      );
      spark.scale.setScalar(1);
      spark.material.opacity = 1;
      spark.userData.velocity = spark.userData.velocity || new THREE.Vector3();
      spark.userData.velocity.set(
        (Math.random() - 0.3) * 0.15 * cosA,
        Math.random() * 0.12,
        (Math.random() - 0.3) * 0.15 * sinA
      );
      spark.userData.life = 1.0;
      spark.userData.decay = 0.04 + Math.random() * 0.03;
      this.hitParticles.push(spark);
    }
  }

  spawnBlockSpark(position) {
    const count = 4;
    for (let i = 0; i < count; i++) {
      const spark = this._getPooledSpark(this._blockMat);
      spark.position.set(
        position.x,
        position.y + 1.2 + (Math.random() - 0.5) * 0.3,
        position.z + (Math.random() - 0.5) * 0.2
      );
      spark.scale.setScalar(0.7);
      spark.material.opacity = 1;
      spark.userData.velocity = spark.userData.velocity || new THREE.Vector3();
      spark.userData.velocity.set(
        (Math.random() - 0.5) * 0.1,
        Math.random() * 0.08,
        (Math.random() - 0.5) * 0.08
      );
      spark.userData.life = 1.0;
      spark.userData.decay = 0.06;
      this.hitParticles.push(spark);
    }
  }

  updateHitParticles(deltaTime) {
    for (let i = this.hitParticles.length - 1; i >= 0; i--) {
      const p = this.hitParticles[i];
      const d = p.userData;
      d.life -= d.decay;
      d.velocity.y -= 0.005; // gravity
      p.position.x += d.velocity.x;
      p.position.y += d.velocity.y;
      p.position.z += d.velocity.z;
      p.material.opacity = d.life;
      p.scale.setScalar(d.life);

      if (d.life <= 0) {
        p.visible = false;
        this._sparkPool.push(p);
        this.hitParticles.splice(i, 1);
      }
    }
  }

  // ============================================================
  // RENDER
  // ============================================================

  render(deltaTime) {
    const f1 = this.fighters[0];
    const f2 = this.fighters[1];

    // Update fighter visuals
    if (f1) f1.updateVisuals(deltaTime);
    if (f2) f2.updateVisuals(deltaTime);

    // Update camera — local player always appears on left
    if (f1 && f2) {
      this.fightCamera.update(f1.position, f2.position, deltaTime, this.localPlayerIndex);
    }

    // Update stage
    if (this.stage) this.stage.update(deltaTime);

    // Update hit particles
    this.updateHitParticles(deltaTime);

    // Refresh shadow map periodically (characters move slowly relative to shadow)
    if (this.frame % 8 === 0) {
      this.renderer.shadowMap.needsUpdate = true;
    }

    // Render
    this.renderer.render(this.scene, this.camera);
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  playBGM() {
    if (this.bgm && this.bgm.paused) {
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

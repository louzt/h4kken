// ============================================================
// H4KKEN - Network Event Handlers
// Extracted from Game to keep Game.ts lean.
// Uses `import type` so there is no runtime circular dependency.
// ============================================================

import { GAME_CONSTANTS } from '../constants';
import type { Game } from './Game';

const GC = GAME_CONSTANTS;

// Mirror of the GAME_STATE const in Game.ts — string values must stay in sync.
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

export function setupNetworkEvents(game: Game): void {
  game.network.on('waiting', () => {
    game.ui.showScreen('waiting-screen');
  });

  game.network.on('matched', (msg) => {
    game.localPlayerIndex = msg.playerIndex;
    const myName = game.ui.playerNameInput?.value || 'Player';
    game.ui.setPlayerNames(myName, msg.opponentName);
    game.ui.hideAllScreens();
    game.ui.showFightHud();
    game.prepareMatch();
  });

  game.network.on('countdown', (msg) => {
    if (game.state !== GAME_STATE.ROUND_END && game.state !== GAME_STATE.COUNTDOWN) return;
    if (msg.count === 3) {
      // Cancel the client-side fallback timeout — server countdown is authoritative.
      // Without this, the timeout set in onKO() / roundResult fires ~3s later
      // after _roundResetting has been cleared by the 'fight' event, triggering
      // a spurious startNextRound() that resets fighters mid-round.
      if (game._nextRoundTimeout !== null) {
        clearTimeout(game._nextRoundTimeout);
        game._nextRoundTimeout = null;
      }
      // Guard against duplicate count=3 messages (reconnect, WS retransmit).
      // startNextRound() has its own _roundResetting guard but the announcement
      // code below would still fire even if startNextRound() returned early.
      if (!game._roundResetting) {
        game.startNextRound();
        if (game.round === 1) game._startIntroAnimations();
        const roundSfx =
          game.round === 1
            ? 'announce_round1'
            : game.round === 2
              ? 'announce_round2'
              : 'announce_finalround';
        game.ui.showAnnouncement(`ROUND ${game.round}`, '', 900);
        game.audio.play(roundSfx, 0.63);
      }
    } else if (msg.count === 2) {
      game.ui.showAnnouncement('3', '', 900, 'countdown');
      game.audio.play('count_3', 0.63);
    } else if (msg.count === 1) {
      game.ui.showAnnouncement('2', '', 900, 'countdown');
      game.audio.play('count_2', 0.63);
    }
    game.state = GAME_STATE.COUNTDOWN;
  });

  game.network.on('fight', () => {
    game.ui.showAnnouncement('1', '', 400, 'countdown');
    game.audio.play('count_1', 0.63);
    setTimeout(() => {
      game.ui.showAnnouncement('FIGHT!', '', 1000);
      game.audio.play('announce_fight', 0.63);
    }, 400);
    // Cancel any running intro, snap both fighters to idle before control transfers
    game.fighters[0]?.cancelIntro();
    game.fighters[1]?.cancelIntro();
    game.state = GAME_STATE.FIGHTING;
    game._roundResetting = false;
  });

  game.network.on('opponentInput', (msg) => {
    game.pendingOpponentInput = msg.input;
  });

  game.network.on('roundResult', (msg) => {
    if (game.state === GAME_STATE.FIGHTING) {
      game.state = GAME_STATE.ROUND_END;
      const winnerIdx = msg.winner;
      if (winnerIdx >= 0 && winnerIdx < 2) {
        const winner = game.fighters[winnerIdx];
        const loser = game.fighters[winnerIdx === 0 ? 1 : 0];
        if (!winner || !loser) return;
        winner.wins = winnerIdx === 0 ? msg.p1Wins : msg.p2Wins;
        loser.wins = winnerIdx === 0 ? msg.p2Wins : msg.p1Wins;
        winner.setVictory(msg.victoryAnim);
        loser.setDefeat(msg.defeatAnim);
        game.fightCamera.setDramaticAngle(winner.position);
        game.fightCamera.shake(0.3, 0.3);
        game.audio.play('ko_bell', 0.9);
        game.ui.showAnnouncement('K.O.', '', 2000, 'ko');
        game.ui.updateWins(
          game.fighters[game.localPlayerIndex]?.wins ?? 0,
          game.fighters[1 - game.localPlayerIndex]?.wins ?? 0,
          GC.ROUNDS_TO_WIN,
        );
      }
      if (msg.matchOver && winnerIdx >= 0) {
        setTimeout(() => game.onMatchEnd(winnerIdx), 2500);
      } else {
        game._nextRoundTimeout = setTimeout(() => game.startNextRound(), 3000);
      }
    }
  });

  game.network.on('superActivated', (msg) => {
    const fighter = game.fighters[msg.playerIndex];
    fighter?.applyServerSuperActivation();
    game.bgm.crossfadeTo('power');
  });

  game.network.on('gameState', (msg) => {
    if (game.localPlayerIndex === 1 && msg.state) {
      const { p1, p2 } = msg.state;
      // Sync the remote fighter (P1) fully — we have no local knowledge of P1's position
      if (p1 && game.fighters[0]) game.fighters[0].deserializeState(p1);
      // For P2's own fighter, only accept authoritative combat results from P1.
      // Skipping position/velocity/animation prevents P1's stale snapshot from
      // rubber-banding P2's character back to where it was RTT/2 ms ago.
      if (p2 && game.fighters[1]) {
        const f = game.fighters[1];
        f.health = p2.health;
        f.wins = p2.wins;
        f.stunFrames = p2.stunFrames;
        f.comboCount = p2.comboCount;
        f.comboDamage = p2.comboDamage;
        f.superMeter = p2.superMeter;
        if (p2.superPowerActive !== f.superPowerActive) {
          f.superPowerActive = p2.superPowerActive;
        }
      }
      if (msg.state.timer !== undefined) {
        game.roundTimer = msg.state.timer;
        game.ui.updateTimer(game.roundTimer);
      }
      if (msg.state.round !== undefined) {
        game.round = msg.state.round;
      }
    }
  });

  game.network.on('opponentLeft', () => {
    game.stopBGM();
    game.ui.showAnnouncement('OPPONENT LEFT', '', 3000);
    setTimeout(() => {
      game.state = GAME_STATE.MENU;
      game.ui.showScreen('menu-screen');
      game.ui.hideFightHud();
      game.ui.hideAnnouncement();
    }, 3000);
  });

  game.network.on('disconnected', () => {
    if (game.state !== GAME_STATE.MENU && game.state !== GAME_STATE.LOADING) {
      game.stopBGM();
      game.ui.showAnnouncement('DISCONNECTED', '', 3000);
      setTimeout(() => {
        game.state = GAME_STATE.MENU;
        game.ui.showScreen('menu-screen');
        game.ui.hideFightHud();
      }, 3000);
    }
  });
}

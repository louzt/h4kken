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

function handleCountdownStart(game: Game): void {
  if (game._nextRoundTimeout !== null) {
    clearTimeout(game._nextRoundTimeout);
    game._nextRoundTimeout = null;
  }
  if (game._roundResetting) return;
  game.startNextRound();
  if (game._lastAnnouncedRound === game.round) return;
  game._lastAnnouncedRound = game.round;
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
    game._mobileControls?.show();
    game.prepareMatch();
  });

  game.network.on('countdown', (msg) => {
    if (game.state !== GAME_STATE.ROUND_END && game.state !== GAME_STATE.COUNTDOWN) return;
    if (msg.count === 3) {
      handleCountdownStart(game);
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

  // Rollback netcode: feed opponent's frame-tagged input, triggers rollback on misprediction
  game.network.on('opponentSyncInput', (msg) => {
    game.rollbackManager?.receiveRemoteInput(msg.targetFrame, msg.input, game._rollbackHost);
  });

  // With delay-based sync both clients detect KO/time-up locally at the same
  // frame, so by the time the server's confirmation arrives the state is already
  // ROUND_END. This handler is a defensive fallback — it only fires if the
  // local simulation somehow hasn't transitioned yet.
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
      }
    }
  });

  // With input sync, both clients activate super at the same frame locally.
  // This handler is a fallback — only apply if the fighter isn't already active.
  // BGM is driven by _updateHud polling, not by this event, so no crossfadeTo here.
  game.network.on('superActivated', (msg) => {
    const fighter = game.fighters[msg.playerIndex];
    if (fighter && !fighter.superPowerActive) {
      fighter.applyServerSuperActivation();
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
      game._mobileControls?.hide();
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
        game._mobileControls?.hide();
      }, 3000);
    }
  });
}

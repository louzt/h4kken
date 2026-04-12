// ============================================================
// H4KKEN - Fighter Intro / Victory / Defeat Sequences
// Plain functions extracted from Fighter to keep Fighter.ts lean.
// ============================================================

import { FIGHTER_STATE, GAME_CONSTANTS } from '../constants';
import { ANIM_POOLS, type AnimKey, pickRandom } from './animations';
import type { Fighter } from './Fighter';

const GC = GAME_CONSTANTS;

export function setVictory(fighter: Fighter, animName?: AnimKey): AnimKey {
  fighter.state = FIGHTER_STATE.VICTORY;
  fighter.velocity.set(0, 0, 0);
  let chosen: AnimKey;
  if (animName) {
    chosen = animName;
  } else if (fighter.health / fighter.maxHealth <= 0.15 && Math.random() < 0.65) {
    chosen = 'victoryTired';
  } else {
    chosen = pickRandom(ANIM_POOLS.victory);
  }
  fighter.playAnimation(chosen);
  return chosen;
}

export function setDefeat(fighter: Fighter, animName?: AnimKey, matchOver = false): AnimKey {
  fighter.state = FIGHTER_STATE.DEFEAT;
  fighter.velocity.set(0, 0, 0);
  let chosen: AnimKey;
  if (animName) {
    chosen = animName;
  } else if (matchOver) {
    chosen = 'defeatMatch';
  } else if (fighter.comboCount >= 3 || fighter.comboDamage >= GC.MAX_HEALTH * 0.5) {
    chosen = 'defeatBig';
  } else {
    chosen = 'defeat';
  }
  fighter.playAnimation(chosen);
  return chosen;
}

export function playIntroAnimation(fighter: Fighter): AnimKey {
  cancelIntro(fighter);
  const chosen = pickRandom(ANIM_POOLS.intro);
  fighter._introActive = true;
  playIntroSequence(fighter, chosen);
  return chosen;
}

export function playIntroAnimationExcluding(fighter: Fighter, exclude: AnimKey): AnimKey {
  cancelIntro(fighter);
  const filtered = ANIM_POOLS.intro.filter((k) => k !== exclude);
  const pool = filtered.length > 0 ? filtered : ANIM_POOLS.intro;
  const chosen = pickRandom(pool);
  fighter._introActive = true;
  playIntroSequence(fighter, chosen);
  return chosen;
}

function playIntroSequence(fighter: Fighter, key: AnimKey): void {
  // snap = instant cut for the opening frame so there's no idle→intro blend
  const snap = 1.0;
  switch (key) {
    case 'introGroundSitEnter':
      // Start already sitting — idle first, then stand up before the fight
      fighter.playAnimation('introGroundSitIdle', undefined, snap);
      fighter._introTimeout = setTimeout(() => {
        if (!fighter._introActive) return;
        fighter.playAnimation('introGroundSitExit');
        fighter.animGroups.introGroundSitExit?.onAnimationGroupEndObservable.addOnce(() => {
          if (!fighter._introActive) return;
          fighter._introActive = false;
          fighter.playAnimation('combatIdle');
        });
      }, 1800);
      break;

    case 'introSpellEnter':
      fighter.playAnimation('introSpellEnter', undefined, snap);
      fighter.animGroups.introSpellEnter?.onAnimationGroupEndObservable.addOnce(() => {
        if (!fighter._introActive) return;
        fighter.playAnimation('introSpellIdle');
        fighter._introTimeout = setTimeout(() => {
          if (!fighter._introActive) return;
          fighter.playAnimation('introSpellExit');
          fighter.animGroups.introSpellExit?.onAnimationGroupEndObservable.addOnce(() => {
            if (!fighter._introActive) return;
            fighter._introActive = false;
            fighter.playAnimation('combatIdle');
          });
        }, 1200);
      });
      break;

    case 'introTalking':
      fighter.playAnimation('introTalking', undefined, snap);
      // Loop until countdown ends — cancelIntro() will snap back to idle
      fighter._introTimeout = setTimeout(() => {
        if (!fighter._introActive) return;
        fighter._introActive = false;
        fighter.playAnimation('combatIdle');
      }, 3000);
      break;

    default:
      // Single-play: returns to combatIdle automatically when done
      fighter.playAnimation(key, undefined, snap);
      fighter.animGroups[key]?.onAnimationGroupEndObservable.addOnce(() => {
        if (!fighter._introActive) return;
        fighter._introActive = false;
        fighter.playAnimation('combatIdle');
      });
      break;
  }
}

export function cancelIntro(fighter: Fighter): void {
  fighter._introActive = false;
  if (fighter._introTimeout !== null) {
    clearTimeout(fighter._introTimeout);
    fighter._introTimeout = null;
  }
  fighter.playAnimation('combatIdle', undefined, 0.2);
}

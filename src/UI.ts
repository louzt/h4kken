// ============================================================
// H4KKEN - HUD / UI Manager
// ============================================================

export class UI {
  loadingScreen: HTMLElement | null;
  menuScreen: HTMLElement | null;
  waitingScreen: HTMLElement | null;
  controlsScreen: HTMLElement | null;
  fightHud: HTMLElement | null;
  announcement: HTMLElement | null;
  announceText: HTMLElement | null;
  announceSub: HTMLElement | null;
  loadingBar: HTMLElement | null;
  loadingText: HTMLElement | null;
  p1Health: HTMLElement | null;
  p2Health: HTMLElement | null;
  p1HealthDamage: HTMLElement | null;
  p2HealthDamage: HTMLElement | null;
  p1Name: HTMLElement | null;
  p2Name: HTMLElement | null;
  p1WinsEl: HTMLElement | null;
  p2WinsEl: HTMLElement | null;
  fightTimer: HTMLElement | null;
  p1Combo: HTMLElement | null;
  p2Combo: HTMLElement | null;
  p1ComboHits: HTMLElement | null;
  p2ComboHits: HTMLElement | null;
  p1ComboDamage: HTMLElement | null;
  p2ComboDamage: HTMLElement | null;
  btnFindMatch: HTMLElement | null;
  btnPractice: HTMLElement | null;
  btnControls: HTMLElement | null;
  btnBackControls: HTMLElement | null;
  btnCancelSearch: HTMLElement | null;
  playerNameInput: HTMLInputElement | null;
  p1HealthTarget: number;
  p2HealthTarget: number;
  p1HealthDamageTarget: number;
  p2HealthDamageTarget: number;
  announcementTimer: ReturnType<typeof setTimeout> | null;

  constructor() {
    this.loadingScreen = document.getElementById('loading-screen');
    this.menuScreen = document.getElementById('menu-screen');
    this.waitingScreen = document.getElementById('waiting-screen');
    this.controlsScreen = document.getElementById('controls-screen');
    this.fightHud = document.getElementById('fight-hud');
    this.announcement = document.getElementById('announcement');
    this.announceText = document.getElementById('announce-text');
    this.announceSub = document.getElementById('announce-sub');

    this.loadingBar = document.getElementById('loading-bar');
    this.loadingText = document.getElementById('loading-text');

    this.p1Health = document.getElementById('p1-health');
    this.p2Health = document.getElementById('p2-health');
    this.p1HealthDamage = document.getElementById('p1-health-damage');
    this.p2HealthDamage = document.getElementById('p2-health-damage');
    this.p1Name = document.getElementById('p1-name');
    this.p2Name = document.getElementById('p2-name');
    this.p1WinsEl = document.getElementById('p1-wins');
    this.p2WinsEl = document.getElementById('p2-wins');
    this.fightTimer = document.getElementById('fight-timer');

    this.p1Combo = document.getElementById('p1-combo');
    this.p2Combo = document.getElementById('p2-combo');
    this.p1ComboHits = document.getElementById('p1-combo-hits');
    this.p2ComboHits = document.getElementById('p2-combo-hits');
    this.p1ComboDamage = document.getElementById('p1-combo-damage');
    this.p2ComboDamage = document.getElementById('p2-combo-damage');

    this.btnFindMatch = document.getElementById('btn-find-match');
    this.btnPractice = document.getElementById('btn-practice');
    this.btnControls = document.getElementById('btn-controls');
    this.btnBackControls = document.getElementById('btn-back-controls');
    this.btnCancelSearch = document.getElementById('btn-cancel-search');
    this.playerNameInput = document.getElementById('player-name') as HTMLInputElement | null;

    this.p1HealthTarget = 100;
    this.p2HealthTarget = 100;
    this.p1HealthDamageTarget = 100;
    this.p2HealthDamageTarget = 100;
    this.announcementTimer = null;
  }

  showScreen(screenId: string) {
    document.querySelectorAll('.screen').forEach((s) => {
      s.classList.remove('active');
    });
    const screen = document.getElementById(screenId);
    if (screen) screen.classList.add('active');
  }

  hideAllScreens() {
    document.querySelectorAll('.screen').forEach((s) => {
      s.classList.remove('active');
    });
  }

  setLoadingProgress(progress: number) {
    const pct = Math.round(progress * 100);
    (this.loadingBar as HTMLElement).style.width = `${pct}%`;
    (this.loadingText as HTMLElement).textContent = `Loading assets... ${pct}%`;
  }

  setLoadingText(text: string) {
    (this.loadingText as HTMLElement).textContent = text;
  }

  showFightHud() {
    (this.fightHud as HTMLElement).classList.remove('hidden');
  }

  hideFightHud() {
    (this.fightHud as HTMLElement).classList.add('hidden');
  }

  setPlayerNames(p1Name: string, p2Name: string) {
    (this.p1Name as HTMLElement).textContent = p1Name;
    (this.p2Name as HTMLElement).textContent = p2Name;
  }

  updateHealth(p1Health: number, p2Health: number, maxHealth: number) {
    const p1Pct = Math.max(0, (p1Health / maxHealth) * 100);
    const p2Pct = Math.max(0, (p2Health / maxHealth) * 100);

    (this.p1Health as HTMLElement).style.width = `${p1Pct}%`;
    (this.p2Health as HTMLElement).style.width = `${p2Pct}%`;

    setTimeout(() => {
      (this.p1HealthDamage as HTMLElement).style.width = `${p1Pct}%`;
      (this.p2HealthDamage as HTMLElement).style.width = `${p2Pct}%`;
    }, 400);

    this.updateHealthColor(this.p1Health as HTMLElement, p1Pct);
    this.updateHealthColor(this.p2Health as HTMLElement, p2Pct);
  }

  updateHealthColor(el: HTMLElement, pct: number) {
    el.classList.remove('medium', 'low');
    if (pct <= 25) {
      el.classList.add('low');
    } else if (pct <= 50) {
      el.classList.add('medium');
    }
  }

  updateTimer(seconds: number) {
    (this.fightTimer as HTMLElement).textContent = String(Math.ceil(seconds));
    if (seconds <= 10) {
      (this.fightTimer as HTMLElement).classList.add('urgent');
    } else {
      (this.fightTimer as HTMLElement).classList.remove('urgent');
    }
  }

  updateWins(p1Wins: number, p2Wins: number, roundsToWin: number) {
    (this.p1WinsEl as HTMLElement).innerHTML = '';
    (this.p2WinsEl as HTMLElement).innerHTML = '';

    for (let i = 0; i < roundsToWin; i++) {
      const dot1 = document.createElement('div');
      dot1.className = `win-dot${i < p1Wins ? ' won' : ''}`;
      (this.p1WinsEl as HTMLElement).appendChild(dot1);

      const dot2 = document.createElement('div');
      dot2.className = `win-dot${i < p2Wins ? ' won' : ''}`;
      (this.p2WinsEl as HTMLElement).appendChild(dot2);
    }
  }

  updateCombo(playerIndex: number, hits: number, damage: number) {
    const comboEl = playerIndex === 0 ? this.p1Combo : this.p2Combo;
    const hitsEl = playerIndex === 0 ? this.p1ComboHits : this.p2ComboHits;
    const damageEl = playerIndex === 0 ? this.p1ComboDamage : this.p2ComboDamage;

    if (hits >= 2) {
      (comboEl as HTMLElement).classList.remove('hidden');
      (hitsEl as HTMLElement).textContent = String(hits);
      (damageEl as HTMLElement).textContent = `${damage} DMG`;
    } else {
      (comboEl as HTMLElement).classList.add('hidden');
    }
  }

  hideCombo(playerIndex: number) {
    const comboEl = playerIndex === 0 ? this.p1Combo : this.p2Combo;
    (comboEl as HTMLElement).classList.add('hidden');
  }

  showAnnouncement(text: string, sub = '', duration = 2000, cssClass = '') {
    if (this.announcementTimer) clearTimeout(this.announcementTimer);

    (this.announceText as HTMLElement).textContent = text;
    (this.announceText as HTMLElement).className = `announce-text${cssClass ? ` ${cssClass}` : ''}`;
    (this.announceSub as HTMLElement).textContent = sub;
    (this.announcement as HTMLElement).classList.remove('hidden');

    if (duration > 0) {
      this.announcementTimer = setTimeout(() => {
        (this.announcement as HTMLElement).classList.add('hidden');
      }, duration);
    }
  }

  hideAnnouncement() {
    (this.announcement as HTMLElement).classList.add('hidden');
    if (this.announcementTimer) clearTimeout(this.announcementTimer);
  }

  showHitEffect() {
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(255,255,255,0.15); pointer-events: none; z-index: 45;
    `;
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 80);
  }

  showBlockEffect() {
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,150,255,0.1); pointer-events: none; z-index: 45;
    `;
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 60);
  }
}

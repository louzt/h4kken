// ============================================================
// H4KKEN - Character Selection Screen
// ============================================================

import {
  type AbstractMesh,
  type FreeCamera,
  Quaternion,
  type Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { AnimKey } from './fighter/animations';
import { CHARACTERS, DEFAULT_P1, DEFAULT_P2 } from './fighter/characters';
import type { SharedAssets } from './fighter/Fighter';

const CYCLE_ANIMS: readonly AnimKey[] = ['victorySmug', 'introTalking'];
const CYCLE_INTERVAL_MS = 4000;
const FLOURISH_ANIM: AnimKey = 'victoryCelebrate';
const FLOURISH_DURATION_MS = 2000;

class SelectSlot {
  private positionNode: TransformNode;
  private clonedMeshes: AbstractMesh[] = [];
  private currentAssets: SharedAssets | null = null;
  private cycleInterval: ReturnType<typeof setInterval> | null = null;
  private cycleIndex = 0;
  private cycleAnims: readonly AnimKey[] = CYCLE_ANIMS;

  constructor(
    scene: Scene,
    private xOffset: number,
  ) {
    this.positionNode = new TransformNode(`cs_slot_${xOffset}`, scene);
    this.positionNode.position = new Vector3(xOffset, 0, 0);
    this.positionNode.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI);
  }

  setOffset(x: number) {
    this.xOffset = x;
    this.positionNode.position.x = x;
  }

  setCharacter(assets: SharedAssets, cycleAnims?: readonly AnimKey[]) {
    this._clearCycle();
    for (const m of this.clonedMeshes) m.dispose();
    this.clonedMeshes = [];
    this.currentAssets = assets;
    this.cycleAnims = cycleAnims ?? CYCLE_ANIMS;
    this.positionNode.scaling.setAll(assets.scale ?? 1.0);

    for (const baseMesh of assets.baseMeshes) {
      const clone = baseMesh.clone(`cs_${this.xOffset}_${baseMesh.name}`, this.positionNode);
      if (!clone) continue;
      clone.setEnabled(true);
      if (assets.baseSkeleton) clone.skeleton = assets.baseSkeleton;
      this.clonedMeshes.push(clone);
    }
    this._startCycle();
  }

  private _playAnim(name: AnimKey, loop: boolean) {
    const assets = this.currentAssets;
    if (!assets) return;
    const target = assets.animGroups[name];
    if (!target) return;
    for (const ag of Object.values(assets.animGroups)) {
      if (ag !== target) ag.stop();
    }
    target.play(loop);
  }

  private _startCycle() {
    this._clearCycle();
    this.cycleIndex = 0;
    const firstAnim = this.cycleAnims[0];
    if (firstAnim) this._playAnim(firstAnim, true);
    if (this.cycleAnims.length <= 1) return;
    this.cycleInterval = setInterval(() => {
      this.cycleIndex = (this.cycleIndex + 1) % this.cycleAnims.length;
      const animName = this.cycleAnims[this.cycleIndex];
      if (animName) this._playAnim(animName, true);
    }, CYCLE_INTERVAL_MS);
  }

  private _clearCycle() {
    if (this.cycleInterval !== null) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
  }

  playSelectFlourish() {
    this._clearCycle();
    this._playAnim(FLOURISH_ANIM, false);
    setTimeout(() => {
      if (this.currentAssets) this._startCycle();
    }, FLOURISH_DURATION_MS);
  }

  clear() {
    this._clearCycle();
    if (this.currentAssets) {
      for (const ag of Object.values(this.currentAssets.animGroups)) ag.stop();
      this.currentAssets = null;
    }
    for (const m of this.clonedMeshes) m.dispose();
    this.clonedMeshes = [];
  }

  dispose() {
    this.clear();
    this.positionNode.dispose();
  }
}

interface CharSelectHandlers {
  onConfirm?: (p1Id: string, p2Id: string) => void;
  onPick?: (charId: string) => void;
  onReady?: () => void;
  onBack: () => void;
}

export class CharSelect {
  private slot1: SelectSlot;
  private slot2: SelectSlot;
  private p1SelectedId: string;
  private p2SelectedId: string;
  private mode: 'practice' | 'online' = 'practice';
  private handlers: CharSelectHandlers | null = null;
  private savedCamPos: Vector3 | null = null;
  private savedCamTarget: Vector3 | null = null;
  private opponentPresent = false;
  private opponentReady = false;
  private localReady = false;
  private opponentName = '';

  constructor(
    scene: Scene,
    private readonly camera: FreeCamera,
    private readonly allAssets: Map<string, SharedAssets>,
  ) {
    this.slot1 = new SelectSlot(scene, -2);
    this.slot2 = new SelectSlot(scene, 2);
    this.p1SelectedId = DEFAULT_P1;
    this.p2SelectedId = DEFAULT_P2;
  }

  show(mode: 'practice' | 'online', handlers: CharSelectHandlers) {
    this.mode = mode;
    this.handlers = handlers;
    this.opponentPresent = false;
    this.opponentReady = false;
    this.localReady = false;
    this.opponentName = '';

    this.savedCamPos = this.camera.position.clone();
    this.savedCamTarget = this.camera.target.clone();

    this.slot1.setOffset(-1.2);
    this.slot2.setOffset(1.2);
    this.camera.position = new Vector3(0, 1.8, -5.0);
    this.camera.setTarget(new Vector3(0, 1.2, 0));

    this._buildDOM();
    this._container().classList.add('active');

    const p1Assets = this.allAssets.get(this.p1SelectedId);
    if (p1Assets) this.slot1.setCharacter(p1Assets, CHARACTERS[this.p1SelectedId]?.selectAnims);

    if (mode === 'practice') {
      const p2Assets = this.allAssets.get(this.p2SelectedId);
      if (p2Assets) this.slot2.setCharacter(p2Assets, CHARACTERS[this.p2SelectedId]?.selectAnims);
    } else {
      this.slot2.clear();
    }
  }

  hide() {
    this._container().classList.remove('active');
    this._container().innerHTML = '';

    if (this.savedCamPos) this.camera.position.copyFrom(this.savedCamPos);
    if (this.savedCamTarget) this.camera.setTarget(this.savedCamTarget);

    this.slot1.clear();
    this.slot2.clear();
  }

  dispose() {
    this.slot1.dispose();
    this.slot2.dispose();
  }

  setOpponent(name: string, charId: string) {
    if (this.mode !== 'online') return;
    this.opponentPresent = true;
    this.opponentReady = false;
    this.opponentName = name;
    this.p2SelectedId = charId;
    const assets = this.allAssets.get(charId) ?? this.allAssets.get(DEFAULT_P2);
    if (assets) this.slot2.setCharacter(assets, CHARACTERS[charId]?.selectAnims);
    this._renderP2Panel();
  }

  updateOpponentPick(charId: string) {
    if (this.mode !== 'online' || !this.opponentPresent) return;
    this.p2SelectedId = charId;
    const assets = this.allAssets.get(charId);
    if (assets) {
      this.slot2.setCharacter(assets, CHARACTERS[charId]?.selectAnims);
      this.slot2.playSelectFlourish();
    }
    this._renderP2Panel();
  }

  setOpponentReady() {
    if (this.mode !== 'online') return;
    this.opponentReady = true;
    this._renderP2Panel();
  }

  clearOpponent() {
    if (this.mode !== 'online') return;
    this.opponentPresent = false;
    this.opponentReady = false;
    this.opponentName = '';
    this.slot2.clear();
    this._renderP2Panel();
  }

  private _container(): HTMLElement {
    return document.getElementById('char-select-screen') as HTMLElement;
  }

  private _buildDOM() {
    const chars = Object.values(CHARACTERS);
    const isOnline = this.mode === 'online';

    this._container().innerHTML = `
      <div class="cs-layout">
        <div class="cs-panel cs-p1">
          <div class="cs-panel-label">${isOnline ? 'YOU' : 'PLAYER 1'}</div>
          <div class="cs-char-grid" id="cs-p1-grid"></div>
        </div>
        <div class="cs-center">
          <div class="cs-vs">VS</div>
        </div>
        <div class="cs-panel cs-p2" id="cs-p2-panel">
          <div class="cs-panel-label" id="cs-p2-label">${isOnline ? 'WAITING\u2026' : 'PLAYER 2'}</div>
          ${isOnline ? '<div class="cs-p2-body" id="cs-p2-body"></div>' : '<div class="cs-char-grid" id="cs-p2-grid"></div>'}
        </div>
      </div>
      <div class="cs-footer">
        <button class="cs-btn cs-back-btn">BACK</button>
        <button class="cs-btn cs-confirm-btn" id="cs-confirm">${isOnline ? 'READY' : 'FIGHT!'}</button>
      </div>
    `;

    const p1Grid = this._container().querySelector<HTMLElement>('#cs-p1-grid');
    if (p1Grid) {
      for (const char of chars) {
        const card = this._makeCard(char.id, char.name, char.id === this.p1SelectedId);
        card.addEventListener('click', () => this._selectP1(char.id));
        p1Grid.appendChild(card);
      }
    }

    if (!isOnline) {
      const p2Grid = this._container().querySelector<HTMLElement>('#cs-p2-grid');
      if (p2Grid) {
        for (const char of chars) {
          const card = this._makeCard(char.id, char.name, char.id === this.p2SelectedId);
          card.addEventListener('click', () => this._selectP2(char.id));
          p2Grid.appendChild(card);
        }
      }
    }

    this._container()
      .querySelector('.cs-back-btn')
      ?.addEventListener('click', () => this.handlers?.onBack?.());

    this._container()
      .querySelector('.cs-confirm-btn')
      ?.addEventListener('click', () => this._onConfirmClick());

    if (isOnline) this._renderP2Panel();
  }

  private _onConfirmClick() {
    if (this.mode === 'online') {
      if (this.localReady || !this.opponentPresent) return;
      this.localReady = true;
      this._renderConfirmButton();
      this.handlers?.onReady?.();
    } else {
      this.handlers?.onConfirm?.(this.p1SelectedId, this.p2SelectedId);
    }
  }

  private _renderP2Panel() {
    if (this.mode !== 'online') return;
    const label = this._container().querySelector<HTMLElement>('#cs-p2-label');
    const body = this._container().querySelector<HTMLElement>('#cs-p2-body');
    if (!label || !body) return;

    if (!this.opponentPresent) {
      label.textContent = 'WAITING\u2026';
      body.innerHTML = '<div class="cs-waiting">WAITING FOR<br>OPPONENT\u2026</div>';
      this._renderConfirmButton();
      return;
    }

    const char = CHARACTERS[this.p2SelectedId];
    const charName = char?.name ?? this.p2SelectedId;
    label.textContent = this.opponentName || 'OPPONENT';
    body.innerHTML = `
      <div class="cs-opp-pick">
        <div class="cs-opp-label">PICKED</div>
        <div class="cs-opp-char">${charName}</div>
        ${this.opponentReady ? '<div class="cs-opp-ready">READY!</div>' : '<div class="cs-opp-waiting">CHOOSING\u2026</div>'}
      </div>
    `;
    this._renderConfirmButton();
  }

  private _renderConfirmButton() {
    const btn = this._container().querySelector<HTMLButtonElement>('#cs-confirm');
    if (!btn) return;
    if (this.mode !== 'online') {
      btn.textContent = 'FIGHT!';
      btn.disabled = false;
      return;
    }
    if (this.localReady) {
      btn.textContent = 'WAITING\u2026';
      btn.disabled = true;
    } else if (!this.opponentPresent) {
      btn.textContent = 'READY';
      btn.disabled = true;
    } else {
      btn.textContent = 'READY';
      btn.disabled = false;
    }
  }

  private _makeCard(id: string, name: string, selected: boolean): HTMLElement {
    const card = document.createElement('div');
    card.className = `cs-card${selected ? ' selected' : ''}`;
    card.dataset.charId = id;
    card.innerHTML = `<div class="cs-card-name">${name}</div>`;
    return card;
  }

  private _selectP1(charId: string) {
    if (this.localReady) return;
    this.p1SelectedId = charId;
    this._container()
      .querySelectorAll<HTMLElement>('#cs-p1-grid .cs-card')
      .forEach((el) => {
        el.classList.toggle('selected', el.dataset.charId === charId);
      });
    const assets = this.allAssets.get(charId);
    if (assets) {
      this.slot1.setCharacter(assets, CHARACTERS[charId]?.selectAnims);
      this.slot1.playSelectFlourish();
    }
    if (this.mode === 'online') this.handlers?.onPick?.(charId);
  }

  private _selectP2(charId: string) {
    this.p2SelectedId = charId;
    this._container()
      .querySelectorAll<HTMLElement>('#cs-p2-grid .cs-card')
      .forEach((el) => {
        el.classList.toggle('selected', el.dataset.charId === charId);
      });
    const assets = this.allAssets.get(charId);
    if (assets) {
      this.slot2.setCharacter(assets, CHARACTERS[charId]?.selectAnims);
      this.slot2.playSelectFlourish();
    }
  }
}

// ============================================================
// H4KKEN - Mobile Controls
// Touch overlay: d-pad (left) + action buttons (right).
// Feeds directly into InputManager.keys — all tap/hold/dash
// logic in InputManager.update() works unchanged.
// ============================================================

import type { InputManager } from './Input';

export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

export class MobileControls {
  private _cleanups: (() => void)[] = [];
  private _container: HTMLElement;

  constructor(private _input: InputManager) {
    const el = document.getElementById('mobile-controls');
    if (!el) throw new Error('Missing #mobile-controls element');
    this._container = el;
    this._bindButtons();
  }

  private _bindButtons() {
    const btns = this._container.querySelectorAll<HTMLElement>('[data-key]');
    for (const btn of btns) {
      const code = btn.dataset.key ?? '';

      const onDown = (e: PointerEvent) => {
        e.preventDefault();
        // Capture so pointerup fires even if finger slides off the element
        btn.setPointerCapture(e.pointerId);
        this._input.setKey(code, true);
        btn.classList.add('pressed');
      };

      const onUp = () => {
        this._input.setKey(code, false);
        btn.classList.remove('pressed');
      };

      btn.addEventListener('pointerdown', onDown);
      btn.addEventListener('pointerup', onUp);
      btn.addEventListener('pointercancel', onUp);

      this._cleanups.push(() => {
        btn.removeEventListener('pointerdown', onDown);
        btn.removeEventListener('pointerup', onUp);
        btn.removeEventListener('pointercancel', onUp);
      });
    }
  }

  show() {
    this._container.classList.remove('hidden');
  }

  hide() {
    this._container.classList.add('hidden');
    // Release all virtual keys when hiding so no buttons stay stuck
    const btns = this._container.querySelectorAll<HTMLElement>('[data-key]');
    for (const btn of btns) {
      const code = btn.dataset.key ?? '';
      if (code) this._input.setKey(code, false);
      btn.classList.remove('pressed');
    }
  }

  destroy() {
    this.hide();
    for (const fn of this._cleanups) fn();
    this._cleanups = [];
  }
}

// Request fullscreen + landscape lock on user gesture.
// Both calls are best-effort — iOS iPhone silently rejects both.
// The CSS rotate-prompt handles the portrait fallback.
export async function requestLandscapeFullscreen(): Promise<void> {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // not supported or user denied — carry on
  }
  try {
    await screen.orientation.lock('landscape');
  } catch {
    // iOS iPhone doesn't support this
  }
}

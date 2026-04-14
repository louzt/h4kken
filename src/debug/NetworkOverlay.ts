// ============================================================
// H4KKEN - Network Debug Overlay
// ============================================================
// Optional HUD overlay showing real-time network metrics.
// Toggled via F3 during gameplay. Helps developers and testers
// validate WebRTC improvements, diagnose rollback issues, and
// measure connection quality during online matches.
//
// [Ref: VALVE-MP] Inspired by Source Engine's net_graph diagnostic overlay
// [Ref: TAXONOMY] Live metrics help correlate technique behavior with perceived quality
//
// Why: Console-only diagnostics (every 5s) are hard to correlate
// with gameplay feel. A live overlay lets you see exactly when
// rollbacks spike, whether WebRTC is active, and how latency
// behaves during specific in-game situations.
// ============================================================

import type { RollbackManager } from '../game/RollbackManager';
import type { Network } from '../Network';

/** Callback for forfeit action, wired up by Game.ts */
type ForfeitCallback = () => void;

export class NetworkOverlay {
  private _el: HTMLDivElement | null = null;
  private _visible = false;
  private _network: Network;
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _forfeitBtn: HTMLButtonElement | null = null;
  private _onForfeit: ForfeitCallback | null = null;

  // FPS tracking (rolling average over last 60 frames)
  private _fpsSamples: number[] = [];
  private _lastFrameTime = 0;

  constructor(network: Network, onForfeit?: ForfeitCallback) {
    this._network = network;
    this._onForfeit = onForfeit ?? null;
    this._createDOM();
    this._bindToggle();
  }

  private _createDOM(): void {
    const el = document.createElement('div');
    el.id = 'net-debug-overlay';
    el.style.cssText = [
      'position: fixed',
      'top: 8px',
      'right: 8px',
      'background: rgba(0,0,0,0.75)',
      'color: #0f0',
      'font-family: monospace',
      'font-size: 11px',
      'padding: 6px 10px',
      'border-radius: 4px',
      'z-index: 9999',
      'pointer-events: auto',
      'display: none',
      'line-height: 1.5',
      'white-space: pre',
    ].join(';');

    // Forfeit button
    const btn = document.createElement('button');
    btn.textContent = 'FORFEIT';
    btn.style.cssText = [
      'display: block',
      'margin-top: 6px',
      'width: 100%',
      'padding: 4px 8px',
      'background: #a00',
      'color: #fff',
      'border: 1px solid #f44',
      'border-radius: 3px',
      'font-family: monospace',
      'font-size: 11px',
      'cursor: pointer',
    ].join(';');
    btn.addEventListener('click', () => {
      if (this._onForfeit) this._onForfeit();
    });
    this._forfeitBtn = btn;

    el.appendChild(document.createTextNode(''));
    el.appendChild(btn);
    document.body.appendChild(el);
    this._el = el;
  }

  private _bindToggle(): void {
    this._keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'F3') {
        e.preventDefault();
        this._visible = !this._visible;
        if (this._el) {
          this._el.style.display = this._visible ? 'block' : 'none';
        }
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  /** Call every render frame to refresh the overlay content. */
  update(rm: RollbackManager | null, frame: number, inputDelay = 0, engineFps = 0): void {
    if (!this._visible || !this._el) return;

    // FPS tracking — use engine FPS if available, otherwise measure ourselves
    const now = performance.now();
    if (this._lastFrameTime > 0) {
      const dt = now - this._lastFrameTime;
      if (dt > 0) this._fpsSamples.push(1000 / dt);
      if (this._fpsSamples.length > 60) this._fpsSamples.shift();
    }
    this._lastFrameTime = now;

    const fps = engineFps > 0 ? Math.round(engineFps) : this._avgFps();

    const n = this._network;
    const rtt = n.rtt;
    const transport = n.transportType;

    // Color-code RTT
    const rttColor = rtt < 50 ? '#0f0' : rtt < 120 ? '#ff0' : '#f44';

    // Derive soft frame advantage from RTT (same formula as Game.ts)
    const rttFrames = rtt / 16.67;
    const softAdv = Math.max(3, Math.min(8, Math.ceil(rttFrames) + 2));

    let lines = `FPS: ${fps}  RTT: ${rtt}ms`;
    lines += `\nTransport: ${transport.toUpperCase()}`;
    lines += `\nAdvance: ${softAdv}f  Frame: ${frame}  Delay: ${inputDelay}f`;

    if (rm) {
      const d = rm.diag;
      const avgDepth = d.rollbacks > 0 ? (d.rollbackDepthSum / d.rollbacks).toFixed(1) : '0';
      const mispredPct =
        d.predictionsTotal > 0 ? Math.round((d.mispredictions / d.predictionsTotal) * 100) : 0;
      const avgLag = d.inputLagCount > 0 ? (d.inputLagFramesSum / d.inputLagCount).toFixed(1) : '–';

      lines += `\nRollbacks: ${d.rollbacks} (avg ${avgDepth}f)`;
      lines += `\nMisprediction: ${mispredPct}%`;
      lines += `\nRemote Lag: ${avgLag}f  Stalls: ${d.stallFrames}f`;
    }

    // Set text (first child is the text node)
    const textNode = this._el.firstChild;
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      textNode.textContent = lines;
    }

    // Apply RTT color to the whole overlay
    this._el.style.color = rttColor;
    // Forfeit button always white
    if (this._forfeitBtn) this._forfeitBtn.style.color = '#fff';
  }

  private _avgFps(): number {
    if (this._fpsSamples.length === 0) return 0;
    const sum = this._fpsSamples.reduce((a, b) => a + b, 0);
    return Math.round(sum / this._fpsSamples.length);
  }

  dispose(): void {
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
    this._forfeitBtn = null;
  }
}

// ============================================================
// H4KKEN - Entry Point
// ============================================================

import { Game } from './Game';

const game = new Game();

game.init().catch((err) => {
  console.error('Failed to initialize H4KKEN:', err);
  const loadingText = document.getElementById('loading-text');
  if (loadingText) {
    loadingText.textContent = `Error loading game: ${err.message}`;
    loadingText.style.color = '#ff4444';
  }
});

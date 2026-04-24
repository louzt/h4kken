// ============================================================
// H4KKEN - Runtime character metadata
// ============================================================
// Per-character runtime knobs applied on top of the uniformly-built
// <id>.glb assets from scripts/characters.ts. Keep build-time inputs
// (FBX ingestion) separate from presentation/gameplay tweaks (scale,
// display name, thumbnails, future character-select metadata).

import type { AnimKey } from './animations';

interface CharacterMeta {
  /** Must match a build entry id → public/assets/models/<id>.glb */
  id: string;
  /** Display name for UI */
  name: string;
  /** Uniform scale applied to the fighter's root node at runtime */
  scale?: number;
  /** Path to a UI thumbnail (future character-select screen) */
  thumbnail?: string;
  /** Animation cycle shown in the character selection screen */
  selectAnims?: readonly AnimKey[];
}

export const CHARACTERS: Record<string, CharacterMeta> = {
  beano: {
    id: 'beano',
    name: 'Beano',
    scale: 1.0,
  },
  mita: {
    id: 'mita',
    name: 'Mita',
    scale: 0.85,
    selectAnims: ['introSpellIdle', 'victoryYes'],
  },
};

export const DEFAULT_P1 = 'beano';
export const DEFAULT_P2 = 'mita';

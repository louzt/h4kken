import '@babylonjs/core/Audio/audioSceneComponent';
import '@babylonjs/core/Audio/audioEngine';
import { Engine, type Scene, Sound, type Vector3 } from '@babylonjs/core';

const SPATIAL_OPTS = {
  loop: false,
  autoplay: false,
  spatialSound: true,
  distanceModel: 'linear' as const,
  rolloffFactor: 0.1,
  maxDistance: 100,
} as const;

const SPATIAL_LOAD_TIMEOUT_MS = 4000;

function loadSoundWithSoftTimeout(
  name: string,
  url: string,
  scene: Scene,
  options: typeof SPATIAL_OPTS,
  timeoutMs: number,
): Promise<Sound> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (sound: Sound) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(sound);
    };
    const sound = new Sound(name, url, scene, () => finish(sound), options);
    const timeoutId = setTimeout(() => {
      finish(sound);
    }, timeoutMs);
  });
}

const BGM_OPTS = {
  loop: true,
  autoplay: false,
  spatialSound: false,
} as const;

const BGM_MASTER_VOL = 0.5;
const BGM_POWER_VOL = BGM_MASTER_VOL * 1.2;
const BGM_FADE_SEC = 0.4;

let audioUnlockArmed = false;
let audioUnlockHandled = false;

export function armAudioUnlockOnFirstGesture(): void {
  if (audioUnlockArmed || audioUnlockHandled) return;

  const cleanup = () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    audioUnlockArmed = false;
    audioUnlockHandled = true;
  };

  const unlock = () => {
    cleanup();
    const audioEngine = Engine.audioEngine;
    if (!audioEngine) return;
    audioEngine.unlock();
    const ctx = audioEngine.audioContext;
    if (ctx?.state === 'suspended') {
      void ctx.resume().catch(() => {
        // Some browsers still reject resume() until a later gesture.
      });
    }
  };

  audioUnlockArmed = true;
  window.addEventListener('pointerdown', unlock, { capture: true, once: true });
  window.addEventListener('keydown', unlock, { capture: true, once: true });
}

// Both tracks run simultaneously at all times. Crossfading is just volume ramping —
// the tracks never stop, so they stay perfectly time-aligned across loops.
export class BgmManager {
  private _main: Sound | null = null;
  private _power: Sound | null = null;
  private _active: 'main' | 'power' = 'main';
  private _playing = false;
  // play() may be called before the tracks finish decoding on slow mobile devices.
  // If so, we queue the intent and honour it as soon as load() completes.
  private _playPending = false;

  async load(scene: Scene): Promise<void> {
    await Promise.all([
      new Promise<void>((resolve) => {
        this._main = new Sound('bgm_main', '/assets/music/h4kken-m.mp3', scene, resolve, BGM_OPTS);
      }),
      new Promise<void>((resolve) => {
        this._power = new Sound(
          'bgm_power',
          '/assets/music/h4kken-power.mp3',
          scene,
          resolve,
          BGM_OPTS,
        );
      }),
    ]);
    if (this._playPending) {
      this._playPending = false;
      this.play();
    }
  }

  play() {
    if (this._playing) return;
    // Tracks still decoding — remember intent, load() will call us back
    if (!this._main || !this._power) {
      this._playPending = true;
      return;
    }
    this._playing = true;
    this._active = 'main';
    // Volumes set before play() so the gain node is correct from the first sample
    this._main?.setVolume(BGM_MASTER_VOL);
    this._power?.setVolume(0);
    // Start both at once — they will stay frame-aligned for the whole session
    this._main?.play();
    this._power?.play();
  }

  stop() {
    this._playPending = false;
    if (!this._playing) return;
    this._playing = false;
    this._active = 'main'; // next play() always restarts on main
    this._main?.stop();
    this._power?.stop();
  }

  // Fade to a different track. Both tracks keep playing; only gain changes.
  // Sound.setVolume(v, sec) calls Web Audio linearRampToValueAtTime under the hood.
  crossfadeTo(track: 'main' | 'power', fadeSec = BGM_FADE_SEC) {
    if (!this._playing || this._active === track) return;
    this._active = track;
    const [fadeOut, fadeIn] =
      track === 'power' ? [this._main, this._power] : [this._power, this._main];
    const targetVol = track === 'power' ? BGM_POWER_VOL : BGM_MASTER_VOL;
    fadeOut?.setVolume(0, fadeSec);
    fadeIn?.setVolume(targetVol, fadeSec);
  }

  get activeTrack(): 'main' | 'power' {
    return this._active;
  }

  get isPlaying(): boolean {
    return this._playing;
  }

  // TODO delete — dev keybind to test crossfade
  toggleForTest() {
    this.crossfadeTo(this._active === 'main' ? 'power' : 'main');
  }
}

// Flat (non-spatial) sounds use HTMLAudioElement instead of Babylon.js Sound.
// This completely bypasses the Web Audio API AudioBufferSourceNode, which avoids
// a known Babylon.js/Web Audio bug where the BGM's loop:true state can bleed into
// other sounds' source nodes — causing them to loop forever.
const FLAT_MANIFEST: Record<string, string[]> = {
  ko_bell: ['ko_bell.ogg'],
  announce_fight: ['announce_fight.ogg'],
  announce_ready: ['announce_ready.ogg'],
  announce_round1: ['announce_round1.ogg'],
  announce_round2: ['announce_round2.ogg'],
  announce_finalround: ['announce_finalround.ogg'],
  announce_winner: ['announce_winner.ogg'],
  announce_youwin: ['announce_youwin.ogg'],
  announce_time: ['announce_time.ogg'],
  count_3: ['count_3.ogg'],
  count_2: ['count_2.ogg'],
  count_1: ['count_1.ogg'],
};

const SPATIAL_MANIFEST: Record<string, string[]> = {
  hit_heavy: [
    'hit_heavy_000.ogg',
    'hit_heavy_001.ogg',
    'hit_heavy_002.ogg',
    'hit_heavy_003.ogg',
    'hit_heavy_004.ogg',
  ],
  hit_light: ['hit_light_000.ogg', 'hit_light_001.ogg'],
  block: ['block_000.ogg', 'block_001.ogg', 'block_002.ogg'],
};

export class AudioManager {
  private spatialSounds = new Map<string, Sound[]>();
  private flatSounds = new Map<string, HTMLAudioElement[]>();
  private indices = new Map<string, number>();

  async load(scene: Scene): Promise<void> {
    const base = '/assets/sounds/';
    const promises: Promise<void>[] = [];

    for (const [name, files] of Object.entries(SPATIAL_MANIFEST)) {
      const loaded: Sound[] = [];
      for (const file of files) {
        promises.push(
          loadSoundWithSoftTimeout(
            name,
            base + file,
            scene,
            SPATIAL_OPTS,
            SPATIAL_LOAD_TIMEOUT_MS,
          ).then((snd) => {
            loaded.push(snd);
          }),
        );
      }
      this.spatialSounds.set(name, loaded);
    }

    for (const [name, files] of Object.entries(FLAT_MANIFEST)) {
      const loaded: HTMLAudioElement[] = [];
      for (const file of files) {
        const audio = new Audio(base + file);
        audio.preload = 'auto';
        loaded.push(audio);
      }
      this.flatSounds.set(name, loaded);
    }

    await Promise.all(promises);
  }

  private _pickSpatial(name: string): Sound | null {
    const variants = this.spatialSounds.get(name);
    if (!variants || variants.length === 0) return null;
    const prev = this.indices.get(name) ?? -1;
    const next = (prev + 1) % variants.length;
    this.indices.set(name, next);
    return variants[next] ?? null;
  }

  private _pickFlat(name: string): HTMLAudioElement | null {
    const variants = this.flatSounds.get(name);
    if (!variants || variants.length === 0) return null;
    const prev = this.indices.get(name) ?? -1;
    const next = (prev + 1) % variants.length;
    this.indices.set(name, next);
    return variants[next] ?? null;
  }

  // Spatial sound anchored to a world position
  playAt(name: string, pos: Vector3, volume = 1.0) {
    const snd = this._pickSpatial(name);
    if (!snd) return;
    if (!snd.isReady()) return;
    snd.setPosition(pos);
    if (snd.isPlaying) snd.stop();
    snd.setVolume(volume);
    snd.play();
  }

  // Non-spatial (UI / announcer) sound via HTMLAudioElement.
  // HTMLAudioElement never inherits loop state from other audio sources —
  // it uses the browser's native media pipeline, not the Web Audio API graph.
  play(name: string, volume = 1.0) {
    const audio = this._pickFlat(name);
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    audio.loop = false;
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.play().catch(() => {
      // Autoplay may be blocked before first user interaction; silently ignore.
    });
  }
}

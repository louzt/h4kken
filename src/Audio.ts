import '@babylonjs/core/Audio/audioSceneComponent';
import '@babylonjs/core/Audio/audioEngine';
import { type Scene, Sound, type Vector3 } from '@babylonjs/core';

const SPATIAL_OPTS = {
  loop: false,
  autoplay: false,
  spatialSound: true,
  distanceModel: 'linear' as const,
  rolloffFactor: 0.1,
  maxDistance: 100,
} as const;

const FLAT_OPTS = {
  loop: false,
  autoplay: false,
  spatialSound: false,
} as const;

const BGM_OPTS = {
  loop: true,
  autoplay: false,
  spatialSound: false,
} as const;

const BGM_MASTER_VOL = 0.5;
const BGM_POWER_VOL = BGM_MASTER_VOL * 1.2;
const BGM_FADE_SEC = 0.4;

// Both tracks run simultaneously at all times. Crossfading is just volume ramping —
// the tracks never stop, so they stay perfectly time-aligned across loops.
export class BgmManager {
  private _main: Sound | null = null;
  private _power: Sound | null = null;
  private _active: 'main' | 'power' = 'main';
  private _playing = false;

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
  }

  play() {
    if (this._playing) return;
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

const MANIFEST: Record<string, { files: string[]; spatial: boolean }> = {
  hit_heavy: {
    spatial: true,
    files: [
      'hit_heavy_000.ogg',
      'hit_heavy_001.ogg',
      'hit_heavy_002.ogg',
      'hit_heavy_003.ogg',
      'hit_heavy_004.ogg',
    ],
  },
  hit_light: {
    spatial: true,
    files: ['hit_light_000.ogg', 'hit_light_001.ogg'],
  },
  block: {
    spatial: true,
    files: ['block_000.ogg', 'block_001.ogg', 'block_002.ogg'],
  },
  ko_bell: { spatial: false, files: ['ko_bell.ogg'] },
  announce_fight: { spatial: false, files: ['announce_fight.ogg'] },
  announce_ready: { spatial: false, files: ['announce_ready.ogg'] },
  announce_round1: { spatial: false, files: ['announce_round1.ogg'] },
  announce_round2: { spatial: false, files: ['announce_round2.ogg'] },
  announce_finalround: { spatial: false, files: ['announce_finalround.ogg'] },
  announce_winner: { spatial: false, files: ['announce_winner.ogg'] },
  announce_youwin: { spatial: false, files: ['announce_youwin.ogg'] },
  announce_time: { spatial: false, files: ['announce_time.ogg'] },
  count_3: { spatial: false, files: ['count_3.ogg'] },
  count_2: { spatial: false, files: ['count_2.ogg'] },
  count_1: { spatial: false, files: ['count_1.ogg'] },
};

export class AudioManager {
  private sounds = new Map<string, Sound[]>();
  private indices = new Map<string, number>();

  async load(scene: Scene): Promise<void> {
    const base = '/assets/sounds/';
    const promises: Promise<void>[] = [];

    for (const [name, { files, spatial }] of Object.entries(MANIFEST)) {
      const opts = spatial ? SPATIAL_OPTS : FLAT_OPTS;
      const loaded: Sound[] = [];

      for (const file of files) {
        promises.push(
          new Promise<void>((resolve) => {
            const snd = new Sound(name, base + file, scene, resolve, opts);
            loaded.push(snd);
          }),
        );
      }

      this.sounds.set(name, loaded);
    }

    await Promise.all(promises);
  }

  // Round-robin through variants so the same sound doesn't repeat back-to-back
  private _pick(name: string): Sound | null {
    const variants = this.sounds.get(name);
    if (!variants || variants.length === 0) return null;
    const prev = this.indices.get(name) ?? -1;
    const next = (prev + 1) % variants.length;
    this.indices.set(name, next);
    return variants[next] ?? null;
  }

  // Force-reset loop state and kill any stuck playback before starting.
  // Works around a Web Audio / Babylon.js edge case where the underlying
  // AudioBufferSourceNode can get stuck in loop mode after audio-context
  // suspend/resume cycles (tab backgrounding, high-latency reconnects).
  private _safePlay(snd: Sound, volume: number) {
    if (snd.isPlaying) snd.stop();
    snd.loop = false;
    snd.setVolume(volume);
    snd.play();
  }

  // Spatial sound anchored to a world position
  playAt(name: string, pos: Vector3, volume = 1.0) {
    const snd = this._pick(name);
    if (!snd) return;
    snd.setPosition(pos);
    this._safePlay(snd, volume);
  }

  // Non-spatial (UI / announcer) sound
  play(name: string, volume = 1.0) {
    const snd = this._pick(name);
    if (!snd) return;
    this._safePlay(snd, volume);
  }
}

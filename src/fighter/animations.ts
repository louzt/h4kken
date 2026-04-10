// ============================================================
// H4KKEN - Animation Data
// Typed clip name unions + ANIM_CONFIG + pools
// ============================================================

// Typed unions of every clip in each GLB. Using these in AnimConfig.glb gives
// compile-time errors when a clip name is misspelled or doesn't exist.
const UAL1_CLIPS = [
  'A_TPose',
  'BackFlip',
  'Celebration',
  'Crawl_Bwd_Loop',
  'Crawl_Enter',
  'Crawl_Exit',
  'Crawl_Fwd_Loop',
  'Crawl_Idle_Loop',
  'Crawl_Left_Loop',
  'Crawl_Right_Loop',
  'Crouch_Bwd_Loop',
  'Crouch_Enter',
  'Crouch_Exit',
  'Crouch_Fwd_Loop',
  'Crouch_Idle_Loop',
  'Crying',
  'Dance_Loop',
  'Death01',
  'Death02',
  'Dodge_Left',
  'Dodge_Right',
  'Drink',
  'Fixing_Kneeling',
  'GroundSit_Enter',
  'GroundSit_Exit',
  'GroundSit_Idle_Loop',
  'Hit_Chest',
  'Hit_Head',
  'Hit_Shoulder_L',
  'Hit_Shoulder_R',
  'Hit_Stomach',
  'Idle_LookAround_Loop',
  'Idle_Loop',
  'Idle_Talking_Loop',
  'Idle_Tired_Loop',
  'Interact',
  'Jog_Bwd_Loop',
  'Jog_Fwd_Loop',
  'Jog_Left_Loop',
  'Jog_Right_Loop',
  'Jump_Land',
  'Jump_Loop',
  'Jump_Start',
  'Kick',
  'Punch_Cross',
  'Punch_Jab',
  'PunchKick_Enter',
  'PunchKick_Exit',
  'Roll',
  'Sprint_Loop',
  'Spell_Double_Enter',
  'Spell_Double_Exit',
  'Spell_Double_Idle_Loop',
  'Spell_Double_Shoot_Loop',
  'Turn90_L',
  'Turn90_R',
  'Walk_Loop',
] as const;

const UAL2_CLIPS = [
  'Hit_Knockback',
  'Idle_FoldArms_Loop',
  'Idle_No_Loop',
  'IdleToLay',
  'KipUp',
  'LayToIdle',
  'LiftAir_Fall_Impact',
  'LiftAir_Hit_L',
  'LiftAir_Hit_R',
  'Melee_Combo',
  'MonsterTransformation',
  'Melee_Hook',
  'Melee_Hook_Rec',
  'Melee_Knee',
  'Melee_Knee_Rec',
  'Melee_Uppercut',
  'Slide_Exit',
  'Slide_Loop',
  'Slide_Start',
  'Walk_Bwd_Loop',
  'Walk_Fwd_Loop',
  'Yes',
] as const;

type Ual1Clip = (typeof UAL1_CLIPS)[number];
type Ual2Clip = (typeof UAL2_CLIPS)[number];
type AnimClip = Ual1Clip | Ual2Clip;

// Animation configuration table — single source of truth for all animation bindings.
// glb:   exact clip name inside the GLB (typed — typos are compile errors)
// src:   'ual1' = character.glb (default), 'ual2' = UAL2.glb
// loop:  whether the clip loops (default false)
// speed: playback speed multiplier (default 1.0)
// blend: crossfade blend duration in seconds (default 0.15)
export interface AnimConfig {
  glb: AnimClip;
  src?: 'ual1' | 'ual2';
  loop?: boolean;
  speed?: number;
  blend?: number;
}

export const ANIM_CONFIG = {
  // ── Idle / neutral ──────────────────────────────────────────────────────
  idle: { glb: 'Idle_Loop', loop: true, blend: 0.2 },
  combatIdle: { glb: 'Idle_Loop', loop: true, blend: 0.2 },
  // ── Crouch ──────────────────────────────────────────────────────────────
  crouchIdle: { glb: 'Crouch_Idle_Loop', loop: true, blend: 0.15 },
  crouchEnter: { glb: 'Crouch_Enter', speed: 4.0, blend: 0.1 },
  crouchExit: { glb: 'Crouch_Exit', speed: 4.0, blend: 0.1 },
  crouchWalk: { glb: 'Crouch_Fwd_Loop', loop: true, blend: 0.2 },
  crouchWalkBack: { glb: 'Crouch_Bwd_Loop', loop: true, blend: 0.2 },
  // ── Locomotion ──────────────────────────────────────────────────────────
  walk: { glb: 'Walk_Loop', loop: true, blend: 0.2 },
  // UAL2 Walk_Bwd_Loop is a proper backward walk; Jog_Bwd_Loop looked like running
  walkBack: { glb: 'Walk_Bwd_Loop', src: 'ual2', loop: true, blend: 0.2 },
  walkLeft: { glb: 'Jog_Left_Loop', loop: true, blend: 0.2 },
  walkRight: { glb: 'Jog_Right_Loop', loop: true, blend: 0.2 },
  run: { glb: 'Jog_Fwd_Loop', loop: true, blend: 0.2 },
  runBack: { glb: 'Jog_Bwd_Loop', loop: true, speed: 1.5, blend: 0.1 },
  sprint: { glb: 'Sprint_Loop', loop: true, blend: 0.15 },
  // ── Air ─────────────────────────────────────────────────────────────────
  // jumpSquat plays a fast crouch anticipation (visual only, physics starts immediately)
  jumpSquat: { glb: 'Crouch_Enter', speed: 6.0, blend: 0.05 },
  jump: { glb: 'Jump_Start', blend: 0.1 },
  falling: { glb: 'Jump_Loop', loop: true, blend: 0.1 },
  juggleLand: { glb: 'LiftAir_Fall_Impact', src: 'ual2', blend: 0.05 },
  landing: { glb: 'Jump_Land', blend: 0.1 },
  // ── Attacks ─────────────────────────────────────────────────────────────
  // speed for attacks is auto-calculated from frame data in startAttack()
  punch1: { glb: 'Punch_Jab', blend: 0.1 },
  punch2: { glb: 'Punch_Cross', blend: 0.1 },
  heavyPunch: { glb: 'Melee_Hook', src: 'ual2', blend: 0.1 },
  meleeUppercut: { glb: 'Melee_Uppercut', src: 'ual2', blend: 0.08 },
  meleeKnee: { glb: 'Melee_Knee', src: 'ual2', blend: 0.08 },
  kickRight: { glb: 'Kick', blend: 0.08 },
  kickLeft: { glb: 'Kick', blend: 0.08 },
  lowKick: { glb: 'Kick', blend: 0.08 },
  sweepKick: { glb: 'Kick', blend: 0.08 },
  // ── Sidestep / dodge ────────────────────────────────────────────────────
  dodgeLeft: { glb: 'Dodge_Left', blend: 0.1 },
  dodgeRight: { glb: 'Dodge_Right', blend: 0.1 },
  // ── Block ────────────────────────────────────────────────────────────────
  block: { glb: 'PunchKick_Enter', blend: 0.06 },
  blockExit: { glb: 'PunchKick_Exit', blend: 0.1 },
  // ── Hit reactions — light (body shots) ──────────────────────────────────
  hurt1: { glb: 'Hit_Chest', blend: 0.05 },
  hurt2: { glb: 'Hit_Head', blend: 0.05 },
  hurt3: { glb: 'Hit_Stomach', blend: 0.05 },
  hurt4: { glb: 'Hit_Shoulder_L', blend: 0.05 },
  hurt5: { glb: 'Hit_Shoulder_R', blend: 0.05 },
  // ── Hit reactions — heavy / airborne (UAL2) ─────────────────────────────
  hurtHeavy: { glb: 'Hit_Knockback', src: 'ual2', blend: 0.04 },
  hurtAir1: { glb: 'LiftAir_Hit_L', src: 'ual2', blend: 0.04 },
  hurtAir2: { glb: 'LiftAir_Hit_R', src: 'ual2', blend: 0.04 },
  // ── Get-up ───────────────────────────────────────────────────────────────
  kipUp: { glb: 'KipUp', src: 'ual2', blend: 0.15 },
  // ── Win / loss ──────────────────────────────────────────────────────────
  defeat: { glb: 'Death01', blend: 0.2 },
  defeatBig: { glb: 'Death02', blend: 0.2 },
  defeatMatch: { glb: 'Crying', blend: 0.3 },
  victory: { glb: 'Dance_Loop', loop: true, blend: 0.2 },
  victoryBackflip: { glb: 'BackFlip', blend: 0.2 },
  victoryCelebrate: { glb: 'Celebration', blend: 0.2 },
  victoryYes: { glb: 'Yes', src: 'ual2', blend: 0.2 },
  victorySmug: { glb: 'Idle_FoldArms_Loop', src: 'ual2', loop: true, blend: 0.3 },
  // ── Pre-fight intro / taunt animations ──────────────────────────────────
  introDrink: { glb: 'Drink', blend: 0.2 },
  introGroundSitEnter: { glb: 'GroundSit_Enter', blend: 0.2 },
  introGroundSitIdle: { glb: 'GroundSit_Idle_Loop', loop: true, blend: 0.1 },
  introGroundSitExit: { glb: 'GroundSit_Exit', blend: 0.1 },
  introTalking: { glb: 'Idle_Talking_Loop', loop: true, blend: 0.2 },
  introInteract: { glb: 'Interact', blend: 0.2 },
  introPunchKick: { glb: 'PunchKick_Enter', blend: 0.2 },
  introSpellEnter: { glb: 'Spell_Double_Enter', blend: 0.2 },
  introSpellIdle: { glb: 'Spell_Double_Idle_Loop', loop: true, blend: 0.1 },
  introSpellExit: { glb: 'Spell_Double_Exit', blend: 0.1 },
  introFixing: { glb: 'Fixing_Kneeling', blend: 0.2 },
  // ── Super Power ─────────────────────────────────────────────────────────────
  superActivate: { glb: 'MonsterTransformation', src: 'ual2', blend: 0.1 },
} satisfies Record<string, AnimConfig>;

export type AnimKey = keyof typeof ANIM_CONFIG;

export const ANIM_POOLS = {
  hurtLight: ['hurt1', 'hurt3', 'hurt4', 'hurt5'] as AnimKey[],
  hurtAir: ['hurtAir1', 'hurtAir2'] as AnimKey[],
  victory: [
    'victory',
    'victoryBackflip',
    'victoryCelebrate',
    'victoryYes',
    'victorySmug',
  ] as AnimKey[],
  intro: [
    'introDrink',
    'introGroundSitEnter',
    'introTalking',
    'introInteract',
    'introPunchKick',
    'introSpellEnter',
    'introFixing',
  ] as AnimKey[],
};

export function pickRandom<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)] as T;
}

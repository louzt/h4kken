import type { InputState } from '../Input';

// Binary message opcodes
export const OP = {
  SYNC_INPUT: 0x01, // client → server
  OPPONENT_SYNC_INPUT: 0x02, // server → client
} as const;

// Bit positions — 22 bits, fits in a uint32
const B = {
  up: 0,
  down: 1,
  left: 2,
  right: 3,
  block: 4,
  lp: 5,
  rp: 6,
  lk: 7,
  rk: 8,
  upJust: 9,
  downJust: 10,
  leftJust: 11,
  rightJust: 12,
  lpJust: 13,
  rpJust: 14,
  lkJust: 15,
  rkJust: 16,
  sideStepUp: 17,
  sideStepDown: 18,
  dashLeft: 19,
  dashRight: 20,
  superJust: 21,
} as const;

function encodeInput(input: InputState): number {
  let bits = 0;
  for (const [key, bit] of Object.entries(B)) {
    if (input[key as keyof typeof B]) bits |= 1 << bit;
  }
  return bits;
}

function decodeInput(bits: number): InputState {
  return {
    up: !!(bits & (1 << B.up)),
    down: !!(bits & (1 << B.down)),
    left: !!(bits & (1 << B.left)),
    right: !!(bits & (1 << B.right)),
    block: !!(bits & (1 << B.block)),
    lp: !!(bits & (1 << B.lp)),
    rp: !!(bits & (1 << B.rp)),
    lk: !!(bits & (1 << B.lk)),
    rk: !!(bits & (1 << B.rk)),
    upJust: !!(bits & (1 << B.upJust)),
    downJust: !!(bits & (1 << B.downJust)),
    leftJust: !!(bits & (1 << B.leftJust)),
    rightJust: !!(bits & (1 << B.rightJust)),
    lpJust: !!(bits & (1 << B.lpJust)),
    rpJust: !!(bits & (1 << B.rpJust)),
    lkJust: !!(bits & (1 << B.lkJust)),
    rkJust: !!(bits & (1 << B.rkJust)),
    sideStepUp: !!(bits & (1 << B.sideStepUp)),
    sideStepDown: !!(bits & (1 << B.sideStepDown)),
    dashLeft: !!(bits & (1 << B.dashLeft)),
    dashRight: !!(bits & (1 << B.dashRight)),
    superJust: !!(bits & (1 << B.superJust)),
  };
}

// Wire format: [1 byte opcode][3 bytes frame uint24 BE][4 bytes bitmask uint32 BE] = 8 bytes

export function encodeSyncInput(targetFrame: number, input: InputState): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint8(0, OP.SYNC_INPUT);
  v.setUint8(1, (targetFrame >> 16) & 0xff);
  v.setUint8(2, (targetFrame >> 8) & 0xff);
  v.setUint8(3, targetFrame & 0xff);
  v.setUint32(4, encodeInput(input), false);
  return buf;
}

export function decodeSyncInput(buf: ArrayBuffer): { targetFrame: number; input: InputState } {
  const v = new DataView(buf);
  const targetFrame = (v.getUint8(1) << 16) | (v.getUint8(2) << 8) | v.getUint8(3);
  return { targetFrame, input: decodeInput(v.getUint32(4, false)) };
}

// ============================================================
// H4KKEN - Network Client
// ============================================================

import type { AnimKey } from './fighter/animations';
import { decodeSyncInput, encodeSyncInput, OP } from './game/InputCodec';
import type { InputState } from './Input';

// ── Inbound messages (server → client) ──────────────────────

interface MatchedMsg {
  type: 'matched';
  playerIndex: number;
  opponentName: string;
  roomId: string;
}

interface CountdownMsg {
  type: 'countdown';
  count: number;
}

interface OpponentInputMsg {
  type: 'opponentInput';
  input: InputState;
  frame: number;
}

interface GameStateMsg {
  type: 'gameState';
  frame: number;
  state: {
    p1: FighterStateSync;
    p2: FighterStateSync;
    timer: number;
    round: number;
  };
}

interface RoundResultMsg {
  type: 'roundResult';
  winner: number;
  p1Wins: number;
  p2Wins: number;
  matchOver: boolean;
  victoryAnim: AnimKey;
  defeatAnim: AnimKey;
}

interface SuperActivatedMsg {
  type: 'superActivated';
  playerIndex: number;
}

interface ErrorMsg {
  type: 'error';
  message: string;
}

interface OpponentSyncInputMsg {
  type: 'opponentSyncInput';
  targetFrame: number;
  input: InputState;
}

interface PongMsg {
  type: 'pong';
  t: number;
}

interface SimpleMsg {
  type: 'waiting' | 'fight' | 'opponentLeft';
}

type ServerMessage =
  | SimpleMsg
  | PongMsg
  | MatchedMsg
  | CountdownMsg
  | OpponentInputMsg
  | OpponentSyncInputMsg
  | GameStateMsg
  | RoundResultMsg
  | SuperActivatedMsg
  | ErrorMsg;

// Serialized fighter state used for network sync
export interface FighterStateSync {
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  state: string;
  facing: number;
  facingAngle: number;
  health: number;
  moveId: string | null;
  moveFrame: number;
  hasHitThisMove: boolean;
  isCrouching: boolean;
  isBlocking: boolean;
  comboCount: number;
  comboDamage: number;
  stunFrames: number;
  wins: number;
  superMeter: number;
  superPowerActive: boolean;
  currentAnimKey: string;
}

// ── Outbound messages (client → server) ─────────────────────

type JoinMsg = { type: 'join'; name: string };
type PingMsg = { type: 'ping'; t: number };
type RoundResultOutMsg = {
  type: 'roundResult';
  winner: number;
  p1Wins: number;
  p2Wins: number;
  matchOver: boolean;
  victoryAnim: AnimKey;
  defeatAnim: AnimKey;
};
type LeaveMsg = { type: 'leave' };

type ClientMessage = JoinMsg | PingMsg | RoundResultOutMsg | LeaveMsg;

// ── Event handler map ────────────────────────────────────────

type HandlerMap = {
  waiting: () => void;
  fight: () => void;
  opponentLeft: () => void;
  disconnected: () => void;
  matched: (msg: MatchedMsg) => void;
  countdown: (msg: CountdownMsg) => void;
  opponentInput: (msg: OpponentInputMsg) => void;
  opponentSyncInput: (msg: OpponentSyncInputMsg) => void;
  gameState: (msg: GameStateMsg) => void;
  roundResult: (msg: RoundResultMsg) => void;
  superActivated: (msg: SuperActivatedMsg) => void;
  error: (msg: ErrorMsg) => void;
};

type EventName = keyof HandlerMap;

export class Network {
  ws: WebSocket | null;
  connected: boolean;
  playerIndex: number;
  opponentName: string;
  roomId: string | null;
  rtt = 0;
  private handlers: { [K in EventName]?: Array<HandlerMap[K]> };
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.ws = null;
    this.connected = false;
    this.playerIndex = -1;
    this.opponentName = '';
    this.roomId = null;
    this.handlers = {};
  }

  on<K extends EventName>(event: K, handler: HandlerMap[K]) {
    if (!this.handlers[event]) {
      this.handlers[event] = [] as NonNullable<(typeof this.handlers)[K]>;
    }
    (this.handlers[event] as Array<HandlerMap[K]>).push(handler);
  }

  private emit<K extends EventName>(event: K, ...args: Parameters<HandlerMap[K]>) {
    const list = this.handlers[event] as
      | Array<(...a: Parameters<HandlerMap[K]>) => void>
      | undefined;
    if (list)
      list.forEach((h) => {
        h(...args);
      });
  }

  connect() {
    return new Promise<void>((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.connected = true;
        this.startPing();
        resolve();
      };

      this.ws.onclose = () => {
        this.connected = false;
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = null;
        this.emit('disconnected');
      };

      this.ws.onerror = (err) => {
        reject(err);
      };

      this.ws.binaryType = 'arraybuffer';
      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.handleBinaryMessage(event.data);
          return;
        }
        const msg = JSON.parse(event.data as string) as ServerMessage;
        this.handleMessage(msg);
      };
    });
  }

  private handleBinaryMessage(buf: ArrayBuffer) {
    const opcode = new DataView(buf).getUint8(0);
    if (opcode === OP.OPPONENT_SYNC_INPUT) {
      const { targetFrame, input } = decodeSyncInput(buf);
      this.emit('opponentSyncInput', { type: 'opponentSyncInput', targetFrame, input });
    }
  }

  private startPing() {
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping', t: Date.now() } as ClientMessage);
    }, 2000);
  }

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'pong':
        this.rtt = Date.now() - msg.t;
        break;
      case 'waiting':
        this.emit('waiting');
        break;
      case 'matched':
        this.playerIndex = msg.playerIndex;
        this.opponentName = msg.opponentName;
        this.roomId = msg.roomId;
        this.emit('matched', msg);
        break;
      case 'countdown':
        this.emit('countdown', msg);
        break;
      case 'fight':
        this.emit('fight');
        break;
      case 'opponentInput':
        this.emit('opponentInput', msg);
        break;
      case 'opponentSyncInput':
        this.emit('opponentSyncInput', msg);
        break;
      case 'gameState':
        this.emit('gameState', msg);
        break;
      case 'roundResult':
        this.emit('roundResult', msg);
        break;
      case 'superActivated':
        this.emit('superActivated', msg);
        break;
      case 'opponentLeft':
        this.emit('opponentLeft');
        break;
      case 'error':
        this.emit('error', msg);
        break;
    }
  }

  private send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  joinMatch(name: string) {
    this.send({ type: 'join', name });
  }

  sendSyncInput(targetFrame: number, input: InputState) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeSyncInput(targetFrame, input));
    }
  }

  sendRoundResult(
    winner: number,
    p1Wins: number,
    p2Wins: number,
    matchOver: boolean,
    victoryAnim: AnimKey,
    defeatAnim: AnimKey,
  ) {
    this.send({ type: 'roundResult', winner, p1Wins, p2Wins, matchOver, victoryAnim, defeatAnim });
  }

  leave() {
    this.send({ type: 'leave' });
    this.playerIndex = -1;
    this.roomId = null;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

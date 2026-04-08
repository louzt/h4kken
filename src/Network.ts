// ============================================================
// H4KKEN - Network Client
// ============================================================

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
}

interface ErrorMsg {
  type: 'error';
  message: string;
}

interface SimpleMsg {
  type: 'waiting' | 'fight' | 'opponentLeft';
}

type ServerMessage =
  | SimpleMsg
  | MatchedMsg
  | CountdownMsg
  | OpponentInputMsg
  | GameStateMsg
  | RoundResultMsg
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
}

// ── Outbound messages (client → server) ─────────────────────

type JoinMsg = { type: 'join'; name: string };
type InputMsg = { type: 'input'; frame: number; input: InputState };
type GameStateOutMsg = {
  type: 'gameState';
  frame: number;
  state: { p1: FighterStateSync; p2: FighterStateSync; timer: number; round: number };
};
type RoundResultOutMsg = {
  type: 'roundResult';
  winner: number;
  p1Wins: number;
  p2Wins: number;
  matchOver: boolean;
};
type LeaveMsg = { type: 'leave' };

type ClientMessage = JoinMsg | InputMsg | GameStateOutMsg | RoundResultOutMsg | LeaveMsg;

// ── Event handler map ────────────────────────────────────────

type HandlerMap = {
  waiting: () => void;
  fight: () => void;
  opponentLeft: () => void;
  disconnected: () => void;
  matched: (msg: MatchedMsg) => void;
  countdown: (msg: CountdownMsg) => void;
  opponentInput: (msg: OpponentInputMsg) => void;
  gameState: (msg: GameStateMsg) => void;
  roundResult: (msg: RoundResultMsg) => void;
  error: (msg: ErrorMsg) => void;
};

type EventName = keyof HandlerMap;

export class Network {
  ws: WebSocket | null;
  connected: boolean;
  playerIndex: number;
  opponentName: string;
  roomId: string | null;
  private handlers: { [K in EventName]?: Array<HandlerMap[K]> };

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
        resolve();
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.emit('disconnected');
      };

      this.ws.onerror = (err) => {
        reject(err);
      };

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        this.handleMessage(msg);
      };
    });
  }

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
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
      case 'gameState':
        this.emit('gameState', msg);
        break;
      case 'roundResult':
        this.emit('roundResult', msg);
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

  sendInput(frame: number, input: InputState) {
    this.send({ type: 'input', frame, input });
  }

  sendGameState(frame: number, state: GameStateOutMsg['state']) {
    this.send({ type: 'gameState', frame, state });
  }

  sendRoundResult(winner: number, p1Wins: number, p2Wins: number, matchOver: boolean) {
    this.send({ type: 'roundResult', winner, p1Wins, p2Wins, matchOver });
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

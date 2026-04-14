// ============================================================
// H4KKEN - Network Client
// ============================================================
// Manages WebSocket connection to the game server and optionally
// upgrades the binary input path to WebRTC DataChannel (UDP) for
// lower latency on lossy connections. JSON messages (matchmaking,
// round results, etc.) always use WebSocket for reliability.
//
// [Ref: VALVE-LAG] Binary input codec mirrors Valve's usercmd_t structure
// [Ref: RFC8831] Dual transport: WS (reliable/ordered) + DC (unreliable/unordered)
// [Ref: YCOMBINATOR] Architecture follows Gambetta's client-server game architecture pattern
// ============================================================

import type { AnimKey } from './fighter/animations';
import { decodeSyncInput, encodeSyncInput, OP } from './game/InputCodec';
import type { InputState } from './Input';
import type { IGameTransport } from './transport/Transport';
import { WebSocketTransport } from './transport/Transport';
import type { IceServerConfig } from './transport/WebRTCTransport';
import { WebRTCTransport } from './transport/WebRTCTransport';

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

// WebRTC signaling messages relayed by the server between matched peers
interface RtcOfferMsg {
  type: 'rtc-offer';
  sdp: string;
}
interface RtcAnswerMsg {
  type: 'rtc-answer';
  sdp: string;
}
interface RtcIceMsg {
  type: 'rtc-ice';
  candidate: string;
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
  | ErrorMsg
  | RtcOfferMsg
  | RtcAnswerMsg
  | RtcIceMsg;

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
// WebRTC signaling messages sent via WebSocket to be relayed to the matched peer
type RtcOfferOutMsg = { type: 'rtc-offer'; sdp: string };
type RtcAnswerOutMsg = { type: 'rtc-answer'; sdp: string };
type RtcIceOutMsg = { type: 'rtc-ice'; candidate: string };

type ClientMessage =
  | JoinMsg
  | PingMsg
  | RoundResultOutMsg
  | LeaveMsg
  | RtcOfferOutMsg
  | RtcAnswerOutMsg
  | RtcIceOutMsg;

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

// Default STUN servers — always available for basic NAT traversal.
const DEFAULT_STUN: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** Fetch ephemeral TURN credentials from the game server (if configured). */
async function fetchIceServers(): Promise<IceServerConfig[]> {
  try {
    const res = await fetch('/api/turn-credentials');
    const data = (await res.json()) as { iceServers: IceServerConfig[] };
    if (data.iceServers.length > 0) {
      console.log('[ICE] Using self-hosted TURN relay');
      return [...DEFAULT_STUN, ...data.iceServers];
    }
  } catch {
    console.warn('[ICE] Failed to fetch TURN credentials — STUN only');
  }
  return DEFAULT_STUN;
}

export class Network {
  ws: WebSocket | null;
  connected: boolean;
  playerIndex: number;
  opponentName: string;
  roomId: string | null;
  rtt = 0;
  private handlers: { [K in EventName]?: Array<HandlerMap[K]> };
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  // ── Transport layer (WebRTC upgrade over WebSocket) ────────
  // Binary game inputs (8-byte syncInput packets) are routed through
  // _activeTransport. Starts as WebSocket, upgrades to WebRTC DataChannel
  // when the peer-to-peer handshake succeeds. Falls back automatically.
  private _wsTransport: WebSocketTransport | null = null;
  private _rtcTransport: WebRTCTransport | null = null;
  private _activeTransport: IGameTransport | null = null;

  /** Current transport type for diagnostics display. */
  get transportType(): 'websocket' | 'webrtc' {
    return this._activeTransport?.type ?? 'websocket';
  }

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
        // Initiate WebRTC upgrade in the background — game starts on WS immediately.
        // playerIndex=0 is always the offerer for deterministic role assignment.
        this._initiateWebRTC();
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
        this._cleanupWebRTC();
        this.emit('opponentLeft');
        break;
      case 'error':
        this.emit('error', msg);
        break;
      // WebRTC signaling: relay SDP offers/answers and ICE candidates
      case 'rtc-offer':
        this._handleRtcOffer(msg.sdp);
        break;
      case 'rtc-answer':
        this._handleRtcAnswer(msg.sdp);
        break;
      case 'rtc-ice':
        this._handleRtcIce(msg.candidate);
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
    // Route binary input through the active transport (WebRTC if available, WS otherwise).
    // The 8-byte binary format from InputCodec is used on both transports.
    const buf = encodeSyncInput(targetFrame, input);
    if (this._activeTransport?.ready) {
      this._activeTransport.send(buf);
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
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
    this._cleanupWebRTC();
    this.playerIndex = -1;
    this.roomId = null;
  }

  disconnect() {
    this._cleanupWebRTC();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── WebRTC upgrade lifecycle ──────────────────────────────
  // After a match is found, we attempt to establish a peer-to-peer
  // DataChannel for binary input packets (UDP semantics, no head-of-line
  // blocking). The game starts immediately on WebSocket — WebRTC is a
  // background upgrade. If it fails or closes, we fall back to WS.

  private async _initiateWebRTC(): Promise<void> {
    // Clean up any previous WebRTC session
    this._cleanupWebRTC();

    // Set up WS transport wrapper (used as fallback and initial transport)
    if (this.ws) {
      this._wsTransport = new WebSocketTransport(this.ws);
      this._activeTransport = this._wsTransport;
    }

    // Check if WebRTC is available in this browser
    if (typeof RTCPeerConnection === 'undefined') {
      console.log('[WebRTC] Not available in this browser — using WebSocket');
      return;
    }

    const signaling = {
      sendOffer: (sdp: string) => this.send({ type: 'rtc-offer', sdp }),
      sendAnswer: (sdp: string) => this.send({ type: 'rtc-answer', sdp }),
      sendIceCandidate: (candidate: string) => this.send({ type: 'rtc-ice', candidate }),
    };

    const iceServers = await fetchIceServers();
    this._rtcTransport = new WebRTCTransport(iceServers, signaling);

    // When DataChannel opens, switch binary path from WS to WebRTC
    this._rtcTransport.events.onOpen = () => {
      if (this._rtcTransport) {
        this._rtcTransport.onMessage = (buf: ArrayBuffer) => this.handleBinaryMessage(buf);
        this._activeTransport = this._rtcTransport;
        console.log('[NET] Binary input path upgraded to WebRTC (UDP)');
      }
    };

    // When DataChannel closes, fall back to WS
    this._rtcTransport.events.onClose = () => {
      if (this._activeTransport?.type === 'webrtc') {
        this._activeTransport = this._wsTransport;
        console.log('[NET] Fell back to WebSocket transport');
      }
    };

    // playerIndex=0 is always the offerer (deterministic)
    if (this.playerIndex === 0) {
      this._rtcTransport.initiateOffer().catch((err) => {
        console.warn('[WebRTC] Offer failed:', err);
      });
    }
    // playerIndex=1 waits for the offer via _handleRtcOffer()
  }

  private _handleRtcOffer(sdp: string): void {
    if (!this._rtcTransport) return;
    this._rtcTransport.handleOffer(sdp).catch((err) => {
      console.warn('[WebRTC] Handle offer failed:', err);
    });
  }

  private _handleRtcAnswer(sdp: string): void {
    if (!this._rtcTransport) return;
    this._rtcTransport.handleAnswer(sdp).catch((err) => {
      console.warn('[WebRTC] Handle answer failed:', err);
    });
  }

  private _handleRtcIce(candidate: string): void {
    if (!this._rtcTransport) return;
    this._rtcTransport.handleIceCandidate(candidate).catch((err) => {
      console.warn('[WebRTC] ICE candidate failed:', err);
    });
  }

  private _cleanupWebRTC(): void {
    if (this._rtcTransport) {
      this._rtcTransport.close();
      this._rtcTransport = null;
    }
    // Reset active transport to WS
    this._activeTransport = this._wsTransport;
  }
}

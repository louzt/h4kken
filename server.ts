import crypto from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
// Vite proxies /ws in dev; in production the WS server listens on /ws directly
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;

app.use(express.json());
// In production __dirname = dist/, so client assets are in dist/client/
app.use(express.static(path.join(__dirname, 'client')));

// ── Health endpoint — used by reverse proxies and monitoring ────
const startTime = Date.now();
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    rooms: rooms.size,
    waiting: waitingPlayers.length,
    connections: wss.clients.size,
  });
});

// ── TURN credentials endpoint (time-limited HMAC) ──────────────
// Returns ephemeral credentials for coturn (RFC 5389 long-term auth).
// Clients call this before creating a PeerConnection.
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_REALM = process.env.TURN_REALM || '';
const TURN_PORT = process.env.TURN_PORT || '3478';
const TURN_TLS_PORT = process.env.TURN_TLS_PORT || '5349';

app.get('/api/turn-credentials', async (_req, res) => {
  if (TURN_SECRET && TURN_REALM) {
    // Self-hosted coturn — preferred (no bandwidth cap, lowest latency)
    const ttl = 86400;
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:h4kken`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');

    res.json({
      iceServers: [
        {
          urls: [
            `turn:${TURN_REALM}:${TURN_PORT}?transport=udp`,
            `turn:${TURN_REALM}:${TURN_PORT}?transport=tcp`,
            `turns:${TURN_REALM}:${TURN_TLS_PORT}?transport=tcp`,
          ],
          username,
          credential,
        },
      ],
      source: 'coturn',
    });
    return;
  }

  // No TURN configured — clients rely on STUN only for direct P2P.
  res.json({ iceServers: [], source: 'stun-only' });
});

app.post('/api/debug', (req, res) => {
  const lines = req.body.lines || [];
  lines.forEach((l: string) => {
    console.log('[BROWSER]', l);
  });
  res.json({ ok: true });
});

interface PlayerInfo {
  ws: import('ws').WebSocket;
  name: string;
  characterId: string;
  roomId: string | null;
  playerIndex: number | null;
}

interface ClientMessage {
  type: string;
  name?: string;
  characterId?: string;
  frame?: number;
  targetFrame?: number;
  input?: unknown;
  state?: unknown;
  winner?: number;
  p1Wins?: number;
  p2Wins?: number;
  matchOver?: boolean;
  victoryAnim?: string;
  defeatAnim?: string;
  playerIndex?: number;
  t?: number;
  // WebRTC signaling fields — server relays these between matched players
  // without processing them. SDP contains session descriptions for the
  // peer connection; candidate contains ICE candidates for NAT traversal.
  sdp?: string;
  candidate?: string;
}

interface Room {
  id: string;
  players: [PlayerInfo, PlayerInfo];
  state: 'lobby' | 'countdown' | 'fighting' | 'roundEnd' | 'matchEnd';
  countdownTimer: ReturnType<typeof setTimeout> | null;
  pendingRoundResults: [ClientMessage | null, ClientMessage | null];
  roundResultTimeout: ReturnType<typeof setTimeout> | null;
  lobbyReady: [boolean, boolean];
}

const waitingPlayers: PlayerInfo[] = [];
const rooms = new Map<string, Room>();
let roomIdCounter = 1;

function generateRoomId() {
  return `room_${roomIdCounter++}`;
}

function createRoom(player1: PlayerInfo, player2: PlayerInfo): Room {
  const roomId = generateRoomId();
  const room: Room = {
    id: roomId,
    players: [player1, player2],
    state: 'lobby',
    countdownTimer: null,
    pendingRoundResults: [null, null],
    roundResultTimeout: null,
    lobbyReady: [false, false],
  };
  rooms.set(roomId, room);
  player1.roomId = roomId;
  player1.playerIndex = 0;
  player2.roomId = roomId;
  player2.playerIndex = 1;
  return room;
}

function destroyRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.players.forEach((p) => {
    if (p?.ws && p.ws.readyState === 1) {
      p.roomId = null;
      p.playerIndex = null;
    }
  });

  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  if (room.roundResultTimeout) clearTimeout(room.roundResultTimeout);
  rooms.delete(roomId);
}

function sendTo(playerInfo: PlayerInfo, message: object) {
  if (playerInfo?.ws && playerInfo.ws.readyState === 1) {
    playerInfo.ws.send(JSON.stringify(message));
  }
}

function broadcastToRoom(room: Room, message: object) {
  room.players.forEach((p) => {
    sendTo(p, message);
  });
}

function startCountdown(room: Room) {
  // Kill any in-flight countdown chain before starting a new one
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
  }
  room.state = 'countdown';
  let count = 3;

  function tick() {
    broadcastToRoom(room, { type: 'countdown', count });
    if (count <= 0) {
      room.state = 'fighting';
      broadcastToRoom(room, { type: 'fight' });
      return;
    }
    count--;
    room.countdownTimer = setTimeout(tick, 1000);
  }
  tick();
}

function handleJoin(
  ws: import('ws').WebSocket,
  playerInfo: PlayerInfo,
  name: string | undefined,
  characterId: string | undefined,
) {
  playerInfo.name = name || 'Player';
  playerInfo.characterId = characterId || 'beano';

  if (playerInfo.roomId) {
    sendTo(playerInfo, { type: 'error', message: 'Already in a match' });
    return;
  }

  const idx = waitingPlayers.findIndex((p) => p.ws !== ws && p.ws.readyState === 1);

  if (idx >= 0) {
    const opponent = waitingPlayers.splice(idx, 1)[0];
    const room = createRoom(opponent, playerInfo);

    sendTo(opponent, {
      type: 'lobbyMatched',
      playerIndex: 0,
      opponentName: playerInfo.name,
      opponentCharacterId: playerInfo.characterId,
      roomId: room.id,
    });
    sendTo(playerInfo, {
      type: 'lobbyMatched',
      playerIndex: 1,
      opponentName: opponent.name,
      opponentCharacterId: opponent.characterId,
      roomId: room.id,
    });
  } else {
    waitingPlayers.push(playerInfo);
    sendTo(playerInfo, { type: 'waiting' });
  }
}

function handlePick(playerInfo: PlayerInfo, characterId: string | undefined) {
  if (!characterId) return;
  playerInfo.characterId = characterId;
  if (!playerInfo.roomId) return;
  const room = rooms.get(playerInfo.roomId);
  if (!room || room.state !== 'lobby') return;
  const idx = playerInfo.playerIndex ?? -1;
  if (idx < 0 || idx > 1) return;
  const opponentIdx = idx === 0 ? 1 : 0;
  sendTo(room.players[opponentIdx], { type: 'opponentPick', characterId });
}

function handleReady(playerInfo: PlayerInfo) {
  if (!playerInfo.roomId) return;
  const room = rooms.get(playerInfo.roomId);
  if (!room || room.state !== 'lobby') return;
  const idx = playerInfo.playerIndex ?? -1;
  if (idx < 0 || idx > 1) return;
  room.lobbyReady[idx] = true;
  const opponentIdx = idx === 0 ? 1 : 0;
  sendTo(room.players[opponentIdx], { type: 'opponentReady' });
  if (room.lobbyReady[0] && room.lobbyReady[1]) {
    const p0 = room.players[0];
    const p1 = room.players[1];
    sendTo(p0, {
      type: 'matched',
      playerIndex: 0,
      opponentName: p1.name,
      roomId: room.id,
      opponentCharacterId: p1.characterId,
    });
    sendTo(p1, {
      type: 'matched',
      playerIndex: 1,
      opponentName: p0.name,
      roomId: room.id,
      opponentCharacterId: p0.characterId,
    });
    setTimeout(() => startCountdown(room), 1000);
  }
}

const OP_SYNC_INPUT = 0x01;
const OP_OPPONENT_SYNC_INPUT = 0x02;

function handleBinarySyncInput(playerInfo: PlayerInfo, data: Buffer) {
  if (!playerInfo.roomId) return;
  const room = rooms.get(playerInfo.roomId);
  if (!room || room.state !== 'fighting') return;

  const opponentIdx = playerInfo.playerIndex === 0 ? 1 : 0;
  const opponent = room.players[opponentIdx];
  if (!opponent?.ws || opponent.ws.readyState !== 1) return;

  // Zero-copy relay: copy buffer and flip opcode byte
  const relay = Buffer.allocUnsafe(8);
  data.copy(relay);
  relay[0] = OP_OPPONENT_SYNC_INPUT;
  opponent.ws.send(relay);
}

function finishRound(room: Room, result: ClientMessage) {
  room.state = 'roundEnd';
  if (room.roundResultTimeout) {
    clearTimeout(room.roundResultTimeout);
    room.roundResultTimeout = null;
  }
  broadcastToRoom(room, {
    type: 'roundResult',
    winner: result.winner,
    p1Wins: result.p1Wins,
    p2Wins: result.p2Wins,
    matchOver: result.matchOver ?? false,
    victoryAnim: result.victoryAnim ?? '',
    defeatAnim: result.defeatAnim ?? '',
  });
  room.pendingRoundResults = [null, null];

  if (result.matchOver) {
    room.state = 'matchEnd';
    setTimeout(() => destroyRoom(room.id), 5000);
  } else {
    setTimeout(() => startCountdown(room), 3000);
  }
}

function handleSyncRoundResult(playerInfo: PlayerInfo, msg: ClientMessage) {
  if (!playerInfo.roomId) return;
  const room = rooms.get(playerInfo.roomId);
  if (!room || room.state !== 'fighting') return;

  const idx = playerInfo.playerIndex ?? -1;
  if (idx < 0 || idx > 1) return;
  room.pendingRoundResults[idx] = msg;

  const r0 = room.pendingRoundResults[0];
  const r1 = room.pendingRoundResults[1];

  if (r0 && r1) {
    // Both arrived — use first player's result (they should agree)
    if (r0.winner !== r1.winner) {
      console.warn(`[DESYNC] Room ${room.id}: P1 winner=${r0.winner}, P2 winner=${r1.winner}`);
    }
    finishRound(room, r0);
  } else if (!room.roundResultTimeout) {
    // First result — wait up to 2s for the other
    room.roundResultTimeout = setTimeout(() => {
      const result = room.pendingRoundResults[0] || room.pendingRoundResults[1];
      if (result && room.state === 'fighting') {
        finishRound(room, result);
      }
    }, 2000);
  }
}

function handleLeave(playerInfo: PlayerInfo) {
  if (playerInfo.roomId) {
    const room = rooms.get(playerInfo.roomId);
    if (room) {
      const opponentIdx = playerInfo.playerIndex === 0 ? 1 : 0;
      sendTo(room.players[opponentIdx], { type: 'opponentLeft' });
      destroyRoom(room.id);
    }
  }
  const waitIdx = waitingPlayers.indexOf(playerInfo);
  if (waitIdx >= 0) waitingPlayers.splice(waitIdx, 1);
}

// WebRTC signaling relay — forwards SDP offers/answers and ICE candidates
// between matched players. The server never inspects the contents; it's a
// pure relay so the two clients can negotiate a direct peer-to-peer
// DataChannel (UDP) for lower-latency input sync.
// [Ref: RFC8831] Signaling is out-of-band; we reuse the existing WS connection
// [Ref: EDGEGAP] If direct P2P fails, TURN relay still beats TCP for game inputs
function handleSignalingRelay(playerInfo: PlayerInfo, msg: ClientMessage) {
  if (!playerInfo.roomId) return;
  const room = rooms.get(playerInfo.roomId);
  if (!room) return;

  const opponentIdx = playerInfo.playerIndex === 0 ? 1 : 0;
  const opponent = room.players[opponentIdx];
  if (!opponent?.ws || opponent.ws.readyState !== 1) return;

  sendTo(opponent, { type: msg.type, sdp: msg.sdp, candidate: msg.candidate });
}

function handleClose(playerInfo: PlayerInfo) {
  const waitIdx = waitingPlayers.indexOf(playerInfo);
  if (waitIdx >= 0) waitingPlayers.splice(waitIdx, 1);

  if (playerInfo.roomId) {
    const room = rooms.get(playerInfo.roomId);
    if (room) {
      const opponentIdx = playerInfo.playerIndex === 0 ? 1 : 0;
      sendTo(room.players[opponentIdx], { type: 'opponentLeft' });
      destroyRoom(room.id);
    }
  }
}

wss.on('connection', (ws, req) => {
  // Disable Nagle's algorithm — flush every message immediately.
  // Without this, TCP batches small packets (our 8-byte inputs) for up to
  // 40-200ms waiting for more data, which destroys input latency.
  req.socket.setNoDelay(true);
  const playerInfo: PlayerInfo = {
    ws,
    name: 'Player',
    characterId: 'beano',
    roomId: null,
    playerIndex: null,
  };

  ws.on('message', (data) => {
    // Binary fast-path: syncInput (8 bytes, opcode 0x01)
    if (Buffer.isBuffer(data) && data.length === 8 && data[0] === OP_SYNC_INPUT) {
      handleBinarySyncInput(playerInfo, data);
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join':
        handleJoin(ws, playerInfo, msg.name, msg.characterId);
        break;
      case 'pick':
        handlePick(playerInfo, msg.characterId);
        break;
      case 'ready':
        handleReady(playerInfo);
        break;
      case 'roundResult':
        handleSyncRoundResult(playerInfo, msg);
        break;
      case 'ping':
        sendTo(playerInfo, { type: 'pong', t: msg.t });
        break;
      case 'leave':
        handleLeave(playerInfo);
        break;
      // WebRTC signaling: relay SDP and ICE candidates between matched peers
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice':
        handleSignalingRelay(playerInfo, msg);
        break;
    }
  });

  ws.on('close', () => handleClose(playerInfo));
});

server.listen(PORT, () => {
  console.log(`\n  ██╗  ██╗██╗  ██╗██╗  ██╗██╗  ██╗███████╗███╗   ██╗`);
  console.log(`  ██║  ██║██║  ██║██║ ██╔╝██║ ██╔╝██╔════╝████╗  ██║`);
  console.log(`  ███████║███████║█████╔╝ █████╔╝ █████╗  ██╔██╗ ██║`);
  console.log(`  ██╔══██║╚════██║██╔═██╗ ██╔═██╗ ██╔══╝  ██║╚██╗██║`);
  console.log(`  ██║  ██║     ██║██║  ██╗██║  ██╗███████╗██║ ╚████║`);
  console.log(`  ╚═╝  ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝`);
  console.log(`\n  Server running on http://localhost:${PORT}`);
  if (TURN_SECRET) console.log(`  TURN relay: ${TURN_REALM}:${TURN_PORT} (self-hosted coturn)`);
  else console.log('  TURN: disabled (set TURN_SECRET and TURN_REALM for coturn)');
  console.log();
});

// ── Graceful shutdown ───────────────────────────────────────────
// Close WebSocket connections cleanly so containers/process managers
// can restart without clients seeing abrupt disconnects.
function shutdown(signal: string) {
  console.log(`\n  [${signal}] Shutting down...`);
  // Stop accepting new connections
  server.close();
  // Close all WebSocket connections with "going away" code
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
  // Give in-flight messages 2s to flush, then force exit
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

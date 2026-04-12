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
  roomId: string | null;
  playerIndex: number | null;
}

interface ClientMessage {
  type: string;
  name?: string;
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
}

interface Room {
  id: string;
  players: [PlayerInfo, PlayerInfo];
  state: 'countdown' | 'fighting' | 'roundEnd' | 'matchEnd';
  countdownTimer: ReturnType<typeof setTimeout> | null;
  pendingRoundResults: [ClientMessage | null, ClientMessage | null];
  roundResultTimeout: ReturnType<typeof setTimeout> | null;
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
    state: 'countdown',
    countdownTimer: null,
    pendingRoundResults: [null, null],
    roundResultTimeout: null,
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

function handleJoin(ws: import('ws').WebSocket, playerInfo: PlayerInfo, name: string | undefined) {
  playerInfo.name = name || 'Player';

  if (playerInfo.roomId) {
    sendTo(playerInfo, { type: 'error', message: 'Already in a match' });
    return;
  }

  const idx = waitingPlayers.findIndex((p) => p.ws !== ws && p.ws.readyState === 1);

  if (idx >= 0) {
    const opponent = waitingPlayers.splice(idx, 1)[0];
    const room = createRoom(opponent, playerInfo);

    sendTo(opponent, {
      type: 'matched',
      playerIndex: 0,
      opponentName: playerInfo.name,
      roomId: room.id,
    });
    sendTo(playerInfo, {
      type: 'matched',
      playerIndex: 1,
      opponentName: opponent.name,
      roomId: room.id,
    });

    setTimeout(() => startCountdown(room), 1000);
  } else {
    waitingPlayers.push(playerInfo);
    sendTo(playerInfo, { type: 'waiting' });
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
        handleJoin(ws, playerInfo, msg.name);
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
  console.log(`\n  Server running on http://localhost:${PORT}\n`);
});

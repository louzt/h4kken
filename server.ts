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
  input?: unknown;
  state?: unknown;
  winner?: number;
  p1Wins?: number;
  p2Wins?: number;
  matchOver?: boolean;
  playerIndex?: number;
}

interface Room {
  id: string;
  players: [PlayerInfo, PlayerInfo];
  frame: number;
  inputs: [unknown, unknown];
  state: 'countdown' | 'fighting' | 'roundEnd' | 'matchEnd';
  countdownTimer: ReturnType<typeof setTimeout> | null;
  superMeters: [number, number];
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
    frame: 0,
    inputs: [null, null],
    state: 'countdown',
    countdownTimer: null,
    superMeters: [0, 0],
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
  room.state = 'countdown';
  let count = 3;

  function tick() {
    broadcastToRoom(room, { type: 'countdown', count });
    if (count <= 0) {
      room.state = 'fighting';
      room.frame = 0;
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

function handleInput(playerInfo: PlayerInfo, msg: ClientMessage) {
  if (!playerInfo.roomId) return;
  const room = rooms.get(playerInfo.roomId);
  if (!room || room.state !== 'fighting') return;

  const opponentIdx = playerInfo.playerIndex === 0 ? 1 : 0;
  const opponent = room.players[opponentIdx];

  sendTo(opponent, {
    type: 'opponentInput',
    frame: msg.frame,
    input: msg.input,
  });
}

function handleGameState(playerInfo: PlayerInfo, msg: ClientMessage) {
  if (!playerInfo.roomId || playerInfo.playerIndex !== 0) return;
  const room = rooms.get(playerInfo.roomId);
  if (!room) return;

  // Cache super meter values from P1's authoritative simulation
  const state = msg.state as { p1?: { superMeter?: number }; p2?: { superMeter?: number } } | null;
  if (state?.p1?.superMeter !== undefined) room.superMeters[0] = state.p1.superMeter;
  if (state?.p2?.superMeter !== undefined) room.superMeters[1] = state.p2.superMeter;

  const opponent = room.players[1];
  sendTo(opponent, {
    type: 'gameState',
    state: msg.state,
    frame: msg.frame,
  });
}

const SUPER_MAX = 1200; // must match GAME_CONSTANTS.SUPER_MAX (600 * PACE_SCALE=2)

function handleSuperActivate(playerInfo: PlayerInfo, msg: ClientMessage) {
  if (!playerInfo.roomId) return;
  const room = rooms.get(playerInfo.roomId);
  if (!room || room.state !== 'fighting') return;

  const idx = msg.playerIndex ?? playerInfo.playerIndex;
  if (idx === null || idx === undefined) return;
  const meter = room.superMeters[idx] ?? 0;
  if (meter < SUPER_MAX) return;

  room.superMeters[idx] = 0;
  broadcastToRoom(room, { type: 'superActivated', playerIndex: idx });
}

function handleRoundResult(playerInfo: PlayerInfo, msg: ClientMessage) {
  if (!playerInfo.roomId) return;
  const room = rooms.get(playerInfo.roomId);
  if (!room) return;

  if (room.state !== 'fighting') return;
  room.state = 'roundEnd';

  broadcastToRoom(room, {
    type: 'roundResult',
    winner: msg.winner,
    p1Wins: msg.p1Wins,
    p2Wins: msg.p2Wins,
  });

  if (msg.matchOver) {
    room.state = 'matchEnd';
    setTimeout(() => destroyRoom(room.id), 5000);
  } else {
    setTimeout(() => startCountdown(room), 3000);
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

wss.on('connection', (ws) => {
  const playerInfo: PlayerInfo = {
    ws,
    name: 'Player',
    roomId: null,
    playerIndex: null,
  };

  ws.on('message', (data) => {
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
      case 'input':
        handleInput(playerInfo, msg);
        break;
      case 'gameState':
        handleGameState(playerInfo, msg);
        break;
      case 'roundResult':
        handleRoundResult(playerInfo, msg);
        break;
      case 'superActivate':
        handleSuperActivate(playerInfo, msg);
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

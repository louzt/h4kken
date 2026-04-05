import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Debug endpoint - receives console logs from the browser
app.post('/api/debug', (req, res) => {
  const lines = req.body.lines || [];
  lines.forEach(l => console.log('[BROWSER]', l));
  res.json({ ok: true });
});

// Game state
const waitingPlayers = [];
const rooms = new Map();
let roomIdCounter = 1;

function generateRoomId() {
  return `room_${roomIdCounter++}`;
}

function createRoom(player1, player2) {
  const roomId = generateRoomId();
  const room = {
    id: roomId,
    players: [player1, player2],
    frame: 0,
    inputs: [null, null],
    state: 'countdown', // countdown, fighting, roundEnd, matchEnd
    countdownTimer: null,
  };
  rooms.set(roomId, room);
  player1.roomId = roomId;
  player1.playerIndex = 0;
  player2.roomId = roomId;
  player2.playerIndex = 1;
  return room;
}

function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.players.forEach(p => {
    if (p && p.ws && p.ws.readyState === 1) {
      p.roomId = null;
      p.playerIndex = null;
    }
  });
  
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  rooms.delete(roomId);
}

function sendTo(playerInfo, message) {
  if (playerInfo && playerInfo.ws && playerInfo.ws.readyState === 1) {
    playerInfo.ws.send(JSON.stringify(message));
  }
}

function broadcastToRoom(room, message) {
  room.players.forEach(p => sendTo(p, message));
}

function startCountdown(room) {
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

wss.on('connection', (ws) => {
  const playerInfo = {
    ws,
    name: 'Player',
    roomId: null,
    playerIndex: null,
  };

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'join': {
        playerInfo.name = msg.name || 'Player';
        
        // Check if already in a room
        if (playerInfo.roomId) {
          sendTo(playerInfo, { type: 'error', message: 'Already in a match' });
          return;
        }

        // Try to match with a waiting player
        const idx = waitingPlayers.findIndex(
          p => p.ws !== ws && p.ws.readyState === 1
        );

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

          // Start countdown
          setTimeout(() => startCountdown(room), 1000);
        } else {
          waitingPlayers.push(playerInfo);
          sendTo(playerInfo, { type: 'waiting' });
        }
        break;
      }

      case 'input': {
        if (!playerInfo.roomId) return;
        const room = rooms.get(playerInfo.roomId);
        if (!room || room.state !== 'fighting') return;

        // Relay input to opponent
        const opponentIdx = playerInfo.playerIndex === 0 ? 1 : 0;
        const opponent = room.players[opponentIdx];
        
        sendTo(opponent, {
          type: 'opponentInput',
          frame: msg.frame,
          input: msg.input,
        });
        break;
      }

      case 'gameState': {
        // Player 1 is authoritative - relay state to player 2
        if (!playerInfo.roomId || playerInfo.playerIndex !== 0) return;
        const room = rooms.get(playerInfo.roomId);
        if (!room) return;

        const opponent = room.players[1];
        sendTo(opponent, {
          type: 'gameState',
          state: msg.state,
          frame: msg.frame,
        });
        break;
      }

      case 'roundResult': {
        if (!playerInfo.roomId) return;
        const room = rooms.get(playerInfo.roomId);
        if (!room) return;

        // Only accept roundResult while in 'fighting' state
        // (prevents duplicate countdowns from both players sending roundResult)
        if (room.state !== 'fighting') break;
        room.state = 'roundEnd';

        // Relay round result
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
          // Start next round countdown after delay
          setTimeout(() => startCountdown(room), 3000);
        }
        break;
      }

      case 'leave': {
        if (playerInfo.roomId) {
          const room = rooms.get(playerInfo.roomId);
          if (room) {
            const opponentIdx = playerInfo.playerIndex === 0 ? 1 : 0;
            sendTo(room.players[opponentIdx], { type: 'opponentLeft' });
            destroyRoom(room.id);
          }
        }
        // Remove from waiting list
        const waitIdx = waitingPlayers.indexOf(playerInfo);
        if (waitIdx >= 0) waitingPlayers.splice(waitIdx, 1);
        break;
      }
    }
  });

  ws.on('close', () => {
    // Remove from waiting list
    const waitIdx = waitingPlayers.indexOf(playerInfo);
    if (waitIdx >= 0) waitingPlayers.splice(waitIdx, 1);

    // Handle disconnect from room
    if (playerInfo.roomId) {
      const room = rooms.get(playerInfo.roomId);
      if (room) {
        const opponentIdx = playerInfo.playerIndex === 0 ? 1 : 0;
        sendTo(room.players[opponentIdx], { type: 'opponentLeft' });
        destroyRoom(room.id);
      }
    }
  });
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

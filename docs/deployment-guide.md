# H4KKEN — Deployment Guide

Everything you need to get H4KKEN running in production on a Linux server.

## Prerequisites

| Software | Version | Purpose |
|----------|---------|---------|
| **Bun** | ≥ 1.3.0 | Runtime + package manager |
| **nginx** | ≥ 1.25 | Reverse proxy, static assets, HTTP/3 |
| **coturn** | ≥ 4.6 | Self-hosted TURN relay for WebRTC |
| **Let's Encrypt** | (certbot) | TLS certificate |
| **PM2** (optional) | ≥ 5.x | Process management with log rotation |
| **systemd** | (built-in) | Alternative process management |

### Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version   # should print ≥ 1.3.0
```

### Install coturn

```bash
# Debian/Ubuntu
apt-get install -y coturn

# RHEL/Fedora
dnf install -y coturn
```

### Install PM2 (optional — alternative to systemd)

```bash
bun install -g pm2
```

---

## 1. Build

```bash
cd /path/to/h4kken
bun install
bun run build         # vite build (client) + tsc (server)
```

Output structure:
```
dist/
├── client/           # Static files served by nginx
│   ├── assets/       # Hashed JS/CSS/GLB chunks
│   ├── css/
│   └── index.html
├── server.js          # Compiled server entry point
└── ...
```

---

## 2. Environment Variables

Copy the template and fill in your values:
```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP + WebSocket listen port |
| `TURN_SECRET` | No | (empty) | coturn shared secret for HMAC auth |
| `TURN_REALM` | No | (empty) | TURN realm (your domain, e.g. `h4kken.example.com`) |
| `TURN_PORT` | No | `3478` | coturn UDP/TCP listening port |
| `TURN_TLS_PORT` | No | `5349` | coturn TLS listening port |

If `TURN_SECRET` is empty, the server skips TURN credential generation and clients use STUN only. This is fine for players on regular home internet — TURN is only needed when someone is behind symmetric NAT (mobile carriers, corporate firewalls).

---

## 3. coturn Setup

Generate a random secret:
```bash
openssl rand -hex 32
# Example: db17964ca4823414f301f0cc...
```

Create `/etc/turnserver.conf`:
```ini
realm=h4kken.example.com
server-name=h4kken.example.com

use-auth-secret
static-auth-secret=YOUR_SECRET_HERE

listening-ip=YOUR_PUBLIC_IP
relay-ip=YOUR_PUBLIC_IP
external-ip=YOUR_PUBLIC_IP

listening-port=3478
tls-listening-port=5349
min-port=49152
max-port=65535

# TLS — use your Let's Encrypt cert
cert=/etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem
pkey=/etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem

# Security
no-multicast-peers
no-cli
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255

total-quota=100
stale-nonce=600
log-file=/var/log/turnserver.log
simple-log
```

Open firewall ports:
```bash
# UDP: STUN/TURN + relay range
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 5349/tcp
ufw allow 49152:65535/udp
```

Start coturn:
```bash
systemctl enable coturn
systemctl start coturn
systemctl status coturn
```

---

## 4. nginx Configuration

The game server runs on port 3000. nginx handles:
- TLS termination
- HTTP/2 and HTTP/3 (QUIC)
- Direct static file serving (no proxy for `/assets/`, `/css/`)
- WebSocket upgrade on `/ws`
- Proxy pass for API routes

Example server block:
```nginx
server {
    listen 80;
    listen YOUR_IP:80;
    listen 443 ssl;
    listen YOUR_IP:443 ssl;
    listen YOUR_IP:443 quic;
    http2 on;
    http3 on;
    add_header Alt-Svc 'h3=":443"; ma=86400' always;
    server_name h4kken.example.com;

    ssl_certificate /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;

    # Redirect HTTP → HTTPS
    if ($scheme != "https") {
        return 301 https://$host$request_uri;
    }

    # Static assets — nginx serves directly, 1 year cache (Vite hashes filenames)
    location /assets/ {
        alias /path/to/h4kken/dist/client/assets/;
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Alt-Svc 'h3=":443"; ma=86400' always;
        try_files $uri =404;
    }

    location /css/ {
        alias /path/to/h4kken/dist/client/css/;
        expires 7d;
        add_header Cache-Control "public";
        add_header Alt-Svc 'h3=":443"; ma=86400' always;
    }

    # WebSocket — upgrade headers required
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # Everything else → Express
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering on;
        proxy_buffers 16 16k;
        proxy_busy_buffers_size 64k;
        proxy_buffer_size 16k;
    }
}
```

Test and reload:
```bash
nginx -t
systemctl reload nginx
```

**Important**: If using HTTP/3 (QUIC), the `listen ... quic` directive must be bound to the server's public IP (e.g. `listen 1.2.3.4:443 quic`) — not the generic `listen 443 quic`. QUIC uses UDP, and nginx SNI routing requires an IP-specific listener for deterministic matching.

---

## 5. Running the Server

### Option A: systemd (recommended for production)

Create `/etc/systemd/system/h4kken.service`:
```ini
[Unit]
Description=H4KKEN Fighting Game Server
After=network.target coturn.service

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/h4kken
EnvironmentFile=/path/to/h4kken/.env
ExecStart=/path/to/bun dist/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable h4kken
systemctl start h4kken
systemctl status h4kken
```

### Option B: PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # auto-start on boot
```

### Option C: Docker Compose

```bash
# Edit compose.yaml — uncomment the coturn service block
# Set TURN_SECRET and TURN_REALM in .env
docker compose up -d
```

---

## 6. Health Check

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "ok",
  "uptime": 3600,
  "rooms": 2,
  "waiting": 1,
  "connections": 5
}
```

Use this endpoint for:
- nginx health checks (`proxy_next_upstream`)
- PM2 health (`pm2 monitor`)  
- External monitoring (UptimeRobot, etc.)

---

## 7. Development Workflow

```bash
# Start dev server (Vite HMR + bun --watch)
bun run dev

# Or with PM2:
pm2 start ecosystem.config.cjs --only h4kken-dev
```

The dev server runs on port 3001 (via PM2) or 5173 (Vite dev server). Vite proxies `/ws` and `/api` to the game server automatically.

### Code Quality

```bash
bun run fix       # biome format/lint + typecheck + knip
bun run typecheck  # tsc only (both configs)
bun run ci        # biome ci + tsc + knip (for CI pipelines)
```

---

## 8. Update / Redeploy

```bash
cd /path/to/h4kken
git pull
bun install
bun run build

# systemd:
systemctl restart h4kken

# PM2:
pm2 restart h4kken

# Docker:
docker compose up -d --build
```

The server handles SIGTERM gracefully — it closes WebSocket connections with code 1001 ("going away") and waits 2 seconds for in-flight messages to flush before exiting. Players will see an "opponent disconnected" message and can immediately re-queue.

---

## 9. Architecture Quick Reference

```
Browser ──HTTPS──▶ nginx (TLS, HTTP/2, HTTP/3)
                      ├── /assets/   → dist/client/assets/ (static, 1yr cache)
                      ├── /css/      → dist/client/css/ (static, 7d cache)
                      ├── /ws        → Express:3000 (WebSocket upgrade)
                      └── /          → Express:3000 (HTML, API)

Browser ──WebRTC──▶ Direct P2P (UDP DataChannel)
         └─ or ──▶ coturn:3478 (TURN relay fallback)

Server processes:
  h4kken (bun)    → Game server + WebSocket + signaling
  coturn           → STUN/TURN relay for WebRTC
  nginx            → Reverse proxy + TLS + static files
```

### Key Files

| File | Purpose |
|------|---------|
| `server.ts` | Game server: matchmaking, room management, WebSocket, WebRTC signaling, health endpoint, TURN credentials |
| `src/Network.ts` | Client network layer: WebSocket + WebRTC DataChannel transport |
| `src/transport/WebRTCTransport.ts` | WebRTC DataChannel with UDP semantics |
| `src/game/Game.ts` | Game loop, rollback, input delay, hit stop |
| `src/game/RollbackManager.ts` | GGPO-style rollback netcode |
| `src/fighter/Fighter.ts` | Fighter state machine, animations, physics |
| `src/debug/NetworkOverlay.ts` | F3 key debug HUD (RTT, rollbacks, transport) |
| `ecosystem.config.cjs` | PM2 process configuration |
| `compose.yaml` | Docker Compose (game + optional coturn) |
| `vite.config.ts` | Vite build config + dev proxy |

---

## 10. Troubleshooting

### WebSocket returns 502
- Check the game server is running: `curl http://localhost:3000/health`
- Check nginx config: `nginx -t`
- If using HTTP/3, make sure `listen YOUR_IP:443 quic` (not `listen 443 quic`)

### Assets return "MIME type text/html"
- nginx is returning HTML instead of serving the asset. Check:
  - `dist/client/assets/` exists and contains the file
  - nginx `location /assets/` alias path is correct
  - Run `bun run build` if assets are missing

### WebRTC doesn't connect (stays on WebSocket)
- Check browser console for ICE errors
- Verify coturn is running: `systemctl status coturn`
- Test TURN: `turnutils_uclient -t -T -u test -w test YOUR_IP`
- Check firewall: ports 3478/UDP, 3478/TCP, 5349/TCP, 49152-65535/UDP

### Players desync
- Check the F3 debug overlay for rollback count
- High rollback count (>10/sec) suggests packet loss or high latency
- If on WebSocket transport, WebRTC upgrade may have failed — check console

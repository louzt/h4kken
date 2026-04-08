# H4KKEN

A Tekken-inspired 3D browser fighting game built with Three.js and WebSockets.

## Features

- **3D Fighting** — Full 3D arena with punches, kicks, combos, juggling, and throws
- **Dynamic Camera** — Camera orbits to always follow the fight axis between players
- **Online Multiplayer** — Real-time matches via WebSocket with matchmaking
- **Practice Mode** — Solo practice against a bot opponent
- **Sidestepping** — Full 3D movement with sidestep mechanics

## Controls

| Action | Key |
|---|---|
| Move Left / Right | `A` / `D` |
| Jump | `W` |
| Crouch | `S` |
| Light Punch | `U` |
| Heavy Punch | `I` |
| Light Kick | `J` |
| Heavy Kick | `K` |
| Sidestep | `Shift` + `W` / `S` |
| Dash Back | Double-tap `Back` |

## Quick Start

```bash
bun install
bun run dev
```

Open http://localhost:3000

## Docker

```bash
docker compose up --build
```

## Dev

```bash
bun run fix   # auto-format, lint, typecheck, dead-code check — run before committing
```

Pre-commit hooks are installed automatically by `bun install` (via the `prepare` script). Every commit runs `bun run fix` and is blocked if anything fails.

## Tech Stack

- **Frontend**: Three.js (3D), vanilla JS modules
- **Backend**: Bun, Express, WebSocket (`ws`)
- **Assets**: FBX character model and animations (AnimPack01)

## License

MIT

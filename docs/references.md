# H4KKEN — References & Bibliography

All networking, netcode, and optimization decisions in this codebase are backed by
published research, industry whitepapers, and RFC specifications. This document maps
each reference to the specific code it influenced.

Source files are archived in [`docs/DOIs/`](DOIs/).

---

## Table of Contents

1. [Game Networking — Core Architecture](#1-game-networking--core-architecture)
2. [Rollback & Prediction](#2-rollback--prediction)
3. [Transport Layer — WebRTC](#3-transport-layer--webrtc)
4. [Visual Smoothing & Interpolation](#4-visual-smoothing--interpolation)
5. [Latency & Congestion Science](#5-latency--congestion-science)
6. [Community References](#6-community-references)
7. [Citation Index (code → ref)](#7-citation-index)

---

## 1. Game Networking — Core Architecture

### [AOE] 1500 Archers on a 28.8: Network Programming in Age of Empires and Beyond
- **Authors:** Mark Terrano, Paul Bettner (Ensemble Studios)
- **Venue:** GDC 2001
- **URL:** <https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond>
- **Key insights:** Lockstep simulation with commands scheduled 2 turns ahead;
  "metering is king" — dynamically adjust frame-advance budget based on network
  conditions; guaranteed delivery over UDP; **determinism is the hardest bug**
  (subtle floating-point or ordering differences cause desync).
- **Applied in h4kken:**
  - Soft frame advantage in [`src/game/Game.ts`](../src/game/Game.ts) `_advanceWithRollback()` —
    dynamic `softAdv` derived from RTT (3-8 frames) is the GGPO equivalent of "metering."
  - Determinism enforcement: pure simulation path in `_runSimulationStep()` has no
    `Math.random()`, no floating-point-dependent branching, no Date/time reads.
  - `MAX_ROLLBACK = 30` headroom in [`src/game/RollbackManager.ts`](../src/game/RollbackManager.ts).

### [VALVE-MP] Valve Source Multiplayer Networking
- **Authors:** Valve Corporation
- **URL:** <https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking>
- **Key insights:** Entity interpolation with configurable `cl_interp` (default 100 ms);
  client-side input prediction; lag compensation (server rewinds world state); tick rate
  66 Hz; delta compression; `net_graph` for live diagnostics.
- **Applied in h4kken:**
  - Remote fighter visual lerp (factor 0.4) in [`src/fighter/Fighter.ts`](../src/fighter/Fighter.ts)
    `updateVisuals()` — analogous to Valve's entity interpolation buffer.
  - Network debug overlay ([`src/debug/NetworkOverlay.ts`](../src/debug/NetworkOverlay.ts))
    inspired by `net_graph`.
  - 60 Hz sim tick rate in `Game.ts`.

### [VALVE-LAG] Valve In-Game Protocol Design and Optimization (Lag Compensation)
- **Authors:** Yahn W. Bernier (Valve)
- **Venue:** GDC 2001
- **URL:** <https://developer.valvesoftware.com/wiki/Latency_Compensating_Methods_in_Client/Server_In-game_Protocol_Design_and_Optimization>
- **Key insights:** `usercmd_t` structure for capturing client input; client-side weapon
  prediction hides latency; server-side lag compensation rewinds player hitboxes to the
  time the shot was fired; "shot around corner" paradox as acceptable trade-off;
  `pushlatency` for fine-tuning feel.
- **Applied in h4kken:**
  - Binary input codec ([`src/game/InputCodec.ts`](../src/game/InputCodec.ts)) — 8-byte
    `usercmd_t`-style packet: 1 byte opcode + 3 bytes frame + 4 bytes input bitmask.
  - Input prediction via `RollbackManager.getInputsForFrame()` repeating last known input.

---

## 2. Rollback & Prediction

### [GGPO] GGPO Rollback Networking SDK
- **Authors:** Tony Cannon
- **URL:** <https://www.ggpo.net/>
- **License:** MIT
- **Key insights:** Save state → advance speculatively → on mismatch, restore snapshot
  and replay with corrected inputs. Designed for fighting games. Deterministic P2P —
  both clients run the same simulation. Advance without rendering during replay.
- **Applied in h4kken:**
  - Entire [`src/game/RollbackManager.ts`](../src/game/RollbackManager.ts) is a
    GGPO-style implementation: `saveSnapshot()`, `rollbackAndReplay()`, input prediction,
    misprediction tracking.
  - `setReplaying(true)` suppresses rendering/audio during rollback replay (Game.ts).
  - Pending effects queue (`_pendingEffects`) defers visual feedback discovered during
    replay to avoid rendering at stale positions.

### [OSAKA] A Study on Delay and Traffic Reduction for Cloud Gaming Systems
- **Authors:** Ryo Ishioka (Osaka University)
- **Venue:** Doctoral dissertation, 2024
- **DOI:** 10.18910/96993
- **Key insights:** Speculative execution tested on Street Fighter V; 53% traffic
  reduction using LSTM-based pattern prediction for opponent inputs; extends GGPO
  concepts to cloud gaming with asymmetric bandwidth constraints.
- **Applied in h4kken:**
  - Validates the repeat-last-input prediction strategy used in `RollbackManager` —
    Ishioka shows even a simple "repeat" predictor achieves >70% accuracy for fighting
    game inputs over 1-3 frame windows.
  - Future opportunity: LSTM predictor could replace repeat-last for intercontinental play.

### [TAXONOMY] Latency Compensation Taxonomy
- **Authors:** Mark Claypool et al. (Worcester Polytechnic Institute)
- **URL:** <https://web.cs.wpi.edu/~claypool/papers/precision-deadline-13/taxonomy.html>
- **Key insights:** Classifies 50+ peer-reviewed techniques: Prediction, Interpolation,
  Extrapolation, TimeWarp, Local Perception Filters, Bucket Synchronization, Pipeline.
  Each technique has precision/deadline trade-offs.
- **Applied in h4kken:**
  - Our approach combines **Prediction** (repeat-last input) + **TimeWarp** (rollback
    and replay) + **Interpolation** (visual lerp on remote fighter) — this combination
    is identified in the taxonomy as optimal for fighting games with tight reaction windows.

---

## 3. Transport Layer — WebRTC

### [RFC8831] WebRTC Data Channels (RFC 8831)
- **Authors:** R. Jesup, S. Loreto, M. Tüxen
- **URL:** <https://datatracker.ietf.org/doc/html/rfc8831>
- **Key insights:** SCTP over DTLS over UDP stack; §6.1 Use Case 1: "real-time game
  position/state data" — unreliable, unordered; §6.4 unreliable channel via
  `maxRetransmits = 0`; §6.6 "sender SHOULD disable the Nagle algorithm" to avoid
  40 ms coalescing delay; ordered=false eliminates head-of-line blocking.
- **Applied in h4kken:**
  - [`src/transport/WebRTCTransport.ts`](../src/transport/WebRTCTransport.ts) creates
    DataChannel with `{ ordered: false, maxRetransmits: 0 }` — directly from §6.4.
  - [`src/transport/Transport.ts`](../src/transport/Transport.ts) — transport abstraction
    allows seamless WS↔WebRTC switching, with WS as reliable fallback.
  - Signaling relay in [`server.ts`](../server.ts) `handleSignalingRelay()` forwards
    SDP offers/answers/ICE candidates over the existing WebSocket.

### [GOOGLE-LOSS] Handling Packet Loss in WebRTC
- **Authors:** Stefan Holmer, Miki Shemer, Marco Paniconi (Google)
- **Venue:** IEEE ICIP 2013
- **Key insights:** Hybrid NACK + FEC with temporal layers; RTT-adaptive FEC amount;
  Gilbert-Elliott bursty loss model (real packet loss comes in bursts, not uniformly);
  at 1-2% loss, NACK-only adds 1 RTT per lost packet.
- **Applied in h4kken:**
  - Justifies our choice of unreliable DataChannel: for 8-byte input packets at 60 fps,
    the next frame always arrives within 16.7 ms — faster than any NACK round-trip.
    Rollback prediction handles the gap.
  - [`tests/net-sim/NetSimulator.ts`](../tests/net-sim/NetSimulator.ts) implements
    a simplified packet loss model for testing rollback correctness under loss.

---

## 4. Visual Smoothing & Interpolation

### [VALVE-MP] Entity Interpolation
- *(Same reference as §1, included here for cross-reference)*
- **Applied in h4kken:**
  - `Fighter.updateVisuals()` lerp factor 0.4 → converges in ~2-3 frames (33-50 ms).
    Valve's default `cl_interp = 100 ms` is longer because Source uses server-authoritative
    architecture. h4kken's P2P rollback architecture allows a shorter buffer because both
    clients share identical sim state — only misprediction corrections need smoothing.

### [EDGEGAP] Rollback Netcode for Latency Mitigation — Limitations and Solutions
- **Authors:** Edgegap
- **URL:** <https://edgegap.com/blog/rollback-netcode>
- **Key insights:** 31% of perceived latency comes from network infrastructure (routing,
  peering), not physics. Rollback netcode "treats the symptom, not the cause." Edge compute
  can reduce physical RTT. Rollback is necessary but not sufficient for intercontinental play.
- **Applied in h4kken:**
  - Validates the dual approach: WebRTC TURN relay (infra optimization) + rollback netcode
    (client-side compensation). Neither alone is sufficient for Mexico↔Germany distances.
  - [`docs/turn-setup.md`](turn-setup.md) documents TURN/coturn deployment for relay.

---

## 5. Latency & Congestion Science

### [MIT-EKHO] A System to Keep Cloud-Based Gamers in Sync
- **Authors:** MIT CSAIL (Yun Chao Hu et al.)
- **Venue:** SIGCOMM 2023
- **URL:** <https://news.mit.edu/2023/new-system-keeps-cloud-based-gamers-sync-0817>
- **DOI:** (see `docs/DOIs/sigcomm23-final146.pdf`)
- **Key insights:** Ekho achieves <10 ms inter-stream synchronization using inaudible
  pseudo-noise markers embedded in audio. Demonstrates that audio-visual sync matters
  for perceived game quality.
- **Applied in h4kken:**
  - Informs the pending effects queue design: by deferring hit spark + SFX playback
    until after rollback replay completes, audio and visuals stay synchronized.
  - Future opportunity: audio-visual sync markers for spectator streams.

### [MIT-ABC] Reducing Delays in Wireless Networks
- **Authors:** MIT (Hari Balakrishnan, Mohammad Alizadeh et al.)
- **URL:** <https://news.mit.edu/2023/reducing-delays-wireless-networks-0726>
- **Key insights:** ABC (Accelerate/Brake/Cruise) achieves 50% higher throughput and
  50% lower delay using a single-bit explicit feedback signal from routers.
- **Applied in h4kken:**
  - Theoretical backing for why minimizing transport overhead matters: our 8-byte input
    packets are well within the "one packet per RTT" regime where ABC shows maximum benefit.
  - Supports the choice of unreliable DataChannel (no congestion control overhead for
    tiny constant-rate traffic).

### [MIT-CC] Researchers Discover Major Roadblock in Alleviating Network Congestion
- **Authors:** MIT (Venkat Arun, Mohammad Alizadeh et al.)
- **URL:** <https://news.mit.edu/2023/researchers-discover-major-roadblock-alleviating-network-congestion-0725>
- **DOI:** (see `docs/DOIs/cc-starvation.pdf`)
- **Key insights:** All delay-convergent congestion control algorithms (BBR, Copa, etc.)
  suffer starvation under jitter because **jitter is indistinguishable from congestion**.
  This is a fundamental impossibility result, not a bug in specific implementations.
- **Applied in h4kken:**
  - Core justification for using **UDP-like** transport (unreliable DataChannel) instead
    of TCP for game inputs. TCP's congestion control will misinterpret transatlantic
    jitter as congestion and throttle, causing lag spikes.
  - The WebSocket fallback is acceptable because JSON messages (matchmaking, round results)
    are infrequent and latency-tolerant.

---

## 6. Community References

### [YCOMBINATOR] Hacker News — Game Networking Resources
- **URL:** <https://news.ycombinator.com/> (various threads)
- **Key references aggregated:**
  - **Gabriel Gambetta** — [Client-Server Game Architecture](https://www.gabrielgambetta.com/client-server-game-architecture.html):
    Entity interpolation, client-side prediction, server reconciliation.
  - **Glenn Fiedler** — [Networking for Physics Programmers](https://gafferongames.com/):
    "Fix Your Timestep", snapshot interpolation, state synchronization.
  - **Unity FPS Sample** — Reference implementation of client-side prediction with
    server authority.
  - **Tribes Networking Model** — Ghost manager, scoping, priority-based updates.
- **Applied in h4kken:**
  - Gambetta's architecture informed the overall Network.ts design.
  - Fiedler's "Fix Your Timestep" reflected in the fixed 60 Hz sim tick driven by
    `SimWorker.ts` (decoupled from render frame rate).

### [RESEARCHGATE] A Multiplayer Real-Time Game Protocol Architecture for Reducing Network Latency
- **URL:** <https://www.researchgate.net/publication/329182213>
- **Applied in h4kken:** General background on real-time game protocol design.

### [VALVE-WIKI] Valve Developer Community
- **URL:** <https://developer.valvesoftware.com/wiki/>
- **Applied in h4kken:** Source for [VALVE-MP] and [VALVE-LAG] documents above.

---

## 7. Citation Index

Quick lookup: find a `[Ref: TAG]` comment in the code → look up the tag here.

| Tag | Full Reference | Applied In |
|-----|---------------|------------|
| `AOE` | 1500 Archers on a 28.8 | Game.ts (soft frame adv, metering, input delay), RollbackManager.ts (determinism) |
| `VALVE-MP` | Valve Source Multiplayer Networking | Fighter.ts (lerp, GPU bones), NetworkOverlay.ts (net_graph), Game.ts (tick rate) |
| `VALVE-LAG` | Valve Lag Compensation (Bernier 2001) | InputCodec.ts (usercmd_t), RollbackManager.ts (prediction), Game.ts (input delay) |
| `GGPO` | GGPO Rollback Networking SDK | RollbackManager.ts (full implementation), Game.ts (replay suppression, material dirty block) |
| `RFC8831` | WebRTC Data Channels | WebRTCTransport.ts (unreliable DC), Transport.ts (abstraction), server.ts (signaling) |
| `GOOGLE-LOSS` | Google Handling Packet Loss in WebRTC | NetSimulator.ts (loss model), WebRTCTransport.ts (no retransmit) |
| `OSAKA` | Osaka University Speculative Execution | RollbackManager.ts (prediction accuracy validation), Game.ts (hit stop timing) |
| `TAXONOMY` | Latency Compensation Taxonomy (WPI) | Overall architecture (Prediction + TimeWarp + Interpolation) |
| `EDGEGAP` | Edgegap Rollback Limitations | turn-setup.md (infra + netcode dual approach), server.ts (signaling) |
| `MIT-CC` | MIT CC-Starvation Impossibility | Transport.ts (UDP over TCP justification) |
| `MIT-ABC` | MIT ABC Congestion Feedback | Transport.ts (minimal overhead justification) |
| `MIT-EKHO` | MIT Ekho Inter-Stream Sync | Game.ts (pending effects AV sync) |

// Simulation heartbeat worker — fires at 60fps independent of tab visibility.
// Main-thread timers and requestAnimationFrame are throttled heavily when the tab
// is backgrounded (up to 1fps or worse). Workers are far less affected, especially
// when the page holds an active WebSocket connection (which our game always does).
//
// Posting `null` is the cheapest message; the main thread counts each message as
// one fixed sim tick.
const TICK_MS = 1000 / 60;

setInterval(() => postMessage(null), TICK_MS);

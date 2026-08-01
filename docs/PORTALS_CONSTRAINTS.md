# Portals Hosted Web Game Constraints

Researched 2026-08-01 from:
- https://portals.to/documentation/advanced-tooling/portals-sdk
- https://portals.to/documentation/advanced-tooling/multiplayer-and-voice
- https://portals.to/documentation/advanced-tooling

## Bundle and runtime

- Portals processes and hosts the game bundle; the SDK is auto-injected and the
  game includes it via `<script src="./_portals/sdk.js"></script>`. Never edit
  or vendor that file.
- All paths must be relative (Vite `base: "./"`).
- The sandbox blocks external networking: fetch, WebSocket, and WebRTC to
  outside hosts fail. Everything ships in the bundle.
- Never place API keys, tokens, or signed URLs in game code, saved state,
  score modes, logs, or leaderboard UI.
- Publish flow: portals.to/create → "create game" → GitHub repo link.
- TypeScript declarations: `/portals-sdk/portals.d.ts`.

## Lifecycle

- `await Portals.ready()` → session; `session.context` is `"standalone"`
  (game page) or `"room"` (inside a Portals room).
- `Portals.quit()` asks the host to close the game.

## Persistence, identity, scores

- `Portals.saveState(data)` / `Portals.loadState()` — JSON-serializable,
  ≤64 KB encoded. Version the schema.
- `Portals.identity.requestLogin()`, `Portals.identity.onChange(listener)`.
  Player IDs are stable per game but differ across games; `playerId` is null
  for unsigned users.
- `Portals.submitScore(score, mode?)` — mode: lowercase letters, numbers,
  hyphens, ≤32 chars. `Portals.getLeaderboard({limit: 1..100})`. Client-reported;
  casual use only. Saving/score submission require sign-in.

## Multiplayer — `Portals.net`

- `const session = await net.join({ channel? })` → `{ self, players, state }`.
  Channel: starts alphanumeric, ≤64 chars, `[A-Za-z0-9:_-]`.
- Live accessors: `net.players()`, `net.self()`, `net.getState(key?)`.
- Player shape: `{ id, playerId, displayName, avatarUrl }`. `id` is
  per-connection (two tabs = two players).
- `net.send(data)` — broadcast, ≤8 KB JSON, ~20/s per player. Senders do NOT
  receive their own broadcasts.
- `net.setState(key, value)` — shared state, ≤8 KB value, ≤128-char key,
  ≤64 keys per session, ~10 writes/s, last-write-wins. The `state` event fires
  for ALL players including the writer (apply via listener, not locally).
- Events: `net.on("message"|"playerjoin"|"playerleave"|"state"|"status")`.
- No auto-reconnect. On `status === "disconnected"`, call `join()` again.
- Authority model is client-reported. Design: elect a host client (e.g. lowest
  connection id among players) to run the authoritative game-sim and publish
  canonical state; migrate host on playerleave.
- Update cadence guidance: sample on 100–150 ms intervals and interpolate;
  never per-frame sends.

## Voice — `Portals.voice`

- `await voice.join()` → `{ self, participants, muted }` (promise pends during
  the consent card — do not race with timers).
- `voice.setMuted(bool)` / `voice.muted()`; `voice.devices()`;
  `voice.setDevice(id)`.
- Events: `participantjoin`, `participantleave`, `speaking` (ids array),
  `status`.
- Games never call getUserMedia; Portals owns the microphone.

## Availability matrix

| Context | Portals.net | Portals.voice |
|---|---|---|
| Game page | yes | yes |
| Portals room | yes (room = session) | no (room voice separate) |
| Editor preview | yes | no |
| Outside Portals | no | no |

The game must remain playable when both are unavailable (standalone/local dev):
wrap in adapters and fall back to LocalLoopback.

## Implications for FOLD & SEEK

- Full 12-player pose sync must fit the 8 KB / rate budget: quantized disguise
  states (bible §7.18) comfortably fit; Forge deltas coalesce at ≤10 Hz.
- The Colyseus server cannot be reached from inside Portals; the same
  game-sim runs on a host-elected client over Portals.net instead.
- ElevenLabs and any other external generation happens at BUILD time into
  bundled assets, never at runtime.

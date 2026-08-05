# Portals Hosted Web Game Constraints

Researched 2026-08-01, re-checked 2026-08-06, from:
- https://portals.to/documentation/advanced-tooling/portals-sdk
- https://portals.to/documentation/advanced-tooling/multiplayer-and-voice
- https://portals.to/documentation/advanced-tooling/server-scripts
- https://portals.to/documentation/advanced-tooling

## 2026-08-06 re-check: `Portals.net` unchanged, but SERVER SCRIPTS now exist

Every limit below was re-read against the live docs and still holds: 8 KB
messages and state values, ~20 broadcasts and ~10 state writes per second per
player, 64 state keys, 128-character key names, last-write-wins, no automatic
reconnect, senders do not receive their own broadcasts.

What is NEW is `server.js`, and it invalidates the premise behind this
project's biggest architectural decision (no authoritative server in Portals,
therefore host-elected client authority plus host migration):

- A root `server.js` runs on Portals' own servers as "an invisible,
  authoritative participant in every multiplayer session of your game",
  started automatically when players join and hot-swapped on publish.
- Plain JavaScript in a strict sandbox: no imports, no DOM, no browser
  globals, no network. One frozen `server` global mirroring `Portals.net`.
- The server holds EXCLUSIVE write access to state keys prefixed `server:`.
  Clients may read them but never write them. `server.kick(sessionId)` exists.
- Budgets: ~50 ms CPU per callback, 32 MB memory, 16 timers (>=50 ms), ~60
  broadcasts/s and ~30 state writes/s (both better than a client's), 8 KB
  messages, 64 keys, 128-character names, 512 KB script.
- A session survives the server crashing or exceeding its budget.
- `server.js` SHIPS PUBLICLY with the bundle: never put a secret in it.

Not yet verified for this project (do not treat as settled): whether an
imported GitHub bundle picks up `server.js` from the repo root or the built
`portals/` directory, and whether `packages/game-sim` plus its zod dependency
bundle to a single import-free file inside the 512 KB script limit.

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

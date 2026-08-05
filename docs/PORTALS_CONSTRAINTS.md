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

### The `server` API, as documented 2026-08-06

Top-level code, no exports. One frozen `server` global:

- `server.on("message" | "playerjoin" | "playerleave" | "state", handler)`
  — `message` is `(data, fromId)`, the roster events are `(player, players)`
  with `player = { id, playerId, displayName, avatarUrl }`, `state` is
  `(key, value)`.
- `server.send(data)` — broadcasts to ALL players. There is no addressed
  send. That is PARITY for this game, not a regression: private sim events
  already travel as broadcasts carrying a `to` field and are filtered by the
  receiving client (see `portalsProtocol.ts`).
- `server.setState(key, value)` / `server.getState(key?)`, `server.players()`,
  `server.kick(sessionId)`, `server.setTimeout` / `setInterval` /
  `clearTimer`, `server.log(...)`.

### Measured 2026-08-06: the simulation fits

Bundled `packages/game-sim` (with `@foldseek/shared` and zod) through esbuild
as a minified IIFE targeting es2020:

- **382.5 KB**, against the 512 KB script cap — about 130 KB of headroom.
- Zero `import`, `require`, or `export` in the output.
- Zero references to `window`, `document`, `process`, `navigator`, `fetch`,
  `WebSocket`, or `localStorage`.
- The sim's randomness is its own seeded RNG (`deterministic/rng.ts`); the
  only `Math.random`/`Date.now` in the tree is `generateId`, which the sim
  never calls. Determinism therefore survives the move.

This is what `packages/game-sim` being pure, DOM-free and transport-agnostic
bought: the authoritative simulation can physically run as a server script.

### Verified live 2026-08-06: it runs, from the SERVED BUNDLE

Two identical probe scripts were deployed, one at the repository root and
one in `portals/`, each writing a differently named `server:` key. Only a
server script can write a `server:` key, so the key that appears names the
location Portals used. Read back from a live editor session
(`visual/serverScriptProbe.mjs`):

```
serverKeys: ["server:probe_bundle"]
values:     { "server:probe_bundle": { where: "portals-bundle",
                                       note: "join", players: 2 } }
ack:        "ack from portals-bundle"
```

- **Server scripts work for a game imported from GitHub.** Settled.
- **`server.js` must live in the SERVED BUNDLE — `portals/` — not the
  repository root.** The root twin never ran and has been deleted. Anything
  that generates a server script must therefore emit it into `portals/`,
  and `syncPortalsBuild.mjs` must learn to publish and check it (today it
  copies only the Vite output, and a hand-placed file merely survives
  because the sync prunes nothing but stale `index-*` assets).
- Client to server to client messaging works: the client sent a probe, the
  server broadcast an ack, the client received it.
- The server sees the roster (`players: 2` across the editor's two panes).
- The live SDK reports **version 1.5.0**. Our vendored
  `apps/client/src/types/portals.d.ts` is headed v1.4.0, but its member set
  already matches what the live object exposes (`ready`, `getPlayer`,
  `quit`, `identity`, `saveState`, `loadState`, `submitScore`,
  `getLeaderboard`, `net`, `voice`); only the header comment is stale.
- Client-side `Portals.net` is unchanged: `join`, `leave`, `send`,
  `setState`, `getState`, `players`, `self`, `on`, `off`.

### From the full doc read, 2026-08-05 (every page, not just the SDK overview)

Read: documentation index, `advanced-tooling` index, `portals-sdk`,
`multiplayer-and-voice`, `server-scripts` (including its code examples),
`my-games` + `publish-your-game`, `api`, `portals-functions-quick-reference`,
`troubleshooting`, `start-here`. The Function Effect and JavaScript Function
sections describe the no-code room editor's scripting and do not apply to an
uploaded bundle.

Things that change how this game must be built:

- **Two identities, not one.** A player is
  `{ id, playerId, displayName, avatarUrl }`, where `id` is one connection
  (a second tab is a second player) and `playerId` is the signed-in account,
  **null when signed out**. A seat must therefore be keyed on
  `playerId ?? id`, which is what lets a player who drops and returns keep
  their disguise, warrants, and score.
- **`server.log` output is not surfaced anywhere.** The documented technique
  is to publish diagnostics to a state key instead. Error paths that only
  call `log` are silent in production.
- **The server's `state` event is `(key, value)` with no writer.** A client
  may write any key that is not `server:`-prefixed, and the server cannot
  attribute the write. So a client-published pose book is forgeable: nothing
  stops one client writing another's pose key. Poses and paint must instead
  travel to the server as **messages**, where `fromId` is the relay's own
  word, and be republished by the server under `server:` keys, which no
  client can write.
- **Only the server may write `server:` keys**; a client attempting it gets an
  `error` event with code `forbidden`. Clients read those keys normally.
- **`server.send` broadcasts only.** There is no addressed send, so private
  batches carry the seat they belong to and are filtered on arrival. This is
  the same exposure the relay protocol already accepted under §43.8.
- **A crashed or over-budget server does not end the session.** Players are
  never disconnected, and the documented guidance is to "keep the game
  playable when the server is absent" and to gate lobby UI on `server:` state
  appearing. This is in direct tension with an outright cutover; see below.
- **Channels partition servers exactly as they partition players** — one
  server instance per channel. Real channel-per-room matchmaking is therefore
  possible now, which the logical-room key budget existed to work around.
  Not acted on yet.
- **Editor preview runs the DRAFT `server.js`; a local dev session runs the
  PUBLISHED one.** So a draft is testable only in the preview.
- A dev token (`POST /api/v2/arcade/dev-token` with an `x-access-key`, valid
  8 hours, declared as `window.__PORTALS_DEV__` before the SDK script) gives a
  local build a real session on a fenced `dev:` channel. This is the only
  route to real multiplayer testing outside the editor, and it needs an
  access key the user holds.
- Client `state` events fire for the writer too; `message` does not.
- Channel names are 1–64 chars of letters, numbers, colons, underscores, and
  hyphens, starting with a letter or number. A `global:` prefix makes a
  worldwide room, served from the US at higher latency.

### Still unverified (do not treat as settled)

- Whether a full six-player round stays inside the ~50 ms CPU budget per
  callback **in the real sandbox**. Measured only in Node: worst tick
  1.133 ms of 50 ms at six seats, mean 0.0022 ms.
- Whether the authority's own traffic stays inside ~60 broadcasts/s and
  ~30 state writes/s once poses and paint are republished through it.

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

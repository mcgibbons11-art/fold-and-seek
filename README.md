# FOLD & SEEK

Fold yourself into the room.

A live multiplayer hide-and-seek party game. Mimics manually fold, stretch,
flatten, and reskin their articulated mechanical bodies into room objects.
An Inspector memorizes the room, then hunts for the furniture that is lying.

Built with Three.js (WebGPU renderer, WebGL 2 fallback), strict TypeScript,
React DOM shell, and a transport-agnostic authoritative match simulation that
runs against a Colyseus dedicated server (standalone) or over `Portals.net`
(when hosted as a Portals web game).

## Quick start

```bash
corepack enable
pnpm install
pnpm dev
```

- Client: http://localhost:5173
- Server: ws://localhost:2567 (health: http://localhost:2567/health)

## Workspace layout

| Path | Purpose |
|---|---|
| `apps/client` | Vite + React shell + imperative Three.js engine |
| `apps/server` | Colyseus authoritative server (standalone mode) |
| `packages/shared` | Protocol, schemas, config, IDs — no DOM, no Three |
| `packages/game-sim` | Pure deterministic match simulation |
| `assets-source/references` | Art-direction reference images (the quality bar) |
| `docs` | Portals constraints, workflow docs, status log |

## Scripts

- `pnpm dev` — run client and server in parallel
- `pnpm typecheck` / `pnpm test` / `pnpm build` — the standard gate
- `pnpm check` — all of the above

- `pnpm build:portals` â€” build in OS temp space and update the tracked bundle Portals serves
- `pnpm portals:check` â€” fail if the tracked Portals bundle is older than the current source

See `docs/STATUS.md` for current progress and known gaps.

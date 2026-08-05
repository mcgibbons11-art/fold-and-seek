import type { PortalsContext, PortalsPlayer, PortalsSdk } from "../types/portals";
import { detectPortals, isPortalsSdk } from "./PortalsNetAdapter";

/**
 * Finds out, once at boot, whether this page is running inside Portals and in
 * what capacity (docs/PORTALS_CONSTRAINTS.md).
 *
 * The SDK exists only where Portals put it. A hosted bundle is served with
 * `./_portals/sdk.js` beside it and the host injects the tag that loads it, so
 * the usual case is that `window.Portals` is already there before this module
 * runs. The import below is the fallback for a host that serves the file but
 * leaves the game to pull it in, and it is the reason nothing here is bundled:
 * the file is fetched from wherever the page itself lives, at run time, and
 * `@vite-ignore` keeps the build from trying to resolve a path that exists on
 * no developer's disk.
 *
 * Everything that can go wrong here means the same thing — we are not inside
 * Portals — so it all resolves to null and the game plays offline, which is
 * what the availability matrix requires of it.
 */

const SDK_PATH = "_portals/sdk.js";

/**
 * How long `ready()` is given before the game gives up on it. The handshake is
 * with the host page and should take milliseconds; the ceiling exists so a host
 * that never answers costs the player a pause rather than a menu that never
 * appears.
 */
export const PORTALS_READY_TIMEOUT_MS = 8_000;

export interface PortalsBoot {
  readonly sdk: PortalsSdk;
  /** "room" inside a Portals room, "standalone" on the game's own page. */
  readonly context: PortalsContext;
  /** Who Portals says this is. `displayName` is null for a player not signed in. */
  readonly player: PortalsPlayer;
}

export async function detectPortalsSession(): Promise<PortalsBoot | null> {
  const sdk = await loadSdk();
  if (sdk === null) return null;

  try {
    const session = await withTimeout(sdk.ready(), PORTALS_READY_TIMEOUT_MS);
    return { sdk, context: session.context, player: session.player };
  } catch (error) {
    console.warn("[portals] the SDK is present but did not become ready; playing offline", error);
    return null;
  }
}

/**
 * Hands a local build a real Portals session, when one has been arranged.
 *
 * Outside Portals there is no relay at all, so a local build normally plays
 * offline and multiplayer can only be exercised in the editor. A dev token
 * lifts that: declaring it before the SDK loads puts local sessions on a
 * `dev:` channel namespace, fenced away from live players. It is minted from
 * the account holder's access key, lasts eight hours, and is a password, so it
 * arrives through the environment and is never committed or bundled into a
 * published build.
 *
 * A local session runs the PUBLISHED `server.js`, not the working copy. Only
 * the editor preview runs a draft.
 */
function declareDevToken(): void {
  const token = import.meta.env.VITE_PORTALS_DEV_TOKEN;
  if (typeof token !== "string" || token.length === 0) return;
  if (import.meta.env.PROD) {
    // A published bundle carrying a token would hand every player the
    // account holder's credential.
    console.warn("[portals] a dev token is set in a production build; ignoring it");
    return;
  }
  const target = window as typeof window & { __PORTALS_DEV__?: { token: string } };
  target.__PORTALS_DEV__ = { token };
}

async function loadSdk(): Promise<PortalsSdk | null> {
  const injected = detectPortals();
  if (injected !== null) return injected;
  if (typeof document === "undefined") return null;
  declareDevToken();

  let module: unknown;
  try {
    module = await import(/* @vite-ignore */ new URL(SDK_PATH, document.baseURI).href);
  } catch {
    // No such file, or it is the host's 404 page rather than a module. Either
    // way this page is not being served by Portals.
    return null;
  }
  // The SDK announces itself on the window; a module export is accepted too so
  // that a future packaging of the same file still works.
  return detectPortals() ?? exportedSdk(module);
}

function exportedSdk(module: unknown): PortalsSdk | null {
  if (typeof module !== "object" || module === null) return null;
  const candidates = [
    (module as { default?: unknown }).default,
    (module as { Portals?: unknown }).Portals,
  ];
  return candidates.find(isPortalsSdk) ?? null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Portals.ready() did not settle within ${ms} ms`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

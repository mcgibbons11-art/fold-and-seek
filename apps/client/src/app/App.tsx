import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { MenuAmbience } from "../audio/MenuAmbience";
import { installAudioRuntime } from "../audio/AudioRuntime";
import { getMusicEngine } from "../audio/music";
import { installUiSounds } from "../audio/uiSounds";
import { GameHost, type RoundLoadProgress } from "../engine/GameHost";
import type { ForgeController } from "../forge/ForgeController";
import {
  createLocalRound,
  LOCAL_ROUND_NAME,
  seedFromLocation,
} from "../gameplay/localRound";
import { createPortalsRound, PORTALS_ROUND_CHANNEL, type PortalsRound } from "../gameplay/portalsRound";
import type { GameRound } from "../gameplay/round";
import type { RoundSession } from "../gameplay/RoundSession";
import { detectPortalsSession, type PortalsBoot } from "../networking/portalsBoot";
import type { QualityTier } from "../rendering/quality";
import type { ConnectionDetail } from "../networking/NetworkAdapter";
import type {
  OutgoingRoomJoinRequest,
  PendingRoomJoinRequest,
  RoomEntryFailure,
  RoomEntryResult,
} from "../networking/PortalsNetAdapter";
import { MAX_CONCURRENT_ROOMS, type RoomListing } from "../networking/roomRegistry";
import {
  GraphicsRecoveryPolicy,
  RendererInitError,
  type DeviceEvent,
  type RenderBackend,
} from "../rendering/RendererManager";
import { ForgeHud } from "../ui/ForgeHud";
import {
  ALARM,
  BRASS,
  BRASS_LIT,
  CREAM,
  FONT_DISPLAY,
  FONT_UI,
  PRESS_CLASS,
  SCREEN_WASH,
  buttonStyle,
  labelStyle,
  ornamentRuleStyle,
  plate,
  primaryButtonStyle,
} from "../ui/rounds/theme";
import { LoadingScreen } from "../ui/LoadingScreen";
import { MainMenu } from "../ui/MainMenu";
import { StartScreen } from "../ui/StartScreen";
import type { RoomBrowserProps } from "../ui/RoomBrowser";
import { RoundHud } from "../ui/RoundHud";
import { AtomicLiveRegion, useScreenEntryFocus } from "../ui/accessibility";

type BootState =
  | { kind: "detecting" }
  | { kind: "initializing" }
  | { kind: "ready"; backend: RenderBackend }
  | { kind: "failed"; headline: string; detail: string };

interface GpuCapableNavigator extends Navigator {
  readonly gpu?: { requestAdapter(): Promise<unknown | null> };
}

/** Everything one live round holds open, so leaving it releases all of it. */
interface ActiveRound {
  readonly round: GameRound;
  readonly session: RoundSession;
}

const DEFAULT_PLAYER_NAME = "Curator";

/**
 * How often the menu re-reads the session's rooms. Well inside the window a
 * room is retired after, so a room that goes quiet leaves the list promptly
 * without the menu polling hard enough to be felt.
 */
const ROOM_LIST_REFRESH_MS = 2_000;
/** Let the browser restore a lost WebGL context before asking for a new one. */
const CONTEXT_RESTORE_WAIT_MS = 2_000;
/** A rebuild that draws this long counts as healthy rather than consecutive. */
const GRAPHICS_STABLE_MS = 15_000;
/** Briefly leave the recovery copy readable before rebuilding the whole tree. */
const AUTO_RECOVERY_NOTICE_MS = 350;

const NO_BACKEND_HEADLINE = "This browser cannot draw the shop";
const NO_BACKEND_DETAIL =
  "FOLD & SEEK needs WebGPU or WebGL 2, and this browser offers neither. A current version of Chrome, Edge, Firefox, or Safari will run it.";

async function hasDrawableBackend(): Promise<boolean> {
  const gpu = (navigator as GpuCapableNavigator).gpu;
  if (gpu !== undefined) {
    try {
      if ((await gpu.requestAdapter()) !== null) {
        return true;
      }
    } catch {
      // Fall through: WebGL 2 may still be available.
    }
  }
  const probe = document.createElement("canvas");
  return probe.getContext("webgl2") !== null;
}

/**
 * WebGL context restoration is asynchronous. The old GameHost is disposed by
 * the boot effect's cleanup before this runs; when the browser still reports a
 * lost context, wait for its restoration event (with a bounded fallback) before
 * constructing the replacement renderer.
 */
async function waitForCanvasRestore(canvas: HTMLCanvasElement): Promise<void> {
  const context = canvas.getContext("webgl2");
  if (context === null || !context.isContextLost()) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      canvas.removeEventListener("webglcontextrestored", finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, CONTEXT_RESTORE_WAIT_MS);
    canvas.addEventListener("webglcontextrestored", finish, { once: true });
  });
}

function describeFailure(error: unknown): { headline: string; detail: string } {
  if (error instanceof RendererInitError) {
    return {
      headline: NO_BACKEND_HEADLINE,
      detail:
        "Your browser can run FOLD & SEEK in Light mode once the graphics device recovers. Right now neither the WebGPU nor the WebGL 2 backend would start.",
    };
  }
  return {
    headline: "The shop failed to open",
    detail: error instanceof Error ? error.message : "An unknown error stopped the renderer from starting.",
  };
}

/** What to tell the player about a join the room refused (§27.3 wording). */
const JOIN_FAILURE_COPY: Readonly<Record<string, string>> = {
  room_full: "That room already has as many players as a round allows.",
  duplicate_session: "This account is already playing from another tab.",
  join_failed: "The room would not let this game join. Try again in a moment.",
  transport_unavailable: "Multiplayer is unavailable here.",
};

function joinFailureCopy(detail: ConnectionDetail, error: unknown): string {
  const known = detail === null ? undefined : JOIN_FAILURE_COPY[detail];
  if (known !== undefined) return known;
  return error instanceof Error ? error.message : "The round could not be opened.";
}

/** What to tell the player about a room they could not get into. */
const ROOM_FAILURE_COPY: Readonly<Record<RoomEntryFailure, string>> = {
  not_in_session: "This game is not connected to the others in this session yet.",
  no_such_room: "That room has closed. Pick another, or open one of your own.",
  room_full: "That room already has as many players as a round allows.",
  session_full: `This session holds ${MAX_CONCURRENT_ROOMS} rooms at once. Join one of them, or wait for a room to empty.`,
  request_pending: "You already have a join request waiting for this host.",
  already_in_room: "You are already in a room.",
};

const noticeStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeContent: "center",
  justifyItems: "center",
  textAlign: "center",
  padding: 32,
  background: SCREEN_WASH,
  color: CREAM,
  font: `15px/1.7 ${FONT_UI}`,
  pointerEvents: "auto",
};

/**
 * The wordmark every boot-time screen carries, so a failure still looks like
 * FOLD & SEEK rather than an unstyled browser error.
 */
function NoticeMark(): ReactElement {
  return (
    <>
      <h1
        className="fs-candle"
        style={{
          margin: 0,
          font: `600 30px/1.1 ${FONT_DISPLAY}`,
          letterSpacing: "0.16em",
          textIndent: "0.16em",
        }}
      >
        <span style={{ color: BRASS_LIT }}>FOLD</span>
        <span style={{ color: BRASS, opacity: 0.8 }}> &amp; </span>
        <span style={{ color: CREAM, fontWeight: 400 }}>SEEK</span>
      </h1>
      <div style={{ ...ornamentRuleStyle(180), margin: "14px auto 18px" }} aria-hidden />
    </>
  );
}

function ReturningToMenu(): ReactElement {
  const screenRef = useScreenEntryFocus<HTMLDivElement>("returning-to-menu");
  return (
    <div ref={screenRef} style={noticeStyle}>
      <AtomicLiveRegion message="Returning to menu" />
      <div style={{ textAlign: "center" }}>
        <NoticeMark />
        <p
          style={{ ...labelStyle, opacity: 0.78, margin: 0 }}
          tabIndex={-1}
          data-entry-focus="true"
        >
          Returning to menuâ€¦
        </p>
      </div>
    </div>
  );
}

export function App(): ReactElement {
  const [boot, setBoot] = useState<BootState>({ kind: "detecting" });
  const [tier, setTier] = useState<QualityTier>("high");
  const [forge, setForge] = useState<ForgeController | null>(null);
  const [round, setRound] = useState<ActiveRound | null>(null);
  /** The Portals session, or null when this page is not inside Portals. */
  const [portals, setPortals] = useState<PortalsBoot | null>(null);
  const [loading, setLoading] = useState<RoundLoadProgress | null>(null);
  /** Why the last attempt to open a round did not get as far as the shop. */
  const [roundError, setRoundError] = useState<string | null>(null);
  const [deviceFault, setDeviceFault] = useState<DeviceEvent | null>(null);
  /**
   * The relay session held open at the menu, so the room browser has something
   * to read. It is a whole round object rather than a bare adapter because the
   * adapter is built with the map, the validator and the bots that whichever
   * client ends up host will need, and building that twice would mean the
   * browser and the round disagreeing about the shop.
   */
  const [lobby, setLobby] = useState<PortalsRound | null>(null);
  const [rooms, setRooms] = useState<readonly RoomListing[]>([]);
  const [roomRequests, setRoomRequests] = useState<readonly PendingRoomJoinRequest[]>([]);
  const [outgoingRoomRequest, setOutgoingRoomRequest] = useState<OutgoingRoomJoinRequest | null>(null);
  /** True while the session is being joined or rejoined, so nothing is pressed twice. */
  const [lobbyBusy, setLobbyBusy] = useState(false);
  /** The boot hands off to one deliberate start input before opening navigation. */
  const [menuEntered, setMenuEntered] = useState(false);
  /** True while the old room is released and the menu relay session is restored. */
  const [returningToMenu, setReturningToMenu] = useState(false);
  /** Incrementing this disposes and rebuilds the complete GPU-owned tree. */
  const [bootAttempt, setBootAttempt] = useState(0);
  const hostRef = useRef<GameHost | null>(null);
  const lobbyRef = useRef<PortalsRound | null>(null);
  const roundRef = useRef<ActiveRound | null>(null);
  /** Read inside the click handler, where the loading state itself is stale. */
  const loadingRef = useRef(false);
  /** Synchronous once-only guard for repeated leave confirmation inputs. */
  const returningToMenuRef = useRef(false);
  /** Cancels whichever join/build currently owns the loading screen. */
  const cancelOpeningRef = useRef<(() => void) | null>(null);
  /** The menu session owns this listener until that session is replaced. */
  const lobbyRejectionRef = useRef<(() => void) | null>(null);
  /** Consecutive full renderer rebuilds before the player gets the fallback. */
  const graphicsRecoveryRef = useRef(new GraphicsRecoveryPolicy());
  /** Retained so a failed rebuild can explain the original device fault. */
  const lastDeviceFaultRef = useRef<DeviceEvent | null>(null);
  /** Logical room to re-enter after the GPU-owned tree has been rebuilt. */
  const recoveryRoomCodeRef = useRef<string | null>(null);
  /** Last recoverable directory action, retained for the notice's Retry control. */
  const lastRoomActionRef = useRef<(() => void) | null>(null);
  /** Prevents a rapid double press from starting two complete renderer boots. */
  const bootRetryPendingRef = useRef(false);

  useEffect(() => {
    // Playwright's headless Edge session does not expose the WebGL device the
    // game scene needs. Keep a development-only doorway into the real menu and
    // lobby components so their responsive layouts can still be reviewed in a
    // browser. `import.meta.env.DEV` is replaced at build time, so a shipped
    // page can never opt out of renderer validation with a query string.
    if (
      (import.meta.env.DEV || import.meta.env.MODE === "visual") &&
      new URLSearchParams(window.location.search).has("visualReview")
    ) {
      let cancelled = false;
      void detectPortalsSession().then((session) => {
        if (cancelled) return;
        setPortals(session);
        setBoot({ kind: "ready", backend: "webgl2" });
      });
      return () => {
        cancelled = true;
      };
    }

    const canvas = document.getElementById("game-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      setBoot({ kind: "failed", headline: "The shop failed to open", detail: "The game canvas is missing from the page." });
      return;
    }

    let disposed = false;
    let host: GameHost | null = null;

    const runBootSequence = async (): Promise<void> => {
      if (bootAttempt > 0) await waitForCanvasRestore(canvas);
      if (disposed) return;
      // Both probes ask something outside the page and neither depends on the
      // other, so the slower one sets the length of the boot rather than the
      // sum of the two.
      const [drawable, session] = await Promise.all([
        hasDrawableBackend(),
        detectPortalsSession(),
      ]);
      if (!drawable) {
        if (!disposed) {
          setBoot({ kind: "failed", headline: NO_BACKEND_HEADLINE, detail: NO_BACKEND_DETAIL });
        }
        return;
      }
      if (disposed) {
        return;
      }
      // The context label is NOT the multiplayer gate. Measured in the real
      // editor (2026-08-02): the 2p preview panes share a live Portals.net
      // session while ready() still reports "standalone", and a bare game page
      // refuses net.join() with "no host page" regardless of label. Joinability
      // is decided by the join attempt itself, so multiplayer is offered
      // wherever the SDK exists and the join's own failure copy handles the
      // pages where there is nobody to reach.
      setPortals(session);
      setBoot({ kind: "initializing" });

      host = new GameHost(
        canvas,
        {
          onTierChange: (next) => {
            setTier(next);
          },
          onDeviceEvent: (event) => {
            // A lost device cannot be recovered in place: every GPU resource the
            // renderer holds is already gone. A device error is survivable, so
            // it stays out of the player's way.
            if (event.kind === "device-lost") {
              lastDeviceFaultRef.current = event;
              setDeviceFault(event);
            }
          },
        },
        // WebGL 2 is the launch default: across every measurement session the
        // WebGPU path rendered the shop erratically (0.1-5 fps against a
        // consistent 12-21 on WebGL 2, same content, same machine) and the
        // cause is still open — see docs/STATUS.md "WebGPU shop performance".
        // `?webgpu` opts back in for investigation.
        { forceWebGL: !new URLSearchParams(window.location.search).has("webgpu") },
      );
      hostRef.current = host;

      try {
        await host.initialize();
      } catch (error) {
        host.dispose();
        hostRef.current = null;
        if (!disposed) {
          const previousFault = lastDeviceFaultRef.current;
          if (graphicsRecoveryRef.current.attemptsUsed > 0 && previousFault !== null) {
            // Feeding a fresh object back into the recovery effect spends the
            // second automatic attempt. Once its budget is gone, the same state
            // remains as the player's manual fallback instead of looping.
            setDeviceFault({
              ...previousFault,
              message: `${previousFault.message} The renderer rebuild did not initialize.`,
            });
          } else {
            setBoot({ kind: "failed", ...describeFailure(error) });
          }
        }
        return;
      }

      if (disposed) {
        host.dispose();
        hostRef.current = null;
        return;
      }

      host.start();
      setTier(host.tier);
      setBoot({ kind: "ready", backend: host.backend });
    };

    void runBootSequence();

    return () => {
      disposed = true;
      // The round holds the adapter's ticking simulation, so it is released
      // before the host that owns the scene its systems are attached to.
      roundRef.current?.round.dispose();
      roundRef.current = null;
      lobbyRejectionRef.current?.();
      lobbyRejectionRef.current = null;
      lobbyRef.current?.dispose();
      lobbyRef.current = null;
      host?.dispose();
      hostRef.current = null;
    };
  }, [bootAttempt]);

  useEffect(() => {
    if (boot.kind === "failed") bootRetryPendingRef.current = false;
  }, [boot.kind]);

  useEffect(() => {
    if (boot.kind !== "ready" || deviceFault !== null) return undefined;
    const timer = window.setTimeout(() => {
      graphicsRecoveryRef.current.markStable();
      lastDeviceFaultRef.current = null;
    }, GRAPHICS_STABLE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [boot.kind, deviceFault]);

  // The whole shell's click and hover, for the life of the page. It listens at
  // the document rather than in the components, so every panel the game grows
  // later is audible without being wired for it.
  useEffect(() => installUiSounds(), []);
  useEffect(() => installAudioRuntime(), []);

  const menuAmbience = useMemo(() => new MenuAmbience(), []);
  useEffect(() => () => {
    menuAmbience.dispose();
  }, [menuAmbience]);

  /**
   * The menu has beds of its own because the round's ambience does not exist
   * yet: `AmbienceController` is built with a round and treats the lobby as
   * silent, so everything before the player presses play used to be dead air.
   * They close again as soon as anything else opens, and the fade is short
   * enough that the shop is never heard twice over.
   */
  const atMenu =
    boot.kind === "ready" &&
    round === null &&
    forge === null &&
    loading === null &&
    !returningToMenu;
  useEffect(() => {
    if (atMenu) menuAmbience.start();
    else menuAmbience.stop();
  }, [atMenu, menuAmbience]);

  /**
   * The score, everywhere there is no round. A round reads the phase and the
   * watched meter every frame and sets its own scene, so the shell stands back
   * while one exists; what is left is the menu, the loading screen and the
   * practice workbench, and exactly one of them is on screen at a time. Keeping
   * the decision in one place is what stops two owners writing to the one
   * engine and cutting each other off mid-bar.
   */
  useEffect(() => {
    if (round !== null) return;
    getMusicEngine().setScene(forge === null ? "menu" : "forge");
  }, [round, forge]);
  useEffect(() => () => {
    getMusicEngine().setScene("silent");
  }, []);

  /**
   * Holds a relay session open while the player is at the menu, which is what
   * the room browser reads.
   *
   * It runs after the renderer is up rather than beside it. The join is a
   * ten-second-capped handshake with the Portals host, and a build holding the
   * main thread was measured (editor, 2026-08-02) blocking the reply past that
   * cap: the join "timed out", the host kept the seat, and every retry was
   * refused. At the menu the reply has the thread to itself.
   *
   * A session this client cannot join is not an error. A bare game page has no
   * host to reach, and the menu falls back to the single play button and a solo
   * round, which is what it offered before rooms existed.
   */
  const openSession = useCallback(async (session: PortalsBoot): Promise<void> => {
    if (lobbyRef.current !== null) return;
    setLobbyBusy(true);
    const opened = createPortalsRound({ sdk: session.sdk });
    lobbyRef.current = opened;
    try {
      await opened.adapter.connect();
      await opened.adapter.joinSession(
        PORTALS_ROUND_CHANNEL,
        session.player.displayName ?? DEFAULT_PLAYER_NAME,
      );
    } catch {
      console.warn("[rooms] relay unavailable; solo play remains available");
      lobbyRef.current = null;
      opened.dispose();
      setLobbyBusy(false);
      return;
    }
    setRooms(opened.adapter.listRooms());
    opened.adapter.onDirectory(setRooms);
    lobbyRejectionRef.current?.();
    lobbyRejectionRef.current = opened.adapter.onRejection((rejection) => {
      if (rejection.type === "create_room") {
        setRoundError(
          rejection.detail === undefined
            ? "The room could not be opened. Try another name or room slot."
            : `The room could not be opened: ${rejection.detail}`,
        );
      } else if (rejection.type === "state_publish" && roundRef.current === null) {
        setRoundError(
          "The room opened locally, but its listing could not be shared. Reopen it or reconnect to the session.",
        );
      }
    });
    setLobby(opened);
    setLobbyBusy(false);
  }, []);

  useEffect(() => {
    if (boot.kind !== "ready" || portals === null) return;
    void openSession(portals);
  }, [boot.kind, portals, openSession]);

  /**
   * Re-reads the registry on a timer as well as on every write.
   *
   * A room that ends because its host closed the tab writes nothing at all: it
   * simply stops advertising, and the registry retires it once its heartbeat has
   * been quiet long enough. Nothing on the wire marks that moment, so without a
   * clock of its own the browser would go on offering a room that is not there.
   */
  useEffect(() => {
    if (lobby === null) return undefined;
    const timer = setInterval(() => {
      setRooms(lobby.adapter.listRooms());
    }, ROOM_LIST_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [lobby]);

  const onTierSelect = useCallback((value: QualityTier) => {
    hostRef.current?.setQualityTier(value);
    setTier(value);
  }, []);

  const onEnterForge = useCallback(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    host.enterForgeMode();
    setForge(host.forgeController);
  }, []);

  const onLeaveForge = useCallback(() => {
    hostRef.current?.exitForgeMode();
    setForge(null);
  }, []);

  const onPlayRound = useCallback(() => {
    const host = hostRef.current;
    if (host === null || roundRef.current !== null || loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setLoading({ label: "the shop", fraction: 0 });

    // This callback is exposed only when no room-browser relay is held, and its
    // button explicitly says "Begin solo round". The SDK can still be injected
    // in that state when Portals.net is temporarily unavailable. Treating SDK
    // presence as multiplayer here made that solo click issue another relay
    // join during loading and turn a ProgressEvent into a fatal shop error.
    // Matchmade rounds enter through onEnterRoom and reuse the held adapter.
    const opening: { round: GameRound; channel: string; displayName: string } = {
      round: createLocalRound({ seed: seedFromLocation(window.location.search) }),
      channel: LOCAL_ROUND_NAME,
      displayName: DEFAULT_PLAYER_NAME,
    };
    const { round: opened } = opening;
    let cancelled = false;

    const clearOpening = (): void => {
      if (cancelOpeningRef.current === cancel) cancelOpeningRef.current = null;
    };
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      clearOpening();
      roundRef.current = null;
      loadingRef.current = false;
      host.exitRoundMode();
      opened.dispose();
      setLoading(null);
    };
    cancelOpeningRef.current = cancel;

    setRoundError(null);
    const abandon = (error: unknown): void => {
      if (cancelled) return;
      console.error("[round] could not open the shop", error);
      clearOpening();
      roundRef.current = null;
      loadingRef.current = false;
      opened.dispose();
      host.exitRoundMode();
      setLoading(null);
      // A refused join is the common case here and it is entirely the player's
      // business why: a full room and a second tab of one account read as the
      // game doing nothing at all otherwise.
      setRoundError(joinFailureCopy(opened.adapter.getConnection().detail, error));
    };

    // JOIN FIRST, BUILD SECOND — the order is load-bearing. The join is a
    // 10-second-capped handshake with the host, and running it while the
    // shop build holds the main thread was measured (editor, 2026-08-02)
    // blocking the host's reply past that cap: the join "timed out", the
    // host kept the seat, and every retry was refused. At the menu the reply
    // has the thread to itself and a refused join surfaces in seconds, not
    // after the whole load. The build then yields the frame back between
    // zones, so the loading screen animates and the menu room keeps drawing
    // behind it; enterRoundMode resolves null when the player left before
    // the shop was ready.
    (async () => {
      await opened.adapter.connect();
      if (cancelled) return;
      await opened.adapter.join(opening.channel, opening.displayName);
      if (cancelled) return;
      const session = await host.enterRoundMode(
        opened.adapter,
        opened.director,
        opened.spatial,
        setLoading,
      );
      if (session === null) {
        clearOpening();
        opened.dispose();
        loadingRef.current = false;
        setLoading(null);
        return;
      }
      const active: ActiveRound = { round: opened, session };
      clearOpening();
      roundRef.current = active;
      loadingRef.current = false;
      setRound(active);
      setLoading(null);
    })().catch(abandon);
  }, []);

  /**
   * Takes the room the player picked and opens the shop in it.
   *
   * The relay session is already held, so this is the room half of the old
   * join: the choice is made against the live registry, and only once a seat is
   * actually taken does the shop start unpacking. A refusal costs nothing and
   * leaves the player in the browser with a reason.
   */
  const onEnterRoom = useCallback(
    (choose: (round: PortalsRound) => RoomEntryResult) => {
      const host = hostRef.current;
      const opened = lobbyRef.current;
      if (host === null || opened === null || roundRef.current !== null || loadingRef.current) {
        return;
      }

      let entered: RoomEntryResult;
      try {
        entered = choose(opened);
      } catch (error) {
        console.error("[rooms] room choice failed", error);
        setRoundError(joinFailureCopy(opened.adapter.getConnection().detail, error));
        return;
      }
      if (!entered.ok) {
        setRoundError(ROOM_FAILURE_COPY[entered.reason]);
        return;
      }

      setRoundError(null);
      loadingRef.current = true;
      setLoading({ label: "the shop", fraction: 0 });
      let cancelled = false;
      const clearOpening = (): void => {
        if (cancelOpeningRef.current === cancel) cancelOpeningRef.current = null;
      };
      const cancel = (): void => {
        if (cancelled) return;
        cancelled = true;
        clearOpening();
        opened.adapter.leaveRoom();
        loadingRef.current = false;
        host.exitRoundMode();
        setLoading(null);
      };
      cancelOpeningRef.current = cancel;

      void (async () => {
        try {
          const session = await host.enterRoundMode(
            opened.adapter,
            opened.director,
            opened.spatial,
            setLoading,
          );
          if (cancelled) return;
          if (session === null) {
            clearOpening();
            opened.adapter.leaveRoom();
            loadingRef.current = false;
            setLoading(null);
            return;
          }
          const active: ActiveRound = { round: opened, session };
          clearOpening();
          roundRef.current = active;
          loadingRef.current = false;
          setRound(active);
          setLoading(null);
        } catch (error) {
          if (cancelled) return;
          console.error("[round] could not open the shop", error);
          clearOpening();
          opened.adapter.leaveRoom();
          roundRef.current = null;
          loadingRef.current = false;
          host.exitRoundMode();
          setLoading(null);
          setRoundError(joinFailureCopy(opened.adapter.getConnection().detail, error));
        }
      })();
    },
    [],
  );

  const onCancelOpening = useCallback(() => {
    cancelOpeningRef.current?.();
  }, []);

  const reconnectLobby = useCallback((): void => {
    if (portals === null || lobbyBusy) return;
    const previous = lobbyRef.current;
    lobbyRef.current = null;
    lobbyRejectionRef.current?.();
    lobbyRejectionRef.current = null;
    setLobby(null);
    setRooms([]);
    setRoomRequests([]);
    setOutgoingRoomRequest(null);
    setRoundError(null);
    setLobbyBusy(true);
    void (async () => {
      if (previous !== null) {
        try {
          await previous.adapter.disconnect();
        } catch (error) {
          console.warn("[rooms] reconnect cleanup was not clean", error);
        }
        previous.dispose();
      }
      await openSession(portals);
    })();
  }, [lobbyBusy, openSession, portals]);

  useEffect(() => {
    if (lobby === null) {
      setRoomRequests([]);
      setOutgoingRoomRequest(null);
      return undefined;
    }
    const refresh = (): void => {
      setRoomRequests(lobby.adapter.pendingJoinRequests());
      setOutgoingRoomRequest(lobby.adapter.outgoingJoinRequest());
    };
    refresh();
    const stopRequests = lobby.adapter.onRoomRequests(refresh);
    const stopDecision = lobby.adapter.onRoomDecision((decision) => {
      refresh();
      if (decision.accepted) {
        const enterAcceptedRoom = (): void => {
          onEnterRoom((opened) => opened.adapter.enterRoom(decision.roomCode));
        };
        lastRoomActionRef.current = enterAcceptedRoom;
        enterAcceptedRoom();
        return;
      }
      const copy = {
        declined: "The host declined that join request.",
        expired: "The host did not answer within five minutes. Pick another room or try again.",
        room_full: "That room filled before the host could accept you.",
        room_started: "That room has already started its match.",
        host_left: "That room closed while you were waiting.",
        accepted: "The room accepted you.",
      }[decision.reason];
      setRoundError(copy);
    });
    return () => {
      stopRequests();
      stopDecision();
    };
  }, [lobby, onEnterRoom]);

  /**
   * A device loss invalidates the renderer and every scene resource it owns.
   * Re-running the boot effect disposes that whole tree, then builds a fresh
   * renderer and menu room against the restored canvas.
   */
  const recoverGraphics = useCallback(() => {
    const activeRoom =
      roundRef.current?.round.adapter.getRoomCode?.() ??
      lobbyRef.current?.adapter.getRoomCode?.() ??
      null;
    if (activeRoom !== null) recoveryRoomCodeRef.current = activeRoom;
    cancelOpeningRef.current?.();
    setRound(null);
    setForge(null);
    setLoading(null);
    setLobby(null);
    setRooms([]);
    setPortals(null);
    setRoundError(null);
    setLobbyBusy(false);
    setDeviceFault(null);
    setBoot({ kind: "detecting" });
    setBootAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    if (deviceFault === null) return undefined;
    if (graphicsRecoveryRef.current.requestRebuild() === "fallback") return undefined;
    const timer = window.setTimeout(recoverGraphics, AUTO_RECOVERY_NOTICE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [deviceFault, recoverGraphics]);

  useEffect(() => {
    const roomCode = recoveryRoomCodeRef.current;
    if (lobby === null || roomCode === null) return;
    recoveryRoomCodeRef.current = null;
    onEnterRoom((opened) => opened.adapter.enterRoom(roomCode));
  }, [lobby, onEnterRoom]);

  const onManualGraphicsRecovery = useCallback(() => {
    graphicsRecoveryRef.current.markStable();
    graphicsRecoveryRef.current.requestRebuild();
    recoverGraphics();
  }, [recoverGraphics]);

  const retryBoot = useCallback((): void => {
    if (bootRetryPendingRef.current) return;
    bootRetryPendingRef.current = true;
    setBoot({ kind: "detecting" });
    setBootAttempt((attempt) => attempt + 1);
  }, []);

  const onLeaveRound = useCallback(async (): Promise<void> => {
    if (returningToMenuRef.current) return;
    const active = roundRef.current;
    if (active === null) return;
    returningToMenuRef.current = true;
    setReturningToMenu(true);
    roundRef.current = null;
    setRound(null);
    // Order matters: the host disposes the session, which is what unhooks the
    // engine from an adapter that is still delivering events.
    hostRef.current?.exitRoundMode();

    if (active.round !== lobbyRef.current) {
      try {
        active.round.dispose();
      } finally {
        returningToMenuRef.current = false;
        setReturningToMenu(false);
      }
      return;
    }
    // A round played in a Portals room is torn down whole and the session
    // rejoined, rather than the seat alone being given up. The director carries
    // a round's worth of accumulated feeds — the accusations, the missed-finds
    // board, the votes — and it resets those on entering a lobby, which a
    // client that walks into a room ALREADY in its lobby never sees. Reusing it
    // for the next room would show that room the last one's evidence.
    lobbyRef.current = null;
    lobbyRejectionRef.current?.();
    lobbyRejectionRef.current = null;
    setLobby(null);
    // Held busy across the whole handover. Without it the menu falls back to
    // the plain play button for as long as the rejoin takes, and pressing it
    // would build a second transport while this one is still letting go of the
    // session the SDK only has one of.
    setLobbyBusy(true);
    const previous = active.round;
    try {
      await previous.adapter.disconnect();
    } catch (error) {
      console.warn("[rooms] leaving the session was not clean", error);
    }
    try {
      previous.dispose();
      if (portals !== null) await openSession(portals);
    } finally {
      returningToMenuRef.current = false;
      setReturningToMenu(false);
    }
  }, [portals, openSession]);

  // A device loss outranks the boot state: the renderer came up, so `boot` still
  // reads "ready" while nothing can actually be drawn.
  if (deviceFault !== null) {
    return (
      <div style={noticeStyle} role="alert" aria-label="Graphics error">
        <div style={{ ...plate(true), borderRadius: 14, padding: "30px 34px", maxWidth: 540 }}>
          <NoticeMark />
          <div style={{ ...labelStyle, color: ALARM, marginBottom: 7 }}>Graphics error</div>
          <p style={{ margin: "0 0 10px", font: `17px/1.5 ${FONT_DISPLAY}`, color: ALARM }}>
            {graphicsRecoveryRef.current.exhausted
              ? "The graphics device was lost twice. The automatic rebuild has paused."
              : "The graphics device was lost. The shop is rebuilding its renderer safely."}
          </p>
          <p style={{ ...labelStyle, opacity: 0.6, margin: 0 }}>
            {deviceFault.api}: {deviceFault.message}
          </p>
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 20 }}>
            <button
              type="button"
              className={PRESS_CLASS}
              style={{ ...primaryButtonStyle, width: "auto", minWidth: 180 }}
              onClick={onManualGraphicsRecovery}
            >
              Recover graphics
            </button>
            <button
              type="button"
              className={PRESS_CLASS}
              style={{ ...buttonStyle, width: "auto", margin: 0 }}
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (boot.kind === "failed") {
    return (
      <div style={noticeStyle} role="alert" aria-label="Startup error">
        <div style={{ ...plate(true), borderRadius: 14, padding: "30px 34px", maxWidth: 540 }}>
          <NoticeMark />
          <div style={{ ...labelStyle, color: ALARM, marginBottom: 7 }}>Startup error</div>
          <p style={{ margin: "0 0 10px", font: `17px/1.5 ${FONT_DISPLAY}`, color: ALARM }}>
            {boot.headline}
          </p>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{boot.detail}</p>
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 20 }}>
            <button
              type="button"
              autoFocus
              className={PRESS_CLASS}
              style={{ ...primaryButtonStyle, width: "auto", minWidth: 150 }}
              onClick={retryBoot}
            >
              Retry startup
            </button>
            <button
              type="button"
              className={PRESS_CLASS}
              style={{ ...buttonStyle, width: "auto", margin: 0 }}
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (boot.kind !== "ready") {
    return (
      <div style={noticeStyle} role="status" aria-live="polite">
        <div style={{ textAlign: "center" }}>
          <NoticeMark />
          <p style={{ ...labelStyle, opacity: 0.7, margin: 0 }}>
            {boot.kind === "detecting" ? "Checking your browser…" : "Unpacking the reading nook…"}
          </p>
        </div>
      </div>
    );
  }

  if (round !== null) {
    return (
      <RoundHud
        director={round.round.director}
        session={round.session}
        onLeave={onLeaveRound}
        qualityTier={tier}
        onQualityTierChange={onTierSelect}
      />
    );
  }

  if (returningToMenu) return <ReturningToMenu />;

  if (forge !== null) {
    return <ForgeHud controller={forge} onExit={onLeaveForge} />;
  }

  if (loading !== null) {
    return <LoadingScreen progress={loading} onCancel={onCancelOpening} />;
  }

  if (!menuEntered) {
    return (
      <StartScreen
        onEnter={() => {
          setMenuEntered(true);
        }}
      />
    );
  }

  // Offered only while a relay session is actually held. Without one there is
  // nothing to browse, and the menu shows the single play button it always did.
  const browser: RoomBrowserProps | null =
    lobby === null
      ? null
      : {
          rooms,
          currentCode: lobby.adapter.getRoomCode(),
          pendingRequests: roomRequests,
          outgoingRequest: outgoingRoomRequest,
          busy: lobbyBusy,
          notice: roundError,
          onJoin: (code) => {
            const attempt = (): void => {
              const result = lobby.adapter.requestRoom(code);
              if (!result.ok) setRoundError(ROOM_FAILURE_COPY[result.reason]);
              else setRoundError(null);
            };
            lastRoomActionRef.current = attempt;
            attempt();
          },
          onCreate: (name) => {
            const attempt = (): void => {
              const result = lobby.adapter.createRoom(name);
              if (!result.ok) setRoundError(ROOM_FAILURE_COPY[result.reason]);
              else setRoundError(null);
            };
            lastRoomActionRef.current = attempt;
            attempt();
          },
          onQuickJoin: () => {
            const attempt = (): void => {
              const result = lobby.adapter.requestQuickRoom();
              if (!result.ok) setRoundError(ROOM_FAILURE_COPY[result.reason]);
              else setRoundError(null);
            };
            lastRoomActionRef.current = attempt;
            attempt();
          },
          onRetryNotice: () => {
            const retry = lastRoomActionRef.current;
            setRoundError(null);
            if (retry !== null) window.setTimeout(retry, 0);
          },
          onReconnect: reconnectLobby,
          onDismissNotice: () => setRoundError(null),
          onForgePractice: onEnterForge,
          onAcceptRequest: (connectionId) => {
            const result = lobby.adapter.acceptRoomRequest(connectionId);
            if (!result.ok) {
              setRoundError(ROOM_FAILURE_COPY[result.reason]);
              return;
            }
            lastRoomActionRef.current = () => {
              onEnterRoom((opened) => opened.adapter.enterRoom(result.code));
            };
            onEnterRoom(() => result);
          },
          onDeclineRequest: (connectionId) => {
            lobby.adapter.declineRoomRequest(connectionId);
          },
          onCancelRequest: () => {
            lobby.adapter.cancelRoomRequest();
          },
          onCancelHostedRoom: () => {
            lobby.adapter.leaveRoom();
            setRoomRequests([]);
            setOutgoingRoomRequest(null);
            setRoundError(null);
          },
          onBack: () => {
            lobby.adapter.cancelRoomRequest();
            lobby.adapter.leaveRoom();
            setRoomRequests([]);
            setOutgoingRoomRequest(null);
            setRoundError(null);
          },
        };

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <MainMenu
        onPlayRound={onPlayRound}
        qualityTier={tier}
        onQualityTierChange={onTierSelect}
        starting={lobbyBusy}
        notice={roundError}
        browser={browser}
      />
    </div>
  );
}

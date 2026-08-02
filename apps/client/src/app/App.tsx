import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { MenuAmbience } from "../audio/MenuAmbience";
import { installUiSounds } from "../audio/uiSounds";
import { GameHost, type RoundLoadProgress } from "../engine/GameHost";
import type { ForgeController } from "../forge/ForgeController";
import {
  createLocalRound,
  LOCAL_ROUND_NAME,
  seedFromLocation,
} from "../gameplay/localRound";
import { createPortalsRound, PORTALS_ROUND_CHANNEL } from "../gameplay/portalsRound";
import type { GameRound } from "../gameplay/round";
import type { RoundSession } from "../gameplay/RoundSession";
import { detectPortalsSession, type PortalsBoot } from "../networking/portalsBoot";
import { QUALITY_TIER_ORDER, type QualityTier } from "../rendering/quality";
import type { ConnectionDetail } from "../networking/NetworkAdapter";
import { RendererInitError, type DeviceEvent, type RenderBackend } from "../rendering/RendererManager";
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
} from "../ui/rounds/theme";
import { LoadingScreen } from "../ui/LoadingScreen";
import { MainMenu } from "../ui/MainMenu";
import { RoundHud } from "../ui/RoundHud";

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

const panelStyle: CSSProperties = {
  position: "absolute",
  left: 20,
  bottom: 20,
  padding: "12px 16px",
  borderRadius: 10,
  ...plate(),
  color: CREAM,
  font: `13px/1.6 ${FONT_UI}`,
  pointerEvents: "auto",
};

/**
 * The five tiers, named for what they buy rather than for where they sit in the
 * `QUALITY_TIER_ORDER` array. "light" and "low" are neighbours in that list and
 * near-synonyms in English, which is not a choice anybody can make from a
 * dropdown.
 */
const QUALITY_TIER_LABELS: Readonly<Record<QualityTier, string>> = {
  light: "Lightest",
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

/**
 * The quality control as five chips rather than a `<select>`. A native dropdown
 * is the one piece of browser chrome on the title screen, it renders in the
 * platform's own colours whatever is asked of it, and it hides four of the five
 * choices behind a click.
 */
const qualityChipStyle: CSSProperties = {
  ...buttonStyle,
  padding: "5px 9px",
  fontSize: 10,
  letterSpacing: "0.1em",
};

const qualityChipActiveStyle: CSSProperties = {
  ...qualityChipStyle,
  background: "linear-gradient(180deg, rgba(194, 151, 79, 0.45), rgba(122, 93, 46, 0.3))",
  border: `1px solid ${BRASS_LIT}`,
  color: "#fff3df",
  boxShadow: "0 0 12px rgba(255, 190, 107, 0.2), inset 0 1px 0 rgba(255, 232, 186, 0.25)",
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
  const hostRef = useRef<GameHost | null>(null);
  const roundRef = useRef<ActiveRound | null>(null);
  /** Read inside the click handler, where the loading state itself is stale. */
  const loadingRef = useRef(false);

  useEffect(() => {
    const canvas = document.getElementById("game-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      setBoot({ kind: "failed", headline: "The shop failed to open", detail: "The game canvas is missing from the page." });
      return;
    }

    let disposed = false;
    let host: GameHost | null = null;

    const runBootSequence = async (): Promise<void> => {
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
          setBoot({ kind: "failed", ...describeFailure(error) });
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
      host?.dispose();
      hostRef.current = null;
    };
  }, []);

  // The whole shell's click and hover, for the life of the page. It listens at
  // the document rather than in the components, so every panel the game grows
  // later is audible without being wired for it.
  useEffect(() => installUiSounds(), []);

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
  const atMenu = boot.kind === "ready" && round === null && forge === null && loading === null;
  useEffect(() => {
    if (atMenu) menuAmbience.start();
    else menuAmbience.stop();
  }, [atMenu, menuAmbience]);

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

    // Inside a Portals room the round is the people who are in it; anywhere
    // else it is this tab and its bots. Everything after this point is the
    // same, because the director, the session and the engine all read the
    // NetworkAdapter interface and nothing narrower.
    const opening: { round: GameRound; channel: string; displayName: string } =
      portals === null
        ? {
            round: createLocalRound({ seed: seedFromLocation(window.location.search) }),
            channel: LOCAL_ROUND_NAME,
            displayName: DEFAULT_PLAYER_NAME,
          }
        : {
            round: createPortalsRound({ sdk: portals.sdk }),
            channel: PORTALS_ROUND_CHANNEL,
            displayName: portals.player.displayName ?? DEFAULT_PLAYER_NAME,
          };
    const { round: opened } = opening;

    setRoundError(null);
    const abandon = (error: unknown): void => {
      console.error("[round] could not open the shop", error);
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
      await opened.adapter.join(opening.channel, opening.displayName);
      const session = await host.enterRoundMode(
        opened.adapter,
        opened.director,
        opened.spatial,
        setLoading,
      );
      if (session === null) {
        opened.dispose();
        loadingRef.current = false;
        setLoading(null);
        return;
      }
      const active: ActiveRound = { round: opened, session };
      roundRef.current = active;
      loadingRef.current = false;
      setRound(active);
      setLoading(null);
    })().catch(abandon);
  }, [portals]);

  const onLeaveRound = useCallback(() => {
    const active = roundRef.current;
    if (active === null) {
      return;
    }
    roundRef.current = null;
    setRound(null);
    // Order matters: the host disposes the session, which is what unhooks the
    // engine from an adapter that is still delivering events.
    hostRef.current?.exitRoundMode();
    active.round.dispose();
  }, []);

  // A device loss outranks the boot state: the renderer came up, so `boot` still
  // reads "ready" while nothing can actually be drawn.
  if (deviceFault !== null) {
    return (
      <div style={noticeStyle} role="alert">
        <div style={{ ...plate(true), borderRadius: 14, padding: "30px 34px", maxWidth: 540 }}>
          <NoticeMark />
          <p style={{ margin: "0 0 10px", font: `17px/1.5 ${FONT_DISPLAY}`, color: ALARM }}>
            The graphics device was lost. Reload the page to reopen the shop.
          </p>
          <p style={{ ...labelStyle, opacity: 0.6, margin: 0 }}>
            {deviceFault.api}: {deviceFault.message}
          </p>
        </div>
      </div>
    );
  }

  if (boot.kind === "failed") {
    return (
      <div style={noticeStyle} role="alert">
        <div style={{ ...plate(true), borderRadius: 14, padding: "30px 34px", maxWidth: 540 }}>
          <NoticeMark />
          <p style={{ margin: "0 0 10px", font: `17px/1.5 ${FONT_DISPLAY}`, color: ALARM }}>
            {boot.headline}
          </p>
          <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{boot.detail}</p>
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
      <RoundHud director={round.round.director} session={round.session} onLeave={onLeaveRound} />
    );
  }

  if (forge !== null) {
    return <ForgeHud controller={forge} onExit={onLeaveForge} />;
  }

  if (loading !== null) {
    return <LoadingScreen progress={loading} />;
  }

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <MainMenu
        onPlayRound={onPlayRound}
        onForgePractice={onEnterForge}
        starting={false}
        multiplayer={portals !== null}
        notice={roundError}
      />
      <div style={panelStyle} role="group" aria-label="Quality">
        <div style={{ ...labelStyle, marginBottom: 7 }}>Quality</div>
        <div style={{ display: "flex", gap: 5 }}>
          {[...QUALITY_TIER_ORDER].reverse().map((value) => (
            <button
              key={value}
              type="button"
              className={PRESS_CLASS}
              aria-pressed={tier === value}
              style={tier === value ? qualityChipActiveStyle : qualityChipStyle}
              onClick={() => {
                onTierSelect(value);
              }}
            >
              {QUALITY_TIER_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

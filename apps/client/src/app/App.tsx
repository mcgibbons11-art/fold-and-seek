import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactElement } from "react";
import { GameHost } from "../engine/GameHost";
import type { ForgeController } from "../forge/ForgeController";
import { isQualityTier, QUALITY_TIER_ORDER, type QualityTier } from "../rendering/quality";
import { RendererInitError, type DeviceEvent, type RenderBackend } from "../rendering/RendererManager";
import { ForgeHud } from "../ui/ForgeHud";
import { MainMenu } from "../ui/MainMenu";

type BootState =
  | { kind: "detecting" }
  | { kind: "initializing" }
  | { kind: "ready"; backend: RenderBackend }
  | { kind: "failed"; headline: string; detail: string };

interface GpuCapableNavigator extends Navigator {
  readonly gpu?: { requestAdapter(): Promise<unknown | null> };
}

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

const panelStyle: CSSProperties = {
  position: "absolute",
  left: 20,
  bottom: 20,
  padding: "14px 18px",
  borderRadius: 10,
  background: "rgba(10, 9, 8, 0.78)",
  border: "1px solid rgba(232, 221, 205, 0.16)",
  color: "#e8ddcd",
  font: "13px/1.6 system-ui, sans-serif",
  pointerEvents: "auto",
  backdropFilter: "blur(6px)",
};

const noticeStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeContent: "center",
  textAlign: "center",
  padding: 32,
  color: "#e8ddcd",
  font: "15px/1.7 system-ui, sans-serif",
  pointerEvents: "auto",
};

export function App(): ReactElement {
  const [boot, setBoot] = useState<BootState>({ kind: "detecting" });
  const [tier, setTier] = useState<QualityTier>("high");
  const [forge, setForge] = useState<ForgeController | null>(null);
  const [deviceFault, setDeviceFault] = useState<DeviceEvent | null>(null);
  const hostRef = useRef<GameHost | null>(null);

  useEffect(() => {
    const canvas = document.getElementById("game-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      setBoot({ kind: "failed", headline: "The shop failed to open", detail: "The game canvas is missing from the page." });
      return;
    }

    let disposed = false;
    let host: GameHost | null = null;

    const runBootSequence = async (): Promise<void> => {
      if (!(await hasDrawableBackend())) {
        if (!disposed) {
          setBoot({ kind: "failed", headline: NO_BACKEND_HEADLINE, detail: NO_BACKEND_DETAIL });
        }
        return;
      }
      if (disposed) {
        return;
      }
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
        { forceWebGL: new URLSearchParams(window.location.search).has("webgl") },
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
      host?.dispose();
      hostRef.current = null;
    };
  }, []);

  const onTierSelect = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (!isQualityTier(value)) {
      return;
    }
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

  // A device loss outranks the boot state: the renderer came up, so `boot` still
  // reads "ready" while nothing can actually be drawn.
  if (deviceFault !== null) {
    return (
      <div style={noticeStyle}>
        <div style={{ maxWidth: 520 }}>
          <h1 style={{ letterSpacing: "0.2em", fontSize: 22, marginBottom: 12 }}>FOLD &amp; SEEK</h1>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>
            The graphics device was lost — reload to reopen the shop
          </p>
          <p style={{ opacity: 0.8 }}>
            {deviceFault.api}: {deviceFault.message}
          </p>
        </div>
      </div>
    );
  }

  if (boot.kind === "failed") {
    return (
      <div style={noticeStyle}>
        <div style={{ maxWidth: 520 }}>
          <h1 style={{ letterSpacing: "0.2em", fontSize: 22, marginBottom: 12 }}>FOLD &amp; SEEK</h1>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>{boot.headline}</p>
          <p style={{ opacity: 0.8 }}>{boot.detail}</p>
        </div>
      </div>
    );
  }

  if (boot.kind !== "ready") {
    return (
      <div style={noticeStyle}>
        <div>
          <h1 style={{ letterSpacing: "0.2em", fontSize: 22, marginBottom: 10 }}>FOLD &amp; SEEK</h1>
          <p style={{ opacity: 0.75 }}>
            {boot.kind === "detecting" ? "Checking your browser…" : "Unpacking the reading nook…"}
          </p>
        </div>
      </div>
    );
  }

  if (forge !== null) {
    return <ForgeHud controller={forge} onExit={onLeaveForge} />;
  }

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <MainMenu backend={boot.backend} onForgePractice={onEnterForge} />
      <div style={panelStyle}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ opacity: 0.72 }}>quality</span>
          <select
            value={tier}
            onChange={onTierSelect}
            style={{
              background: "rgba(232, 221, 205, 0.08)",
              color: "#e8ddcd",
              border: "1px solid rgba(232, 221, 205, 0.24)",
              borderRadius: 6,
              padding: "4px 8px",
              font: "inherit",
            }}
          >
            {[...QUALITY_TIER_ORDER].reverse().map((value) => (
              <option key={value} value={value} style={{ color: "#14100c" }}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

import { useEffect, useState, type ReactElement } from "react";

type BootState =
  | { kind: "detecting" }
  | { kind: "ready"; backend: "webgpu" | "webgl2" }
  | { kind: "unsupported"; reason: string };

async function detectBackend(): Promise<BootState> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } };
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) return { kind: "ready", backend: "webgpu" };
    } catch {
      // fall through to WebGL 2 detection
    }
  }
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (gl) return { kind: "ready", backend: "webgl2" };
  return {
    kind: "unsupported",
    reason: "This browser supports neither WebGPU nor WebGL 2. FOLD & SEEK needs one of them to draw the shop.",
  };
}

export function App(): ReactElement {
  const [boot, setBoot] = useState<BootState>({ kind: "detecting" });

  useEffect(() => {
    let cancelled = false;
    void detectBackend().then((state) => {
      if (!cancelled) setBoot(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ color: "#e8ddcd", fontFamily: "system-ui, sans-serif", padding: 32 }}>
      <h1 style={{ letterSpacing: "0.2em" }}>FOLD &amp; SEEK</h1>
      {boot.kind === "detecting" && <p>Checking your browser&hellip;</p>}
      {boot.kind === "ready" && <p>Renderer backend available: {boot.backend}. Engine boot comes next.</p>}
      {boot.kind === "unsupported" && <p>{boot.reason}</p>}
    </div>
  );
}

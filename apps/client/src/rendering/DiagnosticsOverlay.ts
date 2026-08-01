import type { QualityTier } from "./quality";
import type { PipelineEffect } from "./RenderPipeline";
import type { RenderBackend } from "./RendererManager";

const TOGGLE_KEY = "Backquote";
const REFRESH_INTERVAL_MS = 200;
const FPS_SMOOTHING = 0.1;

export interface DiagnosticsSnapshot {
  readonly backend: RenderBackend;
  readonly tier: QualityTier;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly renderTargets: number;
  readonly programs: number;
  readonly pixelRatio: number;
  readonly renderScale: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly meshCount: number;
  readonly effects: readonly PipelineEffect[];
}

/**
 * Development overlay toggled with the backquote key. Text is rebuilt on a
 * timer rather than per frame, so the render loop stays allocation free.
 */
export class DiagnosticsOverlay {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLPreElement;
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private smoothedFrameMs = 16.7;
  private lastRefreshMs = 0;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.style.cssText = [
      "position:absolute",
      "top:12px",
      "right:12px",
      "z-index:20",
      "padding:10px 14px",
      "border-radius:8px",
      "background:rgba(10,9,8,0.82)",
      "border:1px solid rgba(232,221,205,0.16)",
      "color:#e8ddcd",
      "font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace",
      "white-space:pre",
      "pointer-events:none",
      "display:none",
    ].join(";");

    this.body = document.createElement("pre");
    this.body.style.cssText = "margin:0;font:inherit;color:inherit";
    this.body.textContent = "collecting…";
    this.root.appendChild(this.body);
    parent.appendChild(this.root);

    this.onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== TOGGLE_KEY || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      event.preventDefault();
      this.setVisible(!this.visible);
    };
    window.addEventListener("keydown", this.onKeyDown);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.style.display = visible ? "block" : "none";
  }

  update(nowMs: number, frameMs: number, snapshot: () => DiagnosticsSnapshot): void {
    this.smoothedFrameMs += (frameMs - this.smoothedFrameMs) * FPS_SMOOTHING;
    if (!this.visible || nowMs - this.lastRefreshMs < REFRESH_INTERVAL_MS) {
      return;
    }
    this.lastRefreshMs = nowMs;

    const data = snapshot();
    const fps = this.smoothedFrameMs > 0 ? 1000 / this.smoothedFrameMs : 0;
    this.body.textContent = [
      `backend    ${data.backend}`,
      `tier       ${data.tier}`,
      `fps        ${fps.toFixed(1)}`,
      // Wall-clock spacing between animation-loop callbacks. It bounds GPU time
      // but does not measure it, so a GPU-bound frame and a stalled main thread
      // look identical here until timestamp queries are wired up.
      `cpu frame  ${this.smoothedFrameMs.toFixed(2)} ms (wall clock)`,
      `resolution ${data.widthPx} x ${data.heightPx} @ ${data.pixelRatio.toFixed(2)}`,
      `scale      ${data.renderScale.toFixed(2)}`,
      `post       ${data.effects.length > 0 ? data.effects.join(" + ") : "direct"}`,
      `draw calls ${data.drawCalls}`,
      `triangles  ${data.triangles.toLocaleString("en-US")}`,
      `geometries ${data.geometries}`,
      `textures   ${data.textures}`,
      `targets    ${data.renderTargets}`,
      `pipelines  ${data.programs}`,
      `meshes     ${data.meshCount}`,
      "",
      "` toggles this overlay",
    ].join("\n");
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    this.root.remove();
  }
}

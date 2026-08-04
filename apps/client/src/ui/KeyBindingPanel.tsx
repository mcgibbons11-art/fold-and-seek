import { useEffect, useState, type ReactElement } from "react";

import {
  INPUT_ACTION_LABELS,
  displayCode,
  getGamepadBindings,
  getInputBindings,
  rebindAction,
  rebindGamepadAction,
  resetGamepadBindings,
  resetInputBindings,
  resolveBindingConflict,
  resolveGamepadBindingConflict,
  subscribeInputBindings,
  type GamepadCode,
  type InputAction,
} from "../gameplay/inputBindings";
import { BRASS_LIT, CREAM, PRESS_CLASS, buttonStyle, labelStyle, RULE } from "./rounds/theme";

type Device = "keyboard" | "gamepad";
interface PendingConflict {
  readonly action: InputAction;
  readonly conflict: InputAction;
  readonly code: string;
  readonly device: Device;
}

const GROUPS: ReadonlyArray<Readonly<{ label: string; actions: readonly InputAction[] }>> = [
  { label: "Movement", actions: ["moveForward", "moveBack", "moveLeft", "moveRight", "jump", "grapple"] },
  { label: "Forge", actions: ["toolPose", "toolShape", "toolPanels", "toolMaterial", "toolPaint", "mirror", "eyedropper"] },
  { label: "Hunt", actions: ["taunt"] },
];

/** Context-grouped keyboard and controller remapping with explicit conflict recovery. */
export function KeyBindingPanel(): ReactElement {
  const [keyboard, setKeyboard] = useState(() => getInputBindings());
  const [gamepad, setGamepad] = useState(() => getGamepadBindings());
  const [device, setDevice] = useState<Device>("keyboard");
  const [listening, setListening] = useState<InputAction | null>(null);
  const [pending, setPending] = useState<PendingConflict | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => subscribeInputBindings(() => {
    setKeyboard(getInputBindings());
    setGamepad(getGamepadBindings());
  }), []);

  useEffect(() => {
    if (listening === null || device !== "keyboard") return undefined;
    const capture = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setListening(null);
        setPending(null);
        return;
      }
      if (["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(event.code)) return;
      const result = rebindAction(listening, event.code);
      if (!result.ok) {
        setPending({ action: listening, conflict: result.conflict, code: event.code, device });
        setListening(null);
        return;
      }
      setPending(null);
      setListening(null);
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [device, listening]);

  useEffect(() => {
    if (listening === null || device !== "gamepad") return undefined;
    const interval = window.setInterval(() => {
      const pad = typeof navigator.getGamepads === "function"
        ? [...navigator.getGamepads()].find((candidate) => candidate?.connected)
        : null;
      if (pad == null) return;
      let code: GamepadCode | null = null;
      const button = pad.buttons.findIndex((entry) => entry.pressed || entry.value > 0.6);
      if (button === 1) {
        setListening(null);
        setPending(null);
        return;
      }
      if (button >= 0) code = `Button${button}`;
      if (code === null) {
        const axis = pad.axes.findIndex((entry) => Math.abs(entry) > 0.72);
        if (axis >= 0) code = `Axis${axis}${pad.axes[axis]! > 0 ? "+" : "-"}`;
      }
      if (code === null) return;
      const result = rebindGamepadAction(listening, code);
      if (!result.ok) setPending({ action: listening, conflict: result.conflict, code, device });
      else setPending(null);
      setListening(null);
    }, 60);
    return () => window.clearInterval(interval);
  }, [device, listening]);

  const resolve = (resolution: "swap" | "replace" | "cancel"): void => {
    if (pending === null) return;
    if (pending.device === "keyboard") {
      resolveBindingConflict(pending.action, pending.code, resolution);
    } else {
      resolveGamepadBindingConflict(pending.action, pending.code as GamepadCode, resolution);
    }
    setPending(null);
  };

  const bindings = device === "keyboard" ? keyboard : gamepad;
  return (
    <div style={{ marginTop: 20, paddingTop: 14, borderTop: RULE }}>
      <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1, marginBottom: 8 }}>Customize controls</div>
      <div role="tablist" aria-label="Input device" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 10 }}>
        {(["keyboard", "gamepad"] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={device === value} className={PRESS_CLASS}
            style={{ ...buttonStyle, margin: 0, borderColor: device === value ? BRASS_LIT : undefined }}
            onClick={() => { setDevice(value); setListening(null); setPending(null); setConfirmReset(false); }}>
            {value === "keyboard" ? "Keyboard" : "Controller"}
          </button>
        ))}
      </div>

      {GROUPS.map((group) => (
        <section key={group.label} aria-label={`${group.label} bindings`} style={{ marginBottom: 10 }}>
          <div style={{ ...labelStyle, marginBottom: 5 }}>{group.label}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 5 }}>
            {group.actions.map((action) => (
              <button key={action} type="button" className={PRESS_CLASS} aria-pressed={listening === action}
                style={{ ...buttonStyle, margin: 0, padding: "6px 8px", display: "flex", justifyContent: "space-between", gap: 8, textAlign: "left", borderColor: listening === action ? BRASS_LIT : undefined }}
                onClick={() => { setPending(null); setListening(action); setConfirmReset(false); }}>
                <span>{INPUT_ACTION_LABELS[action]}</span>
                <span style={{ color: listening === action ? BRASS_LIT : CREAM }}>
                  {listening === action ? (device === "keyboard" ? "Press a key…" : "Press a control…") : displayCode(bindings[action] ?? "Unbound:")}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {pending === null ? null : (
        <div role="alertdialog" aria-label="Binding conflict" style={{ border: RULE, borderRadius: 7, padding: 9, marginTop: 8 }}>
          <div style={{ color: "#ffc0a8", marginBottom: 7 }}>
            {displayCode(pending.code)} is assigned to {INPUT_ACTION_LABELS[pending.conflict]}.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5 }}>
            <button type="button" className={PRESS_CLASS} style={buttonStyle} onClick={() => resolve("swap")}>Swap</button>
            <button type="button" className={PRESS_CLASS} style={buttonStyle} onClick={() => resolve("replace")}>Replace</button>
            <button type="button" className={PRESS_CLASS} style={buttonStyle} onClick={() => resolve("cancel")}>Cancel</button>
          </div>
        </div>
      )}

      <button type="button" className={PRESS_CLASS} style={{ ...buttonStyle, width: "100%", marginTop: 8 }}
        onClick={() => {
          if (!confirmReset) { setConfirmReset(true); return; }
          if (device === "keyboard") resetInputBindings(); else resetGamepadBindings();
          setConfirmReset(false); setPending(null); setListening(null);
        }}>
        {confirmReset ? `Confirm reset ${device}` : `Reset ${device} defaults`}
      </button>
      {listening !== null ? <p role="status" style={{ margin: "8px 0 0", opacity: 0.72 }}>Escape or controller B cancels capture.</p> : null}
    </div>
  );
}

import { useEffect, useState, type ReactElement } from "react";

import {
  INPUT_ACTION_LABELS,
  REBINDABLE_ACTIONS,
  displayCode,
  getInputBindings,
  rebindAction,
  resetInputBindings,
  subscribeInputBindings,
  type InputAction,
} from "../gameplay/inputBindings";
import { BRASS_LIT, CREAM, PRESS_CLASS, buttonStyle, labelStyle, RULE } from "./rounds/theme";

export function KeyBindingPanel(): ReactElement {
  const [bindings, setBindings] = useState(() => getInputBindings());
  const [listening, setListening] = useState<InputAction | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => subscribeInputBindings(() => setBindings(getInputBindings())), []);
  useEffect(() => {
    if (listening === null) return undefined;
    const capture = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setListening(null);
        return;
      }
      if (["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(event.code)) return;
      const result = rebindAction(listening, event.code);
      if (!result.ok) {
        setConflict(`${displayCode(event.code)} is already assigned to ${INPUT_ACTION_LABELS[result.conflict]}.`);
        return;
      }
      setConflict(null);
      setListening(null);
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [listening]);

  return (
    <div style={{ marginTop: 20, paddingTop: 14, borderTop: RULE }}>
      <div style={{ ...labelStyle, color: BRASS_LIT, opacity: 1, marginBottom: 8 }}>Customize keyboard</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
        {REBINDABLE_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            className={PRESS_CLASS}
            aria-pressed={listening === action}
            style={{ ...buttonStyle, margin: 0, padding: "6px 8px", display: "flex", justifyContent: "space-between", gap: 8, textAlign: "left", borderColor: listening === action ? BRASS_LIT : undefined }}
            onClick={() => { setConflict(null); setListening(action); }}
          >
            <span>{INPUT_ACTION_LABELS[action]}</span>
            <span style={{ color: listening === action ? BRASS_LIT : CREAM }}>{listening === action ? "Press a key…" : displayCode(bindings[action])}</span>
          </button>
        ))}
      </div>
      {conflict === null ? null : <div role="alert" style={{ color: "#ffc0a8", marginTop: 8 }}>{conflict}</div>}
      <button type="button" className={PRESS_CLASS} style={{ ...buttonStyle, width: "100%", marginTop: 8 }} onClick={() => { resetInputBindings(); setConflict(null); setListening(null); }}>
        Reset default bindings
      </button>
      <p style={{ margin: "8px 0 0", opacity: 0.65, fontSize: 11 }}>
        Gamepad: left stick moves, right stick looks, A jumps, triggers aim/fire, D-pad cycles Forge tools, Y mirrors.
      </p>
    </div>
  );
}

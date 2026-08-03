import type { CSSProperties, ReactElement } from "react";

import { getPlayerPreferences } from "../../gameplay/preferences";
import { ALARM, BRASS, CREAM, FONT_DISPLAY, labelStyle, plate } from "./theme";

/**
 * The stamp stack. Accusation results and command refusals both land here, so
 * the room speaks in one voice and one place instead of three overlays fighting
 * for the same corner.
 */

export type ToastTone = "brass" | "cream" | "alarm";

export interface ToastEntry {
  readonly id: number;
  readonly title: string;
  readonly body?: string | null;
  readonly tone: ToastTone;
}

export interface ToastProps {
  readonly entries: readonly ToastEntry[];
  /** Extra styling for the stack. The region it sits in decides where it is. */
  readonly anchor?: CSSProperties;
}

const TONE_COLORS: Readonly<Record<ToastTone, string>> = {
  brass: BRASS,
  cream: CREAM,
  alarm: ALARM,
};

const stackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  alignItems: "flex-end",
  pointerEvents: "none",
  maxWidth: 280,
};

export function Toast({ entries, anchor }: ToastProps): ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <div style={{ ...stackStyle, ...anchor }} role="log" aria-live="polite">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="fs-rise"
          style={{
            ...plate(),
            // Longhands so the accent edge and the plate's own edge never
            // collide as a shorthand/longhand pair on a rerender.
            borderLeft: `3px solid ${TONE_COLORS[entry.tone]}`,
            borderRadius: 8,
            padding: "9px 13px",
            textAlign: "right",
          }}
        >
          <div
            style={{
              font: `600 14px/1.25 ${FONT_DISPLAY}`,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: TONE_COLORS[entry.tone],
            }}
          >
            {entry.title}
          </div>
          {entry.body === null || entry.body === undefined ? null : (
            <div style={{ ...labelStyle, marginTop: 2, letterSpacing: "0.04em" }}>{entry.body}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Rejections read the same everywhere, so their copy is built in one place. */
export function rejectionToast(id: number, commandType: string, reason: string): ToastEntry {
  const friendly = REJECTION_COPY[reason] ?? {
    title: "Action not completed",
    body: "Try that action again. If it keeps happening, return to matchmaking and rejoin.",
  };
  const debug = getPlayerPreferences().showDiagnostics
    ? ` · ${commandType.replace(/_/g, " ")} / ${reason.replace(/_/g, " ")}`
    : "";
  return {
    id: -id,
    title: friendly.title,
    body: `${friendly.body}${debug}`,
    tone: "alarm",
  };
}

const REJECTION_COPY: Readonly<Record<string, { readonly title: string; readonly body: string }>> = {
  not_connected: { title: "Connection interrupted", body: "Wait for recovery, or leave and rejoin matchmaking." },
  not_host: { title: "Host action only", body: "The room host controls this action." },
  not_enough_players: { title: "Waiting for a player", body: "At least two people must join before the round can start." },
  players_not_ready: { title: "Players not ready", body: "Everyone must ready up before the host can start." },
  wrong_phase: { title: "Not available now", body: "That action belongs to a different part of the round." },
  no_warrants: { title: "No warrants left", body: "The Inspector has no accusations remaining this round." },
  accusation_cooldown: { title: "Warrant recovering", body: "Wait for the weapon indicator before firing again." },
  taunt_cooldown: { title: "Taunt recovering", body: "Wait for the taunt timer before baiting again." },
  target_unknown: { title: "Target lost", body: "Aim at the object again and retry when the reticle confirms it." },
  out_of_range: { title: "Out of range", body: "Move closer until the reticle closes around the target." },
  obstructed: { title: "Shot obstructed", body: "Move until there is a clear line to the target." },
  unsupported: { title: "Action unavailable", body: "This room does not support that feature yet." },
};

import { MatchPhase, type ResultVoteCategory } from "@foldseek/shared";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactElement } from "react";

import type { RoundDirector } from "../gameplay/RoundDirector";
import type { RoundSession } from "../gameplay/RoundSession";
import type { RoundViewState } from "../gameplay/roundView";
import { ForgeHud } from "./ForgeHud";
import {
  BaselineHud,
  ForgePhaseHud,
  HiderHud,
  InspectorHud,
  LobbyHud,
  MissedFindsHud,
  PhaseTimer,
  ResultsHud,
  RevealHud,
  RoleRevealHud,
  SpectatorHud,
  Toast,
  rejectionToast,
} from "./rounds";
import { BRASS, INK, labelStyle, overlayStyle, panelStyle } from "./rounds/theme";

/**
 * The round's whole DOM layer: one HUD per phase, chosen from the single
 * RoundViewState the director publishes and the engine state the session
 * publishes beside it. It renders and routes, and decides nothing: every
 * control asks RoundActions, which asks the authority.
 */

const INSPECTION_PHASES: ReadonlySet<MatchPhase> = new Set([
  MatchPhase.InspectionIntro,
  MatchPhase.Inspection,
  MatchPhase.FinalCountdown,
]);

/**
 * When the missed-finds board has anything to say. The authority reports during
 * the hunt and publishes one exact board at the reveal, so it stays up through
 * the reveal rather than vanishing at the moment the numbers stop being
 * bucketed.
 */
const MISSED_FINDS_PHASES: ReadonlySet<MatchPhase> = new Set([
  ...INSPECTION_PHASES,
  MatchPhase.Reveal,
]);

/** Toggles the board, as in the original (docs/MECCHA_RESEARCH.md). */
const MISSED_FINDS_KEY = "6";

/** The loopback round is not a room anyone can be invited to. */
const LOCAL_ROOM_CODE = "";

export interface RoundHudProps {
  readonly director: RoundDirector;
  readonly session: RoundSession;
  readonly onLeave: () => void;
}

export function RoundHud({ director, session, onLeave }: RoundHudProps): ReactElement {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => director.subscribe(listener), [director]),
    useCallback(() => director.getState(), [director]),
  );
  const engine = useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    useCallback(() => session.engineState, [session]),
  );

  const onReady = useCallback((ready: boolean) => session.actions.ready(ready), [session]);
  const onStart = useCallback(() => session.actions.startMatch(), [session]);
  const onTaunt = useCallback(() => session.actions.taunt(), [session]);
  const onVote = useCallback(
    (category: ResultVoteCategory, targetPublicObjectId: string) =>
      session.actions.voteResult(category, targetPublicObjectId),
    [session],
  );
  const onRematch = useCallback((yes: boolean) => session.actions.voteRematch(yes), [session]);

  const [boardOpen, setBoardOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A hider paints through the hunt, and the paint panel has a hex field
      // and numeric ones; a 6 typed into either is a colour, not a shortcut.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      // The Forge owns 1 through 5 for its tool modes, which is exactly why the
      // original put this board on 6 and why it is free here as well.
      if (event.key !== MISSED_FINDS_KEY || event.ctrlKey || event.metaKey || event.altKey) return;
      setBoardOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const forgeTools =
    engine.forge === null ? null : (
      <ForgeHud controller={engine.forge} onExit={onLeave} exitLabel="Leave the round" />
    );

  const isInspecting = INSPECTION_PHASES.has(state.phase) && state.self.role === "inspector";

  return (
    <>
      {phaseHud(state, {
        forgeTools,
        gun: engine.gun,
        onReady,
        onStart,
        onTaunt,
        onVote,
        onRematch,
      })}
      {boardOpen && MISSED_FINDS_PHASES.has(state.phase) ? <MissedFindsHud state={state} /> : null}
      {isInspecting ? null : <Toast entries={rejectionToasts(state)} />}
      {isInspecting && !engine.pointerLocked ? <PointerLockPrompt /> : null}
    </>
  );
}

interface PhaseHandlers {
  readonly forgeTools: ReactElement | null;
  readonly gun: RoundSession["engineState"]["gun"];
  readonly onReady: (ready: boolean) => void;
  readonly onStart: () => void;
  readonly onTaunt: () => void;
  readonly onVote: (category: ResultVoteCategory, targetPublicObjectId: string) => void;
  readonly onRematch: (yes: boolean) => void;
}

function phaseHud(state: RoundViewState, handlers: PhaseHandlers): ReactElement | null {
  switch (state.phase) {
    case MatchPhase.Lobby:
    case MatchPhase.Loading:
      return (
        <LobbyHud
          state={state}
          roomCode={LOCAL_ROOM_CODE}
          onReady={handlers.onReady}
          onStart={handlers.onStart}
        />
      );

    case MatchPhase.MapIntro:
      return (
        <div style={overlayStyle}>
          <PhaseTimer timer={state.timer} label={state.phaseLabel} />
        </div>
      );

    case MatchPhase.RoleReveal:
      return <RoleRevealHud state={state} />;

    case MatchPhase.BaselineScan:
      return <BaselineHud state={state} />;

    case MatchPhase.Forge:
    case MatchPhase.Locking:
      return <ForgePhaseHud state={state}>{handlers.forgeTools}</ForgePhaseHud>;

    case MatchPhase.InspectionIntro:
    case MatchPhase.Inspection:
    case MatchPhase.FinalCountdown:
      if (state.self.role === "inspector") {
        return <InspectorHud state={state} gun={handlers.gun} />;
      }
      if (state.self.role === "mimic" && state.self.lifeState === "active") {
        return (
          <HiderHud state={state} onTaunt={handlers.onTaunt}>
            {handlers.forgeTools}
          </HiderHud>
        );
      }
      return (
        <SpectatorHud
          state={state}
          target={{ publicObjectId: null, displayName: null }}
          delaySeconds={null}
        />
      );

    case MatchPhase.Reveal:
      return <RevealHud state={state} />;

    case MatchPhase.Results:
    case MatchPhase.RematchVote:
      return <ResultsHud state={state} onVote={handlers.onVote} onRematch={handlers.onRematch} />;

    default:
      return null;
  }
}

function rejectionToasts(state: RoundViewState): ReturnType<typeof rejectionToast>[] {
  return state.rejections.map((rejection) =>
    rejectionToast(rejection.id, rejection.commandType, rejection.reason),
  );
}

/**
 * Pointer lock can only be taken from a gesture, so the Inspector is told to
 * click rather than having the browser refuse the request on their behalf.
 */
function PointerLockPrompt(): ReactElement {
  return (
    <div style={overlayStyle}>
      <div
        style={{
          ...panelStyle,
          bottom: 96,
          left: "50%",
          transform: "translateX(-50%)",
          pointerEvents: "none",
          textAlign: "center",
          background: INK,
        }}
      >
        <div style={{ ...labelStyle, color: BRASS }}>Click to take the room</div>
        <div style={{ marginTop: 4, opacity: 0.8 }}>
          WASD to walk · right mouse to aim · left mouse to fire a warrant
        </div>
      </div>
    </div>
  );
}

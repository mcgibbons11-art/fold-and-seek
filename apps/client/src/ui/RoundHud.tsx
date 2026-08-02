import { MatchPhase, type ResultVoteCategory } from "@foldseek/shared";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import type { RoundDirector } from "../gameplay/RoundDirector";
import type { RoundSession } from "../gameplay/RoundSession";
import type { RoundViewState } from "../gameplay/roundView";
import { ForgeHud } from "./ForgeHud";
import {
  BaselineHud,
  ForgePhaseHud,
  HuntHud,
  LobbyHud,
  MissedFindsHud,
  PhaseTimer,
  ResultsHud,
  RevealHud,
  RoleRevealHud,
  Toast,
  rejectionToast,
} from "./rounds";
import { MISSED_FINDS_KEY, TAUNT_KEY } from "./rounds/huntControls";
import { HudLayout } from "./rounds/layout";
import { overlayStyle } from "./rounds/theme";

/**
 * The round's whole DOM layer: one HUD per phase, chosen from the single
 * RoundViewState the director publishes and the engine state the session
 * publishes beside it. It renders and routes, and decides nothing: every
 * control asks RoundActions, which asks the authority.
 *
 * The hunt is handed over whole to `HuntHud`, which owns the screen regions for
 * those phases. What stays here is the routing and the two keys the round binds
 * on its own account, the board toggle and the taunt.
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
  const onToggleBoard = useCallback(() => {
    setBoardOpen((open) => !open);
  }, []);

  // The taunt key has to read the gate at the moment it is pressed, and the
  // listener is bound once, so the current view goes through a ref rather than
  // rebinding the handler on every published state.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A hider paints through the hunt, and the paint panel has a hex field
      // and numeric ones; a 6 typed into either is a colour, not a shortcut.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;

      // The Forge owns 1 through 5 for its tool modes, which is exactly why the
      // original put the board on 6 and why the taunt cannot have 1 here.
      if (event.key === MISSED_FINDS_KEY) {
        setBoardOpen((open) => !open);
        return;
      }
      if (event.key.toLowerCase() === TAUNT_KEY) {
        const current = stateRef.current;
        if (!current.capabilities.taunt || !current.actions.taunt.allowed) return;
        event.preventDefault();
        session.actions.taunt();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [session]);

  if (INSPECTION_PHASES.has(state.phase)) {
    return (
      <HuntHud
        state={state}
        gun={engine.gun}
        forge={engine.forge}
        pointerLocked={engine.pointerLocked}
        boardOpen={boardOpen}
        onToggleBoard={onToggleBoard}
        onTaunt={onTaunt}
      />
    );
  }

  return (
    <>
      {phaseHud(state, {
        forgeTools:
          engine.forge === null ? null : (
            <ForgeHud
              controller={engine.forge}
              onExit={onLeave}
              exitLabel="Leave the round"
              showHeader={false}
            />
          ),
        onReady,
        onStart,
        onVote,
        onRematch,
      })}
      <HudLayout
        regions={{
          leftColumn:
            boardOpen && MISSED_FINDS_PHASES.has(state.phase) ? (
              <MissedFindsHud state={state} />
            ) : undefined,
          topRight:
            state.rejections.length === 0 ? undefined : (
              <Toast entries={rejectionToasts(state)} />
            ),
        }}
      />
    </>
  );
}

interface PhaseHandlers {
  readonly forgeTools: ReactElement | null;
  readonly onReady: (ready: boolean) => void;
  readonly onStart: () => void;
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

import type { MatchSettingsPatch } from "@foldseek/game-sim";
import { MatchPhase, type MatchSettings, type ResultVoteCategory } from "@foldseek/shared";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import type { RoundDirector } from "../gameplay/RoundDirector";
import type { RoundSession } from "../gameplay/RoundSession";
import { recordProfileRound } from "../gameplay/playerProfile";
import type { RoundViewState } from "../gameplay/roundView";
import type { QualityTier } from "../rendering/quality";
import { ForgeHud } from "./ForgeHud";
import { FirstRoundGuide } from "./FirstRoundGuide";
import { GameMenu, REQUEST_LEAVE_MATCH_EVENT } from "./GameMenu";
import { SoundCaptionHud } from "./SoundCaptionHud";
import {
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
 * The beats worth announcing, and nothing else: phase changes inside the hunt
 * (Inspection -> FinalCountdown) or into the vote are bookkeeping, not acts.
 */
const CURTAIN_NAMES: ReadonlyMap<MatchPhase, string> = new Map([
  [MatchPhase.Forge, "The Forge"],
  [MatchPhase.InspectionIntro, "The Hunt"],
  [MatchPhase.Reveal, "The Reveal"],
  [MatchPhase.Results, "The Ledger"],
]);

/**
 * A letterpress band that names each act as it opens, then gets out of the
 * way (QA 2026-08-05: the cuts between phases were abrupt). It never shows on
 * mount, so a player joining or rejoining mid-phase sees the game, not a
 * title card for a transition that happened without them.
 */
function PhaseCurtain({ phase }: { readonly phase: MatchPhase }): ReactElement | null {
  const [shown, setShown] = useState<MatchPhase | null>(null);
  const previous = useRef<MatchPhase | null>(null);

  useEffect(() => {
    const last = previous.current;
    previous.current = phase;
    if (last === null || last === phase || !CURTAIN_NAMES.has(phase)) return undefined;
    setShown(phase);
    const timeout = window.setTimeout(() => setShown(null), 1_600);
    return () => window.clearTimeout(timeout);
  }, [phase]);

  if (shown === null) return null;
  return (
    <div className="fs-phase-curtain" aria-hidden>
      <div className="fs-phase-curtain__band">{CURTAIN_NAMES.get(shown)}</div>
    </div>
  );
}

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

export interface RoundHudProps {
  readonly director: RoundDirector;
  readonly session: RoundSession;
  readonly onLeave: () => void;
  /** Players waiting to be let into this room, shown to the host in the lobby. */
  readonly pendingRequests?: readonly { readonly id: string; readonly displayName: string }[];
  readonly onAcceptRequest?: (connectionId: string) => void;
  readonly onDeclineRequest?: (connectionId: string) => void;
  readonly qualityTier: QualityTier;
  readonly onQualityTierChange: (tier: QualityTier) => void;
}

export function RoundHud({
  director,
  session,
  onLeave,
  pendingRequests,
  onAcceptRequest,
  onDeclineRequest,
  qualityTier,
  onQualityTierChange,
}: RoundHudProps): ReactElement {
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
  const onSettings = useCallback(
    (settings: MatchSettingsPatch) => session.actions.setSettings(settings),
    [session],
  );
  const onTaunt = useCallback(() => session.actions.taunt(), [session]);
  const onVote = useCallback(
    (category: ResultVoteCategory, targetPublicObjectId: string) =>
      session.actions.voteResult(category, targetPublicObjectId),
    [session],
  );
  const onRematch = useCallback((yes: boolean) => session.actions.voteRematch(yes), [session]);
  const onAddBot = useCallback(() => session.actions.addBot(), [session]);
  const onRemoveBot = useCallback(() => session.actions.removeBot(), [session]);
  const onCopyRoomCode = useCallback(() => {
    if (session.roomCode !== "" && navigator.clipboard !== undefined) {
      void navigator.clipboard.writeText(session.roomCode);
    }
  }, [session]);
  const onRequestLeave = useCallback(() => {
    window.dispatchEvent(new Event(REQUEST_LEAVE_MATCH_EVENT));
  }, []);

  const [boardOpen, setBoardOpen] = useState(false);
  const onToggleBoard = useCallback(() => {
    setBoardOpen((open) => !open);
  }, []);

  // The taunt key has to read the gate at the moment it is pressed, and the
  // listener is bound once, so the current view goes through a ref rather than
  // rebinding the handler on every published state.
  const stateRef = useRef(state);
  stateRef.current = state;
  const profileRound = useRef<{ round: number; id: string; playedAt: number } | null>(null);

  useEffect(() => {
    if (state.results === null) {
      profileRound.current = null;
      return;
    }
    if (profileRound.current === null || profileRound.current.round !== state.results.round) {
      const playedAt = Date.now();
      profileRound.current = {
        round: state.results.round,
        id: `${session.roomCode || "local"}:${state.results.round}:${playedAt.toString(36)}`,
        playedAt,
      };
    }
    recordProfileRound(profileRound.current.id, state.results, profileRound.current.playedAt);
  }, [session, state.results]);

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
      <>
        <HuntHud
          state={state}
          gun={engine.gun}
          forge={engine.forge}
          pointerLocked={engine.pointerLocked}
          boardOpen={boardOpen}
          onToggleBoard={onToggleBoard}
          onTaunt={onTaunt}
          traversal={engine.hiderTraversal}
          dangerBearingRad={engine.dangerBearingRad}
        />
        <GameMenu
          qualityTier={qualityTier}
          onQualityTierChange={onQualityTierChange}
          onLeave={onLeave}
          role={state.self.role}
        />
        <FirstRoundGuide state={state} forge={engine.forge} gun={engine.gun} pointerLocked={engine.pointerLocked} />
        <SoundCaptionHud captions={engine.soundCaptions} />
        <PhaseCurtain phase={state.phase} />
      </>
    );
  }

  return (
    <>
      {phaseHud(state, {
        forgeTools:
          engine.forge === null ? null : (
            <ForgeHud
              controller={engine.forge}
              onExit={onRequestLeave}
              exitLabel="Leave the round"
              showHeader={false}
            />
          ),
        onReady,
        onStart,
        ...(pendingRequests === undefined ? {} : { pendingRequests }),
        ...(onAcceptRequest === undefined ? {} : { onAcceptRequest }),
        ...(onDeclineRequest === undefined ? {} : { onDeclineRequest }),
        roomCode: session.roomCode,
        onCopyRoomCode,
        settings: session.matchSettings,
        onSettings,
        onVote,
        onRematch,
        onAddBot,
        onRemoveBot,
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
      <GameMenu
        qualityTier={qualityTier}
        onQualityTierChange={onQualityTierChange}
        onLeave={onLeave}
        role={state.self.role}
      />
      <FirstRoundGuide state={state} forge={engine.forge} gun={engine.gun} pointerLocked={engine.pointerLocked} />
      <SoundCaptionHud captions={engine.soundCaptions} />
      <PhaseCurtain phase={state.phase} />
    </>
  );
}

interface PhaseHandlers {
  readonly forgeTools: ReactElement | null;
  readonly onReady: (ready: boolean) => void;
  readonly onStart: () => void;
  readonly pendingRequests?: readonly { readonly id: string; readonly displayName: string }[];
  readonly onAcceptRequest?: (connectionId: string) => void;
  readonly onDeclineRequest?: (connectionId: string) => void;
  readonly roomCode: string;
  readonly onCopyRoomCode: () => void;
  readonly settings: MatchSettings;
  readonly onSettings: (settings: MatchSettingsPatch) => void;
  readonly onVote: (category: ResultVoteCategory, targetPublicObjectId: string) => void;
  readonly onRematch: (yes: boolean) => void;
  readonly onAddBot: () => void;
  readonly onRemoveBot: () => void;
}

function phaseHud(state: RoundViewState, handlers: PhaseHandlers): ReactElement | null {
  switch (state.phase) {
    case MatchPhase.Lobby:
    case MatchPhase.Loading:
      return (
        <LobbyHud
          state={state}
          roomCode={handlers.roomCode}
          onCopyRoomCode={handlers.roomCode === "" ? undefined : handlers.onCopyRoomCode}
          onReady={handlers.onReady}
          onStart={handlers.onStart}
          {...(handlers.pendingRequests === undefined ? {} : { pendingRequests: handlers.pendingRequests })}
          {...(handlers.onAcceptRequest === undefined ? {} : { onAcceptRequest: handlers.onAcceptRequest })}
          {...(handlers.onDeclineRequest === undefined ? {} : { onDeclineRequest: handlers.onDeclineRequest })}
          settings={handlers.settings}
          onSettingsChange={handlers.onSettings}
          onAddBot={handlers.onAddBot}
          onRemoveBot={handlers.onRemoveBot}
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

    // Old persisted snapshots can still name this wire phase. They receive the
    // Forge immediately rather than resurrecting the removed memorize screen.
    case MatchPhase.BaselineScan:
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

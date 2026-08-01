import { MatchPhase, DEFAULT_MATCH_SETTINGS, type MatchSettings } from "@foldseek/shared";

export interface PhaseState {
  phase: MatchPhase;
  phaseEndsAt: number;
  round: number;
}

export interface PhaseInput {
  now: number;
  settings: MatchSettings;
  readyPlayerCount: number;
  totalPlayerCount: number;
  mimicsRemaining: number;
  allLocked: boolean;
  rematchYesVotes: number;
}

/** Duration of a phase in milliseconds, from settings. Zero means event-driven. */
export function phaseDurationMs(phase: MatchPhase, settings: MatchSettings): number {
  switch (phase) {
    case MatchPhase.MapIntro: return settings.mapIntroMs;
    case MatchPhase.RoleReveal: return settings.roleRevealMs;
    case MatchPhase.BaselineScan: return settings.baselineScanMs;
    case MatchPhase.Forge: return settings.forgeMs;
    case MatchPhase.Locking: return settings.lockGraceMs;
    case MatchPhase.InspectionIntro: return settings.inspectionIntroMs;
    case MatchPhase.Inspection: return settings.inspectionMs;
    case MatchPhase.Reveal: return settings.revealMs;
    case MatchPhase.Results: return settings.resultsMs;
    case MatchPhase.RematchVote: return settings.rematchVoteMs;
    default: return 0;
  }
}

export function createInitialPhaseState(): PhaseState {
  return { phase: MatchPhase.Lobby, phaseEndsAt: 0, round: 0 };
}

/**
 * Pure deadline-driven transition. Event-driven transitions (match start,
 * all-mimics-found) are applied by the authority layer via explicit commands;
 * this handles only "the clock ran out" progression.
 */
export function nextPhaseOnDeadline(state: PhaseState, input: PhaseInput): PhaseState {
  if (state.phaseEndsAt === 0 || input.now < state.phaseEndsAt) return state;

  const enter = (phase: MatchPhase, round = state.round): PhaseState => {
    const duration = phaseDurationMs(phase, input.settings);
    return {
      phase,
      phaseEndsAt: duration > 0 ? input.now + duration : 0,
      round,
    };
  };

  switch (state.phase) {
    case MatchPhase.MapIntro: return enter(MatchPhase.RoleReveal);
    case MatchPhase.RoleReveal: return enter(MatchPhase.BaselineScan);
    case MatchPhase.BaselineScan: return enter(MatchPhase.Forge);
    case MatchPhase.Forge: return enter(MatchPhase.Locking);
    case MatchPhase.Locking: return enter(MatchPhase.InspectionIntro);
    case MatchPhase.InspectionIntro: return enter(MatchPhase.Inspection);
    case MatchPhase.Inspection: return enter(MatchPhase.Reveal);
    case MatchPhase.Reveal: return enter(MatchPhase.Results);
    case MatchPhase.Results: return enter(MatchPhase.RematchVote);
    case MatchPhase.RematchVote:
      return input.rematchYesVotes * 2 > input.totalPlayerCount
        ? enter(MatchPhase.RoleReveal, state.round + 1)
        : enter(MatchPhase.Lobby);
    default:
      return state;
  }
}

export { DEFAULT_MATCH_SETTINGS };

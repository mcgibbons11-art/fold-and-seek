export enum MatchPhase {
  Lobby = "lobby",
  Loading = "loading",
  MapIntro = "map_intro",
  RoleReveal = "role_reveal",
  BaselineScan = "baseline_scan",
  Forge = "forge",
  Locking = "locking",
  InspectionIntro = "inspection_intro",
  Inspection = "inspection",
  FinalCountdown = "final_countdown",
  Reveal = "reveal",
  Results = "results",
  RematchVote = "rematch_vote",
  Disposed = "disposed",
}

export type PlayerRole = "mimic" | "inspector" | "spectator";

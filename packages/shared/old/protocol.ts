export const PROTOCOL_VERSION = 1;

export const ClientMessage = {
  Ready: "ready",
  SetLobbySettings: "set_lobby_settings",
  MovementInput: "movement_input",
  CameraSample: "camera_sample",
  ForgeCommand: "forge_command",
  ForgeSnapshot: "forge_snapshot",
  LockDisguise: "lock_disguise",
  FocusObject: "focus_object",
  AccuseObject: "accuse_object",
  OpenDossier: "open_dossier",
  VoteResult: "vote_result",
  VoteRematch: "vote_rematch",
  Ping: "ping",
} as const;

export const ServerMessage = {
  PrivateRole: "private_role",
  PrivateDisguiseIdentity: "private_disguise_identity",
  ForgeAccepted: "forge_accepted",
  ForgeRejected: "forge_rejected",
  PhaseEvent: "phase_event",
  AccusationResult: "accusation_result",
  InnocentReaction: "innocent_reaction",
  RevealEvent: "reveal_event",
  MatchResults: "match_results",
  Pong: "pong",
  Error: "error",
} as const;

export type ClientMessageName = (typeof ClientMessage)[keyof typeof ClientMessage];
export type ServerMessageName = (typeof ServerMessage)[keyof typeof ServerMessage];

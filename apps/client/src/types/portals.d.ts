/**
 * Portals SDK v1.4.0
 *
 * The runtime is injected into hosted games at ./_portals/sdk.js.
 * Reference this file from a TypeScript project or use it for editor
 * autocomplete. Games must not bundle credentials or call Portals private
 * APIs directly.
 */

export type PortalsContext = "standalone" | "room";

export interface PortalsPlayer {
  /** Stable within this game and deliberately unlinkable across games. */
  playerId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PortalsSession {
  player: PortalsPlayer;
  context: PortalsContext;
}

export interface PortalsLeaderboardOptions {
  /** Lowercase letters, numbers, or hyphens. Omit for "default". */
  mode?: string;
  /** Number of top entries to return. Defaults to 10 and may not exceed 100. */
  limit?: number;
}

export interface PortalsLeaderboardEntry {
  rank: number;
  /** A stable game-scoped player id, never the player's Portals account id. */
  playerId: string;
  displayName: string | null;
  avatarUrl: string | null;
  score: number;
}

export interface PortalsLeaderboard {
  mode: string;
  entries: PortalsLeaderboardEntry[];
}

export interface PortalsIdentity {
  /**
   * Opens Portals sign-in when needed. Call from a direct player action so a
   * browser popup or modal is not blocked.
   */
  requestLogin(): Promise<PortalsPlayer>;
  /** Subscribes to sign-in and sign-out changes. Returns an unsubscribe. */
  onChange(listener: (player: PortalsPlayer) => void): () => void;
}

export interface PortalsNetPlayer {
  /** Per-connection id (two tabs are two players); `from` in "message". */
  id: string;
  /** Game-scoped player id, never the Portals account id; null for guests. */
  playerId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PortalsNetJoinOptions {
  /** Optional sub-lobby within the host-chosen session bucket. */
  channel?: string;
}

export interface PortalsNetSession {
  self: PortalsNetPlayer;
  players: PortalsNetPlayer[];
  /** Shared last-write-wins key-value state snapshot at join time. */
  state: Record<string, unknown>;
}

export interface PortalsNetEvents {
  /** A broadcast from another player (see send()). */
  message: (data: unknown, fromId: string) => void;
  playerjoin: (player: PortalsNetPlayer, players: PortalsNetPlayer[]) => void;
  playerleave: (player: PortalsNetPlayer, players: PortalsNetPlayer[]) => void;
  /** Confirmed shared-state write — fires for the writer too. */
  state: (key: string, value: unknown) => void;
  /** "disconnected" on connection loss; rejoin with join(). */
  status: (status: "connected" | "disconnected") => void;
}

export interface PortalsNet {
  /**
   * Joins the multiplayer session for this game. Rejects when multiplayer is
   * unavailable (no host, older host, connection failure) — keep a playable
   * solo fallback.
   */
  join(options?: PortalsNetJoinOptions): Promise<PortalsNetSession>;
  leave(): Promise<void>;
  /** Broadcasts at most 8 KB of JSON to the other players in the session. */
  send(data: unknown): void;
  /**
   * Writes shared last-write-wins state (value at most 8 KB of JSON, at most
   * 64 keys, key at most 128 chars) that late joiners receive in join().
   */
  setState(key: string, value: unknown): void;
  getState(key: string): unknown;
  getState(): Record<string, unknown>;
  players(): PortalsNetPlayer[];
  self(): PortalsNetPlayer | null;
  on<E extends keyof PortalsNetEvents>(
    event: E,
    handler: PortalsNetEvents[E]
  ): void;
  off<E extends keyof PortalsNetEvents>(
    event: E,
    handler: PortalsNetEvents[E]
  ): void;
}

export interface PortalsVoiceJoinOptions {
  /** Optional sub-lobby within the host-chosen session bucket. */
  channel?: string;
}

export interface PortalsVoiceSession {
  self: PortalsNetPlayer;
  participants: PortalsNetPlayer[];
  muted: boolean;
}

export interface PortalsVoiceDevice {
  /** Pass to setDevice() to capture from this microphone. */
  deviceId: string;
  /**
   * The browser's name for the device. Empty until the player has granted
   * the microphone, so render a fallback like "microphone 1".
   */
  label: string;
  /**
   * The microphone Portals captures from. All entries are false while Portals
   * is still on the browser default.
   */
  active: boolean;
}

export interface PortalsVoiceEvents {
  participantjoin: (
    participant: PortalsNetPlayer,
    participants: PortalsNetPlayer[]
  ) => void;
  participantleave: (
    participant: PortalsNetPlayer,
    participants: PortalsNetPlayer[]
  ) => void;
  /** Ids (PortalsNetPlayer.id) currently speaking, self included. */
  speaking: (speakingIds: string[]) => void;
  /** "disconnected" on connection loss; rejoin with join(). */
  status: (status: "connected" | "disconnected") => void;
}

export interface PortalsVoice {
  /**
   * Joins voice chat for this game's session. The Portals host owns the
   * microphone and the connection — the game never accesses the mic. Safe to
   * call on startup: the host asks the player for the microphone itself, so
   * the game needs no join button. Expect rejection (no host, the player
   * declined, connection failure) — keep the game fully playable without
   * voice, and offer a control that calls join() again.
   */
  join(options?: PortalsVoiceJoinOptions): Promise<PortalsVoiceSession>;
  leave(): Promise<void>;
  /** Mutes or unmutes the local microphone within the joined session. */
  setMuted(muted: boolean): void;
  muted(): boolean;
  /**
   * Lists the microphones Portals can capture from, for an in-game mic
   * picker. Works before and after join(); labels are only filled in once
   * the player has granted the microphone. Rejects wherever voice chat
   * itself is unavailable.
   */
  devices(): Promise<PortalsVoiceDevice[]>;
  /**
   * Captures from another microphone. Applies immediately in a joined session
   * and is remembered for the next join(). Rejects when the device cannot be
   * used — keep the previously selected entry shown in that case.
   */
  setDevice(deviceId: string): Promise<void>;
  participants(): PortalsNetPlayer[];
  self(): PortalsNetPlayer | null;
  on<E extends keyof PortalsVoiceEvents>(
    event: E,
    handler: PortalsVoiceEvents[E]
  ): void;
  off<E extends keyof PortalsVoiceEvents>(
    event: E,
    handler: PortalsVoiceEvents[E]
  ): void;
}

export interface PortalsSdk {
  readonly version: string;
  ready(): Promise<PortalsSession>;
  getPlayer(): Promise<PortalsPlayer>;
  readonly identity: PortalsIdentity;
  /** Saves at most 64 KB of JSON-serializable state for the signed-in player. */
  saveState(data: unknown): Promise<void>;
  /** Returns the signed-in player's saved state, or null when none exists. */
  loadState<T = unknown>(): Promise<T | null>;
  /**
   * Records the signed-in player's best casual score. Higher scores win.
   * Client-reported scores must never control prizes, currency, or access.
   */
  submitScore(score: number, mode?: string): Promise<void>;
  /** Reads the top casual scores after the host enforces game access. */
  getLeaderboard(
    options?: PortalsLeaderboardOptions
  ): Promise<PortalsLeaderboard>;
  /** Requests that the current Portals host close this game. */
  quit(): void;
  /** Real-time multiplayer relay for the players of this game. */
  readonly net: PortalsNet;
  /** Voice chat with the players of this game's session. */
  readonly voice: PortalsVoice;
}

declare global {
  const Portals: PortalsSdk;

  interface Window {
    Portals: PortalsSdk;
  }
}

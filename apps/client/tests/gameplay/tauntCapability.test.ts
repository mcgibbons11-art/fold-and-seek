import type { MatchCommand, PrivateSimEvent, SimEvent } from "@foldseek/game-sim";
import { MatchPhase } from "@foldseek/shared";
import { describe, expect, it } from "vitest";

import { computeAvailability } from "../../src/gameplay/actionAvailability";
import { RoundActions } from "../../src/gameplay/RoundActions";
import { RoundDirector } from "../../src/gameplay/RoundDirector";
import type {
  CommandRejection,
  ConnectionState,
  ForgeSnapshot,
  MatchSync,
  NetworkAdapter,
  PaintUpdate,
  RosterEntry,
  Unsubscribe,
} from "../../src/networking/NetworkAdapter";
import { EMPTY_SYNC, idleConnection } from "../../src/networking/NetworkAdapter";
import { Signal } from "../../src/networking/signal";

/**
 * The taunt is newer than some of the rooms a client can join. A room running a
 * build without it refuses the command as something it cannot decode, and the
 * client has to stop offering the button rather than asking again every five
 * seconds. No simulation in this repository can produce that refusal, so the
 * degradation path is driven through a stub authority.
 */

class StubAdapter implements NetworkAdapter {
  readonly mode = "local" as const;

  readonly sent: MatchCommand[] = [];
  private readonly rejections = new Signal<CommandRejection>();
  private readonly events = new Signal<SimEvent>();
  private readonly privateEvents = new Signal<PrivateSimEvent>();
  private readonly rosters = new Signal<readonly RosterEntry[]>();
  private readonly statuses = new Signal<ConnectionState>();
  private readonly syncs = new Signal<MatchSync>();
  private connection: ConnectionState = {
    ...idleConnection("local"),
    status: "connected",
    selfId: "self",
  };

  async connect(): Promise<void> {}
  async join(): Promise<ConnectionState> {
    return this.connection;
  }
  async disconnect(): Promise<void> {}
  dispose(): void {}

  sendCommand(command: MatchCommand): void {
    this.sent.push(command);
  }
  sendForgeSnapshot(_snapshot: ForgeSnapshot): void {}
  sendPaintUpdate(_update: PaintUpdate): void {}

  getSelfId(): string | null {
    return this.connection.selfId;
  }
  getConnection(): ConnectionState {
    return this.connection;
  }
  getRoster(): readonly RosterEntry[] {
    return [{ id: "self", displayName: "Curator", isSelf: true, isAuthority: false }];
  }
  getSync(): MatchSync {
    return EMPTY_SYNC;
  }

  onEvent(listener: (event: SimEvent) => void): Unsubscribe {
    return this.events.subscribe(listener);
  }
  onRejection(listener: (rejection: CommandRejection) => void): Unsubscribe {
    return this.rejections.subscribe(listener);
  }
  onPrivateEvent(listener: (event: PrivateSimEvent) => void): Unsubscribe {
    return this.privateEvents.subscribe(listener);
  }
  onRoster(listener: (roster: readonly RosterEntry[]) => void): Unsubscribe {
    return this.rosters.subscribe(listener);
  }
  onStatus(listener: (state: ConnectionState) => void): Unsubscribe {
    return this.statuses.subscribe(listener);
  }
  onSync(listener: (sync: MatchSync) => void): Unsubscribe {
    return this.syncs.subscribe(listener);
  }

  /** Answers as the authority would have. */
  refuse(rejection: CommandRejection): void {
    this.rejections.emit(rejection);
  }
}

describe("taunt capability", () => {
  it("stops offering the taunt once the authority refuses it as unknown", () => {
    const adapter = new StubAdapter();
    const director = new RoundDirector(adapter, { now: () => 0, tickIntervalMs: 0 });
    const actions = new RoundActions(adapter, director);

    expect(director.getState().capabilities.taunt).toBe(true);

    adapter.refuse({ type: "taunt", reason: "invalid_command", detail: "unknown discriminator" });

    expect(director.getState().capabilities.taunt).toBe(false);
    expect(director.getState().actions.taunt).toEqual({ allowed: false, reason: "unsupported" });
    expect(actions.taunt()).toEqual({ sent: false, reason: "unsupported" });
    expect(adapter.sent).toHaveLength(0);

    director.dispose();
  });

  it("keeps the taunt on a refusal the authority is entitled to make", () => {
    const adapter = new StubAdapter();
    const director = new RoundDirector(adapter, { now: () => 0, tickIntervalMs: 0 });

    adapter.refuse({ type: "taunt", reason: "taunt_cooldown" });

    expect(director.getState().capabilities.taunt).toBe(true);
    director.dispose();
  });

  it("blocks the taunt gate on an unsupported authority whatever the round says", () => {
    const gate = computeAvailability({
      status: "connected",
      phase: MatchPhase.Inspection,
      role: "mimic",
      lifeState: "active",
      isHost: false,
      disguiseLocked: true,
      warrantsRemaining: null,
      accusationReadyAtServerMs: null,
      serverNowMs: 0,
      connectedPlayers: 3,
      connectedPlayersReady: 3,
      minPlayers: 2,
      voteCandidates: 0,
      rematchVoted: false,
      tauntCooldownMs: 0,
      tauntSupported: false,
    });

    expect(gate.taunt).toEqual({ allowed: false, reason: "unsupported" });
  });
});

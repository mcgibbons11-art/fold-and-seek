import { Room, type Client } from "@colyseus/core";
import { Schema, MapSchema, type } from "@colyseus/schema";
import { MatchPhase } from "@foldseek/shared";

export class PublicPlayerState extends Schema {
  @type("string") publicId = "";
  @type("string") displayName = "";
  @type("boolean") ready = false;
  @type("boolean") connected = true;
}

export class MatchStateSchema extends Schema {
  @type("string") phase: string = MatchPhase.Lobby;
  @type("number") phaseEndsAt = 0;
  @type("string") mapId = "curiosity_shop";
  @type({ map: PublicPlayerState }) players = new MapSchema<PublicPlayerState>();
}

export class MatchRoom extends Room<MatchStateSchema> {
  override maxClients = 12;

  override onCreate(): void {
    this.setState(new MatchStateSchema());
    this.onMessage("ready", (client: Client, ready: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.ready = ready === true;
    });
  }

  override onJoin(client: Client, options: { displayName?: unknown } | undefined): void {
    const player = new PublicPlayerState();
    player.publicId = client.sessionId;
    const requested = typeof options?.displayName === "string" ? options.displayName : "";
    player.displayName = requested.slice(0, 24) || `Guest-${client.sessionId.slice(0, 4)}`;
    this.state.players.set(client.sessionId, player);
  }

  override onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
  }
}

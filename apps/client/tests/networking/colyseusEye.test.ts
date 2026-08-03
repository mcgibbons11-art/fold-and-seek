import { EYE_REPORT_EPSILON_M } from "@foldseek/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { ColyseusAdapter } from "../../src/networking/ColyseusAdapter";

/**
 * The client half of the dedicated server's eye channel.
 *
 * The server refuses `inspector_position_unknown` for a player whose position
 * it has never been told, so without this report every shot a client fires at
 * that transport is refused. The room writes the report into a map and answers
 * nothing, so what matters here is that the message goes out at all, that it
 * goes out in the shape the server's schema accepts, and that a stationary
 * Inspector does not spend one a tick restating where they already are.
 *
 * There is no seam for a fake room, because `join` acquires one through a
 * dynamic import of colyseus.js and nothing else sets it. The room is therefore
 * planted directly, which keeps the test to the send path rather than the
 * websocket underneath it.
 */

interface Sent {
  readonly type: string;
  readonly payload: unknown;
}

function plantRoom(adapter: ColyseusAdapter): Sent[] {
  const sent: Sent[] = [];
  (adapter as unknown as { room: unknown }).room = {
    sessionId: "s1",
    state: {},
    send(type: string, payload?: unknown) {
      sent.push({ type, payload });
    },
    leave: () => Promise.resolve(0),
    onMessage: () => undefined,
    onStateChange: () => undefined,
    onLeave: () => undefined,
    onError: () => undefined,
  };
  return sent;
}

describe("ColyseusAdapter eye reports", () => {
  let adapter: ColyseusAdapter;
  let sent: Sent[];

  beforeEach(() => {
    adapter = new ColyseusAdapter({ endpoint: "ws://localhost:2567" });
    sent = plantRoom(adapter);
  });

  it("sends the eye on the channel the room listens on", () => {
    adapter.reportInspectorEye([1, 2, 3]);

    expect(sent).toEqual([{ type: "eye", payload: { eye: [1, 2, 3] } }]);
  });

  it("can put the current eye on the wire before its accusation", () => {
    adapter.reportInspectorEye([1, 2, 3]);
    adapter.sendCommand({ type: "accuse", targetObjectId: "obj-hider" });

    expect(sent).toEqual([
      { type: "eye", payload: { eye: [1, 2, 3] } },
      { type: "accuse", payload: { type: "accuse", targetObjectId: "obj-hider" } },
    ]);
  });

  it("says nothing when the Inspector has not moved far enough to matter", () => {
    adapter.reportInspectorEye([1, 2, 3]);
    // Well inside the epsilon: a step this small cannot change a range or a
    // line-of-sight decision, so the message is not worth its own send.
    adapter.reportInspectorEye([1 + EYE_REPORT_EPSILON_M / 4, 2, 3]);

    expect(sent).toHaveLength(1);
  });

  it("sends again once the eye has actually travelled", () => {
    adapter.reportInspectorEye([1, 2, 3]);
    adapter.reportInspectorEye([1 + EYE_REPORT_EPSILON_M * 4, 2, 3]);

    expect(sent).toHaveLength(2);
  });

  it("rounds to the millimetre, which is finer than any check the server makes", () => {
    adapter.reportInspectorEye([1.23456789, -0.00049, 3]);

    expect(sent[0]?.payload).toEqual({ eye: [1.235, -0, 3] });
  });

  it("reports null so the server forgets an eye rather than keeping a ghost's", () => {
    adapter.reportInspectorEye([1, 2, 3]);
    adapter.reportInspectorEye(null);

    expect(sent.at(-1)).toEqual({ type: "eye", payload: { eye: null } });
  });

  it("sends the first report even when it is the null one", () => {
    // A Mimic writes null into the bridge at the start of a round. Treating
    // "never reported" as if it were "reported null" would swallow it, and the
    // server would keep whatever this session had reported before.
    adapter.reportInspectorEye(null);

    expect(sent).toHaveLength(1);
  });

  it("repeats itself after a rejoin, since the new room has heard nothing", () => {
    adapter.reportInspectorEye([1, 2, 3]);
    void adapter.disconnect();
    const rejoined = plantRoom(adapter);
    adapter.reportInspectorEye([1, 2, 3]);

    expect(rejoined).toEqual([{ type: "eye", payload: { eye: [1, 2, 3] } }]);
  });
});

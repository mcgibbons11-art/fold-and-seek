// @vitest-environment jsdom
import { MatchPhase } from "@foldseek/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ForgeController, ForgeHudState, ForgeToolMode } from "../../src/forge/ForgeController";
import type { RoundViewState } from "../../src/gameplay/roundView";
import { HuntHud } from "../../src/ui/rounds/HuntHud";
import type { InspectorGunView } from "../../src/ui/rounds/InspectorHud";
import { HUD_REGIONS, rectsOverlap, regionRect, type HudRegion } from "../../src/ui/rounds/layout";

/**
 * The hunt HUD as the browser assembles it. jsdom does no layout, so the boxes
 * themselves are proved in `hudLayout.test.ts`; what this file proves is that
 * the HUD puts each piece in exactly one region, that nothing renders outside a
 * region, and that the set of regions a given role claims is mutually disjoint
 * at both of the sizes the game is played at.
 *
 * It is also the regression guard for the collisions that prompted the layout:
 * a hider's status card over the tool rail, the Forge's own header over the
 * phase timer, and the taunt over its own hint.
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const VIEWPORTS = [
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1920x1080", width: 1920, height: 1080 },
] as const;

const GUN: InspectorGunView = {
  state: "idle",
  targetObjectId: null,
  targetDistanceM: null,
  targetInRange: false,
  triggerProgress: 0,
  dryFires: 0,
  cooldownRemainingMs: 0,
};

function huntState(overrides: {
  readonly role: RoundViewState["self"]["role"];
  readonly lifeState?: RoundViewState["self"]["lifeState"];
  readonly tauntAllowed?: boolean;
}): RoundViewState {
  const gate = { allowed: false, reason: "wrong_role" as const };
  return {
    connection: { mode: "loopback", status: "connected", canRejoin: false, detail: null },
    round: 0,
    phase: MatchPhase.Inspection,
    previousPhase: MatchPhase.Locking,
    phaseLabel: null,
    timer: {
      endsAtServerMs: 200_000,
      remainingMs: 96_000,
      secondsRemaining: 96,
      totalMs: 240_000,
      running: true,
      finalTen: false,
    },
    self: {
      transportId: "seat-1",
      publicPlayerId: "p1",
      displayName: "Me",
      role: overrides.role,
      lifeState: overrides.lifeState ?? "active",
      isHost: true,
      ready: true,
      ownDisguise: null,
      disguiseLocked: true,
      warrantsRemaining: overrides.role === "inspector" ? 3 : null,
      accusationReadyAtServerMs: null,
      accusationCooldownMs: 0,
      tauntCooldownMs: 0,
      watchedLevel: 0,
    },
    roster: [
      {
        seatId: "seat-1",
        publicPlayerId: "p1",
        displayName: "Me",
        isSelf: true,
        isAuthority: true,
        isHost: true,
        connected: true,
        ready: true,
        lifeState: "active",
        rolePublicState: overrides.role === "inspector" ? "inspector" : "unknown",
      },
      {
        seatId: "seat-2",
        publicPlayerId: "p2",
        displayName: "Bot",
        isSelf: false,
        isAuthority: false,
        isHost: false,
        connected: true,
        ready: true,
        lifeState: "active",
        rolePublicState: overrides.role === "inspector" ? "unknown" : "inspector",
      },
    ],
    warrantsRemaining: 3,
    warrantsTotal: 3,
    mimicsRemaining: 2,
    accusations: [],
    missedFinds: {
      received: false,
      rows: [],
      nextUpdateAtServerMs: 0,
      secondsToNextUpdate: null,
      final: false,
    },
    deception: { recent: [], directLookEscapes: 0, closePasses: 0, points: 0 },
    reveal: { entries: [], survivors: [], caught: [] },
    results: null,
    rematch: { yesVotes: 0, totalVoters: 0, myVote: null },
    rejections: [],
    actions: {
      ready: gate,
      startMatch: gate,
      lockDisguise: gate,
      accuse: gate,
      focus: gate,
      taunt:
        overrides.tauntAllowed === false
          ? { allowed: false, reason: "taunt_cooldown" }
          : { allowed: true, reason: null },
      voteResult: gate,
      voteRematch: gate,
    },
    capabilities: { taunt: true },
    clockOffsetMs: 0,
  };
}

/**
 * Enough of a Forge for the panels the hunt borrows. The real controller needs a
 * WebGL scene, and none of what it draws in the room is under test here: what is
 * under test is that its panels land in the left column and its tool keys land
 * on the rail.
 */
function stubForge(mode: ForgeToolMode): ForgeController {
  const state: ForgeHudState = {
    mode,
    locked: true,
    mirror: false,
    canUndo: true,
    canRedo: false,
    undoLabel: null,
    segment: null,
    panel: null,
    sampledSwatchId: null,
    bodySwatchId: "brass",
    arrangementId: "upright",
    anchoredBones: [],
    unsatisfiedAnchors: [],
    preview: "none",
    silhouette: false,
    status: "",
    formEpoch: 0,
  };
  const stub = {
    snapshot: () => state,
    subscribe: () => () => undefined,
    paint: {
      getState: () => ({ active: false }),
      store: { subscribe: () => () => undefined },
    },
    swatches: [],
    setToolMode: () => undefined,
    setMirror: () => undefined,
    applyArrangement: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    commitEdits: () => undefined,
  };
  return stub as unknown as ForgeController;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(element: React.ReactElement): void {
  act(() => {
    root.render(element);
  });
}

function claimedRegions(): HudRegion[] {
  return [...container.querySelectorAll("[data-hud-region]")].map(
    (element) => element.getAttribute("data-hud-region") as HudRegion,
  );
}

function textOf(region: HudRegion): string {
  return container.querySelector(`[data-hud-region="${region}"]`)?.textContent ?? "";
}

describe("hunt HUD region ownership", () => {
  it("claims each region at most once for a hider", () => {
    render(
      <HuntHud
        state={huntState({ role: "mimic" })}
        gun={GUN}
        forge={stubForge("pose")}
        pointerLocked={false}
        boardOpen
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    const claimed = claimedRegions();
    expect(new Set(claimed).size).toBe(claimed.length);
    for (const region of claimed) expect(HUD_REGIONS).toContain(region);
  });

  it("claims each region at most once for an Inspector", () => {
    render(
      <HuntHud
        state={huntState({ role: "inspector" })}
        gun={GUN}
        forge={null}
        pointerLocked
        boardOpen
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    const claimed = claimedRegions();
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("draws all eight of a hider's chips, and shrinks them at 720p to do it", () => {
    // The measured defect: at 1280x720 the roomy rail overran its region by
    // 54 px, which cut the taunt chip off the top and the board off the bottom.
    // The arithmetic is checked in `hudLayout.test.ts`; what is checked here is
    // that the component acts on it and that no chip is dropped to make it fit.
    const restore = { width: window.innerWidth, height: window.innerHeight };
    for (const viewport of VIEWPORTS) {
      Object.defineProperty(window, "innerWidth", { value: viewport.width, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: viewport.height, configurable: true });
      render(
        <HuntHud
          state={huntState({ role: "mimic", tauntAllowed: false })}
          gun={GUN}
          forge={stubForge("pose")}
          pointerLocked={false}
          boardOpen={false}
          onToggleBoard={() => undefined}
          onTaunt={() => undefined}
        />,
      );
      // A window that changes size mid-round has to reach the rail too, so the
      // viewport is announced rather than only read once at mount.
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      const rail = container.querySelector("[data-rail-size]");
      expect(rail, viewport.name).not.toBeNull();
      expect(rail?.children).toHaveLength(8);
      expect(rail?.getAttribute("data-rail-size"), viewport.name).toBe(
        viewport.height === 720 ? "compact" : "roomy",
      );
    }
    Object.defineProperty(window, "innerWidth", { value: restore.width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: restore.height, configurable: true });
  });

  it("gives the left column exactly one scroll container", () => {
    // A hider's column stacks the status card, the board and the whole of the
    // Forge's tool panels, and at 720p that is taller than the region. One
    // scrollbar is the region's; a second one nested inside it splits the column
    // into two things the player has to scroll separately to read.
    render(
      <HuntHud
        state={huntState({ role: "mimic" })}
        gun={GUN}
        forge={stubForge("pose")}
        pointerLocked={false}
        boardOpen
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    const column = container.querySelector('[data-hud-region="leftColumn"]');
    expect(column).not.toBeNull();
    const scrollers = [column, ...(column?.querySelectorAll("*") ?? [])].filter((element) => {
      const style = (element as HTMLElement | null)?.style;
      return style !== undefined && ["auto", "scroll"].includes(style.overflowY);
    });
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]).toBe(column);
  });

  it("folds a hider's tool panels at every size, so the toolset is not drawn twice", () => {
    // The panels' own contents have to be absent from the DOM rather than
    // merely hidden: what they cost is the count of things on screen, and the
    // rail beside them is already the whole toolset with the keys on it.
    const restore = { width: window.innerWidth, height: window.innerHeight };
    const folded: Record<string, string | null> = {};
    for (const viewport of VIEWPORTS) {
      Object.defineProperty(window, "innerWidth", { value: viewport.width, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: viewport.height, configurable: true });
      render(
        <HuntHud
          state={huntState({ role: "mimic" })}
          gun={GUN}
          forge={stubForge("pose")}
          pointerLocked={false}
          boardOpen={false}
          onToggleBoard={() => undefined}
          onTaunt={() => undefined}
        />,
      );
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      folded[viewport.name] =
        container.querySelector("[data-forge-panels]")?.getAttribute("data-forge-panels") ?? null;
      // The header is always there, so the panels are always one press away.
      expect(textOf("leftColumn"), viewport.name).toContain("Forge tools");
    }
    Object.defineProperty(window, "innerWidth", { value: restore.width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: restore.height, configurable: true });

    expect(folded["1280x720"]).toBe("folded");
    expect(folded["1920x1080"]).toBe("folded");
  });

  it("opens the folded panels when the header is pressed", () => {
    Object.defineProperty(window, "innerHeight", { value: 720, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    render(
      <HuntHud
        state={huntState({ role: "mimic" })}
        gun={GUN}
        forge={stubForge("pose")}
        pointerLocked={false}
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    const wrapper = container.querySelector("[data-forge-panels]");
    expect(wrapper?.getAttribute("data-forge-panels")).toBe("folded");
    expect(textOf("leftColumn")).not.toContain("Starter arrangements");

    const header = wrapper?.querySelector("button");
    act(() => {
      header?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      container.querySelector("[data-forge-panels]")?.getAttribute("data-forge-panels"),
    ).toBe("open");
    expect(textOf("leftColumn")).toContain("Starter arrangements");
  });

  it("unfolds the panels when the player changes tool, so a tool key is never pressed at nothing", () => {
    // The rail carries the tool keys through the hunt (override 2). Selecting
    // Shape and being shown a folded header is the failure this prevents.
    Object.defineProperty(window, "innerHeight", { value: 720, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    const props = {
      state: huntState({ role: "mimic" }),
      gun: GUN,
      pointerLocked: false,
      boardOpen: false,
      onToggleBoard: () => undefined,
      onTaunt: () => undefined,
    };
    render(<HuntHud {...props} forge={stubForge("pose")} />);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(
      container.querySelector("[data-forge-panels]")?.getAttribute("data-forge-panels"),
    ).toBe("folded");

    render(<HuntHud {...props} forge={stubForge("shape")} />);
    expect(
      container.querySelector("[data-forge-panels]")?.getAttribute("data-forge-panels"),
    ).toBe("open");
  });

  it("renders nothing outside a region", () => {
    render(
      <HuntHud
        state={huntState({ role: "mimic" })}
        gun={GUN}
        forge={stubForge("paint")}
        pointerLocked={false}
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    const layoutRoot = container.firstElementChild;
    expect(layoutRoot).not.toBeNull();
    const children = [...(layoutRoot?.children ?? [])];
    expect(children).toHaveLength(claimedRegions().length);
    for (const child of children) expect(child.hasAttribute("data-hud-region")).toBe(true);
  });

  for (const viewport of VIEWPORTS) {
    it(`keeps a hider's claimed regions apart at ${viewport.name}`, () => {
      render(
        <HuntHud
          state={huntState({ role: "mimic" })}
          gun={GUN}
          forge={stubForge("shape")}
          pointerLocked={false}
          boardOpen
          onToggleBoard={() => undefined}
          onTaunt={() => undefined}
        />,
      );
      expectDisjoint(claimedRegions(), viewport.width, viewport.height);
    });

    it(`keeps an Inspector's claimed regions apart at ${viewport.name}`, () => {
      render(
        <HuntHud
          state={huntState({ role: "inspector" })}
          gun={GUN}
          forge={null}
          pointerLocked
          boardOpen
          onToggleBoard={() => undefined}
          onTaunt={() => undefined}
        />,
      );
      expectDisjoint(claimedRegions(), viewport.width, viewport.height);
    });
  }
});

function expectDisjoint(regions: readonly HudRegion[], width: number, height: number): void {
  const collisions: string[] = [];
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const a = regions[i] as HudRegion;
      const b = regions[j] as HudRegion;
      if (rectsOverlap(regionRect(a, width, height), regionRect(b, width, height))) {
        collisions.push(`${a} over ${b}`);
      }
    }
  }
  expect(collisions).toEqual([]);
}

describe("hunt HUD grammar", () => {
  it("gives a hider the four anchors the original has", () => {
    render(
      <HuntHud
        state={huntState({ role: "mimic" })}
        gun={GUN}
        forge={stubForge("pose")}
        pointerLocked={false}
        boardOpen
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    const claimed = claimedRegions();
    expect(claimed).toContain("topCenter");
    expect(claimed).toContain("rightRail");
    expect(claimed).toContain("bottomCenter");
    expect(claimed).toContain("bottomRight");
    expect(claimed).toContain("leftColumn");
    // The reticle belongs to whoever is holding the gun.
    expect(claimed).not.toContain("center");
  });

  it("puts the countdown and the phase in the top-centre row, and nowhere else", () => {
    render(
      <HuntHud
        state={huntState({ role: "mimic" })}
        gun={GUN}
        forge={stubForge("pose")}
        pointerLocked={false}
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    // The row prints the clock the way every other clock in the game is
    // printed, and says the count of hiders in words rather than in a rank of
    // 13-px figures the round-1 critic read as "†††⧗42†".
    expect(textOf("topCenter")).toContain("1:36");
    expect(textOf("topCenter")).toContain("STILL HIDDEN");
    expect(textOf("topCenter")).toContain("SEARCH TIME");
    // The Forge header used to print "FORGE · POSE" on top of the timer.
    for (const region of claimedRegions()) {
      expect(textOf(region).toUpperCase()).not.toContain("FORGE ·");
    }
  });

  it("puts the hider's tools on the rail once each, and not in a second column", () => {
    render(
      <HuntHud
        state={huntState({ role: "mimic" })}
        gun={GUN}
        forge={stubForge("pose")}
        pointerLocked={false}
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    const rail = container.querySelector('[data-hud-region="rightRail"]');
    const chips = [...(rail?.querySelectorAll("button, [aria-label] > div > div") ?? [])];
    expect(chips.length).toBeGreaterThan(0);
    for (const label of ["Pose", "Shape", "Panels", "Material", "Paint Mode", "Taunt"]) {
      const matches = (rail?.textContent ?? "").split(label).length - 1;
      expect(matches, `${label} on the rail`).toBe(1);
    }
    // The tool keys live in one place. "1 Pose" in the left column as well is
    // exactly the duplication the collision came from.
    expect(textOf("leftColumn")).not.toContain("Paint Mode");
  });

  it("shows the taunt with its own chip, not stacked on its hint", () => {
    render(
      <HuntHud
        state={huntState({ role: "mimic" })}
        gun={GUN}
        forge={stubForge("pose")}
        pointerLocked={false}
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    expect(textOf("rightRail")).toContain("Taunt");
    expect(textOf("bottomCenter")).not.toContain("Taunt");
  });

  it("gives an Inspector the reticle and no taunt", () => {
    render(
      <HuntHud
        state={huntState({ role: "inspector" })}
        gun={GUN}
        forge={null}
        pointerLocked
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    expect(claimedRegions()).toContain("center");
    expect(textOf("rightRail")).not.toContain("Taunt");
    expect(textOf("rightRail")).toContain("Fire a warrant");
    expect(textOf("leftColumn")).toContain("WARRANT ROUNDS");
    expect(textOf("bottomCenter")).toContain("Walk");
  });

  it("replaces an Inspector's control strip with the pointer-lock prompt until the room is theirs", () => {
    render(
      <HuntHud
        state={huntState({ role: "inspector" })}
        gun={GUN}
        forge={null}
        pointerLocked={false}
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    expect(textOf("bottomCenter")).toContain("Click to look around");
    expect(textOf("bottomCenter")).not.toContain("Walk");
  });

  it("keeps a caught hider on the board and off the rail's tools", () => {
    render(
      <HuntHud
        state={huntState({ role: "mimic", lifeState: "caught" })}
        gun={GUN}
        forge={null}
        pointerLocked={false}
        boardOpen
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    expect(textOf("leftColumn")).toContain("You were found");
    expect(textOf("leftColumn")).toContain("Fooled the Inspector");
    expect(textOf("rightRail")).not.toContain("Taunt");
  });
});

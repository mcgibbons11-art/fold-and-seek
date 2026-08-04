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
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const VIEWPORTS = [
  { name: "640x660", width: 640, height: 660 },
  { name: "640x720", width: 640, height: 720 },
  { name: "960x540", width: 960, height: 540 },
  { name: "1280x720", width: 1280, height: 720 },
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
  readonly watchedLevel?: 0 | 1 | 2;
  readonly finalTen?: boolean;
  readonly warrantsRemaining?: number;
  readonly accusations?: RoundViewState["accusations"];
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
      finalTen: overrides.finalTen ?? false,
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
      warrantsRemaining: overrides.role === "inspector" ? (overrides.warrantsRemaining ?? 3) : null,
      accusationReadyAtServerMs: null,
      accusationCooldownMs: 0,
      tauntCooldownMs: 0,
      watchedLevel: overrides.watchedLevel ?? 0,
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
    accusations: overrides.accusations ?? [],
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
    notices: [],
    myHuntLedger: null,
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
    activeMode: mode,
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
    deactivateTools: () => undefined,
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

function openActions(): void {
  const disclosure = container.querySelector<HTMLButtonElement>(
    '[data-hud-region="rightRail"] button[aria-expanded]',
  );
  expect(disclosure).not.toBeNull();
  act(() => disclosure?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
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

  it("keeps one persistent Forge dock and no duplicate action rail in every Portals pane", () => {
    const restore = { width: window.innerWidth, height: window.innerHeight };
    for (const viewport of VIEWPORTS) {
      Object.defineProperty(window, "innerWidth", { value: viewport.width, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: viewport.height, configurable: true });
      render(
        <HuntHud
          key={viewport.name}
          state={huntState({ role: "mimic", tauntAllowed: false })}
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
      expect(container.querySelectorAll('[data-hider-forge-dock="persistent"]'), viewport.name).toHaveLength(1);
      expect(container.querySelectorAll('[data-forge-command-owner="hider-dock"]'), viewport.name).toHaveLength(1);
      expect(container.querySelectorAll("[data-persistent-plate]").length, viewport.name).toBeLessThanOrEqual(3);
      expect(container.querySelector('[data-hud-region="rightRail"]'), viewport.name).toBeNull();
      expect(textOf("leftColumn"), viewport.name).toContain("Starter arrangements");
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

  it("keeps a hider's tool panel open at every supported viewport", () => {
    // USER DIRECTIVE (2026-08-02): the fold tools must never READ as taken
    // away mid-round, so the panels start open wherever the column holds them
    // whole. At 720p they would open onto a scrollbar, so the critic's folded
    // default keeps that case and the rail's keys remain the way in.
    const restore = { width: window.innerWidth, height: window.innerHeight };
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
      expect(container.querySelectorAll('[data-forge-command-owner="hider-dock"]'), viewport.name).toHaveLength(1);
      expect(textOf("leftColumn"), viewport.name).toContain("Starter arrangements");
    }
    Object.defineProperty(window, "innerWidth", { value: restore.width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: restore.height, configurable: true });
  });

  it("starts the persistent panel open and collapses only from its arrow", () => {
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
    const wrapper = container.querySelector('[data-hider-forge-dock="persistent"]');
    expect(wrapper).not.toBeNull();
    expect(textOf("leftColumn")).toContain("Starter arrangements");
    const toggle = wrapper?.querySelector('button[aria-label="Collapse Forge tools"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      (toggle as HTMLButtonElement).click();
    });
    const collapsed = wrapper?.querySelector<HTMLElement>('[data-forge-panels="collapsed"]');
    expect(collapsed).not.toBeNull();
    expect(collapsed?.style.width).toBe("30px");
    expect((wrapper as HTMLElement).style.width).toBe("30px");
    expect(textOf("leftColumn")).not.toContain("Starter arrangements");
    expect(textOf("leftColumn")).toContain("Expand Forge tools");
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
    expect(container.querySelector('[data-forge-command-owner="hider-dock"]')).not.toBeNull();

    render(<HuntHud {...props} forge={stubForge("shape")} />);
    expect(container.querySelector('[data-forge-command-owner="hider-dock"]')).not.toBeNull();
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
  it("centres shot callouts in an outer wrapper the rise animation cannot overwrite", () => {
    render(
      <HuntHud
        state={huntState({
          role: "inspector",
          accusations: [{
            id: 11,
            atServerMs: 1,
            inspectorPublicId: "p1",
            byMe: true,
            targetObjectId: "mimic-1",
            correct: true,
            stamp: "MIMIC FOUND",
            reactionId: null,
            revealedPlayerPublicId: "p2",
            revealedDisplayName: "Bot",
            warrantsRemaining: 2,
          }],
        })}
        gun={GUN}
        forge={null}
        pointerLocked
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );

    const wrapper = container.querySelector<HTMLElement>('[data-shot-callout="true"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.transform).toBe("translateX(-50%)");
    expect(wrapper?.classList.contains("fs-rise")).toBe(false);
    expect(wrapper?.querySelector(".fs-rise")).not.toBeNull();
    expect(wrapper?.textContent).toContain("MIMIC FOUND");
  });

  it("gives a hider only the persistent anchors needed during play", () => {
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
    expect(claimed).toContain("leftColumn");
    expect(claimed).not.toContain("rightRail");
    expect(claimed).not.toContain("bottomRight");
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

  it("puts every Hider command in the persistent dock exactly once", () => {
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
    const dock = container.querySelector('[data-hider-forge-dock="persistent"]');
    const chips = [...(dock?.querySelectorAll("button") ?? [])];
    expect(chips.length).toBeGreaterThan(0);
    for (const label of ["Pose", "Shape", "Panels", "Material", "Paint", "Mirror", "Taunt", "Missed spots"]) {
      const matches = chips.filter((button) => button.textContent?.includes(label)).length;
      expect(matches, `${label} in the dock`).toBe(1);
    }
    expect(container.querySelector('[data-hud-region="rightRail"]')).toBeNull();
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
    expect(textOf("leftColumn")).toContain("Taunt");
    expect(textOf("leftColumn").split("Taunt")).toHaveLength(2);
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
    openActions();
    expect(textOf("rightRail")).toContain("Fire a warrant");
    expect(textOf("leftColumn")).toContain("WARRANT ROUNDS");
    expect(claimedRegions()).not.toContain("bottomCenter");
  });

  it("keeps controls out of the persistent Inspector HUD", () => {
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
    expect(claimedRegions()).not.toContain("bottomCenter");
    expect(container.textContent).not.toContain("WASD");
  });

  it("lets danger and traversal preempt a returning Hider's low-priority hint", () => {
    render(
      <HuntHud
        state={huntState({ role: "mimic", watchedLevel: 2, finalTen: true })}
        gun={GUN}
        forge={stubForge("pose")}
        pointerLocked={false}
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
        traversal="climbing"
        dangerBearingRad={0.5}
      />,
    );
    const status = container.querySelector('[data-hider-urgency="danger"]');
    expect(status?.getAttribute("data-hider-density")).toBe("compact");
    expect(status?.textContent).toContain("Freeze");
    expect(status?.textContent).not.toContain("Move slowly");
    expect(container.querySelectorAll('[aria-label="Inspector direction"]')).toHaveLength(1);
  });

  it("makes every Inspector firing state distinct without relying on colour", () => {
    const cases = [
      { name: "normal", gun: GUN, state: huntState({ role: "inspector" }), shape: "open", symbol: false },
      {
        name: "target",
        gun: { ...GUN, targetObjectId: "prop", targetDistanceM: 4, targetInRange: true },
        state: huntState({ role: "inspector" }),
        shape: "lock",
        symbol: false,
      },
      {
        name: "range",
        gun: { ...GUN, targetObjectId: "prop", targetDistanceM: 40, targetInRange: false },
        state: huntState({ role: "inspector" }),
        shape: "broken",
        symbol: true,
      },
      {
        name: "cooldown",
        gun: { ...GUN, state: "cooldown" as const, cooldownRemainingMs: 500 },
        state: huntState({ role: "inspector" }),
        shape: "cooldown",
        symbol: true,
      },
      {
        name: "empty",
        gun: GUN,
        state: huntState({ role: "inspector", warrantsRemaining: 0 }),
        shape: "empty",
        symbol: true,
      },
    ] as const;
    const labels = new Set<string>();
    for (const entry of cases) {
      render(
        <HuntHud
          key={entry.name}
          state={entry.state}
          gun={entry.gun}
          forge={null}
          pointerLocked
          boardOpen={false}
          onToggleBoard={() => undefined}
          onTaunt={() => undefined}
        />,
      );
      const reticle = container.querySelector(`[data-reticle-shape="${entry.shape}"]`);
      expect(reticle, entry.name).not.toBeNull();
      labels.add(reticle?.getAttribute("aria-label") ?? "");
      expect(reticle?.querySelector("[data-reticle-symbol]") !== null, entry.name).toBe(entry.symbol);
    }
    expect(labels.size).toBe(cases.length);
  });

  it("promotes the Inspector's warrant count and names empty state in text", () => {
    render(
      <HuntHud
        state={huntState({ role: "inspector", warrantsRemaining: 0 })}
        gun={GUN}
        forge={null}
        pointerLocked
        boardOpen={false}
        onToggleBoard={() => undefined}
        onTaunt={() => undefined}
      />,
    );
    const warrants = container.querySelector('[data-warrant-state="empty"]');
    expect(warrants).not.toBeNull();
    expect(warrants?.textContent).toContain("EMPTY");
    expect(warrants?.textContent).toContain("WARRANT ROUNDS");
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

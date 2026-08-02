# STATUS

## Current phase

Phase 3 — playable local round. The wiring described under "Phase 3 wiring" below is in
place: "Play a round" on the main menu now runs a whole match in one tab against the
Curiosity Shop, with no network.

## Live-hunt presentation (2026-08-02)

Three sim events the audits found produced but never consumed now reach the
player. Nothing in the simulation or in `@foldseek/shared` changed.

**The missed-finds board** (the original's Missed-Spot Ranking, key 6).
`RoundDirector` was dropping `missed_finds_update` in its default branch; it now
holds the last board and publishes a `MissedFindsView` slice on `RoundViewState`
with ranked rows, the viewer's own row marked, and the "next update Ns" countdown
derived from `nextUpdateAtMs` against the director's corrected server clock.
`MissedFindsHud` renders it top-right through the inspection phases and the
reveal, toggled on key 6 by `RoundHud`, for both roles — that shared visibility
is the original's behaviour and is what makes being seen worth playing for. The
key listener ignores keystrokes aimed at an input, because the paint panel's hex
and numeric fields are live while a hider paints during the hunt.

There is **no state fallback**: the ranking exists only as an event, so a player
who joins mid-round has no board until the next report, and the view says
`received: false` rather than showing an empty ranking that would read as
"nobody has scored". The board is cleared with the round.

**Taunt presentation.** `DisguiseTheatre.taunt` performs the gesture on the
disguise the event names, never on a player. Five motions, one per `TauntId`,
are described as shares of the body's own measured height rather than in metres,
so they survive the scale retune; the event's seed picks the starting phase and
the lean direction, so every client animates the same taunt identically. The
envelope opens and closes on zero, so a gesture cannot leave an object askew.
The focus box is deliberately measured with the body at rest: it is what the
reticle brackets and what the authority shoots against, and letting it follow a
cosmetic wobble would make a taunting object unshootable where it appears.
`taunt` returns false for an object this theatre is not drawing, which is how a
hider's own disguise looks from here while the Forge holds it — `RoundSession`
still plays them the sound.

**Audio.** `ForgeSoundId` is now `SoundId` and carries the hunt clips.
`gameplay/huntCues.ts` is the explicit crossing between the simulation's
vocabulary and the bundle's filenames (`clock_chimes` → `clock_chime.mp3`),
written out rather than derived, so a reaction added upstream breaks the build
instead of playing nothing. Taunt uses `unfold_reveal`, a catch `caught_sting`,
a wrong accusation `wrong_horn`, and each `InnocentReactionId` its own clip.

**Innocent reactions in the world.** The shop's props are merged and instanced
into shared draw calls, so an individual chair cannot be squeaked by moving it.
`ReactionTheatre` instead raises a short coloured flare at the prop's own
published focus bounds, with a point light for the reactions that are lights,
and fades it out; an object the map does not publish is heard but not seen
rather than given an invented position.

**Verified** (`pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` all green;
418 client, 161 sim, 46 shared, 21 server):

- `missedFinds.test.ts` drives real rounds at the simulation's own uncompressed
  ~20 s report cycle (it is not host-settable) and checks the empty state before
  the first report, the ranking and its 25-point buckets, a countdown that
  actually falls, a hider's own row, the exact board at the reveal, and the
  clear on rematch.
- `disguiseTheatre.test.ts` gained taunt coverage: the gesture reaches the body
  and returns it to rest, three theatres given the same seed agree exactly while
  a different seed diverges, gestures differ from one another in shape and
  length, an unknown object is refused without a sound, and a creep arriving
  mid-taunt produces exactly the bounds a theatre with no taunt running produces.
- `huntPresentation.test.ts` covers task 3 end to end: a hider creeps, the
  authority accepts it and emits `disguise_updated { moved: true }`, and an
  observer's theatre re-measures the body 0.05 m along; the same for paint, which
  arrives as `painted: true` and puts bound paint materials on the body. Also
  checks that every `INNOCENT_REACTION_ID` names a bundled sound.

`disguise_updated` is intentionally **not** consumed as an event. It carries no
geometry, only the news that some object changed; pose and paint travel in public
state, which `RoundSession.update` re-reads every frame, so the visual was
already correct and the tests now hold it that way.

### Deception score feedback, and the last two SFX (second pass)

**`direct_look_escape` and `close_pass` now reach the hider who earned them**, as
a `DeceptionView` slice on `RoundViewState` and a readout in `HiderHud`: the
running total, the two counts, and the latest event named in words. Point values
come from `SCORE_MIMIC_PER_DIRECT_LOOK_ESCAPE` and `SCORE_MIMIC_PER_CLOSE_PASS`
rather than being written out again in the client.

The guard on this is not cosmetic. Both events are **broadcast** and name a
public object, and the only client that can turn that object into a person is
the one wearing it. `RoundDirector.recordDeception` therefore drops any event
whose object is not the viewer's own disguise, so an Inspector is never told
that the thing they just stared at was a Mimic, and a hider cannot count another
hider's escapes and correlate them against where the Inspector was standing.
`deceptionFeedback.test.ts` drives real focus commands through the loopback,
asserts the escape was actually broadcast, and then asserts the Inspector's and
the bystanding hider's view states stay empty. Deleting the guard fails exactly
those two tests, which was checked by hand rather than assumed.

**`door_open`** plays once on entering InspectionIntro, for every role: it is the
moment the room stops being a workshop, and a hider hearing the Inspector let in
is the phase opening. This is an interpretation of the §5 walk-out beat, not a
door prop the map has — there is no door interaction to hang it on.

**`footstep_wood`** is the Inspector's own locomotion, throttled from the speed
`InspectorController` actually achieved, with the stride quoted against
`WORLD_SCALE.playerHeight` so it neither drums at a standstill nor keeps a human
cadence for a 0.35 m body. All nine hunt clips are now wired.

**Producer gap, not fixed here: `close_pass` can never fire in play.**
`MatchSimulation.recordClosePass` has no caller anywhere in the client — only the
simulation's own tests call it. Nothing detects an Inspector physically passing
close to a disguise and reports it, so half of the deception score is dead in a
real round. The consumer is built and symmetrical with the escape path, and is
covered only as far as an unreachable event allows. Closing this needs a producer
on the Inspector side plus a way to report it to the authority, which is a new
verb on `NetworkAdapter` and therefore a `packages/shared` change.

## Art pass (2026-08-02, landed UNREPORTED — agent terminated before its writeup)

The art agent's changes are in this commit but it never delivered its gap analysis:
edits to `world/maps/lighting.ts`, `props/{batch,furniture,geometry,materials}.ts`,
`maps/swatches.ts`, `mimic/visual/mimicGeometry.ts`, plus a re-captured
`docs/screenshots/map-zone-a.jpeg`. Typecheck/tests/build are green over these changes
and the round runs at ~54 fps on WebGPU against them, but WHAT was improved and what
remains is undocumented. The next critic pass must judge the art bar visually against
`assets-source/references/` and the og screenshots rather than trusting any claim here.
CORRECTION (critic pass, same night): the earlier attribution of the "WebGPU under
1 fps" scare to HMR churn is REFUTED as a complete explanation. The critic reproduced
0.14 fps in the shop on a frozen production build (menu 39 fps, WebGL2 shop 21 fps,
same session), while the lead measured 54 fps on WebGPU in the hunt on the settled dev
tree the same evening. The two measurements conflict and neither is trusted; WebGPU
performance in the shop is an OPEN defect needing a controlled bisect (suspects: the
17 practicals + 2 shadowed lights driving per-frame pipeline/bind-group rebuilds in
the node-material path). Until it is understood, treat WebGL2 as the reliable backend.

## Phase 3 wiring (2026-08-02)

### What works end to end

A solo round runs from the main menu through every phase. `createLocalRound` builds a
`LocalLoopbackAdapter` carrying the map's real `ObjectRegistry` and a real
`SpatialValidatorImpl`, seats three auto-playing bots, and joins. `GameHost.enterRoundMode`
disposes the menu room, builds `ShopWorld` (Curiosity Shop plus its environment), and
creates a `RoundSession`. The session watches the one `RoundViewState` the `RoundDirector`
publishes and hands the player whichever system that phase calls for:

- **Lobby and the intro phases** — a slow survey camera turning inside the shop, with the
  existing `LobbyHud`, `RoleRevealHud` and `BaselineHud` over it.
- **Forge** — a `ForgeController` at the map's central Mimic spawn, with `ForgeHud` nested
  inside `ForgePhaseHud`. An Inspector sees the staging HUD instead.
- **Locking** — the session locks the disguise it has, publishes the paint layer, and sends
  `lock_disguise`. Whatever the player has on the workbench is what the room gets.
- **Inspection** — an Inspector takes `createInspectorSystem` (first-person rig, focus,
  warrant gun) with pointer lock taken on a canvas click. A hider keeps the Forge open at
  the hunt's own copy so they can go on shaping and creeping, with `HiderHud`'s watched
  indicator and taunt over it (override 2).
- **Reveal, Results, Rematch** — survey camera with `RevealHud` and `ResultsHud`.

Bots lock authored disguises rather than the simulation's origin fallback:
`botDisguises.ts` gives each one a starter arrangement standing on a different authored
Mimic spawn, encoded through the new `mimic/poseWire.ts` bridge between the Forge's
`DisguiseState` and the canonical `DisguiseWire`. `DisguiseTheatre` decodes every public
disguise, poses a `MimicVisual` with it, and publishes a focus proxy carrying a neutral
category and the live bounds, so a disguise is picked and shot by exactly the code path a
shop prop is.

### Verified

- `pnpm -r typecheck`, `pnpm -r test` (392 client, 161 sim, 46 shared, 21 server) and
  `pnpm -r build` all green.
- New tests: `poseWire.test.ts` (every starter arrangement survives the crossing),
  `localRound.test.ts` (a four-seat round reaches the hunt with three authored disguises in
  different places), `disguiseTheatre.test.ts` (a public pose becomes geometry with
  non-empty bounds, and the cast is added and removed correctly),
  `roundAccusation.test.ts` (an Inspector standing over a bot's disguise catches it; the
  same shot from across the shop and a shot before the eye is known are both refused
  `spatial_rejected`; a wrong accusation on a real prop spends a warrant and fires an
  innocent reaction).
- In-browser on the WebGL 2 backend: menu → lobby with the bot roster → ready → start →
  role reveal → baseline scan → Forge with the Mimic and its handles in the shop →
  Inspection with the hider HUD, taunt and watched indicator. Screenshots in
  `docs/screenshots/round-lobby.jpeg`, `round-forge.jpeg`, `round-inspection.jpeg`.

### Audit follow-ups closed (2026-08-02, second pass)

- **The simulation now judges geometry on the round path.** `RoundSpatialBridge` *is* the
  `SpatialValidator` the loopback hands `MatchSimulation`, rather than holding one, because
  the simulation takes its validator once at construction. That indirection also fixes the
  frozen-settings bug: the host can change `accusationDistance` or `inspectorFocusDistance`
  in the lobby and the bridge rebuilds the implementation under a stable identity, driven
  from `RoundSession.update`. `roundAccusation.test.ts` proves a shot through the shop wall
  is refused with detail `no_line_of_sight` specifically, so it is the wall and not the
  range doing the refusing.
- **A rate-limited taunt no longer disables the taunt.** `KNOWN_TAUNT_REFUSALS` was missing
  `rate_limited` and `payload_too_large`, either of which the room or the relay can emit;
  one busy second permanently set `tauntSupported = false` and hid the button for the rest
  of the match. Both are now known refusals, covered in `tauntCapability.test.ts`.
- **Peer paint renders.** `DisguiseTheatre` builds a `PaintLayer` per painted disguise,
  loads it with `fromWireData`, and binds it through `PaintMaterialBinder` after the swatch
  materials are applied, so the base colour is baked into the unpainted texel correctly. A
  disguise whose layer is cleared has its own materials handed back. `RevealEntryView` now
  carries `encodedPaint` too, so the reveal can show painted bodies.
- **The Forge workspace comes from the map.** `WORKSPACE_HALF`/`WORKSPACE_MIN_Y`/
  `WORKSPACE_MAX_Y` were TestRoom values (an 8 m box about the origin) and silently dragged
  a Mimic back whenever it was posed past them; The Curiosity Shop runs 15 m by 11 m.
  `ForgeController` now takes a `ForgeWorkspace`, defaulting to `TEST_ROOM_WORKSPACE` for
  practice, and the round passes `SHOP_FORGE_WORKSPACE` (published by `ShopWorld` from the
  zone constants). It reaches the walls and the ceiling rather than stopping short, because
  wall-mounting and hanging are legal disguises. `localRound.test.ts` guards the regression:
  several authored Mimic spawns fall outside the old box.

### Giant scale: the knob and the four numbers derived from it (2026-08-02)

**One source of truth.** `PLAYER_HEIGHT_M = 0.35` now lives in
`packages/shared/src/config.ts`, and `inspector/navData.ts` `WORLD_SCALE.playerHeight`
reads it. Shared cannot import client code, and the match settings need the same number
the character controller uses, so shared owns it and the client borrows it.
`InspectorCamera` and the Forge's §7.6 preview cameras already derive from it.

The rest of `WORLD_SCALE` is now written as shares of that height rather than as loose
literals: `playerRadius` and `groundSnap` 0.35 of it, `eyeHeight` 0.9, `stepHeight` 0.2,
`climbActivationRadius` 0.43, `mantleSpeed` 1.6 body lengths a second and `ladderSpeed`
exactly one. Every value moves by at most 5 mm from what it was, so this is a change of
authorship rather than of behaviour. `gravity` and `terminalFallSpeed` stay absolute on
purpose: the shop's ledges are real heights and a body falling off one accelerates at the
real rate.

**The four settings are derived rather than written out**, each with its arithmetic beside
the constant in `config.ts`:

| Setting | Was | Now | Derivation |
|---|---|---|---|
| `inspectorMoveSpeed` | 2.8 m/s | 0.91 m/s | 2.6 body lengths/s |
| `hiderCreepSpeed` | 0.6 m/s | 0.175 m/s | 0.5 body lengths/s |
| `inspectorFocusDistance` | 8.0 m | 2.1 m | 6 body heights |
| `accusationDistance` | 5.5 m | 1.05 m | 3 body heights |

*Walk speed* comes from Froude scaling: geometrically similar legged walkers move alike at
equal v²/(g·L). A 1.75 m person breaks from a walk into a run near 2.1 m/s, a Froude
number of about 0.5; the same number over a 0.35 m body with a 0.175 m leg gives 0.93 m/s,
which is 2.6 body lengths a second. Small creatures cover more of their own lengths per
second than people do, so this is deliberately not the human figure of 1.2. It also lands
in the right relation to the climb speeds the map is already authored against: walking is
a little under twice a vault, where 2.8 m/s was five times a vault and an Inspector
crossed the floor faster than they could climb the stool in front of them.

*Creep* at half a body length a second is the speed at which a disguise still reads as
furniture that moved while nobody was looking. It is under a fifth of the walk, so creeping
can never outrun a search, and over a full hunt a patient hider can still relocate about
the length of the shop.

*Focus and gun reach.* Six body heights is 2.1 m, the human-scale equivalent of seeing
object detail at 10.5 m: enough to pick a shape out of the next aisle, well short of the
15 m the shop runs end to end. The gun reaches half that, so noticing something always
costs a walk toward it. The old 8.0 m focus was 23 body heights, a human equivalent of
40 m, which made most of the shop inspectable from wherever the Inspector stood.

**Tests.** `apps/client/tests/maps/giantScale.test.ts` is new: every starter arrangement,
normalised to player height, fits under three real anchor surfaces (`crawl_workbench`,
`crawl_office_desk`, `shelving_board_2` with the board above it), measured by box and by
orientation-free bounding sphere, with the headroom read out of `NAV_BLOCKERS` rather than
trusted from the surface's `clearance` note. It also pins `accusationDistance` under a
quarter of the shop's long axis, orders accusation < focus < half the short axis, and
checks `WORLD_SCALE.playerHeight === PLAYER_HEIGHT_M`.

Four existing suites had human-scale numbers baked into their fixtures and were rewritten
to derive them, which strengthens rather than weakens what they prove:
`liveHiders.test.ts` now states creep distances through a `creepBudget(ms)` helper, so a
retune cannot turn "a teleport" into "a legal creep"; `spatialValidator.test.ts` had an eye
at y = 1.6 m and targets placed in absolute metres and is now built entirely from shares of
the two reaches under test; `shooting.test.ts` took a literal 1.2 m focus distance and now
takes half the gun's reach; `controller.test.ts` had frame counts that assumed 2.8 m/s and
now uses the existing `walkUntil` helper. `roundAccusation.test.ts`'s wall shot could no
longer be built against a bot disguise at 1.05 m reach, so it now searches the map's own
geometry for an accusable prop with cover in front of it, which keeps the refusal a
line-of-sight refusal rather than a range one.

### The Mimic body is now at player scale (2026-08-02, closes the earlier P0)

The rig was authored in its own units and nothing converted them, so a Mimic stood
1.68–2.16 m tall in a shop where the Inspector is 0.35 m. It now converts once.

`mimic/rig.ts` publishes `RIG_AUTHORED_HEIGHT = 1.1` and
`RIG_TO_WORLD = PLAYER_HEIGHT_M / RIG_AUTHORED_HEIGHT`, and the `BONE_SOURCES` → `BONES`
map is the single place authored units become world metres, multiplying every
`localPosition` and `length`. Angles, axes and joint limits are dimensionless and pass
through untouched. The bone table stays written at creature scale, where the proportions
are readable, which is why the conversion lives at the seam rather than in the literals.

Everything else that turns rig units into geometry multiplies by the same constant:
`SEGMENT_DIMENSIONS` and `PANEL_THICKNESS_M` in `visual/MimicVisual.ts`, the panel size
and extension range in `mimic/panels.ts`, `IK_TOLERANCE` in `mimic/ikSolver.ts`, the
anchor snap/release/gap radii and position tolerance in `forge/anchors.ts`, and the
Forge's orbit distances, handle clamps, wall-mount standoff, wall search range,
auto-anchor radius and perch sampling. `HANDLE_SCREEN_RADIUS` is deliberately **not**
converted: it multiplies the camera distance, which already shrank, so converting it too
would shrink the handles twice.

`IK_TOLERANCE` is worth calling out. Left at an absolute 2 mm it would have become a
three-times looser solve relative to the body, so a pose would report converged while
sitting visibly off its target. It is quoted in authored units and converted with
everything else, which keeps the solver's precision scale-invariant.

Measured after the change: the rest pose stands with the crown at exactly 0.350 m, and the
starter arrangements run 0.17–0.47 m tall by 0.07–0.39 m across. Nothing on the wire
changed, because segment forms are unitless multipliers and the root position was always
in world metres; `poseWire.test.ts` still round-trips every starter arrangement.

**A separate bug came out of measuring this.** `MimicVisual` left the plate of a stowed or
absent panel at its build scale of one unit, and `Box3.setFromObject` measures hidden
children, so every disguise published focus bounds about a metre across regardless of its
actual size. That box is what the reticle brackets and what `SpatialValidatorImpl` checks a
shot against, so an Inspector was shooting a phantom slab rather than the object. A plate
that is not visible now has zero scale. `panelTipWorld` already refused invisible plates,
so nothing that reads panel geometry is affected.

`giantScale.test.ts` now measures real bodies in world metres with no normalisation: every
starter arrangement fits under all three anchor surfaces, the crown of the unfolded body is
`PLAYER_HEIGHT_M` exactly, and a new case pins each arrangement's published bounds to
within 1.25x of its own shells, which is what would have caught the panel-plate slab.

Not changed, and worth a look from whoever owns presentation: `WALL_MOUNT_HEIGHT_M` (1.15)
and `DOORWAY_POSITION` (y 1.62) in `ForgeController` are still human-scale heights. Both
are arguably room dimensions rather than body dimensions — a picture really does hang at
1.15 m in a real shop — but the doorway preview camera in particular now sits at nearly
five player heights, which is not a view anybody in the match can have.

### Stubbed, unverified or broken

- **WebGPU renders the round at under one frame per second** while WebGL 2 renders it at
  roughly 30. Measured by counting `RoundSession.update` calls: 2/1/0/0/0 per second on
  WebGPU against 36/27/35/12 on WebGL 2, and still zero per second at the `low` tier, so it
  is not shading cost. The same map in `map-viewer.html` on WebGPU managed about 12 fps.
  The cause is not isolated. It was measured while a second agent was rewriting the map's
  materials and lighting and while other WebGPU tabs were open, and the WebGL 2 run later
  produced a burst of shader compile failures and a device loss, so contention or the
  in-flight art edits may be involved. This is the single biggest open risk.
- The Inspector's own round was not exercised in the browser: roles come off a random seed
  and the draws landed on Mimic. The gun-to-catch chain is covered headlessly by
  `roundAccusation.test.ts`, but pointer lock, the first-person camera and the reticle were
  not seen running.
- A hider's creep is capped by the authority but not by the client: dragging the pelvis
  faster than `hiderCreepSpeed` is refused as `moved_too_fast` and the local body and the
  room's copy disagree until the next accepted pose.
- The Forge tool HUD and `HiderHud` overlap during the hunt, and the Forge's own header
  still reads "FORGE · POSE" there. Presentation only.
- Bots ready up and lock a disguise and do nothing else. A bot Inspector never accuses, so
  a round where the bots inspect always runs the clock out.
- The lobby has no room code, no settings controls and no way to change the bot count.

## Done

- Monorepo scaffold: root configs, shared/game-sim/client/server packages.
- Shared package: MatchPhase enum, protocol message names, DEFAULT_MATCH_SETTINGS, branded IDs.
- game-sim: deadline-driven phase machine (pure).
- Client: React boot shell with WebGPU/WebGL2 feature detection.
- Server: Colyseus skeleton with match room and /health endpoint.
- Portals SDK + multiplayer constraints researched and documented.

## Known gaps / deferred

- Engine (GameHost, renderer manager) not yet built — Phase 1.
- No lint config yet (eslint deferred until Phase 1 to keep boot fast).
- Colyseus schema decorator compatibility unverified until first typecheck.

### Critique round 1 (sim)

An adversarial audit of `packages/game-sim` and `packages/shared` produced 54 probes.
Findings accepted and fixed, each with a regression test named after the finding in
`packages/game-sim/tests/hardening.test.ts` or `packages/shared/tests/schemas.test.ts`:

- **P0-1** A Mimic dropped after their reconnect grace left an orphaned disguise that
  published an empty pose and absorbed a warrant as an innocent object. The lock now
  snapshots the pose into a disguise record that outlives its owner, and accusing it
  resolves as a correct catch naming the departed player (§5.8, §27.9).
- **P0-2** One Inspector's transient disconnect ended the round instantly. Only the loss
  of every Inspector *after* grace expiry ends it now.
- **P1-3** `encodedPose` was stored opaque. `DisguiseWireSchema` and `decodeDisguiseWire`
  in `@foldseek/shared` are now the canonical pose contract, and a lock that fails to
  decode is refused as `invalid_pose` (§7.16). With no valid pose at the Forge deadline,
  the fallback is explicit: the last valid pose, else `DEFAULT_ARRANGEMENT_ID`.
- **P1-4** An `ObjectRegistry` is now an input to the simulation, and accuse/focus refuse
  any target that is neither a registered innocent nor a live disguise (§36.5).
- **P1-5** Focus targets are validated, unique-focus scoring stops at the §6.2 cap, and
  direct-look escapes pass through `SpatialValidator.canObserve`.
- **P1-6** `addPlayer` refuses a join past `maxPlayers` or a repeated player id, and
  `set_settings` cannot shrink the room below its current roster.
- **P1-7** Simulation output is split at the source into `{ public, private }`. Roles and
  disguise ownership are per-player deliveries, so no transport can leak them by
  forwarding the wrong list. **This is an API break**: `drain()` and `CommandResult` no
  longer return a flat event array.
- **P1-8** The dead `phase/phaseMachine.ts` transition table is deleted; `phaseDurationMs`
  moved into `match/constants.ts`.
- **P1-9** A rematch requires enough connected players to field a round, and no round
  starts with an inspector count of zero.
- **P2 batch** Settings clamped to the wire bounds; published event nonces are salted and
  truncated instead of being derived master seeds; the correct-accusation cooldown is its own
  named constant rather than `accusationHoldMs`; accusation validation follows §28.4
  order; monotonic join index with a deterministic host-promotion tie-break; spectators
  cannot cast style votes; one staleness rule shared by lock and snapshot; `getPublicState`
  returns defensive copies; the final countdown derives from `inspectionMs`; the lock
  grace keeps a one-second floor; `QuaternionSchema` enforces unit length within 1e-3.

### Host migration snapshot (sim)

`MatchSimulation.snapshot()` and `MatchSimulation.restore(snapshot, deps)` capture and
rebuild complete authoritative state for §27.11 host migration: settings, seed and
generator cursor, sequence counter, phase/round/deadlines, the full roster with roles,
life state, stats, ready and connection-grace timestamps, disguise records with owner
mapping and pose, warrants, focus holds, rate-limit clocks, votes, results, and any
undrained events. `DeterministicRng` now exposes `cursor`/`fromCursor`; the generated
stream is unchanged (verified against the previous closure form over 5 seeds x 5000 draws).
The object registry is a restore dependency rather than snapshot data, and a map-id
mismatch throws rather than silently changing which objects are accusable.

A snapshot is always authored by a host that has since left, so `restore` accepts
`seatedPlayerIds` and detaches anyone no longer in the room, exactly as a live departure
would: disguises stay behind as catchable ghosts, the host is promoted, and the round ends
early if that leaves no Inspector. The resulting `player_left` and `host_changed` events
stay queued for the new host to broadcast. Restoring without the option and calling
`removePlayer` for each missing id reaches the same state.

`MatchSnapshotSchema` in `@foldseek/shared` validates an incoming snapshot, and
`restore` runs it before believing any of it. Under Portals the snapshot arrives from
another *client*, so it is untrusted peer input regardless of how it was produced;
restoring it unchecked would let a peer install arbitrary authoritative state. Validation
is structural (shape, types, no injected keys) with loose ranges, because this describes
internal mid-round state rather than a player command, and a bound guessed too tight would
reject a legitimate room.

**A snapshot is host-to-host secret material** — it contains every Mimic's role and the
disguise-to-player mapping. Portals `setState` is readable by every client, so an adapter
migrating through room state is taking the §43.8 party-stakes tradeoff knowingly and should
say so where it writes. Validation stops a forged snapshot; it does nothing about a read
one.

**Size.** Locked poses dominate a full snapshot, so `snapshot({ poses: "omit" })` leaves
them out and `restore(..., { poses })` rebuilds them from the public state a new host
already holds. Measured mid-inspection with the reference pose (~3.4 KB each):

| Roster | Full | Pose-omitted |
|---|---|---|
| 4 | 30.1 KB | 2.2 KB |
| 8 | 68.9 KB | 3.7 KB |
| 12 | 98.2 KB | 5.1 KB |

A pose-omitted snapshot fits one transport key at any supported roster. A full one exceeds
a four-key, 8 KB-per-key budget from five players up.

Omission is only available once every pose is locked. During Forge a Mimic's working pose
is private and exists nowhere else, so `snapshot({ poses: "omit" })` throws rather than
truncating it, and a full Forge-phase snapshot runs 35 KB at eight players and 50 KB at
twelve. Migrating mid-Forge therefore needs either more keys at a lower publish cadence or
an accepted loss of in-progress Forge work.

Note that `estimateSnapshotBytes - estimateSnapshotPoseBytes` overstates the non-pose
remainder, because an encoded pose is JSON inside JSON and pays escaping on top of its raw
length. Take the pose-omitted figure as the real non-pose cost.

### Live hiders and taunts (sim)

Per the user design override in CLAUDE.md (classic MECCHA CHAMELEON), hiders stay active
through the hunt instead of hard-freezing at lock. This supersedes bible §5.8 "freeze
locomotion" and §5.12 "without moving geometry"; the bible text itself still reads the old
way, so treat CLAUDE.md as the reconciling document until the bible is revised.

- `recordForgeSnapshot` now accepts adjustments after the disguise manifests, during
  InspectionIntro/Inspection/FinalCountdown. Locking, Reveal and Results still refuse:
  Locking is the moment everything settles, and after the reveal the round is over.
- Every post-lock update is validated: monotonic revision, `maxForgeCommandHz` rate cap,
  full pose decode, creep distance against `hiderCreepSpeed` (new setting, 0.6 m/s,
  measured between consecutive poses), and `SpatialValidator.canOccupy` for where the new
  root actually is. Rejections are typed (`moved_too_fast`, `outside_play_volume`,
  `rate_limited`, `invalid_pose`, `stale_revision`).
- `recordForgeSnapshot` returns a `CommandResult` rather than a boolean, so a rejection can
  be reported to its author and accepted updates carry their events.
- New public events: `disguise_updated { publicObjectId, revision, moved }` and
  `taunt_performed { publicObjectId, tauntId, seed }`. Geometry travels in public state,
  not in the event, which would repeat kilobytes per tick.
- New command `taunt { tauntId }` for a live disguised Mimic during the hunt, one per
  5 s per player. The object performs it, never the player, so anonymity survives.
- Scoring adds two hider terms: 40 per taunt performed while an Inspector was actually
  watching (capped at 5, gated on `canObserve`), and 2 per second spent inside an
  Inspector's focus while unresolved (capped at 200 points). Held time is banked when a
  hold ends rather than sampled per tick, so it does not depend on tick rate.
- Snapshot/restore carries all of it: taunt cooldowns, forge-rate clocks, line-of-sight
  accumulators, and each disguise's root position and last-moved time, so a migration
  cannot reset the creep clock or grant a second taunt.

### Round-orchestration and HUD surface (sim)

Filled the API gaps the round-orchestration builder reported:

- `PlayerResult.publicObjectId` names each hider's disguise. Results exist only after the
  reveal, so this costs no anonymity.
- `PublicMatchState.warrantsTotal` reports the round's allowance next to what remains, so a
  mid-round joiner can render spent rounds. Cleared with the round.
- `PublicPlayerView.seatId` publishes the key the transport seated the player with. Who is
  in the room is public; **which disguise they wear is not**, and that seal is tested: no
  public disguise field names a seat or a public player id, and no seat id appears in any
  event. Routing keeps events clean, so only the roster view carries seats.
- `accusation_resolved` carries `reactionId` on a wrong accusation, alongside the
  `innocent_reaction` event that still drives world presentation.
- `DisguiseOwnership` entries carry `survivalSeconds`, so the reveal can show how long each
  disguise lasted, for survivors as well as the caught.
- `PrivateMatchState.roleState` separates `unassigned` (lobby, no round dealt) from
  `spectator` (sitting out a live round). Derived from role and phase, so nothing new is
  stored and it needs no snapshot support.
- `PrivateMatchState.tauntReadyAtMs` mirrors `accusationReadyAt` so clients stop
  shadow-counting the cooldown.
- **Being-watched signal (§5.12 tension indicator).** While an Inspector holds a hider's
  disguise in focus and `canObserve` agrees, that hider alone receives a private
  `watched { level: 0 | 1 | 2 }` event and a matching `PrivateMatchState.watchedLevel`.
  It carries no Inspector identity and no distance. Deliveries are throttled to one per
  500 ms per hider, deliberately: a faster signal would let a hider triangulate an
  Inspector by watching their own indicator flicker. Level 2 is the default when focused,
  since a focus hold already means the reticle is on the object; a geometry-aware validator
  downgrades to 1 via the new optional `SpatialDecision.level` when the object is in the
  cone but beyond the focus distance. Throttle state is snapshotted, so a migration neither
  re-fires the signal nor resets the window.
- `round` is documented as zero-based, incrementing on rematch; a display counting from one
  prints `round + 1`.

Deferred at the lead's direction: per-category vote tallies, client firing-range echo,
batch boundaries, and server-time echo, all transport concerns.

### Body paint and the missed-finds board (sim)

**Paint** rides beside the pose, never inside it. `DisguiseRecord.encodedPaint` is
validated by `decodePaintLayerWire` from shared, carries its own monotonic revision, and
is exposed publicly because paint is what the object looks like. `recordPaintUpdate`
accepts during Forge and the live-hider phases, refuses when caught, ghosted or out of
phase, and **shares one command budget with pose updates**, so alternating the two cannot
buy double the rate. `disguise_updated` gained `painted` alongside `moved`. Lock captures
whatever the Forge produced; snapshots carry paint and pose-omitted snapshots rehydrate it
from public state, throwing if a painted layer cannot be supplied.
`LIMITS.encodedPaintLength` is **derived** from `PAINT_WIRE_MAX_BASE64_LENGTH` rather than
written out, so builder-paint's ceiling changes flow through automatically — that already
paid off once when strokes gained metallic and smoothness mid-integration.

**The missed-finds board** (docs/MECCHA_RESEARCH.md) publishes
`missed_finds_update { entries: [{ displayName, publicPlayerId, points }], nextUpdateAtMs,
final }` on a jittered ~20 s cycle during the hunt, plus one exact board at the reveal.
Deception points are the settled part of §6.2: watched seconds, direct-look escapes,
observed taunts and close passes, excluding survival which is not yet earned. Watched time
from an open focus hold is projected into the figure without banking it, so a hider under a
steady stare sees their number climb.

Anonymity: entries name players, never disguises, and naming hiders leaks nothing because
"not an Inspector and not a spectator" already implied "hider". Mid-round figures are
floored into buckets of 25 and the cycle is jittered by up to 3 s from the seeded RNG.
**The residual risk is real and accepted, not solved:** every component of the score is
caused by the Inspector's own actions, so a patient Inspector who stares at one object and
watches which name moves can still correlate. Bucketing blunts the inference — two stares
of four and ten seconds publish the identical figure — and the jitter breaks a metronome
cadence, but neither removes attribution. Closing it properly would mean withholding the
mid-round board from Inspectors, which is a design call, not a sim fix.

Deferred, with reasons:

- Real range and line-of-sight validation stays permissive behind `SpatialValidator`
  until the map exists (Phase 3). Target *existence* is enforced now.
- Camera validation (§28.5) awaits Phase 4.
- Wire byte and rate caps beyond the pose payload belong to the transport layer.
- Anchors are validated structurally; that they reference legal map surfaces (§7.16)
  needs the map.

## Verification state (2026-08-01 19:55, full working tree)

- typecheck: clean across all 5 workspace projects.
- tests: all passing — apps/client 367 tests in 31 files, plus shared, game-sim
  (including new paint.test.ts and missedFinds.test.ts), and server suites.
- build: `vite build` green, 156 modules, 1.34 MB bundle (383 KB gzip).

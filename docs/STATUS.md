# STATUS

## Two connections of one account are two players (2026-08-02)

**The gap this closes**, found by running the real Portals editor's two-player
preview. Both panes joined the same relay session and the whole stack worked
live — join, relay, host election, refusal feedback — and then the host turned
the second pane away with `refused connection f8Jsa_Ble: duplicate_session`.
Both panes carry the same Portals account, `PortalsNetAdapter` seated by the
stable `playerId`, and a second connection of a seated account was refused by
design (§31.3). The result was a 1-seat lobby in each pane: **the only tool that
can test this game's multiplayer could not produce a second player.** The same
rule also refused a real player's phone while their laptop was in the room.

**A second live connection now takes a seat of its own.** The account id is
still a seat, and it is still the first connection's; a second connection made
while the first is alive gets `derivedSeatId`, which is the account id with its
own connection id appended. To the simulation that is simply another player,
with its own role, disguise, private queue and anonymity, which is what makes a
one-account preview a real two-player round. The reconnect is untouched: a seat
is only *taken* by a live connection, so once the old one is gone the account id
is free and the returning connection claims it, lands back in its role and
disguise inside the grace, and is seated fresh after it (§27.9).

**The seat is decided once per connection and then never moves.** This is the
load-bearing part rather than a tidiness preference. `indexSeats` used to rebuild
the whole map from the current roster every time it ran, which under the new
policy would hand the duplicate its neighbour's seat the instant that neighbour
left — a player silently inheriting someone else's round, role and disguise
included. It now prunes departed connections and assigns only new ones. A test
drops the connection holding the account id and asserts the duplicate keeps its
own seat while the returning connection reclaims the account id; **with the old
rebuild in place that test fails on exactly that promotion**, which is how it was
checked rather than assumed.

**Every client has to reach the same answer, or the room splits in silence.**
Seats are how this protocol addresses: a client sends commands `to` the host's
seat and the host answers `to` the sender's, and each end drops anything
addressed to a seat it does not think is its own. Two clients disagreeing about
which of a pair holds the account id means both are addressed wrongly and simply
receive nothing, with no error anywhere. A client that was present when the pair
arrived is right by construction. One that joins later is settled by the
published roster, and **no wire change was needed to do it**: a derived seat
names the connection that owns it, so seeing it among the `seatId`s the host
already publishes in `publicState.players` identifies its holder outright and
leaves the account id for the other. Where there is no publication yet, the
relay's player list is taken in order. The test for this reverses the list the
fake relay hands out, because the SDK promises no ordering and a rule that reads
arrival order out of it is guessing; with the published-roster rule removed the
late joiner reads the pair backwards and the test fails.

**The residual window is one snapshot interval**, between a duplicate arriving
and the next publication naming it, during which a third client joining relies
on list order alone. It is stated rather than closed.

**A derived seat is bounded and cannot collide.** `LIMITS.idLength` is 64 and
every schema carrying a seat applies it, so the connection id is kept whole and
the account id is trimmed to fit: the connection id is what makes the seat
unique, and no two live connections share one, whereas trimming the other way
would collide two accounts whose ids share a prefix. A second seat's display
name gains a numeral, counted over the account's connection ids rather than over
the seats handed out so far, so every client prints the same one.

**The refusal is kept as a guard, not a policy.** `seatArrival` still refuses
`duplicate_session` if two live connections ever land on one seat, which seat
assignment is supposed to make impossible. Reaching it means the relay
contradicted itself, and turning the newcomer away is better than letting it
into somebody else's role.

**One automatic retry on a failed join.** The first join of a session in the
editor can time out while still registering internally, after which every
further attempt is refused with "a multiplayer session is already active".
Leaving before reporting the failure was already committed; the join now tries
once more after that cleanup, so the editor's slow first arming never reaches
the player. One retry and not a loop, because a relay refusing twice is refusing
for a reason retrying cannot fix. The fake relay models the half-registered
session rather than a plain rejection, so the test proves the cleanup is what
makes the second attempt succeed.

**Verified.** `pnpm -r typecheck` clean across five projects, `pnpm -r test`
green (643 client over 61 files, 161 game-sim, 47 shared, 23 server), and
`vite build` green at 242 modules, 1.70 MB / 481 KB gzip, to a scratch
`--outDir`. Six new cases in `tests/networking/portalsNet.test.ts`: a second
connection seated with a distinct seat and both in every client's roster, its
commands and refusals routed to it alone, a late joiner agreeing with the room
under a reversed player list, the drop-and-return seat bookkeeping above, a
derived seat carrying its role and disguise through a change of host, and the
two join-retry paths. **Three of them were confirmed to fail with the mechanism
they cover removed** — the published-roster rule, seat stickiness, and the retry
— so none of them passes by accident.

Worth knowing for whoever runs the suite next: mid-way through this work the
`shared` typecheck, two `paintWire` tests and the `client` typecheck were all
failing inside the paint emissive-channel work another agent was landing at the
same time. Those cleared on their own once that agent finished, and the figures
above are from runs after it. Nothing here touches a paint or shared file.

**Not verified: none of this was run inside Portals.** Whether the editor's two
panes now produce a two-player lobby is exactly the question the next live test
should ask, and it is the reason this change exists.

## Movement has weight: acceleration, a jump arc, and a body that carries itself (2026-08-02)

**The gap this closes.** Every mechanic was already in place — run, creep, climb,
hop, the shared `CharacterController` both roles walk with — and all of it moved
like a cursor. Velocity was set from the keys each frame, so the body reached
full speed on frame one and stopped dead on the frame the key came up. The jump
was a symmetric parabola with no hang and no impact. The creature itself never
reacted to any of it: the shell was carried along rigidly, and the Forge camera
was welded to the root.

**Acceleration lives under the caps, never through them.** One rule in
`moveHorizontally` steers the horizontal velocity toward what the keys ask for at
`cap / GROUND_ACCELERATION_SECONDS` (0.18 s up, 0.09 s back to rest, both quoted
as times rather than accelerations so a creep ramps as gently as it moves). The
same rule is the turn smoothing, because a change of direction is a change of
velocity: reversing now passes through a standstill instead of teleporting the
sign. **The cap semantics are unchanged** — the velocity is clamped to the
`speedFor` result every frame, so it only ever moves *slower* than the number the
authority validates against, and `hiderCreep.test.ts` still passes untouched.
Air control is `AIR_CONTROL_SCALE` 0.6 of the ground rate with **no air braking
at all**, so a hop holds the momentum it left with.

**The jump arc got a hang and a landing, and the apex did not move.** Gravity is
scaled 0.9 rising and 1.15 falling. `JUMP_SPEED` is derived from the *rising*
scale, so the body still tops out at exactly `JUMP_HEIGHT_M` and the invariant
`jump.test.ts` guards — that a hop reaches nothing in the Curiosity Shop that can
be stood on, the steel rack's bottom board at 0.26 m included — is untouched;
what changed is the time spent up there. Coyote time (80 ms) answers a jump
pressed just after the feet leave an edge, and a 100 ms buffer answers one made
just before they touch down. Consuming a jump spends both, so neither stacks into
a second launch. The controller now reports `justLanded` and `landingSpeed`, and
those are the seam the compression and the camera dip hang off.

**Body language is a transform, never an edit.** `forge/BodyLanguage.ts` is a
deterministic set of critically damped springs producing three numbers — lean
into travel, bank into a turn plus a gait sway, and a dip — which `ForgeController`
lays over the authored pose by rotating `MimicVisual.root` **about the body's own
root**. Nothing touches `this.pose` or `this.state`, so `disguise` is
byte-identical for a body mid-stride and a body standing still at the same root.
`movementFeel.test.ts` asserts exactly that, and asserts the rendered transform is
genuinely non-identity at the same moment, so the test cannot pass by the
cosmetic having quietly stopped working.

Three details in that layer are load-bearing rather than decorative:

- **Rotation about the root moves no part of the root.** Of the three channels
  only the dip changes where the creature stands, and the dip is snapped onto its
  rest value once the spring has arrived, so "returns to exactly the authored
  height" is a claim a test can make with `toBe(0)` rather than `toBeCloseTo`.
- **A locked disguise gets none of it.** An anonymized object that breathes on
  the shelf tells an Inspector which of the six vases is a player, which is a
  worse giveaway than any pose mistake the Forge could make. The same suppression
  covers a body being authored, so a handle is always dragged against the pose.
- **Only the Mimic carries the transform, not the handle group.** That group
  holds three different coordinate spaces at once: pose grips on the body, seal
  markers on the *map surfaces* a disguise is anchored to, and panel tips already
  read through the Mimic's own matrix. Transforming the group leaned the seals
  off their shelves and double-applied the lean to the tips. `layoutHandles` now
  carries the posture onto the pose grips one at a time instead, and the test
  asserts the head's grip sits exactly on the head.

**The Forge camera chases rather than being welded.** A `cameraTarget` closes all
but a twentieth of its gap to the orbit point in 0.16 s and snaps once inside a
tenth of a millimetre, so a settled shot is exactly the shot the player left. The
orbit *angle* and zoom are still instant — only the point being orbited lags. The
walk bob reuses `InspectorCamera`'s own `BOB_AMPLITUDE_M` and `BOB_RATE_RAD_PER_M`
rather than restating them, and the landing dip echoes the body's own compression
at 0.55 of it. The Inspector's rig got the landing dip too, on the **boom pivot
and not the eye**: every gameplay distance is measured from the eye, and camera
feel may never change what the Inspector can reach (§8.5).

**The footstep seam was left alone deliberately.** `gameplay/footsteps.ts`
(builder-audio's) already switches on grounded/creeping/climbing and counts
footfalls by distance, which is exactly right under a ramping speed — the cadence
now eases in for free. Three tests were added against it rather than any change
to it, so the signature builder-audio is wiring stays stable.

**One bug fixed that was not on the list.** `HiderLocomotion` ended the walk on
the first frame after the keys came up, which under the new deceleration would
have cut the stop off and dropped the body on the spot. It now holds the walk
open until the controller has actually reached zero.

**Tests changed, and why.** Five existing assertions encoded instant velocity and
had to move: three measured a distance over a fixed window from a standing start
(now measured after the ramp, which is what "the cap" means), and two asserted
the body stops on the release frame (now: it coasts under a body length and then
stays put, with the no-drift claim intact). `forgeView`'s camera-framing test now
settles the shot before measuring it, and gained a sibling asserting the trail
exists mid-run. All are the same claims re-expressed; none were weakened to pass.

**Addendum: a host who was a Mimic could not be shot.** Found by the Portals-net
builder and fixed here because it lands in the same files. `RoundSession` omits
the viewer's own disguise from `DisguiseTheatre` while the Forge draws it, and
override 2 keeps a hider's Forge open for the whole hunt. `DisguiseTheatre.sync`
*deletes* an omitted actor, so `boundsOf` returned null for the local player's
own body, and `SpatialValidatorImpl` refuses a target with no bounds as
`target_bounds_unknown`. The owner was the one player in the room who could not
be hit — and on Portals the authority runs on an elected client, so a host who
drew Mimic was immune for as long as they held it.

`RoundSpatialBridge` now takes a second disguise source, `setOwnDisguiseBounds`,
fed from `ForgeController.bodyBounds`. The two sources are **exact complements
rather than alternatives**: `RoundSession` derives the theatre's `omit` and the
bridge's answer from one stored `omittedObjectId`, so at most one of them ever
knows about a given disguise and there is no body neither describes.

`bodyBounds` is measured with the body language switched off and cached against
the disguise revision — the same isolation rule as the wire pose, for the same
reason. A box that leaned with the run would make its owner shootable somewhere
no other client believes they are, which is the wire-pose failure in a place no
wire format would catch. Two tests: `gameplay/ownDisguiseBounds.test.ts` drives a
real round where the seed deals the local player a Mimic, reproduces the old
failure in the same test (a theatre told to omit returns null), asserts the
bridge answers anyway with a box matching what a remote theatre computes from the
published pose, and asserts `canAccuse` now returns `{ ok: true }` for an
Inspector standing over it. `forge/movementFeel.test.ts` asserts a leaning body's
bounds equal a peer's box for the disguise it is currently wearing. **Both were
confirmed to fail with the second source removed**, so they are not passing by
accident.

**Not done.** Peers and bots see no body language at all — it lives in
`ForgeController`, which owns the player's own body, and `DisguiseTheatre`'s
bodies are the authored pose by design. Giving peers a lean would mean deriving
it from accepted root deltas on the receiving side, which is a separate piece of
work and is the honest place to put it.

**Verified.** `pnpm -r typecheck` clean across five projects; `pnpm -r test`
green (client 60 files / 634 tests, shared 46, game-sim 161, server 23);
`vite build` green at 242 modules, 1.69 MB / 479 KB gzip. Worth knowing for the
next session: the first build attempt died with `EPERM` clearing
`apps/client/dist/assets`, which is Dropbox holding the folder open on this
machine rather than anything in the bundle. It cleared on its own; a scratch
`--outDir` gets past it if it does not.

## The shop has a voice: full soundscape, twelve beds and forty-eight one-shots (2026-08-02)

**The gap this closes.** The game shipped eighteen SFX and no ambience at all.
Every footfall in the shop was the same wood sample, nothing played between
events, and the seven `ambienceId` beds already authored on the map zones in
`world/maps/zones.ts` had never had a file behind them. The bundle now carries
**48 one-shots and 12 seamless ambience beds, 3.3 MB of a 4.9 MB build**, and
the room is audible whether or not anything is happening in it.

**The beds are generated as real loops, not faded clips.** ElevenLabs
`eleven_text_to_sound_v2` takes a `loop` flag that makes the material meet
itself at the seam; the older model does not. Beds are cut at `mp3_44100_64`
and one-shots stay at 128, which is why twelve thirty-second loops cost less
than a megabyte more than the whole SFX set. The generator is still
`packages/content-tools`, now with `--kind=` and `--only=` filters so a single
prompt can be re-rolled without spending the whole set again.

**An MP3 cannot be looped by `HTMLMediaElement` without a hole in it.** The
files are seamless but the container is not: encoder padding at both ends puts
a short gap in a room tone every thirty seconds, which is exactly the kind of
fault a player hears without being able to name. `ElementBedVoice` runs two
elements of the same file half a second apart and crossfades the join, so
something is always mid-file and the seam never arrives. WebAudio would be the
usual answer and was rejected deliberately: it needs `fetch` plus
`decodeAudioData`, the Portals sandbox blocks fetch, and `new Audio(url)` is
the one asset path this bundle has already proven works.

**Four channels, not one mix.** `AmbienceController` holds the base shop tone,
the zone bed, the phase bed and the tension bed at once, and each crossfades
within itself, so walking from the clock wall to the reading nook exchanges one
zone bed without disturbing the heartbeat. Zone routing reads `ambienceId`
straight off the map rather than restating it, and a zone naming a bed that was
never generated throws at load instead of falling silent in one corner of the
shop. Stingers duck all four channels, which recover over 900 ms. The
heartbeat follows `RoundViewState.self.watchedLevel` and is forced off outside
the hunt, so a watched level left over from the round just ended cannot beat
under the results screen.

**Footsteps know what they are standing on.** `FootstepDriver` picks from four
materials with three variations each, by distance travelled rather than by
clock, so the cadence follows the speed without anything having to be told the
speed. The map publishes no material field, so the few surfaces that are not
wood are named in `footsteps.ts` and everything else falls through to wood: the
nook floor and its upholstery are rug, the workshop rack boards are metal, and
the glazed cabinet and marble counter are glass. Both roles drive it. The
Inspector walks; a hider under the hunt's creep cap scrapes instead of
striding, because a disguise audibly crossing the shop would give itself away
for a reason its owner never chose.

**Known, and deliberate.** `wallstick_attach` and `wallstick_release` are
generated and unwired: wall-stick exists in the CLAUDE.md overrides and nowhere
in the code, so the clips are ready for the mechanic rather than pretending it
is done. `setMasterVolume` is exported and called by nothing but tests; it is
the seam a volume control plugs into, and `getMasterVolume` is genuinely
consumed by every channel every frame. The reading-nook rug is a zone-wide
approximation of a prop-sized rug.

**Verified.** 33 new tests: bundle-to-union parity in both directions behind a
compile-time mirror of the `SoundId` union, the four-channel fade state machine
driven frame by frame with a stub voice, and footstep cadence and material
lookup. `pnpm -r typecheck` clean, 615 client / 161 game-sim / 46 shared / 23
server tests green, `vite build` green, and all 60 files present in `dist`.

## A disguise costs four draw calls, not forty (2026-08-02)

**The gap this closes.** The hunt collapsed to 0-1 fps when four disguise
bodies joined the scene. Shader compiles were refuted as the cause, and the
measured load was draw calls: a Mimic is about forty drawn meshes, so four
bodies added 160 to a shop already submitting around 293. `MergedMimicBody`
collapses each theatre body to **one mesh per material, which is four**:
porcelain shells, casting bellows, the non-casting eye shutter, and the eyes.
Four bodies are now 16 draws rather than 160. A **painted** body is the larger
win and was worse than the brief assumed: unmerged, paint gives every part a
clone of its material carrying a view of that part's atlas tile, so a painted
disguise was 27 materials and 27 draws. Merged it is four of each.

**Only the theatre's bodies are merged.** The player's own Forge body is
untouched: it is picked per part, recoloured per part, and dragged by handles.
A disguise is none of those things. It is shot through its focus proxy's bounds
and the reticle picks analytically against a box (`FocusSystem.pick`,
`RoundSpatialBridge.boundsOf`), never against a mesh, so its parts only have to
be drawn, and they can be drawn together.

**The parts stay in the graph, hidden, rather than being taken out of it.**
They are what the pose is applied to, what the merge reads, and what
`Box3.setFromObject` measures. `Box3` ignores visibility while the renderer
skips a hidden subtree in one test (`Renderer._projectObject` returns on
`visible === false`), so a merged disguise publishes a focus box that is
*identical*, not approximate, to an unmerged one. That box is the accusation
hitbox, so identical is the requirement; `mergedBody.test.ts` asserts it with
`Box3.equals` against a freshly built `MimicVisual` across four arrangements
and again with a panel deployed.

**Every part of a Mimic moves with its bone**, so there is no static half to
bake once and articulating half to leave live. The merge bakes each part's
pose-space transform into vertices and re-bakes whenever the pose changes,
writing into buffers that are reallocated only when the *set* of parts changes:
a panel deploying, a swatch changing, a shadow setting changing. A move never
reallocates and never allocates at all. Re-baking one body's ~12,900 vertices
measures **p50 0.29 ms, p90 0.65 ms** headless once V8 has warmed (the first
four passes are 3-14 ms and are warmup, not the cost the hunt pays). Four
hiders creeping at the 500 ms publish interval is about 2.4 ms a second.

**Paint needed the atlas tile moved out of the material and into the
vertices.** Every part publishes the same 0..1 UV square, so the atlas gives
each its own tile and the unmerged path reaches it through the tile view's
`offset` and `repeat`, which three folds into the sampled coordinate as
`u * repeat + offset`. The merge folds exactly that into the coordinates
instead, so one merged mesh wears the whole atlas and samples the same texels.
A group is keyed on paintability as well as material, so a merged mesh can
never mix a part that owns a tile with one that does not.

**A hidden part is still raycast**, which was a real regression caught in
review rather than by a test that existed. `Raycaster` tests layers and ignores
visibility, the Forge's eyedropper reads the room, and a peer's disguise is a
fair thing to copy a colour from. A part and the merged mesh drawn over it are
the same surface at the same distance, so the dropper would have taken the
swatch from under the paint about half the time. The parts therefore move to a
layer nothing renders or picks on, and a test aims a ray down a merged
triangle's own normal and asserts every hit belongs to the merge.

**Noticed, not fixed, and outside this change:** `ForgeController` captures
`roomObjects` as the scene's children at construction, which is after the
theatre has parked its prewarmed bodies, so `indexAnchorSurfaces` indexes Mimic
part names (`mimic_torso_upper` and the rest) as anchorable surfaces. A saved
anchor naming one would resolve against a parked body. Merging does not change
this either way.

### Verified

`pnpm -r typecheck` green, `npx vite build` green, and 199 tests across
`tests/gameplay`, `tests/mimic` and `tests/paint` pass, including twelve new
ones in `tests/gameplay/mergedBody.test.ts` and the existing theatre, hunt
presentation and paint cases unchanged. **`pnpm -r test` is not green at the
time of writing:** six tests fail in `tests/forge/hiderLocomotion.test.ts`,
`tests/forge/forgeView.test.ts` and `tests/inspector/controller.test.ts`, all
of them downstream of `src/inspector/CharacterController.ts`, which the
concurrent movement work was editing. None of them touch the theatre, the
merge, the Mimic visual or paint.

New tests: draw count at or under six against a part count of forty with the
triangle count preserved exactly; the merged surface's precise vertex box
against the parts'; the focus box against an unmerged reference; a deploying
panel entering both the merge and the box; a creep moving the drawn geometry by
the distance it travelled; a taunt carrying the merged meshes; paint drawn
without a call per part; every merged UV inside a tile the body owns with all
21 painted parts represented; paint coming off cleanly; a picking ray answered
by the merge alone; and sixty re-poses that reuse the same geometry and
material objects.

## The game is playable with other people (2026-08-02)

**The gap this closes.** `PortalsNetAdapter` was finished, tested at 37 cases, and
mounted by nothing: `App.tsx` only ever called `createLocalRound`, so every round
the shipping build could open was this tab against three bots. The headline
feature was code nobody could reach.

### Detecting where the game is running

`networking/portalsBoot.ts` answers one question at boot: is this page inside a
Portals room. It reads `window.Portals` first, because a hosted bundle is served
with the SDK tag already injected, and falls back to importing
`_portals/sdk.js` from wherever the document itself lives — `@vite-ignore` and a
`document.baseURI` URL, so the build never tries to resolve a path that exists on
no developer's disk. Everything that can fail there means the same thing, so it
all resolves to null and the game plays offline: no file, a 404 page served as a
module, a `Portals` global belonging to something else, a `ready()` that rejects,
and a `ready()` that never settles at all, which is capped at
`PORTALS_READY_TIMEOUT_MS`. The probe runs beside the WebGL backend probe rather
than after it, so it costs the boot nothing.

`context === "room"` takes the multiplayer path. **A standalone game page takes
the offline one**, even though `Portals.net` is reachable there, because on the
game's own page there is nobody in particular to be joined to.

### The round is the same round

`gameplay/portalsRound.ts` is `localRound.ts`'s sibling and assembles the same
three pieces, because `GameHost.enterRoundMode`, `RoundDirector` and
`RoundSession` all read `NetworkAdapter` and nothing narrower. That was checked
rather than assumed: `createLocalRound` was the only reference to
`LocalLoopbackAdapter` outside the adapter itself. What differs is only where the
simulation runs, and the shell's own branch is four lines choosing a round, a
channel and a name before a shared path takes over.

The relay's **default bucket** is used rather than a named channel: a Portals
room already is the session, and naming a channel inside one would split the
people in a single room into sub-lobbies that cannot see each other.

### Three things the host was missing

The adapter elects a host to run the simulation, and that host needs the same
inputs the loopback's simulation gets. It was being given one of them.

**The map.** `PortalsAdapterOptions` had no `objectRegistry`, so an elected host
built `MatchSimulation` on its five-prop test fixture. Every warrant an Inspector
spent on any of the Curiosity Shop's 104 accusable props would have come back
`target_unknown` (`MatchSimulation.commandAccuse`). It is now passed on
construction **and** through `MatchSimulation.restore`, where it matters twice
over: a snapshot records the map it belongs to and restore refuses one whose
registry disagrees, so without it a migration would either resume a round about a
different room or fail outright.

**The Inspector's eye.** `RoundSession` writes the camera into the local spatial
bridge every frame, which is sufficient on the loopback because there the
Inspector *is* the authority. Over the relay the Inspector is usually not the
host, and the host's validator had never heard of them, so
`SpatialValidatorImpl.check` refused every shot with `inspector_position_unknown`.
**There was no envelope in the protocol that could carry it**, so one was added:
`t: "eye"`, addressed to the host, nullable so an Inspector who stops being one is
forgotten rather than remembered where they last stood. It is client-reported,
which is the authority model Portals gives us; the host still decides what may be
shot from it. `RoundSpatialBridge` gained an observer on its local writes and a
separate `acceptInspectorEye` for what arrives from the wire, so a host applying a
remote report cannot relay it onward under its own name. Cost is capped at one
message per 100 ms flush and skipped entirely while the eye has moved less than
`EYE_REPORT_EPSILON_M`, so an Inspector standing still sends **one** message for
the whole second (measured). A change of host clears the record of what was
already sent, because the new one has never heard it.

**Disguise bounds** were already right: `RoundSession` wires `setDisguiseBounds`
from its own `DisguiseTheatre` in its constructor, and every client runs a
theatre, so whoever is promoted is already holding them.

### Verified

`pnpm -r typecheck` clean, `npx vite build` green, `pnpm -r test` green
(571 client, 161 sim, 46 shared, 23 server) — excepting
`tests/gameplay/mergedBody.test.ts`, which was being rewritten by the draw-call
merge work while this ran and passes on its own.

Eleven new tests. `tests/gameplay/portalsRound.test.ts` drives two clients
through the shipping `createPortalsRound` over the fake relay: both seated with
one host elected, only the host offered the start control, the phase machine
reaching the Forge for both, a locked disguise arriving at the far client **with
its geometry**, and an accusation fired from the non-host machine catching the
Mimic. Its companion writes the eye straight into the local validator, which is
exactly what the round did before this pass, and asserts the same shot resolves
nothing at all — so the first test is proving a live channel rather than a dead
one. The fixture throws if the deal ever puts the gun on the host seat, because
these cases would then pass while proving nothing.
`tests/networking/portalsBoot.test.ts` covers the six ways the probe can end, of
which five are the offline fallback.

**Not verified: none of this was run inside Portals.** No real SDK was loaded, no
real relay carried a message, and whether Portals injects the SDK tag or expects
the game to import the file is a question only the editor can answer — the probe
handles both, which is why it is written that way.

### Two findings this pass did not fix

**A host who is a Mimic cannot be shot.** `RoundSession.update` omits the
viewer's own disguise from its theatre while the Forge is drawing it, and per
override 2 a hider's Forge stays open for the whole hunt. `DisguiseTheatre.sync`
deletes an omitted actor, so `boundsOf` returns null for it, so that client's
validator answers `target_bounds_unknown`. On the loopback the authority is always
the local player, so this is the same hole and it has simply never been
reachable: a solo round's Inspector is a bot shooting bot disguises. On Portals it
means whichever client is elected host is immune for as long as it holds
authority. The fix belongs where the Forge's own body is: the bridge needs a
second bounds source for the viewer's own disguise rather than falling through to
the theatre that deliberately does not have it.

**Bots cannot fill a Portals room.** `LocalLoopbackOptions` has `botPose` and
`botBrain`; `PortalsAdapterOptions` has no equivalent and the host's simulation
has no hook to add one, so a room below `minPlayers` (2) simply cannot start.
Nothing was forced here. Adding it means seating bots as real players in the
host's simulation and driving them from the host's tick, which is a change to the
adapter's seat bookkeeping rather than a wiring job.

## Jump is in, and the left button is the camera (2026-08-02)

Two user directives, one of them a reversal. CLAUDE.md overrides 5 and 6 carry
them: **space jumps**, which retires the "no jump, ever" rule the whole movement
layer was written under, and **WASD moves while a left-click hold turns the
camera**. The walking work in the section below landed hours earlier under the
old rule, so parts of it are amended here rather than left standing.

### The hop, and why it is small

`JUMP_HEIGHT_M` in `packages/shared/src/config.ts` is 0.45 body heights, 0.158 m,
beside the run and creep speeds. `CharacterController` derives the takeoff speed
from it and the room's own gravity, so the authored number is the height and the
physics delivers it. Both roles jump: it is one shared controller, so the
Inspector got it for the price of adding `Space` to `InspectorInput`.

**The ceiling on that number is not the one it looks like.** The intent is that a
hop clears clutter and gaps while the authored climb links keep their monopoly on
getting up onto things, so the hop must not reach the lowest thing in the shop
that can be stood on. That is not the 0.34 m window deck but the **bottom board
of the steel rack at 0.26 m**, which the first attempt at 0.55 body heights would
have mounted: it reached 0.2625 m with the step lip added, against a 0.26 m
board. Nine twentieths reaches 0.228 m and leaves 3 cm. `jump.test.ts` derives
the bound from `WALKABLE_SURFACES` rather than from that sentence, so retuning
either the hop or the map fails loudly.

Worth knowing: **no blocker in the Curiosity Shop is currently low enough to hop
over.** The furniture all stands taller than a hop's reach, so in this map the
jump is feel and gap-crossing rather than a route past anything. The test that
proves a hop clears an obstacle a walk cannot builds its own kerb for that
reason, and says so.

The discrete arc undershoots the analytic one, because the controller decrements
velocity before it integrates: at 60 Hz the apex lands about 1.5 cm short of the
authored height, and always short rather than sometimes over. That is the safe
direction, since the "cannot mount" bound is computed from the authored height.

### Making a hop legal during the hunt

A hop is root motion and the authority measures root motion in three dimensions
against `hiderCreepSpeed`, which buys 8.75 cm over a publication interval against
an apex of 15.8 cm. Two things keep it accepted, and both are load-bearing:

1. **A surface-locked hop lands on the height it took off from**, not on whatever
   `surfaceAt` reports underneath. A locked disguise sits where the Forge posed
   it, which is rarely exactly a surface top, so landing "on the ground" would
   spend creep budget the hop never earned. `resolveHop` is that rule.
2. **The round does not publish a pose while the body is off the ground.**
   `ForgeController.bodyAirborne` reports it and `RoundSession.publishPose`
   holds, letting the interval keep running so the pose goes out on landing. An
   airborne pose is a moment rather than a place.

Both are covered by a test that does the opposite and asserts the refusal, so
neither is decorative. Writing the second of those found a flaw in the test
fixture rather than in the code: at the 100 ms frames the creep tests were
stepping, a hop's arc is so under-sampled that its apex fits inside the creep
budget by accident and the mid-air publication was accepted. The fixture runs at
50 Hz now, which is the rate the claim is actually about.

### Space had a job already

The Forge held the §7.5 Inspector-eyeline preview on space. A key cannot be both
a movement verb and a camera hold, so **the eyeline preview moved to E** — next
to the walk keys, and the letter its own name starts with. This is a user-visible
rebinding the directives did not ask for and the jump forced; it is called out
here and on the control strip rather than left for a player to discover.

### The left button

Already the behaviour, as it turns out: `beginLeftPress` reports whether the
active tool consumed the press and an unconsumed one goes to the camera, so a
hold on a handle poses and a hold anywhere else orbits. What was wrong was the
HUD, which advertised the left button as "Drag a handle" and put orbit on the
right. The strip now prints the left button twice, once as "Look around" and once
as "On a handle: pose", because that is what it does. Right-drag orbit and
shift-drag pan are untouched.

**It is asserted rather than assumed.** Adding a second way to move the body is
exactly the change that could have quietly taken the left button away from the
camera, so `forgeView.test.ts` now drives the gesture with locomotion live: a
left hold over empty space turns the camera and leaves both the body and the
undo stack alone, a walk carries on through a camera drag rather than being
interrupted by it, and turning the camera turns where the walk keys go, which is
the one behaviour that makes a single non-modal control scheme work.

**Space appears on the control strip, not on the action rail.** The rail is one
chip per verb and the strip is what the role steers with, which is why WASD is on
the strip; a jump is locomotion and belongs beside it. Putting it on the rail
would have crossed the separation those two components were built around.

### Verified

`pnpm -r typecheck`, `pnpm -r test` (582 client, 161 sim, 46 shared, 23 server —
the client total includes other agents' work landing the same night) and
`pnpm -r build` all green. Eighteen new tests in `forge/jump.test.ts`,
`forge/forgeView.test.ts` and
`gameplay/hiderCreep.test.ts`: the apex against the authored height at 60 Hz, a
kerb cleared that stops a walk, the map-derived bound that no walkable surface is
within a hop's reach, a concrete failed attempt on the steel rack's bottom board,
no second launch in mid-air, a surface-locked hop returning to its exact takeoff
height, the creep cap holding with the hop included, and a real round in which a
hider hops repeatedly through the hunt with nothing refused — plus its companion
that publishes mid-air and gets `moved_too_fast` back.

**Not verified: still nothing in a browser.** Nobody has pressed space and
watched the creature hop, and the feel of the hop height is exactly the kind of
judgement only playing it can make. `JUMP_BODY_HEIGHTS` is the one knob, and the
map-derived ceiling on it is 0.19 m.

## A Mimic can walk (2026-08-02)

**Amended by the section above.** This section was written under the "no jump,
ever" rule, which the user reversed the same day. Where it says a Mimic has no
jump, read: a Mimic hops on space, and the climb links are still the only way up
onto furniture. The control strip's key list has also changed.

**The gap this closes**, caught by the user: "how am I supposed to move as the
character to go hide?" The design promises a hider free run and climb during the
Forge and the same abilities creep-capped through the hunt, which is the MECCHA
loop — run about as the creature, find a spot, settle, disguise. What was built
was drag-only. The body was repositioned by hauling its root handle across the
room with the pointer, and `huntControls.ts` said in so many words that a hider
has no walk key.

### One body, two speeds

Everything about how a body moves came out of `InspectorController` into
`inspector/CharacterController.ts` unchanged: the capsule against axis-aligned
nav geometry, the axis-fallback slide, the ground snap and the fall, the
authored climb links, and the absence of a jump. `InspectorController` is now
four lines that hand it `inspectorMoveSpeed` with the §8.1 brisk walk on shift,
so its sixteen tests pass untouched, and `forge/HiderLocomotion.ts` hands it the
Mimic's speed instead. A hider is therefore stopped by the furniture the
Inspector is stopped by, gets up onto the same shelf by the same authored link,
and has no more jump than the Inspector does.

**The Forge run is derived, not written out.** `HIDER_FORGE_RUN_SPEED` in
`packages/shared/src/config.ts` is 3 body lengths a second, 1.05 m/s, beside the
Inspector's 2.6 and 0.91. The Inspector's figure is the Froude number at which a
walker breaks into a run, so it is the top of a walk; a Mimic crossing the shop
to hide is running, carries no gun and is searching for nothing, so it goes a
little faster. It is deliberately **not** a `MatchSettings` field: no authority
reads it, because the Forge phase has no speed rule, and putting it on the wire
would offer a host a number the simulation never checks.

**The hunt cap is applied twice on purpose.** `MatchSimulation.validateCreep`
measures a straight line in three dimensions from the last pose it accepted
against the time since, and refuses anything over `hiderCreepSpeed`.
`RoundSession.driveForge` now tells the Forge the same number for the inspection
phases and null before them, and `HiderLocomotion` caps each frame at it. Capping
per frame is sufficient for the authority's test, since a straight line is never
longer than the path that drew it. This closes the rubber-band this file listed
under "stubbed, unverified or broken": the client used to predict motion the
authority would refuse, and the two copies of the body disagreed until the next
accepted pose.

**A creep keeps its height.** `CharacterController.surfaceLocked` stops gravity,
takes the climb links away, and refuses a step that leaves the surface the body
settled on. That is not a flourish: one frame of falling, or a single snap up a
0.07 m lip, covers more ground than a whole second of creeping is allowed, so a
creep that could change height could not stay inside the cap. A disguise with
nothing underfoot — hanging, or bracketed to a wall — simply does not creep,
rather than being dropped to the floor by its own walk key.

### What walking does to a disguise

Locomotion writes the same root a handle drag writes, and goes out through the
same `recordForgeSnapshot` on the same 500 ms coalescing interval, so the
authority cannot tell a Mimic that walked from a Mimic that was dragged.

**The pose travels with the body**, which was a real bug found by writing the
test for it. The Forge's IK targets are world positions, so a body that walked
away from a posed hand was solved back toward where it had been standing: with
the translation removed, walking 0.7 m moves the head 6.9 cm out of place on a
0.35 m body, and `forgeView.test.ts` fails by exactly that much.

**Walking breaks every seal**, for the same reason. The anchor pass in
`solveAndRefresh` walks the root toward its anchors, so a sealed body that tried
to walk would be hauled straight back to the surface it left. A whole walk is one
undo entry labelled "walk", carrying both where the body went and what it let go
of, and `commitEdits` closes a walk in progress so an undo, a lock or a new
starter arrangement cannot fold a half-finished walk into whatever follows.

**The camera is not a mode.** The Forge's orbit point travels with the body and
its angle, pitch and zoom are left exactly where the player put them, so the
same view both poses and drives: the body moves whenever a walk key is down and
is posed whenever a handle is dragged, with nothing to toggle between them. Keys
steer relative to the camera, and the body is then turned to face where it is
actually travelling, which is what lets a climb link activate when it is walked
into sideways as well as head on.

**The play volume's floor bound is not applied to a walk.** `minY` is 0.02 on
this map, a guard against the pointer shoving a body down through the boards,
and the shop floor is at 0. Clamping a walking body to it lifted the Mimic 2 cm
off the ground and then fought the controller for it every frame, which is what
the first version did: the body took exactly one step and stopped. X, Z and the
ceiling are still clamped, and a walk that hits one of those stops, because a
walkable surface outside the room's own faces would mean the map disagrees with
itself.

`ForgeControllerOptions.navData` is optional and Forge practice passes none, so
the practice room — which publishes no nav data to walk on — is unchanged.

### The HUD

`HIDER_CONTROL_HINTS` leads with W A S D, labelled "Creep", because the strip is
drawn during the hunt. Shift is absent: a creep has one speed. The assertion in
`huntControls.test.ts` that a hider is offered no walk key was the HUD correctly
describing the old behaviour, and it is now the opposite assertion plus a check
that the only key a player might mistake for a jump, Space, still holds the
Inspector-eyeline preview.

### Verified

`pnpm -r typecheck`, `pnpm -r test` (541 client, 161 sim, 46 shared, 23 server)
and `pnpm -r build` all green. Nineteen new tests:

- `forge/hiderLocomotion.test.ts` measures the run against the derived constant,
  climbs the fixture's mantle, runs off the workbench and lands, sweeps eight
  headings from every floor-level Mimic spawn asserting the body is never inside
  a `NAV_BLOCKER` and never off the floors (and that something did stop it, so
  the sweep is not just proving the shop is empty), and holds the creep cap both
  over two seconds and frame by frame in every direction.
- `gameplay/hiderCreep.test.ts` drives a real `LocalLoopbackAdapter` round: the
  local player locks a disguise, creeps for ten seconds publishing at the round's
  own interval, and **nothing is refused**; the room's copy of the body ends
  where the player's is, to the wire's precision. Its companion drives the same
  creep at the Forge run speed and asserts `moved_too_fast` comes back, so the
  first test is proving a live rule rather than a dead one.
- `forge/forgeView.test.ts` covers the seam: the root moves and the revision
  advances, the body stops where the keys were released, one walk is one undo
  that returns it, the camera keeps its framing while following, a locked
  disguise ignores the keys, and the posed-head case above.

**Not verified: none of this was driven in a browser.** The rules are proved
headlessly and the seam is proved through the real `ForgeController` under a
stubbed window, but nobody has held W and watched a Mimic run across the shop.

**Known, and not this change's to fix:** `CharacterController` checks blockers
along a step but not along a fall, so a body that runs off the window deck can
land inside furniture. That is the Inspector's behaviour too and predates this
work; the locomotion sweep test scopes itself to the floor-level spawns and says
so rather than papering over it.

## The round opens across frames, and the hunt's bodies are built before it (2026-08-02)

Answers the round-4 critic findings that "Play a round" freezes the tab for about
a minute with no feedback, and that the hunt collapses to 0-1 fps on both
backends. The first is fixed. The second is **not** fixed here, and the section
below says why the diagnosis it was given does not hold up.

### Clicking "Play a round" no longer stops the tab

`GameHost.enterRoundMode` is asynchronous and reports progress.
`CuriosityShop.buildSteps` is a generator that yields ten times — the shell, one
step per zone, and the batcher's `finalize`, which is where the merged geometry
is actually built — and `ShopWorld.createIncremental` hands each yield to a
callback that paints the loading screen and waits a frame. `ui/LoadingScreen.tsx`
draws the real fraction and names the piece that was just put in.

**The zones are cut out of the authored order rather than grouped into it.**
Build order is the mesh numbering (§24.6) and a saved disguise resolves its
anchor surface by the name the build gave it, so regrouping the props to make
tidier chunks would rename every hero mesh in the shop. `SHOP_PLACEMENTS` is
already written as one contiguous run per zone, so cutting it wherever the zone
changes gives ten labelled steps and touches nothing.
`tests/world/shopBuild.test.ts` re-flattens the runs and asserts the result is
the authored list by identity, which is what fails if anyone sorts it.

**The menu room stays up for the whole load.** It used to be disposed first,
which is why the freeze had nothing behind it. The shop is now built into its own
scene while the menu goes on rendering, and the swap happens once the shop is
ready. Two rooms are alive at once for the length of the load, which the small
menu room can afford.

**The load ends with one real frame drawn under the loading screen.**
`renderer.compileAsync` walks the beauty pass only: shadow pipelines come from
the shadow camera and the post chain from its own passes, and both are otherwise
built by the first frame of play. Paying for one frame while the loading screen
is still up moves that cost somewhere the player is expecting to wait.

`ShopWorld.precompile` turns frustum culling off across the map for the length of
the call. A precompile builds the same render list a frame does, culling
included, so without that only the props in front of the camera would be covered.

A round abandoned while it is opening is caught by a token that `exitRoundMode`
and `dispose` both bump: the build releases the shop it has instead of installing
one nobody asked for, and `enterRoundMode` resolves null.

### The hunt's bodies are built during the load

`DisguiseTheatre.prewarm(4, compile)` builds four Mimic bodies posed with the
fallback arrangement, parks them 20 m below the boards with culling off and every
panel plate forced visible, hands them to the precompile, and then hides them in
a reserve. `createActor` takes from that reserve, so the transition into the hunt
re-poses an existing body instead of building one. A disguise that leaves hands
its body back rather than destroying it, which also covers a rematch.

One of the four wears a paint layer during the compile, because a painted part
swaps in a cloned material carrying the atlas; the clones are handed back before
the body is parked.

Measured in `tests/gameplay/disguiseTheatre.test.ts`: at compile time the scene
holds four visible bodies with no hidden drawable part and nothing frustum
culled, and syncing four real disguises afterwards adds **zero** scene children
and **zero** materials.

Four bodies share one `MimicMaterialPool` instead of one each, which takes the
materials hanging on the cast from 16 to 4 (measured). The eyes became two
materials, lit and shut, swapped by reference, because a shared material cannot
be dark for one body and lit for another.

### The compile-storm diagnosis does not survive reading three 0.185

The critic's hypothesis was that four theatre bodies with unpooled per-part
materials mean a shader compile storm at the transition. **Three does not work
that way.** `RenderObject.getMaterialCacheKey()` (three.webgpu.js:30342) builds
its key from the material's property *values* and explicitly skips `uuid`,
`name` and `version`, and `Pipelines._getProgramStages` caches compiled stages by
the generated shader *source*. Two structurally identical `MeshPhysicalMaterial`s
therefore share one `nodeBuilderState` and one GPU program on both backends. The
sixteen materials were never sixteen compiles, and the porcelain and graphite a
theatre body wears are the same shaders the player's own Forge body already
built.

So the pooling above is worth having — it is 4x fewer material objects, uniform
buffers and bind groups, and 4x less per-material work every frame — but it is
**not** a compile saving, and nobody should expect the hunt's frame rate to move
because of it.

**The number that does look like the cause: four bodies are 160 drawn meshes.**
A Mimic is 19 shells, 17 bellows, up to 8 panel plates, two eyes and a shutter,
each an individual un-batched mesh with its own draw call, and four of them stand
up at the transition against a shop already running about 293. That is a 55%
draw-call increase arriving in one frame, on the backend and the tier where the
shop alone was already the problem. It is measured (224 meshes, 160 drawn, 96
geometries for a four-body cast) and it is untouched by this pass. Merging a
body's parts into one mesh per material, which the shop's own props already do
through `PropBatcher`, is the obvious next move and is a change to `MimicVisual`
that the Forge's picking and the paint atlas both constrain.

### Verified, and what is not

`pnpm -r typecheck` clean, `pnpm -r test` green (540 client, 161 sim, 46 shared,
23 server), `pnpm -r build` green. New tests: `tests/world/shopBuild.test.ts`
(the chunking preserves the authored order, one run per zone, the step count),
`tests/ui/loadingScreen.test.tsx` (the bar is the real fraction, clamped at both
ends, announced), and four cases in `disguiseTheatre.test.ts` for the pool, the
prewarm, the painted warm body and the once-only guard.

**Not verified: none of this was measured in a browser.** Whether the hunt still
collapses, and by how much the load actually shortened, is a timing question this
pass cannot answer headlessly. Two specific unknowns for whoever measures it:

- The load's shader step leans on `KHR_parallel_shader_compile`. With it, three's
  WebGL 2 backend links in parallel and polls on rAF, so the main thread stays
  free and the loading screen animates. Without it, `createRenderPipeline`
  completes synchronously and that step blocks — the block moves out of play but
  does not disappear.
- The warm frame is drawn from wherever the survey camera happens to be, so it
  covers the shadow and post pipelines for what that one frame draws, not for the
  whole map.

## WebGL 2 stability, and bots that survive a stalled thread (2026-08-02)

Answers two round-4 critic findings measured on a frozen production build on an
Intel integrated GPU. Half of all rounds died with "graphics device was lost" on
the **default** WebGL 2 backend, and the bot Inspector that catches 17 hiders in
19 headless rounds caught nobody at all in real play.

### The light budget is now capped on WebGL 2 as well

`qualitySettingsFor(tier, backend)` capped `maxPracticalLights` on WebGPU only,
so WebGL 2 at the medium tier was running all seventeen authored practicals plus
two fill directionals, a hemisphere and a shadowed spot. The two backends now
have their own tables in `rendering/quality.ts`.

| tier | preset | WebGL 2 | WebGPU |
|---|---|---|---|
| ultra | 20 | 10 | 6 |
| high | 17 | 9 | 6 |
| medium | 10 | 7 | 5 |
| low | 7 | 6 | 4 |
| light | 5 | 4 | 3 |

The two backends are capped for different reasons. WebGPU pays in frame rate.
WebGL 2 pays in program size, because three unrolls the punctual light loop, so
every live point light is another inlined block of lighting code in the fragment
program. The chain into every device loss is the same, roughly ten `Shader Error
1282 VALIDATE_STATUS false` link failures whose driver info logs are empty, then
`uniformBlockBinding: program not linked`, then the context dies. An empty log on
a failed link is what a driver reports when a program runs past a resource limit
rather than when its GLSL is wrong.

**These numbers are a hypothesis, not a measured driver limit, and nothing here
proves the light count is the cause.** The one-shot A/B that survived at the
light tier moves lights, shadows, bloom, GTAO and render scale together. The
table is a single constant and the lead's A/B re-runs against it. Nothing about
the shop's dressing changed, because a lamp that loses its light keeps its pool:
at the WebGL 2 high budget, nine lamps stay lit, eight become unlit fixtures and
four of those get drawn pools, the other four being wall sconces, which never do.

The memo behind `qualitySettingsFor` had to change with it. It was keyed by tier
alone, which was correct while one backend capped and would have handed the
first caller's budget to the other backend now that both do. `GameHost` compares
settings by identity to decide whether a tier change is worth re-applying down
the whole world, so this is load-bearing, and `dressing.test.ts` pins it.

### A link failure now costs a tier instead of the session

`RendererManager` takes `renderer.debug.onShaderError`, which the WebGL 2 backend
calls for every program the driver refuses, and publishes it through
`onShaderLinkFailure`. This is the last point at which anything can be done,
since three carries on and binds the unlinked program regardless. Taking the hook
replaces three's own console report, so the driver's logs are written out here
instead, together with the fragment source length, which is the number that would
confirm or kill the program-size hypothesis above.

`ShaderFailurePolicy` decides what a failure costs, and `GameHost` does as it is
told. A storm arrives as one burst, so the burst rather than the individual
failure is the unit of decision, and a 1.5 second window collapses the tail of
one storm into a single response. The first burst demotes one tier. Further
bursts keep demoting. Once the ladder is spent, the second burst at the floor
tier reports a device fault, which reaches the panel `App.tsx` already shows for
a lost device. That panel is the honest end state, since nothing further can be
traded away, and the context dies within a few draw calls in any case.

Two decisions worth knowing. A link failure **overrides a manual tier lock**,
because the player's choice was about how the game should look and this is about
whether it can be drawn at all. And the tier that failed is **closed for the
session**, which the adversarial pass caught as a hole rather than the critic:
`AdaptiveQuality` raises the tier when frames are fast, and a tier that draws
nothing because its programs never linked is a fast tier, so without a ceiling
the session would have climbed straight back into the failure it was pulled out
of, on a loop. `stepQualityTier` in `quality.ts` carries the ceiling.

`tests/engine/shaderFailure.test.ts` drives the policy against the real
`QUALITY_TIER_ORDER`, covering the single demote, ten failures in one frame
costing one tier rather than ten, the walk down the ladder, the floor being
reached without faulting at once, the fault on the second floor burst, a session
whose failures stop never faulting, and the closed tier refusing a raise while
still allowing the demote below it.

**Not verified: none of this was seen firing in a browser.** The detection hook
is typed against three 0.185.1 and reads the same `debug.onShaderError` contract
`WebGLBackend._logProgramError` calls, but no test drives a real failed link,
because a headless renderer cannot produce one. What is tested is the policy.

### Bot Inspectors advance on match time, not on callbacks

The bot walked `min(120 ms, elapsed)` per turn and threw the rest away. Its turns
come from a `setInterval` the browser coalesces, so a main thread frozen for
seconds delivered one turn and the bot walked eleven centimetres of it. `update`
now integrates the whole elapsed interval in steps of at most `MAX_STEP_MS`,
replanning between them exactly as a run of ordinary turns would, capped at six
seconds of catch-up. Time past that cap is dropped rather than owed, since a bot
carrying a debt walks at a visibly wrong speed for whole seconds afterwards.

Measured over a five second stall in `botRound.test.ts`, against a control round
from the same seed ticked every 100 ms throughout:

| | |
|---|---|
| Control bot, ground covered in 5 s | 4.45 m |
| Speed ceiling for 5 s | 4.55 m |
| Stalled bot, single published hop | 2.90 m |
| Gap between the two bots afterwards | 3e-15 m |

The hop is shorter than the control's path because it is a straight line between
two points and the route turns corners. **The no-teleport property survives**,
and the test states it against elapsed time rather than against a tick. Under the
old clamp the same hop measures 0.109 m, which is `inspectorMoveSpeed * 120 ms`,
and the assertion was falsified by hand against it.

A second bug came out of this and would have been invisible before: `stage` left
`hunter.nowMs` at the moment the bot was created, so the whole of
InspectionIntro read as elapsed walking time and the hunt would have opened with
the bot several metres into the shop. Staging now keeps the clock current.

`LocalLoopbackAdapter.step` also takes one clock reading and drives both the
simulation tick and the bots from it. A bot measures how much match it has to
make up against the clock the phase machine was just advanced to, and a bot's
creep is now recorded at the moment the brain decided on it, which is the
interval the authority measures creep speed over.

**What this does not fix.** A single stall longer than six seconds still costs
the bot the remainder. The critic's 187 seconds of freeze per round, if it is one
block rather than the sum of many, is beyond anything a catch-up can answer, and
the real answer to that is the compile storm work in the pass above. Sensing
still happens once per turn, from where the bot stood when the turn began, so a
stalled client's Inspector is looking at a five second old room for one turn.

**Verified:** `pnpm -r typecheck`, `pnpm -r build`, and `pnpm -r test` green over
these changes at the time of writing (client 535, sim 161, shared 46, server 23).
A later run picked up two failures in `tests/forge/forgeView.test.ts` from the
hider-locomotion work landing in `ForgeController.ts` while this ran. Those are
not from this pass, which touches no forge file.

## Bot Inspectors hunt, and bot hiders hide (2026-08-02)

**The gap this closes.** A solo round had no stakes, because nobody was ever
caught: `localRound.ts` contained no accuse path, bots locked a disguise and did
nothing else, and every round ended with four identical scorelines and the clock
running out. A stranger could play a whole 75-second hunt without discovering
that the game has a gun in it.

### The bot Inspector

`gameplay/botInspector.ts` walks the shop and spends warrants. It moves at
`settings.inspectorMoveSpeed` (read from the settings, never written out), plans
its route over a floor grid built from `NAV_DATA`, and fires through the same
`accuse` command a human fires, so `SpatialValidatorImpl` checks its range and
line of sight exactly as it checks a player's. It has to be standing within
`accusationDistance` of what it shoots, and a test measures the eye positions it
publishes tick by tick and fails if any pair is further apart than the walking
speed allows.

**Movement is a grid path, not steering.** The first version steered at its goal
and slid along whatever it hit, and it spent entire rounds pinned against the
Security Office partition, never reaching the shop at all. It now floods a
breadth-first search outward over cells a body fits in (`WORLD_SCALE.playerRadius
* 2` to a cell, about 2,700 cells) and walks the result. Flooding from the bot
rather than searching toward the goal means a goal inside furniture or up on a
shelf still yields the closest approach the floor allows, which is how the bot
learns something is out of its reach: there is no jump and it does not climb, so
it gives that object up rather than grinding at it.

**What it is allowed to know.** The brain is handed a flat list of object ids and
one bounds lookup. `localRound.ts` is the only place that touches the room's
disguise list, and it reads exactly one thing from it, the object ids, before
merging them into the shop's props. Nothing downstream records which is which, so
there is no role, owner, or "is this a Mimic" to read even by accident. That is
the same view a human client has, since `DisguiseTheatre` publishes a disguise
through the identical focus proxy a chair publishes (§8.5).

**How it decides**, since it cannot see. Two explicit proxies for the eye:

1. *That moved.* An object it watched and then found somewhere else. Only objects
   it can currently see are recorded, so it never notices a shift that happened
   while it was in another aisle.
2. *That is the wrong size to be furniture.* Bounding diagonals between 0.6 and
   2.4 player heights. Fifty of the shop's 104 accusable props survive this
   filter and 26 of those can be reached from the floor, which is why the bot
   still burns warrants on candlesticks and hat boxes.

Whatever passes the size filter enters a seeded shortlist at a 0.28 rate, so a
round contains a few honest mistakes and the same seed hunts the same way twice.

### Bot hiders

`botDisguises.ts` now carries six hiding places instead of bare spawn points,
alternating cover with exposure. Three fold under real furniture the map already
has, the bay beneath the workshop bench, the second board of the steel rack with
the third over it, and the space under the ladderback chair in the window, and
hold absolutely still. Three stand out on the open floor and creep: `BotCreep`
drifts them out to the end of an authored 8 cm offset and back on a six-second
cycle, republished every 400 ms, so each step is about a centimetre. Every one
goes through `recordForgeSnapshot` and is validated for creep speed, revision and
play volume like a human hider's.

The bay under the office desk is the third anchor surface `giantScale.test.ts`
measures and is deliberately unused: it is inside the Security Office, which a
Mimic may never enter (§10.4).

Hiding places are handed out **in the order bots actually hide**, not by seat.
Seats are dealt roles by a shuffle, and a seat-ordered table left one deal in
three with both remaining hiders standing in the open and nobody in cover.

### Measured

Seeds 1 to 24, of which 19 deal the gun to a bot, three bots and the local
player. These are the figures `botRound.test.ts` asserts against, so re-running
it reproduces them:

| | |
|---|---|
| Rounds with no shot fired | 0 |
| Restless hider caught | 17 of 19 |
| Hider in cover, holding still, caught | 7 of 19 |
| Catches / wrong accusations | 32 / 86 |

So cover roughly doubles a hider's survival odds, and the bot spends most of its
warrants on the shop's own furniture. That ratio is also the anonymity guard: if
anybody ever wires the disguise list into the brain as an answer key, the wrong
accusations collapse and `botRound.test.ts` says so.

**These are statistical thresholds and they carry flake risk.** The tight one is
`stillCaught * 2 < restlessCaught`, which is 14 against 17: it fails if the
catch rate on a hider in cover rises from 37% to about 45%. That is the right
failure, since the assertion exists to say cover is worth something, but anybody
who widens the hunt, the shortlist rate or the gun's reach should expect to
re-measure rather than nudge the threshold.

The size filter, by contrast, is **not** tightly coupled to the body. The
tightest starter arrangement measures 0.322 m across its diagonal against a band
of 0.210 to 0.840 m, so it can shrink by 35% or grow by 161% before the bot
stops recognising it as person-shaped. A silhouette retune of a few percent does
not move it. Note the failure mode is loud either way: if disguises ever fell
out of the band the bot would target none of them, the restless catch rate would
collapse to nil, and both difficulty assertions would fail rather than pass
quietly.

The bot issues 0.44 to 0.69 commands a second during the hunt, so nothing here
strains a transport. Bots exist only in the local loopback, so none of it reaches
the wire under Portals in any case.

**Known limits, not fixed here.** The bot walks but never climbs, so a disguise
on a high shelf is safe from it forever; hiding place 3, the steel rack board, is
shootable from nowhere on the floor, though a human Inspector has the climb links
and can reach it. It also empties its warrant budget in most rounds, which is
more trigger-happy than good play, and `INSPECTION_RATE` is the knob. With more
than six hiding bots the plan table wraps and two disguises would share a spot;
the menu seats three.

### Verified

`pnpm -r typecheck`, `pnpm -r test` and `pnpm -r build` all green: 494 client,
161 sim, 46 shared, 23 server. New `apps/client/tests/gameplay/botRound.test.ts`
drives the real `createLocalRound` wiring headlessly, the same adapter, brain,
registry and validator the menu builds, standing in for `RoundSession` only by
running a `DisguiseTheatre` over the published poses, which is the same bounds
lookup the live round installs. It covers every hiding place being legal at both
ends of its fidget, cover plans having real furniture overhead, a round ending
with somebody caught, somebody away and warrants spent on furniture, creeps
actually accepted by the authority, the same seed replaying identically, the
difficulty shape above, and the no-teleport walk.

Not checked: none of this was seen in a browser. The lead owns the browser.

## Backend-aware light budget: 17 point lights down to 6 on WebGPU (2026-08-02)

Follows the lead's finding that the shop's light rig is the dominant WebGPU
cost (frozen production build, GPU-bound, no CPU stall): 5.4 fps at the high
tier on WebGPU against roughly 21 on WebGL 2 with the same seventeen lamps, and
22.9 fps at the light tier. Three shades every punctual light in a loop and its
WebGPU node-material path is far weaker at it than the WebGL 2 renderer.

**`QualitySettings.maxPracticalLights` is new, and `qualitySettingsFor(tier,
backend)` caps it on WebGPU** (6 at ultra and high, down to 3 at light).
WebGL 2 is untouched and still runs every authored lamp — a cap that cost both
backends would trade art for a problem only one of them has. Capped settings
are memoised per tier, because `GameHost` compares settings by identity to
decide whether a tier change is worth re-applying down the whole world.

`GameHost.applyTier` now resolves settings against `renderer.backend`. Its
early-return guard had to change with it: the boot tier is `high` and the
heuristic frequently lands back on `high`, so the old `settings.tier === tier`
test would have skipped the first apply and left the WebGPU cap unused.

**The lamps that lose their light do not lose their pool.** `ShopLighting` draws
a stand-in: one additive `InstancedMesh` of soft discs, unlit geometry, one draw
call for the room. Pools are built in reverse authored priority, so the ones
that must appear are always the leading instances and the switch-over is a
`count` assignment. Two kinds, because they differ in size as well as height —
a floor pool for lamps and pendants (radius to 2.4 m, on the boards), a much
smaller tabletop pool for table lamps and task lights (radius to 0.28 m, on the
furniture the lamp stands on). Sizing this against the authored light radius
would have hung a 1.8 m glowing disc a metre out past a 0.5 m table. Wall
sconces get none at all: they wash the wall beside them and a disc lying flat
under one would be a lie, so their lit shades carry them.

**Which lamps keep their lights is now a rendering policy, not the manifest's
authored priority.** `PRACTICALS_BY_RANK` sorts by whether a lamp lights space a
player can occupy, then by authored priority. This mattered: `office_pendant_01`
carries the highest priority in the manifest (11) but stands in the Security
Office, which publishes no walkable floor and blocks accusation on every prop
inside it, so a six-light budget was spending its most valuable light on the one
room nobody can enter. The six live lights now land in six different playable
zones — reading nook, front window, counter, clock wall and cabinet maze —
instead of five plus a sealed room. The sort lives here rather than in
`placements.ts` so the manifest stays a description of the shop.

Measured over the authored manifest (17 practicals: 6 pendants, 3 floor lamps,
2 table lamps, 2 task lights, 4 sconces):

| | live point lights | unlit fixtures | drawn pools |
|---|---|---|---|
| WebGPU, high | 6 | 11 | 7 |
| WebGL 2, high | 17 | 0 | 0 |

Cutting a light never removes a fixture. The bulb and shade geometry belongs to
the prop and is built from `SHOP_PLACEMENTS` by the lamp builders, which pull
`BULB_MATERIAL` and `LAMPSHADE_MATERIAL` unconditionally, so no budget can take
a glow away; only the `THREE.PointLight` goes. `dressing.test.ts` pins the
arithmetic at every budget from zero up, including the extreme where nothing is
lit and all seventeen fixtures still stand.

**This does not prove the hypothesis, and the change is built so it can be
tested.** The 5.4-vs-22.9 comparison across tiers moves practical count,
shadows, bloom, GTAO and render scale together, so it does not isolate lights;
the same-content 5.4-vs-21 backend gap is the stronger evidence but points at
the backend rather than at lights specifically. `WEBGPU_PRACTICAL_CEILING` in
`rendering/quality.ts` is a single constant: setting it back to 17 and
re-measuring is a clean A/B with everything else held fixed. `stats.practicals`
and `stats.lightPools` on `CuriosityShopStats` report what actually ran.

Worth knowing: the fill rig in the pass below **added** a directional light, so
the room now runs 2 fill directionals rather than 1. Against 11 point lights
removed that is plainly a win, but it is an addition to the loop under
suspicion. The counter spot is also untouched and is still a shadowed local
light on WebGPU. And on WebGPU the shop will read flatter than on WebGL 2:
eleven real pools become seven drawn discs that light only the surface they lie
on, never the walls or props around the lamp. That flattening is the price of
the trade and is why the fill work had to come first.

## Shop readability and the floor as a hero surface (2026-08-02)

Answers the round-2 critic gap "the shop is too dark for a game built on visual
comparison" and "the floor is nearly featureless". Touches `world/maps/lighting.ts`,
`props/{architecture,materials,clutter}.ts` and `maps/swatches.ts` only.

**The readability floor is now a measured contract, not a hope.** Every
unshadowed light is declared as data in `SHOP_FILL_RIG`, and `fillIrradiance(normal)`
restates three's own diffuse maths for those lights alone. `ShopLighting` builds
its lights from that rig, so the numbers a test measures are the numbers the
renderer gets. The rig is four-way on purpose — cool sky and warm floor bounce
from the hemisphere, a cool wash from the back corner and a warm one from the
window corner — because flat ambient reaches the same level and reads as fog.

Measured through the renderer's real transform (three's ACES fit at exposure
1.15, then sRGB), for a white body with no practical, no moon and no environment
map reaching it:

| | before | after |
|---|---|---|
| white body, worst normal | 11/255 | 48/255 |
| white vs mid-tone gap, worst normal | 10 levels | 40 levels |
| north- and west-facing surfaces | 14/255 | 107–113/255 |

That is the gap the critic named: at 11/255 a white body and a white box were
the same pixel. The lamps still carry the room — a practical out-lights the
entire fill rig out to a 2.3 m radius, which `dressing.test.ts` pins between
1.5 m and 4 m, so neither a brighter fill nor a dimmer one passes unnoticed.

**The main risk in this pass: none of it has been seen rendered.**
`fillIrradiance` deliberately ignores the environment map, so the model is a
lower bound and a real frame is brighter than the table above — and the
environment shell was lifted too (`0x0e0c0a` → `0x171310`, floor bounce
`0x3a2a1c` → `0x46341f`). If the screenshots come back over-lit, the whole rig
scales from the four intensities in `SHOP_FILL_RIG`; nothing else needs touching.

**The floor is now authored as a surface rather than tiled as one.** It wears
three new swatches (`floorboard_oak_02`, `floorboard_bleached_03`,
`floorboard_stained_01`) instead of borrowing cabinet walnut, which raises mean
floor reflectance about 2.3x — a shop floor is walked on and is lighter than the
furniture standing on it. They are distinct swatch ids rather than walnut with
different maps because sampling has to hand back the colour actually rendered
(§7.12).

A board-space map (512x128, u along the board in 2 m tiles, v from joint to
joint) carries grain bands of varying width and darkness, two knots, joint
shadows and traffic wear, from one field driving both colour and roughness.
Effective roughness moves from 0.22–0.50 to 0.45–0.64, which is what breaks the
single mirror streak a low camera was getting back. Each board is its own
geometry with its own u offset, u scale and v flip, because the extruder gave
every board of a given width identical UVs and therefore identical grain to the
texel.

The plank field was verified by rendering it to PNG and looking at it rather
than by reading the code, which was worth doing twice: the first version came
out as uniform corrugated sheet and was rebuilt with per-band width and depth
plus a drifting band count. Separately, the wear field was being point-sampled
and printed its own 64-cell grid onto the boards as 3 cm blocks; it is bilinear
now.

**Floor scatter** (`props/clutter.ts`): 180 pieces of paper scrap, dust, wood
shavings, twine, coins and buttons, laid out as pure data with no graphics
device so the placement rules can be checked. It is dressing and only dressing —
it reaches neither `placements.ts`, the object registry nor the nav blockers,
and `dressing.test.ts` holds that line by re-deriving the rules from the map
rather than from the scatter's own code. Writing that test found a real bug:
the authored focus boxes are routinely tighter than the props, so rejecting
against them alone put a scrap inside a workbench leg. Rejection now also runs
against the ground-level nav blockers, which are the authored record of what is
solid.

**Draw calls are down, not up.** The floor went from ~10 instanced meshes to 3
merged ones (a board now appears once, which puts every bucket under the merge
threshold), and the scatter costs 6 instanced draws however many pieces land,
since per-copy variety rides the instance tint. Net change is roughly
break-even against the 293 the scene was running, though that figure is reasoned
from the batcher's rules rather than measured, because building the map needs a
canvas. No shadowed light was added; the tier-gated `shadowedLocalLights` budget
is untouched.

Known and deliberate: the Security Office gets no scatter, because `FLOOR_PLAN`
publishes no walkable box for it. Clutter sheds as a whole below
`clutterDensity` 0.4 via the existing background-layer gate rather than thinning
gradually, which would need quality passed into `PropContext` and therefore a
change to `CuriosityShop.ts`.

Verified: `pnpm -r typecheck`, `pnpm -r test` (501 client, 161 sim, 46 shared,
23 server) and `pnpm -r build` all green.

## The hunt HUD now owns screen regions (2026-08-02)

The critic's finding was that the hunt HUD collided with itself and shared no
grammar with the original: the hider's status card clipped the Forge tool rail so
"1 Pose" and "2 Shape" were unreachable, the Forge's own "FORGE · POSE" header
was drawn on top of the phase timer, and the taunt button sat over its own hint
(`docs/screenshots/critic/06-hunt-hider.jpeg`). Each offset was defensible alone,
which is why inspection could not fix them.

**The screen is now cut into regions before anything fills them.**
`ui/rounds/layout.tsx` holds one table of seven boxes (top-centre status, top-right
stamps, left column, right rail, bottom-centre strip, bottom-right mode note, the
centre). `regionRect` and the CSS come from the same arithmetic, every region
clips or scrolls its own content, and a phase HUD hands `HudLayout` a **record**
of region to node, so claiming one region twice is not expressible rather than
merely wrong. Components render content and no longer position themselves:
`HiderHud`, `InspectorHud`, `MissedFindsHud`, `PaintPanel` and `Toast` all lost
their absolute offsets.

**The original's four anchors are ported** (`ui/rounds/HuntHud.tsx`):

- *Top centre* — `HuntStatus`: a rank of hider figures with the caught ones
  struck through, an hourglass carrying the seconds, a rank of red seeker
  figures, and the phase named underneath ("SEARCH TIME" / "UNTIL THE SEARCH
  STARTS" / "TEN SECONDS"). It is a **count, not an attribution**: it draws one
  figure per published disguise and strikes as many as the round has lost, so a
  caught object cannot be picked out of the row.
- *Right edge* — `ActionRail`: one chip per verb with the key that fires it. A
  hider gets Taunt, the five Forge tools, Mirror and the board; an Inspector gets
  the trigger, the aim and the board. **Every key on it is one some component
  actually listens for.** The nameplate and x-ray toggles of the original are
  absent because we do not have them.
- *Bottom centre* — `ControlStrip`: keycaps for what this role steers with. A
  hider's has no WASD, because per CLAUDE.md override 4 a hider creeps by being
  dragged. OVERTAKEN 2026-08-02: a hider walks and hops, so the strip carries
  WASD and space; see "Jump is in" at the top of this file. For an Inspector
  without pointer lock the strip is replaced by the
  click prompt, since until the room has the mouse none of those controls do
  anything.
- *Bottom right* — `ModeNote`: the mode and its two lines, per role.
- The missed-spot board moved from the top right into the left column, which is
  where the original keeps it.

**The taunt is on T, not on 1.** The original puts Taunt on 1, but 1 is the
Forge's pose tool here and a hider is still authoring during the hunt. `RoundHud`
binds T and reads the gate at the moment of the press through a ref, so the
listener does not rebind on every published state. The Forge's tool column is not
rendered during the hunt at all: the rail carries those keys, and the same key on
two chips is how a player learns to distrust the HUD.

**Also fixed, same defect class, one phase earlier.** `ForgeHud` gained
`showHeader`, and the round passes false, so "FORGE · POSE" no longer lands on the
phase timer during the Forge either. `ForgePhaseHud`'s locked panel was a second
bottom-centre panel over the Forge's status line; the lock is now reported in the
timer's own note.

**Verified** (`pnpm -r typecheck` clean over these files, `pnpm -r build` green,
38 new tests in `apps/client/tests/ui`):

- `hudLayout.test.ts` proves the seven boxes are pairwise disjoint and inside the
  viewport at **1280x720 and 1920x1080**, that a centred region uses `calc`
  rather than a transform (two centred axes cannot share one transform), and that
  every region clips or scrolls.
- `huntControls.test.ts` proves no key is bound twice on either rail, that every
  action appears exactly once, that the taunt key differs from the pose key, that
  a cooling taunt is shown disabled rather than hidden, that an unsupported taunt
  is dropped, and that the mouse verbs are not clickable chips. Its assertion
  that a hider is offered no walk key was overtaken twice on 2026-08-02, first by
  the walk and then by the jump; it now asserts the opposite.
- `huntHud.test.tsx` renders both roles in jsdom, asserts each region is claimed
  at most once, that **nothing renders outside a region**, that the claimed set is
  disjoint at both resolutions, that "FORGE ·" appears nowhere, that each tool
  label appears exactly once and never in a second column, and that the taunt is
  not stacked on the control strip. The duplication assertion was falsified by
  hand: reintroducing a "5 Paint Mode" line in the left column fails it.

`jsdom` was added as a client devDependency for that last file; there was no DOM
test environment before.

Not covered, and worth knowing: jsdom does no layout, so no test measures a real
painted rectangle. The geometry is proved arithmetically and the composition is
proved by rendering, and the two meet only because `regionStyle` and `regionRect`
read the same table. A browser screenshot is still the check on that.

`SpectatorHud` is now unreferenced. The hunt gives a caught hider a small status
card and the board instead, and no other phase used it. It was left in place
rather than deleted, since removing another builder's component is not this
change's call.

## Current phase

Phase 3 — playable local round. The wiring described under "Phase 3 wiring" below is in
place: "Play a round" on the main menu now runs a whole match in one tab against the
Curiosity Shop, with no network.

## The Mimic body and the Forge view (2026-08-02)

A critic pass found the game's central object unreadable: "a vertical stack of
rounded blobs; I could identify two glowing eyes and nothing else. Limbs are
indistinguishable from torso. Seven large flat translucent IK-handle discs are
painted over it and cover more of the body than the body shows." Three separate
causes, all in presentation. Nothing in the rig, the solver, the wire format or
the paint pipeline changed.

**The trunk read as beads because every shell closes to a point.** A segment
shell is a loft with a filleted cap at each end, so four trunk shells laid end to
end pinch four times. `MimicVisual` now draws each trunk shell past its bone tip
into the next one, as a share of its own length (`SHELL_OVERRUN_SHARE`), which
buries both pinches and leaves the trunk one continuous surface. A share rather
than a length, so stretching the torso in the Forge cannot open a gap at a seam.
Limbs are deliberately left alone: the pinch at an elbow is the articulation. The
head overruns nothing, because it is the crown and player height is measured
against it — `giantScale.test.ts` still finds the standing body at exactly
`PLAYER_HEIGHT_M`.

**Limbs disappeared into the trunk because the trunk was wider than the arms
hang.** An upper arm hangs with its centre 0.13 authored units out from the
spine; against the old 0.32-wide chest it protruded 0.025 and had no outline of
its own. The authored cross-sections are re-proportioned against the silhouette
rather than against the bone table: chest 0.27 and waist 0.23 so the trunk tapers,
neck 0.115 against a 0.20 head so there is a neck at all, shoulder stubs 0.145 so
there is a shoulder line wider than the head, arms slimmed to 0.10 and 0.088.
The arm now stands 0.045 clear of the chest, which is 90% of its own half width.
Legs clear each other by 9 mm at the thigh, and a foot reaches twice as far
forward as its shin.

**Edge definition comes from the bellows, which were tucked away.** The dark
rubber at each joint was sized at 0.92 of the thinner shell for every joint alike,
and it is also 1.14x fatter at its equator than the diameter it is scaled to —
a rib bulge nobody had accounted for, now published as `BELLOWS_OUTER_RATIO` so
the joint table can be written in outer diameter and mean it. Elbows, knees,
shoulders and wrists now stand proud (1.1–1.2 of the shell below them) and read as
dark articulated seams on a matte white body; trunk joints and hips tuck in at
0.94 so the trunk stays one form. The capsule profile's caps were also taking
nine tenths of a limb between them at the middle of the roundness slider, leaving
no straight shaft at all; they are 0.12/0.32 now instead of 0.20/0.45.

**Finish.** The porcelain default was roughness 0.30 with 0.45 clearcoat, which
blows out to a flat bright shape against colourful clutter. It is 0.62 / 0.25 on
a near-neutral white now, so shading describes the form. `PaintMaterialBinder`
bakes a part's swatch roughness and metalness into its unpainted texel, so
painting still starts from exactly the material underneath it.

**Two more unconverted world-metre literals**, both of the same family as the
ones the giant-scale retune caught: the panel socket studs (a 52 mm brass disc on
a 350 mm creature) and the anchor seal markers (68 mm). Both now convert with
`RIG_TO_WORLD`.

### The handles and the camera

`HANDLE_SCREEN_RADIUS` was 0.028 and the handle was a filled sphere or disc with
a translucent depth-ignoring copy over it. **Drawing and grabbing are now two
different sizes.** The drawn handle is a thin billboarded outline ring at 0.012
with a small solid grip inside it at half that, faint (0.34 opacity) until it is
hovered and opaque while it is held; the pointer is tested against an invisible
proxy at the original 0.028, which draws nothing and writes no depth. The outline
spans under a twelfth of the body's height where the old filled disc spanned
about a seventh, and picking is no harder than it was.

**The Forge camera could always orbit — on a right drag.** Left-drag was the
gesture nobody found, because a left press that hit nothing simply did nothing.
`beginLeftPress` now reports whether the active tool consumed the press, and an
unconsumed one goes to the camera. `forgeView.test.ts` pins both directions: a
drag over empty space turns the camera and records no edit, and a drag aimed at
the head handle poses the body and does not move the camera.

Two framing numbers were world-metre leftovers. The opening radius of 2.4 was
outside the wheel's own maximum of `7 * RIG_TO_WORLD` = 2.23, so the opening shot
could not be zoomed back to once left; it is `2.4 * RIG_TO_WORLD` now. The orbit
target sat 0.55 m above the root, which is above the crown of a 0.35 m body, so
the frame was aimed over the Mimic's head; it is 0.55 *of body height* now, and
`frameMimic` takes the same rule from the root rather than from the pelvis bone,
so a folded arrangement that tucks its hips does not drag the whole frame down.

**`DOORWAY_POSITION` is gone.** It was the fixed point (2.9, 1.62, 2.6) — the
practice room's doorway, and after the retune a camera at nearly five player
heights, which is the "what I did not verify" note from the retune section below.
The doorway preview is derived from the active workspace instead: eye height,
22 body heights back down the room's longer axis, toward whichever end has more
room, clamped one player radius inside the walls. The Inspector preview is
clamped the same way, which it was not before.

Also fixed while in there: switching tool mode now cancels a live camera drag.
Holding a drag and pressing 5 left the camera owning a pointer the brush needed.

**Verified**: `pnpm -r typecheck`, `pnpm -r test` (491 client, plus sim, shared
and server) and `vite build` all green. `mimicSilhouette.test.ts` measures a real
`MimicVisual` in world metres and asserts the relations that make it a body —
head wider than neck and narrower than the shoulder span, each arm clear of the
chest by a share of its own width, a waist narrower than hips and chest, daylight
between the thighs, feet ahead of shins, a flat hand rather than more forearm,
trunk shells overlapping while limb joints abut exactly, bellows proud at elbow
and knee and tucked at the neck, and the crown still at player height.
`forgeView.test.ts` covers the camera and handle claims above.

**Not verified: none of this was seen rendering.** The measurements are geometric
and headless. Whether the matte porcelain, the proud bellows seams and the
outline rings actually look right under the shop's lighting is a judgement only a
screenshot can make, and the next critic pass should make it rather than trust
this section. The paint pipeline was not changed and its existing tests pass, but
a painted body was likewise not looked at.

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

**Closed** (see "The Mimic body and the Forge view" above). `DOORWAY_POSITION` is deleted:
the doorway preview is derived from the workspace at `WORLD_SCALE.eyeHeight`.
`WALL_MOUNT_HEIGHT_M` is kept at 1.15 m deliberately. It is a room dimension, not a body
one — a Mimic disguising itself as something hung on a wall belongs at the height the
shop's own pictures hang, whatever size the Mimic is.

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
  room's copy disagree until the next accepted pose. NARROWED 2026-08-02: the walk keys
  now cap themselves at exactly the number the authority checks (see "A Mimic can walk"),
  so the ordinary way of moving during the hunt no longer rubber-bands. The **pointer**
  path is untouched: a pelvis drag is still limited only by how fast the player moves the
  mouse, and still rubber-bands when it outruns the cap.
- ~~The Forge tool HUD and `HiderHud` overlap during the hunt, and the Forge's own header
  still reads "FORGE · POSE" there.~~ Fixed by the region layout above.
- ~~Bots ready up and lock a disguise and do nothing else.~~ CLOSED 2026-08-02: see
  "Bot Inspectors hunt, and bot hiders hide" at the top of this file. A bot Inspector
  now patrols and accuses, and bot hiders take real hiding places.
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

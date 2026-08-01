# MECCHA CHAMELEON Research (user-directed feature port)

Researched 2026-08-01 from the Steam store page, Steam community screenshots,
Kotaku coverage, GamingOnLinux, and gameplay video thumbnails/frames. The user
wants ALL core features ported into FOLD & SEEK (see CLAUDE.md "USER DESIGN
OVERRIDES").

## What the game is

Steam release June 10, 2026 (~$6). Viral: ~7M copies, 340k+ peak concurrent.
Multiplayer hide-and-seek: hiders have pure-white poseable bodies and PAINT
themselves to blend into the room. "The hiding spot, the pose, and above all,
your artistic skills are the key." 2-10 recommended (screenshots show lobbies
with 20+); public matches, private servers, streamer viewer-participation.

## Core mechanics observed/confirmed

- Seekers carry SHOTGUNS and must find/shoot all hiders within a time limit
  (observed seek timer: ~258s). Seekers win on finding everyone.
- Hiders can KEEP painting and repositioning after seekers enter. Being in a
  seeker's direct line of sight EARNS POINTS — visibility is rewarded; pure
  out-of-sight hiding scores nothing. Taunts exist to bait seekers for points.
- Painting: color wheel + eyedropper (sample colors from the environment by
  clicking surfaces), brush size control, paint directly onto your own 3D body,
  NO undo in the original (we keep our undo as an improvement). A "shadow"
  toggle exists in the paint UI (bake shading on/off?). Metallic/value sliders
  visible in the ref screenshot's color panel.
- Poses: pose key (R) cycles/holds poses (lying flat on walls/fences is meta),
  rotation lock toggle, climb ability, free camera toggle.
- Keybinds seen: 1 = Taunt, R = Pose, F = Paint mode, T = toggle nameplates.
- Per-hider social ratings: thumbs-up/found counters shown over players;
  "missed finds" rating; post-round rating of best hides.
- Maps: GIANT-SCALE themed rooms — players are tiny (mouse-sized) in oversized
  interiors (SpongeBob-style room with giant barrel + pet bowl; a "Mansion").
  A corner photo/minimap reference of the room exists in the HUD.
- X-ray rendering toggle for spectating/streamer view (in ref screenshot).
- Round flow: lobby → hide/prep phase (seekers blocked) → seek phase with
  countdown → results with ratings.

## What FOLD & SEEK ports (user directives)

1. Seeker gun (shooting = accusation; warrant rounds as ammo).
2. Hiders active during the hunt (creep movement, live editing, taunts).
3. Full body painting: eyedropper click-to-copy from any surface, freehand
   texture-space brush strokes on own body, free color wheel, brush size.
4. Taunt/pose expressiveness and the visibility-scoring philosophy (our
   direct-look escapes + LOS-seconds scoring).

## What FOLD & SEEK keeps as its own identity

- Mimic FOLDING (articulated body reshaping) on top of painting — the fold IS
  our differentiator vs MECCHA's fixed humanoid.
- Anonymized disguise objects + accusation/warrant economy (bounded shots vs
  MECCHA's timer-only pressure).
- The Curiosity Shop premium diorama art direction (vs MECCHA's janky charm).
- Undo, starter arrangements, material swatches (bulk fills) alongside brushes.

## From the user's 32 screenshots ("og game ss" folder in the workspace root)

Read 2026-08-01. Definitive mechanics visible in the actual UI:

- SEEKER: first-person SHOTGUN viewmodel (paint-splattered skin), center
  crosshair, ammo as a row of red SHOTGUN SHELLS bottom-center, TPS/FPS camera
  toggle, CTRL crouch / CTRL+SPACE stand / SPACE climb. Seek timer ~340s on
  big maps.
- HIDERS STICK TO WALLS: players lie flat on vertical fences/walls high off
  the ground (SHIFT releases the stick; SPACE climbs up, CTRL down). Wall
  hiding painted-to-match is a core meta.
- "MISSED FINDS RATING" (key 6): a LIVE leaderboard during the seek phase
  ranking hiders by points earned from being passed over/seen-but-not-found;
  updates on a visible ~20s cycle ("next update 21"). Names + points.
- Social counters float over hiders (spectator/post-find view): thumbs-up
  count + found-magnifier count.
- HUD top: row of hider icons (alive/caught), hourglass timer with phase
  label ("until search begins" / "search time" / "answer checking"),
  red seeker icons. Top-left: photo minimap card with map name + N/10 counter.
- Right-edge keybind chips: 1 Taunt (bell), R Pose, F Paint mode,
  2 toggle nameplates, 3 toggle render-through-walls, V mic, B audio, T chat.
- Bottom bar (hider): SHIFT release stick, CTRL down, SPACE up, 5 free camera,
  rotation lock (mouse), turn-in-place (mouse). Q + two gem slots + X row =
  quick-swap saved colors.
- Free camera mode ("Свободная камера") for hiders/spectators.
- Modes seen: Básico (two teams, hide until end), Infection ("if caught you
  become a seeker"), Growing/Multiplying seekers variant.
- Maps seen: hide-and-seek Mansion ballroom, farm/barn yard, Japanese street
  wall, SpongeBob-style room, carnival fence — all giant-scale, players tiny.
- Painting meta: players paint FACES and clothing onto their white bodies
  (Mona Lisa bodies, denim cats matching plush props, maneki-neko cat among
  real cat statues, tiny frog beside a plant). Paint quality IS the disguise.

## Second screenshot batch (33-51): the paint panel + phase details

- FULL PAINT PANEL (download 46, German UI): color wheel + sRGB preview
  checkbox, R/G/B numeric sliders, Hue/Saturation/Value sliders, Hex sRGB
  field WITH alpha (e.g. C6ABBBFF), brush size on wheel, 3D-Pipette
  eyedropper on HOLD SPACE, Schatten (shadow) toggle on V, and THREE material
  channels per paint: Metallisch, Rauheit (roughness), Emissiv. Old/new color
  comparison swatches top-right.
- ANSWER CHECK phase: after the seek timer, a short phase labeled "Answer
  Check" (~11-15s) before results.
- SEEKER SELECTION: a floor pad labeled "hunter applicants should stand
  here" — players opt into the seeker role by standing on it in the lobby.
- Hiders can hide INSIDE framed paintings (painted flat against art), among
  statues, as plush props. One player painted a full Bosch-like mural on a
  wall canvas.
- Seeker FPS shotgun has a paint-splatter skin; gamepad button prompts
  confirm controller support.
- Missed-finds scores reach thousands (e.g. #1 at 3,492) with a visible
  "next update Ns" countdown.

## Confirmed English UI names (from English-locale screenshots)

"Missed-Spot Ranking" (key 6, "next update Ns"), "Search Time", "Answer
Check", "Taunt" (1), "Pose" (R), "Paint Mode" (F), "Toggle Nameplate
Display" (2), "Toggle X-Ray Rendering" (3), hider bar: "Detach" (SHIFT),
"Move Down" (CTRL), "Move Up" (SPACE), "Switch to Free Camera" (5),
"Rotation Lock", "Rotate in Place"; seeker bar: "Crouch" (CTRL), "Stand Up",
"Climb" (SPACE), "TPS/FPS" toggle. Modes: "Basic — Split into two teams: It
and runners. Hide until the end to win." / "Increasing Tag — When caught,
you become It."

Design bar note: a hider painted themselves as a complete autumn-forest
painting inside an oval gold frame (#1 missed-spot, 1,302 pts). Frame-hiding
is top-tier strategy — the Clock Wall frames family must support flat
in-frame disguises with paintable "canvas" poses.

## Open questions (not yet decided)

- Human-scale shop vs MECCHA's giant-scale room. Giant scale multiplies hiding
  surface and is core to MECCHA's comedy. Candidate: scale players down
  relative to the shop (mouse-in-a-shop fantasy) — ASK USER before committing.
- Round timer values vs bible defaults given live hiders.

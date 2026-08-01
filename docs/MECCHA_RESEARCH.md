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

## Open questions (not yet decided)

- Human-scale shop vs MECCHA's giant-scale room. Giant scale multiplies hiding
  surface and is core to MECCHA's comedy. Candidate: scale players down
  relative to the shop (mouse-in-a-shop fantasy) — ASK USER before committing.
- Round timer values vs bible defaults given live hiders.

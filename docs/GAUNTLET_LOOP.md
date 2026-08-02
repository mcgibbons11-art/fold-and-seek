# Gauntlet Loop — Working Agreement

Adapted from https://somethingbig.ai/gauntlet-loop (reviewed 2026-08-01).

## The loop

1. Lead (main session) decomposes work into independently improvable
   components and states a CONCRETE bar for each.
2. A builder agent creates or modifies the component. Builders never grade
   their own work.
3. A critic agent with fresh context inspects the ACTUAL output (runs the
   code, takes/looks at screenshots, reads the diff) and compares it directly
   against the bar — blind A/B against the reference images where possible.
   It names the single biggest remaining gap. A critic never grades a
   builder's summary or self-report, only real output.
4. Work returns to a builder with the critic's gap as the brief.
5. Repeat until the bar is met, improvements become negligible, or the lead
   halts. Never a fixed round count. Every round gets a FRESH critic; a
   critic is never reused across rounds (its context is contaminated by what
   it already excused).

## The bars for this project

- **Visual bar:** `assets-source/references/ref-diorama-warm-bedroom.jpg`,
  `ref-diorama-cozy-blue-room.jpg`, `ref-diorama-drawer-workshop.jpg` —
  warm handcrafted miniature-diorama lighting, dense believable clutter,
  premium PBR response. Screenshots of the running game are compared against
  these.
- **Gameplay bar:** bible §47 acceptance matrix + §51 quality checklist +
  §0.2 required final repository condition.
- **Code bar:** `pnpm check` green (typecheck, tests, build), bible §48
  coding rules.

## Session rules

- Max 4 concurrent agents (user directive 2026-08-01, supersedes the earlier 5).
- Agents run as Opus 5, medium effort; never Fable (user directive, see memory).
- Builders own disjoint file sets; the lead owns shared config files.
- Critics get: the bar artifacts, the component's acceptance criteria, and
  access to run the app — not the builder's self-report.
- The lead adjudicates critic findings; it does not blindly apply them.
- MEASUREMENT PROTOCOL (learned 2026-08-02, round-6 control experiment): on
  this machine, automation-browser frame timing is untrustworthy — a single
  fullscreen triangle measured 1.3 fps in the same session that ran rAF at
  143 fps, so absolute fps/load numbers from Playwright/DevTools Chromium
  are harness artifacts. Critics judge by COUNTS (pipeline/link/draw/call
  counters), DOM geometry, and event sequences. Frame-rate and feel verdicts
  come from the user's own headed Chrome only. Always run the triangle
  control before trusting any perf number.

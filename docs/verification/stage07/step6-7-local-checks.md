# Cheat evidence, escrow lifecycle and networking checkpoint

Verified locally on 2026-09-27 with Node 22 and pnpm 10.7.1. This checkpoint
combines the new Stage 07 evidence and escrow code with the Stage 08 transport
and signaling foundations. It does not accept either stage or milestones C/D.

`pnpm check` passed typechecking, type-aware lint, formatting, dependency and
boundary checks, engine purity, translation checks and the full test suite.
The suite passed **1,014 tests in 167 files**, with one opt-in draw timing test
skipped. Vitest took 159.94 seconds. `pnpm build` also passed. The new
browser timing and WebRTC diagnostic pages are absent from the production build.

The [566-file source manifest](step6-7-local-checks-manifest.json) covers source
and configuration. Its hashes matched after the test run and build. Review
responses and this report were written separately from that source snapshot.

The first combined attempts found test lint errors and 69 dependency cycles.
Shared declarations now live in type modules, with verifier behavior preserved;
the dependency check reports zero violations. Another run timed out in the live
Monopoly trace at 60 seconds. The isolated trace passed in 41.6 seconds and
reached Monopoly after 58 legal commands. Test workers now use at most four
workers and at most half the available CPU concurrency, with a minimum of one.
The unchanged test passed in the complete suite in 45.1 seconds. No timeout or
assertion was weakened, and no game-count acceptance batch was added.

Focused evidence includes:

- Durable cheat candidates, historical verification, owed contributions during
  a retained claim, rotating retries and restore after auxiliary failures.
- Locally pinned escrow manifests, reservation and abort races, no master reuse
  after abort, reserved retirement capacity and no verdict before durable abort.
- Private complaint nonces, authenticated bad-share and false-complaint results,
  and aggregate admission rejecting a forged ACK before application policy.
- Authenticated WebRTC replacement, replayed old offers, deferred attempts,
  asymmetric loss, bounded buffers and observer-triggered disconnect.
- WebSocket challenge signatures, same-key reconnect, heartbeat cleanup,
  paced client sends and exact forwarded-frame byte limits.

The [native Chrome check](../stage08/chromium-replacement-smoke.md) formed all six
links, transferred 1 MiB and reconnected a lost pair using four same-origin
frames. It used the existing Chrome process. No Firefox or Playwright browser
was launched. Independent-browser, cross-browser, TURN, manual-code and
cross-network acceptance remain open. No GitHub Actions result is claimed for
this local checkpoint.

Automatic rejected-artifact capture, sequencer consequences, recovery release
and activation, browser storage, full audit and lobby integration are unfinished.
The eight-type hidden-steal browser measurement remains above its 300 ms target.
The verified protocol is not yet exposed in the published app.

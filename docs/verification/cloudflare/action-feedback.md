# Pending action feedback

The deployed multiplayer beta waited for `session.submit()` without displaying
its pending state. The controller's ref prevented duplicate submission, but did
not render a spinner or disable the other controls. Command preparation can run
synchronous validation and cryptography before its first asynchronous wait.

This change displays pending feedback before starting submission. It keeps the
selected public building preview while waiting and preserves the certified game
state, hidden hands, revisions, saves and network protocol. A pending preview is
not an accepted move. The original expected revision still governs admission.

## Performance scope

This improves click feedback. It does not claim shorter consensus or proof
latency, nor add speculative authoritative moves or rollback across peers.

Setup placements and dice requests do not normally create resource-spending
range proofs. They still perform local hand-opening validation and clone the
crypto context. Candidate, proposal and commit validation repeat some checks at
different trust boundaries. A later profiling pass should measure these costs
before changing them. Dice randomness waits for one contribution per required
participant; separate peers contribute concurrently. There is no measured
2-to-6-player wall-clock multiplier, and the published beta supports two to four
seats.

## Verification

- Thirteen focused tests passed across action submission, dialog pending state,
  card dialogs and trading. They cover feedback before validation/submission,
  duplicate clicks, rejected moves, revision changes during the paint delay and
  suspended animation callbacks. Trade controls become inert during submission;
  Escape cannot close the pending modal, and its footer remains outside the
  scrolling body.
- Full type checking, type-aware lint, formatting, dependency boundaries and
  translation checks passed. Translation checking reports existing unused keys.
- `pnpm build:cloudflare` passed, with the existing large-chunk warning.
- Inspected the real dialog and card-picker components in a temporary browser
  preview at 1280 × 720 and 390 × 844. The spinner stays visible, pending controls
  dim, and the footer stays inside the modal. This checks component layout, not a
  new end-to-end multiplayer session. The preview files were removed afterward.
- The previous release's two-profile multiplayer check remains documented in
  `deployment.md`. This patch changes UI feedback only; it does not change the
  protocol, signaling Worker, bindings or free-only hosting configuration.

The release uses local checks and `[skip ci]` while the separately documented
whole-repository coverage timeout remains unresolved.

## Deployment

Deployed on 2026-09-27 to `https://hexfield.steenbakkers.cc/` as Worker version
`f9563873-e0c9-4377-83e5-fd4f3be303f9`. The live homepage loads the new
`index-DCB3cH-U.js` bundle and renders in the browser. HTTP checks confirmed the
homepage, health endpoint, entry assets and updated game chunk return 200;
`/api/turn` still returns 503. See `action-feedback-http.json`.

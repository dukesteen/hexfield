# Online worker release

Deployed on 2026-09-27 to <https://hexfield.steenbakkers.cc/> from source
`929e889` as Worker version `980115cf-504c-4c68-b54f-9dab5ceddcd2`.

Certified multiplayer startup, game validation, proofs, journal writes and bot
actions now run in a dedicated browser worker. The UI receives detached public
state and the local human's private hand. Pending feedback can paint while
cryptographic checks run. Peer agreement still takes time; this release does not
introduce speculative accepted moves or change fairness guarantees.

## Build and deployment

The clean Cloudflare deployment checkout was fast-forwarded to the source
commit. `pnpm build:cloudflare` and the Wrangler deployment dry run passed with
Node 22. The deployed main bundle, online bundle and protocol worker match the
local production build byte for byte, as does `index.html`; see
`online-worker-live-assets.json`. The live health endpoint returns `ok`.

The existing Worker, Durable Object bindings, request limits, routes and asset
configuration are unchanged. Workers Free remains the constraint, and TURN
remains disabled. No paid resource or billing-plan change was made.

## Verification

The [implementation report](../stage09/online-worker-implementation.md) records
242 passing local web tests, static checks, a two-browser game through setup,
dice, trade and restore, hosted-bot startup, and Claude's review disposition.

On the published site, a fresh isolated signaling room connected successfully.
One human and one hosted random bot completed certified startup. The bot placed
its first settlement and road; the human confirmed a settlement and advanced to
road placement. The board, player totals and hand rendered correctly, with no
browser warnings or errors reported. Save and leave returned to the homepage
and retained the game in the saved online games list.

This production smoke check uses a hosted bot; it does not replace the local
two-browser network check or claim a new external-network acceptance result.
Full terminal-audit and detailed proof/heartbeat performance acceptance for the
worker boundary remain open. The earlier remote CI timeouts are not declared
resolved, and full M-C/M-D remain incomplete.

# Redesigned multiplayer release

Deployed 2026-09-27 from `127f6ab31311e309b58138098b1af693907d0cee` to
<https://hexfield.steenbakkers.cc/> as Worker version
`4913fe89-1267-469c-85ab-12f24c73c0c3`.

This release includes the redesigned board and UI, protocol v5, verified public
replays and safe local game removal, improved reconnect/QR controls, and durable
transfer-cancellation reload. The homepage board uses a legal four-player setup.
The unfinished encrypted-save and periodic-snapshot work was excluded.

The clean Cloudflare checkout was fast-forwarded to this exact commit. Its locked
offline dependency installation, Cloudflare production build, Worker TypeScript
check and deployment dry run passed. The existing Worker, Durable Object,
rate-limit and origin bindings are unchanged. The session's confirmed Workers
Free constraint remains in effect. No subscription or paid resource changed;
TURN remains disabled.

Live verification:

- The published HTML, main bundle, protocol worker and homepage board asset match
  the local build byte for byte. See [asset checks](redesign-release-assets.json).
- The real WebSocket smoke test passed health/API checks, signed join, relay,
  identity replacement, idle relay, invalid client rejection and join timeout.
  `/api/turn` still refuses credential issuance.
- A fresh online room with one human and one hosted random bot completed startup.
  The bot placed its settlement and road. A human settlement was confirmed and
  accepted, increasing the score to one and advancing to road placement. Save and
  leave returned to Home with the game available to resume.

This live smoke check supplements the local two-peer gameplay and native
handoff/cancellation checks. It is not a complete multiplayer milestone audit or
an external-network compatibility claim. All players should refresh before a new
room; the release does not support older protocol saves or mixed-version games.

CI was dispatched with E2E skipped and one seed per network scenario, as requested.
Its first run passed typechecking and lint but stopped because the formatter
included a verbatim Claude follow-up review. The formatter exclusion was extended
without changing that raw review. Full-repository formatting then passed in the
clean release checkout. CI will rerun on the follow-up commit; a successful
production deployment does not imply that pending CI checks have passed.

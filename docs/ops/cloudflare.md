# Cloudflare hosting

`hexfield.steenbakkers.cc` serves the SPA and WebSocket signaling from the
`hexfield` Worker. Each signaling room uses its own SQLite
Durable Object with hibernating WebSockets. Browsers still execute and verify the
game. Signaling relays opaque connection envelopes. Cloudflare STUN helps peers
discover direct routes. Some networks require a TURN relay and cannot connect
through this free-only deployment.

## Deploy

Use Node 22 and the repository's pinned Wrangler version. Authenticate Wrangler
to the account in `apps/signaling/wrangler.jsonc`, then run:

```sh
pnpm install --frozen-lockfile
pnpm deploy:cloudflare
```

The build sets the public signaling URL, leaves the TURN credential endpoint
empty, and uses `/` as the SPA base. Explicit custom network settings remain usable. GitHub Pages builds
retain their separate configuration.

Wrangler owns the custom domain, static assets, Durable Object bindings,
migrations, limits and ordinary variables. Regenerate Worker types after binding
changes with `pnpm --filter @cp2p/signaling worker:types`.

## Free-only deployment

The user requires no overage charges. Keep this account on **Workers Free** and
verify that plan before deploying. Do not upgrade it or enable a paid product.
Cloudflare [stops Workers requests](https://developers.cloudflare.com/workers/platform/limits/)
and [Durable Object operations](https://developers.cloudflare.com/durable-objects/platform/pricing/)
when their Free plan allowances are exhausted. An outage at the limit is
preferable to a bill. Static asset requests are free and unlimited under the
[static assets billing policy](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

Cloudflare [STUN is free and unlimited](https://developers.cloudflare.com/realtime/turn/faq/).
TURN charges for egress beyond its shared monthly allowance. No provider-enforced
zero-overage cap was verified, so this Worker has no TURN key, secret binding,
credential issuance code or outbound TURN API calls. `/api/turn` always returns 503. A credential-count limit cannot cap bytes transferred, and Cloudflare's
[budget alerts do not stop usage](https://developers.cloudflare.com/billing/manage/budget-alerts/).

This policy covers Hexfield's deployment. A later account upgrade or unrelated
paid service can change account billing; no application setting can prevent
those account changes.

Signaling admits at most 16 sockets and eight authenticated peers per room.
Pending joins expire after ten seconds. Inactive rooms expire after 24 hours.
Origin checks restrict browser callers, but neither room IDs nor request headers
authenticate a player: the signaling challenge requires the player's signature.
Game invitations and the peer protocol provide their own authorization.

## Verification and operation

`/healthz` checks Worker reachability. Opening an app route directly should return
the SPA. The bounded WebSocket check uses fresh test identities and a random room:

```sh
SIGNALING_ORIGIN=https://hexfield.steenbakkers.cc \
  pnpm --filter @cp2p/signaling exec node tests/worker-smoke.mjs
```

Also verify two independent browser profiles can join a room and begin play.
Verify `/api/turn` refuses issuance and the deployed client has no default TURN
endpoint. Do not create a TURN key as part of smoke testing.

Worker invocation logs are disabled to avoid recording room URLs. Application
errors omit provider bodies and credentials. Use deployment versions for code
rollbacks; Durable Object migrations and data do not roll back with code.

The initial Cloudflare agent setup installed the official Cloudflare skills and
registered the main, documentation, bindings, builds and observability MCP
servers. The protected servers are authenticated. A new Codex session loads the
newly registered tools.

See the [Cloudflare verification record](../verification/cloudflare/deployment.md)
for the deployed revision and the checks actually completed.

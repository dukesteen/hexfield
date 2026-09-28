# Protocol v6 multiplayer release

Deployed on 2026-09-28 from `9652085926dd6c9345cda7c82850119d62302277`
to <https://hexfield.steenbakkers.cc/> as Worker version
`dd518b15-1ad6-43c6-9352-7923e9397264`.

The release includes protocol v6, encrypted saves, certified seat transfer and
recovery, and the reviewed ceremony, admission and audit fixes. All players must
refresh before creating a new room. Earlier protocol games and saves are not
supported by this release.

## Build and acceptance

The isolated release checkout passed locked offline installation, the Cloudflare
production build, Worker typechecking and deployment dry run. The Cloudflare
build now builds the signaling package's dependencies first, so a fresh checkout
does not depend on old package build output.

[CI 36422582543](https://github.com/dukesteen/hexfield/actions/runs/36422582543)
passed static checks, production builds, all four unit shards, engine coverage,
stub network scenarios and the real-crypto invalid-proposer scenario. The
production source is unchanged between that run's `21553e3` and this release;
subsequent changes are test code, documentation, workflow selection and the build
command. Broad E2E was skipped as requested. The separate
[mixed-engine run](../stage08/mixed-engine-followup-36422582118.md) passed a
complete signaling-backed game and all four independent audits with Chromium,
Firefox and WebKit.

All nine real-crypto fault scenarios now have passing full-game traces across
the source pins in the [M-C evidence map](../stage09/mc-remaining-acceptance.md).
The [M-D evidence map](../stage10/remaining-acceptance.md) covers its explicit
acceptance criteria. Current-source manual-code completion and physical
phone/network checks remain open at deployment time. This release does not
declare M-C complete.

## Live checks and configuration

The published HTML, main JavaScript, stylesheet, protocol worker and audit worker
match the local release build byte for byte. The live signaling smoke check
passes health/API routing, signed join, opaque relay, identity replacement, idle
relay, unauthenticated and binary rejection, and the join deadline. TURN
credential issuance remains disabled.

A production UI smoke check in two isolated installed-Chrome profiles passes
room creation, invite-link joining, readiness, startup and board rendering. The
acting player confirms a settlement and road; the other player's board then
becomes enabled. Neither page reports a JavaScript error. Both profiles close
cleanly. This checks live startup and replicated placement, not a full game or
an external-network connection.

The first smoke attempt incorrectly assumed the host always starts. Its retained
failure shows both boards rendered without page errors while the guest was the
acting player. The corrected check follows the actual active board and passes;
no production change was needed.

The existing Worker, Durable Object, rate-limit and origin bindings are unchanged.
No subscription or paid resource was created or changed. The user's confirmed
Workers Free plan remains the deployment constraint. This records the settings
used by this release, not an audit of unrelated account usage.

The [release evidence archive](protocol-v6-release-evidence.tar.gz) contains the
source/asset manifest, build and dry-run output, live asset hashes, signaling
results and both UI smoke outcomes. SHA-256:
`36a472ae0a7d0e68e4e793f35829e549280d6b1a31196b831d6f264cf40100fa`.

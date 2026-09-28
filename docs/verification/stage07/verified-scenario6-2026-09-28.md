# Verified scenario 6 on the final clone build

[CI run 36422582543](https://github.com/dukesteen/hexfield/actions/runs/36422582543)
passed one real-crypto scenario 6 game on protocol v6 at
`21553e304bfe36f3a5005898c5fe6b0aba7dcccf`. It used seed 42, game index 0,
one worker and the unchanged 900,000 ms limit. The public artifact reports
source fingerprint
`135cef2e5df2188864d308888c90505adee91f0537efdf45fd5bb7dc022bb0d4` and
`sourceUnchanged: true`.

The game completed 182 turns and 1,064 certified inputs in 738.032 seconds.
The fault was injected and recovered. The terminal head was sequence 1,064,
hash `9019b0eaa04069d9e5aca9611da05abd0fd876c7b414a5b11a7ecdbcb4e6d0fd`.
All three surviving peers completed an independent audit at that head with no
cheat findings. The selected workflow also passed build/check, simulation, all
nine stub-network scenarios, and all four unit shards. Persistence was not run
in this workflow.

This closes the remaining scenario 6 outcome after the older run timed out
while its terminal audits were pending ([historical report](verified-ci-followup-36416940673.md)).
It does not replace that history. Scenario 2 has a separate local pass on this
same source pin ([timing report](verified-latency-local-2026-09-28.md)); the
other scenario passes remain linked in the [M-C matrix](../stage09/mc-remaining-acceptance.md)
with their own source pins. This is not a claim that all nine scenarios ran in
one CI job or on one source revision.

The exact public JSON and source-revision file are retained in
[the evidence archive](verified-scenario6-36422582543-artifacts.tar.gz),
SHA-256 `64aaa0f199dd09fa25e6d0d00f582f23366996b453326e23fc31eb542441defc`.

# Automatic takeover production scheduler acceptance

Current protocol v6: **PASS**, 2026-09-28. The focused signed-session test passed
in 20,880 ms (21.88 seconds including runner startup), within its unchanged
60-second limit. [Terminal report](automatic-takeover-terminal.json),
[exact runner log](automatic-takeover-trace.log), and
[source hashes](automatic-takeover-source.sha256) preserve the result.

The focused test and fixture pass scoped TypeScript checking and type-aware lint.
Formatting passes for the owned source and reports. All five source hashes still
match after those checks; no additional crypto or native run was needed.

Three genuine `P2PSession` instances restore independent durable journals from a
signed four-human verified fixture. Seat 0 is disconnected. Before signing
genesis, the fixture selects `auto` mode while retaining the default 120-second
policy. The production `ReplicatedLog` pulse and `P2PSession` automatic callback
remain intact; pass-through spies observe requests and do not invoke them.

The peers certify a live offline marker at sequence 9. Disconnecting one of the
host's required peers for 120 seconds produces no takeover request. After
reconnection, a further 90 seconds still produces none. Once the quorum-qualified
policy interval elapses, the production scheduler calls `requestTakeover(0,
'easy')` exactly once. No public manual authorization approval API is called.

The real recovery flow certifies authorization at sequence 10 and activation at
sequence 11. Both certificates contain the original three required human voters,
seats 1, 2 and 3. All peers converge on activation hash
`274aef8cf573968bb6108fb93ed062481b778976a82160a9e3fdd70961d43f21`.
Replaying the signed history verifies membership epoch 2 and quorum 3. Only the
new bot controller receives the recovered seat's private state.

This closes the named automatic production scheduler trace. It uses deterministic
virtual time and an in-memory authenticated transport, not a browser or device
matrix. The fixture supplies its existing engine-command verification policy;
this test submits no human engine commands. Recovery certificates, encrypted
private reconstruction and production session scheduling execute normally.
Actual recovered-bot commands, default-10-VP finish and independent audits remain
covered by the separate [installed-Chrome lifecycle](native-takeover-acceptance.md).

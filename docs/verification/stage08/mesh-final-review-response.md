# Connection replacement review response

The [follow-up review](mesh-final-review.md) identified a replayed offer that
could retire a live link. The transport now keeps one primary and at most one
pending replacement per peer. Only a replacement that completes fresh HELLO
authentication can displace the primary. Failure or expiry clears only the
pending attempt. A captured offer from another session leaves the primary
authenticated and able to send data through the pending attempt's timeout.

Rate-limited fresh offers enter one deferred slot per peer. At the end of the
250 ms interval, the transport checks freshness and retired attempts again.
The regression delivers a second offer at 100 ms and sees it applied at 250 ms.
Signal routing checks the complete attempt/session/sequence tuple for both slots.
Disconnect and disposal clear pending attempts, deferred offers and timers.
Promotion also rechecks ownership after down observers run, so an observer's
disconnect cannot resurrect a closed pending connection.

The remaining implemented corrections are:

- SHA-256 fingerprint parsing accepts uppercase tokens. An unsupported local
  fingerprint reports `fingerprint-unsupported`; a computed mismatch remains a
  security failure.
- The isolated-page browser test constructs all transports before starting them,
  preventing an early offer from arriving before a listener exists.
- Manual connection attempts have a finite five-minute timeout on both roles.
  Ordinary attempts retain their 30-second timeout.
- Attempt and reassembly expiry have specific diagnostics. The diagnostic API
  includes a security classification.
- Regressions isolate inbound data liveness from PING and PONG traffic, check a
  delayed HELLO before negotiation returns to stable, and cover both random-ID
  orders. Wrong sender hints, lower sequence replays, retired attempts and
  responder-only loss have focused coverage.

The focused peer-link, mesh and signed-envelope tests pass 45 cases. Source and
test typechecks, scoped lint and formatting pass. The generic envelope limit
is larger than the server route's complete 64 KiB frame limit. That adapter
checks the full escaped frame and rejects an oversize send explicitly.

Cross-browser, independent-context, cross-network and manual-code acceptance
remain open. The native Chrome result is recorded separately with its source
fingerprints. Neither fake connections nor four frames in one browser establish
those remaining acceptance criteria.

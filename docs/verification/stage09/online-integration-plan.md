# Online integration sequence

Read-only inventory after the audit implementation checkpoint. This is a plan,
not acceptance evidence.

The web routes and session registry currently launch local games only.
`attachSession(gameId, GameSession)` and `GameReadOnly` already accept a generic
session, so the game UI can consume a `P2PSession` once the online lifecycle exists.

1. Expose the ceremony coordinator and its public types. Compose durable device
   identity, per-game signing keys, master sources, accepted shares and outboxes.
   Store signing keys and consensus records before genesis consent. Use the
   ceremony's consent lifecycle instead of calling raw genesis signing directly.
2. Implement signed lobby messages, the host-owned lobby state and host handover.
   Freeze configuration, seat ownership and versions before collecting secrets.
3. Connect create/join routes to server signaling and the mesh. The signaling
   adapter currently receives room peers but does not expose the roster needed by
   `WebRtcTransport`, whose roster is fixed before start. Resolve authenticated
   roster discovery and lobby membership changes before freezing the game mesh.
   Manual-code and relay signaling remain separate unfinished work.
4. Coordinate freeze acknowledgements, original commitments, seed agreement,
   ordered deck passes, optional escrow, durable consent and signed genesis.
   Preserve irreversible consent across timeouts and restarts. Certify the retained
   deck passes before allowing the first random result or gameplay input.
5. Acquire the game writer lease and create or restore one `P2PSession` per local
   human. Supply the verified private driver, hosted bot keys, IndexedDB journal,
   contribution stores, recovery records and post-game audit worker. Attach the
   session to the shared store and release it through an online session registry.
6. Add the online lobby, ceremony progress, game route, waiting/reconnect states
   and audit presentation. Finish with a complete game over real peer links and
   the existing strict-agreement recovery cases.

`IndexedDbProtocolJournal`, `IndexedDbByteStore`, ceremony locks and
`acquireGameWriterLease` are available foundations; none currently forms a
production online session by itself.

Game turn timers need a separate implementation. Current replica timers govern
consensus rounds, and `VerifiedSessionDriver` does not expose game timers. The
Stage 09 local-clock admission rule also needs a deterministic historical replay
rule; a wall-clock callback cannot become the authority for certified replay.
The bot delay currently defaults to 350 ms, while the stage document specifies a
configurable 0.5–2 seconds.

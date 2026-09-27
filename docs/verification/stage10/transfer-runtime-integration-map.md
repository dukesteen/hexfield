# Transfer runtime integration

Protocol v4 has certified authorization, activation and cancellation, sealed private delivery, durable destination credentials, staging and atomic journal promotion. A promoted destination can restore under its current certified key and device route. The browser cannot yet complete a user-driven transfer. This map separates the implemented boundaries from their missing callers.

| Boundary                   | Implemented                                                                                                                                                                                                                                                                             | Remaining                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Certification              | `P2PSession.submitTransfer()` uses the strict membership channel and current voter set. Authorization reserves fresh keys without changing voters.                                                                                                                                      | Worker requests, source intent and approval controls.                                                                                                                                                |
| Destination credentials    | `prepareOnlineTransferCredentials()` persists independent replacement keys and encryption secret before returning signatures. Exact-attempt retry restores the same credentials.                                                                                                        | Destination worker flow and authorization exchange.                                                                                                                                                  |
| Public bootstrap           | `online-transfer-bootstrap.ts` verifies a bounded public start and certified prefix against the expected game and genesis.                                                                                                                                                              | Authenticated delivery to a device with no local game record; the artifact itself grants no import or voting permission.                                                                             |
| Temporary device admission | Game-key routing rejects devices without an active certified route.                                                                                                                                                                                                                     | A transfer-only device channel carrying public evidence and sealed packets. A pending destination must remain outside gameplay and voting.                                                           |
| Private delivery           | `prepareTransferPrivate()` persists an exact signed sealed outbox. `importTransferPrivate()` authenticates it, checks certified source authority and reconstructs the affected private seats.                                                                                           | Worker calls using its own trusted journal and keys, retry control and progress reporting.                                                                                                           |
| Staging and promotion      | `TransferImportStore` verifies staging/readiness. `IndexedDbProtocolJournal.promoteTransfer()` atomically installs certified history, fresh safety and the active binding under a game-wide writer lease. Final authorization tombstones prevent reuse after selective record deletion. | Serialize import, exact-head readiness, activation and promotion in the destination worker. Save the verified original public start for ordinary resume.                                             |
| Current-authority restore  | `P2PSession.restore()` checks current ownership after historical replay. `openOnlineGame()` validates the installing generation and current human route. `OnlineStartup` uses promoted material without reminting ceremony keys.                                                        | Connect successful promotion to this restore path.                                                                                                                                                   |
| Active routing and cleanup | The post-membership hook sends the final commit before swapping game routes. Old writers retire. Returned bot keys, private state and proof providers are released without discarding the host's human seat. Resume exports only public active device peers to the main thread.         | Update the live WebRTC frozen roster, chat peers and worker/main-thread route state. Remove temporary admission on cancel or activation. Retire separate browser credential copies where applicable. |

A source that misses activation can request certified history through a bounded
retired route. The adapter retains at most six such routes for 128 certified
heights. Only history requests and responses pass, alongside a one-shot commit
notice. Restore requests history after its listener attaches; the existing pulse
retries with ten-second deduplication. Catch-up still needs a reachable survivor
whose route the stale source recognizes. A save beyond that grace period, or one
whose known peers have all moved, needs the separate public bootstrap path.

## Required ordering

1. The destination validates public start evidence and the certified prefix, then durably creates fresh replacement signing keys and a transfer-encryption key.
2. The current owner submits the signed authorization. The current quorum certifies it. The destination still cannot vote or command.
3. The source rechecks its journal and certified source authority, persists the sealed packet, and sends only those immutable outbox bytes.
4. The destination verifies the packet, reconstructs private state and durably stages its binding. It rereads the certified head before producing exact-parent readiness. A changed head requires a new check.
5. The old voter set certifies activation. A destination receives the exact certificate and atomically promotes its staged journal, binding and fresh safety.
6. Only successful promotion permits the new session to open. The original writer is retired by the certified activation.

Cancellation removes temporary admission and staged private material only after its certified outcome is verified. It retains the authorization tombstone and reserved-key evidence. Retry needs a fresh authorization and keys. Complete origin-storage deletion is outside the tombstone guarantee.

An already-running destination voter is not a valid intermediate state. Activation replaces the human key itself as well as its inherited bots. A destination must open a fresh promoted session with all its affected keys; a live host's recovery loader is not a transfer-adoption path.

## Destination worker constraints

Credential preparation uses a verified pre-authorization prefix. Private import
and readiness require the exact certified pending authorization. A participant
resuming an import must load the previously reserved keys, because its certified
authorization already binds those keys.

Persist the validated public start before promotion using
`saveOnlineGameRecord()`. It already writes the immutable start, game pointer and
catalogue in that order, and retries repair a missing catalogue entry.
`loadOnlineGameRecord()` reads the game pointer directly. Awaiting that save
before promotion closes the crash window where an active journal has no public
start for ordinary resume. A read-only durable outcome lookup is still needed
to distinguish completed promotion from a missing stage on restart. An attempt
also needs a durable locator for its reserved credential attempt and exact stage
head; missing final outcome does not mean no import exists.

Staging validates the binding and public prefix, but treats sealed-packet and
private-replay bytes as opaque. The worker must authenticate and replay them on
restart and after a changed certified head. It must release the staging lock
before acquiring the game-wide writer lease for promotion. Cancellation and
successful handoff dispose working credential buffers and private drivers.

Resume currently repeats overlapping verification in worker initialization,
startup, the game factory and `P2PSession`. The three-second resume acceptance
target remains unmeasured for this path. Reuse requires holding the writer lease
and checking the exact journal head and binding; an arbitrary cached authority
map cannot replace replay.

## Evidence and limits

The focused tests cover real signed authorization and activation, old route rejection, fresh-key private restore, promoted browser startup, exact private outbox retries and atomic fake-IndexedDB promotion. They do not yet establish browser-to-browser handoff, transfer-only WebRTC admission, manual reconnect to a replacement host, or a completed game and audit after transfer. Those remain required before enabling the user flow or claiming Stage 10 acceptance.

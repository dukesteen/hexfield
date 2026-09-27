# Certified game audit

Finished verified sessions now exchange original master reveals and can run an
independent audit of the certified history. This is an implementation checkpoint.
Milestones C and D remain incomplete.

## Behavior

The engine's recorded mode starts at untouched genesis and applies exactly one
recorded input per call. It always checks public and private invariants, preserves
atomic rollback, and never generates another random answer or automatic input.
Normal local games retain their existing settling behavior.

The audit first validates the entire certified public history and identifies the
first entry that produced a game result. It verifies each original master against
its genesis commitments, reconstructs private draws and hidden steals, and replays
all inputs with every hand available. It compares public hashes after every entry
and cross-checks the existing private reconstruction, including historical beacon
extensions. Missing reveals and malformed supplied masters do not accuse an
original owner. Authenticated inconsistencies and already certified cheat findings
remain distinct report fields.

The reveal coordinator reads the durable certified journal before accessing a
master. Signed packets bind the genesis, first result, original seat and current
publisher. It saves outgoing packets before publication and retransmits the exact
bytes after restart. Incoming reveals are saved with their certified receipt head
and reauthenticated against that historical authority on restore. A recovered
master requires an existing completed recovery authorization. Verification work,
accepted secrets and retransmission packets are bounded by the original roster.

The replica continues reveal exchange after ordinary gameplay completes. The
session publishes audit status separately from the engine result. It waits for
all original seats, cancels stale jobs, wipes retained buffers immediately on
cancellation, and exposes an explicit retry after worker failure. Observer errors
do not permanently suppress a retained reveal. Local storage failures do not
count as peer misconduct.

The browser adapter runs the base-engine audit in a disposable worker, transfers
owned master copies, erases its input buffers and correlates responses. Its policy
uses mandatory built-in proof verification and rejects unsupported callback-only
system evidence. The adapter is ready for the online session wiring; it is not yet
connected to a production lobby or results view.

## Evidence

The audit fixture plays a real certified game with two human peers and two hosted
bots to victory using a privately dealt victory card. Focused tests cover the
complete audit, missing/wrong masters, a corrupt certificate, refusing unfinished
history and an altered private draw detected at the exact victory-claim entry.

Reveal tests cover refusing private-source access before a result, exact durable
retries, source-buffer erasure, wrong signer/result/master, and restoring accepted
reveals. The live session test drops all initial reveal packets, retries them,
completes an audit, closes a pending worker, and restores after the other peer has
left. It also retries a simulated worker failure without a new certified entry or
any change to the game result. Browser-adapter tests use an injected worker port;
a separate test runs the real terminal history through the worker's base policy.

The [verification record](audit-verification.json) records the combined command
results, source manifest and logs. No Playwright or browser process was launched.
An internal read-only integration review found cancellation, retry and observer
delivery issues; the checkpoint fixes them. Deferred-I/O tests also prove that
disposing during journal, source or store work cannot return a packet or repopulate
accepted master buffers.

The full check passed all static gates and 1,121 tests, with one worker-adapter
test failing because its Node environment did not provide `ErrorEvent`. Giving
that test the intended DOM environment passes all five adapter tests. The later
disposal fix passes all four reveal tests. Final typechecks, lint, formatting,
dependency boundaries, purity, translation checks and the production build pass
with an unchanged 623-file source manifest. The whole unit suite was not repeated
after those scoped corrections. The Claude implementation review remains pending.

## Remaining work

The complete recovered-game audit, adversarial acceptance, automatic cheat
consequences and proof-performance target remain open. The F0-matching but
otherwise inconsistent-genesis reveal verdict lacks a dedicated terminal fixture.
Production lobby/start flow, browser writer-lease integration, signaling invite
flows, audit presentation, returning players and certified device transfer are
also unfinished. This checkpoint does not check a Stage 07 or Stage 10 acceptance
box.

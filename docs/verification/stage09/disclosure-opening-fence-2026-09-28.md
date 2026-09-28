# Authenticated disclosure fence during browser activation

The current source fixes a demonstrated transferred-resume bypass of retained
post-consent escrow disclosure. It adds no disposition certificate, quorum rule
or recovery-share release.

## Failure and correction

The fail-before run `81339` retained a correctly signed original-holder disclosure
for the pinned genesis, including a verified DLEQ witness and original frozen
device signature. The clean transferred resume passed (9.311 seconds), but the
disclosed resume entered `playing` rather than `halted` (3.971 seconds). The
fixture uses a genuinely certified transfer journal and current key binding;
production `OnlineStartup` and `openOnlineGame` perform the restore. The witness
is constructed and authenticated directly in the test, not written by a second
ceremony coordinator.

The new protocol helper owns and validates the original genesis, frozen roster
and escrow transcript. It scans only bounded retained dispute slots, verifies
canonical device packets and holder proofs, and requires the exact envelope hash
from signed genesis. A foreign nonce, malformed packet or nonmatching witness
does not establish a halt. Storage failures stop opening rather than bypass the
check. Public invalid-envelope reports remain separate: they disclose no share
and do not revoke a completed genesis.

Shared browser activation checks this authenticated evidence before creating a
session. Opening device output is copied into a bounded FIFO (128 messages,
1 MiB). After genuine session create/restore, a final check and synchronous FIFO
release run under the same attempt lock used for disclosure insertion. This
callback only loads and sends; it acquires no nested ceremony/writer lock. Valid
disclosure discards buffered output and closes the prepared session. Startup
shows `halted` while preserving the signed promise and evidence. Clean opening
preserves send order. No internal signature prepared before the final check is
claimed to be recalled.

## Checks and scope

```sh
pnpm exec vitest run apps/web/src/session/online-resume-binding.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run apps/web/src/session/online-startup.test.ts apps/web/src/session/online-startup-retry.test.ts -t 'freezes two humans|consented dispute during opening|closing during a deferred' --maxWorkers=1 --minWorkers=1
```

Final `34012`: **5/5 pass**, 24.282 seconds test time / 25.94-second runner.
Cases: clean, retained disclosure, disclosure inserted after the real
`P2PSession.restore` returns but before activation receives it, malformed bytes,
and a signed foreign nonce. The two halt cases emit no actual device messages.
The real restore implementation runs unchanged. `91888`: **3/3 pass**, fresh
startup/first certified move, disputed deferred lease, and close during opening
(22.61-second runner). Shared typecheck `77161`, scoped lint/format/diff `68581`
passed. Existing per-case bounds were retained. An earlier five-case pass inserted
evidence during the restore load; the final case strengthens that placement to
after the real restore returns.

This fixes retained-evidence and opening-race activation. It does **not** fence
an already-active independent coordinator for the rest of its lifetime. The
existing coordinator's live dispute event still halts its own session. Another
process that has already activated needs separate authenticated notification or
output fencing; no instant cross-process guarantee is claimed. A different
device cannot know a disclosure it has not received. This is focused correctness
evidence, not new browser timing, cross-engine or full-game acceptance.

The [design review](disclosure-halt-design-review-2026-09-28.md) rejected the
broader unanimous disposition proposal. The [source manifest](disclosure-opening-fence-2026-09-28.json)
records post-check source hashes; it is not a before/after runtime pin.

A subsequent read-only review identified that disposal callbacks could refill the
opening queue after it was cleared. The final source sets a monotonic output stop
before disposal, ignores subsequent sends, and refuses final release after stop.
The selected disputed-opening and deferred-close regressions passed 2/2 in
`39382` (12.22-second runner); scoped format/lint `8810` passed. The five-case
result above predates this narrow cleanup correction.

The [final source review archive](disclosure-opening-implementation-review-v2-2026-09-28.tar.gz)
contains the immutable Opus 5.5 medium input, manifest, response and correction
disposition. Its required corrections are now covered:

- The coordinator and guard share `onlineCeremonyPacketKey`. The existing actual
  four-peer coordinator test retained an authenticated post-consent dispute, and
  the guard detected that exact stored evidence (`50844`, 1/1 pass, 17.70 seconds).
- Buffered release catches each disconnected-peer send failure and preserves
  FIFO for the remaining peers. The final lossy FIFO assertion passed in `29455`
  (1/1, 11.22 seconds).
- Overflow sets a bounded sticky flag and fails opening at final release, before
  sending a partial queue. It does not throw into session listener internals.
- The actual memory and IndexedDB/Web Locks adapters propagate the task's error
  unchanged, so the typed disclosure error remains intact without a new lock
  result protocol.

`72771` reran all five original controls plus lossy-send and overflow cases on the
final production source: **7/7 pass**, 35.148 seconds test time / 37.15 seconds
runner. The real restored session sends a valid encoded `SYNC_REQ` through its
actual projected transport before returning. Assertions require nonempty queued
send attempts in the during-open case and released output in the clean case.
The request is a controlled transport probe, not a mocked accepted command.
Shared typecheck `29226` and scoped type-aware lint passed. The JSON records the
final eight source hashes; the lossy FIFO assertion was added after `72771` and
checked separately in `29455`.

Commands for the final checks:

```sh
pnpm exec vitest run apps/web/src/session/online-resume-binding.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run packages/protocol/src/online-ceremony.test.ts -t 'authenticated post-consent disclosure clears ready' --maxWorkers=1 --minWorkers=1
pnpm exec vitest run apps/web/src/session/online-resume-binding.test.ts -t 'with lossy retained' --maxWorkers=1 --minWorkers=1
pnpm exec vitest run apps/web/src/session/online-startup-retry.test.ts -t 'consented dispute during opening|closing during a deferred' --maxWorkers=1 --minWorkers=1
pnpm exec tsc -p tsconfig.test.json --noEmit
```

Disconnect callbacks and route-admission updates can still occur during opening;
they are not protocol output. This check does not recall internal signatures or
halt an already-active independent coordinator after a later disclosure.

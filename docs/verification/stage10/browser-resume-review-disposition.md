# Browser resume review corrections

Date: 2026-09-27. The [review response](browser-resume-review-response.md) records
the frozen source review. These corrections are implementation evidence, not
browser or milestone acceptance.

| Finding                                                  | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1: valid IDs rejected by the journal                    | Fixed  | Both the IndexedDB journal and writer lease accept leading `-` and `_`. Four regressions failed before the correction. The two complete storage test files then passed all 23 tests in 1.12 seconds.                                                                                                                                                                                             |
| M1: interrupted first open cannot resume                 | Fixed  | Under the writer lease, only the built-in bound journal may initialize after atomically proving genesis, entries, consensus safety and key binding all absent. The fake-IndexedDB signed-start regression passes, including refusal after deleting existing consensus safety. The existing two-human resume test also passes and retains strict missing-history rejection for injected journals. |
| M2: leaving the loading route retains its connection     | Fixed  | The game route releases its room on unmount, including a kept lobby handoff. Deferred cleanup preserves StrictMode remounts. Both lifecycle regressions failed before the correction and pass afterward.                                                                                                                                                                                         |
| L1: the 129th saved game blocks startup                  | Fixed  | The recent-games index evicts its oldest entry while retaining immutable game records and direct-route access. A bounded-index regression covers this behavior.                                                                                                                                                                                                                                  |
| L2: one bad pointer hides all games                      | Fixed  | Listing returns valid games and unavailable IDs separately; Home reports partial failures. Tests cover missing and malformed pointers.                                                                                                                                                                                                                                                           |
| L3: post-consent dispute accepts another signed envelope | Fixed  | Post-consent evidence must match the exact envelope hash in the pinned draft or certified transcript. Focused regressions prove that disclosure of the certified share still halts, while another dealer-signed envelope does not.                                                                                                                                                               |

The L3 follow-up inspection found no path where an honest holder publishes a
complaint over a later alternate envelope: the per-pair received packet is
immutable, and local complaints read that same accepted slot. The review's
coverage note should say **four-human** resume for nonempty escrow transcripts;
escrow eligibility begins at four humans. The original response remains intact.

The updated loading-route, room-registry, settings and network-query tests pass
18 tests in four files in 3.28 seconds. The route tests exercise StrictMode for
both direct resume and kept-lobby handoff, checking that connections stay open
while mounted and close after unmount. Scoped type-aware lint passes.

Browser reopening has now restored a two-human/two-bot game's certified board and
the returning player's private hand. The native manual reconnect check exposed a
stale bootstrap-bridge lifecycle problem; its correction passes focused tests and
the [surviving-host browser retest](../stage09/manual-browser-check.md), including
another certified turn handoff after reconnection. The
three-second restore target, four-human escrow resume, and current-protocol
full-game acceptance remain pending. No acceptance checkbox is completed by this
review.

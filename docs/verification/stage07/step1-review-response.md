# Stage 07 Step 1 review response

The user approved the prepared review packet and subsequently authorized future
Claude reviews of this project's source, tests and designs. The read-only review
ran with tools disabled. Its [manifest](step1-review-manifest.json) identifies the
exact input, and the [response](step1-review.md) is retained with Markdown
formatting normalized.

The reviewer reported no confirmed verifier soundness break or witness leak.
This is a code review, not formal verification or Stage 07 acceptance.

## Changes

| Finding                                                           | Response                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: Escrow degree, master key and recipient binding               | `verifyFeldmanShare` now requires the expected threshold, master public key and recipient index. Tests reject mismatched commitment lengths, keys and recipients. Recovery still requires authenticated, individually verified shares.                                                                                                                                                                                |
| F2: Standalone/composed range nonce reuse on caller context reuse | Fixed mode tags separate standalone bits, standalone ranges and composed ranges. Composed Schnorr uses a separate nonce domain. A regression checks that response subtraction cannot recover the shared blinding across modes. The caller must still bind the complete operation and branch.                                                                                                                          |
| F3: Shuffle negatives used malformed proofs                       | Negative statement tests now use a well-formed proof.                                                                                                                                                                                                                                                                                                                                                                 |
| F4: Missing malicious range and reduced-threshold tests           | Hand-built bit/range forgeries try values 2 and field value minus 1, pretending either bit is honest. Both fail. The Shamir test checks that interpolating fewer shares at a lowered threshold does not recover the dealt secret. These finite regressions do not claim exhaustive proof soundness.                                                                                                                   |
| F5: Integer sampler test name overstated bound binding            | Renamed the test. The generic sampler retains the specified label/context/counter derivation. Beacon derivation binds the entire validated engine request, including its bound.                                                                                                                                                                                                                                       |
| F6: Hash-to-group tests lacked independent vectors                | Added RFC 9496 A.3 element-map vectors and RFC 9380 K.3 SHA-512 XMD vectors, plus an independently calculated intermediate for the actual H input. There is no claim of a published end-to-end RFC vector for our custom domain.                                                                                                                                                                                      |
| F7: Missing complete CDS composition helper                       | Added composable Schnorr and a bounded CDS OR helper. Each branch proves an opening and up to two ranges under one shared challenge. One Fiat-Shamir challenge binds all ordered statements and first messages. An independent outer transcript, false branches, range splicing, modified challenges, branch order and context changes are tested. Protocol-specific one-hot and index statements remain Step 5 work. |
| F8: Shuffle rejection ordering                                    | Encoded challenge length and proof-array shape are checked before parsing deck points. The generic 128-card bound remains; the deck protocol must enforce its exact expected size before invoking this helper.                                                                                                                                                                                                        |

The integration obligations in the review remain requirements. In particular,
range widths and card counts come from protocol state, a dispute's shared point
needs a verified DLEQ, and recipient openings must be checked before a receipt.
The generic CDS helper supports up to eight resource branches, matching the
planned eight-type steal benchmark. Its bounded shape does not establish that
the caller supplied the correct application statement.

Browser worker timings, full-game cryptographic validation and the adversarial
acceptance suite remain outstanding.

## Follow-up

The [second review](step1-followup-review.md) found no confirmed soundness break
or witness leak. It identified checks whose removal would not fail the existing
tests. The subsequent regressions isolate those checks:

- N1: A false range has internally consistent bit proofs at challenge 7, while
  its valid opening uses the branch challenge. The outer hash and challenge sum
  match. Only the range-to-branch equality check rejects the forged AND proof.
- N2: Valid bits for 13 answer the Fiat-Shamir challenge for the false claim
  that 100 is a six-bit value. Only the weighted-sum check binds those bits to
  the claimed commitment and rejects the proof.
- N3: An independently constructed shuffle transcript includes an identity card.
  All shuffle equations hold, but the verifier rejects the identity. A separate
  equivalent fixture isolates duplicate-card rejection.
- N4: A CDS opening's response changes while its first message remains unchanged.
  The composition rejects it through the opening equation.
- N5: Response subtraction now compares standalone and composed one-bit ranges
  with the same known blinding. This targets the actual nonce-reuse risk.
- N6: CDS derives dedicated entropy before invoking the exported Sigma helpers.
  A direct helper call with the original seed and the exact CDS component context
  therefore has a different first message. This hardens accidental local reuse;
  a caller that already holds the secret seed is not a security boundary.

The [mutation checks](step1-mutation-checks.json) temporarily removed the N1,
N2 and N3 production guards one at a time. Each targeted regression then failed
an assertion, demonstrating that it catches the missing guard. The source was
restored byte-for-byte after each run. The second review's source manifest
records its exact input; these final test additions and N6 entropy hardening
follow that review.

# Internal canonical clone: local checks

The codec now copies a value by parsing canonical text it generated itself, then decoding byte tags. Only copyConsensusStateData and the transition schema check use this internal helper. Both retain schema validation and detached copies. The helper accepts values, never a caller-supplied trusted encoding or flag; it grants no consensus ownership or admission authority.

Public canonicalDecode, parseCanonical and its UTF-8 byte limit, restoreConsensusState, controller persistence and context stamps are unchanged. The clone still runs the same encoder and tag decoder. It removes redundant UTF-8 conversion, re-encoding and byte comparison of the codec's own output. No timing or acceptance improvement is claimed.

Claude Opus 5.5 at medium effort approved this narrow design in 129128 ms. The implementation follows its recommended API and exactly two consumers. Wider parseCanonical, restore, cache and structural-byte-copy changes were deferred. The review notes that less traversal can change resource-exhaustion behavior; that is not used as a validation property.

Final run 98038 passed 60/60 tests in 1.37 seconds: codec 12, consensus 16, controller 32. Tests cover a fixed-seed bounded 100-case differential corpus plus Unicode/surrogates, numeric normalization, byte views and special records; writable detached copies and duplicated shared references; matching rejection constructors/messages; the public export boundary; genuine copied consensus state rejecting a forged retained vote and a changed context. Existing signed-state, persistence, callback-isolation and context-guard regressions passed. One intermediate test-only prototype comparison was corrected to use identity, avoiding a typed-array prototype getter during deep equality.

Final scoped type-aware lint, formatting and shared test typecheck passed in session 61456. No full game, CPU profile, long CI or new dependency was used for this change.

| Final source                              | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `packages/codec/src/canonical.ts`         | `a163545d5f4d23fb1d6f05b1229fd6727efe6ac9667c621828cf3ad8675e8f3a` |
| `packages/codec/src/internal.ts`          | `c6dfabc71bcb06d365b5a97f5ef0f2cb5415c492ae04fc48124d90e7ab901416` |
| `packages/codec/src/canonical.test.ts`    | `3a83af668c22648b96ee26d32b8a26ba6a1fc94626f047e7eb55bde143723e38` |
| `packages/protocol/src/consensus.ts`      | `fb22de87afc8ba467a227c22de8589b0bfb203a50a952faf8636a2da4e2f78a5` |
| `packages/protocol/src/consensus.test.ts` | `271d53c2ed1e0b4782122ff6a2bab6b2c3db2d15cbeb1cea6a8017b11169f1a8` |

[Review and check archive](canonical-clone-review-2026-09-28.tar.gz) contains the exact brief, raw review, manifests, final sources and complete final check logs. SHA-256: `f6f332ed10c88793be1bea75999b51f3ca3244c0b5810e9d258e4aa54838fcba`.

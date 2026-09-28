# Terminal master-reveal checkpoint design review

**Disposition:** Design-only review. It approves investigation of a private live-replica checkpoint, not an implementation or Stage 07 acceptance. The review examined source at commit `4e4af86e48849e7e1f9da4ccebb378dc3358c28e`. It ran no tests and changed no production code.

The current terminal lookup loads the journal and replays its certified prefix before its first result is used. A live replica has already replayed that chain on restore and validates each new certificate before committing it. An internal checkpoint could avoid that duplicate replay, but only if it remains tied to that validated replica and its durable journal.

The reviewer requires every checkpoint use to confirm that the replica is live, outside repair, has a non-halted active controller, and still holds the exact context object recorded in the checkpoint. The controller snapshot and opening stamp must pass, and a fresh journal read must match the checkpoint's genesis, certified head and height. No failure may fall back to trusting a snapshot or caller-provided context. Standalone coordinators and imported journals keep full replay.

Mint the checkpoint only after a validated replay or validated entry advance, a successful journal safety CAS, and successful controller restoration. In `repairNow`, keep the first-result reference with the cached replay so the later snapshot-validation call does not need another replay. Mint only after repair resumes successfully. Clear it before repair, on a new commit or terminal halt, and on disposal. Capture the original result entry once, when a certified transition first changes the engine result from `null` to a value. Later controls must not replace that reference.

The checkpoint must stay internal. `MasterRevealCoordinator` and `MasterRevealOptions` are exported from the package root today, so do not add a public constructor parameter, callback, option, or `ProposalContext` fast path. The package export map names only `.` and `./testing`; an internal factory may be omitted from both public entry points. Keep imported and display snapshots, transport payloads, and the excluded actor outside this trust path. The excluded actor retains full replay.

Leave accepted-receipt restoration unchanged. It must continue to replay and verify each receipt at its recorded `receivedAt` head, including publisher authority. A journal head-only read may later avoid copying the full journal on cache hits, but it does not remove first-call replay and should be measured separately.

The source shows valid mint points in restore, commit and repair. It does not establish that terminal replay caused the reported CI timeouts. The failure brief notes long flushes and gaps in lifecycle timings, but has no phase profile. Keep that attribution open and measure terminal load, clone and replay costs separately from restart/load/open time.

Minimum regression coverage should include a bounded signed terminal fixture that compares the live checkpoint with standalone replay; initial restore and first-result capture; corrupt restore and certificate rejection; mutated result, membership, crypto ledger, nonce, engine and policy; changed journal genesis/head/height; delayed journal reads followed by commit, repair or disposal; repair that retains the first-result reference; unchanged historical receipt quarantine; and proof that the excluded actor still replays. Invalid history, authority failure, or stale durable state must not publish a reveal. Do not weaken controller integrity, certificate validation, safety CAS, post-await checks, or secret wiping.

The source-only Claude review also needed two corrections against the pinned code. `contextStamp` serializes top-level context fields, including membership. `replayCertifiedPrefix` accepts an `onEntry` callback, so replay can capture the first result. `opensOn` compares a candidate stamp against the stamp saved when the controller opened; use that check alongside exact object identity to detect later mutation.

The review ran with Claude Code `2.1.283`, tools disabled, strict MCP isolation, and session persistence off. No saved games or production credentials were sent. The two raw responses and their source manifests are archived in [`terminal-checkpoint-review-evidence.tar.gz`](./terminal-checkpoint-review-evidence.tar.gz), whose SHA-256 is `14643a150dad0e2564ec96f37960941b2a2decc76351a3f01e81ff9188115e30`.

| Artifact | Path | SHA-256 |
| --- | --- | --- |
| Design brief | `/private/tmp/hexfield-terminal-checkpoint-review-brief.md` | `1b9003ad36438f12116c1c417b349f776d94674a6d0f2cec7447264103b3e601` |
| Initial prompt and pinned source excerpts | `/private/tmp/hexfield-terminal-checkpoint-review/prompt.md` | `6555a8078c79a9f77922e258364276b02c1b390038624014b7178df749b4fdcf` |
| Source manifest | `initial-source-manifest.json` in the archive | `2d89aa3668b57c028044258ad360e30e057b9dc6da27f2b9d9fcbba70673bf84` |
| Initial raw response | `initial-raw-response.json` in the archive | `f0b05489f8b74f0a4a55167a938c7b5aac8f1fb69dd879aab1ac38b77fdd722b` |
| Follow-up prompt and repair/export excerpts | `/private/tmp/hexfield-terminal-checkpoint-review/followup-prompt.md` | `8d5e6628b301a4c73600ec26e0c7e6277bb5912f6b92489f88021f5c593565c1` |
| Follow-up source manifest | `followup-source-manifest.json` in the archive | `ae8de3b681c0ef85d2eced1ac4261e4b495cf7c405695176843102781442d49b` |
| Follow-up raw response with repair and export excerpts | `followup-raw-response.json` in the archive | `a86b7f6f8dd0422a3a5b004231dfb831340eb6cd75a47c46d5013c7216a1395c` |

Both CLI calls completed with exit status 0 and no permission denials. The prompts, excerpt bundles and extracted responses remain in the temporary review directory; the raw responses and manifests needed to verify the review are in the repository archive.

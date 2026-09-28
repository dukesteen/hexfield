# Post-consent disclosure design review

Claude Opus 5.5, medium effort, reviewed the frozen source/design input with
all tools disabled. Root handle `38592` completed in 125.168 seconds. No product
code was implemented. The exact [input, source manifest, raw response and
disposition](disclosure-halt-design-review-2026-09-28.tar.gz) are retained; archive SHA-256:
`9f0904216549a3facb31e1f9c9db5114dad7ad1472d7ecec23deaf30216648be`.

The verdict is **DO NOT IMPLEMENT** the proposed all-original-human disposition
certificate. It adds no dependable liveness: the participant responsible for
compromising a share can veto it. Original signers also cannot override a later
certified controller or history. Disclosure subsets may differ, so an aggregate
evidence digest need not converge. A pre-play restriction cannot establish that
another peer has not already assembled genesis or committed entries.

The review distinguishes the requirement from the unchecked note. The stated
criterion does not require normal gameplay resume; current normal coordinator
and resume paths preserve the promise/evidence and halt safely. The phrase
“until assembled or agreed disposition” is ambiguous because neither exit is
implemented after disclosure. The reviewer recommends defining restart-safe
disclosure halt explicitly rather than inventing a new certificate.

The actionable safety question is whether every activation path observes the
existing durable disclosure. Transferred resume bypasses the ceremony, and a
second coordinator may already be opening or playing. The reviewer requests
focused fail-before checks of these paths before changing security behavior.
A monotonic device-global marker is only a conditional proposal if retained
evidence cannot provide a shared reliable fence. Such a fence must cover signer
acquisition, hosted bots, post-await activation and restart; it must preserve
irreversible consent and never disclose additional recovery shares. A pre-dispute
export on another device cannot know evidence it has not received.

The nine suggested regressions are a mapping checklist, not authorization for
nine duplicate fixtures. Existing genuine disclosure, restore, invalid-envelope
and consent-abort tests will be mapped first. Transferred resume and shared-store
cross-coordinator behavior are the first reproduction targets. Requirement
wording and any security change remain subject to root coordination/review.

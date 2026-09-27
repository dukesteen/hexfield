# Recovered-game audit check

A four-human verified game loses seat 0 and activates its recovered bot under a replacement signing key. Three live P2PSessions then use the existing deterministic bot strategy to complete legal setup and gameplay. The test forces one legal development-card purchase so it also verifies the recovered unlock signer fix: every surviving peer commits the first draw and the drawer can read its private card.

The bounded acceptance passed in 134.85 seconds, within the unchanged 120-step and 180-second limits. It submitted 72 commands and reached a real public-VP victory for seat 3 at turn 17. All three surviving sessions completed audits using all original masters, including the departed seat's master loaded through durable recovery. Reports have no missing seats, violations, input errors, history errors or audit errors.

The exact 109-entry certified history was then loaded into the native Chrome development audit page. Its actual disposable browser worker completed in 43.80 seconds, within the 60-second deadline, and its report exactly matched the Node result. Terminal and final head are seq 109, hash `69b41082154e8101ac6c19cb54bb4ac4329200d44c7a5e6d92db363954a3d675`. The source fingerprints and fixture hash are in [the check record](recovered-game-audit-check.json). The temporary fixture contains deterministic test master material and is excluded from Git; it is not a release asset.

This verifies one honest recovered game and the native worker. It does not prove all chaos/adversarial cases, cross-device recovery, proof-performance budgets, or production online setup. Milestones C and D remain incomplete.

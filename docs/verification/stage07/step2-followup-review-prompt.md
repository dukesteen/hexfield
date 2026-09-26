# Beacon review follow-up

Review the attached correction to issue 1 from your earlier beacon review and the
strengthened tests. This is read-only; do not run tools, write code, access other
files or external services. The user has authorized these project reviews.
The packet contains source/design and public test fixtures, no actual game secrets
or credentials.

The source now derives initial and extension chains deterministically from a
retained canonical master, ceremony ID, seat, epoch and length. It copies inputs,
bounds cached epochs and clears mutable buffers on eviction/disposal. The outbox
contract requires this deterministic lifecycle. A crash-before-write test recreates
the provider, certifies its identical extension and prepares a valid reveal from
another fresh provider. Source/signing failure has a separate error code.

Check the fix for secret/tip mismatches across restart, parameter mutation, cache
eviction, disposal and canonical input handling. Stage 10 still owns durable
master storage. The provider cannot repair a lost or replaced master.

Also inspect the stronger duplicate regression, pending/fixed/label negative tests,
and the new extension-result system-type guard. The registry is trusted module
code, not network registration. Base rules support two through four seats and
reset the balanced dice deck at six or fewer cards before creating a pending
request; those engine snippets are included to resolve your conditional findings.

Report confirmed remaining defects with a trace. State whether the extension
lifecycle issue is addressed under the documented provider contract. Do not
write replacement code or imply that the later deck/hand/steal/recovery work is
complete. There is no request for a fresh review of the accepted voting algorithm.

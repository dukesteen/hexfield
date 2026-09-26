# Deck foundation correction review

Review this packet read-only. Do not use tools, write code, open other files or
contact external services. The user approves all project Claude reviews. The
packet contains source, design and deterministic public fixtures, with no real
credentials or game secrets.

This is a follow-up to the attached first review, not acceptance of Stage 07.
Check the response against the current source and tests. Concentrate on whether
H1, H2 and M3 are closed, including concurrent calls, retries, the drawer's own
position reservation, conflicting valid setup predecessors and mutable inputs.
Check whether the new tests actually reach the intended cryptographic checks.
Report any remaining concrete failing trace and severity. Do not write code.

The foundation is not yet attached to the certified log or live session. A
locally verified setup and certified request remain caller requirements. The
next integration must compare catalogue/roster to genesis and enforce one-time
positions and owned slots before votes. Explicitly separate missing integration
from a defect within these helper contracts. The three-second Chromium target
remains open; the retained diagnostic is about nineteen seconds including locks.

The shuffle implementation is unchanged since the first review; only its
negative tests were extended. All 64 rounds, proof bytes and secret-safe
multiplication remain unchanged.

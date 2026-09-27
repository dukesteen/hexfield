# WebRTC reconnect follow-up review

Read-only review of the supplied source; tools disabled. Do not claim to execute tests.

Check the attached previous follow-up findings F1 through F9 against current code. The wire now signs a per-construction random sessionId and increasing attemptSeq. Per-peer high-water and retired-attempt sets are bounded. It does not compare wall clocks or order random IDs for freshness. Pre-auth attempts have a default 30-second deadline. New canonical-initiator offers can replace one-sided authenticated/stalled links, with a bounded replacement rate; replays must not permanently suppress honest attempts.

Check early candidate queue limits, answer generation before isolating bad queued candidates, negotiation errors closing the attempt, game-channel high-water backpressure with a separate control hard cap, inbound traffic liveness, HELLO binding to the binding actually sent, canonical envelope detachment, and security failure diagnostics. Verify fake connections need both SDP directions before opening and regressions discriminate asymmetric closure and delayed negotiation.

The previous Chrome iframe smoke demonstrated six native links and a 1 MiB transfer, but is older source and was same-origin, not four independent browsers. No browser acceptance is claimed for these new fixes. Signaling-server, manual/relay codes, lobby and browser persistence remain separate unfinished work and are excluded from this packet.

Report concrete defects, minimal fixes, and meaningful missing regressions. Explicitly confirm fixes that hold. No real credentials or secrets are included.

# Ceremony step deadline review disposition

The review used `return-phase-review-manifest.json`. Its unchanged response is `return-phase-review-raw.md`. The fixes below followed that snapshot.

1. Completed restore now checks the durable consent barrier before replaying any phase. Normal restart does the same, even if the current deadline has not expired. The completed-restore regression advances the clock by 20,001 milliseconds before reopening and still obtains the exact result and ready state.
2. Escrow enters its durable phase before producing or waiting for sealed envelopes. The dropped-share and ACK restart regression now holds approval delivery for 15 seconds, then waits another 10 seconds in escrow. It still completes with byte-identical retries.
3. The attempt-lock deadline check before the phase CAS is the transition instant. A slow storage CAS does not relabel the new phase as expired. No output is possible until the transition is durable, and output checks its current deadline before signing and sending.
4. Every ordinary packet send now checks the phase deadline immediately before transport enqueue, including after waiting for the escrow lock. A focused test persists a real private envelope, advances the clock past its deadline at that lock, and observes retirement with zero envelope sends.

The original 20-case ceremony file passed before these review fixes. The three changed restore, escrow-restart, and late-send cases passed after the fixes. Protocol type checking and scoped lint passed. The new deadline behavior still needs a native startup check before the four-human takeover and return test can count as acceptance.

The durable phase never regresses during transcript replay. Same-phase retries retain the original start time. A timeout callback carries both phase and start time, then checks them again under the attempt lock before retirement. A durable consent prevents retirement. Retirement cause and phase are diagnostic fields; they do not grant signing or game authority.

# Recovery design review response

The read-only Claude review covered the proposed ceremony coordinator and the
next recovery design. Membership authorization and activation are not implemented
by this checkpoint.

1. Completion belongs in the same CAS registry as retirement, with mutually
   exclusive completed and retired markers and permanent master reservations.
   The coordinator implementation is adding that transition. A separate flag
   would not order completion against another tab's retirement.
2. Genesis consent is irrevocable. The coordinator must reserve an exact digest
   in the registry before signing, refuse later local abort, and retain later
   authenticated disclosure evidence. A valid ACK alone does not prove an honest
   plaintext. Post-consent misconduct still needs agreed handling after genesis;
   it cannot revoke an already sent signature. The implementation is adding this
   phase and forbidding a local complaint after its exact accepted-share record.
3. Recovery needs a current controller-signature resolver separate from frozen
   cryptographic statements. This was required by the design but remains a
   concrete implementation gap in count, steal, deck, beacon and proposal paths.
4. Membership entries must bypass ordinary pending-operation gates. Recovery
   will first require completed genesis deck certification. It must preserve
   pending draw, beacon, count and steal records.
5. Fresh replacement keys must be durable before readiness. The design now
   includes certified amendment of a pending recovery and fresh-key human return.
   Neither restores secrecy nor lowers a share threshold.
6. Readiness binds the parent, releases bind the authorization entry, and the
   activation check binds its parent. These avoid circular hashes. The design
   now states that recovered encryption keys can open other dealers' shares held
   by that seat. Honest release policy remains mandatory, but cannot undo this
   loss of confidentiality against collusion.

Focused regressions and a code review are still required for the coordinator.
The design review is not evidence that recovery is implemented or accepted.

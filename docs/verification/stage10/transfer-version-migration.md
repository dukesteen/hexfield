# Protocol v4 rollout for seat transfers

On 2026-09-27 the user explicitly waived protocol backward compatibility.
The transfer release makes a clean upgrade to protocol v4. New and resumed games
must use the current version; v3 games are unsupported. Do not rewrite old genesis,
certificates, private material or safety records to pretend that they are v4.

The current exact-version checks remain in genesis, lobby handshake, online seat
bindings, ceremony construction and saved-game loading. An old save stays on disk
and receives the existing unsupported-version message. Mixed-version lobby peers
receive the existing version-mismatch diagnostic.

Every verified v4 game initializes replay-derived transfer state from its signed
genesis device bindings. Membership validation accepts only the strict recovery
and transfer variants. Authorization, cancellation and activation are certified
under the current voter set. Replacement authority begins at the next height.
No optional caller flag may grant a destination voting rights.

Keep the current signed hash domains. The protocol version already participates
in the genesis body digest and deck ceremony identifier. A v4 game therefore
requires a fresh lobby freeze, per-game keys and ceremony material. The storage
wrapper version is independent of the game protocol and does not need to change
just to reject unsupported games.

Required focused checks:

- Old and unknown genesis versions fail admission before gameplay.
- Current-version transfer entries pass certified replay only with valid owner,
  destination and quorum signatures.
- Authorization leaves old voting authority active; activation retires old keys
  and enables fresh keys only at the next height.
- Cancellation reserves the proposed keys and rejects earlier authorization
  anchors after the certified membership change.
- Unsupported saves remain untouched and show the version error.
- New lobbies reject peers using a different protocol version.

The old-version compatibility branch and historical replay migration are outside
the requested scope. The local core uses `MEMBERSHIP_SUBMIT` for strict recovery
and transfer messages; the old recovery-only wire envelope is not retained.
Durable transfer promotion, private delivery, routing and user flows still
require integration and acceptance evidence.

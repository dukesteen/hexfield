# Escrow lifecycle and disclosure review

Read-only security/correctness review of the supplied source. Tools are disabled. Do not claim to execute tests.

Check the new escrow-lifecycle wrapper. Every original human must approve the same locally pinned frozen manifest. Distribution derives private retry entropy from the master under a dedicated label, reserves the master for one ceremony in a device-global durable CAS registry, and persists exact envelopes before return. Conflicting ceremony reservations cannot both win. Abort tombstones a ceremony even before reservation and atomically retires every local dealing master in it. Dispute verification must authenticate raw signed evidence before any retirement; both a bad-share verdict and a valid-DLEQ false complaint expose a share and retire the ceremony.

The prior escrow reviews and response are included. Check N1 private dispute proof seed, N3 detached genesis and typed verdicts, the discriminating reduced-degree envelope test, canonical 43-character padding-bit test, dealer-signature-before-disclosure tests and copied-point-plus-proof rejection. Codec source is now supplied. Root also moved revealed-master base64 decoding inside its Result failure boundary.

Review storage races, retained-byte integrity, registry sizing and idempotence. The local registry has a 16 MiB bound, distinct from the 256 KiB network message bound. Both reserve and retire validate schema and size before writes. Invalid retirement IDs must not corrupt storage. Test doubles are not browser durability adapters. Production storage must be device-global and transactional across tabs for the local identity.

Known remaining scope: network ceremony delivery and private-share persistence before ACK, complaint publication after abort, browser-backed lifecycle storage, authorized recovery share release, voter replacement/activation, current beacon-extension verification, private-hand reconstruction and complete post-game audit. These are not implemented by this slice. Pure helpers are not exported to app entry points. Do not treat optional policy callbacks as authorization.

Report concrete remaining defects with traces, minimal fixes, and meaningful regressions. Distinguish future integration from bugs. No actual game secrets or credentials are supplied.

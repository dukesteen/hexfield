# Redesign merge verification

Verified locally on 2026-09-27.

## Integration

- Multiplayer checkpoint: `d2c2f5d`.
- Merge: `b969b15`, merging the local `feat/redesign-assets` branch through `c0b0cdf`.
- Includes the complete asset/UI redesign, readable dice and resource-delivery timing, and centered production-token pulses.
- The lobby translation conflict keeps the redesigned wording and all transfer messages. Protocol, transport and storage implementation files are unchanged by the merge.
- Reconnect, resume and transfer screens now use the new theme. The lobby background, primary buttons and ready-state text follow both explicit themes and the system preference.
- Verification details live in the game menu. The mobile hand dock has one continuous background.

## Checks

- Full production/test type checking and production build passed.
- Tracked-file type-aware lint and formatting passed. Unrestricted `pnpm lint` and `pnpm format:check` also scan the existing untracked `.redesign` source kit, which has independent lint/format violations; that kit was left unchanged.
- Dependency boundaries, engine purity and translation-key checks passed. The translation check reports existing unused keys.
- 44 focused web/renderer test files: 164 tests passed. Covers online components, transfer browser/exchange/channel/records, worker requests, current-device transport routing, renderer layout, animation timing and production-card delivery.
- Presence, takeover and recovery membership: 8 tests passed.
- Recovery replica: all 8 cases passed in bounded focused runs. Fixtures now certify absence, observe the required local waiting interval and choose a valid surviving proposer where necessary.
- Peer-session recovery: 1 test passed.
- Transfer membership/session, transfer import storage and game/worker transport: 28 tests passed in a grouped rerun. Some transport cases also appear in the web test count above.

## Chrome checks

- Created and started a real two-player game using local signaling and separate browser origins.
- Disconnected a peer, checked the redesigned reconnect notice and connection dialog, then resumed that peer from its saved game. Both peers showed connected.
- Confirmed a settlement on the board after reconnecting. The other peer showed the host at 1 VP with 4 settlements remaining.
- Checked dark/system and light game styling, the corrected dark lobby background, and the 390 × 844 mobile hand/reconnect layout.
- Opened verification details from the hamburger menu and closed them successfully.
- Opened the transfer dialog and cancelled the unapproved attempt; the original device retained control.

The three-device certified transfer acceptance flow was not completed in this merge check. The remaining milestone acceptance items are tracked in [remaining-acceptance.md](./remaining-acceptance.md).

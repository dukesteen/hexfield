# M-C and M-D closeout

Completed on 2026-09-28 under the [bounded acceptance policy](p2p-acceptance-policy.md)
and the user's final device-check waiver.

## Evidence

- [M-C requirement map](stage09/mc-remaining-acceptance.md): agreement, all nine real-crypto fault scenarios, hidden information, signed misconduct handling, performance targets, both connection modes, lobby, bots, timers and chat.
- [M-D requirement map](stage10/remaining-acceptance.md): durable recovery, all five lifecycle faults, private-state reconstruction, measured refresh, takeover and return, certified cross-browser save transfer, encryption and history.
- [Main CI](https://github.com/dukesteen/hexfield/actions/runs/36422582543) passed static checks, builds, all four unit shards and the recorded network checks. Broad E2E was skipped as requested.
- [Signaling](stage08/mixed-engine-followup-36422582118.md) and [manual-code](stage08/mixed-engine-manual-pass-36430074221.md) games finished in Chromium ×2, Firefox and WebKit with matching results and four successful independent audits. The final manual run took 192.149 seconds within the unchanged limit.
- The [protocol v6 release](cloudflare/protocol-v6-release.md) is deployed at <https://hexfield.steenbakkers.cc/>. Its assets match the tested build; live signaling and two-profile startup/placement checks passed.

The maps preserve each trace's source revision and scope. Application code is
unchanged from the deployed `9652085`; subsequent commits through `5a4e2ca`
contain test-driver and evidence updates.

## User waiver

After being told the only remaining work was the physical phone QR scan and
cross-network check, the user instructed: “you can just mark that one as done.”
That combined manual check is closed by waiver. It was not run, and no physical
scan or external-network pass is claimed. Compact-code sizing, native browser
connections and the four-engine manual-code game remain the observed evidence.

No M-C or M-D acceptance work remains under that instruction. Earlier reports
retain their historical failures, pending items and measurement limits.

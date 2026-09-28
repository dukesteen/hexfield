# Current-source mixed-engine manual-relay full game

[CI run 36430074221](https://github.com/dukesteen/hexfield/actions/runs/36430074221)
passed the manual-relay full-game test on commit
`1fe220adba4cc41e2117cb6abe6cacd60113a944`. Build, Playwright browser
installation and startup completed in Chromium ×2, Firefox and WebKit. The
runMode finished in 192.149 seconds, including 32.584 seconds of play and
20.964 seconds of audit.

After setup and the first roll, the driver accepted 19 legal commands without refusals: eight `END_TURN`,
eight `ROLL_DICE`, two `BUILD_ROAD` and one `BUILD_CITY`. All four browser
views reported a terminal result and complete audit at the same final head:
sequence 54, hash
`d5c6378eb20ff024a204a8c8391bffe1155ef63d7888dd01fc138a12be04224d`. This
passes the current-source mixed-engine manual-relay full-game criterion for
this bounded trace. It does not establish physical-device, QR-scan or
cross-network acceptance.

The [public workflow log, metadata and Playwright report](mixed-engine-manual-pass-36430074221-artifacts.tar.gz)
are retained with SHA-256
`26c34e07ce3df0a49344361dde77631e1c106b85a79cde481c806b60b71336fc`.

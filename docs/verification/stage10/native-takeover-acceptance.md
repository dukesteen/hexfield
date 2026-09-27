# Native takeover and return checks

Full lifecycle acceptance is still open. These checks used protocol v6, signed signaling envelope v2, one installed Chromium process with four isolated contexts, real WebRTC, and localhost signaling on port 8909. The isolated source checkout was `/private/tmp/hexfield-takeover-acceptance` at baseline `8000f80` with the return fixes overlaid. `native-takeover-source-manifest.sha256` pins the source used for the latest full attempt.

The opt-in test is `apps/web/tests/online-takeover.e2e.ts`. It requires genuine setup, a turn number above zero before departure, certified recovery, an actual certified command from the recovered bot, return activation with fresh authority, and an actual certified command from that returned seat. It has a 270-second cap. It does not yet finish the game or collect terminal audits.

Observed results:

- A startup-only check passed in 38.4 seconds. Four humans reached the game route. This was concurrent with a separate functional headless crypto game, so the duration is not performance acceptance.
- An uncontended full attempt reached certified recovery, an actual bot command, and return activation. It then failed because the test read the game registry immediately after the destination URL changed, before the new screen loaded. Source UI showed the completed move; no page errors occurred. The test now waits for the game screen before reading the session.
- The next full attempt retired before opening. All four peers remained authenticated and signaling was ready. Every public startup snapshot reported `online-ceremony-retired`; there were no page errors. The former code lost the reason, so this result does not prove a timeout or a dispute.
- After adding durable retirement reasons, a startup-only check passed in 26.2 seconds. No retirement occurred in that run.

Logs remain at `/private/tmp/hexfield-takeover-v6-startup-diagnostic.log`, `/private/tmp/hexfield-takeover-v6-uncontended-native.log`, `/private/tmp/hexfield-takeover-v6-return-ready-native.log`, and `/private/tmp/hexfield-takeover-v6-reason-diagnostic.log`. Browser contexts and the test-owned Vite server closed after each attempt.

Source inspection found that the old timeout covered the whole ceremony, although docs/09 requires 20 seconds per step. The subsequent deadline change uses a durable monotone phase and start time. It is outside the native manifest above. Its virtual-clock tests cover a total ceremony longer than 20 seconds, same-phase retry and restart without deadline renewal, and post-consent waiting. A further native check must use that reviewed source before claiming takeover and return acceptance.

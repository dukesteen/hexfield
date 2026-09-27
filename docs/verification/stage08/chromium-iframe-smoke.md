# Stage 08 Chrome iframe smoke evidence

On 2026-09-27 at approximately 01:40 Europe/Vienna, the root agent used the existing Chrome UI to open `http://127.0.0.1:5187/dev/webrtc-smoke.html` and clicked **Run**. The page displayed, in order:

```text
PASS all six native links authenticated
PASS small message and 1 MiB bulk pattern delivered
PASS lost pair reauthenticated once
PASS Chrome iframe smoke complete
```

The Run button was enabled again after the page cleaned up its connections. The page uses four same-origin iframes as separate JavaScript globals inside one Chrome tab. Each peer has its own real `RTCPeerConnection`; the parent only routes signed signaling envelopes and does not forward application messages. The forced loss closes the tracked RTC connections at both endpoints of one pair and waits for one down/up transition and full mesh membership again.

The [pre-run source manifest](./chromium-source-manifest.sha256) pins the transport, harness, smoke pages, and Vite/Playwright configuration used for this observation. The local p2p suite passed 34 focused tests and scoped lint before the UI run. A subsequent p2p package build was blocked by an in-progress, unrelated protocol edit at `replicated-log.ts:299` (`recoverCheatCandidates` missing); the p2p build had passed before that edit.

After the observation, the [post-smoke manifest](./chromium-post-smoke-manifest.sha256) records two test-support changes: the browser harness exposes its existing functions on a typed `window.cp2pHarness` property, and the unrun four-context Playwright test loads that module through `addScriptTag` to satisfy test typechecking. The iframe smoke runner still imports and calls the same module exports. No transport, signaling, or iframe runner bytes changed between these manifests.

This observation establishes native WebRTC behavior for four same-origin iframe globals in one Chrome tab. It does not establish four isolated browser contexts, cross-browser behavior, deployed signaling, manual exchange, TURN, or in-mesh relay. The separate Playwright four-context test remains ready but could not run locally because the required bundled Chromium executable was absent and the installed Chrome process exited before page creation; no Firefox or WebKit process was launched.

# Chrome check with authenticated replacement

On 2026-09-27 the existing Chrome test tab ran the four-frame WebRTC check after
the authenticated replacement and deferred-offer corrections. The dedicated
Vite server was restarted because it had retained an older transformed module.
Before running, the served transport contained the pending replacement state
and the ownership check after down observers. The [13-file manifest](chromium-replacement-smoke-manifest.json)
was captured before the run and matched afterward.

The page finished with Run enabled and these results:

```text
PASS all six native links authenticated
PASS small message and 1 MiB bulk pattern delivered
PASS lost pair reauthenticated once
PASS Chrome iframe smoke complete
```

This uses native WebRTC in four same-origin iframe globals inside one existing
Chrome tab. It does not run isolated browsers, the signaling-server route,
TURN, manual codes or a cross-network connection. The browser's forced loss is
symmetric; replayed offers, one-sided loss and deferred replacement are covered
by the focused transport tests. No new browser process was launched.

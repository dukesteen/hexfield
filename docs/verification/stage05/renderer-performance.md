# Renderer performance proxy

Measured on 2026-09-25 against the card-picker checkpoint `c84ad6f` in headless Chromium on macOS arm64, with a 390×844 viewport, device scale factor 2, touch enabled, and 4× CDP CPU throttling. The test performs 90 drag moves and 40 wheel events. CPU throttling is not calibrated to a physical phone.

Two isolated runs passed the renderer lifecycle checks. Frame timing varied between them:

| Run | Gesture | Samples | Mean interval | Mean FPS | p95 interval |
| --- | ------- | ------- | ------------- | -------- | ------------ |
| 1   | Drag    | 287     | 19.22 ms      | 52.03    | 16.8 ms      |
| 1   | Zoom    | 90      | 17.78 ms      | 56.25    | 16.8 ms      |
| 2   | Drag    | 273     | 16.79 ms      | 59.57    | 16.7 ms      |
| 2   | Zoom    | 88      | 16.85 ms      | 59.33    | 16.8 ms      |

Both runs kept rebuilt layers at 9 and ended with no active effects, queued disposals, or browser errors. The second run recorded 129 rendered frames. The test checks those bounds and nonempty frame samples; it does not assert a 60 FPS threshold.

The first run's raw JSON was overwritten when the test was repeated to save its console transcript. Its rounded figures above come from the recorded tool output. The [second run's raw JSON](renderer-performance-proxy.json) is preserved separately from later CI execution. Its console log is `/private/tmp/hexfield-performance-final.log` on the verification host.

These results do not establish 60 FPS on a mid-range phone. The user explicitly chose to keep the physical-phone check pending on 2026-09-25.

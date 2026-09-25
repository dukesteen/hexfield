# Physical phone performance

The final Pages production build from `ce6bdd13bca7c4c18d717a368bee7af6562e1afc` passed the board-panning check on a connected Google Pixel 7 on 2026-09-25. Chrome was `154.0.8037.57`, the CSS viewport was 411 × 782, and device pixel ratio was 2.625.

The production build used `GITHUB_PAGES=true pnpm --filter @cp2p/web build` and was served at `/hexfield/` through an ADB reverse connection. The test opened a four-human local setup game, zoomed the board to 3.03×, and performed three alternating 1.8-second swipes using Android touchscreen input. The production renderer's frame counter and camera coordinates were read during trusted pointer events. Browser animation-frame intervals were sampled separately. Other browser tests were stopped during measurement.

| Pan | Active input | Rendered frames | Frames/second | rAF p95 | Intervals over 16.7 ms |
| --- | ------------ | --------------- | ------------- | ------- | ---------------------- |
| 1   | 1,793 ms     | 162             | 90.33         | 11.1 ms | 0                      |
| 2   | 1,782 ms     | 162             | 90.89         | 11.1 ms | 0                      |
| 3   | 1,786 ms     | 162             | 90.70         | 11.1 ms | 0                      |

Every swipe moved the camera by approximately 146 horizontal and 59 vertical CSS pixels. No browser errors occurred. Layer rebuild counts stayed constant during panning, with no effects or disposals left queued. The coordinator inspected the measurements and actual Android framebuffer captures before and after a pan.

The [summary](physical-phone-performance.json) includes the device information, production-build SHA-256 fingerprints, camera deltas, and frame counts. The [raw measurements](physical-phone-performance-raw.json) retain the sampled intervals. These [before](physical-phone-board-before.jpg) and [after](physical-phone-board-after.jpg) images show the board's movement; only the board area is retained from the Android screenshots.

These results measure application rendering and animation-frame cadence, rather than an independent display-compositor recording. They establish the required panning performance for this device and scene, not every phone or game state. The earlier desktop proxy remains documented separately.

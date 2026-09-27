# Eight-type hidden transfer timing in Chrome

Observed on 2026-09-27 in the existing Chrome browser, through the visible Run three samples button at `/dev/steal-proof-timing.html`. No separate browser process was launched. The worker performs three samples and terminates on completion or after a 15-second timeout.

The [source manifest](step5-chrome-worker-timing-manifest.json) was captured before the run. The [raw results](step5-chrome-worker-timing.json) were read from the completed page. Each sample uses eight resource types, counts 10 through 17, and selected index 107 of 108. Commitment setup happens before timing. Timed work covers actual proof generation and verification, with fresh synthetic proof inputs per sample. It excludes network, sealing, session delivery and UI animation.

| Sample |    Prove |   Verify |   Combined | Valid |
| ------ | -------: | -------: | ---------: | ----- |
| 1      | 868.3 ms | 449.1 ms | 1,317.4 ms | Yes   |
| 2      | 780.0 ms | 399.6 ms | 1,179.6 ms | Yes   |
| 3      | 757.1 ms | 399.9 ms | 1,157.0 ms | Yes   |

All three proofs verified. The 300 ms target is not met, including in the warm samples. This diagnostic is a performance failure, not Stage 07 acceptance. It does not establish phone performance or behavior across browser processes.

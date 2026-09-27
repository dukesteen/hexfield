# Stage 09 chat follow-up review

Read-only security and correctness rereview. Do not use tools or edit files. The user authorized Claude reviews. Source and deterministic tests only; no runtime credentials or private game records. The previous review identified six concrete issues, summarized in the attached disposition. This bundle contains the changed security-relevant source after fixes.

Challenge each claimed fix: ingress work before caps, per-sender fairness, durable duplicate suppression after seen-cache eviction, cross-instance mute merges, handled async receive errors, and fan-out after a failed recipient. Check for new races caused by cached roster updates or lobby-to-game switching, especially stale authorization after a kick and scope changes while packets wait in the queue. Check that a duplicate still-retained packet cannot be broadcast by the local sender or corrupt restore. Note any actual remaining data-loss/liveness defect in the bounded noncertified chat design.

For every confirmed issue report severity, file:line, concrete sequence, and smallest safe correction. Distinguish confirmed bugs from intentionally bounded history and missing browser evidence. Do not assume device-key forgery or recommend chat in the certified log. If the fixes are sound, say so plainly.

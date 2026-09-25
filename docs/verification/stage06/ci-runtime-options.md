# Network simulation CI policy

The repository enables bounded full-game simulation checks with deterministic,
non-overlapping game-index ranges.

- Every push and pull request runs five games for each of the nine network
  scenarios.
- The nightly schedule runs twenty games per scenario. Its base game index is
  twenty times the UTC day number, so adjacent nights cover distinct ranges.
- The first Stage 06 acceptance gate is twenty completed games per scenario.
- A manual workflow dispatch defaults to twenty games per scenario and index
  zero. It accepts one to 1,000 games per scenario and a non-negative safe
  starting index. Requests are split into forty-game jobs, each bounded by a
  90-minute timeout; invalid or overflowing ranges fail in the matrix planner.
- Each game uses seed 42 and its deterministic game index. The simulator emits
  source provenance, completed/failed counts, final hashes and measured timing.
  Failed shards upload their JSON output for diagnosis and block deployment.

Local timing measured on 2026-09-25 with Node 22.23.3 was 32–45 seconds per
complete four-peer game across the initial fault scenarios. GitHub-hosted
runner time may differ. The scheduler shards large manual runs so an individual
job stays well below GitHub's six-hour job limit; total runner use still scales
with the requested game count.

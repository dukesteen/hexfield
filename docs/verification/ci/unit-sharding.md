# Unit-test runner split

Date: 2026-09-27.

The no-E2E release run completed its network scenarios and simulations while the
serial unit-test job was still running. CI now gives four independent runners a
Vitest shard each. Each runner retains one test worker, which avoids CPU
contention between expensive cryptographic fixtures. Deployment waits for every
shard as well as static checks, coverage and both simulation jobs.

The manual `skip_e2e` option is unchanged. It skips browser installation and E2E
only. Unit tests and engine coverage remain required.

Validation: workflow YAML parses, formatting passes, and the installed Vitest
sequencer partitions the 296 discovered test files into four groups of 74 with
zero duplicates or omissions. This checks suite allocation without rerunning the
expensive suite locally. CI wall-time improvement still needs a completed
sharded run.

# Takeover approval and presence review

Read-only security and design review of the attached frozen source and proposal. The user has authorized Claude reviews for this project. Do not use tools, inspect other files, run code, or edit anything. The packet contains only source and deterministic fixture keys, no runtime credentials or private game records.

Separate confirmed bugs in the current recovery gate and host facade from concerns in the proposed policy/presence migration. Give each confirmed issue a severity, `file:line`, a reachable sequence, and the smallest sound correction. Identify assumptions where source excerpts are insufficient instead of inferring behavior from missing lines. Do not recommend a weaker public validator or a timer-dependent replay rule.

Review these questions:

- Does the current local approval gate cover every new positive recovery-authorization vote before safety CAS, including rounds, locks, restore and retained proposals? Can an authenticated `RECOVERY_SUBMIT` received before approval be approved by a different elected proposer and still make progress? Can a competing candidate overwrite the displayed or retained exact candidate?
- Does `requestTakeover` reserve fresh replacement keys durably before any signed authorization leaves the device? Is the prepared-readiness loader bound to the exact certified parent, host, departure, bot level, replacement keys and signatures? Can a stale, corrupt, or concurrent record silently rebase or leak a secret?
- Does the proposed `takeover` field actually bind the host's lobby edit, all freeze ACKs, online seat bindings and verified genesis? Is a protocol version bump and explicit rejection of old saves sound? Call out any hash-cycle or ordering mistake.
- Can `seat-offline` and `seat-online` be validated deterministically from certified context while the 15-second marker gate and configured signed takeover delay remain honest local voting rules only? Does the signed return proof bind the current human controller, exact parent, generation and particular offline marker after key rotation?
- What happens when a target reconnects just before or after an authorization vote is durably stored? Distinguish stopping future signatures, canceling an uncommitted intent, a signed vote that cannot be revoked, and a certified removal. Check quorum-aware pause and restart-conservative timing for two-, three- and four-human games.

The live regression in the packet uses a request host different from the current elected survivor proposer. It observes the valid candidate and no takeover proposal before approval, then a certified old-quorum authorization after all survivor approvals. Treat that test as evidence for its exact scenario, not as proof of every race. The proposed policy and presence code is not implemented yet.

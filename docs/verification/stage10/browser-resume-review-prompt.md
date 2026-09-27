# Browser resume implementation review

Read-only security and correctness review of the attached frozen source. The
user has authorized all Claude reviews for this project. Do not use tools,
inspect other files or edit anything. Source and tests contain deterministic
fixture keys only, not live credentials or private game records.

Review the new saved-game resume path and the corrections to the previous online
ceremony review. Focus on concrete bugs that could sign or transmit before
restoring the original authority, silently replace a safety record, lose an
authenticated dispute, open the wrong room, or make an ordinary saved game
impossible to resume.

Check these boundaries:

- `OnlineRoom.open({kind:'resume'})` loads the existing device and signed start
  record, pins the frozen roster and acquires the original room lease.
- Saved game records have immutable canonical bytes, a bounded public catalogue
  and pointers; listing uses structural validation without proof replay, while
  actual resume verifies signatures, genesis state and all deck transcripts.
- `OnlineStartup` requires existing freeze/agreement/start pins and original
  secrets, restores a completed ceremony, drains queued messages, and opens the
  journal in restore-only mode. No missing record authorizes replacement keys.
- `OnlineCeremony` subscribes before replay, suppresses output until validated,
  checks durable completion, restores exact evidence, and halts on genuine
  secret disclosure. Recheck the corrected durable abort/consent race and the
  distinction between objective invalid envelopes and secret disclosure.
- Cancellation, writer contention, duplicate route opens and failures during
  close must not leave an unintended voting session active.

State each confirmed issue with severity, file/line, a reachable sequence and
the smallest sound correction. Separate missing coverage from confirmed bugs.
Do not classify separately tracked manual signaling, public hosting, seat
transfer, recovery UI or browser acceptance as implementation bugs. Do not
recommend replay shortcuts that weaken the voting journal or proof checks.

The prior review response and disposition, plus current checkpoint, are included
for context. They are claims to check, not proof. If no blocking issue remains
in this delta, say so plainly. Identify any follow-up needed before browser
acceptance without requesting an unbounded new testing programme.

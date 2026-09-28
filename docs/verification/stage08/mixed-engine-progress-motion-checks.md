# Mixed-engine progress and reduced motion

Manual-relay CI 36425753132 reached a matching certified terminal state, with all four audits verifying by about 290 seconds. The 300-second overall deadline cancelled the test before its nested finish poll could report the command histogram. This is not a passing acceptance run and does not establish an audit deadlock.

The driver now retains copied public command/refusal counters through a synchronous callback outside the finish function. The existing ten-second progress log includes those counters, elapsed play/audit times, certified heads, result presence and audit kinds. Phase transitions emit immediately. Logs survive outer timeout cancellation without depending on catch-block completion.

All four contexts request the normal production reduced-motion preference. This disables optional animations while retaining renderers, real rules, cryptography, session submission and all audit assertions. The 3VP target, 150-second finish deadline, 300-second manual overall deadline, 240-second signaling deadline, 45-second mesh bound and existing bot policy remain unchanged.

Shared test typechecking and scoped type-aware lint passed. No browser or full-game rerun was performed for this change. Manual mixed-engine acceptance remains open.

The prior failure evidence is archived in [mixed-engine-36425753132-evidence.tar.gz](mixed-engine-36425753132-evidence.tar.gz), SHA-256 `a79ff9df568d2f6c3c3ab0fd1a09e65634bd21dbb33db9b7c5ef2ef5a4d1203e`.

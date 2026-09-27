# Transfer browser coordinator review

Read-only correctness and security review of the attached pinned source and tests. Tools are disabled. Return concrete findings with file/line, severity, failure trace and a minimal correction. Separate proved issues from assumptions. Do not request secrets, actual user data, or unrelated files.

The signed protocol v4 transfer core already has separate reviews. Review the new browser coordinator, public progress records, temporary signaling/WebRTC link, worker importer and exchange together. The UI is being connected separately; a missing route or button is not a finding for this packet. No backwards compatibility is required.

Check these requirements:

- The source explicitly chooses one authenticated destination and confirms its signed offer before authority changes or private disclosure. Public retry records cannot replace an approved statement or destination after reload.
- A staged destination has no game transport or voter. Private material is handled only in its worker. Promotion needs the exact verified certified activation and durable import, then importer shutdown before ordinary resume.
- Old and new devices cannot both vote. Source retirement does not prematurely kill the separate channel or prevent final public certificate export/status checks.
- Browser retry and reconnect are idempotent across partial delivery, lost final receipts, reload, and cancellation. The source only reports completion after a receipt naming a matching certified outcome. Failure is not cancellation.
- Storage failure, writer contention, lease loss, close, replaced links, repeated artifacts and out-of-order callbacks cannot leak workers/keys, silently replace authority, or permanently strand a completed handoff.
- Work and messages remain bounded; duplicate delivery cannot cause unbounded work or change the chosen transfer.

Focused tests pass for real worker import/restart/promotion, public record pins, query cleanup, link reconnect, delayed old-link callbacks, and lost-final-receipt retry. A native three-browser test is being prepared and is not yet evidence. Look for gaps the existing tests miss. Do not redesign consensus or treat a smaller test as proof of complete milestone acceptance.

The source intentionally retains historical durable credentials needed for certified return/recovery; every resumed signer verifies current authority. The existing strict-agreement rule requires all voters in two-/three-human games and permits a four-human quorum of three. Signaling carries opaque data and provides no authority.

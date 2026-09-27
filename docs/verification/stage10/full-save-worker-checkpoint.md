# Full-save worker checkpoint

Date: 2026-09-27. Builds on the reviewed
[HXFS1 format](hxfs1-review-disposition.md).

Export takes a saved game ID. A one-shot worker reads and verifies the durable
journal and historical safety. Public-only export does not load a device
identity. Private export requires a passphrase and includes only masters the
current certified controller hosts, plus accepted escrow shares. Recovered bot
masters must match the certified recovery authorization and activation. Missing
current material fails the export. Temporary keys and masters stay inside the
worker and owned byte buffers are wiped.

Import validates the full file before publishing its immutable manifest in a
separate namespace. Encrypted private files require the correct passphrase on
import. A display catalogue is published afterward; retry can repair a failed
catalogue write without replacing the verified file. Every open verifies the
stored file again and returns only public board/history data marked read-only
and paused. No imported file installs a voting key or live journal.

Private jobs share a cross-tab Web Lock to avoid overlapping key derivations.
The client bounds transferred file bytes, times out failed workers, terminates
each worker after its response and supports aborting a read. TanStack Query hooks
provide the UI data boundary.

Five focused tests passed serially in 27.6 seconds. They cover a real bound
private export with accepted escrow, passphrase failure, manifest/catalogue
retry, a certified recovered-bot master, missing recovery material and client
worker handling. Web TypeScript, scoped type-aware lint, formatting and diff
checks passed for the frozen backend slice.

The UI, native file round-trip and certified fresh-key resume from an imported
save remain separate work. Export encryption does not encrypt live browser
storage.

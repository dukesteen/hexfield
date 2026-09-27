# Full-save UI and browser checkpoint

Date: 2026-09-27. Builds on the [isolated worker path](full-save-worker-checkpoint.md).

Saved games and the in-game menu now offer full-save export. Public history and
historical safety are the default. Including private masters and escrow requires
an explicit checkbox and a 12–1024 character file passphrase. Home accepts bounded
`.hxfs` files and distinguishes missing or incorrect passphrases from invalid
files. A successful import opens a verified, read-only snapshot with the board,
players and event log. It does not install a live journal or a voting key.

Six focused component tests passed. Translation-key and dependency checks pass;
scoped type-aware lint, formatting and diff checks pass. The native Chrome test
`apps/web/tests/online-full-save.e2e.ts` passed in 15.5 seconds, 16.9 seconds including
the runner. It seeds a disposable signed four-human public history and its safety
record, exports through the actual dialog with private data unchecked, downloads
and imports the file, reloads the resulting route, and checks a 390×844 viewport
for horizontal overflow and game actions. The development-tool buttons are outside
the app assertion. No private real-game data is used.

Visual inspection of [the export dialog](public-export-dialog.png) and
[the mobile snapshot](imported-save-mobile.png) confirms the current theme and
readable layout. The first attempt was interrupted by a development-server reload
while source files were changing. The final check ran with all relevant source
owners holding their changes.

The browser trace exercises public export/import with the vault disabled. Private
file validation and encryption have focused worker/format tests; they are not
claimed as a private browser round-trip here. A certified fresh-key transfer from
an imported snapshot and an enabled local-storage vault remain separate work.

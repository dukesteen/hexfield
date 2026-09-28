# Cross-engine imported-transfer CI, 2026-09-28

The immutable evidence bundle includes public logs, Playwright reports and page
diagnostics for runs [36416108153](https://github.com/dukesteen/hexfield/actions/runs/36416108153),
[36416945252](https://github.com/dukesteen/hexfield/actions/runs/36416945252) and
[36417729313](https://github.com/dukesteen/hexfield/actions/runs/36417729313),
plus relevant source files pinned at commits `80133af` and
`98d8846`. Their commit/tree pins and source SHA-256 manifests are included in
the archive. SHA-256 for the full [evidence archive](cross-engine-transfer-ci-2026-09-28.tar.gz):
`41e90ab2d02d44726212399e36e0dc69fb830023413f1ec853d6c46b61f8fe52`.

Run 36416108153 at `8502469fb0bc51925c458c51c9be3025dba1fe0a` failed in both
destination engines before the imported view or transfer flow. Firefox stayed
on the landing page with the import form disabled while saved data was still
checking. WebKit showed the local-data-protection startup check on the landing
page. These first failures remain in the archive as historical diagnostics.

Run 36416945252 at `80133af2acd4172b11b9842286d27ce5e8657237` passed the actual
Chromium-source-to-WebKit-destination transfer in 104.481 seconds. This was a
real cross-engine pass, but Firefox in that run remained on the imported-view
readiness status described below.

Run 36417729313 at `98d8846619c604ebac1f489473325ecf8d2438fc` passed both
Chromium-source-to-Firefox and Chromium-source-to-WebKit transfers. Firefox completed in 100.708
seconds and WebKit in 83.374 seconds. Both public result attachments record a
fresh destination, read-only import before activation, stale pre-transfer
archive remaining read-only after activation, refusal of the retired source
after reload and after stale import, a peer-accepted destination command,
matching peer heads and no page errors. This verifies the Stage 10 “another
browser” transfer requirement and the stale-save refusal criterion in both
tested engines.

The Firefox failure in run 36416945252 occurred after the archive route loaded:
at 44.675 seconds the page still showed “Checking imported save…” and had no
page errors. It did not reach transfer invitation or peer negotiation. This
was an import-view readiness failure, not a transfer-protocol result. The
subsequent bounded retry passed with the read-only view wait and stale-archive
assertion; the overall 240-second test budget was unchanged.

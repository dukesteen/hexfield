# Trade delivery timing fixes

Review this exact snapshot read-only with no tools. The user authorizes Claude
reviews. The prior review and response are attached. Focus on the F1-F4 changes,
their boundary interactions and any remaining concrete High/Medium defect.

F1 now uses a separate four-distinct-request budget per peer per ten seconds for
trade proof production. Repair retains its independent three-request budget.
The existing per-finalizer/per-parent distinct cap remains three, and successful
requests are served from the exact response cache first. Failed generation can
retry after the work window expires; it is not blocked forever at that parent.
This permits the coordinator's initial request and three fresh-parent retries.

F2 waits through replica-side stale-parent errors until the session catches up;
it does not immediately rebuild the same body or spend the retry count. F3 checks
automatic/timer priority after receiving a response and after local preparation,
then checks the overall deadline before admission. F4 turns engine exceptions
into unavailable results; request and response receive paths do not attribute
those local failures to the sender.

The focused coordinator/planning tests pass. A strengthened live consensus test
for four distinct parents and same-parent proof regeneration after restart is
being checked separately; it is not included or claimed complete in this packet.
Do not request large random batches or review unrelated future stages. Report
explicit failing traces and the smallest necessary correction. Explain whether
the fixes address F1-F4 and whether F5's current-engine scenarios are actually
reachable, using the included base trade implementation.

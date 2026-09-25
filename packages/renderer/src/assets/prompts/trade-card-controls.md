# Trade card picker clarity review

Read `docs/design/style-guide.md`, `reports/stage05/trade-card-controls-reference.png`, `reports/stage05/trade-card-hover-alignment.png`, `apps/web/src/features/trade/ResourceCard.tsx`, `apps/web/src/features/trade/trade.css`, and the relevant card overrides in `apps/web/src/app.css`. Return a focused design and implementation recommendation; do not edit files.

The screenshot shows repeated “6 available” labels crowding under the cards and a tall floating circular minus control. The user likes the existing card-selection layout and the modal itself has already been fixed, so preserve that overall layout. The remaining goal is to make stock/count information easier to scan and integrate decreasing a selected quantity with the card.

Constraints:

- Desktop modal width is 680px, with two resource groups side by side and five cards per group; each card column is about 60px wide.
- At 390px phone width, the groups stack vertically and each group still has five columns.
- Tapping a card adds one card. Decreasing a selected quantity must remain an independent, accessible 44px touch target.
- Keep the selected quantity badge or recommend a similarly clear selected-count treatment.
- “Available” is the total currently held in the hand for the give side; it must not be described as remaining stock after selection. The want side must not disclose hand counts. Bank trade-rate units stay intact.
- Avoid tall floating minus buttons, repeated wording that runs together, and new dependencies. Use the existing original card SVGs; only recommend new SVG work if it materially improves clarity.
- Keep accessibility labels/status updates and 44px interactive targets.
- Hover/selection styling must not shift the card art relative to its clickable button. Current `.resource-card-name` can make a 48px implicit grid track expand to about62px; use an explicit `minmax(0, 1fr)` track and center the name without widening the resource-card grid item.

Return: (1) the concrete layout/control recommendation, (2) exact JSX wrapper/control additions or changes for the current ResourceCardPicker, and (3) scoped CSS selectors/dimensions that preserve the 680px desktop and 390px phone layouts. Make the stock amount visually quiet but unambiguous, and distinguish selected count from total in-hand count.

# Full-screen game results design

The user explicitly requested Claude's design help for the victory/end-game UI in this local board game. Give a concrete React/CSS design proposal; do not edit files or run commands.

Read only these task files:

- docs/design/style-guide.md
- apps/web/src/features/game/GameOverPanel.tsx
- apps/web/src/features/game/GameReadOnly.tsx
- apps/web/src/features/game/stats.ts
- apps/web/src/app.css
- apps/web/src/i18n/locales/en/game.json
- apps/web/src/features/dialogs/DialogFrame.tsx

The current end-game section replaces the Actions dock and is cramped. The user now wants a full-screen modal over the preserved game board. Keep the clean, legible game design, native sans-serif typography, existing light/dark tokens and simple original icons. No medieval ornament, gradients, confetti, decorative clutter, or new dependencies.

Requirements:

- Results automatically open once on game completion and when loading a completed game. Native dialog/focus containment, accessible title, Escape/View board dismiss. Provide an obvious Results control to reopen from the finished board. Preserve the board, hand and Actions layout behind the modal.
- Winner and final VP total are the primary information; all player scores, public identities and color/shape markers remain clear. Ranking must not override the actual recorded winner, since a losing player can have hidden points.
- Score bug report: user held 2 VP cards and saw Buildings 6, Awards 2, Revealed cards 2, End-game revealed VP cards 0. The calculation is correct: winning CLAIM_VICTORY already revealed those 2, leaving 0 additional hidden cards. We want the main score breakdown to simply show Buildings 6, Awards 2, VP cards 2, Total 10. Combine revealed and remaining hidden VP cards exactly once; preserve unknown totals if private end-game info is unavailable. Do not change engine rules.
- Keep final dice histogram and resources gained per player, preferably secondary to standings. Preserve Rematch, Export replay, async busy/error handling; View board should close the dialog.
- Full viewport modal, with header, independently scrollable content and fixed footer that never covers content. Desktop 1728x960/1280x720/1024x768, phone 390x844, landscape 844x390. Fit core winner/score/action content; use useful responsive layout and collapsible detail if needed.
- i18next for all UI text. 44px touch targets. Visible focus and both themes. Respect reduced motion if any entrance transition is suggested.

Return a compact, implementable visual specification with recommended DOM structure, responsive CSS measurements, hierarchy and key component snippets. Keep the existing scoring logic and public/private boundaries intact. Call out any concrete interaction issue you see in the current integration. No need to request user clarification; use reasonable judgment.

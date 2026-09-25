Design review only. Do not edit files.

The web app identifies players with an 18 × 18 px circle, triangle, square, or diamond. The triangle is broken in the live UI. The original CSS clipped a square border and inset box shadow, leaving a white horizontal bar and missing triangular edges. A first attempted fix used three nested CSS triangles; at actual size it looks like a mostly white wedge with a tiny orange stripe, and the user rejected it too. Inspect these screenshots if available:

- Original user screenshot: `/var/folders/gd/b0yk1bp93z398wwsgy13q29w0000gn/T/codex-clipboard-7iAE6d.png`
- Rejected updated user screenshot: `/var/folders/gd/b0yk1bp93z398wwsgy13q29w0000gn/T/codex-clipboard-oDffye.png`
- Full setup and player-panel captures: `/private/tmp/hexfield-marker-setup-desktop-dark.png`, `/private/tmp/hexfield-marker-game-desktop-dark.png`, `/private/tmp/hexfield-marker-game-phone-light.png`

Current CSS is in `apps/web/src/app.css` around `.player-marker` and `.marker-triangle`. Player colors are blue `#0072b2`, orange `#d55e00`, green `#009e73`, magenta `#b35b93`. The triangle is usually orange. It appears at 18 px in setup and player cards, including the compact phone player strip, and at 28 px in the results hero. Both light and dark themes matter. Existing circle/square/diamond are acceptable. The board renderer already draws a real triangular identity polygon; do not redesign the board renderer.

Please recommend one precise implementation that renders a balanced, readable, fully colored triangle with a continuous outline and a subtle white inset following the actual triangle. Avoid CSS border/box-shadow clipping and avoid concentric rectangular insets that shrink the colored center too far. An inline SVG polygon with stroke joins is welcome if it is better. Give concrete SVG coordinates or JSX/CSS and stroke widths for 18 px and 28 px, including anti-aliasing/line-join considerations. Keep the rest of the marker shapes and labels unchanged. Explain briefly why the proposed geometry solves the screenshot defect.

import type { GameState } from '@cp2p/engine';
import { engineForConfig } from '@cp2p/engine';
import type { BoardRenderer } from '@cp2p/renderer';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { uiModulesFor } from './registry';
import './index';
import './modules.css';

/** Render every registered HUD widget for the game's modules. */
export function ModuleHud({
  state,
  presentation,
  renderer = null,
  openFixture = () => undefined,
}: {
  state: Readonly<GameState>;
  presentation: GamePresentation;
  renderer?: BoardRenderer | null;
  openFixture?: (fixtureId: string) => void;
}) {
  const modules = uiModulesFor(state.config.modules.map((module) => module.id));
  if (!modules.some(({ ui }) => ui.HudWidgets?.length)) return null;
  const hints = engineForConfig(state.config).hooks.renderHints(state, []);
  return (
    <div className="module-hud">
      {modules.flatMap(({ id, ui }) =>
        (ui.HudWidgets ?? []).map((Widget, index) => (
          <Widget
            key={`${id}:${index}`}
            state={state}
            hints={hints}
            presentation={presentation}
            renderer={renderer}
            openFixture={openFixture}
          />
        )),
      )}
    </div>
  );
}

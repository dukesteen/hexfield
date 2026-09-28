import type { GameState, Seat } from '@cp2p/engine';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { uiModulesFor } from './registry';
import './index';

/** Render every registered player-panel extra for the game's modules. */
export function ModulePanelExtras({
  state,
  seat,
  presentation,
}: {
  state: Readonly<GameState>;
  seat: Seat;
  presentation: GamePresentation;
}) {
  const modules = uiModulesFor(state.config.modules.map((module) => module.id));
  return (
    <>
      {modules.flatMap(({ id, ui }) => {
        const Extra = ui.PlayerPanelExtras;
        return Extra
          ? [<Extra key={id} state={state} seat={seat} presentation={presentation} />]
          : [];
      })}
    </>
  );
}

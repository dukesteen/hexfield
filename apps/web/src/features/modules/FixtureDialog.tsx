import { engineForConfig } from '@cp2p/engine';
import type { GameState } from '@cp2p/engine';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { uiModule } from './registry';
import './index';

/** Open the owning module's dialog for a tapped board fixture, if it registered one. */
export function FixtureDialog({
  fixtureId,
  state,
  presentation,
  onClose,
}: {
  fixtureId: string;
  state: Readonly<GameState>;
  presentation: GamePresentation;
  onClose: () => void;
}) {
  const fixture = state.board.fixtures?.find((item) => item.id === fixtureId);
  const Dialog = fixture ? uiModule(fixture.module)?.Dialogs?.[fixture.id] : undefined;
  if (!Dialog) return null;
  const hints = engineForConfig(state.config).hooks.renderHints(state, []);
  return <Dialog state={state} hints={hints} presentation={presentation} onClose={onClose} />;
}

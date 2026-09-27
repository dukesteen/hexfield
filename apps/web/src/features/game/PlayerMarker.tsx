import type { GamePresentation } from '../../queries/repositories/saved-games';
import { getFactionUrl } from '@cp2p/renderer';

type PlayerIdentity = GamePresentation['players'][number];

export function PlayerMarker({
  color,
}: {
  shape: PlayerIdentity['shape'];
  color: PlayerIdentity['color'];
  hero?: boolean;
}) {
  return (
    <span className={`player-marker color-${color}`} aria-hidden="true">
      <img className="player-marker-crest" src={getFactionUrl(color)} alt="" />
    </span>
  );
}

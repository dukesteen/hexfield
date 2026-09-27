import { createFileRoute } from '@tanstack/react-router';
import { OnlineGameScreen } from '../../features/online/OnlineGameScreen.js';

export const Route = createFileRoute('/game/$gameId')({ component: OnlineGamePage });

function OnlineGamePage() {
  const { gameId } = Route.useParams();
  return <OnlineGameScreen key={gameId} gameId={gameId} />;
}

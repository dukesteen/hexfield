import { createFileRoute } from '@tanstack/react-router';
import { OnlineLobby } from '../../features/online/OnlineLobby.js';

export const Route = createFileRoute('/lobby/$lobbyId')({ component: OnlineLobbyPage });

function OnlineLobbyPage() {
  const { lobbyId } = Route.useParams();
  return <OnlineLobby lobbyId={lobbyId} />;
}

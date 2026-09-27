import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { OnlineAutoJoin } from '../../features/online/OnlineJoin.js';

const searchSchema = v.object({
  host: v.optional(v.string()),
  server: v.optional(v.string()),
});

export const Route = createFileRoute('/join/$roomId')({
  validateSearch: searchSchema,
  component: AutoJoinPage,
});

function AutoJoinPage() {
  const { roomId } = Route.useParams();
  const search = Route.useSearch();
  return <OnlineAutoJoin roomId={roomId} host={search.host ?? ''} server={search.server ?? ''} />;
}

import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { TransferDestinationScreen } from '../../features/online/TransferDestinationScreen.js';

export const Route = createFileRoute('/transfer/$code')({
  validateSearch: v.object({ archiveId: v.optional(v.string()) }),
  component: TransferDestinationPage,
});

function TransferDestinationPage() {
  const { code } = Route.useParams();
  const { archiveId } = Route.useSearch();
  return (
    <TransferDestinationScreen
      key={`${code}:${archiveId ?? ''}`}
      code={code}
      {...(archiveId === undefined ? {} : { importedArchiveId: archiveId })}
    />
  );
}

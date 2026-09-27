import { createFileRoute } from '@tanstack/react-router';
import { TransferDestinationScreen } from '../../features/online/TransferDestinationScreen.js';

export const Route = createFileRoute('/transfer/$code')({ component: TransferDestinationPage });

function TransferDestinationPage() {
  const { code } = Route.useParams();
  return <TransferDestinationScreen key={code} code={code} />;
}

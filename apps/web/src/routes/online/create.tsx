import { createFileRoute } from '@tanstack/react-router';
import { OnlineCreate } from '../../features/online/OnlineCreate.js';

export const Route = createFileRoute('/online/create')({ component: OnlineCreate });

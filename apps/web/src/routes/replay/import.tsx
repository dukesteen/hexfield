import { createFileRoute } from '@tanstack/react-router';
import { ReplayImport } from '../../features/replay/ReplayImport.js';

export const Route = createFileRoute('/replay/import')({ component: ReplayImport });

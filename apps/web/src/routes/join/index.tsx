import { createFileRoute } from '@tanstack/react-router';
import { OnlineJoinForm } from '../../features/online/OnlineJoin.js';

export const Route = createFileRoute('/join/')({ component: OnlineJoinForm });

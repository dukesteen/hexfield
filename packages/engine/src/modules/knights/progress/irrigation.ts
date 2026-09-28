import type { CardModule } from './card.js';
import { harvestCard } from './harvest.js';

/** Irrigation: 2 grain for each fields hex touching one of your buildings. */
export const irrigation: CardModule = { card: harvestCard('irrigation', 'fields', 'grain') };

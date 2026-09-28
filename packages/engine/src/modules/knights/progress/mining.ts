import type { CardModule } from './card.js';
import { harvestCard } from './harvest.js';

/** Mining: 2 ore for each mountains hex touching one of your buildings. */
export const mining: CardModule = { card: harvestCard('mining', 'mountains', 'ore') };

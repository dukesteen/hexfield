import { RESOURCES } from '../../../core/types/index.js';
import type { CardModule } from './card.js';
import { monopolyCard } from './monopoly.js';

/** Resource Monopoly: name a resource; each other seat gives 2 of it, or its only one. */
export const resourceMonopoly: CardModule = {
  card: monopolyCard('resourceMonopoly', RESOURCES, 2),
};

import { COMMODITIES } from '../config.js';
import type { CardModule } from './card.js';
import { monopolyCard } from './monopoly.js';

/** Trade Monopoly: name a commodity; each other seat gives 1 of it, if it has one. */
export const tradeMonopoly: CardModule = {
  card: monopolyCard('tradeMonopoly', COMMODITIES, 1),
};

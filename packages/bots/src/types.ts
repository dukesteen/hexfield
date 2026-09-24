import type {
  CommandShape,
  GameState,
  Pending,
  PrivateState,
  Seat,
  TradeOffer,
} from '@cp2p/engine';

/** Only the owner's secret state is available to a bot. */
export interface BotView {
  state: GameState;
  priv: PrivateState;
  seat: Seat;
}

/** Independent per-game, per-seat random stream. */
export interface BotRng {
  int(maxExclusive: number): number;
}

export interface Bot {
  id: string;
  decide(view: BotView, pending: Pending, rng: BotRng): CommandShape;
  respondToTrade?(view: BotView, offer: TradeOffer, rng: BotRng): boolean;
}

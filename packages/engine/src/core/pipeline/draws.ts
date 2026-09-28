import type { Pending, SystemInput } from './types.js';

type RandomPending = Extract<Pending, { kind: 'random' }>;

/** A deck draw whose card every seat sees: `request.public === true`. */
export function isPublicDraw(pending: Pending): pending is RandomPending {
  return (
    pending.kind === 'random' && pending.request.type === 'draw' && pending.request.public === true
  );
}

/**
 * The system input that resolves a public draw: the request's fields (minus `type` and
 * `public`) echoed under the module's `systemType`, plus the revealed card type. Every driver
 * and the P2P ledger build the answer with this one function.
 */
export function publicDrawInput(pending: RandomPending, card: string): SystemInput {
  const { type: _type, public: _public, ...echoed } = pending.request;
  return { ...echoed, kind: 'system', type: pending.systemType, card };
}

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

/** The extra dice (such as an event die) a dice request asks for, or none. */
export function extraDiceOf(request: RandomPending['request']): { id: string; faces: string[] }[] {
  const value = request.extra;
  if (!Array.isArray(value)) return [];
  return value.flatMap((die: unknown) => {
    if (typeof die !== 'object' || die === null) return [];
    const id: unknown = Reflect.get(die, 'id');
    const faces: unknown = Reflect.get(die, 'faces');
    return typeof id === 'string' &&
      Array.isArray(faces) &&
      faces.every((face) => typeof face === 'string')
      ? [{ id, faces: faces.filter((face): face is string => typeof face === 'string') }]
      : [];
  });
}

/**
 * The `extra` field of a `DICE_RESULT` for a dice request: one face per extra die, chosen by
 * `pick(faceCount)`. Empty when the request has no extra dice, so drivers add the `extra` key
 * only when it is not empty and base dice inputs stay unchanged.
 */
export function rollExtraDice(
  request: RandomPending['request'],
  pick: (maxExclusive: number) => number,
): Record<string, string> {
  const rolled: Record<string, string> = {};
  for (const die of extraDiceOf(request)) {
    const face = die.faces[pick(die.faces.length)];
    if (face === undefined) throw new Error(`Extra die ${die.id} has no faces`);
    rolled[die.id] = face;
  }
  return rolled;
}

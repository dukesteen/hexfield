import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import { DECK_REVEAL_PROTOCOL } from './deck-ledger.js';
import { handProofsSchema } from './hand-transition.js';
import type { HandProof, HandTransitionPlan } from './hand-transition.js';
import type { CommandBody } from './types.js';
import { parseCanonical } from './validation.js';

export const COMMAND_PROOFS_PROTOCOL = 'command-proofs-v1';
const deckSection = v.pipe(v.array(v.unknown()), v.maxLength(128));
const combinedSchema = v.strictObject({
  protocol: v.literal(COMMAND_PROOFS_PROTOCOL),
  data: v.strictObject({ deck: deckSection, hands: handProofsSchema }),
});
const legacySchema = v.strictObject({
  protocol: v.literal(DECK_REVEAL_PROTOCOL),
  data: deckSection,
});

export function composeCommandProofs(
  deck: readonly unknown[],
  hands: readonly HandProof[],
): CommandBody['evidence'] {
  return deck.length === 0 && hands.length === 0
    ? undefined
    : { protocol: COMMAND_PROOFS_PROTOCOL, data: { deck, hands } };
}

/** Split signed evidence without letting either section bypass the other verifier. */
export function readCommandProofs(
  evidence: unknown,
  plan: HandTransitionPlan,
): Result<{ deck: unknown[]; hands: HandProof[] }> {
  const reveals = plan.effects.filter((effect) => effect.type === 'card-slot-revealed');
  if (evidence === undefined) {
    return reveals.length === 0 && plan.obligations.length === 0
      ? success({ deck: [], hands: [] })
      : failure('command-proofs-required', 'This command requires card or resource proofs');
  }
  const combined = parseCanonical(evidence, combinedSchema);
  if (combined.ok) {
    if (reveals.length === 0 && plan.obligations.length === 0)
      return failure('command-proofs-unexpected', 'This command has no private proof obligation');
    if (
      combined.value.data.deck.length !== reveals.length ||
      combined.value.data.hands.length !== plan.obligations.length
    )
      return failure('command-proofs-count', 'Evidence must cover exactly the required sections');
    return success(combined.value.data);
  }
  // Explicit migration: historical deck-only evidence cannot satisfy resource obligations.
  const legacy = parseCanonical(evidence, legacySchema);
  if (
    legacy.ok &&
    plan.obligations.length === 0 &&
    reveals.length > 0 &&
    legacy.value.data.length === reveals.length
  )
    return success({ deck: legacy.value.data, hands: [] });
  return failure('command-proofs-invalid', 'Malformed or incompatible command proof envelope');
}

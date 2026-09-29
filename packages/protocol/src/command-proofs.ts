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
const denialSection = v.pipe(v.array(v.unknown()), v.maxLength(8));
const combinedSchema = v.strictObject({
  protocol: v.literal(COMMAND_PROOFS_PROTOCOL),
  data: v.strictObject({
    deck: deckSection,
    hands: handProofsSchema,
    /** Proofs that hidden cards are none of a named set of identities; absent for most inputs. */
    denials: v.exactOptional(denialSection),
    /** A private look at, or transfer of, hidden cards; its shape depends on the input. */
    look: v.exactOptional(v.unknown()),
  }),
});
const legacySchema = v.strictObject({
  protocol: v.literal(DECK_REVEAL_PROTOCOL),
  data: deckSection,
});

export interface CommandProofSections {
  deck: unknown[];
  hands: HandProof[];
  denials: unknown[];
  look: unknown;
}

/** Whether the plan needs any card, hand or denial proof from the input's signer. */
export function planNeedsProofs(plan: HandTransitionPlan): boolean {
  return plan.reveals.length > 0 || plan.denials.length > 0 || plan.obligations.length > 0;
}

export function composeCommandProofs(
  deck: readonly unknown[],
  hands: readonly HandProof[],
  extra: { denials?: readonly unknown[]; look?: unknown } = {},
): CommandBody['evidence'] {
  const denials = extra.denials ?? [];
  const look = extra.look;
  return deck.length === 0 && hands.length === 0 && denials.length === 0 && look === undefined
    ? undefined
    : {
        protocol: COMMAND_PROOFS_PROTOCOL,
        data: {
          deck,
          hands,
          ...(denials.length > 0 ? { denials } : {}),
          ...(look === undefined ? {} : { look }),
        },
      };
}

/** Split signed evidence without letting either section bypass the other verifier. */
export function readCommandProofs(
  evidence: unknown,
  plan: HandTransitionPlan,
  /** True when the input opens or answers a private look, whose evidence is the `look` section. */
  looks = false,
): Result<CommandProofSections> {
  const needs = planNeedsProofs(plan);
  if (evidence === undefined) {
    return !needs && !looks
      ? success({ deck: [], hands: [], denials: [], look: undefined })
      : failure('command-proofs-required', 'This command requires card or resource proofs');
  }
  const combined = parseCanonical(evidence, combinedSchema);
  if (combined.ok) {
    if (!needs && !looks)
      return failure('command-proofs-unexpected', 'This command has no private proof obligation');
    const data = combined.value.data;
    if (
      data.deck.length !== plan.reveals.length ||
      data.hands.length !== plan.obligations.length ||
      (data.denials?.length ?? 0) !== plan.denials.length ||
      (data.look !== undefined) !== looks
    )
      return failure('command-proofs-count', 'Evidence must cover exactly the required sections');
    return success({
      deck: data.deck,
      hands: data.hands,
      denials: data.denials ?? [],
      look: data.look,
    });
  }
  // Explicit migration: historical deck-only evidence cannot satisfy resource obligations.
  const legacy = parseCanonical(evidence, legacySchema);
  if (
    legacy.ok &&
    plan.obligations.length === 0 &&
    plan.denials.length === 0 &&
    !looks &&
    plan.reveals.length > 0 &&
    legacy.value.data.length === plan.reveals.length
  )
    return success({ deck: legacy.value.data, hands: [], denials: [], look: undefined });
  return failure('command-proofs-invalid', 'Malformed or incompatible command proof envelope');
}

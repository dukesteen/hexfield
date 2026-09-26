import { success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import {
  deckDrawOperationId,
  deckUnlockSchema,
  validateDeckDrawOperation,
  verifyDeckUnlockPrefix,
} from './deck-draw.js';
import type { DeckDrawOperation, SignedDeckUnlock } from './deck-draw.js';
import { DECK_DRAW_PROTOCOL } from './deck-ledger.js';
import { hashSchema } from './schema-values.js';
import { parseCanonical } from './validation.js';
import type { CryptoContext } from './crypto-context.js';
import type { LogContext } from './log.js';
import type { EntryPayload } from './types.js';

export const deckUnlockContributionSchema = v.strictObject({
  kind: v.literal('deck-unlock'),
  operationId: hashSchema,
  unlocks: v.pipe(v.array(deckUnlockSchema), v.minLength(1), v.maxLength(5)),
});

export interface DeckUnlockContribution {
  kind: 'deck-unlock';
  operationId: string;
  unlocks: readonly SignedDeckUnlock[];
}
type DealPayload = Extract<EntryPayload, { kind: 'system' }>;

function copyUnlock(unlock: SignedDeckUnlock): SignedDeckUnlock {
  return {
    body: {
      ...unlock.body,
      proof: {
        commitments: [unlock.body.proof.commitments[0], unlock.body.proof.commitments[1]],
        response: unlock.body.proof.response,
      },
    },
    sig: unlock.sig,
  };
}

/** Disposable delivery cache. The certified entry validator rechecks the evidence. */
export class DeckInbox {
  private operation: DeckDrawOperation | null = null;
  private id: string | null = null;
  private unlocks: SignedDeckUnlock[] = [];

  operationId(): string | null {
    return this.id;
  }

  refresh(crypto: CryptoContext | null): Result<void> {
    const active = crypto?.decks.active;
    if (!active) {
      this.clear();
      return success(undefined);
    }
    const checked = validateDeckDrawOperation(active);
    if (!checked.ok) {
      this.clear();
      return checked;
    }
    const id = deckDrawOperationId(checked.value);
    if (id !== this.id) this.unlocks = [];
    this.operation = checked.value;
    this.id = id;
    return success(undefined);
  }

  remember(value: DeckUnlockContribution): Result<boolean> {
    const parsed = parseCanonical(value, deckUnlockContributionSchema);
    if (!parsed.ok) return parsed;
    const operation = this.operation;
    if (
      !operation ||
      parsed.value.operationId !== this.id ||
      parsed.value.unlocks.length <= this.unlocks.length
    )
      return success(false);
    const verified = verifyDeckUnlockPrefix(operation, parsed.value.unlocks);
    if (!verified.ok) return verified;
    this.unlocks = verified.value.unlocks.map(copyUnlock);
    return success(true);
  }

  prefix(): SignedDeckUnlock[] {
    return this.unlocks.map(copyUnlock);
  }

  candidate(context: LogContext): Result<DealPayload | null> {
    const refreshed = this.refresh(context.crypto);
    if (!refreshed.ok) return refreshed;
    const operation = this.operation;
    if (!operation || this.unlocks.length !== operation.participants.length - 1)
      return success(null);
    // remember() already verified this entire prefix for the same operation ID.
    // Proposal validation independently checks the final evidence before voting.
    return success({
      kind: 'system',
      input: {
        kind: 'system',
        type: 'CARD_DEALT',
        deck: operation.deckId,
        seat: operation.seat,
        slotId: operation.slotId,
      },
      evidence: { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: this.prefix() },
    });
  }

  private clear(): void {
    this.operation = null;
    this.id = null;
    this.unlocks = [];
  }
}

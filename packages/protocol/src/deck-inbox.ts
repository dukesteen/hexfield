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
import type { Genesis } from './types.js';
import type { SeatAuthorities, ArtifactSigner } from './authority-types.js';
import { resolveArtifactSigner } from './authority.js';
import { failure } from '@cp2p/engine';

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
  private generationId: string | null = null;
  private unlocks: SignedDeckUnlock[] = [];
  private signers: ArtifactSigner[] | undefined;

  operationId(): string | null {
    return this.id;
  }

  refresh(
    crypto: CryptoContext | null,
    genesis?: Genesis,
    authority?: SeatAuthorities,
  ): Result<void> {
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
    let signers: ArtifactSigner[] | undefined;
    if (genesis && (authority || crypto.epoch > 0)) {
      signers = [];
      for (const participant of checked.value.participants.filter(
        (item) => item.seat !== checked.value.seat,
      )) {
        const signer = resolveArtifactSigner(authority, genesis, crypto.epoch, participant.seat);
        if (!signer.ok) return signer;
        signers.push(signer.value);
      }
    } else if (crypto.epoch > 0) {
      return failure('deck-inbox-authority', 'Recovered inbox needs current authority');
    }
    const id = deckDrawOperationId(checked.value);
    const generationId =
      signers?.map((item) => `${item.generation.seq}:${item.generation.hash}`).join('/') ?? '';
    if (id !== this.id || generationId !== this.generationId) this.unlocks = [];
    this.operation = checked.value;
    this.signers = signers;
    this.id = id;
    this.generationId = generationId;
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
    const verified = verifyDeckUnlockPrefix(operation, parsed.value.unlocks, this.signers);
    if (!verified.ok) return verified;
    this.unlocks = verified.value.unlocks.map(copyUnlock);
    return success(true);
  }

  prefix(): SignedDeckUnlock[] {
    return this.unlocks.map(copyUnlock);
  }

  candidate(context: LogContext): Result<DealPayload | null> {
    const refreshed = this.refresh(context.crypto, context.genesis, context.authority);
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
    this.generationId = null;
    this.unlocks = [];
    this.signers = undefined;
  }
}

import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import {
  COUNT_EVIDENCE_PROTOCOL,
  countOperationId,
  validateCountOperation,
  verifyCountContribution,
} from './count-reveal.js';
import type { CountOperation, SignedCountContribution } from './count-reveal.js';
import type { CryptoContext } from './crypto-context.js';
import type { EntryPayload } from './types.js';

type RevealPayload = Extract<EntryPayload, { kind: 'system' }>;

/** Disposable delivery cache; certified entry validation rechecks the proof. */
export class CountInbox {
  private operation: CountOperation | null = null;
  private id: string | null = null;
  private remaining: readonly Seat[] = [];
  private readonly received = new Map<Seat, SignedCountContribution>();

  operationId(): string | null {
    return this.id;
  }

  refresh(crypto: CryptoContext | null): Result<void> {
    const active = crypto?.counts;
    if (!active) {
      this.clear();
      return success(undefined);
    }
    const operation = validateCountOperation(active.operation);
    if (!operation.ok) {
      this.clear();
      return operation;
    }
    if (!Array.isArray(active.remaining)) {
      this.clear();
      return failure(
        'count-inbox-remaining',
        'Pending count victims differ from the frozen roster',
      );
    }
    const expected = operation.value.victims
      .map((victim) => victim.seat)
      .filter((seat) => active.remaining.includes(seat));
    if (
      active.remaining.length !== expected.length ||
      active.remaining.some((seat, index) => seat !== expected[index])
    ) {
      this.clear();
      return failure(
        'count-inbox-remaining',
        'Pending count victims differ from the frozen roster',
      );
    }
    const id = countOperationId(operation.value);
    if (id !== this.id) this.received.clear();
    this.operation = operation.value;
    this.id = id;
    this.remaining = [...active.remaining];
    return success(undefined);
  }

  remember(contribution: SignedCountContribution): Result<boolean> {
    if (
      !this.operation ||
      contribution.body.operationId !== this.id ||
      !this.remaining.includes(contribution.body.seat) ||
      this.received.has(contribution.body.seat)
    )
      return success(false);
    const verified = verifyCountContribution(contribution, this.operation);
    if (!verified.ok) return verified;
    this.received.set(verified.value.body.seat, verified.value);
    return success(true);
  }

  candidate(crypto: CryptoContext | null): Result<RevealPayload | null> {
    const refreshed = this.refresh(crypto);
    if (!refreshed.ok) return refreshed;
    const operation = this.operation;
    if (!operation) return success(null);
    for (const seat of this.remaining) {
      const signed = this.received.get(seat);
      if (!signed) continue;
      return success({
        kind: 'system',
        input: {
          kind: 'system',
          type: 'REVEAL_COUNT',
          seat,
          resource: operation.resource,
          count: signed.body.count,
        },
        evidence: { kind: 'proof', protocol: COUNT_EVIDENCE_PROTOCOL, data: signed },
      });
    }
    return success(null);
  }

  private clear(): void {
    this.operation = null;
    this.id = null;
    this.remaining = [];
    this.received.clear();
  }
}

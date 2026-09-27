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
import type { Genesis } from './types.js';
import type { ArtifactSigner, SeatAuthorities } from './authority-types.js';
import { resolveArtifactSigner } from './authority.js';

type RevealPayload = Extract<EntryPayload, { kind: 'system' }>;

/** Disposable delivery cache; certified entry validation rechecks the proof. */
export class CountInbox {
  private operation: CountOperation | null = null;
  private id: string | null = null;
  private generations: string | null = null;
  private signers = new Map<Seat, ArtifactSigner>();
  private remaining: readonly Seat[] = [];
  private readonly received = new Map<Seat, SignedCountContribution>();

  operationId(): string | null {
    return this.id;
  }

  refresh(
    crypto: CryptoContext | null,
    genesis?: Genesis,
    authority?: SeatAuthorities,
  ): Result<void> {
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
    const signers = new Map<Seat, ArtifactSigner>();
    if (genesis && (authority || crypto.epoch > 0)) {
      for (const victim of operation.value.victims) {
        const signer = resolveArtifactSigner(authority, genesis, crypto.epoch, victim.seat);
        if (!signer.ok) return signer;
        signers.set(victim.seat, signer.value);
      }
    } else if (crypto.epoch > 0) {
      return failure('count-inbox-authority', 'Recovered inbox needs current authority');
    }
    const generations = [...signers.values()]
      .map(({ generation }) => `${generation.seq}:${generation.hash}`)
      .join('/');
    if (id !== this.id || generations !== this.generations) this.received.clear();
    this.operation = operation.value;
    this.id = id;
    this.generations = generations;
    this.signers = signers;
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
    const verified = verifyCountContribution(
      contribution,
      this.operation,
      this.signers.get(contribution.body.seat),
    );
    if (!verified.ok) return verified;
    this.received.set(verified.value.body.seat, verified.value);
    return success(true);
  }

  candidate(
    crypto: CryptoContext | null,
    genesis?: Genesis,
    authority?: SeatAuthorities,
  ): Result<RevealPayload | null> {
    const refreshed = this.refresh(crypto, genesis, authority);
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
    this.generations = null;
    this.signers.clear();
    this.remaining = [];
    this.received.clear();
  }
}

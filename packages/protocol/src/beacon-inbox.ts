import { fromBase64Url } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { beaconOperationId, completeBeacon, verifyBeaconReveal } from './beacon.js';
import type { BeaconOperation } from './beacon.js';
import type { BeaconContribution } from './beacon-contributions.js';
import {
  beaconExtensionOperationId,
  completeBeaconExtension,
  verifyBeaconExtension,
} from './beacon-extension.js';
import { getBeaconExtensionOperation, getBeaconOperation } from './beacon-state.js';
import { BEACON_EVIDENCE_PROTOCOL } from './crypto-context.js';
import type { CryptoContext } from './crypto-context.js';
import { decksReady } from './deck-ledger.js';
import type { LogContext } from './log.js';
import type { BeaconDerivations } from './beacon-state.js';
import { randomDerivations } from './random-derivations.js';
import type { EntryPayload } from './types.js';
import type { Genesis } from './types.js';
import { resolveArtifactSigner } from './authority.js';
import type { ArtifactSigner, SeatAuthorities } from './authority-types.js';

type BeaconPayload = Extract<EntryPayload, { kind: 'crypto' | 'system' }>;
interface Phase {
  kind: BeaconContribution['kind'];
  id: string;
  operation: BeaconOperation;
  signers: readonly ArtifactSigner[] | undefined;
  generations: string;
}

/** Bounded, disposable delivery cache. Certified entry validation rechecks all evidence. */
export class BeaconInbox {
  private phase: Phase | null = null;
  private readonly received = new Map<Seat, BeaconContribution>();

  operationId(): string | null {
    return this.phase?.id ?? null;
  }

  refresh(
    crypto: CryptoContext | null,
    genesis?: Genesis,
    authority?: SeatAuthorities,
  ): Result<void> {
    let next: Phase | null = null;
    if (crypto?.beacon.active && decksReady(crypto.decks)) {
      const extending = crypto.beacon.active.participants.some((p) => p.index === p.length);
      const operation = extending
        ? getBeaconExtensionOperation(crypto.beacon)
        : getBeaconOperation(crypto.beacon);
      if (!operation.ok) return operation;
      let signers: ArtifactSigner[] | undefined;
      if (genesis && (authority || crypto.epoch > 0)) {
        signers = [];
        for (const participant of operation.value.participants) {
          const signer = resolveArtifactSigner(authority, genesis, crypto.epoch, participant.seat);
          if (!signer.ok) return signer;
          signers.push(signer.value);
        }
      } else if (crypto.epoch > 0) {
        return failure('beacon-inbox-authority', 'Recovered inbox needs current authority');
      }
      next = {
        kind: extending ? 'beacon-extension' : 'beacon-reveal',
        id: extending
          ? beaconExtensionOperationId(operation.value)
          : beaconOperationId(operation.value),
        operation: operation.value,
        signers,
        generations:
          signers?.map((item) => `${item.generation.seq}:${item.generation.hash}`).join('/') ?? '',
      };
    }
    if (next?.id !== this.phase?.id || next?.generations !== this.phase?.generations)
      this.received.clear();
    this.phase = next;
    return success(undefined);
  }

  remember(contribution: BeaconContribution): Result<boolean> {
    const phase = this.phase;
    // Delayed, duplicated and future deliveries have no authority over the current request.
    if (
      !phase ||
      contribution.kind !== phase.kind ||
      contribution.signed.body.operationId !== phase.id ||
      this.received.has(contribution.signed.body.seat)
    )
      return success(false);
    if (contribution.kind === 'beacon-extension') {
      const verified = verifyBeaconExtension(
        contribution.signed,
        phase.operation,
        phase.signers?.find((item) => item.seat === contribution.signed.body.seat),
      );
      if (!verified.ok) return verified;
      this.received.set(verified.value.body.seat, {
        kind: contribution.kind,
        signed: verified.value,
      });
    } else {
      const verified = verifyBeaconReveal(
        contribution.signed,
        phase.operation,
        phase.signers?.find((item) => item.seat === contribution.signed.body.seat),
      );
      if (!verified.ok) return verified;
      this.received.set(verified.value.body.seat, {
        kind: contribution.kind,
        signed: verified.value,
      });
    }
    return success(true);
  }

  candidate(
    context: LogContext,
    registry: BeaconDerivations = randomDerivations,
  ): Result<BeaconPayload | null> {
    const refreshed = this.refresh(context.crypto, context.genesis, context.authority);
    if (!refreshed.ok) return refreshed;
    const phase = this.phase;
    if (!phase || this.received.size !== phase.operation.participants.length) return success(null);
    const ordered = phase.operation.participants.map(
      (participant) => this.received.get(participant.seat)?.signed,
    );
    if (phase.kind === 'beacon-extension') {
      const complete = completeBeaconExtension(phase.operation, ordered, phase.signers);
      return complete.ok
        ? success({ kind: 'crypto', action: 'beacon-extend', evidence: complete.value.extensions })
        : complete;
    }
    const complete = completeBeacon(phase.operation, ordered, phase.signers);
    if (!complete.ok) return complete;
    const outcome = registry.derive(
      context.state,
      phase.operation.pending,
      fromBase64Url(complete.value.seed),
      phase.operation,
    );
    if (!outcome.ok) return outcome;
    return outcome.value.kind === 'steal-index'
      ? success({ kind: 'crypto', action: 'beacon-fixed', evidence: complete.value.reveals })
      : success({
          kind: 'system',
          input: outcome.value.input,
          evidence: {
            kind: 'proof',
            protocol: BEACON_EVIDENCE_PROTOCOL,
            data: complete.value.reveals,
          },
        });
  }
}

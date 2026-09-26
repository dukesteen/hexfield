import { fromBase64Url } from '@cp2p/codec';
import { success } from '@cp2p/engine';
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
import type { LogContext } from './log.js';
import type { BeaconDerivations } from './beacon-state.js';
import { randomDerivations } from './random-derivations.js';
import type { EntryPayload } from './types.js';

type BeaconPayload = Extract<EntryPayload, { kind: 'crypto' | 'system' }>;
interface Phase {
  kind: BeaconContribution['kind'];
  id: string;
  operation: BeaconOperation;
}

/** Bounded, disposable delivery cache. Certified entry validation rechecks all evidence. */
export class BeaconInbox {
  private phase: Phase | null = null;
  private readonly received = new Map<Seat, BeaconContribution>();

  operationId(): string | null {
    return this.phase?.id ?? null;
  }

  refresh(crypto: CryptoContext | null): Result<void> {
    let next: Phase | null = null;
    if (crypto?.beacon.active) {
      const extending = crypto.beacon.active.participants.some((p) => p.index === p.length);
      const operation = extending
        ? getBeaconExtensionOperation(crypto.beacon)
        : getBeaconOperation(crypto.beacon);
      if (!operation.ok) return operation;
      next = {
        kind: extending ? 'beacon-extension' : 'beacon-reveal',
        id: extending
          ? beaconExtensionOperationId(operation.value)
          : beaconOperationId(operation.value),
        operation: operation.value,
      };
    }
    if (next?.id !== this.phase?.id) this.received.clear();
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
      const verified = verifyBeaconExtension(contribution.signed, phase.operation);
      if (!verified.ok) return verified;
      this.received.set(verified.value.body.seat, {
        kind: contribution.kind,
        signed: verified.value,
      });
    } else {
      const verified = verifyBeaconReveal(contribution.signed, phase.operation);
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
    const refreshed = this.refresh(context.crypto);
    if (!refreshed.ok) return refreshed;
    const phase = this.phase;
    if (!phase || this.received.size !== phase.operation.participants.length) return success(null);
    const ordered = phase.operation.participants.map(
      (participant) => this.received.get(participant.seat)?.signed,
    );
    if (phase.kind === 'beacon-extension') {
      const complete = completeBeaconExtension(phase.operation, ordered);
      return complete.ok
        ? success({ kind: 'crypto', action: 'beacon-extend', evidence: complete.value.extensions })
        : complete;
    }
    const complete = completeBeacon(phase.operation, ordered);
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

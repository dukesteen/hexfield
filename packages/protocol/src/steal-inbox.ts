import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type { CryptoContext } from './crypto-context.js';
import {
  STEAL_EVIDENCE_PROTOCOL,
  stealOperationId,
  validateStealOperation,
  verifyStealContribution,
  verifyStealDispute,
  verifyStealReceipt,
} from './steal-delivery.js';
import type {
  FixedSteal,
  SignedStealContribution,
  SignedStealDispute,
  SignedStealReceipt,
  StealOperation,
} from './steal-delivery.js';
import type { StealResponse } from './steal-contributions.js';
import type { EntryPayload } from './types.js';
import type { Genesis } from './types.js';
import type { ArtifactSigner, SeatAuthorities } from './authority-types.js';
import { resolveArtifactSigner } from './authority.js';

type StealPayload = Extract<EntryPayload, { kind: 'crypto' | 'system' }>;

/** Delivery cache only: every proposed entry rechecks its certified operation and proof. */
export class StealInbox {
  private operation: StealOperation | null = null;
  private id: string | null = null;
  private fixed: FixedSteal | null = null;
  private contribution: SignedStealContribution | null = null;
  private receipt: SignedStealReceipt | null = null;
  private dispute: SignedStealDispute | null = null;
  private disputed = false;
  private generations: string | null = null;
  private victimSigner: ArtifactSigner | undefined;
  private thiefSigner: ArtifactSigner | undefined;

  operationId(): string | null {
    return this.id;
  }

  /** Changes when the operation advances from victim contribution to recipient response. */
  stageId(): string | null {
    if (!this.id || this.disputed) return null;
    return `${this.id}/${this.fixed?.entry.hash ?? 'contribution'}${this.generations ? `/${this.generations}` : ''}`;
  }

  refresh(
    crypto: CryptoContext | null,
    genesis?: Genesis,
    authority?: SeatAuthorities,
  ): Result<void> {
    const active = crypto?.steal;
    if (!active) {
      this.clear();
      return success(undefined);
    }
    const checked = validateStealOperation(active.operation);
    if (!checked.ok) {
      this.clear();
      return checked;
    }
    const id = stealOperationId(checked.value);
    let victimSigner: ArtifactSigner | undefined;
    let thiefSigner: ArtifactSigner | undefined;
    if (genesis && (authority || crypto.epoch > 0)) {
      const victim = resolveArtifactSigner(
        authority,
        genesis,
        crypto.epoch,
        checked.value.victim.seat,
      );
      if (!victim.ok) return victim;
      const thief = resolveArtifactSigner(
        authority,
        genesis,
        crypto.epoch,
        checked.value.thief.seat,
      );
      if (!thief.ok) return thief;
      victimSigner = victim.value;
      thiefSigner = thief.value;
    } else if (crypto.epoch > 0) {
      return failure('steal-inbox-authority', 'Recovered inbox needs current authority');
    }
    const generations =
      victimSigner && thiefSigner
        ? `${victimSigner.generation.seq}:${victimSigner.generation.hash}/${thiefSigner.generation.seq}:${thiefSigner.generation.hash}`
        : '';
    if (id !== this.id || generations !== this.generations) this.clear();
    if (active.fixed?.entry.hash !== this.fixed?.entry.hash) {
      this.receipt = null;
      this.dispute = null;
    }
    this.operation = checked.value;
    this.id = id;
    this.generations = generations;
    this.victimSigner = victimSigner;
    this.thiefSigner = thiefSigner;
    this.fixed = active.fixed;
    this.disputed = active.dispute !== null;
    if (this.fixed) this.contribution = null;
    return success(undefined);
  }

  rememberContribution(value: SignedStealContribution): Result<boolean> {
    if (
      !this.operation ||
      this.fixed ||
      this.disputed ||
      this.contribution ||
      value.body.operationId !== this.id
    )
      return success(false);
    const checked = verifyStealContribution(value, this.operation, this.victimSigner);
    if (!checked.ok) return checked;
    this.contribution = checked.value;
    return success(true);
  }

  rememberResponse(response: StealResponse): Result<boolean> {
    const fixed = this.fixed;
    if (!fixed || this.disputed) return success(false);
    const binding = response.kind === 'receipt' ? response.value.body : response.value.body.binding;
    // Retries from a different fixed ciphertext must not consume proof verification work.
    if (
      binding.operationId !== this.id ||
      binding.fixed.seq !== fixed.entry.seq ||
      binding.fixed.hash !== fixed.entry.hash
    )
      return success(false);
    if (response.kind === 'receipt') {
      if (this.receipt || this.dispute) return success(false);
      const checked = verifyStealReceipt(response.value, fixed, this.thiefSigner);
      if (!checked.ok) return checked;
      this.receipt = checked.value;
    } else {
      if (this.dispute) return success(false);
      const checked = verifyStealDispute(response.value, fixed, this.thiefSigner);
      if (!checked.ok) return checked;
      this.dispute = checked.value;
    }
    return success(true);
  }

  candidate(
    crypto: CryptoContext | null,
    genesis?: Genesis,
    authority?: SeatAuthorities,
  ): Result<StealPayload | null> {
    const refreshed = this.refresh(crypto, genesis, authority);
    if (!refreshed.ok) return refreshed;
    if (!this.operation || this.disputed) return success(null);
    if (!this.fixed)
      return success(
        this.contribution
          ? { kind: 'crypto', action: 'steal-fixed', evidence: this.contribution }
          : null,
      );
    // A known valid complaint takes priority until consensus has committed a result.
    if (this.dispute)
      return success({ kind: 'crypto', action: 'steal-dispute', evidence: this.dispute });
    if (!this.receipt) return success(null);
    return success({
      kind: 'system',
      input: {
        kind: 'system',
        type: 'STEAL_RESULT',
        thief: this.operation.thief.seat,
        victim: this.operation.victim.seat,
        resource: 'hidden',
      },
      evidence: { kind: 'proof', protocol: STEAL_EVIDENCE_PROTOCOL, data: this.receipt },
    });
  }

  private clear(): void {
    this.operation = null;
    this.id = null;
    this.fixed = null;
    this.contribution = null;
    this.receipt = null;
    this.dispute = null;
    this.disputed = false;
    this.generations = null;
    this.victimSigner = undefined;
    this.thiefSigner = undefined;
  }
}

import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { scalarFromBytes } from '@cp2p/crypto';
import { LocalGame, RESOURCES, failure, success } from '@cp2p/engine';
import type { Engine, PrivateInputData, Result, Seat } from '@cp2p/engine';
import { decodeDeckCard } from './deck-draw.js';
import { createDeckSecretSource } from './deck-source.js';
import { entryHash } from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import { reconstructPrivateSeats } from './private-replay.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { openStealContribution } from './steal-delivery.js';
import { createStealSecretSource } from './steal-source.js';
import type { AuditEntryRef, AuditInputError, AuditReport, AuditViolation } from './audit-types.js';
import type { ProposalContext } from './proposal.js';
import type { Genesis } from './types.js';

const MAX_DIAGNOSTICS = 16;

function isSeat(value: unknown): value is Seat {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5;
}

export interface AuditCertifiedGameInput {
  readonly genesisEntry: unknown;
  readonly entries: readonly unknown[];
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly masters: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
}

function ref(entry: Parameters<typeof entryHash>[0]): AuditEntryRef {
  return { seq: entry.seq, hash: entryHash(entry) };
}

function issue(seq: number, seat: Seat | null, kind: string): AuditViolation {
  return { seq, seat, kind, detail: kind };
}

function selectedResource(
  hand: Readonly<Record<string, number>>,
  index: number,
): (typeof RESOURCES)[number] | null {
  let cursor = index;
  for (const resource of RESOURCES) {
    cursor -= hand[resource] ?? 0;
    if (cursor < 0) return resource;
  }
  return null;
}

function privateDataFor(
  input: NonNullable<Parameters<LocalGame['applyRecorded']>[0]>,
  prior: ProposalContext,
  next: ProposalContext,
  game: LocalGame,
  masters: ReadonlyMap<Seat, Uint8Array>,
  genesis: Genesis,
): Result<Partial<Record<Seat, PrivateInputData>>> {
  if (input.kind !== 'system') return success({});
  if (input.type === 'CARD_DEALT') {
    if (!isSeat(input.seat) || !genesis.config.seats.includes(input.seat))
      return failure('audit-draw-seat', 'Certified draw seat is invalid');
    const deck = next.log.crypto?.decks.decks.find(
      (item) => item.commitment.definition.deckId === input.deck,
    );
    const slot = deck?.slots.find((item) => item.slotId === input.slotId);
    const master = masters.get(input.seat);
    if (!deck || !slot || slot.seat !== input.seat || !master)
      return failure('audit-draw-context', 'Certified draw lacks its original receipt or master');
    const source = createDeckSecretSource(master, deck.commitment.definition, input.seat);
    try {
      const decoded = decodeDeckCard(
        deck.setup,
        slot.receipt,
        source.lock(slot.receipt.operation.position),
        slot.unlockSigners,
      );
      return decoded.ok ? success({ [input.seat]: { card: decoded.value.card } }) : decoded;
    } finally {
      source.dispose();
    }
  }
  if (input.type === 'STEAL_RESULT') {
    const fixed = prior.log.crypto?.steal?.fixed;
    const operation = fixed?.operation;
    if (
      !fixed ||
      !operation ||
      input.thief !== operation.thief.seat ||
      input.victim !== operation.victim.seat
    )
      return failure('audit-steal-context', 'Certified steal lacks its fixed operation');
    const victimHand = game.privateView(operation.victim.seat)?.hand;
    const victimTotal = victimHand
      ? RESOURCES.reduce((sum, resource) => sum + (victimHand[resource] ?? 0), 0)
      : -1;
    const expected = victimHand ? selectedResource(victimHand, operation.index) : null;
    if (!expected || victimTotal !== operation.handSize)
      return failure('audit-steal-index', 'Frozen index differs from the omniscient victim hand');
    const master = masters.get(operation.thief.seat);
    const owner = genesis.seats.find((seat) => seat.seat === operation.thief.seat);
    if (!master || !owner)
      return failure('audit-steal-master', 'Original thief master is unavailable');
    const source = createStealSecretSource(
      master,
      genesis.ceremonyNonce,
      operation.thief.seat,
      owner.publicKey,
    );
    try {
      const opened = openStealContribution(
        operation,
        fixed.contribution,
        source.encryptionSecret(),
        fixed.signer,
      );
      if (!opened.ok) return opened;
      if (opened.value.resource !== expected)
        return failure(
          'audit-steal-resource',
          'Certified transfer differs from the frozen victim card',
        );
      return success({
        [operation.thief.seat]: { resource: expected },
        [operation.victim.seat]: { resource: expected },
      });
    } finally {
      source.dispose();
    }
  }
  return success({});
}

/** Reconstruct a finished certified game without treating bad reveal input as an accusation. */
export function auditCertifiedGame(input: AuditCertifiedGameInput): AuditReport {
  const violations: AuditViolation[] = [];
  const inputErrors: AuditInputError[] = [];
  const masters = new Map<Seat, Uint8Array>();
  let terminal: AuditEntryRef | null = null;
  let finalHead: AuditEntryRef | null = null;
  let historyError: { code: string } | null = null;
  let auditError: AuditReport['auditError'] = null;
  let cheatFindings: AuditReport['cheatFindings'] = [];
  let missingSeats: Seat[] = [];
  let complete = false;
  const report = (): AuditReport => ({
    ok:
      complete &&
      violations.length === 0 &&
      inputErrors.length === 0 &&
      !historyError &&
      !auditError,
    complete,
    missingSeats,
    violations,
    inputErrors,
    cheatFindings,
    terminal,
    finalHead,
    historyError,
    auditError,
  });
  const processingFailure = (seq: number, code: string): AuditReport => {
    auditError = { seq, code };
    complete = false;
    return report();
  };
  try {
    const publicReplay = replayCertifiedPrefix(
      input.genesisEntry,
      input.entries,
      input.engine,
      input.policy,
      (entry, next) => {
        if (!terminal && next.log.state.result) terminal = ref(entry.entry);
        return success(undefined);
      },
    );
    if (!publicReplay.ok) {
      historyError = { code: publicReplay.error.code };
      return report();
    }
    const { context } = publicReplay.value;
    const { genesis, crypto } = context.log;
    finalHead = ref(context.log.head);
    cheatFindings = crypto?.cheats.slice(0, MAX_DIAGNOSTICS) ?? [];
    if (!terminal || !context.log.state.result) return report();
    if (genesis.security !== 'verified' || !crypto) {
      historyError = { code: 'audit-unverified-game' };
      return report();
    }
    if (!Array.isArray(input.masters)) {
      inputErrors.push({ seat: null, kind: 'master-list' });
      return report();
    }
    const seats = new Set(genesis.seats.map((seat) => seat.seat));
    const seen = new Set<Seat>();
    for (const reveal of input.masters) {
      if (!reveal || !seats.has(reveal.seat) || seen.has(reveal.seat)) {
        if (inputErrors.length < MAX_DIAGNOSTICS)
          inputErrors.push({ seat: null, kind: 'master-seat-or-duplicate' });
        continue;
      }
      seen.add(reveal.seat);
      if (!(reveal.master instanceof Uint8Array) || reveal.master.length !== 32) {
        if (inputErrors.length < MAX_DIAGNOSTICS)
          inputErrors.push({ seat: reveal.seat, kind: 'master-scalar' });
        continue;
      }
      const copy = reveal.master.slice();
      try {
        scalarFromBytes(copy, { nonzero: true });
      } catch {
        copy.fill(0);
        if (inputErrors.length < MAX_DIAGNOSTICS)
          inputErrors.push({ seat: reveal.seat, kind: 'master-scalar' });
        continue;
      }
      masters.set(reveal.seat, copy);
    }
    missingSeats = genesis.seats.map((seat) => seat.seat).filter((seat) => !masters.has(seat));
    for (const [seat, master] of masters) {
      const verified = verifyRevealedMaster(genesis, crypto.decks, seat, toBase64Url(master));
      if (verified.ok) continue;
      if (verified.error.code === 'master-public-key' || verified.error.code === 'master-reveal') {
        if (inputErrors.length < MAX_DIAGNOSTICS)
          inputErrors.push({ seat, kind: verified.error.code });
      } else if (
        [
          'master-encryption-key',
          'master-beacon-tip',
          'master-shuffle-key',
          'master-lock-key',
        ].includes(verified.error.code)
      ) {
        violations.push(issue(0, seat, verified.error.code));
      } else return processingFailure(0, verified.error.code);
    }
    complete = missingSeats.length === 0 && inputErrors.length === 0;
    if (!complete || violations.length) return report();

    const initial = initialProposalContext(input.genesisEntry, input.engine, input.policy);
    if (!initial.ok) {
      historyError = { code: initial.error.code };
      return report();
    }
    const recorded = LocalGame.createRecorded(
      input.engine,
      genesis.config,
      fromBase64Url(genesis.genesisSeed),
    );
    if (!recorded.ok) {
      return processingFailure(0, recorded.error.code);
    }
    const game = recorded.value;
    if (toHex(hashValue(game.state)) !== initial.value.log.head.stateHash) {
      return processingFailure(0, 'audit-genesis-state');
    }
    let prior = initial.value;
    let failureSeq = 0;
    let failureSeat: Seat | null = null;
    const privateReplay = replayCertifiedPrefix(
      input.genesisEntry,
      publicReplay.value.entries,
      input.engine,
      input.policy,
      (entry, next) => {
        failureSeq = entry.entry.seq;
        const recordedInput = entry.input;
        if (recordedInput) {
          failureSeat = null;
          try {
            const data = privateDataFor(recordedInput, prior, next, game, masters, genesis);
            if (!data.ok) {
              // Only this mismatch identifies the signer of the fixed hidden transfer.
              // A draw failure does not prove misconduct by the receiving player.
              if (data.error.code === 'audit-steal-resource' && recordedInput.kind === 'system')
                failureSeat = isSeat(recordedInput.victim) ? recordedInput.victim : null;
              return data;
            }
            const applied = game.applyRecorded(recordedInput, data.value);
            if (!applied.ok) return applied;
          } catch {
            return failure('audit-private-input', 'Could not reconstruct certified private input');
          }
        }
        if (
          toHex(hashValue(game.state)) !== next.log.head.stateHash ||
          toHex(hashValue(game.state)) !== toHex(hashValue(next.log.state))
        )
          return failure('audit-state-hash', 'Omniscient state differs from the certified state');
        prior = next;
        return success(undefined);
      },
    );
    if (!privateReplay.ok) {
      if (
        [
          'driver-error',
          'audit-private-input',
          'audit-state-hash',
          'audit-draw-context',
          'audit-draw-seat',
          'audit-steal-context',
          'audit-steal-master',
          'steal-recipient-key',
          'deck-owner-lock',
          'missing-private-state',
        ].includes(privateReplay.error.code)
      )
        return processingFailure(failureSeq, privateReplay.error.code);
      violations.push(issue(failureSeq, failureSeat, privateReplay.error.code));
      complete = true;
      return report();
    }
    if (toHex(hashValue(game.state.result)) !== toHex(hashValue(context.log.state.result))) {
      return processingFailure((terminal as AuditEntryRef).seq, 'audit-terminal-result');
    }
    const crossCheck = reconstructPrivateSeats({
      genesisEntry: input.genesisEntry,
      entries: publicReplay.value.entries,
      engine: input.engine,
      policy: input.policy,
      secrets: [...masters].map(([seat, master]) => ({ seat, master })),
    });
    if (!crossCheck.ok) {
      const details = crossCheck.error.details;
      const seq =
        details &&
        typeof details === 'object' &&
        'seq' in details &&
        typeof details.seq === 'number'
          ? details.seq
          : context.log.head.seq;
      if (
        [
          'private-replay-failed',
          'private-replay-beacon',
          'crypto-context-required',
          'verified-private-missing',
        ].includes(crossCheck.error.code)
      )
        return processingFailure(seq, crossCheck.error.code);
      violations.push(issue(seq, null, crossCheck.error.code));
    } else {
      crossCheck.value.dispose();
    }
    complete = true;
    return report();
  } catch {
    return processingFailure(finalHead?.seq ?? 0, 'audit-internal-failure');
  } finally {
    for (const master of masters.values()) master.fill(0);
  }
}

import { canonicalDecode, canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  parsePeerId,
  scalarFromBytes,
  scalePoint,
  signObject,
  verifyObject,
} from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { entryHash, genesisDigest } from './genesis.js';
import { validateGenesisMasters } from './genesis-masters.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import type { ProtocolJournal } from './journal.js';
import type { ProposalContext } from './proposal.js';
import { loadRecoveryPrivate } from './recovery-private.js';
import type { RecoveryPrivateStore } from './recovery-private.js';
import { replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';

const PROTOCOL = 'master-reveal-v1';
const SIGN_DOMAIN = 'master-reveal';
const refSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
export const signedMasterRevealSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal(PROTOCOL),
    genesisDigest: key32Schema,
    result: refSchema,
    originalSeat: seatSchema,
    publisherSeat: seatSchema,
    master: key32Schema,
  }),
  sig: signature64Schema,
});
const acceptedRevealSchema = v.strictObject({
  protocol: v.literal('master-reveal-accepted-v1'),
  receivedAt: refSchema,
  packet: signedMasterRevealSchema,
});
export type SignedMasterReveal = v.InferOutput<typeof signedMasterRevealSchema>;
export type MasterRevealVerdict = 'valid' | 'inconsistent-genesis';
export interface MasterRevealStore {
  load(id: string): Promise<Uint8Array | null>;
  /** Resolves true only after the exact bytes are durably committed. */
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
}
export interface MasterRevealOptions {
  readonly journal: ProtocolJournal;
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly localSeat: Seat;
  readonly signingKey: Uint8Array;
  readonly store: MasterRevealStore;
  /** Returns a fresh owned copy. Called only for a still-original local host. */
  readonly loadOwnedMaster: (seat: Seat) => Promise<Uint8Array | null>;
  /** Previously certified private recovery record for a recovered original seat. */
  readonly recoveryPrivateStore?: RecoveryPrivateStore;
}
/** Package-internal checkpoint. Only the replica's validated paths may supply it. */
export interface Terminal {
  readonly context: ProposalContext;
  readonly result: { readonly seq: number; readonly hash: string };
  readonly head: { readonly seq: number; readonly hash: string };
  readonly genesisHash: string;
}
const liveTerminalSources = new WeakMap<MasterRevealCoordinator, () => Promise<Result<Terminal>>>();

/** Internal replica adapter; deliberately absent from the package exports. */
export function createLiveMasterRevealCoordinator(
  options: MasterRevealOptions,
  readVerifiedTerminal: () => Promise<Result<Terminal>>,
): MasterRevealCoordinator {
  const coordinator = new MasterRevealCoordinator(options);
  liveTerminalSources.set(coordinator, readVerifiedTerminal);
  return coordinator;
}
function sameRef(a: { seq: number; hash: string }, b: { seq: number; hash: string }): boolean {
  return a.seq === b.seq && a.hash === b.hash;
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
function copyPacket(packet: SignedMasterReveal): SignedMasterReveal {
  return v.parse(signedMasterRevealSchema, canonicalDecode(canonicalEncode(packet)));
}
function acceptedId(result: Terminal['result'], genesis: string, seat: Seat): string {
  return `master-reveal/accepted/${genesis}/${result.seq}-${result.hash}/${seat}`;
}

/** Replay the durable branch; the first result entry, not the latest control, scopes reveals. */
async function terminal(
  options: Pick<MasterRevealOptions, 'journal' | 'engine' | 'policy'>,
  cached?: Terminal,
): Promise<Result<Terminal>> {
  try {
    const record = await options.journal.load();
    if (!record) return failure('master-reveal-journal', 'Certified journal is absent');
    const head = record.entries.at(-1)?.entry ?? record.genesis;
    if (record.height !== head.seq + 1 || record.entries.length !== head.seq)
      return failure('master-reveal-journal', 'Journal height disagrees with its certified prefix');
    const headRef = { seq: head.seq, hash: entryHash(head) };
    const genesisHash = entryHash(record.genesis);
    if (cached && sameRef(cached.head, headRef) && cached.genesisHash === genesisHash)
      return success(cached);
    let first: Terminal['result'] | null = null;
    const replayed = replayCertifiedPrefix(
      record.genesis,
      record.entries,
      options.engine,
      options.policy,
      (entry, next) => {
        if (!first && next.log.state.result !== null)
          first = { seq: entry.entry.seq, hash: entryHash(entry.entry) };
        return success(undefined);
      },
    );
    if (!replayed.ok) return replayed;
    if (!first || replayed.value.context.log.state.result === null)
      return failure('master-reveal-unfinished', 'A certified engine result is required');
    return success({
      context: replayed.value.context,
      result: first,
      head: headRef,
      genesisHash,
    });
  } catch {
    return failure('master-reveal-journal', 'Could not read or replay certified journal');
  }
}

function publisher(
  context: ProposalContext,
  originalSeat: Seat,
  publisherSeat: Seat,
): Result<{
  publicKey: string;
  mode: 'owned' | 'recovered';
  authorization?: { seq: number; hash: string };
}> {
  const original = context.log.genesis.seats.find((seat) => seat.seat === originalSeat);
  const authority = context.log.authority;
  const human = authority?.controllers.find((seat) => seat.seat === publisherSeat);
  if (!original || !authority || !human || human.kind !== 'human' || human.status !== 'active')
    return failure('master-reveal-publisher', 'Publisher is not a current certified human');
  const completed = context.log.recovery?.completed.findLast((item) =>
    context.log.recovery?.authorizations.some(
      (authorization) =>
        sameRef(authorization.entry, item.authorization) &&
        authorization.statement.replacements.some(
          (replacement) => replacement.seat === originalSeat,
        ) &&
        authorization.statement.recoverers.some(
          (recoverer) =>
            recoverer.seat === publisherSeat && recoverer.publicKey === human.publicKey,
        ),
    ),
  );
  if (completed)
    return success({
      publicKey: human.publicKey,
      mode: 'recovered',
      authorization: completed.authorization,
    });
  const controller = authority.controllers.find((seat) => seat.seat === originalSeat);
  const originalHost =
    original.kind === 'human'
      ? original.seat
      : context.log.genesis.seats.find((seat) => seat.publicKey === original.botHost)?.seat;
  if (
    !controller ||
    controller.activatedAt.seq !== 0 ||
    originalHost !== publisherSeat ||
    human.activatedAt.seq !== 0 ||
    human.publicKey !==
      context.log.genesis.seats.find((seat) => seat.seat === publisherSeat)?.publicKey
  )
    return failure('master-reveal-publisher', 'Publisher does not own this original master');
  return success({ publicKey: human.publicKey, mode: 'owned' });
}

function checkMaster(
  packet: SignedMasterReveal,
  context: ProposalContext,
): Result<MasterRevealVerdict> {
  const masters = validateGenesisMasters(context.log.genesis);
  if (!masters.ok) return masters;
  const committed = masters.value.find((item) => item.seat === packet.body.originalSeat);
  if (!committed) return failure('master-reveal-seat', 'Original seat has no master commitment');
  try {
    const bytes = fromBase64Url(packet.body.master);
    try {
      if (
        encodePoint(scalePoint(G, scalarFromBytes(bytes, { nonzero: true }))) !==
        committed.masterPub
      )
        return failure('master-reveal-f0', 'Supplied scalar does not match F0');
    } finally {
      bytes.fill(0);
    }
  } catch {
    return failure('master-reveal-f0', 'Supplied scalar is invalid');
  }
  if (!context.log.crypto)
    return failure('master-reveal-context', 'Verified private ledger is unavailable');
  const full = verifyRevealedMaster(
    context.log.genesis,
    context.log.crypto.decks,
    packet.body.originalSeat,
    packet.body.master,
  );
  if (full.ok) return success('valid');
  return [
    'master-encryption-key',
    'master-beacon-tip',
    'master-shuffle-key',
    'master-lock-key',
  ].includes(full.error.code)
    ? success('inconsistent-genesis')
    : full;
}

/** Cheap sender/ref checks precede master point and full genesis derivation. */
export function verifyMasterReveal(
  value: unknown,
  snapshot: Terminal,
): Result<{ packet: SignedMasterReveal; verdict: MasterRevealVerdict }> {
  const parsed = parseCanonical(value, signedMasterRevealSchema);
  if (!parsed.ok) return parsed;
  const packet = parsed.value;
  const context = snapshot.context;
  if (
    packet.body.genesisDigest !== genesisDigest(context.log.genesis) ||
    !sameRef(packet.body.result, snapshot.result)
  )
    return failure('master-reveal-result', 'Reveal belongs to another certified result');
  const owner = publisher(context, packet.body.originalSeat, packet.body.publisherSeat);
  if (!owner.ok) return owner;
  try {
    if (!verifyObject(SIGN_DOMAIN, packet.body, packet.sig, parsePeerId(owner.value.publicKey)))
      return failure('master-reveal-signature', 'Reveal lacks its current publisher signature');
  } catch {
    return failure('master-reveal-signature', 'Reveal signer is malformed');
  }
  const verdict = checkMaster(packet, context);
  return verdict.ok ? success({ packet, verdict: verdict.value }) : verdict;
}

/** Caller serializes prepare/receive with journal commits and holds its writer lease through send enqueue. */
export class MasterRevealCoordinator {
  private disposed = false;
  private terminalCache: Terminal | undefined;
  private readonly quarantined = new Map<Seat, string>();
  private readonly accepted = new Map<
    Seat,
    {
      packet: SignedMasterReveal;
      verdict: MasterRevealVerdict;
      master: Uint8Array;
      head: Terminal['head'];
    }
  >();
  constructor(private readonly options: MasterRevealOptions) {}
  private async terminal(): Promise<Result<Terminal>> {
    if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
    const live = liveTerminalSources.get(this);
    const loaded = live ? await live() : await terminal(this.options, this.terminalCache);
    if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
    if (loaded.ok) this.terminalCache = loaded.value;
    else this.terminalCache = undefined;
    return loaded;
  }
  async eligibleSeats(): Promise<Result<readonly Seat[]>> {
    const loaded = await this.terminal();
    if (!loaded.ok) return loaded;
    return success(
      loaded.value.context.log.genesis.seats
        .filter(({ seat }) => publisher(loaded.value.context, seat, this.options.localSeat).ok)
        .map(({ seat }) => seat),
    );
  }
  async metadata(): Promise<
    Result<{ result: Terminal['result']; head: Terminal['head']; accepted: readonly Seat[] }>
  > {
    const loaded = await this.terminal();
    return loaded.ok
      ? success({
          result: { ...loaded.value.result },
          head: { ...loaded.value.head },
          accepted: [...this.accepted.keys()],
        })
      : loaded;
  }
  /** Reauthenticate each durable receipt at the certified head where it was accepted. */
  async restoreAccepted(): Promise<Result<void>> {
    const latest = await this.terminal();
    if (!latest.ok) return latest;
    const { context, result, head, genesisHash } = latest.value;
    const genesis = genesisDigest(context.log.genesis);
    const saved: v.InferOutput<typeof acceptedRevealSchema>[] = [];
    const quarantined = new Map<Seat, string>();
    try {
      for (const { seat } of context.log.genesis.seats) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded by the six-seat genesis roster.
        const bytes = await this.options.store.load(acceptedId(result, genesis, seat));
        if (this.disposed) {
          bytes?.fill(0);
          return failure('master-reveal-disposed', 'Reveal coordinator is closed');
        }
        if (!bytes) continue;
        try {
          const parsed = parseCanonical(canonicalDecode(bytes), acceptedRevealSchema);
          if (!parsed.ok || !sameBytes(canonicalEncode(parsed.value), bytes)) {
            quarantined.set(seat, 'master-reveal-accepted');
            continue;
          }
          if (
            parsed.value.packet.body.originalSeat !== seat ||
            parsed.value.packet.body.genesisDigest !== genesis ||
            !sameRef(parsed.value.packet.body.result, result) ||
            parsed.value.receivedAt.seq < result.seq ||
            parsed.value.receivedAt.seq > head.seq
          ) {
            quarantined.set(seat, 'master-reveal-scope');
            continue;
          }
          saved.push(parsed.value);
        } catch {
          quarantined.set(seat, 'master-reveal-accepted');
        } finally {
          bytes.fill(0);
        }
      }
      if (saved.length === 0) {
        for (const { master } of this.accepted.values()) master.fill(0);
        this.accepted.clear();
        this.quarantined.clear();
        for (const [seat, code] of quarantined) this.quarantined.set(seat, code);
        return success(undefined);
      }
      const record = await this.options.journal.load();
      if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
      const recordHead = record?.entries.at(-1)?.entry ?? record?.genesis;
      if (
        !record ||
        !recordHead ||
        !sameRef(head, { seq: recordHead.seq, hash: entryHash(recordHead) })
      )
        return failure('master-reveal-stale', 'Certified journal advanced during accepted restore');
      const wanted = new Map(saved.map((item) => [item.receivedAt.seq, item.receivedAt.hash]));
      const historical = new Map<number, Terminal>();
      const replayed = replayCertifiedPrefix(
        record.genesis,
        record.entries,
        this.options.engine,
        this.options.policy,
        (entry, next) => {
          if (wanted.get(entry.entry.seq) === entryHash(entry.entry))
            historical.set(entry.entry.seq, {
              context: next,
              result,
              head: { seq: entry.entry.seq, hash: entryHash(entry.entry) },
              genesisHash,
            });
          return success(undefined);
        },
      );
      if (!replayed.ok) return replayed;
      const accepted = new Map<
        Seat,
        {
          packet: SignedMasterReveal;
          verdict: MasterRevealVerdict;
          master: Uint8Array;
          head: Terminal['head'];
        }
      >();
      try {
        for (const item of saved) {
          const snapshot = historical.get(item.receivedAt.seq);
          if (!snapshot || !sameRef(snapshot.head, item.receivedAt)) {
            quarantined.set(item.packet.body.originalSeat, 'master-reveal-history');
            continue;
          }
          const checked = verifyMasterReveal(item.packet, snapshot);
          if (!checked.ok) {
            quarantined.set(item.packet.body.originalSeat, checked.error.code);
            continue;
          }
          const seat = checked.value.packet.body.originalSeat;
          accepted.set(seat, {
            packet: checked.value.packet,
            verdict: checked.value.verdict,
            master: fromBase64Url(checked.value.packet.body.master),
            head: item.receivedAt,
          });
        }
        const after = await this.terminal();
        if (!after.ok) return after;
        if (!sameRef(after.value.head, head))
          return failure(
            'master-reveal-stale',
            'Certified journal advanced during accepted restore',
          );
        for (const { master } of this.accepted.values()) master.fill(0);
        this.accepted.clear();
        for (const [seat, item] of accepted) this.accepted.set(seat, item);
        this.quarantined.clear();
        for (const [seat, code] of quarantined) this.quarantined.set(seat, code);
        accepted.clear();
        return success(undefined);
      } finally {
        for (const { master } of accepted.values()) master.fill(0);
      }
    } catch {
      if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
      return failure('master-reveal-accepted', 'Could not restore accepted reveals');
    }
  }
  async prepare(
    originalSeat: Seat,
  ): Promise<Result<{ packet: SignedMasterReveal; verdict: MasterRevealVerdict }>> {
    const first = await this.terminal();
    if (!first.ok) return first;
    const { context, result, head } = first.value;
    const owner = publisher(context, originalSeat, this.options.localSeat);
    if (!owner.ok) return owner;
    const id = `master-reveal/${genesisDigest(context.log.genesis)}/${result.seq}-${result.hash}/${originalSeat}/${owner.value.publicKey}`;
    let signingKey: Uint8Array | null = null;
    let master: Uint8Array | null = null;
    let encoded: Uint8Array | null = null;
    let loaded: Uint8Array | null = null;
    let stage = 'stored-packet';
    try {
      loaded = await this.options.store.load(id);
      if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
      if (loaded) {
        const saved = verifyMasterReveal(canonicalDecode(loaded), first.value);
        if (
          !saved.ok ||
          saved.value.packet.body.originalSeat !== originalSeat ||
          saved.value.packet.body.publisherSeat !== this.options.localSeat ||
          !sameBytes(canonicalEncode(saved.value.packet), loaded)
        )
          return failure('master-reveal-conflict', 'Saved reveal is invalid for this slot');
        const latest = await this.terminal();
        if (!latest.ok) return latest;
        if (!sameRef(latest.value.head, head))
          return failure('master-reveal-stale', 'Certified journal advanced before reveal output');
        return saved;
      }
      if (!(this.options.signingKey instanceof Uint8Array) || this.options.signingKey.length !== 32)
        return failure('master-reveal-key', 'Publisher signing key is malformed');
      stage = 'publisher-key';
      signingKey = this.options.signingKey.slice();
      const identity = identityFromSecret(signingKey);
      const matches = identity.peerId === owner.value.publicKey;
      identity.secretKey.fill(0);
      if (!matches) return failure('master-reveal-key', 'Publisher key is not current');
      stage = 'private-master';
      if (owner.value.mode === 'owned') master = await this.options.loadOwnedMaster(originalSeat);
      else if (owner.value.authorization && this.options.recoveryPrivateStore) {
        const recovered = await loadRecoveryPrivate(
          context.log,
          owner.value.authorization,
          this.options.localSeat,
          this.options.recoveryPrivateStore,
        );
        if (this.disposed) {
          if (recovered.ok) recovered.value.dispose();
          return failure('master-reveal-disposed', 'Reveal coordinator is closed');
        }
        if (!recovered.ok) return recovered;
        try {
          master =
            recovered.value.secrets
              .find((secret) => secret.seat === originalSeat)
              ?.master.slice() ?? null;
        } finally {
          recovered.value.dispose();
        }
      }
      if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
      if (!(master instanceof Uint8Array) || master.length !== 32)
        return failure('master-reveal-source', 'Authorized master is unavailable');
      stage = 'packet-signature';
      const body: SignedMasterReveal['body'] = {
        protocol: PROTOCOL,
        genesisDigest: genesisDigest(context.log.genesis),
        result: { ...result },
        originalSeat,
        publisherSeat: this.options.localSeat,
        master: toBase64Url(master),
      };
      const packet = v.parse(signedMasterRevealSchema, {
        body,
        sig: signObject(SIGN_DOMAIN, body, signingKey),
      });
      const verified = verifyMasterReveal(packet, first.value);
      if (!verified.ok) return verified;
      stage = 'durable-packet';
      encoded = canonicalEncode(packet);
      const inserted = await this.options.store.putIfAbsent(id, encoded);
      if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
      if (!inserted) {
        loaded = await this.options.store.load(id);
        if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
        if (!loaded || !sameBytes(loaded, encoded))
          return failure('master-reveal-conflict', 'A different reveal already occupies this slot');
      }
      const latest = await this.terminal();
      if (!latest.ok) return latest;
      if (!sameRef(latest.value.head, head) || !sameRef(latest.value.result, result))
        return failure('master-reveal-stale', 'Certified journal advanced before reveal output');
      return verified;
    } catch {
      if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
      return failure('master-reveal-prepare', `Could not prepare reveal at ${stage}`);
    } finally {
      master?.fill(0);
      encoded?.fill(0);
      loaded?.fill(0);
      signingKey?.fill(0);
    }
  }
  async receive(
    value: unknown,
  ): Promise<Result<{ verdict: MasterRevealVerdict; packet: SignedMasterReveal }>> {
    const latest = await this.terminal();
    if (!latest.ok) return latest;
    const parsed = parseCanonical(value, signedMasterRevealSchema);
    if (!parsed.ok) return parsed;
    const prior = this.accepted.get(parsed.value.body.originalSeat);
    if (
      prior &&
      sameRef(prior.head, latest.value.head) &&
      sameBytes(canonicalEncode(prior.packet), canonicalEncode(parsed.value))
    )
      return success({ packet: copyPacket(prior.packet), verdict: prior.verdict });
    const checked = verifyMasterReveal(parsed.value, latest.value);
    if (!checked.ok) return checked;
    const seat = checked.value.packet.body.originalSeat;
    if (prior)
      return prior.packet.body.master === checked.value.packet.body.master
        ? success({ packet: copyPacket(prior.packet), verdict: prior.verdict })
        : failure('master-reveal-conflict', 'Original seat already has a different reveal');
    if (this.accepted.size >= latest.value.context.log.genesis.seats.length)
      return failure('master-reveal-capacity', 'All original seats already have reveals');
    const detached = v.parse(
      signedMasterRevealSchema,
      canonicalDecode(canonicalEncode(checked.value.packet)),
    );
    const id = acceptedId(latest.value.result, detached.body.genesisDigest, seat);
    const durable = canonicalEncode({
      protocol: 'master-reveal-accepted-v1',
      receivedAt: { ...latest.value.head },
      packet: detached,
    });
    try {
      const inserted = await this.options.store.putIfAbsent(id, durable);
      if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
      if (!inserted) {
        const restored = await this.restoreAccepted();
        if (!restored.ok) return restored;
        const existing = this.accepted.get(seat);
        return existing?.packet.body.master === detached.body.master
          ? success({ packet: copyPacket(existing.packet), verdict: existing.verdict })
          : failure('master-reveal-conflict', 'Original seat already has a different reveal');
      }
      const after = await this.terminal();
      if (!after.ok) return after;
      if (!sameRef(after.value.head, latest.value.head))
        return failure('master-reveal-stale', 'Certified journal advanced before acceptance');
    } catch {
      if (this.disposed) return failure('master-reveal-disposed', 'Reveal coordinator is closed');
      return failure('master-reveal-storage', 'Could not durably retain accepted reveal');
    } finally {
      durable.fill(0);
    }
    const accepted = {
      packet: detached,
      verdict: checked.value.verdict,
      master: fromBase64Url(detached.body.master),
      head: latest.value.head,
    };
    if (this.disposed) {
      accepted.master.fill(0);
      return failure('master-reveal-disposed', 'Reveal coordinator is closed');
    }
    this.accepted.set(seat, accepted);
    return success({ packet: copyPacket(accepted.packet), verdict: accepted.verdict });
  }
  reveals(): readonly { verdict: MasterRevealVerdict; packet: SignedMasterReveal }[] {
    return [...this.accepted.values()].map(({ packet, verdict }) => ({
      packet: copyPacket(packet),
      verdict,
    }));
  }
  quarantinedAccepted(): readonly { seat: Seat; code: string }[] {
    return [...this.quarantined].map(([seat, code]) => ({ seat, code }));
  }
  acceptedMasters(): readonly { seat: Seat; verdict: MasterRevealVerdict; master: Uint8Array }[] {
    return [...this.accepted].map(([seat, { verdict, master }]) => ({
      seat,
      verdict,
      master: master.slice(),
    }));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { master } of this.accepted.values()) master.fill(0);
    this.accepted.clear();
    this.quarantined.clear();
    this.terminalCache = undefined;
  }
}

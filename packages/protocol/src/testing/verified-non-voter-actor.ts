import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import * as v from 'valibot';
import { enumerateCommands } from '@cp2p/engine';
import type { CommandShape, LegalCommandSet, Result, Seat } from '@cp2p/engine';
import type { PrivateState } from '@cp2p/engine';
import { prepareBeaconContribution } from '../beacon-contributions.js';
import { BeaconInbox } from '../beacon-inbox.js';
import { resolveArtifactSigner } from '../authority.js';
import { prepareCountContribution } from '../count-contributions.js';
import { CountInbox } from '../count-inbox.js';
import { DeckInbox } from '../deck-inbox.js';
import { prepareDeckUnlock } from '../deck-outbox.js';
import { entryHash } from '../genesis.js';
import { MasterRevealCoordinator } from '../master-reveal.js';
import type { ProtocolJournal } from '../journal.js';
import { signCommand } from '../command-validation.js';
import { decodeProtocolMessage, encodeProtocolMessage } from '../messages.js';
import type { ProtocolMessage } from '../messages.js';
import { prepareStealContribution, prepareStealResponse } from '../steal-contributions.js';
import { StealInbox } from '../steal-inbox.js';
import {
  planTradeProof,
  signTradeProofRequest,
  signTradeProofResponse,
  tradeProofHost,
  tradeProofRequestId,
  verifyTradeProofResponse,
  verifyTradeProofRequest,
} from '../trade-proof-delivery.js';
import type { IndexedHandProof, SignedTradeProofRequest } from '../trade-proof-delivery.js';
import { advanceContext, validateCertifiedEntry } from '../proposal.js';
import type { CertifiedEntry, ProposalContext } from '../proposal.js';
import { initialProposalContext } from '../replay.js';
import { logEntrySchema, signedCommandSchema } from '../schemas.js';
import { parseCanonical } from '../validation.js';
import type { VerifiedNetworkSessionOptions } from './verified-network-fixture.js';
import type { ProtocolClock, Transport, Unsubscribe } from '../transport.js';
import type { SignedCommand } from '../types.js';
import type { Genesis } from '../types.js';

const MAX_PREFIX_ENTRIES = 20_000;
const TRADE_REQUEST_TIMEOUT_MS = 10_000;
const TRADE_REQUEST_RETRY_MS = 250;
const OUTBOUND_TYPES = new Set<ProtocolMessage['t']>([
  'SUBMIT',
  'MASTER_REVEAL',
  'SYS_CONTRIB',
  'DECK_CONTRIB',
  'COUNT_CONTRIB',
  'STEAL_CONTRIB',
  'STEAL_RESPONSE',
  'TRADE_PROOF_REQUEST',
  'TRADE_PROOF_RESPONSE',
]);

const commandShapeSchema = v.objectWithRest({ type: v.string() }, v.unknown());

function detachSignedCommand(value: SignedCommand): Result<SignedCommand> {
  return parseCanonical(canonicalDecode(canonicalEncode(value)), signedCommandSchema);
}

export interface VerifiedNonVoterActorOptions {
  readonly seat: Seat;
  readonly identity: { readonly peerId: string; readonly secretKey: Uint8Array };
  /** One already-scoped option value; no callback can request another seat's secrets. */
  readonly sessionOptions: VerifiedNetworkSessionOptions;
  readonly transport: Transport;
  readonly clock: ProtocolClock;
}

export interface VerifiedNonVoterActor {
  readonly seat: Seat;
  advance(entries: readonly CertifiedEntry[]): Promise<Result<void>>;
  submit(
    command: CommandShape,
    expectedHead: { readonly seq: number; readonly hash: string },
  ): Promise<Result<SignedCommand>>;
  legalCommands(): LegalCommandSet;
  publishContributions(): Promise<Result<void>>;
  privateState(): PrivateState | null;
  head(): { readonly seq: number; readonly hash: string };
  dispose(): void;
}

/**
 * A strict replaying player endpoint with no consensus journal or safety state.
 * It can keep producing its own authenticated protocol artifacts after its
 * proposer is excluded, but cannot submit proposals, votes, or certificates.
 */
export function createVerifiedNonVoterActor(
  options: VerifiedNonVoterActorOptions,
): Result<VerifiedNonVoterActor> {
  const { seat, identity, sessionOptions, transport, clock } = options;
  let signingKey: Uint8Array | null = null;
  let driver: ReturnType<VerifiedNetworkSessionOptions['createDriver']> | null = null;
  let disposed = false;
  let context: ProposalContext | null = null;
  const entries: CertifiedEntry[] = [];
  let pendingCommand: {
    readonly seq: number;
    readonly hash: string;
    readonly command: CommandShape;
    readonly signed?: SignedCommand;
  } | null = null;
  const beaconInbox = new BeaconInbox();
  const deckInbox = new DeckInbox();
  const countInbox = new CountInbox();
  const stealInbox = new StealInbox();
  let unsubscribe: Unsubscribe | null = null;
  let pendingTrade: {
    request: SignedTradeProofRequest;
    requestId: string;
    context: ProposalContext;
    finish: (result: Result<readonly IndexedHandProof[]>) => void;
    timer: unknown;
    deadline: number;
  } | null = null;
  let masterReveal: MasterRevealCoordinator | null = null;
  const sentArtifacts = new Map<string, number>();
  const tradeResponses = new Map<string, unknown>();

  const parsedGenesis = parseCanonical(sessionOptions.genesisEntry, logEntrySchema);
  if (!parsedGenesis.ok || parsedGenesis.value.payload.kind !== 'genesis')
    return failure('non-voter-genesis', 'Actor needs the signed verified genesis entry');
  const genesisEntry = parsedGenesis.value;
  if (transport.self !== identity.peerId)
    return failure('non-voter-identity', 'Transport identity differs from the owned seat');

  try {
    signingKey = new Uint8Array(identity.secretKey);
    const derived = identityFromSecret(signingKey);
    const matches = derived.peerId === identity.peerId;
    derived.secretKey.fill(0);
    if (!matches) {
      signingKey.fill(0);
      return failure('non-voter-identity', 'Owned signing key does not match its peer');
    }
    const initialized = initialProposalContext(
      genesisEntry,
      sessionOptions.engine,
      sessionOptions.policy,
    );
    if (!initialized.ok) {
      signingKey.fill(0);
      return initialized;
    }
    const genesis: Genesis = initialized.value.log.genesis;
    if (genesis.security !== 'verified') {
      signingKey.fill(0);
      return failure('non-voter-security', 'Actor only supports verified games');
    }
    const seatGenesis = genesis.seats.find((candidate) => candidate.seat === seat);
    if (seatGenesis?.kind !== 'human' || seatGenesis.publicKey !== identity.peerId) {
      signingKey.fill(0);
      return failure('non-voter-seat', 'Identity does not own this human genesis seat');
    }
    context = initialized.value;
    driver = sessionOptions.createDriver(sessionOptions.engine, genesis, clock, [seat]);
    const revealOptions = sessionOptions.masterReveal;
    if (revealOptions) {
      const readonlyJournal: ProtocolJournal = {
        async load() {
          const current = context;
          if (!current) return null;
          return {
            genesis: genesisEntry,
            entries: [...entries],
            height: current.log.head.seq + 1,
            safety: { revision: 0, bytes: new Uint8Array() },
          };
        },
        async initialize() {
          return false;
        },
        async loadSafety() {
          return null;
        },
        async saveSafety() {
          return false;
        },
        async commit() {
          return false;
        },
      };
      masterReveal = new MasterRevealCoordinator({
        journal: readonlyJournal,
        engine: sessionOptions.engine,
        policy: sessionOptions.policy,
        localSeat: seat,
        signingKey,
        store: revealOptions.store,
        loadOwnedMaster: async (ownedSeat) =>
          ownedSeat === seat ? revealOptions.loadOwnedMaster(ownedSeat) : null,
      });
    }
  } catch {
    driver?.dispose?.();
    masterReveal?.dispose();
    signingKey?.fill(0);
    return failure('non-voter-open', 'Could not initialize scoped verified private state');
  }

  const contextNow = (): ProposalContext => {
    if (disposed || !context || !driver) throw new Error('Non-voter actor is disposed');
    return context;
  };

  const transmit = (message: unknown, recipient?: string): Result<void> => {
    if (disposed) return failure('non-voter-disposed', 'Non-voter actor is disposed');
    const encoded = encodeProtocolMessage(message);
    if (!encoded.ok) return encoded;
    const decoded = decodeProtocolMessage(encoded.value);
    if (!decoded.ok || !OUTBOUND_TYPES.has(decoded.value.t))
      return failure('non-voter-outbound', 'Actor cannot send consensus or unsupported messages');
    const current = contextNow();
    const outgoing = decoded.value;
    if (outgoing.t === 'SUBMIT') {
      const body = outgoing.cmd.body;
      if (
        body.seat !== seat ||
        body.gameId !== current.log.genesis.gameId ||
        body.genesisDigest !== current.membership.genesisDigest ||
        body.headSeq !== current.log.head.seq ||
        body.headHash !== entryHash(current.log.head) ||
        body.nonce !== (current.log.lastNonces.get(seat) ?? 0) + 1 ||
        !pendingCommand ||
        pendingCommand.seq !== body.headSeq ||
        pendingCommand.hash !== body.headHash ||
        !sameCanonical(pendingCommand.command, body.command) ||
        (pendingCommand.signed !== undefined && pendingCommand.signed.sig !== outgoing.cmd.sig)
      )
        return failure(
          'non-voter-command-context',
          'Command is not bound to the actor current head',
        );
    }
    if (
      'genesisDigest' in outgoing &&
      outgoing.genesisDigest !== current.membership.genesisDigest
    ) {
      return failure('non-voter-message-context', 'Sideband message belongs to another game');
    }
    if (outgoing.t === 'MASTER_REVEAL') {
      if (
        outgoing.reveal.body.publisherSeat !== seat ||
        outgoing.reveal.body.originalSeat !== seat ||
        outgoing.reveal.body.genesisDigest !== current.membership.genesisDigest ||
        current.log.state.result === null
      )
        return failure('non-voter-reveal-context', 'Reveal is not for the actor’s terminal seat');
    } else if (outgoing.t === 'TRADE_PROOF_REQUEST') {
      const request = verifyTradeProofRequest(outgoing.request, current.log);
      if (
        !request.ok ||
        outgoing.request.body.seat !== seat ||
        outgoing.request.body.headSeq !== current.log.head.seq ||
        outgoing.request.body.headHash !== entryHash(current.log.head)
      )
        return failure(
          'non-voter-trade-context',
          'Trade proof request is not bound to the actor head',
        );
    }
    const owned =
      (outgoing.t === 'SYS_CONTRIB' && outgoing.contribution.signed.body.seat === seat) ||
      (outgoing.t === 'DECK_CONTRIB' &&
        outgoing.contribution.unlocks.at(-1)?.body.seat === seat &&
        outgoing.contribution.operationId === deckInbox.operationId()) ||
      (outgoing.t === 'COUNT_CONTRIB' && outgoing.contribution.body.seat === seat) ||
      (outgoing.t === 'STEAL_CONTRIB' && outgoing.contribution.body.seat === seat) ||
      (outgoing.t === 'STEAL_RESPONSE' &&
        (outgoing.response.kind === 'receipt'
          ? outgoing.response.value.body.seat
          : outgoing.response.value.body.binding.seat) === seat) ||
      (outgoing.t === 'MASTER_REVEAL' && outgoing.reveal.body.publisherSeat === seat) ||
      (outgoing.t === 'TRADE_PROOF_REQUEST' && outgoing.request.body.seat === seat) ||
      (outgoing.t === 'TRADE_PROOF_RESPONSE' && outgoing.response.body.seat === seat);
    if (outgoing.t !== 'SUBMIT' && !owned)
      return failure('non-voter-outbound-owner', 'Actor may send only its own verified artifacts');
    // Bound repeated sideband sends by virtual time. Commands retain their own retry policy.
    const artifactKey =
      outgoing.t === 'SUBMIT' || outgoing.t === 'TRADE_PROOF_REQUEST'
        ? null
        : `${recipient ?? '*'}:${Array.from(encoded.value).join(',')}`;
    if (artifactKey !== null) {
      const previous = sentArtifacts.get(artifactKey);
      if (previous !== undefined && clock.now() - previous < TRADE_REQUEST_RETRY_MS)
        return success(undefined);
    }
    try {
      if (recipient === undefined) transport.broadcast(encoded.value);
      else transport.send(recipient, encoded.value);
      if (artifactKey !== null) {
        sentArtifacts.set(artifactKey, clock.now());
        if (sentArtifacts.size > 128) {
          const oldest = sentArtifacts.keys().next().value;
          if (oldest !== undefined) sentArtifacts.delete(oldest);
        }
      }
      return success(undefined);
    } catch {
      return failure('non-voter-transport', 'Could not send the actor message');
    }
  };

  const refreshInboxes = (current: ProposalContext): Result<void> => {
    for (const refreshed of [
      beaconInbox.refresh(current.log.crypto, current.log.genesis, current.log.authority),
      deckInbox.refresh(current.log.crypto, current.log.genesis, current.log.authority),
      countInbox.refresh(current.log.crypto, current.log.genesis, current.log.authority),
      stealInbox.refresh(current.log.crypto, current.log.genesis, current.log.authority),
    ])
      if (!refreshed.ok) return refreshed;
    return success(undefined);
  };

  const receive = (from: string, bytes: Uint8Array): void => {
    if (disposed) return;
    const parsed = decodeProtocolMessage(bytes);
    if (!parsed.ok) return;
    const current = context;
    if (!current) return;
    const message = parsed.value;
    if (message.t === 'TRADE_PROOF_REQUEST') {
      void answerTradeProofRequest(from, message.request).catch(() => undefined);
      return;
    }
    if (message.t === 'TRADE_PROOF_RESPONSE') {
      const waiting = pendingTrade;
      if (!waiting || disposed || context !== waiting.context) return;
      const response = verifyTradeProofResponse(message.response, waiting.request, current.log);
      if (response.ok && response.value.body.requestId === waiting.requestId)
        waiting.finish(success(response.value.body.proofs));
      return;
    }
    if ('genesisDigest' in message && message.genesisDigest !== current.membership.genesisDigest)
      return;
    if (!refreshInboxes(current).ok) return;
    if (message.t === 'SYS_CONTRIB') beaconInbox.remember(message.contribution);
    else if (message.t === 'DECK_CONTRIB') deckInbox.remember(message.contribution);
    else if (message.t === 'COUNT_CONTRIB') countInbox.remember(message.contribution);
    else if (message.t === 'STEAL_CONTRIB') stealInbox.rememberContribution(message.contribution);
    else if (message.t === 'STEAL_RESPONSE') stealInbox.rememberResponse(message.response);
    void from;
  };

  const answerTradeProofRequest = async (
    from: string,
    request: SignedTradeProofRequest,
  ): Promise<void> => {
    if (disposed || !driver || !signingKey || !context) return;
    const current = context;
    const checked = verifyTradeProofRequest(request, current.log);
    if (!checked.ok) return;
    const requester = resolveArtifactSigner(
      current.log.authority,
      current.log.genesis,
      current.log.crypto?.epoch ?? current.membership.epoch,
      request.body.seat,
    );
    if (!requester.ok || requester.value.publicKey !== from) return;
    const requestId = tradeProofRequestId(request.body);
    const cached = tradeResponses.get(requestId);
    if (cached) {
      transmit(cached, requester.value.publicKey);
      return;
    }
    const host = tradeProofHost(
      current.log.genesis,
      request.body.command.withSeat,
      current.log.authority,
    );
    if (host !== identity.peerId) return;
    const plan = planTradeProof(request.body, current.log);
    if (!plan.ok) return;
    const proofs = driver.produceTradeProofs?.(request, current.log);
    if (!proofs?.ok) return;
    const response = signTradeProofResponse(request, seat, proofs.value, signingKey);
    const message = { t: 'TRADE_PROOF_RESPONSE', response };
    tradeResponses.set(requestId, message);
    if (tradeResponses.size > 64) {
      const oldest = tradeResponses.keys().next().value;
      if (oldest !== undefined) tradeResponses.delete(oldest);
    }
    const outgoing = encodeProtocolMessage(message);
    if (!outgoing.ok || disposed || context !== current) return;
    try {
      const sent = transmit(message, requester.value.publicKey);
      if (!sent.ok) return;
    } catch {
      // Authenticated packets may be lost during reconnect; callers retry requests.
    }
  };

  const requestTradeProofs = (
    request: SignedTradeProofRequest,
    current: ProposalContext,
    recipient: string,
  ): Promise<Result<readonly IndexedHandProof[]>> =>
    new Promise((resolve) => {
      if (pendingTrade) {
        resolve(failure('non-voter-trade-busy', 'Actor already has a pending trade request'));
        return;
      }
      const requestId = tradeProofRequestId(request.body);
      let finished = false;
      const finish = (result: Result<readonly IndexedHandProof[]>) => {
        if (finished) return;
        finished = true;
        const waiting = pendingTrade;
        if (waiting?.requestId === requestId) {
          if (waiting.timer !== null) clock.clearTimeout(waiting.timer);
          pendingTrade = null;
        }
        resolve(result);
      };
      const deadline = clock.now() + TRADE_REQUEST_TIMEOUT_MS;
      const waiting = {
        request,
        requestId,
        context: current,
        finish,
        timer: null as unknown,
        deadline,
      };
      pendingTrade = waiting;
      const retry = () => {
        waiting.timer = null;
        if (disposed || context !== current) {
          finish(
            failure('non-voter-trade-stale', 'Certified head changed during trade proof request'),
          );
          return;
        }
        if (clock.now() >= deadline) {
          finish(failure('non-voter-trade-timeout', 'Trade proof request expired'));
          return;
        }
        const sent = transmit({ t: 'TRADE_PROOF_REQUEST', request }, recipient);
        if (!sent.ok && sent.error.code !== 'non-voter-transport') {
          finish(sent);
          return;
        }
        waiting.timer = clock.setTimeout(
          retry,
          Math.max(0, Math.min(TRADE_REQUEST_RETRY_MS, deadline - clock.now())),
        );
      };
      retry();
    });

  const publishMasterReveal = async (): Promise<Result<void>> => {
    if (!masterReveal || !context || context.log.state.result === null) return success(undefined);
    const prepared = await masterReveal.prepare(seat);
    if (!prepared.ok) return prepared;
    if (disposed || !context || context.log.state.result === null) return success(undefined);
    const sent = transmit({ t: 'MASTER_REVEAL', reveal: prepared.value.packet });
    return sent.ok ? success(undefined) : sent;
  };

  const actor: VerifiedNonVoterActor = {
    seat,
    async advance(prefix) {
      if (disposed || !context || !driver)
        return failure('non-voter-disposed', 'Non-voter actor is disposed');
      if (!Array.isArray(prefix) || prefix.length > MAX_PREFIX_ENTRIES)
        return failure(
          'non-voter-prefix-limit',
          'Certified prefix exceeds the actor history bound',
        );
      if (prefix.length < entries.length)
        return failure('non-voter-prefix-shrunk', 'Certified prefix cannot shrink');
      for (let index = 0; index < entries.length; index += 1) {
        const accepted = entries[index];
        const received = prefix[index];
        // A certified entry's identity is its signed entry hash. Honest peers
        // can attach different valid quorum subsets to that same entry.
        if (!accepted || !received || entryHash(accepted.entry) !== entryHash(received.entry))
          return failure('non-voter-prefix-fork', 'Certified prefix changed an accepted entry');
      }
      for (let index = entries.length; index < prefix.length; index += 1) {
        const certified = prefix[index];
        if (!certified) return failure('non-voter-prefix-gap', 'Certified prefix has a gap');
        const before = context;
        const validated = validateCertifiedEntry(certified, before);
        if (!validated.ok) return validated;
        const advanced = advanceContext(before, validated.value);
        if (!advanced.ok) return advanced;
        const committed = driver.committedEntry
          ? driver.committedEntry(validated.value, before.log, advanced.value.log)
          : validated.value.input
            ? driver.committed(before.log, validated.value.input, advanced.value.log.state)
            : failure('non-voter-driver', 'Driver cannot apply protocol-only certified entries');
        if (!committed.ok) return committed;
        // Journal replay accepts only the certified wire envelope. Derived state
        // includes Maps and engine metadata which cannot cross canonical boundaries.
        entries.push({
          entry: validated.value.entry,
          certificate: [...validated.value.certificate],
        });
        context = advanced.value;
        tradeResponses.clear();
        if (
          pendingCommand &&
          (pendingCommand.seq !== context.log.head.seq ||
            pendingCommand.hash !== entryHash(context.log.head))
        )
          pendingCommand = null;
        if (pendingTrade && context !== pendingTrade.context)
          pendingTrade.finish(
            failure('non-voter-trade-stale', 'Certified head changed during trade proof request'),
          );
      }
      return actor.publishContributions();
    },
    async submit(command, expectedHead) {
      if (disposed || !context || !driver || !signingKey)
        return failure('non-voter-disposed', 'Non-voter actor is disposed');
      const current = context;
      const parentHash = entryHash(current.log.head);
      if (expectedHead.seq !== current.log.head.seq || expectedHead.hash !== parentHash)
        return failure('non-voter-stale-head', 'Actor command needs the current certified head');
      let ownedCommand: CommandShape;
      try {
        const detached = v.safeParse(commandShapeSchema, canonicalDecode(canonicalEncode(command)));
        if (!detached.success)
          return failure('non-voter-command', 'Actor command cannot be detached safely');
        ownedCommand = detached.output;
      } catch {
        return failure('non-voter-command', 'Actor command cannot be detached safely');
      }
      if (pendingCommand) {
        if (pendingCommand.seq !== expectedHead.seq || pendingCommand.hash !== expectedHead.hash)
          pendingCommand = null;
        else if (!sameCanonical(pendingCommand.command, ownedCommand))
          return failure(
            'non-voter-command-pending',
            'Another command already uses this certified parent',
          );
        else if (pendingCommand.signed) {
          const detached = detachSignedCommand(pendingCommand.signed);
          if (!detached.ok) return detached;
          return transmit({ t: 'SUBMIT', cmd: pendingCommand.signed }).ok
            ? success(detached.value)
            : failure('non-voter-transport', 'Could not resend the actor command');
        } else
          return failure('non-voter-command-pending', 'The actor command is still being prepared');
      }
      const intent = { seq: expectedHead.seq, hash: expectedHead.hash, command: ownedCommand };
      pendingCommand = intent;
      let retained = false;
      try {
        const controller = current.log.authority?.controllers.find((item) => item.seat === seat);
        if (
          controller &&
          (controller.kind !== 'human' ||
            controller.status !== 'active' ||
            controller.publicKey !== identity.peerId)
        )
          return failure('non-voter-retired', 'Actor no longer controls this seat');
        const privateState = driver.privateState(seat);
        if (!privateState)
          return failure('non-voter-private', 'Actor seat private state is unavailable');
        const automatic = sessionOptions.engine.getAutomaticInput(
          current.log.state,
          new Map([[seat, privateState]]),
        );
        if (
          automatic?.kind === 'command' &&
          automatic.seat === seat &&
          !sameCanonical(automatic.command, ownedCommand)
        )
          return failure(
            'non-voter-automatic',
            'The certified engine requires its automatic action first',
          );
        const input = { kind: 'command' as const, seat, command: ownedCommand };
        const publicCheck = sessionOptions.engine.validate(current.log.state, input);
        if (!publicCheck.ok) return publicCheck;
        const privateCheck = sessionOptions.engine.applyPrivate(
          privateState,
          current.log.state,
          input,
        );
        if (!privateCheck.ok) return privateCheck;
        const body = {
          gameId: current.log.genesis.gameId,
          genesisDigest: current.membership.genesisDigest,
          seat,
          nonce: (current.log.lastNonces.get(seat) ?? 0) + 1,
          headSeq: current.log.head.seq,
          headHash: parentHash,
          command: ownedCommand,
        };
        let external: readonly IndexedHandProof[] | undefined;
        if (ownedCommand.type === 'CONFIRM_TRADE') {
          const planned = planTradeProof(body, current.log);
          if (!planned.ok) return planned;
          if (planned.value.indices.length > 0 && planned.value.owner !== seat) {
            const owner = resolveArtifactSigner(
              current.log.authority,
              current.log.genesis,
              current.log.crypto?.epoch ?? current.log.authority?.epoch ?? 0,
              planned.value.owner,
            );
            if (!owner.ok) return owner;
            const request = signTradeProofRequest(planned.value.body, signingKey);
            const received = await requestTradeProofs(request, current, owner.value.publicKey);
            if (!received.ok) return received;
            if (disposed || context !== current || entryHash(context.log.head) !== parentHash)
              return failure(
                'non-voter-stale-head',
                'Certified head changed while awaiting trade proof',
              );
            external = received.value;
          }
        }
        const evidence = driver.prepareCommand?.(body, current.log, external);
        if (evidence && !evidence.ok) return evidence;
        if (disposed || context !== current || entryHash(context.log.head) !== parentHash)
          return failure(
            'non-voter-stale-head',
            'Certified head changed during command preparation',
          );
        const signed = signCommand(
          evidence?.value ? { ...body, evidence: evidence.value } : body,
          signingKey,
        );
        const detachedSigned = detachSignedCommand(signed);
        if (!detachedSigned.ok) return detachedSigned;
        const returned = detachSignedCommand(detachedSigned.value);
        if (!returned.ok) return returned;
        pendingCommand = { ...intent, signed: detachedSigned.value };
        retained = true;
        const sent = transmit({ t: 'SUBMIT', cmd: detachedSigned.value });
        return sent.ok ? returned : sent;
      } finally {
        if (!retained && pendingCommand === intent) pendingCommand = null;
      }
    },
    legalCommands() {
      if (disposed || !context || !driver) return { commands: [], templates: [] };
      const privateState = driver.privateState(seat);
      if (!privateState) return { commands: [], templates: [] };
      const automatic = sessionOptions.engine.getAutomaticInput(
        context.log.state,
        new Map([[seat, privateState]]),
      );
      if (automatic?.kind === 'command' && automatic.seat === seat)
        return { commands: [copyCanonical(automatic.command)], templates: [] };
      try {
        return {
          commands: enumerateCommands(
            sessionOptions.engine,
            context.log.state,
            seat,
            privateState,
            {
              sampleIndex: () => 0,
            },
          ),
          templates: [],
        };
      } catch {
        return { commands: [], templates: [] };
      }
    },
    async publishContributions() {
      if (disposed || !context || !driver || !signingKey)
        return failure('non-voter-disposed', 'Non-voter actor is disposed');
      const current = context;
      const refreshed = refreshInboxes(current);
      if (!refreshed.ok) return refreshed;
      const crypto = current.log.crypto;
      if (!crypto) return success(undefined);
      const beaconSource = sessionOptions.beaconSource;
      const beaconStore = sessionOptions.beaconContributions;
      if (beaconSource && beaconStore) {
        const signer = resolveArtifactSigner(
          current.log.authority,
          current.log.genesis,
          crypto.epoch,
          seat,
        );
        if (!signer.ok) return signer;
        const beacon = await prepareBeaconContribution(
          crypto,
          seat,
          signingKey,
          beaconSource,
          beaconStore,
          signer.value,
        );
        if (disposed || context !== current) return success(undefined);
        if (!beacon.ok) return beacon;
        if (beacon.value) {
          const sent = transmit({
            t: 'SYS_CONTRIB',
            genesisDigest: current.membership.genesisDigest,
            contribution: beacon.value,
          });
          if (!sent.ok) return sent;
        }
      }
      const counts = crypto.counts;
      if (
        counts &&
        counts.remaining.includes(seat) &&
        sessionOptions.countContributionStore &&
        driver.produceCountProof
      ) {
        const signer = resolveArtifactSigner(
          current.log.authority,
          current.log.genesis,
          crypto.epoch,
          seat,
        );
        if (!signer.ok) return signer;
        const contribution = await prepareCountContribution(
          counts.operation,
          seat,
          signingKey,
          current.log,
          (operation, ownedSeat, contextLog) =>
            driver?.produceCountProof?.(operation, ownedSeat, contextLog) ??
            failure('non-voter-count', 'Count proof source is unavailable'),
          sessionOptions.countContributionStore,
        );
        if (disposed || context !== current) return success(undefined);
        if (!contribution.ok) return contribution;
        const sent = transmit({
          t: 'COUNT_CONTRIB',
          genesisDigest: current.membership.genesisDigest,
          contribution: contribution.value,
        });
        if (!sent.ok) return sent;
      }
      const steal = crypto.steal;
      if (steal && sessionOptions.stealDeliveryStore) {
        const signer = resolveArtifactSigner(
          current.log.authority,
          current.log.genesis,
          crypto.epoch,
          seat,
        );
        if (!signer.ok) return signer;
        if (
          !steal.fixed &&
          steal.operation.victim.seat === seat &&
          driver.produceStealContribution
        ) {
          const contribution = await prepareStealContribution(
            steal.operation,
            seat,
            signingKey,
            current.log,
            (operation, ownedSeat, log, key) =>
              driver?.produceStealContribution?.(operation, ownedSeat, log, key) ??
              failure('non-voter-steal', 'Steal proof source is unavailable'),
            sessionOptions.stealDeliveryStore,
          );
          if (disposed || context !== current) return success(undefined);
          if (!contribution.ok) return contribution;
          const sent = transmit({
            t: 'STEAL_CONTRIB',
            genesisDigest: current.membership.genesisDigest,
            contribution: contribution.value,
          });
          if (!sent.ok) return sent;
        } else if (
          steal.fixed &&
          steal.operation.thief.seat === seat &&
          driver.produceStealResponse
        ) {
          const response = await prepareStealResponse(
            steal.fixed,
            seat,
            signingKey,
            current.log,
            (fixed, ownedSeat, log, key) =>
              driver?.produceStealResponse?.(fixed, ownedSeat, log, key) ??
              failure('non-voter-steal', 'Steal response source is unavailable'),
            sessionOptions.stealDeliveryStore,
          );
          if (disposed || context !== current) return success(undefined);
          if (!response.ok) return response;
          const sent = transmit({
            t: 'STEAL_RESPONSE',
            genesisDigest: current.membership.genesisDigest,
            response: response.value,
          });
          if (!sent.ok) return sent;
        }
      }
      const activeDeck = crypto.decks.active;
      if (activeDeck && sessionOptions.createDeckSource && sessionOptions.deckContributions) {
        const deck = crypto.decks.decks.find(
          (item) => item.commitment.definition.deckId === activeDeck.deckId,
        );
        if (!deck) return failure('non-voter-deck', 'Active deck setup is unavailable');
        const participant = activeDeck.participants.some(
          (item) => item.seat === seat && item.seat !== activeDeck.seat,
        );
        if (participant) {
          const signer = resolveArtifactSigner(
            current.log.authority,
            current.log.genesis,
            crypto.epoch,
            seat,
          );
          if (!signer.ok) return signer;
          const signers = activeDeck.participants
            .filter((item) => item.seat !== activeDeck.seat)
            .map((item) =>
              resolveArtifactSigner(
                current.log.authority,
                current.log.genesis,
                crypto.epoch,
                item.seat,
              ),
            );
          const invalidSigner = signers.find((item) => !item.ok);
          if (invalidSigner && !invalidSigner.ok) return invalidSigner;
          let source: ReturnType<NonNullable<typeof sessionOptions.createDeckSource>> | undefined;
          try {
            source = sessionOptions.createDeckSource(activeDeck.deckId, seat);
            const prefix = [...deckInbox.prefix()];
            const operationId = deckInbox.operationId();
            if (operationId === null) return success(undefined);
            const unlock = await prepareDeckUnlock(
              deck.setup,
              {
                genesisDigest: activeDeck.genesisDigest,
                epoch: activeDeck.epoch,
                anchor: activeDeck.anchor,
                position: activeDeck.position,
                seat: activeDeck.seat,
                slotId: activeDeck.slotId,
              },
              prefix,
              seat,
              signingKey,
              source,
              sessionOptions.deckContributions,
              signers
                .map((item) => (item.ok ? item.value : undefined))
                .filter((item) => item !== undefined),
              signer.value,
            );
            if (disposed || context !== current) return success(undefined);
            if (!unlock.ok) return unlock;
            if (unlock.value) {
              const refreshedDeckInbox = deckInbox.refresh(
                crypto,
                current.log.genesis,
                current.log.authority,
              );
              if (!refreshedDeckInbox.ok) return refreshedDeckInbox;
              const contribution = {
                kind: 'deck-unlock' as const,
                operationId,
                unlocks: [...prefix, unlock.value],
              };
              const sent = transmit({
                t: 'DECK_CONTRIB',
                genesisDigest: current.membership.genesisDigest,
                contribution,
              });
              if (!sent.ok) return sent;
            }
          } finally {
            source?.dispose();
          }
        }
      }
      return publishMasterReveal();
    },
    privateState() {
      const value = disposed ? null : (driver?.privateState(seat) ?? null);
      return value === null ? null : copyCanonical(value);
    },
    head() {
      const current = contextNow();
      return { seq: current.log.head.seq, hash: entryHash(current.log.head) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      driver?.dispose?.();
      masterReveal?.dispose();
      masterReveal = null;
      pendingTrade?.finish(failure('non-voter-disposed', 'Non-voter actor is disposed'));
      driver = null;
      signingKey?.fill(0);
      signingKey = null;
      context = null;
      entries.length = 0;
      pendingCommand = null;
      sentArtifacts.clear();
      tradeResponses.clear();
    },
  };
  try {
    unsubscribe = transport.onMessage(receive);
  } catch {
    // A malformed transport must not retain initialized private resources.
    for (const resource of [driver, masterReveal]) {
      try {
        resource?.dispose?.();
      } catch {
        /* Continue clearing remaining private resources. */
      }
    }
    signingKey?.fill(0);
    context = null;
    driver = null;
    masterReveal = null;
    return failure('non-voter-open', 'Could not subscribe the scoped verified actor');
  }
  // Public asynchronous operations always report failures through Result.
  let publication: Promise<Result<void>> | null = null;
  const publish = actor.publishContributions.bind(actor);
  actor.publishContributions = () => {
    publication ??= guard(async () => {
      for (;;) {
        const publishingContext = context;
        // oxlint-disable-next-line eslint/no-await-in-loop -- Complete the current publication before retrying a changed certified context.
        const result = await guard(publish);
        if (disposed || context === publishingContext) return result;
      }
    }).finally(() => {
      publication = null;
    });
    return publication;
  };
  return success({
    ...actor,
    advance: (prefix) => guard(() => actor.advance(prefix)),
    submit: (command, head) => guard(() => actor.submit(command, head)),
  });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    const a = canonicalEncode(left);
    const b = canonicalEncode(right);
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  } catch {
    return false;
  }
}

function copyCanonical<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Clone validated local values through the canonical codec.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function guard<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  return Promise.resolve()
    .then(run)
    .catch(() => failure('non-voter-operation', 'Actor operation failed'));
}

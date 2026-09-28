# Real-crypto network acceptance review

Review this test-only network runner and verified non-voter endpoint. Do not run tools or edit files. Return concrete correctness/security/liveness findings with file and function references, prioritize blockers/high/medium; say what you cannot verify from supplied context. No design expansion.

The four-human scenario1 has completed a default-ten-point game with 641 certified entries and four independent terminal audits. Scenario6 must inject a signed invalid proposer command, certify exclusion under the unchanged three-of-four threshold, dispose the offending P2PSession, and keep that seat's legal game commands and own crypto contributions flowing via a NON-VOTING endpoint. The endpoint must replay real certified histories, possess only its original seat's private secrets, never emit PROPOSAL/VOTE/COMMIT, serialize command preparation by parent/nonce, reserve and retransmit exact contributions, reply to real trade proof requests, and publish only its own master after terminal play. Quorum must not shrink or get a hidden replacement voter. Other eight faults retain their existing schedules, and all surviving honest peers must finish and audit matching histories. The fixed clean-game path is already tested; remaining fullgame scenarios have not passed yet.

Look for vacuous acceptance checks, wrong peer authority, foreign-secret fallbacks, missed contributions after actor creation, command/parent races, retry and terminal reveal deadlocks, certificate-wrapper handling, mutation aliases, unbounded loops, and test assertions that claim more than they exercise. Distinct valid quorum certificates for the same signed entry are equivalent. Current focused actor test was corrected for an awaited-submit/virtual-clock deadlock; latest result pending. Do not assume passing tests not shown.

Only deterministic test material and source are included, no actual game secrets or credentials. Reviews are preauthorized.


## packages/protocol/src/testing/verified-non-voter-actor.ts

```text
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
    } else if (
      'genesisDigest' in outgoing &&
      outgoing.genesisDigest !== current.membership.genesisDigest
    ) {
      return failure('non-voter-message-context', 'Sideband message belongs to another game');
    } else if (outgoing.t === 'MASTER_REVEAL') {
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
    try {
      if (recipient === undefined) transport.broadcast(encoded.value);
      else transport.send(recipient, encoded.value);
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
      void answerTradeProofRequest(from, message.request);
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
    const outgoing = encodeProtocolMessage({ t: 'TRADE_PROOF_RESPONSE', response });
    if (!outgoing.ok || disposed || context !== current) return;
    try {
      const sent = transmit({ t: 'TRADE_PROOF_RESPONSE', response }, from);
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

  unsubscribe = transport.onMessage(receive);

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
        entries.push(validated.value);
        context = advanced.value;
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
        return { commands: [automatic.command], templates: [] };
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
              deckInbox.prefix(),
              seat,
              signingKey,
              source,
              sessionOptions.deckContributions,
              signers
                .map((item) => (item.ok ? item.value : undefined))
                .filter((item) => item !== undefined),
              signer.value,
            );
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
                operationId: deckInbox.operationId() ?? '',
                unlocks: [...deckInbox.prefix(), unlock.value],
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
      return disposed ? null : (driver?.privateState(seat) ?? null);
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
    },
  };
  return success(actor);
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

```


## packages/protocol/src/testing/verified-non-voter-actor.test.ts

```text
import { enumerateCommands } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import { canonicalEncode } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import { entryHash, genesisDigest, signEntry } from '../genesis.js';
import { MemoryProtocolJournal } from '../journal.js';
import { decodeProtocolMessage } from '../messages.js';
import type { ProtocolMessage } from '../messages.js';
import { P2PSession } from '../p2p-session.js';
import { proposerFor } from '../proposal.js';
import type { CertifiedEntry } from '../proposal.js';
import { replayCertifiedPrefix } from '../replay.js';
import { signVote } from '../votes.js';
import { createMemnet } from './memnet.js';
import { VirtualClock } from './virtual-clock.js';
import { createVerifiedNetworkFixture } from './verified-network-fixture.js';
import { createVerifiedNonVoterActor } from './verified-non-voter-actor.js';
import type { VerifiedNonVoterActor } from './verified-non-voter-actor.js';

async function submitAndPump(
  session: P2PSession,
  seat: Seat,
  command: Parameters<P2PSession['submit']>[1],
  sessions: ReadonlyMap<Seat, P2PSession>,
  clock: VirtualClock,
): Promise<void> {
  const outcome: { result: Awaited<ReturnType<P2PSession['submit']>> | null } = { result: null };
  const pending = session.submit(seat, command, {
    expectedRevision: session.getCommittedHead().seq,
  });
  void pending.then((value) => {
    outcome.result = value;
    return value;
  });
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- Promise completion updates the captured result asynchronously.
  for (let step = 0; step < 80 && outcome.result === null; step += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Flush replicas between virtual-clock delivery steps.
    await Promise.all([...sessions.values()].map((replica) => replica.flush()));
    clock.advanceBy(0);
  }
  const result = outcome.result;
  if (result === null)
    throw new Error('Signed command did not finish within the virtual delivery bound');
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  await pending;
}

function sameCommand(left: unknown, right: unknown): boolean {
  const a = canonicalEncode(left);
  const b = canonicalEncode(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function copyPrefix(entries: readonly CertifiedEntry[]): CertifiedEntry[] {
  return entries.map(({ entry, certificate }) => ({
    entry: { ...entry },
    certificate: certificate.map((vote) => ({ ...vote, body: { ...vote.body } })),
  }));
}

describe('VerifiedNonVoterActor', () => {
  test('replays certified history, contributes and submits without consensus authority after exclusion', async () => {
    const fixture = createVerifiedNetworkFixture({ seed: 731, gameIndex: 2, vpTarget: 3 });
    const clock = new VirtualClock();
    const peers = [...fixture.identities.values()].map(({ peerId }) => peerId);
    const network = createMemnet({ peers, clock });
    const outgoingByPeer = new Map<string, ProtocolMessage[]>();
    const transports = new Map<string, ReturnType<typeof network.transport>>();
    for (const peer of peers) {
      const raw = network.transport(peer);
      const captured: ProtocolMessage[] = [];
      outgoingByPeer.set(peer, captured);
      transports.set(peer, {
        self: raw.self,
        peers: () => raw.peers(),
        onMessage: (listener: Parameters<typeof raw.onMessage>[0]) => raw.onMessage(listener),
        onPeerChange: (listener: Parameters<typeof raw.onPeerChange>[0]) =>
          raw.onPeerChange(listener),
        disconnect: (target: string) => raw.disconnect(target),
        broadcast(bytes: Uint8Array) {
          const decoded = decodeProtocolMessage(bytes);
          if (decoded.ok) captured.push(decoded.value);
          raw.broadcast(bytes);
        },
        send(target: string, bytes: Uint8Array) {
          const decoded = decodeProtocolMessage(bytes);
          if (decoded.ok) captured.push(decoded.value);
          raw.send(target, bytes);
        },
      });
    }

    const sessions = new Map<Seat, P2PSession>();
    let actor: VerifiedNonVoterActor | null = null;
    let actorMessages: ProtocolMessage[] = [];
    let actorSeat: Seat | null = null;
    let actorHistory: CertifiedEntry[] | null = null;
    let publishedOwnedContribution = false;
    try {
      for (const seat of [0, 1, 2, 3] as const) {
        const owner = fixture.identities.get(seat);
        const transport = transports.get(owner?.peerId ?? '');
        if (!owner || !transport) throw new Error(`Fixture seat ${seat} identity is missing`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each session binds a distinct identity and journal.
        const opened = await P2PSession.create({
          ...fixture.sessionOptions(seat),
          seat,
          secretKey: owner.secretKey,
          transport,
          clock,
          journal: new MemoryProtocolJournal(),
        });
        if (!opened.ok) throw new Error(`${opened.error.code}: ${opened.error.message}`);
        sessions.set(seat, opened.value);
      }

      for (let pass = 0; pass < 120; pass += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Flush all real replicas before advancing simulated time.
        await Promise.all([...sessions.values()].map((session) => session.flush()));
        clock.advanceBy(0);
        const source = sessions.get(0);
        if (source) {
          const history = source.exportSave();
          const replayed = replayCertifiedPrefix(
            history.genesis,
            history.entries,
            fixture.engine,
            fixture.policy,
          );
          if (!replayed.ok) throw new Error(`${replayed.error.code}: ${replayed.error.message}`);
          if (
            replayed.value.context.log.crypto?.beacon.active &&
            replayed.value.context.log.crypto.decks.decks.every(
              (deck) => deck.nextPass === deck.commitment.passHashes.length,
            )
          ) {
            const seat: Seat = 0;
            const owner = fixture.identities.get(seat);
            const transport = transports.get(owner?.peerId ?? '');
            if (!owner || !transport) throw new Error(`Fixture actor seat ${seat} is unavailable`);
            actorSeat = seat;
            actorHistory = copyPrefix(history.entries);
            const rawActorTransport = network.transport(owner.peerId);
            actorMessages = [];
            const created = createVerifiedNonVoterActor({
              seat,
              identity: owner,
              sessionOptions: fixture.sessionOptions(seat),
              transport: {
                self: rawActorTransport.self,
                peers: () => rawActorTransport.peers(),
                onMessage: (listener) => rawActorTransport.onMessage(listener),
                onPeerChange: (listener) => rawActorTransport.onPeerChange(listener),
                disconnect: (target) => rawActorTransport.disconnect(target),
                broadcast(bytes) {
                  const decoded = decodeProtocolMessage(bytes);
                  if (decoded.ok) actorMessages.push(decoded.value);
                  rawActorTransport.broadcast(bytes);
                },
                send(target, bytes) {
                  const decoded = decodeProtocolMessage(bytes);
                  if (decoded.ok) actorMessages.push(decoded.value);
                  rawActorTransport.send(target, bytes);
                },
              },
              clock,
            });
            if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
            actor = created.value;
            // oxlint-disable-next-line eslint/no-await-in-loop -- Advance only after the selected live certified head is captured.
            const published = await actor.advance(actorHistory);
            if (!published.ok)
              throw new Error(`${published.error.code}: ${published.error.message}`);
            const acceptedHead = actor.head();
            const originalPrefix = copyPrefix(actorHistory);
            const callerMutatedPrefix = copyPrefix(actorHistory);
            const firstCallerEntry = callerMutatedPrefix[0];
            if (!firstCallerEntry) throw new Error('Accepted prefix unexpectedly empty');
            callerMutatedPrefix[0] = {
              ...firstCallerEntry,
              entry: { ...firstCallerEntry.entry, stateHash: 'e'.repeat(64) },
            };
            // oxlint-disable-next-line eslint/no-await-in-loop -- Reject entry forks after retaining the original accepted prefix.
            const forked = await actor.advance(callerMutatedPrefix);
            if (forked.ok || forked.error.code !== 'non-voter-prefix-fork')
              throw new Error('Actor accepted a changed signed entry in its prefix');
            // Different valid quorum subsets may certify the same signed entry;
            // the actor retains its already-validated wrapper for that entry.
            const alternateCertificatePrefix = copyPrefix(actorHistory);
            const firstAccepted = alternateCertificatePrefix[0];
            if (!firstAccepted) throw new Error('Accepted prefix unexpectedly empty');
            const alternateCertificate = ([0, 1, 3] as const).map((voterSeat) => {
              const signer = fixture.identities.get(voterSeat);
              if (!signer) throw new Error(`Fixture voter ${voterSeat} is missing`);
              return signVote(
                {
                  genesisDigest: genesisDigest(fixture.genesis),
                  epoch: 0,
                  seat: voterSeat,
                  seq: firstAccepted.entry.seq,
                  term: firstAccepted.entry.term,
                  phase: 'precommit',
                  valueHash: entryHash(firstAccepted.entry),
                },
                signer.secretKey,
              );
            });
            alternateCertificatePrefix[0] = {
              ...firstAccepted,
              certificate: alternateCertificate,
            };
            // oxlint-disable-next-line eslint/no-await-in-loop -- Accept the same entry under another valid quorum wrapper.
            const alternate = await actor.advance(alternateCertificatePrefix);
            if (!alternate.ok)
              throw new Error(`Actor rejected an equivalent certificate: ${alternate.error.code}`);
            // Mutating the caller's original object after acceptance must not
            // alter the actor's stored prefix.
            const mutatedEntry = callerMutatedPrefix[0];
            if (!mutatedEntry) throw new Error('Mutated caller prefix unexpectedly empty');
            actorHistory[0] = mutatedEntry;
            // oxlint-disable-next-line eslint/no-await-in-loop -- Re-submit the original detached prefix after caller mutation.
            const detached = await actor.advance(originalPrefix);
            if (!detached.ok) throw new Error('Caller mutation changed the actor accepted prefix');
            actorHistory = originalPrefix;
            if (actor.head().seq !== acceptedHead.seq || actor.head().hash !== acceptedHead.hash)
              throw new Error('Mutated caller prefix changed the actor head');
            const lastAccepted = actorHistory.at(-1);
            if (!lastAccepted) throw new Error('Actor prefix unexpectedly lacks an entry');
            const changedPrefix = [
              ...actorHistory.slice(0, -1),
              {
                ...lastAccepted,
                entry: { ...lastAccepted.entry, stateHash: 'f'.repeat(64) },
              },
            ];
            // oxlint-disable-next-line eslint/no-await-in-loop -- Test the invalid fork without racing another prefix update.
            const fork = await actor.advance(changedPrefix);
            if (fork.ok || fork.error.code !== 'non-voter-prefix-fork')
              throw new Error('Actor accepted a changed certified prefix');
            if (actor.head().seq !== acceptedHead.seq || actor.head().hash !== acceptedHead.hash)
              throw new Error('Rejected prefix changed the actor head');
            publishedOwnedContribution = actorMessages.some(
              (message) =>
                message.t === 'SYS_CONTRIB' && message.contribution.signed.body.seat === seat,
            );
            if (!publishedOwnedContribution)
              throw new Error('Actor did not publish its owned beacon contribution');
            break;
          }
        }

        for (const [seat, session] of sessions) {
          const pending = session
            .getPending()
            .some((item) => item.kind === 'player' && item.seat === seat);
          if (!pending) continue;
          const privateState = session.getPrivate(seat);
          if (!privateState) continue;
          const command = enumerateCommands(
            fixture.engine,
            session.getState(),
            seat,
            privateState,
            {
              sampleIndex: () => 0,
            },
          )[0];
          if (command)
            // oxlint-disable-next-line eslint/no-await-in-loop -- Drive an admitted command to certification before polling the next action.
            await submitAndPump(session, seat, command, sessions, clock);
        }
      }
      if (!actor || actorSeat === null || !actorHistory)
        throw new Error('Did not reach a verified player turn');
      const nonVoter = actor;

      let submitted: ReturnType<VerifiedNonVoterActor['submit']> extends Promise<infer T>
        ? T | null
        : never = null;
      for (let pass = 0; pass < 160 && !submitted?.ok; pass += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Flush all real replicas before advancing simulated time.
        await Promise.all([...sessions.values()].map((session) => session.flush()));
        clock.advanceBy(0);
        const latestSource = [...sessions.values()].find(
          (session) => session.getCommittedHead().seq >= nonVoter.head().seq,
        );
        const history = latestSource?.exportSave();
        if (!history) throw new Error('Certified source history is unavailable');
        // oxlint-disable-next-line eslint/no-await-in-loop -- Prefix validation completes before the next virtual-clock step.
        const advanced = await nonVoter.advance(history.entries);
        if (!advanced.ok) throw new Error(`${advanced.error.code}: ${advanced.error.message}`);
        const actorSession = sessions.get(actorSeat);
        const actorHasTurn = actorSession
          ?.getPending()
          .some((item) => item.kind === 'player' && item.seat === actorSeat);
        if (!actorHasTurn) {
          for (const [seat, session] of sessions) {
            const pending = session
              .getPending()
              .some((item) => item.kind === 'player' && item.seat === seat);
            const privateState = session.getPrivate(seat);
            if (!pending || !privateState) continue;
            const command = enumerateCommands(
              fixture.engine,
              session.getState(),
              seat,
              privateState,
              { sampleIndex: () => 0 },
            )[0];
            if (command)
              // oxlint-disable-next-line eslint/no-await-in-loop -- Advance the actual game until the tested actor has a player action.
              await submitAndPump(session, seat, command, sessions, clock);
          }
          continue;
        }
        const command = nonVoter.legalCommands().commands[0];
        if (!command) continue;

        const current = replayCertifiedPrefix(
          history.genesis,
          history.entries,
          fixture.engine,
          fixture.policy,
        );
        if (!current.ok) throw new Error(`${current.error.code}: ${current.error.message}`);
        const parent = current.value.context;
        const offender = actorSeat;
        const offenderIdentity = fixture.identities.get(offender);
        if (!offenderIdentity) throw new Error(`Fixture identity ${offender} is missing`);
        const vote = (valueHash: string) =>
          signVote(
            {
              genesisDigest: parent.membership.genesisDigest,
              epoch: parent.membership.epoch,
              seat: offender,
              seq: parent.log.head.seq + 1,
              term: 1,
              phase: 'prevote',
              valueHash,
            },
            offenderIdentity.secretKey,
          );
        const elected = proposerFor(
          parent.log.head.seq + 1,
          1,
          parent.membership,
          parent.excludedProposers,
        );
        const sequencer = fixture.identities.get(elected.seat);
        if (!sequencer) throw new Error(`Fixture proposer ${elected.seat} is missing`);
        const entry = signEntry(
          {
            seq: parent.log.head.seq + 1,
            term: 1,
            prevHash: entryHash(parent.log.head),
            payload: {
              kind: 'control',
              action: 'exclude-proposer',
              offender,
              evidence: {
                kind: 'vote-equivocation',
                first: vote('a'.repeat(64)),
                second: vote('b'.repeat(64)),
              },
            },
            stateHash: parent.log.head.stateHash,
            sequencer: elected.publicKey,
          },
          sequencer.secretKey,
        );
        const certificate = ([0, 1, 2] as const).map((seat) => {
          const signer = fixture.identities.get(seat);
          if (!signer) throw new Error(`Fixture voter ${seat} is missing`);
          return signVote(
            {
              genesisDigest: parent.membership.genesisDigest,
              epoch: parent.membership.epoch,
              seat,
              seq: entry.seq,
              term: entry.term,
              phase: 'precommit',
              valueHash: entryHash(entry),
            },
            signer.secretKey,
          );
        });
        const exclusion: CertifiedEntry = { entry, certificate };
        // oxlint-disable-next-line eslint/no-await-in-loop -- Apply the synthetic certified control before testing its next command.
        const rejected = await nonVoter.advance([...history.entries, exclusion]);
        if (!rejected.ok) throw new Error(`${rejected.error.code}: ${rejected.error.message}`);
        const postExclusionCommand = nonVoter.legalCommands().commands[0];
        if (!postExclusionCommand)
          throw new Error('Actor lost its legal command after proposer exclusion');

        actorMessages.length = 0;
        // oxlint-disable-next-line eslint/no-await-in-loop -- Command preparation includes an optional proof round-trip.
        submitted = await nonVoter.submit(postExclusionCommand, nonVoter.head());
        if (submitted.ok) {
          const legal = nonVoter.legalCommands().commands;
          const different = legal.find(
            (candidate) => !sameCommand(candidate, postExclusionCommand),
          );
          if (legal.length < 2 || !different)
            throw new Error('Fixture did not provide two distinct legal actions for one parent');
          // oxlint-disable-next-line eslint/no-await-in-loop -- Verify competing command is refused while the first is pending.
          const conflict = await nonVoter.submit(different, nonVoter.head());
          if (conflict.ok || conflict.error.code !== 'non-voter-command-pending')
            throw new Error('Actor accepted a second command at the same parent');
          // oxlint-disable-next-line eslint/no-await-in-loop -- Retry the identical signed command at the same parent.
          const retry = await nonVoter.submit(postExclusionCommand, nonVoter.head());
          if (!retry.ok || retry.value.sig !== submitted.value.sig)
            throw new Error('Actor retry did not reuse its persisted signed command');
        }
      }
      if (!submitted?.ok) throw new Error('Actor could not submit a legal command after exclusion');
      const messages = actorMessages;
      expect(actor?.privateState()?.seat).toBe(actorSeat);
      expect(
        messages.some((message) => message.t === 'SUBMIT' && message.cmd.body.seat === actorSeat),
      ).toBe(true);
      expect(messages.some((message) => ['PROPOSAL', 'VOTE', 'COMMIT'].includes(message.t))).toBe(
        false,
      );
      expect(publishedOwnedContribution).toBe(true);
    } finally {
      actor?.dispose();
      for (const session of sessions.values()) session.dispose();
      network.dispose();
      fixture.dispose();
    }
  }, 90_000);
});

```


## packages/protocol/src/testing/verified-network-fixture.ts

```text
import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { auditCertifiedGame } from '../audit.js';
import type { AuditReport } from '../audit-types.js';
import { createBeaconSecretSource } from '../beacon-source.js';
import type { BeaconSecretProvider } from '../beacon-source.js';
import { MemoryBeaconContributionStore } from '../beacon-contributions.js';
import { MemoryCheatCandidateStore } from '../cheat-candidates.js';
import { MemoryCountContributionStore } from '../count-contributions.js';
import { deckCeremonyId, genesisDeckDefinitions, validateDeckCeremony } from '../deck-genesis.js';
import type { DeckDefinition } from '../deck-setup.js';
import { createDeckSecretSource } from '../deck-source.js';
import type { DeckContributionStore } from '../deck-outbox.js';
import {
  GENESIS_PREVIOUS_HASH,
  genesisBody,
  genesisDigest,
  genesisId,
  signEntry,
  signVerifiedGenesis,
} from '../genesis.js';
import { createHandSecretSource } from '../hand-source.js';
import type { MasterRevealStore } from '../master-reveal.js';
import { MemoryStealDeliveryStore } from '../steal-contributions.js';
import { createStealSecretSource } from '../steal-source.js';
import type { Genesis, GenesisBody } from '../types.js';
import type { ReplayPolicy } from '../replay.js';
import type { P2PSessionOptions } from '../p2p-session.js';
import { VerifiedSessionDriver } from '../verified-session-driver.js';
import { createGenesisDeckFixture } from './deck-fixture.js';
import { createSimulationGenesis } from './simulation-genesis.js';

const HUMAN_SEATS = [0, 1, 2, 3] as const satisfies readonly Seat[];
const BEACON_LENGTH = 128;

class MemoryDeckContributionStore implements DeckContributionStore {
  readonly #records = new Map<string, Uint8Array>();

  async load(id: string): Promise<Uint8Array | null> {
    return this.#records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#records.has(id)) return false;
    this.#records.set(id, bytes.slice());
    return true;
  }

  dispose(): void {
    for (const bytes of this.#records.values()) bytes.fill(0);
    this.#records.clear();
  }
}

class MemoryMasterRevealStore implements MasterRevealStore {
  readonly #records = new Map<string, Uint8Array>();

  async load(id: string): Promise<Uint8Array | null> {
    return this.#records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#records.has(id)) return false;
    this.#records.set(id, bytes.slice());
    return true;
  }

  dispose(): void {
    for (const bytes of this.#records.values()) bytes.fill(0);
    this.#records.clear();
  }
}

interface SeatStores {
  readonly beacon: MemoryBeaconContributionStore;
  readonly cheat: MemoryCheatCandidateStore;
  readonly count: MemoryCountContributionStore;
  readonly deck: MemoryDeckContributionStore;
  readonly masterReveal: MemoryMasterRevealStore;
  readonly steal: MemoryStealDeliveryStore;
}

export type VerifiedNetworkSessionOptions = Pick<
  P2PSessionOptions,
  | 'genesisEntry'
  | 'engine'
  | 'policy'
  | 'beaconSource'
  | 'beaconContributions'
  | 'cheatCandidateStore'
  | 'countContributionStore'
  | 'stealDeliveryStore'
  | 'deckSetupPasses'
  | 'createDeckSource'
  | 'deckContributions'
  | 'createDriver'
  | 'masterReveal'
  | 'auditRunner'
>;

export interface VerifiedNetworkFixtureOptions {
  readonly seed: number;
  readonly gameIndex?: number;
  readonly vpTarget?: number;
}

/**
 * Real four-human verified genesis for network simulations. Sources and durable
 * in-memory outboxes are seat-scoped and remain stable for the fixture lifetime.
 */
export function createVerifiedNetworkFixture(options: VerifiedNetworkFixtureOptions) {
  const simulation = createSimulationGenesis({
    seed: options.seed,
    gameIndex: options.gameIndex ?? 0,
    humanCount: HUMAN_SEATS.length,
    ...(options.vpTarget === undefined
      ? {}
      : {
          config: {
            modules: [{ id: 'base', version: '1.0.0' }],
            seats: [...HUMAN_SEATS],
            options: { base: { mapLayout: 'random', vpTarget: options.vpTarget } },
          },
        }),
  });
  const genesisDraft: GenesisBody = {
    ...genesisBody(simulation.genesis),
    security: 'verified',
    commitments: {},
  };
  const deck = createGenesisDeckFixture(genesisDraft, simulation.identities);
  const decks = genesisDeckDefinitions(deck.body);
  if (!decks.ok)
    throw new Error(`Verified fixture deck definitions failed: ${decks.error.message}`);
  const masterSecrets = new Map<Seat, Uint8Array>(
    HUMAN_SEATS.map((seat) => [seat, scalarToBytes(BigInt(17 + seat))]),
  );
  const providers = new Map<Seat, BeaconSecretProvider>();
  const stores = new Map<Seat, SeatStores>();
  const dispose = (): void => {
    for (const provider of providers.values()) provider.dispose();
    for (const bytes of masterSecrets.values()) bytes.fill(0);
    for (const identity of simulation.identities.values()) identity.secretKey.fill(0);
    for (const seatStores of stores.values()) {
      seatStores.deck.dispose();
      seatStores.masterReveal.dispose();
    }
  };

  try {
    const ceremonyId = deckCeremonyId(deck.body);
    for (const seat of HUMAN_SEATS) {
      const master = masterSecrets.get(seat);
      if (!master) throw new Error(`Missing fixture master for seat ${seat}`);
      providers.set(seat, createBeaconSecretSource(master, { ceremonyId, seat }, BEACON_LENGTH));
      stores.set(seat, {
        beacon: new MemoryBeaconContributionStore(),
        cheat: new MemoryCheatCandidateStore(),
        count: new MemoryCountContributionStore(),
        deck: new MemoryDeckContributionStore(),
        masterReveal: new MemoryMasterRevealStore(),
        steal: new MemoryStealDeliveryStore(),
      });
    }

    const body: GenesisBody = {
      ...deck.body,
      commitments: {
        ...deck.body.commitments,
        beaconChains: HUMAN_SEATS.map((seat) => {
          const provider = providers.get(seat);
          if (!provider) throw new Error(`Missing beacon provider for seat ${seat}`);
          return {
            seat,
            length: BEACON_LENGTH,
            tip: toBase64Url(provider.initialCommitment.tip),
          };
        }),
      },
    };
    const genesis: Genesis = {
      ...body,
      gameId: genesisId(body),
      signatures: HUMAN_SEATS.map((seat) => {
        const identity = simulation.identities.get(seat);
        if (!identity) throw new Error(`Missing fixture identity for seat ${seat}`);
        const signed = signVerifiedGenesis(body, deck.transcripts, seat, identity.secretKey);
        if (!signed.ok) throw new Error(`Verified genesis signing failed: ${signed.error.message}`);
        return signed.value;
      }),
    };
    const policy: ReplayPolicy = {
      genesis: {
        verifyCommitments: (candidate) => validateDeckCeremony(candidate, deck.transcripts),
      },
      // Command and supported system evidence use the protocol's built-in strict verifiers.
      entry: {},
    };
    const state = simulation.engine.createGame(genesis.config, fromBase64Url(genesis.genesisSeed));
    const sequencer = simulation.identities.get(HUMAN_SEATS[0]);
    if (!sequencer) throw new Error('Missing initial fixture sequencer');
    const entry = signEntry(
      {
        seq: 0,
        term: 1,
        prevHash: GENESIS_PREVIOUS_HASH,
        payload: { kind: 'genesis', genesis },
        stateHash: toHex(hashValue(state)),
        sequencer: sequencer.peerId,
      },
      sequencer.secretKey,
    );
    const deckSetupPasses = deck.transcripts.flatMap((transcript) =>
      transcript.passes.map((pass) => ({ deckId: transcript.deckId, pass })),
    );
    const definitions = new Map<string, DeckDefinition>(
      decks.value.map((item) => [item.deckId, item]),
    );
    const digest = genesisDigest(genesis);

    const sessionOptions = (seat: Seat): VerifiedNetworkSessionOptions => {
      const master = masterSecrets.get(seat);
      const provider = providers.get(seat);
      const seatStores = stores.get(seat);
      const identity = simulation.identities.get(seat);
      if (!master || !provider || !seatStores || !identity)
        throw new RangeError(`Seat ${seat} is not an owned human fixture seat`);
      const createDeckSource = (deckId: string, ownedSeat: Seat) => {
        if (ownedSeat !== seat)
          throw new RangeError(`Seat ${seat} does not own deck seat ${ownedSeat}`);
        const definition = definitions.get(deckId);
        if (!definition) throw new RangeError(`Unknown fixture deck ${deckId}`);
        return createDeckSecretSource(master, definition, seat);
      };
      return {
        genesisEntry: entry,
        engine: simulation.engine,
        policy,
        beaconSource: provider.source,
        beaconContributions: seatStores.beacon,
        cheatCandidateStore: seatStores.cheat,
        countContributionStore: seatStores.count,
        stealDeliveryStore: seatStores.steal,
        deckSetupPasses,
        createDeckSource,
        deckContributions: seatStores.deck,
        masterReveal: {
          store: seatStores.masterReveal,
          loadOwnedMaster: async (requestedSeat: Seat) =>
            requestedSeat === seat ? master.slice() : null,
        },
        auditRunner: (input) => {
          let report: AuditReport;
          try {
            report = auditCertifiedGame({
              genesisEntry: input.genesisEntry,
              entries: input.entries,
              masters: input.masters,
              engine: simulation.engine,
              policy,
            });
          } finally {
            for (const item of input.masters) item.master.fill(0);
          }
          return { result: Promise.resolve(report), cancel() {} };
        },
        createDriver: (engine, signedGenesis, _clock, ownedSeats) => {
          if (ownedSeats.length !== 1 || ownedSeats[0] !== seat)
            throw new RangeError(`Seat ${seat} driver may own only its human seat`);
          return new VerifiedSessionDriver(
            engine,
            signedGenesis,
            ownedSeats,
            createDeckSource,
            (ownedSeat) => {
              if (ownedSeat !== seat)
                throw new RangeError(`Seat ${seat} does not own seat ${ownedSeat}`);
              return createHandSecretSource(master, digest, seat);
            },
            (ownedSeat) => {
              if (ownedSeat !== seat)
                throw new RangeError(`Seat ${seat} does not own seat ${ownedSeat}`);
              const owner = genesis.seats.find((item) => item.seat === seat);
              if (!owner || owner.kind !== 'human') throw new Error('Fixture seat is not human');
              return createStealSecretSource(master, genesis.ceremonyNonce, seat, owner.publicKey);
            },
          );
        },
      };
    };

    return {
      engine: simulation.engine,
      identities: simulation.identities,
      genesis,
      entry,
      policy,
      sessionOptions,
      mastersForAudit: () =>
        HUMAN_SEATS.map((seat) => {
          const master = masterSecrets.get(seat);
          if (!master) throw new Error(`Fixture master for seat ${seat} is unavailable`);
          return { seat, master: master.slice() };
        }),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

```


## packages/protocol/src/testing/verified-network-fixture.test.ts

```text
import { scalarToBytes } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { genesisDeckDefinitions } from '../deck-genesis.js';
import { validateGenesisEntry } from '../genesis.js';
import { VirtualClock } from './virtual-clock.js';
import { createVerifiedNetworkFixture } from './verified-network-fixture.js';

describe('verified network fixture', () => {
  test('builds strict four-human 25-card genesis with seat-scoped reusable options', async () => {
    const fixture = createVerifiedNetworkFixture({ seed: 802, gameIndex: 3, vpTarget: 3 });
    try {
      expect(fixture.genesis.security).toBe('verified');
      expect(fixture.genesis.seats).toHaveLength(4);
      expect(fixture.genesis.seats.every((seat) => seat.kind === 'human')).toBe(true);
      expect(fixture.genesis.commitments.beaconChains).toMatchObject([
        { seat: 0, length: 128 },
        { seat: 1, length: 128 },
        { seat: 2, length: 128 },
        { seat: 3, length: 128 },
      ]);
      expect(fixture.genesis.commitments.escrow).toHaveLength(4);
      expect(validateGenesisEntry(fixture.entry, fixture.engine, fixture.policy.genesis).ok).toBe(
        true,
      );
      const deck = genesisDeckDefinitions(fixture.genesis);
      expect(deck.ok).toBe(true);
      if (!deck.ok) return;
      expect(deck.value.find((item) => item.deckId === 'dev')?.cards).toHaveLength(25);

      const seatZero = fixture.sessionOptions(0);
      const restoredSeatZero = fixture.sessionOptions(0);
      const seatOne = fixture.sessionOptions(1);
      expect(seatZero.beaconContributions).toBe(restoredSeatZero.beaconContributions);
      expect(seatZero.deckContributions).toBe(restoredSeatZero.deckContributions);
      expect(seatZero.masterReveal?.store).toBe(restoredSeatZero.masterReveal?.store);
      expect(seatZero.beaconContributions).not.toBe(seatOne.beaconContributions);
      expect(seatZero.masterReveal?.store).not.toBe(seatOne.masterReveal?.store);
      expect('secretKey' in seatZero).toBe(false);

      const ownMaster = await seatZero.masterReveal?.loadOwnedMaster(0);
      const foreignMaster = await seatZero.masterReveal?.loadOwnedMaster(1);
      expect(ownMaster).toEqual(scalarToBytes(17n));
      expect(foreignMaster).toBeNull();
      ownMaster?.fill(0);

      expect(() => seatZero.createDeckSource?.('dev', 1)).toThrow(/does not own/);
      expect(() =>
        seatZero.createDriver(fixture.engine, fixture.genesis, new VirtualClock(), [0, 1]),
      ).toThrow(/may own only its human seat/);
      const driver = seatZero.createDriver(
        fixture.engine,
        fixture.genesis,
        new VirtualClock(),
        [0],
      );
      try {
        expect(driver.privateState(0)?.seat).toBe(0);
        expect(driver.privateState(1)).toBeNull();
      } finally {
        driver.dispose?.();
      }

      const masterCopies = fixture.mastersForAudit();
      expect(masterCopies.map(({ seat }) => seat)).toEqual([0, 1, 2, 3]);
      expect(masterCopies[0]?.master).toEqual(scalarToBytes(17n));
      for (const { master } of masterCopies) master.fill(0);

      const beacon = seatZero.beaconSource;
      expect(beacon?.link(0, 1)).toHaveLength(32);
      expect(beacon?.extension(1)).toMatchObject({ length: 128 });
      expect(beacon?.extension(1).tip).toHaveLength(32);
    } finally {
      fixture.dispose();
    }
  }, 30_000);
});

```


## tools/sim/src/net.ts

```text
import { RandomBot, createBotRng } from '@cp2p/bots';
import { canonicalDecode, hashValue, toHex } from '@cp2p/codec';
import { success } from '@cp2p/engine';
import type { GameState, Pending, PrivateState, Result, Seat } from '@cp2p/engine';
import {
  MemoryProtocolJournal,
  P2PSession,
  decodeProtocolMessage,
  encodeProtocolMessage,
  entryHash,
  genesisDigest,
  initialProposalContext,
  proposerFor,
  quorumSize,
  replayCertifiedPrefix,
  signCommand,
} from '@cp2p/protocol';
import type {
  AuditReport,
  CertifiedEntry,
  ProposalContext,
  ProtocolClock,
  P2PSessionOptions,
  SessionUpdate,
  Transport,
} from '@cp2p/protocol';
import {
  SimulationDriver,
  createMemnet,
  createSimulationGenesis,
  createVerifiedNetworkFixture,
  createVerifiedNonVoterActor,
} from '@cp2p/protocol/testing';
import type { VerifiedNonVoterActor } from '@cp2p/protocol/testing';
import { deriveSeed } from './random-source.js';
import { invalidCommandProposal } from './net-adversary.js';

export interface NetworkGameOptions {
  seed: number;
  gameIndex: number;
  scenario: number;
  maxSteps?: number;
  /** Stage 07 acceptance uses genuine private sources and proofs on the same fault schedules. */
  security?: 'stub' | 'verified';
  maxElapsedMs?: number;
  onProgress?: (progress: {
    revision: number;
    turn: number;
    virtualMilliseconds: number;
    elapsedMilliseconds: number;
  }) => void;
}

export interface NetworkGameResult {
  security: 'stub' | 'verified';
  protocolVersion: number;
  seed: number;
  gameIndex: number;
  scenario: number;
  turns: number;
  inputs: number;
  virtualMilliseconds: number;
  elapsedMilliseconds: number;
  finalStateHash: string;
  finalLogHash: string;
  audits: {
    seat: Seat;
    ok: true;
    complete: true;
    finalHead: { seq: number; hash: string };
    cheatFindings: AuditReport['cheatFindings'];
  }[];
  faultInjected: boolean;
  faultRecovered: boolean;
  faultEvidence: {
    injectedAtRevision: number;
    majorityCommitsDuringPartition: number | null;
    isolatedCommitsDuringPartition: number | null;
    pausedPeersDuringPartition: number;
    replacementTerm: number | null;
    censoredCommandCommitted: boolean;
    snapshotRequests: number;
    snapshotResponses: number;
    duplicateDeliveries: number;
    certifiedExclusionPeers: number;
    byzantineCommandCommits: number;
  };
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Full games through the real peer sessions, signatures, wire encoding and journals. */
export async function runNetworkGame(options: NetworkGameOptions): Promise<NetworkGameResult> {
  if (!Number.isInteger(options.scenario) || options.scenario < 1 || options.scenario > 9)
    throw new Error('This network scenario is not implemented yet');
  const started = performance.now();
  const verified =
    options.security === 'verified'
      ? createVerifiedNetworkFixture({ seed: options.seed, gameIndex: options.gameIndex })
      : null;
  const game =
    verified ?? createSimulationGenesis({ seed: options.seed, gameIndex: options.gameIndex });
  const keys = [...game.identities.values()];
  const network = createMemnet({
    peers: keys.map((identity) => identity.peerId),
    seed: options.seed + options.gameIndex,
    defaultLink:
      options.scenario === 2
        ? { latencyMs: 225, jitterMs: 175, duplicateProbability: 0.1 }
        : { latencyMs: 1 },
  });
  const sessions = new Map<Seat, P2PSession>();
  const updates = new Map<Seat, SessionUpdate>();
  const journals = new Map(
    game.genesis.config.seats.map((seat) => [seat, new MemoryProtocolJournal()]),
  );
  const stateHashes = new Map<number, string>();
  const logHashes = new Map<number, string>();
  const offline = new Set<Seat>();
  let faultInjected = false;
  let faultRecovered = false;
  let recoverAt = Infinity;
  let faultRevision = 0;
  let partitionStableRevisions: Map<Seat, number> | null = null;
  let partitionCheckAt = Infinity;
  let partitionRequested: { proposer: Seat; commandSeat: Seat | null; seq: number } | null = null;
  const partitionProposalSeen = new Set<Seat>();
  let partitionIsolatedSeat: Seat | null = null;
  let majorityCommitsDuringPartition: number | null = null;
  let isolatedCommitsDuringPartition: number | null = null;
  let pausedPeersDuringPartition = 0;
  let replacementTerm: number | null = null;
  let censoredCommandCommitted = false;
  let crashRequested: { seat: Seat; seq: number } | null = null;
  let crashedProposalHeight: number | null = null;
  let crashedProposerSeat: Seat | null = null;
  const intentionallyInterruptedSubmissions = new WeakSet<object>();
  let maliciousHeight: number | null = null;
  let censoredCommandHash: string | null = null;
  let corruptedHeight: number | null = null;
  let desyncObserved = false;
  const snapshotRequestAtSeqs = new Set<number>();
  const snapshotResponsePairs = new Set<string>();
  let certifiedExclusionPeers = 0;
  let byzantineHalted = false;
  let byzantineSubmissionRevision: number | null = null;
  let byzantineSubmissionHash: string | null = null;
  let byzantineCommandCommits = 0;
  let verifiedNonVoter: VerifiedNonVoterActor | null = null;
  let byzantinePrivateCache: {
    revision: number;
    privateState: PrivateState;
    context: ProposalContext;
  } | null = null;
  const bots = new Map(
    game.genesis.config.seats.map((seat) => [
      seat,
      {
        bot: new RandomBot(game.engine),
        rng: createBotRng(deriveSeed(options.seed, options.gameIndex, 'net-bot', seat)),
      },
    ]),
  );
  const failures: string[] = [];
  let submission: { seat: Seat; result: Result<void> | null } | null = null;

  function observe(seat: Seat, update: SessionUpdate): void {
    const prior = updates.get(seat);
    if (prior && update.revision < prior.revision)
      failures.push(`Peer ${seat} rolled back a commit`);
    if (update.status.kind === 'error') {
      if (options.scenario === 8 && seat === 0 && faultInjected && !faultRecovered)
        desyncObserved = true;
      else if (
        options.scenario === 6 &&
        seat === 0 &&
        faultInjected &&
        ['Objective evidence implicates the local signing key', 'replica-fault-limit'].includes(
          update.status.message,
        )
      )
        byzantineHalted = true;
      else failures.push(`Peer ${seat}: ${update.status.message}`);
    }
    if (prior?.revision !== update.revision) {
      const hash = toHex(hashValue(update.state));
      const known = stateHashes.get(update.revision);
      if (known !== undefined && known !== hash)
        failures.push(`Public state diverged at revision ${update.revision}`);
      stateHashes.set(update.revision, hash);
    }
    const head = sessions.get(seat)?.getCommittedHead();
    if (head) {
      const known = logHashes.get(head.seq);
      if (known !== undefined && known !== head.hash)
        failures.push(`Committed log value diverged at revision ${head.seq}`);
      logHashes.set(head.seq, head.hash);
    }
    updates.set(seat, update);
    if (
      options.scenario === 8 &&
      seat === 0 &&
      desyncObserved &&
      corruptedHeight !== null &&
      update.revision >= corruptedHeight &&
      update.status.kind === 'running'
    )
      faultRecovered = true;
    if (
      (options.scenario === 6 || seat === 0) &&
      maliciousHeight !== null &&
      update.revision >= maliciousHeight &&
      !faultRecovered
    ) {
      if (options.scenario === 6) {
        const committed = sessions.get(seat)?.exportSave().entries[maliciousHeight - 1];
        if (committed?.entry.payload.kind !== 'control' || committed.entry.payload.offender !== 0)
          failures.push('Invalid proposer was not excluded by the certified control entry');
      }
      if (options.scenario === 7) {
        const committed = sessions.get(seat)?.exportSave().entries[maliciousHeight - 1];
        if (
          committed?.entry.payload.kind !== 'command' ||
          toHex(hashValue(committed.entry.payload.signed)) !== censoredCommandHash ||
          committed.entry.term <= 1 ||
          committed.entry.sequencer === game.identities.get(seat)?.peerId
        )
          failures.push('Censored command was not committed unchanged by a later proposer');
        else {
          censoredCommandCommitted = true;
          replacementTerm = committed.entry.term;
        }
      }
      faultRecovered = true;
    }
    if (
      (seat === 0 || (options.scenario === 6 && seat === 1)) &&
      prior?.revision !== update.revision
    )
      options.onProgress?.({
        revision: update.revision,
        turn: update.state.turn.number,
        virtualMilliseconds: network.clock.now(),
        elapsedMilliseconds: performance.now() - started,
      });
  }

  async function flush(): Promise<void> {
    await Promise.all([...sessions.values()].map((session) => session.flush()));
  }

  function progressDiagnostic(): string {
    return JSON.stringify({
      submission,
      peers: [...sessions].map(([seat, session]) => ({
        seat,
        revision: updates.get(seat)?.revision,
        turn: updates.get(seat)?.state.turn,
        result: updates.get(seat)?.state.result,
        pending: session.getPending(),
        protocol: session.getProtocolStatus(),
        audit: session.getAudit().kind,
        automaticParent: Reflect.get(session, 'automaticParent'),
      })),
    });
  }

  function peerTransport(seat: Seat): Transport {
    const identity = game.identities.get(seat);
    if (!identity) throw new Error('Missing transport identity');
    const transport = network.transport(identity.peerId);
    if (![3, 4, 5, 6, 7, 8].includes(options.scenario)) return transport;
    const rewrite = (bytes: Uint8Array): Uint8Array | null => {
      const decoded = unwrap(decodeProtocolMessage(bytes));
      if (
        options.scenario === 8 &&
        seat === 0 &&
        decoded.t === 'SNAPSHOT_REQ' &&
        faultInjected &&
        desyncObserved &&
        corruptedHeight !== null &&
        decoded.atSeq === corruptedHeight - 1
      )
        snapshotRequestAtSeqs.add(decoded.atSeq);
      if ([3, 4, 5].includes(options.scenario)) {
        if (
          decoded.t === 'PROPOSAL' &&
          !faultInjected &&
          decoded.proposal.body.entry.seq >= 20 &&
          decoded.proposal.body.entry.term === 1 &&
          (updates.get(seat)?.state.turn.number ?? 0) >= 2
        ) {
          const proposal = decoded.proposal.body.entry;
          if (options.scenario === 3 && !crashRequested) {
            crashRequested = { seat, seq: proposal.seq };
          }
          if ([4, 5].includes(options.scenario) && !partitionRequested)
            partitionRequested = {
              proposer: seat,
              commandSeat:
                proposal.payload.kind === 'command' ? proposal.payload.signed.body.seat : null,
              seq: proposal.seq,
            };
          if (options.scenario === 4) partitionProposalSeen.add(seat);
        }
        return bytes;
      }
      if (options.scenario === 8) return bytes;
      if (seat !== 0) return bytes;
      if (decoded.t !== 'PROPOSAL') return bytes;
      const { entry } = decoded.proposal.body;
      if (
        maliciousHeight === null &&
        entry.seq >= 20 &&
        entry.term === 1 &&
        (options.scenario !== 7 || entry.payload.kind === 'command')
      ) {
        maliciousHeight = entry.seq;
        faultInjected = true;
        faultRevision = entry.seq - 1;
        if (options.scenario === 7 && entry.payload.kind === 'command')
          censoredCommandHash = toHex(hashValue(entry.payload.signed));
      }
      if (entry.seq !== maliciousHeight || entry.term !== 1) return bytes;
      if (options.scenario === 7) return null;
      return unwrap(
        encodeProtocolMessage({
          t: 'PROPOSAL',
          proposal: invalidCommandProposal(
            decoded.proposal,
            game.genesis,
            seat,
            identity.secretKey,
          ),
        }),
      );
    };
    return {
      self: transport.self,
      peers: () => transport.peers(),
      send: (to, bytes) => {
        const changed = rewrite(bytes);
        if (changed) transport.send(to, changed);
      },
      broadcast: (bytes) => {
        const changed = rewrite(bytes);
        if (changed) transport.broadcast(changed);
      },
      onMessage: (listener) =>
        transport.onMessage((from, bytes) => {
          if (options.scenario === 4 && partitionRequested) {
            const incoming = unwrap(decodeProtocolMessage(bytes));
            if (
              incoming.t === 'PROPOSAL' &&
              incoming.proposal.body.entry.seq === partitionRequested.seq
            )
              partitionProposalSeen.add(seat);
          }
          if (options.scenario === 8 && seat === 0 && !faultRecovered) {
            const current = updates.get(seat);
            if (
              corruptedHeight === null &&
              current &&
              current.revision >= 20 &&
              current.revision % keys.length !== 0
            )
              corruptedHeight = current.revision + 1;
            const decoded = unwrap(decodeProtocolMessage(bytes));
            if (
              decoded.t === 'SNAPSHOT_RES' &&
              from !== game.identities.get(0)?.peerId &&
              desyncObserved &&
              snapshotRequestAtSeqs.has(decoded.atSeq)
            )
              snapshotResponsePairs.add(`${from}:${decoded.atSeq}`);
            // Keep this peer's target-height voting record empty while the other three certify.
            if (
              (decoded.t === 'PROPOSAL' && decoded.proposal.body.entry.seq === corruptedHeight) ||
              (decoded.t === 'VOTE' && decoded.vote.body.seq === corruptedHeight)
            )
              return;
            if (
              !faultInjected &&
              decoded.t === 'COMMIT' &&
              decoded.certified.entry.seq === corruptedHeight
            ) {
              const session = sessions.get(seat);
              if (!session) throw new Error('Missing peer for cache corruption');
              corruptDerivedBank(session);
              faultInjected = true;
              faultRevision = decoded.certified.entry.seq - 1;
            }
          }
          listener(from, bytes);
        }),
      onPeerChange: (listener) => transport.onPeerChange(listener),
      disconnect: (peer) => transport.disconnect(peer),
    };
  }

  async function open(seat: Seat, restoring: boolean): Promise<void> {
    const identity = game.identities.get(seat);
    const journal = journals.get(seat);
    if (!identity || !journal) throw new Error('Missing simulation identity or journal');
    const sessionOptions: P2PSessionOptions = {
      genesisEntry: game.entry,
      engine: game.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat,
      secretKey: identity.secretKey,
      transport: peerTransport(seat),
      clock: network.clock,
      journal,
      createDriver: (
        engine: typeof game.engine,
        genesis: typeof game.genesis,
        clock: ProtocolClock,
      ) => new SimulationDriver(engine, genesis, clock),
      ...verified?.sessionOptions(seat),
    };
    const session = unwrap(
      await (restoring ? P2PSession.restore(sessionOptions) : P2PSession.create(sessionOptions)),
    );
    session.subscribe((update) => observe(seat, update));
    sessions.set(seat, session);
  }

  function crash(seat: Seat): void {
    const identity = game.identities.get(seat);
    if (!identity) throw new Error('Missing crashed peer');
    if (submission?.seat === seat && submission.result === null)
      intentionallyInterruptedSubmissions.add(submission);
    sessions.get(seat)?.dispose();
    sessions.delete(seat);
    network.crash(identity.peerId);
    offline.add(seat);
  }

  /** After self-evidence halts the faulty session, this actor sends commands but never votes. */
  function byzantinePrivate(history: readonly CertifiedEntry[]) {
    if (byzantinePrivateCache?.revision === history.length) return byzantinePrivateCache;
    const driver = new SimulationDriver(game.engine, game.genesis, network.clock);
    let before = unwrap(
      initialProposalContext(game.entry, game.engine, {
        genesis: { allowStub: true },
        entry: { allowStub: true },
      }),
    );
    const replayed = unwrap(
      replayCertifiedPrefix(
        game.entry,
        history,
        game.engine,
        { genesis: { allowStub: true }, entry: { allowStub: true } },
        (entry, next) => {
          const applied = entry.input
            ? driver.committed(before.log, entry.input, next.log.state)
            : success(undefined);
          if (applied.ok) before = next;
          return applied;
        },
      ),
    );
    if (replayed.context.log.head.seq !== history.length)
      throw new Error('Byzantine actor replay did not reach the certified head');
    const privateState = driver.privateState(0);
    if (!privateState) throw new Error('Byzantine actor lost its own private hand');
    byzantinePrivateCache = { revision: history.length, privateState, context: replayed.context };
    return byzantinePrivateCache;
  }

  async function survivorsReadyForCrash(proposer: Seat, seq: number): Promise<boolean> {
    const voters = game.genesis.seats.filter((seat) => seat.kind === 'human');
    const ready = await Promise.all(
      voters
        .filter((voter) => voter.seat !== proposer)
        .map(async (voter) => {
          const session = sessions.get(voter.seat);
          const journal = journals.get(voter.seat);
          if (!session || !journal || session.getCommittedHead().seq !== seq - 1) return false;
          const record = await journal.loadSafety(seq);
          if (!record) return false;
          const state = canonicalDecode(record.bytes);
          if (typeof state !== 'object' || state === null) return false;
          const timers = Reflect.get(state, 'timers');
          if (
            Reflect.get(state, 'height') !== seq ||
            Reflect.get(state, 'round') !== 1 ||
            Reflect.get(state, 'inputKnown') !== true ||
            typeof timers !== 'object' ||
            timers === null ||
            Reflect.get(timers, 'propose') !== true
          )
            return false;
          return true;
        }),
    );
    return ready.filter(Boolean).length >= quorumSize(voters.length);
  }

  async function advanceFault(latest: SessionUpdate): Promise<void> {
    const now = network.clock.now();
    if (!faultInjected && options.scenario === 3 && crashRequested) {
      if (!(await survivorsReadyForCrash(crashRequested.seat, crashRequested.seq))) {
        crashRequested = null;
      } else {
        faultInjected = true;
        faultRevision = crashRequested.seq - 1;
        crashedProposalHeight = crashRequested.seq;
        crashedProposerSeat = crashRequested.seat;
        recoverAt = now + 20_000;
        const expected = proposerFor(
          crashRequested.seq,
          1,
          {
            genesisDigest: genesisDigest(game.genesis),
            epoch: 0,
            voters: game.genesis.seats.filter((seat) => seat.kind === 'human'),
          },
          [],
        );
        if (expected.seat !== crashRequested.seat)
          throw new Error('Crash hook did not observe the elected proposer');
        crash(crashRequested.seat);
      }
    }
    const requestedPartition = partitionRequested;
    const bothHalvesSawProposal =
      [...partitionProposalSeen].some((seat) => seat < 2) &&
      [...partitionProposalSeen].some((seat) => seat >= 2);
    if (
      !faultInjected &&
      [4, 5].includes(options.scenario) &&
      requestedPartition &&
      (options.scenario === 5 || bothHalvesSawProposal)
    ) {
      faultInjected = true;
      faultRevision = requestedPartition.seq - 1;
      recoverAt = now + 30_000;
      const seats = game.genesis.config.seats;
      const isolated = seats.find(
        (seat) => seat !== requestedPartition.proposer && seat !== requestedPartition.commandSeat,
      );
      if (isolated === undefined) throw new Error('No non-actor peer to isolate');
      partitionIsolatedSeat = options.scenario === 5 ? isolated : null;
      const groups =
        options.scenario === 4
          ? [seats.slice(0, 2), seats.slice(2)]
          : [seats.filter((seat) => seat !== isolated), [isolated]];
      network.partition(
        groups.map((group) =>
          group.map((seat) => {
            const identity = game.identities.get(seat);
            if (!identity) throw new Error('Partition seat has no identity');
            return identity.peerId;
          }),
        ),
      );
      partitionCheckAt = now + 2000;
    }
    if (
      !faultInjected &&
      options.scenario === 9 &&
      latest.state.turn.number >= 2 &&
      [...updates.values()].every((update) => update.revision === latest.revision)
    ) {
      faultInjected = true;
      faultRevision = latest.revision;
      recoverAt = now + 30_000;
      crash(0);
      crash(1);
    }
    if (faultInjected && !faultRecovered && options.scenario === 4 && now >= partitionCheckAt) {
      partitionStableRevisions ??= new Map(
        [...updates].map(([seat, update]) => [seat, update.revision]),
      );
      pausedPeersDuringPartition = 0;
      for (const [seat, update] of updates) {
        if (
          update.revision !== partitionStableRevisions.get(seat) ||
          update.revision > faultRevision + 1
        )
          throw new Error(`Peer ${seat} committed without a quorum during 2|2 partition`);
        pausedPeersDuringPartition++;
      }
    }
    if (faultInjected && !faultRecovered && now >= recoverAt) {
      if (options.scenario === 3) {
        const targetHeight = crashedProposalHeight;
        const crashedSeat = crashedProposerSeat;
        if (targetHeight === null || crashedSeat === null)
          throw new Error('Missing crashed proposal identity');
        const certified = [...sessions.values()].map(
          (session) => session.exportSave().entries[targetHeight - 1],
        );
        if (
          certified.length !== 3 ||
          certified.some(
            (item) =>
              !item ||
              item.entry.term <= 1 ||
              item.entry.sequencer === game.identities.get(crashedSeat)?.peerId,
          ) ||
          new Set(certified.map((item) => item && entryHash(item.entry))).size !== 1
        )
          throw new Error('Survivors did not certify a replacement before proposer restart');
        replacementTerm = certified[0]?.entry.term ?? null;
      }
      if (options.scenario === 5) {
        const majority = [...updates]
          .filter(([seat]) => seat !== partitionIsolatedSeat)
          .map(([, update]) => update.revision);
        const isolated = updates.get(partitionIsolatedSeat ?? 0)?.revision;
        if (majority.length !== 3 || isolated === undefined)
          throw new Error('Missing 3|1 partition observations');
        const leastMajority = Math.min(...majority);
        majorityCommitsDuringPartition = leastMajority - faultRevision;
        isolatedCommitsDuringPartition = isolated - faultRevision;
        if (majorityCommitsDuringPartition < 1 || isolated >= leastMajority)
          throw new Error('The 3-peer quorum did not advance ahead of its isolated peer');
      }
      for (const seat of offline) {
        const identity = game.identities.get(seat);
        if (!identity) throw new Error('Missing restarting peer');
        network.restart(identity.peerId);
      }
      await Promise.all([...offline].map((seat) => open(seat, true)));
      offline.clear();
      network.heal();
      faultRecovered = true;
    }
  }

  try {
    await Promise.all(game.genesis.config.seats.map((seat) => open(seat, false)));
    const maxSteps = options.maxSteps ?? 1_000_000;
    for (let step = 0; step < maxSteps; step++) {
      if (options.maxElapsedMs !== undefined && performance.now() - started > options.maxElapsedMs)
        throw new Error(`Peer game exceeded ${options.maxElapsedMs} ms: ${progressDiagnostic()}`);
      // oxlint-disable-next-line no-await-in-loop -- Virtual network delivery and peer queues alternate causally.
      await flush();
      if (options.scenario === 6 && byzantineHalted && sessions.has(0)) {
        if (submission?.seat === 0 && submission.result === null)
          intentionallyInterruptedSubmissions.add(submission);
        sessions.get(0)?.dispose();
        sessions.delete(0);
        updates.delete(0);
      }
      if (failures.length) throw new Error(failures[0]);
      if (verified)
        for (const [seat, session] of sessions) {
          const audit = session.getAudit();
          if (audit.kind === 'error')
            throw new Error(`Peer ${seat} terminal audit failed: ${audit.code}`);
        }
      const latest = [...updates.values()].toSorted((a, b) => b.revision - a.revision)[0];
      if (!latest) throw new Error('No peer state available');
      // oxlint-disable-next-line no-await-in-loop -- Crash recovery must restore durable journals before the next delivery.
      await advanceFault(latest);
      if (verified && options.scenario === 6 && byzantineHalted && faultRecovered) {
        const honest = [...sessions].find(
          ([seat]) => updates.get(seat)?.revision === latest.revision,
        )?.[1];
        const identity = game.identities.get(0);
        if (!honest || !identity)
          throw new Error('Excluded actor lacks an honest certified prefix');
        verifiedNonVoter ??= unwrap(
          createVerifiedNonVoterActor({
            seat: 0,
            identity,
            sessionOptions: verified.sessionOptions(0),
            transport: network.transport(identity.peerId),
            clock: network.clock,
          }),
        );
        const actorHead = verifiedNonVoter.head();
        const honestHead = honest.getCommittedHead();
        // Replay each new prefix once. At the same head, only retry persisted owner messages.
        const continuation =
          actorHead.seq === honestHead.seq && actorHead.hash === honestHead.hash
            ? verifiedNonVoter.publishContributions()
            : verifiedNonVoter.advance(honest.exportSave().entries);
        // oxlint-disable-next-line no-await-in-loop -- Each new certified prefix authorizes the next private contribution.
        unwrap(await continuation);
      }
      if (
        [...updates.values()].every(
          (update) => update.state.result && update.revision === latest.revision,
        ) &&
        (!verified ||
          [...sessions.values()].every((session) => session.getAudit().kind === 'complete'))
      ) {
        if (options.scenario > 2 && (!faultInjected || !faultRecovered))
          throw new Error('Game completed without exercising fault recovery');
        if (options.scenario === 3) {
          const committed = sessions.values().next().value?.exportSave().entries[
            (crashedProposalHeight ?? 0) - 1
          ];
          if (
            !committed ||
            committed.entry.term <= 1 ||
            committed.entry.sequencer === game.identities.get(crashedProposerSeat ?? 0)?.peerId
          )
            throw new Error('Crashed proposer was not replaced in a later round');
          replacementTerm = committed.entry.term;
        }
        if (options.scenario === 4 && pausedPeersDuringPartition !== 4)
          throw new Error('The 2|2 partition was not observed long enough to prove a pause');
        if (options.scenario === 6) {
          if (maliciousHeight === null) throw new Error('No invalid proposer height was recorded');
          if (!byzantineHalted || sessions.size !== 3)
            throw new Error('The Byzantine signer did not halt while three honest peers completed');
          certifiedExclusionPeers = 0;
          for (const [seat, session] of sessions) {
            const history = session.exportSave().entries;
            const control = history[maliciousHeight - 1];
            if (
              control?.entry.payload.kind !== 'control' ||
              control.entry.payload.action !== 'exclude-proposer' ||
              control.entry.payload.offender !== 0 ||
              control.certificate.length < 3
            )
              throw new Error(`Peer ${seat} lacks the certified offender-0 exclusion`);
            certifiedExclusionPeers++;
            if (
              history
                .slice(maliciousHeight)
                .some(({ entry }) => entry.sequencer === game.identities.get(0)?.peerId)
            )
              throw new Error(`Excluded proposer authored a later entry at peer ${seat}`);
          }
          if (certifiedExclusionPeers !== 3)
            throw new Error('The three honest peers did not converge after exclusion');
          if (byzantineCommandCommits < 1)
            throw new Error('The faulty actor supplied no later certified player command');
        }
        if (options.scenario === 2 && network.diagnostics().duplicateDeliveries === 0)
          throw new Error('The latency scenario completed without delivering a duplicate packet');
        if (
          options.scenario === 8 &&
          (!desyncObserved || !snapshotRequestAtSeqs.size || !snapshotResponsePairs.size)
        )
          throw new Error(
            'Desync did not trigger a matching snapshot request and response after corruption',
          );
        const hashes = new Set(
          [...updates.values()].map((update) => toHex(hashValue(update.state))),
        );
        if (hashes.size !== 1) throw new Error('Final public state diverged');
        const histories = [...sessions.values()].map((session) =>
          session.exportSave().entries.map(({ entry }) => entryHash(entry)),
        );
        const first = histories[0];
        if (
          !first ||
          histories.some(
            (history) =>
              history.length !== first.length ||
              history.some((hash, index) => hash !== first[index]),
          )
        )
          throw new Error('Committed log values diverged');
        const finalLogHash = first.at(-1);
        if (!finalLogHash) throw new Error('Completed game has no certified history');
        const audits: NetworkGameResult['audits'] = [];
        if (verified) {
          for (const [seat, session] of sessions) {
            const audit = session.getAudit();
            if (
              audit.kind !== 'complete' ||
              !audit.report.ok ||
              !audit.report.complete ||
              audit.report.finalHead?.hash !== finalLogHash ||
              audit.report.finalHead.seq !== latest.revision
            )
              throw new Error(`Verified peer ${seat} did not pass its terminal audit`);
            if (
              audit.report.cheatFindings.some(
                (finding) => options.scenario !== 6 || finding.seat !== 0,
              )
            )
              throw new Error(`Verified peer ${seat} reported misconduct by an honest player`);
            audits.push({
              seat,
              ok: true,
              complete: true,
              finalHead: audit.report.finalHead,
              cheatFindings: audit.report.cheatFindings,
            });
          }
        }
        return {
          security: game.genesis.security,
          protocolVersion: game.genesis.protocolVersion,
          seed: options.seed,
          gameIndex: options.gameIndex,
          scenario: options.scenario,
          turns: latest.state.turn.number,
          inputs: latest.revision,
          virtualMilliseconds: network.clock.now(),
          elapsedMilliseconds: performance.now() - started,
          finalStateHash: toHex(hashValue(latest.state)),
          finalLogHash,
          audits,
          faultInjected,
          faultRecovered,
          faultEvidence: {
            injectedAtRevision: faultRevision,
            majorityCommitsDuringPartition,
            isolatedCommitsDuringPartition,
            pausedPeersDuringPartition,
            replacementTerm,
            censoredCommandCommitted,
            snapshotRequests: snapshotRequestAtSeqs.size,
            snapshotResponses: snapshotResponsePairs.size,
            duplicateDeliveries: network.diagnostics().duplicateDeliveries,
            certifiedExclusionPeers,
            byzantineCommandCommits,
          },
        };
      }
      if (submission?.result) {
        const disposedByIntentionalCrash =
          intentionallyInterruptedSubmissions.has(submission) &&
          !submission.result.ok &&
          ['replica-outcome-unknown', 'replica-disposed'].includes(submission.result.error.code);
        const staleActorPreparation =
          verifiedNonVoter !== null &&
          submission.seat === 0 &&
          !submission.result.ok &&
          ['non-voter-stale-head', 'non-voter-trade-stale'].includes(submission.result.error.code);
        if (
          !submission.result.ok &&
          !['renewed-intent', 'command-pending'].includes(submission.result.error.code) &&
          !disposedByIntentionalCrash &&
          !staleActorPreparation
        )
          throw new Error(`Submission rejected: ${submission.result.error.code}`);
        submission = null;
      }
      if (byzantineSubmissionRevision !== null && latest.revision > byzantineSubmissionRevision) {
        const history = [...sessions]
          .find(([seat]) => updates.get(seat)?.revision === latest.revision)?.[1]
          .exportSave().entries;
        if (
          history
            ?.slice(byzantineSubmissionRevision)
            .some(
              ({ entry }) =>
                entry.payload.kind === 'command' &&
                toHex(hashValue(entry.payload.signed)) === byzantineSubmissionHash,
            )
        )
          byzantineCommandCommits++;
        submission = null;
        byzantineSubmissionRevision = null;
        byzantineSubmissionHash = null;
      }
      if (!submission && !latest.state.result) {
        const pending = choosePending(latest.state, game.engine.getPending(latest.state));
        const session = pending ? sessions.get(pending.seat) : undefined;
        const owned = pending ? updates.get(pending.seat) : undefined;
        if (options.scenario === 6 && byzantineHalted && faultRecovered && pending?.seat === 0) {
          const honest = [...sessions].find(
            ([seat]) => updates.get(seat)?.revision === latest.revision,
          )?.[1];
          const identity = game.identities.get(0);
          const actor = bots.get(0);
          if (!honest || !identity || !actor)
            throw new Error('Byzantine command actor lacks certified history or identity');
          const history = honest.exportSave().entries;
          const rebuilt = verified ? null : byzantinePrivate(history);
          const privateState = verifiedNonVoter?.privateState() ?? rebuilt?.privateState;
          const actorHead =
            verifiedNonVoter?.head() ??
            (rebuilt && {
              seq: rebuilt.context.log.head.seq,
              hash: entryHash(rebuilt.context.log.head),
            });
          if (!privateState || actorHead?.seq !== latest.revision)
            throw new Error(
              'Byzantine command actor lacks its private state at the certified head',
            );
          const chosen = actor.bot.decide(
            { state: latest.state, seat: 0, priv: privateState },
            pending,
            actor.rng,
          );
          if (verifiedNonVoter) {
            const waiting = { seat: 0 as Seat, result: null as Result<void> | null };
            submission = waiting;
            // Remote trade proofs need future virtual deliveries; never block the network loop.
            void verifiedNonVoter.submit(chosen, actorHead).then((result) => {
              if (!result.ok) waiting.result = result;
              else {
                byzantineSubmissionRevision = result.value.body.headSeq;
                byzantineSubmissionHash = toHex(hashValue(result.value));
              }
              return undefined;
            });
          } else {
            if (!rebuilt) throw new Error('Stub actor has no reconstructed state');
            const { log } = rebuilt.context;
            const signed = signCommand(
              {
                gameId: log.genesis.gameId,
                genesisDigest: rebuilt.context.membership.genesisDigest,
                seat: 0,
                nonce: (log.lastNonces.get(0) ?? 0) + 1,
                headSeq: log.head.seq,
                headHash: entryHash(log.head),
                command: chosen,
              },
              identity.secretKey,
            );
            network
              .transport(identity.peerId)
              .broadcast(unwrap(encodeProtocolMessage({ t: 'SUBMIT', cmd: signed })));
            submission = { seat: 0, result: null };
            byzantineSubmissionRevision = latest.revision;
            byzantineSubmissionHash = toHex(hashValue(signed));
          }
        }
        if (pending && session && owned?.revision === latest.revision) {
          const actor = bots.get(pending.seat);
          const privateState = session.getPrivate(pending.seat);
          if (!actor || !privateState) throw new Error('Simulation actor is missing its own hand');
          const chosen = actor.bot.decide(
            { state: latest.state, seat: pending.seat, priv: privateState },
            pending,
            actor.rng,
          );
          const waiting = { seat: pending.seat, result: null as Result<void> | null };
          submission = waiting;
          void session
            .submit(pending.seat, chosen, { expectedRevision: latest.revision })
            .then((result) => {
              waiting.result = result;
              return undefined;
            });
          // oxlint-disable-next-line no-await-in-loop -- Submission must enter the queue before virtual time advances.
          await flush();
        }
      }
      if (!network.clock.runNext())
        throw new Error('Live peer game has no queued network/timer work');
      if (network.clock.now() > 7_200_000)
        throw new Error(`Peer game exceeded two virtual hours: ${progressDiagnostic()}`);
    }
    throw new Error(`Peer game exceeded ${maxSteps} network steps: ${progressDiagnostic()}`);
  } finally {
    verifiedNonVoter?.dispose();
    for (const session of sessions.values()) session.dispose();
    network.dispose();
    verified?.dispose();
  }
}

function choosePending(state: GameState, pending: readonly Pending[]) {
  const players = pending.filter(
    (item): item is Extract<Pending, { kind: 'player' }> =>
      item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );
  return (
    players.find((item) => item.allowed.includes('DISCARD')) ??
    players.find(
      (item) => item.seat !== state.turn.activeSeat && item.allowed.includes('RESPOND_TRADE'),
    ) ??
    players.find((item) => item.seat === state.turn.activeSeat)
  );
}

/** Deliberate in-memory fault injection. Durable certificates and voting records stay intact. */
function corruptDerivedBank(session: P2PSession): void {
  let current: unknown = session;
  for (const property of ['replica', 'context', 'log', 'state', 'bank']) {
    if (typeof current !== 'object' || current === null)
      throw new Error(`Cannot inject derived-state corruption at ${property}`);
    current = Reflect.get(current, property);
  }
  if (typeof current !== 'object' || current === null)
    throw new Error('Missing derived bank cache');
  const brick: unknown = Reflect.get(current, 'brick');
  if (typeof brick !== 'number' || !Reflect.set(current, 'brick', brick + 1))
    throw new Error('Could not corrupt the derived bank cache');
}

```


## tools/sim/src/net-batch.ts

```text
import { Worker } from 'node:worker_threads';
import { runNetworkGame } from './net.js';
import type { NetworkGameResult } from './net.js';

const MAX_WORKERS = 16;

export interface NetBatchOptions {
  seeds: number;
  startIndex: number;
  seed: number;
  scenario: number;
  parallel: number;
  security?: 'stub' | 'verified';
  maxElapsedMs?: number;
}

export interface NetBatchFailure {
  gameIndex: number;
  message: string;
}

export interface NetBatchPart {
  results: NetworkGameResult[];
  failures: NetBatchFailure[];
}

export interface NetBatchResult extends NetBatchPart {
  options: NetBatchOptions;
  requestedSeeds: number;
  completedGames: number;
  averageTurns: number | null;
  averageInputs: number | null;
  averageVirtualMilliseconds: number | null;
  averageElapsedMilliseconds: number | null;
}

export function parseNetBatchOptions(args: readonly string[]): NetBatchOptions {
  const values = new Map<string, string>();
  const accepted = new Set([
    'scenario',
    'seeds',
    'start-index',
    'seed',
    'parallel',
    'security',
    'max-elapsed-ms',
  ]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new Error(`Unexpected network argument ${String(flag)}`);
    const name = flag.slice(2);
    if (!accepted.has(name)) throw new Error(`Unknown network option --${name}`);
    if (values.has(name)) throw new Error(`Duplicate network option --${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`--${name} needs an integer value`);
    if (name === 'security') {
      if (value !== 'stub' && value !== 'verified')
        throw new Error('--security must be stub or verified');
    } else if (!/^-?\d+$/.test(value)) throw new Error(`--${name} needs an integer value`);
    values.set(name, value);
    index++;
  }
  const parse = (name: string, fallback: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error(`--${name} needs a safe integer`);
    return value;
  };
  const security = values.get('security') === 'verified' ? 'verified' : 'stub';
  const maxElapsedMs = values.has('max-elapsed-ms') ? parse('max-elapsed-ms', 0) : undefined;
  const options: NetBatchOptions = {
    scenario: parse('scenario', 1),
    seeds: parse('seeds', 1),
    startIndex: parse('start-index', 0),
    seed: parse('seed', 42),
    parallel: parse('parallel', 1),
    ...(values.has('security') ? { security } : {}),
    ...(maxElapsedMs === undefined ? {} : { maxElapsedMs }),
  };
  if (options.scenario < 1 || options.scenario > 9)
    throw new Error('--scenario must be between 1 and 9');
  if (options.seeds < 1) throw new Error('--seeds must be positive');
  if (options.startIndex < 0) throw new Error('--start-index must be non-negative');
  if (options.startIndex > Number.MAX_SAFE_INTEGER - (options.seeds - 1))
    throw new Error('--start-index and --seeds exceed the safe game-index range');
  if (options.seed < 0) throw new Error('--seed must be non-negative');
  if (options.parallel < 1 || options.parallel > MAX_WORKERS)
    throw new Error(`--parallel must be between 1 and ${MAX_WORKERS}`);
  if (maxElapsedMs !== undefined && maxElapsedMs <= 0)
    throw new Error('--max-elapsed-ms must be positive');
  return options;
}

/** Partition a deterministic contiguous game-index range across worker slices. */
export function partitionGameIndices(options: NetBatchOptions): number[][] {
  const workers = Math.min(options.parallel, options.seeds);
  return Array.from({ length: workers }, (_, workerIndex) =>
    Array.from(
      { length: Math.ceil((options.seeds - workerIndex) / workers) },
      (_unused, offset) => options.startIndex + workerIndex + offset * workers,
    ).filter((gameIndex) => gameIndex < options.startIndex + options.seeds),
  );
}

async function runWorker(indices: number[], options: NetBatchOptions): Promise<NetBatchPart> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./net-worker.js', import.meta.url), {
      workerData: {
        seed: options.seed,
        scenario: options.scenario,
        gameIndices: indices,
        ...(options.security === undefined ? {} : { security: options.security }),
        ...(options.maxElapsedMs === undefined ? {} : { maxElapsedMs: options.maxElapsedMs }),
      },
    });
    let settled = false;
    worker.once('message', (message: NetBatchPart) => {
      settled = true;
      resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Network simulation worker exited with code ${code}`));
    });
  });
}

async function runIndices(
  gameIndices: readonly number[],
  options: NetBatchOptions,
): Promise<NetBatchPart> {
  const results: NetworkGameResult[] = [];
  const failures: NetBatchFailure[] = [];
  for (const gameIndex of gameIndices) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep each worker's deterministic slice sequential.
      const result = await runNetworkGame({
        seed: options.seed,
        gameIndex,
        scenario: options.scenario,
        ...(options.security === undefined ? {} : { security: options.security }),
        ...(options.maxElapsedMs === undefined ? {} : { maxElapsedMs: options.maxElapsedMs }),
      });
      results.push(result);
    } catch (error) {
      failures.push({ gameIndex, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, failures };
}

/** Run contiguous deterministic game indices with a hard worker limit. */
export async function runNetworkBatch(options: NetBatchOptions): Promise<NetBatchResult> {
  if (options.startIndex > Number.MAX_SAFE_INTEGER - (options.seeds - 1))
    throw new Error('Network game-index range exceeds the safe integer limit');
  const gameIndices = partitionGameIndices(options);
  const parts =
    gameIndices.length === 1
      ? [await runIndices(gameIndices[0] ?? [], options)]
      : await Promise.all(gameIndices.map((indices) => runWorker(indices, options)));
  const results = parts
    .flatMap((part) => part.results)
    .toSorted((a, b) => a.gameIndex - b.gameIndex);
  const failures = parts
    .flatMap((part) => part.failures)
    .toSorted((a, b) => a.gameIndex - b.gameIndex);
  const total = (select: (result: NetworkGameResult) => number) =>
    results.reduce((sum, result) => sum + select(result), 0);
  const completedGames = results.length;
  const average = (select: (result: NetworkGameResult) => number) =>
    completedGames ? total(select) / completedGames : null;
  return {
    options,
    requestedSeeds: options.seeds,
    completedGames,
    averageTurns: average((result) => result.turns),
    averageInputs: average((result) => result.inputs),
    averageVirtualMilliseconds: average((result) => result.virtualMilliseconds),
    averageElapsedMilliseconds: average((result) => result.elapsedMilliseconds),
    results,
    failures,
  };
}

```


## tools/sim/src/net-worker.ts

```text
import { parentPort, workerData } from 'node:worker_threads';
import * as v from 'valibot';
import { runNetworkGame } from './net.js';
import type { NetworkGameResult } from './net.js';
import type { NetBatchFailure, NetBatchPart } from './net-batch.js';

const safeInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const workerSchema = v.strictObject({
  seed: safeInteger,
  scenario: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(9)),
  gameIndices: v.pipe(v.array(safeInteger), v.minLength(1)),
  security: v.optional(v.picklist(['stub', 'verified'])),
  maxElapsedMs: v.optional(v.pipe(safeInteger, v.minValue(1))),
});

async function execute(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('Network worker has no parent port');
  const parsed = v.safeParse(workerSchema, workerData);
  if (!parsed.success) throw new Error('Network worker received invalid job data');
  const results: NetworkGameResult[] = [];
  const failures: NetBatchFailure[] = [];
  for (const gameIndex of parsed.output.gameIndices) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep each worker's deterministic slice sequential.
      const result = await runNetworkGame({
        seed: parsed.output.seed,
        gameIndex,
        scenario: parsed.output.scenario,
        ...(parsed.output.security === undefined ? {} : { security: parsed.output.security }),
        ...(parsed.output.maxElapsedMs === undefined
          ? {}
          : { maxElapsedMs: parsed.output.maxElapsedMs }),
      });
      results.push(result);
    } catch (error) {
      failures.push({ gameIndex, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const result: NetBatchPart = { results, failures };
  port.postMessage(result);
}

await execute();

```


## tools/sim/src/net-batch.test.ts

```text
import { describe, expect, test } from 'vitest';
import { parseNetBatchOptions, partitionGameIndices } from './net-batch.js';

describe('network simulation CLI options', () => {
  test('defaults to one seed, scenario one, seed 42, and one worker', () => {
    expect(parseNetBatchOptions([])).toEqual({
      seeds: 1,
      startIndex: 0,
      scenario: 1,
      seed: 42,
      parallel: 1,
    });
  });

  test('parses deterministic scenario and bounded parallelism', () => {
    expect(
      parseNetBatchOptions([
        '--scenario',
        '9',
        '--seeds',
        '12',
        '--start-index',
        '200',
        '--seed',
        '2026',
        '--parallel',
        '4',
      ]),
    ).toEqual({ seeds: 12, startIndex: 200, scenario: 9, seed: 2026, parallel: 4 });
  });

  test('shards use distinct deterministic game indices within the requested range', () => {
    const shards = partitionGameIndices({
      seeds: 10,
      startIndex: 40,
      scenario: 3,
      seed: 42,
      parallel: 3,
    });
    expect(shards).toEqual([
      [40, 43, 46, 49],
      [41, 44, 47],
      [42, 45, 48],
    ]);
    expect(shards.flat().toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, index) => 40 + index),
    );
  });

  test('selects real cryptography with an explicit per-game time budget', () => {
    expect(parseNetBatchOptions(['--security', 'verified', '--max-elapsed-ms', '180000'])).toEqual({
      seeds: 1,
      startIndex: 0,
      scenario: 1,
      seed: 42,
      parallel: 1,
      security: 'verified',
      maxElapsedMs: 180000,
    });
  });

  test.each([
    [['--scenario'], /--scenario needs an integer value/],
    [['--scenario', '1.5'], /--scenario needs an integer value/],
    [['--scenario', '0'], /--scenario must be between 1 and 9/],
    [['--scenario', '10'], /--scenario must be between 1 and 9/],
    [['--seeds', '0'], /--seeds must be positive/],
    [['--start-index', '-1'], /--start-index must be non-negative/],
    [['--start-index', '9007199254740991', '--seeds', '2'], /safe game-index range/],
    [['--seed', '-1'], /--seed must be non-negative/],
    [['--parallel', '17'], /--parallel must be between 1 and 16/],
    [['--security', 'unverified'], /--security must be stub or verified/],
    [['--max-elapsed-ms', '0'], /--max-elapsed-ms must be positive/],
    [['--unknown', '1'], /Unknown network option --unknown/],
    [['--seed', '1', '--seed', '2'], /Duplicate network option --seed/],
  ] as const)('rejects malformed arguments %j', (args, message) => {
    expect(() => parseNetBatchOptions(args)).toThrow(message);
  });
});

```


## .github/workflows/verified-network.yml

```text
name: Verified network acceptance

on:
  workflow_dispatch:
    inputs:
      scenario:
        description: Run every fault case or repeat one selected scenario
        type: choice
        required: true
        default: all
        options:
          - all
          - '1'
          - '2'
          - '3'
          - '4'
          - '5'
          - '6'
          - '7'
          - '8'
          - '9'

permissions:
  contents: read

concurrency:
  group: verified-network-${{ github.ref }}
  cancel-in-progress: false

jobs:
  full-game:
    name: Real crypto scenario ${{ matrix.scenario }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        scenario: ${{ fromJSON(inputs.scenario == 'all' && '[1,2,3,4,5,6,7,8,9]' || format('[{0}]', inputs.scenario)) }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.7.1
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec tsc -b tools/sim
      - name: Record source revision
        run: git rev-parse HEAD > verified-source-revision.txt
      - name: Run one complete game with independent peer audits
        run: >-
          node tools/sim/dist/index.js net
          --security verified
          --scenario ${{ matrix.scenario }}
          --seeds 1
          --seed 42
          --start-index 0
          --parallel 1
          --max-elapsed-ms 900000
          > verified-network-${{ matrix.scenario }}.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: verified-network-${{ matrix.scenario }}
          path: |
            verified-network-${{ matrix.scenario }}.json
            verified-source-revision.txt
          if-no-files-found: warn
          retention-days: 14

```


## docs/verification/p2p-acceptance-policy.md

```text
# Bounded M-C and M-D acceptance

The user authorized reducing redundant game counts. Stages 07 and 10 use the
following deterministic coverage requirements instead of hundreds of repetitions
of each scenario. This changes sample counts, not the required failure cases,
security guarantees, performance targets or browser coverage. No unchecked gate
becomes complete through this policy change.

## Stage 07

Run one reproducible game for each of the nine Stage 06 scenarios with the real
cryptographic participants and verified genesis. The existing stub-randomness
simulation remains useful separate coverage; it cannot satisfy these checks.

| Scenario                        | Required observation                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean four-peer network         | Complete play and independent final audits with matching certified histories.                                                                                               |
| Delayed and duplicated messages | Actually deliver duplicates and 50–400 ms latency; certify the same history and finish.                                                                                     |
| Sequencer crash and restart     | Crash mid-turn, keep durable safety records, return after 20 seconds, and finish without conflicting votes.                                                                 |
| Two-against-two partition       | Neither partition commits during the 30-second split. Heal and finish from the same prefix.                                                                                 |
| Three-against-one partition     | The quorum commits when required inputs are available. A missing private input must wait. Heal, catch up and finish.                                                        |
| Invalid proposer                | Reject the signed invalid command, certify the attributable finding and proposer exclusion, then finish with three honest voters and legal commands from the excluded seat. |
| Censoring proposer              | Observe an actually censored command, replace the proposer and commit that command, then finish.                                                                            |
| Corrupted local state           | Exercise verified repair from certified history and finish without rolling back any committed entry.                                                                        |
| Two simultaneous restarts       | Restore both peers from durable records, fetch missing certified entries, and finish on the same history.                                                                   |

Record protocol version, source revision, seed, actual injected fault, certified
head and relevant safety assertions. The faulty client in the invalid-proposer
case is not required to maintain an honest history. Expected misconduct findings
in that case are distinct from false findings in honest games.

Require three honest terminal compositions: human-only, humans with hosted bots,
and survivors with a recovered bot. Each must finish on the current protocol,
have no false `CHEAT_PROOF`, and obtain a complete successful independent audit
from every surviving human. At least one uses the server-backed browser path.
The same game can satisfy a scenario and a composition when it proves both.

Keep one focused signed adversarial case for every row of the Stage 07 cheat
table. Assert the stated detection time and outcome, including the private
recovery-void policy. Primitive rejection alone does not prove admission or
certification behavior. Keep the fast 100,000-round dice distribution test.

## Stage 10

Exercise every named chaos addition at least once with deterministic faults and
the current protocol. A trace may cover multiple rows only when it records the
required observation for each.

| Case                         | Required observation                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Periodic restart             | In a four-human game, restart a peer with storage intact at each reached approximately 50-entry boundary, rotating the peer. Restore the exact certified prefix and safety state before voting.                                |
| Permanent departure          | Depart mid-game with four humans, certify old-quorum authorization, reconstruct private state, activate the bot, finish and independently audit every survivor.                                                                |
| Everyone leaves              | Close all peers mid-game, reopen them in a fixed non-seat order, restore the same prefix, certify a new move, finish and audit.                                                                                                |
| Sequencer loss during unlock | Interrupt before persistence, after persistence but before send, and after peer acceptance but before local commit. Never send an unpersisted vote or replace a durable contribution; retry the same operation after recovery. |
| Return after takeover        | Rebuild the returning human's private state, certify fresh keys, keep old keys retired and continue. Exercise another takeover where the signed quorum permits it; otherwise assert pause.                                     |

Compare reconstructed private state with an independent omniscient engine at
every certified sequence of the representative lifecycle game. Add focused
fixtures for draw, steal, transfer, recovery and return if that game does not
exercise their private-state changes. Public-state or final-score agreement
cannot replace exact private-state equality.

Retain focused checks for every signing/persistence interruption boundary,
transaction abort, lost acknowledgement, writer contention, stale import,
migration, withholding shares and two-/three-human quorum loss. Retain native
browser refresh, takeover, save transfer, encryption, history and snapshot
checks. The measured three-second resume target remains unchanged.

## Execution

Use bounded runs with explicit time and move limits. A timeout is a failure to
investigate, not a reason to silently increase the limit. Store public results
and source provenance; keep private game material out of reports. Run local
native browser checks in Chrome. Run the required Firefox/WebKit combinations
on CI to avoid the user's local browser crash popups.

The existing Stage 06 CI policy is unchanged. The new real-crypto and lifecycle
fixtures must be named and mapped to these rows before claiming acceptance.

```

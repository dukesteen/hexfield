import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Input, Result, Transition } from '@cp2p/engine';
import { entryHash, genesisDigest } from './genesis.js';
import { signedCommandSchema } from './schemas.js';
import type { CommandBody, SignedCommand } from './types.js';
import { parseCanonical } from './validation.js';
import { revealDeckCards, DECK_REVEAL_PROTOCOL } from './deck-ledger.js';
import { readCommandProofs } from './command-proofs.js';
import { planHandTransition, verifyHandProofs } from './hand-transition.js';
import type { HandTransitionPlan } from './hand-transition.js';
import type { CryptoContext } from './crypto-context.js';
import type { EntryPolicy, LogContext } from './log-types.js';
import { resolveArtifactSigner } from './authority.js';

export function signCommand(body: CommandBody, secretKey: Uint8Array): SignedCommand {
  return { body, sig: signObject('cmd', body, secretKey) };
}

/** A delayed command cannot be applied to a different parent or later turn. */
export function validateSignedCommand(value: unknown, context: LogContext): Result<SignedCommand> {
  try {
    const parsed = parseCanonical(value, signedCommandSchema);
    if (!parsed.ok) return parsed;
    const signed = parsed.value;
    const { body } = signed;
    if (
      body.gameId !== context.genesis.gameId ||
      body.genesisDigest !== genesisDigest(context.genesis)
    )
      return failure('wrong-game', 'Command belongs to another game');
    if (!context.genesis.seats.some((owner) => owner.seat === body.seat))
      return failure('unknown-seat', 'Command has no genesis seat');
    const signer = resolveArtifactSigner(
      context.authority,
      context.genesis,
      context.crypto?.epoch ?? context.authority?.epoch ?? 0,
      body.seat,
    );
    if (!signer.ok) return signer;
    if (!verifyObject('cmd', body, signed.sig, parsePeerId(signer.value.publicKey)))
      return failure('command-signature', 'Command signature does not match its seat');
    if (body.nonce <= (context.lastNonces.get(body.seat) ?? 0))
      return failure('replayed-nonce', 'Command nonce has already been applied');
    if (body.headSeq > context.head.seq)
      return failure('future-head', 'Command refers to a log head not yet available');
    if (body.headSeq < context.head.seq)
      return failure('stale-head', 'Command must be confirmed again against the current state');
    if (body.headHash !== entryHash(context.head))
      return failure('command-parent', 'Command refers to a different log parent');
    const valid = context.engine.validate(context.state, {
      kind: 'command',
      seat: body.seat,
      command: body.command,
    });
    return valid.ok ? success(signed) : valid;
  } catch {
    return failure('entry-verification-failed', 'Signed command validation failed');
  }
}

/** The non-proof statement must be valid before a missing proof can blame its signer. */
export function validateCommandStatement(
  value: unknown,
  context: LogContext,
): Result<{
  signed: SignedCommand;
  applied: Transition;
  crypto: CryptoContext | null;
  plan: HandTransitionPlan | null;
}> {
  try {
    const command = validateSignedCommand(value, context);
    if (!command.ok) return command;
    const input: Input = {
      kind: 'command',
      seat: command.value.body.seat,
      command: command.value.body.command,
    };
    const applied = context.engine.apply(context.state, input);
    if (!applied.ok) return applied;
    const violations = context.engine.checkInvariants(applied.value.state);
    if (violations.length !== 0)
      return failure('entry-state', 'Entry violates engine invariants', { violations });
    const crypto = context.crypto;
    if (context.genesis.security === 'verified' && !crypto)
      return failure(
        'crypto-context-required',
        'Verified commands need replayed cryptographic state',
      );
    if (!crypto)
      return success({ signed: command.value, applied: applied.value, crypto, plan: null });
    const planned = planHandTransition(crypto.hands, context.state, input, applied.value);
    if (!planned.ok) return planned;
    const reveals = planned.value.effects.filter((effect) => effect.type === 'card-slot-revealed');
    const requested: unknown =
      command.value.body.command.type === 'PLAY_DEV_CARD'
        ? [command.value.body.command.slotId]
        : command.value.body.command.type === 'CLAIM_VICTORY'
          ? command.value.body.command.slotIds
          : null;
    if (
      (requested !== null && !Array.isArray(requested)) ||
      reveals.length !== (Array.isArray(requested) ? requested.length : 0)
    )
      return failure('deck-reveal-effect', 'Card reveal effects differ from the command');
    for (const [index, effect] of reveals.entries()) {
      if (
        !Array.isArray(requested) ||
        effect.seat !== command.value.body.seat ||
        effect.slotId !== requested[index] ||
        effect.card !==
          (command.value.body.command.type === 'PLAY_DEV_CARD'
            ? command.value.body.command.card
            : 'victoryPoint')
      )
        return failure('deck-reveal-effect', 'Card reveal effect differs from the signed command');
      if (
        !crypto.decks.decks.some(
          (deck) =>
            deck.commitment.definition.deckId === effect.deck &&
            deck.slots.some((slot) => slot.slotId === effect.slotId && slot.seat === effect.seat),
        )
      )
        return failure(
          'deck-reveal-effect',
          'Card reveal effect differs from the certified deck slot',
        );
    }
    return success({ signed: command.value, applied: applied.value, crypto, plan: planned.value });
  } catch {
    return failure('entry-verification-failed', 'Command statement or state validation failed');
  }
}

/** Shared admission and entry checks; an engine-legal command can still carry a false proof. */
export function validateCommandForEntry(
  value: unknown,
  context: LogContext,
  policy: Pick<EntryPolicy, 'verifyCommand'>,
): Result<{ signed: SignedCommand; crypto: CryptoContext | null; applied: Transition }> {
  try {
    const statement = validateCommandStatement(value, context);
    if (!statement.ok) return statement;
    const { signed, applied, plan } = statement.value;
    let crypto = statement.value.crypto;
    if (crypto && plan) {
      const sections = readCommandProofs(signed.body.evidence, plan);
      if (!sections.ok) return sections;
      const { evidence: _evidence, ...bareBody } = signed.body;
      const handProofs = verifyHandProofs(plan, sections.value.hands, {
        genesisDigest: genesisDigest(context.genesis),
        epoch: crypto.epoch,
        anchor: { seq: context.head.seq, hash: entryHash(context.head) },
        command: bareBody,
      });
      if (!handProofs.ok) return handProofs;
      const reveals = plan.effects.filter((effect) => effect.type === 'card-slot-revealed');
      if (reveals.length > 0) {
        const revealed = revealDeckCards(
          crypto.decks,
          context.state,
          {
            ...signed,
            body: {
              ...signed.body,
              evidence: { protocol: DECK_REVEAL_PROTOCOL, data: sections.value.deck },
            },
          },
          crypto.epoch,
        );
        if (!revealed.ok) return revealed;
        crypto = { ...crypto, decks: revealed.value, hands: plan.hands };
      } else crypto = { ...crypto, hands: plan.hands };
    }
    if (
      policy.verifyCommand &&
      (context.genesis.security === 'verified' || signed.body.evidence !== undefined)
    ) {
      const proof = policy.verifyCommand(signed, context);
      if (!proof.ok) return proof;
    } else if (context.genesis.security === 'stub' && signed.body.evidence !== undefined) {
      return failure('command-proof-unavailable', 'Command proof verification is unavailable');
    }
    return success({ signed, crypto, applied });
  } catch {
    return failure('entry-verification-failed', 'Command proof or state validation failed');
  }
}

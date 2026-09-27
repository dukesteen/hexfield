import { hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { expect, test } from 'vitest';
import {
  artifactSigner,
  initialSeatAuthorities,
  resolveArtifactSigner,
  validateSeatAuthorities,
} from './authority.js';
import type { SeatAuthorities } from './authority-types.js';
import { signCommand, validateSignedCommand } from './command-validation.js';
import { entryHash, genesisDigest, signEntry } from './genesis.js';
import type { LogContext } from './log-types.js';
import { stubEvidence } from './log.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function setup() {
  const fixture = protocolFixture();
  const initial: LogContext = {
    genesis: fixture.genesis,
    engine: fixture.engine,
    state: fixture.state,
    head: fixture.entry,
    lastNonces: new Map(),
    crypto: null,
    authority: value(initialSeatAuthorities(fixture.genesis)),
  };
  const input = { kind: 'system', type: 'START_SEAT', seat: 0 } as const;
  const applied = value(fixture.engine.apply(fixture.state, input));
  const head = signEntry(
    {
      seq: 1,
      term: 1,
      prevHash: entryHash(fixture.entry),
      payload: { kind: 'system', input, evidence: stubEvidence(initial, input) },
      stateHash: toHex(hashValue(applied.state)),
      sequencer: fixtureAt(fixture.identities, 0).peerId,
    },
    fixtureAt(fixture.identities, 0).secretKey,
  );
  const context = { ...initial, head, state: applied.state };
  const command = fixture.engine
    .getLegalCommands(context.state, 0)
    .commands.find((candidate) => candidate.type === 'PLACE_SETTLEMENT');
  if (!command) throw new Error('Missing setup command');
  const body = {
    gameId: fixture.genesis.gameId,
    genesisDigest: genesisDigest(fixture.genesis),
    seat: 0 as const,
    nonce: 1,
    headSeq: head.seq,
    headHash: entryHash(head),
    command,
  };
  return { ...fixture, context, body };
}

test('genesis controller generation and legacy resolution match for humans and hosted bots', () => {
  const fixture = protocolFixture();
  const authority = value(initialSeatAuthorities(fixture.genesis));
  expect(authority.controllers.map(({ hostSeat }) => hostSeat)).toEqual([0, 1, 0, 1]);
  for (const { seat } of fixture.genesis.seats) {
    expect(value(artifactSigner(authority, seat))).toEqual(
      value(resolveArtifactSigner(undefined, fixture.genesis, 0, seat)),
    );
  }
  const missing = resolveArtifactSigner(undefined, fixture.genesis, 1, 0);
  expect(missing.ok ? '' : missing.error.code).toBe('authority-required');
});

test('command admission follows current controller keys and refuses the retired key', () => {
  const fixture = setup();
  const original = value(initialSeatAuthorities(fixture.genesis));
  const fresh = identityFromSecret(new Uint8Array(32).fill(78));
  const authority: SeatAuthorities = {
    ...original,
    epoch: 1,
    usedPublicKeys: [...original.usedPublicKeys, fresh.peerId],
    controllers: original.controllers.map((controller) =>
      controller.seat === 0
        ? {
            ...controller,
            publicKey: fresh.peerId,
            activatedAt: { seq: fixture.context.head.seq, hash: entryHash(fixture.context.head) },
          }
        : controller,
    ),
  };
  const current = { ...fixture.context, authority };
  const oldCommand = signCommand(fixture.body, fixtureAt(fixture.identities, 0).secretKey);
  const newCommand = signCommand(fixture.body, fresh.secretKey);
  expect(validateSignedCommand(oldCommand, fixture.context).ok).toBe(true);
  expect(validateSignedCommand(newCommand, fixture.context).ok).toBe(false);
  const stale = validateSignedCommand(oldCommand, current);
  expect(stale.ok ? '' : stale.error.code).toBe('command-signature');
  expect(validateSignedCommand(newCommand, current).ok).toBe(true);
  expect(fixture.genesis.seats[0]?.publicKey).toBe(fixtureAt(fixture.identities, 0).peerId);
  fresh.secretKey.fill(0);
});

test('pending recovery freezes departed and hosted seat signatures without changing genesis keys', () => {
  const fixture = setup();
  const original = value(initialSeatAuthorities(fixture.genesis));
  const authority: SeatAuthorities = {
    ...original,
    epoch: 1,
    controllers: original.controllers.map((controller) =>
      controller.hostSeat === 0
        ? { ...controller, hostSeat: 1, kind: 'bot', status: 'pending-recovery' }
        : controller,
    ),
  };
  expect(artifactSigner(authority, 0).ok).toBe(false);
  expect(artifactSigner(authority, 2).ok).toBe(false);
  expect(artifactSigner(authority, 1).ok).toBe(true);
  const signed = signCommand(fixture.body, fixtureAt(fixture.identities, 0).secretKey);
  const result = validateSignedCommand(signed, { ...fixture.context, authority });
  expect(result.ok ? '' : result.error.code).toBe('authority-pending');
});

test('authority validation rejects mismatched epochs, unreserved keys and inactive hosts', () => {
  const fixture = protocolFixture();
  const authority = value(initialSeatAuthorities(fixture.genesis));
  const validate = (candidate: unknown) =>
    validateSeatAuthorities(candidate, genesisDigest(fixture.genesis), 0, [0, 1, 2, 3]);
  expect(validate({ ...authority, epoch: 1 }).ok).toBe(false);
  expect(validate({ ...authority, usedPublicKeys: authority.usedPublicKeys.slice(1) }).ok).toBe(
    false,
  );
  expect(
    validate({
      ...authority,
      controllers: authority.controllers.map((controller) =>
        controller.seat === 2 ? { ...controller, hostSeat: 3 } : controller,
      ),
    }).ok,
  ).toBe(false);
});

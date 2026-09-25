import { toBase64Url } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

const key = toBase64Url(new Uint8Array(32));
const signature = toBase64Url(new Uint8Array(64));
const hash = '0'.repeat(64);
const gameId = 'A'.repeat(22);

const signedCommand = {
  body: {
    gameId,
    genesisDigest: key,
    seat: 0,
    nonce: 1,
    headSeq: 0,
    headHash: hash,
    command: { type: 'END_TURN' },
  },
  sig: signature,
};
const signedVote = {
  body: {
    genesisDigest: key,
    epoch: 0,
    seat: 0,
    seq: 1,
    term: 1,
    phase: 'precommit',
    valueHash: hash,
  },
  sig: signature,
};
const entry = {
  seq: 1,
  term: 1,
  prevHash: hash,
  payload: { kind: 'command', signed: signedCommand },
  stateHash: hash,
  sequencer: key,
  sig: signature,
};
const certified = { entry, certificate: [signedVote] };

const messages = [
  { t: 'SUBMIT', cmd: signedCommand },
  {
    t: 'PROPOSAL',
    proposal: {
      body: {
        genesisDigest: key,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      sig: signature,
    },
  },
  { t: 'VOTE', vote: signedVote },
  { t: 'COMMIT', certified },
  {
    t: 'ACCUSE',
    control: {
      kind: 'control',
      action: 'exclude-proposer',
      offender: 0,
      evidence: { kind: 'vote-equivocation', first: signedVote, second: signedVote },
    },
  },
  { t: 'SYNC_REQ', genesisDigest: key, fromSeq: 0 },
  { t: 'SYNC_REQ', genesisDigest: key, fromSeq: 1, toSeq: 10 },
  { t: 'SYNC_RES', genesisDigest: key, entries: [certified], more: true },
  { t: 'SNAPSHOT_REQ', genesisDigest: key, atSeq: 0 },
  { t: 'SNAPSHOT_RES', genesisDigest: key, atSeq: 0, snapshot: { seq: 0, hash } },
  {
    t: 'PROPOSAL_REQ',
    genesisDigest: key,
    epoch: 0,
    seq: 1,
    term: 1,
    valueHash: hash,
  },
  {
    t: 'HEARTBEAT',
    body: { genesisDigest: key, epoch: 0, seat: 0, head: { seq: 1, hash }, term: 1 },
    sig: signature,
  },
  { t: 'PING', n: 0 },
  { t: 'PONG', n: Number.MAX_SAFE_INTEGER },
];

describe('Stage 06 protocol messages', () => {
  test.each(messages)('canonically round-trips $t', (message) => {
    const encoded = encodeProtocolMessage(message);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeProtocolMessage(encoded.value)).toEqual({ ok: true, value: message });
  });

  test('rejects unknown message types, extra fields, and malformed nested payloads', () => {
    const invalid = [
      { t: 'CHAT', text: 'not in stage 06' },
      { t: 'PING', n: 1, extra: true },
      { t: 'SYNC_REQ', genesisDigest: key, fromSeq: -1 },
      { t: 'SYNC_REQ', genesisDigest: key, fromSeq: 1.5 },
      {
        t: 'SYNC_RES',
        genesisDigest: key,
        entries: Array.from({ length: 201 }, () => certified),
        more: false,
      },
      {
        t: 'HEARTBEAT',
        body: { genesisDigest: key, epoch: 0, seat: 6, head: { seq: 0, hash }, term: 1 },
        sig: signature,
      },
      { t: 'VOTE', vote: { ...signedVote, unexpected: true } },
      {
        t: 'ACCUSE',
        control: {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 0,
          evidence: { kind: 'vote-equivocation', first: signedVote, second: signedVote },
          extra: true,
        },
      },
      { t: 'SNAPSHOT_REQ', genesisDigest: key, atSeq: -1 },
      { t: 'SNAPSHOT_RES', genesisDigest: key, atSeq: 0, snapshot: {}, extra: true },
    ];
    for (const message of invalid)
      expect(encodeProtocolMessage(message)).toMatchObject({ ok: false });
  });

  test('applies the global message byte bound to encoded and imported data', () => {
    const tooLarge = { t: 'PING', n: 0, payload: 'x'.repeat(MAX_MESSAGE_BYTES) };
    expect(encodeProtocolMessage(tooLarge)).toMatchObject({
      ok: false,
      error: { code: 'message-too-large' },
    });
    expect(decodeProtocolMessage(new Uint8Array(MAX_MESSAGE_BYTES + 1))).toMatchObject({
      ok: false,
      error: { code: 'message-too-large' },
    });
  });

  test('returns canonical decoded envelopes detached from the input bytes', () => {
    const encoded = encodeProtocolMessage({ t: 'PING', n: 12 });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const importedBytes = encoded.value.slice();
    const decoded = decodeProtocolMessage(importedBytes);
    importedBytes.fill(0);
    expect(decoded).toEqual({ ok: true, value: { t: 'PING', n: 12 } });
  });
});

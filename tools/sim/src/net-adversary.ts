import { identityFromSecret, parsePeerId, verifyObject } from '@cp2p/crypto';
import {
  entryBody,
  genesisDigest,
  proposerFor,
  signCommand,
  signEntry,
  signProposal,
} from '@cp2p/protocol';
import type { Genesis, SignedProposal } from '@cp2p/protocol';
import type { Seat } from '@cp2p/engine';

/** Replaces only the Byzantine proposer's outbound proposal with signed objective misconduct. */
export function invalidCommandProposal(
  original: SignedProposal,
  genesis: Genesis,
  offenderSeat: Seat,
  offenderKey: Uint8Array,
): SignedProposal {
  const offender = genesis.seats.find((seat) => seat.seat === offenderSeat);
  const identity = identityFromSecret(offenderKey);
  const entry = original.body.entry;
  const digest = genesisDigest(genesis);
  if (
    offender?.kind !== 'human' ||
    offender.publicKey !== identity.peerId ||
    original.body.genesisDigest !== digest ||
    original.body.epoch !== 0 ||
    entry.seq < 1 ||
    !Number.isSafeInteger(entry.seq) ||
    entry.term < 1 ||
    !Number.isSafeInteger(entry.term) ||
    entry.sequencer !== identity.peerId ||
    original.body.validRound !== null ||
    original.body.prevotes.length !== 0
  )
    throw new Error('The fault hook requires this voter’s unjustified current proposal');
  const voters = genesis.seats
    .filter((seat) => seat.kind === 'human')
    .map((seat) => ({ seat: seat.seat, publicKey: seat.publicKey }));
  if (
    proposerFor(entry.seq, entry.term, { genesisDigest: digest, epoch: 0, voters }).seat !==
      offenderSeat ||
    !verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(identity.peerId)) ||
    !verifyObject('proposal', original.body, original.sig, parsePeerId(identity.peerId))
  )
    throw new Error('The fault hook cannot replace an unsigned or unelected proposal');
  const otherSeat = genesis.seats.find((seat) => seat.seat !== offenderSeat);
  if (!otherSeat) throw new Error('An invalid command needs another configured seat');
  const signed = signCommand(
    {
      gameId: genesis.gameId,
      genesisDigest: digest,
      seat: otherSeat.seat,
      nonce: Number.MAX_SAFE_INTEGER,
      headSeq: entry.seq - 1,
      headHash: entry.prevHash,
      command: { type: 'END_TURN' },
    },
    offenderKey,
  );
  const replaced = signEntry(
    {
      ...entryBody(entry),
      payload: { kind: 'command', signed },
    },
    offenderKey,
  );
  return signProposal({ ...original.body, entry: replaced }, offenderKey);
}

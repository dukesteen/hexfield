import { describe, expect, test, vi } from 'vitest';
import { success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { signCommand } from '@cp2p/protocol';
import type { SignedCommand } from '@cp2p/protocol';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
import type { VerifiedNonVoterActor } from '@cp2p/protocol/testing';
import { genesisDigest, entryHash } from '@cp2p/protocol';
import { NonVoterCommand } from './non-voter-command.js';

const fixture = createSimulationGenesis({ seed: 42 });
const identity = fixture.identities.get(0);
if (!identity) throw new Error('Missing fixture identity');
const parent = { seq: 0, hash: entryHash(fixture.entry) };
const command = { type: 'END_TURN' };
const signed = signCommand(
  {
    gameId: fixture.genesis.gameId,
    genesisDigest: genesisDigest(fixture.genesis),
    seat: 0,
    nonce: 1,
    headSeq: parent.seq,
    headHash: parent.hash,
    command,
  },
  identity.secretKey,
);
identity.secretKey.fill(0);

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    // oxlint-disable-next-line no-await-in-loop -- Drain the queued submit and completion microtasks.
    await Promise.resolve();
  }
}

describe('non-voter command delivery', () => {
  test('retries a dropped SUBMIT at the same parent without flooding each network delivery', async () => {
    const submit = vi.fn<VerifiedNonVoterActor['submit']>(async () => success(signed));
    const delivery = new NonVoterCommand({ submit }, command, parent);
    delivery.pump(0, parent);
    await settle();
    expect(delivery.result()).toEqual(success(signed));
    for (let now = 1; now < 250; now++) delivery.pump(now, parent);
    expect(submit).toHaveBeenCalledTimes(1);
    delivery.pump(250, parent);
    await settle();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
    delivery.pump(500, { seq: 1, hash: 'new-certified-head' });
    delivery.pump(750, parent);
    await settle();
    expect(submit).toHaveBeenCalledTimes(2);
    // The caller can still count the signed command that the new head certified.
    expect(delivery.result()).toEqual(success(signed));
  });

  test('keeps async trade preparation singular and discards its late result after a same-height fork', async () => {
    let finish: ((value: Result<SignedCommand>) => void) | undefined;
    const submit = vi.fn<VerifiedNonVoterActor['submit']>(
      () =>
        new Promise<Result<SignedCommand>>((resolve) => {
          finish = resolve;
        }),
    );
    const delivery = new NonVoterCommand({ submit }, command, parent);
    delivery.pump(0, parent);
    await settle();
    delivery.pump(1000, parent);
    expect(submit).toHaveBeenCalledTimes(1);
    delivery.pump(1001, { ...parent, hash: 'different-same-height-parent' });
    finish?.(success(signed));
    await settle();
    expect(delivery.result()).toMatchObject({ ok: false, error: { code: 'non-voter-stale-head' } });
  });

  test('surfaces a thrown submit as a failure instead of leaving the game waiting forever', async () => {
    const submit = vi.fn<VerifiedNonVoterActor['submit']>(() => {
      throw new Error('prepare failed');
    });
    const delivery = new NonVoterCommand({ submit }, command, parent);
    delivery.pump(0, parent);
    await settle();
    expect(delivery.result()).toMatchObject({
      ok: false,
      error: { code: 'non-voter-submit-threw' },
    });
    delivery.pump(1000, parent);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

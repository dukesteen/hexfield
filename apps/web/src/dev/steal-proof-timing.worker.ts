import { pedersenCommit, proveHiddenTransfer, verifyHiddenTransfer } from '@cp2p/crypto';

self.addEventListener('message', () => {
  const counts = [10, 11, 12, 13, 14, 15, 16, 17];
  const blindings = counts.map((_, index) => BigInt(index + 11));
  const transferBlindings = counts.map((_, index) => BigInt(index + 31));
  const statement = {
    commitments: counts.map((count, index) => pedersenCommit(BigInt(count), BigInt(index + 11))),
    transfer: counts.map((_, index) =>
      pedersenCommit(BigInt(index === 7 ? 1 : 0), BigInt(index + 31)),
    ),
    handSize: 108,
    index: 107,
    payloadHash: 'c'.repeat(64),
  };
  const samples = [];
  for (let index = 0; index < 3; index++) {
    const context = { genesis: 'a'.repeat(64), parent: 'b'.repeat(64), input: index };
    const start = performance.now();
    const proof = proveHiddenTransfer(
      statement,
      { counts, blindings, transferBlindings },
      new Uint8Array(32).fill(41 + index),
      context,
    );
    const proved = performance.now();
    const valid = verifyHiddenTransfer(statement, proof, context);
    const verified = performance.now();
    samples.push({
      sample: index + 1,
      proveMs: proved - start,
      verifyMs: verified - proved,
      totalMs: verified - start,
      valid,
    });
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messaging has no targetOrigin.
  self.postMessage({ userAgent: navigator.userAgent, types: counts.length, samples });
});

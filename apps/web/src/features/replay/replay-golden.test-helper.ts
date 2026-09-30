import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameConfig, Input } from '@cp2p/engine';
import { hashValue, toHex } from '@cp2p/codec';
import { fromBase64Url } from '@cp2p/codec';
import { engineForConfig } from '@cp2p/engine';
import type { LocalSaveBatch, LocalSessionSave } from '../../session/types.js';
import type { ReplayTranscript } from './replay-session.js';

const golden = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/engine/test/golden',
);

interface GoldenReplay {
  config: GameConfig;
  genesisSeed: string;
  inputs: Input[];
  checkpoints: { index: number; stateHash: string }[];
}

/** Engine goldens are local games: every input carries its own identities. */
export function goldenTranscript(file: string): ReplayTranscript<null> & { raw: GoldenReplay } {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Verified by the engine goldens.
  const raw = JSON.parse(readFileSync(join(golden, file), 'utf8')) as GoldenReplay;
  return {
    raw,
    config: raw.config,
    genesisSeed: raw.genesisSeed,
    inputs: raw.inputs,
    privateData: [],
    document: null,
  };
}

/** A local save of the first `stop` golden inputs, grouped into batches as a session makes them. */
export function goldenSave(file: string, stop?: number): LocalSessionSave {
  const { raw } = goldenTranscript(file);
  const inputs = raw.inputs.slice(0, stop ?? raw.inputs.length);
  const [genesis, ...rest] = inputs;
  if (genesis?.kind !== 'system')
    throw new Error('Golden replay does not begin with a system input');
  const engine = engineForConfig(raw.config);
  let state = engine.createGame(raw.config, fromBase64Url(raw.genesisSeed));
  const batches: LocalSaveBatch[] = [];
  for (const input of inputs) {
    const applied = engine.apply(state, input);
    if (!applied.ok) throw new Error(`Golden prefix rejected: ${applied.error.code}`);
    state = applied.value.state;
  }
  for (const input of rest) {
    if (input.kind === 'command' && input.command.type !== 'CLAIM_VICTORY')
      batches.push({ submitted: input, generated: [] });
    else {
      const batch = batches.at(-1);
      if (!batch) throw new Error('Generated input has no submitted command');
      batch.generated.push(input);
    }
  }
  return {
    v: 1,
    mode: 'local',
    engineVersion: state.engineVersion,
    config: raw.config,
    genesisSeed: raw.genesisSeed,
    roles: { humanSeats: [...raw.config.seats], botSeats: [] },
    genesis: [genesis],
    batches,
    finalHash: toHex(hashValue(state)),
  };
}

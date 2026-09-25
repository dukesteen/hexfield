import { canonicalEncode, fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import * as v from 'valibot';
import type {
  BoardState,
  GameState,
  Input,
  LocalRandomAnswer,
  LocalRandomSource,
  Pending,
  PrivateState,
  Seat,
} from '@cp2p/engine';
import { remainingDevPool } from './random.js';
import type { LocalSessionSave } from './types.js';

type SystemPending = Extract<Pending, { kind: 'random' | 'reveal' }>;

export function owned<T>(value: T): T {
  canonicalEncode(value);
  return structuredClone(value);
}

export function sameCanonical(left: unknown, right: unknown): boolean {
  const a = canonicalEncode(left);
  const b = canonicalEncode(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function stateHash(state: GameState): string {
  return toHex(hashValue(state));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const seatSchema = v.picklist([0, 1, 2, 3, 4, 5] as const);
const inputSchema = v.custom<Input>(
  (value) =>
    record(value) &&
    (value.kind === 'command'
      ? Number.isSafeInteger(value.seat) &&
        record(value.command) &&
        typeof value.command.type === 'string'
      : value.kind === 'system' && typeof value.type === 'string'),
);
const saveSchema = v.strictObject({
  v: v.literal(1),
  mode: v.literal('local'),
  engineVersion: v.string(),
  config: v.strictObject({
    modules: v.array(v.strictObject({ id: v.string(), version: v.string() })),
    seats: v.array(seatSchema),
    options: v.record(v.string(), v.unknown()),
    board: v.optional(v.custom<BoardState>(record)),
  }),
  genesisSeed: v.string(),
  roles: v.strictObject({ humanSeats: v.array(seatSchema), botSeats: v.array(seatSchema) }),
  genesis: v.array(inputSchema),
  batches: v.array(v.strictObject({ submitted: inputSchema, generated: v.array(inputSchema) })),
  finalHash: v.string(),
});

/** The outer shape is untrusted; engine replay checks config and every input. */
export function parseSave(value: unknown): LocalSessionSave {
  const parsed = v.parse(saveSchema, value);
  if (fromBase64Url(parsed.genesisSeed).length !== 32)
    throw new Error('Save has an invalid genesis seed');
  if (!/^[a-f0-9]{64}$/.test(parsed.finalHash)) throw new Error('Save has an invalid final hash');
  const { board, ...withoutBoard } = parsed.config;
  const config = board === undefined ? withoutBoard : { ...withoutBoard, board };
  return owned({ ...parsed, config });
}

/** Feeds only recorded system outcomes while checking secret deck stock. */
export class ReplayRandomSource implements LocalRandomSource {
  private expected: Input[] = [];
  private index = 0;
  private replaying = true;

  constructor(private readonly live: LocalRandomSource) {}

  begin(inputs: readonly Input[]): void {
    if (!this.replaying) throw new Error('Replay has already entered live mode');
    this.expected = inputs.filter((input) => input.kind === 'system');
    this.index = 0;
  }

  end(): void {
    if (this.index !== this.expected.length)
      throw new Error('Saved batch has unused system outcomes');
    this.expected = [];
    this.index = 0;
  }

  goLive(): void {
    this.end();
    this.replaying = false;
  }

  resolve(
    pending: SystemPending,
    state: Readonly<GameState>,
    privates: ReadonlyMap<Seat, PrivateState>,
  ): LocalRandomAnswer {
    if (!this.replaying) return this.live.resolve(pending, state, privates);
    const input = this.expected[this.index++];
    if (!input || input.kind !== 'system' || input.type !== pending.systemType)
      throw new Error(`Saved system outcome does not match ${pending.systemType}`);
    if (input.type === 'CARD_DEALT') {
      const pool = remainingDevPool(state, privates);
      if (typeof input.card !== 'string' || !pool.includes(input.card))
        throw new Error('Saved development card exceeds remaining stock');
    }
    return { input };
  }
}

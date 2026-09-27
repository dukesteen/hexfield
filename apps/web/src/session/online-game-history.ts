import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import type { Seat } from '@cp2p/engine';
import type { EscrowCeremonyStore, SessionAuditState } from '@cp2p/protocol';
import * as v from 'valibot';

const PROTOCOL = 'online-game-outcome-v1';
const MAX_RECORD_BYTES = 32 * 1024;
const GAME_ID = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const SEAT = v.custom<Seat>(isSeat);
const entryRefSchema = v.strictObject({
  seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  hash: v.pipe(v.string(), v.regex(HASH)),
});
const pointsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_000_000));
const seatPointsSchema = v.strictObject({ seat: SEAT, points: pointsSchema });
const finalScoreSchema = v.strictObject({
  seat: SEAT,
  publicPoints: pointsSchema,
  hiddenPoints: pointsSchema,
  totalPoints: pointsSchema,
});
const resultSchema = v.strictObject({
  winner: SEAT,
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  atTurn: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
});
const outcomeSchema = v.strictObject({
  protocol: v.literal(PROTOCOL),
  gameId: v.pipe(v.string(), v.regex(GAME_ID)),
  genesisDigest: v.pipe(v.string(), v.regex(DIGEST)),
  terminal: resultSchema,
  terminalHead: entryRefSchema,
  head: entryRefSchema,
  localSeat: v.nullable(SEAT),
  publicScores: v.pipe(v.array(seatPointsSchema), v.minLength(2), v.maxLength(6)),
  audit: v.strictObject({
    status: v.picklist(['pending', 'failed', 'verified']),
    code: v.nullable(v.pipe(v.string(), v.maxLength(80))),
  }),
  finalScores: v.nullable(v.pipe(v.array(finalScoreSchema), v.minLength(2), v.maxLength(6))),
});

const voidSchema = v.strictObject({
  protocol: v.literal('online-game-void-v1'),
  gameId: v.pipe(v.string(), v.regex(GAME_ID)),
  genesisDigest: v.pipe(v.string(), v.regex(DIGEST)),
  head: entryRefSchema,
});
export type OnlineGameVoid = v.InferOutput<typeof voidSchema>;

export interface OnlineGameOutcome {
  readonly protocol: typeof PROTOCOL;
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly terminal: { readonly winner: Seat; readonly reason: string; readonly atTurn: number };
  /** The certified head at which the engine recorded the terminal result. */
  readonly terminalHead: { readonly seq: number; readonly hash: string };
  /** The latest certified head covered by the recorded audit status. */
  readonly head: { readonly seq: number; readonly hash: string };
  /** Null when this device no longer controls a human seat or cannot identify one. */
  readonly localSeat: Seat | null;
  readonly publicScores: readonly { readonly seat: Seat; readonly points: number }[];
  readonly audit: {
    readonly status: 'pending' | 'failed' | 'verified';
    readonly code: string | null;
  };
  /** Present only for a complete successful audit of `head`. */
  readonly finalScores:
    | readonly {
        readonly seat: Seat;
        readonly publicPoints: number;
        readonly hiddenPoints: number;
        readonly totalPoints: number;
      }[]
    | null;
}

export interface SaveOnlineGameOutcomeInput {
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly head: { readonly seq: number; readonly hash: string };
  readonly terminalHead: { readonly seq: number; readonly hash: string };
  readonly state: {
    readonly config: { readonly seats: readonly Seat[] };
    readonly seats: readonly { readonly seat: Seat; readonly publicVp: number }[];
    readonly result: {
      readonly winner: Seat;
      readonly reason: string;
      readonly atTurn: number;
    } | null;
  };
  readonly localSeat: Seat | null;
  readonly audit: SessionAuditState;
}

export interface OnlineGameStats {
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly averageVictoryPoints: number | null;
}

function isSeat(value: unknown): value is Seat {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5;
}

function recordKey(gameId: string): string {
  return `online-game/${gameId}/outcome`;
}

function historyLock(gameId: string): string {
  return `online-game-history/${gameId}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function encodeBounded(value: unknown): Uint8Array {
  const bytes = canonicalEncode(value);
  if (bytes.byteLength > MAX_RECORD_BYTES)
    throw new Error('Online game outcome exceeds its size limit');
  return bytes;
}

function decodeStored(bytes: Uint8Array): OnlineGameOutcome {
  if (bytes.byteLength > MAX_RECORD_BYTES)
    throw new Error('Stored online game outcome exceeds its size limit');
  const decoded: unknown = canonicalDecode(bytes);
  if (!equalBytes(bytes, canonicalEncode(decoded)))
    throw new Error('Stored online game outcome is not canonical');
  const parsed = v.parse(outcomeSchema, decoded);
  validateOutcome(parsed);
  return parsed;
}

function validateOutcome(outcome: OnlineGameOutcome): void {
  const seats = outcome.publicScores.map(({ seat }) => seat);
  if (
    new Set(seats).size !== seats.length ||
    !seats.includes(outcome.terminal.winner) ||
    outcome.terminalHead.seq > outcome.head.seq ||
    (outcome.terminalHead.seq === outcome.head.seq &&
      outcome.terminalHead.hash !== outcome.head.hash) ||
    seats.some((seat, index) => seat !== index)
  )
    throw new Error('Stored online game outcome has inconsistent seats or heads');
  if (outcome.localSeat !== null && !seats.includes(outcome.localSeat))
    throw new Error('Stored online game outcome has an unknown local seat');
  if (outcome.audit.status === 'verified') {
    if (
      outcome.audit.code !== null ||
      outcome.finalScores === null ||
      outcome.finalScores.length !== seats.length ||
      outcome.finalScores.some((score, index) => {
        const publicScore = outcome.publicScores.find((item) => item.seat === score.seat);
        return (
          seats[index] !== score.seat ||
          !publicScore ||
          publicScore.points !== score.publicPoints ||
          score.totalPoints !== score.publicPoints + score.hiddenPoints
        );
      })
    )
      throw new Error('Verified online outcome is missing consistent final scores');
  } else if (outcome.finalScores !== null) {
    throw new Error('Unverified online outcome cannot contain final scores');
  }
}

function auditFields(
  audit: SessionAuditState,
  head: SaveOnlineGameOutcomeInput['head'],
  terminalHead: SaveOnlineGameOutcomeInput['terminalHead'],
  seats: readonly Seat[],
  publicScores: readonly { readonly seat: Seat; readonly points: number }[],
): OnlineGameOutcome['audit'] & { finalScores: OnlineGameOutcome['finalScores'] } {
  if (audit.kind !== 'complete') {
    return {
      status: audit.kind === 'error' ? 'failed' : 'pending',
      code: audit.kind === 'error' ? audit.code.slice(0, 80) : null,
      finalScores: null,
    };
  }

  const report = audit.report;
  const finalHead = report.finalHead;
  const terminal = report.terminal;
  const hidden = report.finalHiddenVictoryPoints;
  const cleanReport =
    report.ok &&
    report.complete &&
    report.missingSeats.length === 0 &&
    report.violations.length === 0 &&
    report.inputErrors.length === 0 &&
    report.cheatFindings.length === 0 &&
    report.historyError === null &&
    report.auditError === null &&
    finalHead !== null &&
    finalHead.seq === head.seq &&
    finalHead.hash === head.hash &&
    terminal !== null &&
    terminal.seq === terminalHead.seq &&
    terminal.hash === terminalHead.hash &&
    hidden !== null &&
    seats.every((seat) => Object.hasOwn(hidden, seat)) &&
    Array.isArray(report.missingSeats) &&
    Array.isArray(report.violations) &&
    Array.isArray(report.inputErrors) &&
    Array.isArray(report.cheatFindings) &&
    Object.keys(hidden ?? {}).every((seat) => {
      const numericSeat = Number(seat);
      if (!isSeat(numericSeat) || !seats.includes(numericSeat)) return false;
      const count = hidden[numericSeat];
      return count !== undefined && Number.isSafeInteger(count) && count >= 0;
    });
  if (!cleanReport) {
    const code = report.auditError?.code ?? report.historyError?.code ?? 'audit-incomplete';
    return { status: 'failed', code: code.slice(0, 80), finalScores: null };
  }

  const finalScores = seats.map((seat) => {
    const publicPoints = publicScores.find((item) => item.seat === seat)?.points;
    if (publicPoints === undefined) throw new Error('Final public score is missing');
    const hiddenPoints = hidden[seat] ?? 0;
    return {
      seat,
      publicPoints,
      hiddenPoints,
      totalPoints: publicPoints + hiddenPoints,
    };
  });
  return { status: 'verified', code: null, finalScores };
}

function prepareOutcome(input: SaveOnlineGameOutcomeInput): OnlineGameOutcome {
  if (!GAME_ID.test(input.gameId) || !DIGEST.test(input.genesisDigest))
    throw new TypeError('Online game identity is invalid');
  if (!input.state.result) throw new Error('Online game has no terminal result');
  if (
    !isSeat(input.state.result.winner) ||
    !Number.isSafeInteger(input.state.result.atTurn) ||
    input.state.result.atTurn < 0 ||
    typeof input.state.result.reason !== 'string' ||
    input.state.result.reason.length > 128 ||
    !Array.isArray(input.state.config.seats) ||
    input.state.config.seats.length < 2 ||
    input.state.config.seats.length > 6 ||
    !Array.isArray(input.state.seats) ||
    input.state.seats.length !== input.state.config.seats.length
  )
    throw new Error('Online game terminal state is malformed');
  const seats = [...input.state.config.seats];
  if (
    new Set(seats).size !== seats.length ||
    seats.some((seat, index) => !isSeat(seat) || seat !== index) ||
    !seats.includes(input.state.result.winner) ||
    (input.localSeat !== null && !seats.includes(input.localSeat))
  )
    throw new Error('Online game seat set is malformed');
  validateHead(input.head);
  validateHead(input.terminalHead);
  if (
    input.terminalHead.seq > input.head.seq ||
    (input.terminalHead.seq === input.head.seq && input.terminalHead.hash !== input.head.hash)
  )
    throw new Error('Online game terminal head is inconsistent');

  const publicScores = seats.map((seat) => {
    const seatState = input.state.seats.find((item) => item.seat === seat);
    if (
      !seatState ||
      !Number.isSafeInteger(seatState.publicVp) ||
      seatState.publicVp < 0 ||
      seatState.publicVp > 1_000_000
    )
      throw new Error('Online game public score is malformed');
    return { seat, points: seatState.publicVp };
  });
  const auditResult = auditFields(input.audit, input.head, input.terminalHead, seats, publicScores);
  const value: OnlineGameOutcome = {
    protocol: PROTOCOL,
    gameId: input.gameId,
    genesisDigest: input.genesisDigest,
    terminal: {
      winner: input.state.result.winner,
      reason: input.state.result.reason,
      atTurn: input.state.result.atTurn,
    },
    terminalHead: { ...input.terminalHead },
    head: { ...input.head },
    localSeat: input.localSeat,
    publicScores,
    audit: { status: auditResult.status, code: auditResult.code },
    finalScores: auditResult.finalScores,
  };
  const parsed = v.parse(outcomeSchema, value);
  validateOutcome(parsed);
  return parsed;
}

function validateHead(head: { readonly seq: number; readonly hash: string }): void {
  if (!Number.isSafeInteger(head.seq) || head.seq < 0 || !HASH.test(head.hash))
    throw new TypeError('Online game head is invalid');
}

function mergeOutcome(prior: OnlineGameOutcome, next: OnlineGameOutcome): OnlineGameOutcome {
  if (
    prior.gameId !== next.gameId ||
    prior.genesisDigest !== next.genesisDigest ||
    prior.terminal.winner !== next.terminal.winner ||
    prior.terminal.reason !== next.terminal.reason ||
    prior.terminal.atTurn !== next.terminal.atTurn ||
    prior.terminalHead.seq !== next.terminalHead.seq ||
    prior.terminalHead.hash !== next.terminalHead.hash ||
    prior.head.seq > next.head.seq ||
    (prior.head.seq === next.head.seq && prior.head.hash !== next.head.hash) ||
    (prior.localSeat !== null && next.localSeat !== null && prior.localSeat !== next.localSeat) ||
    !equalBytes(encodeBounded(prior.publicScores), encodeBounded(next.publicScores))
  )
    throw new Error('Online game outcome conflicts with its saved identity or history');

  if (prior.audit.status === 'verified' && prior.head.seq === next.head.seq) {
    if (
      next.audit.status === 'verified' &&
      !equalBytes(encodeBounded(prior.finalScores), encodeBounded(next.finalScores))
    )
      throw new Error('Online game audit disagrees with its previously verified outcome');
    return prior.localSeat === null && next.localSeat !== null
      ? { ...prior, localSeat: next.localSeat }
      : prior;
  }

  const merged = {
    ...next,
    localSeat: prior.localSeat ?? next.localSeat,
  };
  validateOutcome(merged);
  return merged;
}

/** Stores display/statistics metadata only; it never authorizes resume or voting. */
export async function saveOnlineGameOutcome(
  store: EscrowCeremonyStore,
  input: SaveOnlineGameOutcomeInput,
): Promise<OnlineGameOutcome> {
  const incoming = prepareOutcome(input);
  return store.withCeremonyLock(historyLock(incoming.gameId), async () => {
    const key = recordKey(incoming.gameId);
    const existing = await store.load(key);
    if (existing === null) {
      const bytes = encodeBounded(incoming);
      if (!(await store.putIfAbsent(key, bytes))) {
        const winnerBytes = await store.load(key);
        if (winnerBytes === null) throw new Error('Online game outcome write winner is missing');
        const winner = decodeStored(winnerBytes);
        const merged = mergeOutcome(winner, incoming);
        if (merged === winner) return winner;
        const replacement = encodeBounded(merged);
        if (!(await store.compareAndSwap(key, winnerBytes, replacement)))
          throw new Error('Online game outcome changed outside its device lock');
        return decodeStored(replacement);
      }
      return decodeStored(bytes);
    }

    const prior = decodeStored(existing);
    const merged = mergeOutcome(prior, incoming);
    if (merged === prior) return prior;
    const replacement = encodeBounded(merged);
    if (!(await store.compareAndSwap(key, existing, replacement)))
      throw new Error('Online game outcome changed outside its device lock');
    return decodeStored(replacement);
  });
}

/** Loads detached history metadata only after checking both the game id and genesis digest. */
export async function loadOnlineGameOutcome(
  store: EscrowCeremonyStore,
  gameId: string,
  expectedGenesisDigest: string,
): Promise<OnlineGameOutcome | null> {
  if (!GAME_ID.test(gameId) || !DIGEST.test(expectedGenesisDigest))
    throw new TypeError('Online game identity is invalid');
  const bytes = await store.load(recordKey(gameId));
  if (bytes === null) return null;
  const outcome = decodeStored(bytes);
  if (outcome.gameId !== gameId || outcome.genesisDigest !== expectedGenesisDigest)
    throw new Error('Online game outcome is bound to another game or genesis');
  return outcome;
}

/** Display metadata for a certified void; never a winner, audit or resume authority. */
export async function saveOnlineGameVoid(
  store: EscrowCeremonyStore,
  input: Omit<OnlineGameVoid, 'protocol'>,
): Promise<void> {
  const value = v.parse(voidSchema, { ...input, protocol: 'online-game-void-v1' });
  const bytes = encodeBounded(value);
  await store.withCeremonyLock(historyLock(input.gameId), async () => {
    const key = `online-game/${input.gameId}/void`;
    if (await store.putIfAbsent(key, bytes)) return;
    const prior = await store.load(key);
    if (!prior || !equalBytes(prior, bytes))
      throw new Error('Voided game metadata conflicts with its certified head');
  });
}

export async function loadOnlineGameVoid(
  store: EscrowCeremonyStore,
  gameId: string,
  expectedGenesisDigest: string,
): Promise<OnlineGameVoid | null> {
  if (!GAME_ID.test(gameId) || !DIGEST.test(expectedGenesisDigest))
    throw new TypeError('Online game identity is invalid');
  const bytes = await store.load(`online-game/${gameId}/void`);
  if (!bytes) return null;
  if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error('Voided game metadata is oversized');
  const value = v.parse(voidSchema, canonicalDecode(bytes));
  if (
    !equalBytes(bytes, canonicalEncode(value)) ||
    value.gameId !== gameId ||
    value.genesisDigest !== expectedGenesisDigest
  )
    throw new Error('Voided game metadata is bound to another game or genesis');
  return value;
}

/** Only fully audited outcomes with a known local human seat contribute to statistics. */
export function deriveOnlineGameStats(outcomes: readonly OnlineGameOutcome[]): OnlineGameStats {
  let gamesPlayed = 0;
  let wins = 0;
  let points = 0;
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (
      seen.has(outcome.gameId) ||
      outcome.audit.status !== 'verified' ||
      outcome.localSeat === null ||
      outcome.finalScores === null
    )
      continue;
    const localScore = outcome.finalScores.find((score) => score.seat === outcome.localSeat);
    if (!localScore) continue;
    seen.add(outcome.gameId);
    gamesPlayed += 1;
    points += localScore.totalPoints;
    if (outcome.terminal.winner === outcome.localSeat) wins += 1;
  }
  return {
    gamesPlayed,
    wins,
    averageVictoryPoints: gamesPlayed > 0 ? points / gamesPlayed : null,
  };
}

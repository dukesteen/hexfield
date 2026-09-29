import { G, encodePoint, scalePoint } from '@cp2p/crypto';
import { knightsConfig, knightsExt, registerAdHocModule, success } from '@cp2p/engine';
import type { CommandShape, Engine, GameConfig, GameModule, Seat } from '@cp2p/engine';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RandomBot, createBotRng } from '../../bots/src/index.js';
import { auditCertifiedGame } from './audit.js';
import { verifyCheatProof } from './cheat-proof.js';
import { validateCommandForEntry } from './command-validation.js';
import { entryHash } from './genesis.js';
import { signCommand } from './log.js';
import type { LogContext } from './log.js';
import { replayCertifiedPrefixObserved } from './replay.js';
import type { SignedCommand } from './types.js';
import { createTerminalAuditFixture } from './testing/audit-fixture.js';

/** The 23 progress cards a hand can hold (the Printer and the Constitution are shown on the draw). */
export const PLAYABLE_CARDS = [
  'alchemist',
  'crane',
  'engineer',
  'inventor',
  'irrigation',
  'medicine',
  'mining',
  'roadBuilding',
  'smith',
  'commercialHarbor',
  'masterMerchant',
  'merchant',
  'merchantFleet',
  'resourceMonopoly',
  'tradeMonopoly',
  'bishop',
  'deserter',
  'diplomat',
  'intrigue',
  'saboteur',
  'spy',
  'warlord',
  'wedding',
];

const QUICK_WIN = 'quick-win';
const QUICK_WIN_VERSION = '1.0.0';

/** Test-only: lowers the victory target so the certified log stays short enough to audit. */
function quickWinModule(): GameModule {
  return {
    id: QUICK_WIN,
    version: QUICK_WIN_VERSION,
    dependsOn: ['base'],
    conflictsWith: [],
    optionsSchema: [{ key: 'target', type: 'integer', default: 9, min: 3, max: 20 }],
    initState: () => ({}),
    hooks: {
      vpTarget: (config) => {
        const target: unknown = Reflect.get(config.options[QUICK_WIN] ?? {}, 'target');
        return typeof target === 'number' ? target : 9;
      },
    },
    commands: {},
    systemInputs: {},
    phases: {},
  };
}

export function shortKnights(seats: number, target: number): GameConfig {
  const config = knightsConfig({ seats });
  return {
    ...config,
    options: { ...config.options, [QUICK_WIN]: { target } },
    modules: [...config.modules, { id: QUICK_WIN, version: QUICK_WIN_VERSION }],
  };
}

/**
 * Start every seat at level 3 on each improvement track and the robber free. Gate faces of the
 * event die then deal progress cards to every seat at almost every roll, and steals loosen the
 * public hand bounds, so the progress flows run often within a short game.
 */
export function progressRich(engine: Engine): Engine {
  return {
    ...engine,
    createGame(config, seed) {
      const state = engine.createGame(config, seed);
      const ext = knightsExt(state);
      return {
        ...state,
        ext: {
          ...state.ext,
          knights: {
            ...ext,
            robberLocked: false,
            improvements: ext.improvements.map(() => ({ trade: 3, politics: 3, science: 3 })),
          },
        },
      };
    },
  };
}

let disposeQuickWin = () => {};
beforeAll(() => {
  disposeQuickWin = registerAdHocModule(QUICK_WIN, QUICK_WIN_VERSION, quickWinModule);
});
afterAll(() => {
  disposeQuickWin();
});

const yieldTask = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Plays each card at its first legal chance; every other choice is a random bot's. */
function scriptedPolicy(
  seed: number,
  played: Map<string, number>,
  onPlay: (card: string) => void = () => {},
) {
  const bot = new RandomBot();
  const rng = createBotRng(new Uint8Array(32).fill(seed));
  return {
    choosePending<T extends { allowed: string[] }>(pendings: readonly T[]): T | undefined {
      return pendings.find((item) => item.allowed.includes('RESPOND_TRADE')) ?? pendings[0];
    },
    chooseCommand(
      host: {
        getState(): Parameters<typeof bot.decide>[0]['state'];
        getLegalCommands(seat: Seat): { commands: CommandShape[] };
        getPrivate(seat: Seat): Parameters<typeof bot.decide>[0]['priv'] | null;
      },
      pending: Parameters<typeof bot.decide>[1] & { seat: Seat; allowed: string[] },
    ): CommandShape {
      const legal = host.getLegalCommands(pending.seat).commands;
      const plays = legal.filter(
        (item) => item.type === 'PLAY_PROGRESS_CARD' && typeof item.card === 'string',
      );
      // The least-played card first, so every kind gets its turn.
      const next = plays.toSorted(
        (a, b) => (played.get(String(a.card)) ?? 0) - (played.get(String(b.card)) ?? 0),
      )[0];
      if (next && (played.get(String(next.card)) ?? 0) === 0) {
        played.set(String(next.card), 1);
        onPlay(String(next.card));
        return next;
      }
      const priv = host.getPrivate(pending.seat);
      if (!priv) throw new Error('Game policy lacks its private seat');
      return bot.decide({ state: host.getState(), priv, seat: pending.seat }, pending, rng);
    },
  };
}

/** The two callbacks a fixture takes, from a scripted policy. */
function policyOptions(dealer: ReturnType<typeof scriptedPolicy>) {
  return {
    choosePending: <T extends { allowed: string[] }>(pendings: readonly T[]) =>
      dealer.choosePending(pendings),
    chooseCommand: (
      host: Parameters<typeof dealer.chooseCommand>[0],
      pending: Parameters<typeof dealer.chooseCommand>[1],
    ) => dealer.chooseCommand(host, pending),
  };
}

function playedIn(entries: readonly { entry: { payload: unknown } }[]): Map<string, number> {
  const played = new Map<string, number>();
  for (const { entry } of entries) {
    const payload = entry.payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Reflect.get(payload, 'kind') !== 'command'
    )
      continue;
    const body: unknown = Reflect.get(Reflect.get(payload, 'signed') ?? {}, 'body');
    const command: unknown = typeof body === 'object' && body ? Reflect.get(body, 'command') : null;
    if (
      typeof command === 'object' &&
      command &&
      Reflect.get(command, 'type') === 'PLAY_PROGRESS_CARD'
    ) {
      const card = String(Reflect.get(command, 'card'));
      played.set(card, (played.get(card) ?? 0) + 1);
    }
  }
  return played;
}

let firstGame: Awaited<ReturnType<typeof createTerminalAuditFixture>> | undefined;

/**
 * The whole progress deck over verified P2P games takes over ten minutes, so it and the cheating
 * checks that reuse its first game are opt-in acceptance runs:
 * `CP2P_HEAVY_TESTS=1 pnpm test packages/protocol/src/knights-progress-game.test.ts`.
 */
const HEAVY = process.env.CP2P_HEAVY_TESTS === '1';

describe.runIf(HEAVY)('every progress card over the verified P2P protocol', () => {
  test('four-seat games play the whole deck, answer every private request and audit clean', async () => {
    const played = new Map<string, number>();
    const certified = new Map<string, number>();
    const note = (entries: Parameters<typeof playedIn>[0]) => {
      for (const [card, count] of playedIn(entries))
        certified.set(card, (certified.get(card) ?? 0) + count);
    };
    const missing = () => PLAYABLE_CARDS.filter((card) => !certified.has(card));
    // The first game is played to its victory and audited. A card the random dealing never
    // handed out (or that never had a legal target) is chased in further games, which stop at
    // its play; each game hands the policy only the cards still missing.
    const first = await createTerminalAuditFixture({
      config: shortKnights(4, 11),
      simulationSeed: 71,
      humanCount: 2,
      prioritizeDevBuy: false,
      wrapEngine: progressRich,
      maxElapsedMs: 3_000_000,
      maxSteps: 8_000,
      yieldTask,
      ...policyOptions(scriptedPolicy(7, played)),
    });
    expect(first.terminal).toBe(true);
    firstGame = first;
    note(first.entries);
    expect(auditCertifiedGame(first)).toMatchObject({
      ok: true,
      complete: true,
      missingSeats: [],
      violations: [],
      inputErrors: [],
      historyError: null,
      auditError: null,
    });
    for (let extra = 0; extra < 3 && missing().length > 0; extra += 1) {
      const chase = new Map(
        PLAYABLE_CARDS.filter((card) => certified.has(card)).map((card) => [card, 1] as const),
      );
      // oxlint-disable-next-line no-await-in-loop -- Games run one at a time to bound memory.
      const more = await createTerminalAuditFixture({
        config: shortKnights(4, 11),
        simulationSeed: 72 + extra,
        humanCount: 2,
        prioritizeDevBuy: false,
        wrapEngine: progressRich,
        maxElapsedMs: 3_000_000,
        maxSteps: 8_000,
        yieldTask,
        stopWhen: () => PLAYABLE_CARDS.every((card) => certified.has(card) || chase.has(card)),
        ...policyOptions(scriptedPolicy(8 + extra, chase, (card) => certified.set(card, 1))),
      });
      note(more.entries);
    }
    expect({ missing: missing() }).toEqual({ missing: [] });
  }, 7_200_000);
});

type Game = Awaited<ReturnType<typeof createTerminalAuditFixture>>;

interface Moment {
  seq: number;
  seat: Seat;
  signed: SignedCommand;
  parent: LogContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function innerOf(command: CommandShape): Record<string, unknown> | null {
  return command.type === 'SEAT_INPUT' && isRecord(command.input) ? command.input : null;
}

/** Replays a certified game once and keeps the parent context of every entry the picks match. */
function collectMoments(
  game: Game,
  wanted: readonly [string, (body: SignedCommand['body']) => boolean][],
) {
  const found = new Map<string, Moment[]>(wanted.map(([name]) => [name, []]));
  const replay = replayCertifiedPrefixObserved(
    game.genesisEntry,
    game.entries,
    game.engine,
    game.policy,
    (validated, prior) => {
      const payload = validated.entry.payload;
      if (payload.kind !== 'command') return success(undefined);
      for (const [name, match] of wanted)
        if (match(payload.signed.body))
          found.get(name)?.push({
            seq: validated.entry.seq,
            seat: payload.signed.body.seat,
            signed: payload.signed,
            parent: prior.log,
          });
      return success(undefined);
    },
  );
  if (!replay.ok) throw new Error(replay.error.message);
  return found;
}

function forge(
  game: Game,
  moment: Moment,
  mutate: (body: SignedCommand['body']) => void,
): SignedCommand {
  const body: SignedCommand['body'] = structuredClone(moment.signed.body);
  mutate(body);
  const key = game.identities.get(moment.seat)?.secretKey;
  if (!key) throw new Error('Missing signing identity');
  return signCommand(body, key);
}

function evidenceData(body: SignedCommand['body']): Record<string, unknown> {
  const data = body.evidence?.data;
  if (!isRecord(data)) throw new Error('Command carries no proof sections');
  return data;
}

function sectionOf(body: SignedCommand['body'], name: string): unknown {
  const data = body.evidence?.data;
  return isRecord(data) ? data[name] : undefined;
}

function lookOf(body: SignedCommand['body']): Record<string, unknown> {
  const look = evidenceData(body).look;
  if (!isRecord(look)) throw new Error('Command carries no look evidence');
  return look;
}

function slotsOf(look: Record<string, unknown>): Record<string, unknown>[] {
  const slots = look.slots;
  if (!Array.isArray(slots)) throw new Error('Look evidence has no slots');
  return slots.filter(isRecord);
}

/**
 * The forged command must not validate. When the failure is a bad proof, its signer must also be
 * the certified offender; `mustProve` says the forgery cannot be refused any other way.
 */
function expectRejected(
  moment: Moment,
  forged: SignedCommand,
  codes: readonly string[],
  mustProve = true,
) {
  const checked = validateCommandForEntry(forged, moment.parent, {});
  expect(checked.ok).toBe(false);
  const proven = !checked.ok && codes.includes(checked.error.code);
  expect(!mustProve || proven).toBe(true);
  const finding = proven
    ? verifyCheatProof(
        {
          seat: moment.seat,
          evidence: {
            kind: 'command-proof',
            at: { seq: moment.parent.head.seq, hash: entryHash(moment.parent.head) },
            artifact: forged,
          },
        },
        moment.parent,
      )
    : null;
  expect(finding === null || (finding.ok && finding.value.seat === moment.seat)).toBe(true);
}

const G_POINT = encodePoint(scalePoint(G, 5n));

describe.runIf(HEAVY)('cheating with progress cards is caught on the move that tries it', () => {
  test('forged Spy request and unlock, Master Merchant take, Wedding give and hidden victory card', () => {
    const game = firstGame;
    if (!game) throw new Error('The audited game did not run');
    const moments = collectMoments(game, [
      [
        'spyPlay',
        (body) => body.command.type === 'PLAY_PROGRESS_CARD' && body.command.card === 'spy',
      ],
      [
        'spyShow',
        (body) => {
          const inner = innerOf(body.command);
          return inner?.type === 'SHOW_HAND' && inner.what === 'progress';
        },
      ],
      ['takeCards', (body) => innerOf(body.command)?.type === 'TAKE_CARDS'],
      ['wedding', (body) => body.command.type === 'WEDDING_GIVE'],
      [
        'victory',
        (body) => {
          const inner = innerOf(body.command);
          return inner?.type === 'REVEAL_PROGRESS' && inner.card !== 'none';
        },
      ],
      [
        'denial',
        (body) => {
          const inner = innerOf(body.command);
          return inner?.type === 'REVEAL_PROGRESS' && inner.card === 'none';
        },
      ],
      ['play', (body) => body.command.type === 'PLAY_PROGRESS_CARD'],
    ]);
    const first = (name: string, keep: (moment: Moment) => boolean = () => true): Moment => {
      const moment = moments.get(name)?.find(keep);
      if (!moment) throw new Error(`The game has no ${name} to forge`);
      return moment;
    };
    // The honest moves the forgeries are made from validate.
    for (const name of ['spyPlay', 'spyShow', 'takeCards', 'wedding', 'victory', 'denial'])
      for (const moment of moments.get(name)?.slice(0, 2) ?? [])
        expect(validateCommandForEntry(moment.signed, moment.parent, {}).ok).toBe(true);

    // 1. A Spy whose lock does not belong to the held card, or who skips a card of its target.
    const spyPlay = first('spyPlay', (moment) => slotsOf(lookOf(moment.signed.body)).length > 0);
    expectRejected(
      spyPlay,
      forge(game, spyPlay, (body) => {
        const slot = slotsOf(lookOf(body))[0];
        if (slot) slot.masked = slot.key;
      }),
      ['spy-request-proof'],
    );
    expectRejected(
      spyPlay,
      forge(game, spyPlay, (body) => {
        const look = lookOf(body);
        look.slots = slotsOf(look).slice(1);
      }),
      ['spy-request-slots'],
    );

    // 2. A target that unlocks with a point it did not compute, or shows fewer cards than it holds.
    const spyShow = first('spyShow', (moment) => slotsOf(lookOf(moment.signed.body)).length > 0);
    expectRejected(
      spyShow,
      forge(game, spyShow, (body) => {
        const slot = slotsOf(lookOf(body))[0];
        if (slot) slot.point = G_POINT;
      }),
      ['spy-unlock-proof'],
    );
    expectRejected(
      spyShow,
      forge(game, spyShow, (body) => {
        const look = lookOf(body);
        look.slots = slotsOf(look).slice(1);
      }),
      ['spy-unlock-slots'],
    );

    // 3. A Master Merchant that takes a card the target does not hold: its own proof of the
    // target's debit, made from the sealed opening, fails for any other statement.
    const take = moments.get('takeCards')?.find((moment) => {
      const hands = sectionOf(moment.signed.body, 'hands');
      return Array.isArray(hands) && hands.length > 0;
    });
    if (take) {
      expectRejected(
        take,
        forge(game, take, (body) => {
          const hands = evidenceData(body).hands;
          if (Array.isArray(hands) && isRecord(hands[0]))
            hands[0].count = Number(hands[0].count) + 1;
        }),
        ['hand-proof-obligation', 'hand-proof-invalid'],
      );
    }

    // 4. A Wedding giver that gives a card it never held (a kind swapped in for one it gave).
    const gift = first('wedding');
    expectRejected(
      gift,
      forge(game, gift, (body) => {
        const cards = body.command.cards;
        if (!isRecord(cards)) return;
        const given = Object.keys(cards).find((kind) => Number(cards[kind]) > 0);
        const other = Object.keys(cards).find(
          (kind) => kind !== given && Number(cards[kind]) === 0,
        );
        if (given && other) {
          cards[given] = Number(cards[given]) - 1;
          cards[other] = 1;
        }
      }),
      [
        'command-proofs-required',
        'command-proofs-count',
        'hand-proof-count',
        'hand-proof-obligation',
        'hand-proof-invalid',
      ],
      false,
    );
    // A gift of the wrong size never reaches the proofs: the engine refuses it.
    const short = forge(game, gift, (body) => {
      const cards = body.command.cards;
      if (!isRecord(cards)) return;
      const given = Object.keys(cards).find((kind) => Number(cards[kind]) > 0);
      if (given) cards[given] = Number(cards[given]) - 1;
    });
    expect(validateCommandForEntry(short, gift.parent, {}).ok).toBe(false);

    // 5. Hiding a victory card: the drawer says `none` about the Printer or the Constitution and
    // pastes the denial proof another drawer made for a card that is none of them.
    const victory = first('victory');
    const other = first('denial');
    const denials = sectionOf(other.signed.body, 'denials');
    expect(Array.isArray(denials) && denials.length > 0).toBe(true);
    expectRejected(
      victory,
      forge(game, victory, (body) => {
        const inner = innerOf(body.command);
        if (inner) inner.card = 'none';
        body.evidence = {
          protocol: 'command-proofs-v1',
          data: { deck: [], hands: [], denials: structuredClone(denials) },
        };
      }),
      ['deck-denial-proof', 'deck-denial-owner', 'deck-denial-context'],
    );
    // A denial with no proof at all is refused as missing evidence.
    expectRejected(
      victory,
      forge(game, victory, (body) => {
        const inner = innerOf(body.command);
        if (inner) inner.card = 'none';
        delete body.evidence;
      }),
      ['command-proofs-required'],
    );

    // 6. A play that shows another slot's card: the deck proofs of two plays swapped.
    const plays = moments.get('play')?.filter((moment) => {
      const deck = sectionOf(moment.signed.body, 'deck');
      return Array.isArray(deck) && deck.length === 1;
    });
    const [one, two] = plays ?? [];
    if (one && two) {
      const swapped = sectionOf(two.signed.body, 'deck');
      expectRejected(
        one,
        forge(game, one, (body) => {
          evidenceData(body).deck = structuredClone(swapped);
        }),
        ['deck-reveal-proof', 'deck-reveal-order', 'deck-reveal-owner', 'deck-reveal-context'],
      );
    }
  }, 900_000);
});

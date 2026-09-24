import type {
  CommandHandler,
  HandlerContext,
  PhaseHandler,
  SystemInputHandler,
} from '../../core/modules/index.js';
import { gainHidden, gainKnown, loseHidden, loseKnown } from '../../core/resources/index.js';
import type { GameState, PrivateState } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { Resource, Result, Seat } from '../../core/types/index.js';
import { verticesForHex } from './board/index.js';
import { claimCommands } from './legal.js';
import { oneResource } from './constants.js';
import { baseOptions } from './types.js';
import type { RobberData, StealData, StealResultData } from './types.js';
import {
  frame,
  isResource,
  ownSeat,
  playerPending,
  popPhase,
  privateExchange,
  replaceTop,
  top,
  updateSeat,
  withClaim,
} from './shared.js';

function robberData(state: GameState): RobberData {
  const value = top(state).data;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('returnTo' in value) ||
    (value.returnTo !== 'main' && value.returnTo !== 'pop')
  )
    throw new Error('Invalid robber phase');
  return { returnTo: value.returnTo };
}

function stealData(state: GameState): StealData {
  const value = top(state).data;
  if (typeof value !== 'object' || value === null) throw new Error('Invalid steal phase');
  // Only moveRobber constructs this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as StealData;
}

export function stealVictims(state: GameState): Seat[] {
  return [...stealData(state).targets];
}

function resultData(state: GameState): StealResultData {
  const value = top(state).data;
  if (typeof value !== 'object' || value === null) throw new Error('Invalid steal-result phase');
  // Only STEAL constructs this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as StealResultData;
}

function resume(state: GameState, returnTo: 'main' | 'pop'): GameState {
  return returnTo === 'main' ? replaceTop(state, frame('main')) : popPhase(state);
}

/** Robber targets after the optional friendly restriction and fall-back. */
export function legalRobberHexes(state: GameState): string[] {
  const candidates = state.board.hexes
    .map((hex) => hex.id)
    .filter((id) => id !== state.board.robberHex)
    .toSorted();
  if (!baseOptions(state.config.options.base).friendlyRobber) return candidates;
  const friendly = candidates.filter((hex) => {
    const vertices = new Set(verticesForHex(state, hex));
    return !state.board.buildings.some(
      (building) => vertices.has(building.vertex) && ownSeat(state, building.seat).publicVp <= 2,
    );
  });
  return friendly.length ? friendly : candidates;
}

/** Eligible occupied opponents, in seat order, with module target hooks applied. */
export function robberTargets(
  state: GameState,
  thief: Seat,
  hex: string,
  ctx: HandlerContext,
): Seat[] {
  const vertices = new Set(verticesForHex(state, hex));
  const occupied = state.config.seats.filter(
    (seat) =>
      seat !== thief &&
      ownSeat(state, seat).resources.total > 0 &&
      state.board.buildings.some(
        (building) => building.seat === seat && vertices.has(building.vertex),
      ),
  );
  return ctx.hooks.robberTargets(state, thief, hex, occupied).toSorted((a, b) => a - b);
}

export const moveRobberPhase: PhaseHandler = {
  pending: (state) =>
    withClaim(state, [playerPending(state, state.turn.activeSeat, ['MOVE_ROBBER'], 'moveRobber')]),
  legalCommands: (state, _frame, seat, priv) => {
    const claim = claimCommands(state, seat, priv);
    return seat === state.turn.activeSeat
      ? {
          commands: [
            ...legalRobberHexes(state).map((hex) => ({ type: 'MOVE_ROBBER', hex })),
            ...claim.commands,
          ],
          templates: claim.templates,
        }
      : { commands: [], templates: [] };
  },
};

export const moveRobber: CommandHandler = {
  validate: (state, input) =>
    typeof input.command.hex === 'string' && legalRobberHexes(state).includes(input.command.hex)
      ? success(undefined)
      : failure('illegal-robber-hex', 'Robber must move to a legal different hex'),
  apply: (state, input, ctx) => {
    const hex = input.command.hex;
    if (typeof hex !== 'string') throw new Error('Validated robber hex missing');
    const data = robberData(state);
    let next: GameState = { ...state, board: { ...state.board, robberHex: hex } };
    const targets = robberTargets(next, state.turn.activeSeat, hex, ctx);
    next = targets.length
      ? replaceTop(
          next,
          frame('steal', { targets, thief: state.turn.activeSeat, returnTo: data.returnTo }),
        )
      : resume(next, data.returnTo);
    return { state: next, events: [{ type: 'robberMoved', hex, seat: state.turn.activeSeat }] };
  },
};

export const stealPhase: PhaseHandler = {
  pending: (state) =>
    withClaim(state, [playerPending(state, state.turn.activeSeat, ['STEAL'], 'steal')]),
  legalCommands: (state, _frame, seat, priv) => {
    const claim = claimCommands(state, seat, priv);
    return seat === state.turn.activeSeat
      ? {
          commands: [
            ...stealData(state).targets.map((victim) => ({ type: 'STEAL', victim })),
            ...claim.commands,
          ],
          templates: claim.templates,
        }
      : { commands: [], templates: [] };
  },
};

export const steal: CommandHandler = {
  validate: (state, input) =>
    stealData(state).targets.some((victim) => victim === input.command.victim)
      ? success(undefined)
      : failure('invalid-steal-victim', 'Victim is not eligible'),
  apply: (state, input) => {
    const data = stealData(state);
    const victim = data.targets.find((seat) => seat === input.command.victim);
    if (victim === undefined) throw new Error('Validated victim missing');
    return {
      state: replaceTop(
        state,
        frame('stealResult', { thief: data.thief, victim, returnTo: data.returnTo }),
      ),
      events: [],
    };
  },
};

export const stealResultPhase: PhaseHandler = {
  legalCommands: (state, _frame, seat, priv) => claimCommands(state, seat, priv),
  pending: (state) => {
    const data = resultData(state);
    return withClaim(state, [
      {
        kind: 'random',
        request: {
          type: 'stealIndex',
          thief: data.thief,
          victim: data.victim,
          handSize: ownSeat(state, data.victim).resources.total,
        },
        systemType: 'STEAL_RESULT',
      },
    ]);
  },
};

function transferBounds(
  state: GameState,
  thief: Seat,
  victim: Seat,
  card: Resource | 'hidden',
): GameState {
  const from = ownSeat(state, victim).resources;
  const to = ownSeat(state, thief).resources;
  const loss = card === 'hidden' ? loseHidden(from, 1) : loseKnown(from, oneResource(card, 1));
  const gain = card === 'hidden' ? gainHidden(to, 1) : gainKnown(to, oneResource(card, 1));
  if (!loss.ok || !gain.ok) throw new Error('Validated steal bounds failed');
  let next = updateSeat(state, victim, (old) => ({ ...old, resources: loss.value }));
  next = updateSeat(next, thief, (old) => ({ ...old, resources: gain.value }));
  return next;
}

export const stealResult: SystemInputHandler = {
  validate: (state, input) => {
    const data = resultData(state);
    if (input.thief !== data.thief || input.victim !== data.victim)
      return failure('steal-result-mismatch', 'Steal result does not match the pending victim');
    if (input.resource !== 'hidden' && !isResource(input.resource))
      return failure('invalid-steal-resource', 'Steal resource is invalid');
    const victim = ownSeat(state, data.victim);
    if (victim.resources.total <= 0) return failure('empty-victim-hand', 'Victim has no cards');
    if (input.resource !== 'hidden') {
      const possible = loseKnown(victim.resources, oneResource(input.resource, 1));
      if (!possible.ok) return possible;
    }
    return success(undefined);
  },
  apply: (state, input) => {
    const data = resultData(state);
    const card = input.resource;
    if (card !== 'hidden' && !isResource(card)) throw new Error('Validated steal resource missing');
    const next = resume(transferBounds(state, data.thief, data.victim, card), data.returnTo);
    return {
      state: next,
      events: [
        {
          type: 'resourceStolen',
          thief: data.thief,
          victim: data.victim,
          known: card !== 'hidden',
        },
      ],
    };
  },
  applyPrivate: (priv, before, input, data): Result<PrivateState> => {
    const pending = resultData(before);
    if (priv.seat !== pending.thief && priv.seat !== pending.victim) return success(priv);
    const disclosed = input.resource === 'hidden' ? data?.resource : input.resource;
    if (!isResource(disclosed))
      return failure('missing-private-steal-card', 'Owner must know the stolen card');
    if (
      input.resource !== 'hidden' &&
      data?.resource !== undefined &&
      data.resource !== input.resource
    )
      return failure('steal-card-mismatch', 'Private steal card disagrees with public result');
    return privateExchange(priv, oneResource(disclosed, 1), priv.seat === pending.thief);
  },
};

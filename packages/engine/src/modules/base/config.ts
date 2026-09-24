import type { OptionSpec } from '../../core/modules/index.js';

export type MapLayout = 'standard-fixed' | 'random' | 'balanced-random';
export type DiceMode = 'random' | 'balanced';
export interface TurnTimer {
  preRollSec: number;
  mainSec: number;
  discardSec: number;
  robberSec: number;
}

export interface BaseOptions {
  vpTarget: number;
  discardLimit: number;
  friendlyRobber: boolean;
  mapLayout: MapLayout;
  strictBalance: boolean;
  playerTrades: boolean;
  diceMode: DiceMode;
  turnTimer: TurnTimer | null;
  hideBankCounts: boolean;
}

function isTurnTimer(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).toSorted();
  if (keys.join(',') !== 'discardSec,mainSec,preRollSec,robberSec') return false;
  return keys.every((key) => {
    const seconds: unknown = Reflect.get(value, key);
    return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0;
  });
}

export const BASE_OPTIONS: readonly OptionSpec[] = [
  { key: 'vpTarget', type: 'integer', default: 10, min: 3, max: 20 },
  { key: 'discardLimit', type: 'integer', default: 7, min: 0 },
  { key: 'friendlyRobber', type: 'boolean', default: false },
  {
    key: 'mapLayout',
    type: 'enum',
    default: 'balanced-random',
    values: ['standard-fixed', 'random', 'balanced-random'],
  },
  { key: 'strictBalance', type: 'boolean', default: false },
  { key: 'playerTrades', type: 'boolean', default: true },
  { key: 'diceMode', type: 'enum', default: 'random', values: ['random', 'balanced'] },
  { key: 'turnTimer', type: 'object', default: null, validate: isTurnTimer },
  { key: 'hideBankCounts', type: 'boolean', default: false },
];

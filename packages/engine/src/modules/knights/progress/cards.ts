import type {
  CommandHandler,
  PhaseHandler,
  SystemInputHandler,
} from '../../../core/modules/index.js';
import type { CardFlow, CardModule, ProgressCard } from './card.js';
import { alchemist } from './alchemist.js';
import { bishop } from './bishop.js';
import { commercialHarbor } from './commercialHarbor.js';
import { constitution } from './constitution.js';
import { crane } from './crane.js';
import { deserter } from './deserter.js';
import { diplomat } from './diplomat.js';
import { engineer } from './engineer.js';
import { intrigue } from './intrigue.js';
import { inventor } from './inventor.js';
import { irrigation } from './irrigation.js';
import { masterMerchant } from './masterMerchant.js';
import { medicine } from './medicine.js';
import { merchant } from './merchant.js';
import { merchantFleet } from './merchantFleet.js';
import { mining } from './mining.js';
import { printer } from './printer.js';
import { resourceMonopoly } from './resourceMonopoly.js';
import { roadBuilding } from './roadBuilding.js';
import { saboteur } from './saboteur.js';
import { smith } from './smith.js';
import { spy } from './spy.js';
import { tradeMonopoly } from './tradeMonopoly.js';
import { warlord } from './warlord.js';
import { wedding } from './wedding.js';

/** Every progress card, one module per card, in the order of the decks in the rules doc. */
export const CARD_MODULES: readonly CardModule[] = [
  alchemist,
  crane,
  engineer,
  inventor,
  irrigation,
  medicine,
  mining,
  printer,
  roadBuilding,
  smith,
  commercialHarbor,
  masterMerchant,
  merchant,
  merchantFleet,
  resourceMonopoly,
  tradeMonopoly,
  bishop,
  constitution,
  deserter,
  diplomat,
  intrigue,
  saboteur,
  spy,
  warlord,
  wedding,
];

const BY_ID = new Map<string, ProgressCard>(CARD_MODULES.map((item) => [item.card.id, item.card]));

/** The effect of a card, or undefined for an id that is not a progress card. */
export function cardOf(id: unknown): ProgressCard | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

export const FLOWS: readonly CardFlow[] = CARD_MODULES.flatMap((item) =>
  item.flow ? [item.flow] : [],
);

/** The commands, system inputs and frames of every card's flow, merged (shared ones are equal). */
export const FLOW_COMMANDS: Record<string, CommandHandler> = Object.assign(
  {},
  ...FLOWS.map((flow) => flow.commands ?? {}),
);
export const FLOW_SYSTEM_INPUTS: Record<string, SystemInputHandler> = Object.assign(
  {},
  ...FLOWS.map((flow) => flow.systemInputs ?? {}),
);
export const FLOW_PHASES: Record<string, PhaseHandler> = Object.assign(
  {},
  ...FLOWS.map((flow) => flow.phases ?? {}),
);

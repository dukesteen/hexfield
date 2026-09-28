import type { GameEvent } from '@cp2p/engine';
import { getDieUrl, getEventDieUrl, getRedDieUrl } from '@cp2p/renderer';
import { useTranslation } from 'react-i18next';
import './dice-roll-readout.css';

export type EventFace = 'ship' | 'trade' | 'politics' | 'science';

export interface DiceRoll {
  readonly faces: readonly [number, number];
  readonly total: number;
  /** The event die of a Cities & Knights roll. */
  readonly event?: EventFace;
}

function eventFace(value: unknown): EventFace | undefined {
  return value === 'ship' || value === 'trade' || value === 'politics' || value === 'science'
    ? value
    : undefined;
}

function validFaces(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (face: unknown) =>
        typeof face === 'number' && Number.isSafeInteger(face) && face >= 1 && face <= 6,
    )
  );
}

/** Finds the latest valid public roll so the readout survives phase changes and save restore. */
export function latestDiceRoll(events: readonly GameEvent[]): DiceRoll | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'diceRolled') continue;
    if (!validFaces(event.dice)) continue;
    const total = event.roll;
    if (!Number.isSafeInteger(total) || total !== event.dice[0] + event.dice[1]) continue;
    const face =
      typeof event.extra === 'object' && event.extra !== null && !Array.isArray(event.extra)
        ? eventFace(Reflect.get(event.extra, 'event'))
        : undefined;
    return { faces: [event.dice[0], event.dice[1]], total, ...(face ? { event: face } : {}) };
  }
  return null;
}

function DieFace({ value, red = false }: { value: number; red?: boolean }) {
  return (
    <img className="dice-roll-face" src={red ? getRedDieUrl(value) : getDieUrl(value)} alt="" />
  );
}

/** Persistent, public last-roll display; animation controls do not affect it. */
export function DiceRollReadout({ dice }: { dice: DiceRoll | null }) {
  const { t } = useTranslation('game');
  if (!dice) return null;
  return (
    <figure
      className="dice-roll-readout"
      role="img"
      data-event={dice.event}
      aria-label={
        t('game:lastRollAria', {
          first: dice.faces[0],
          second: dice.faces[1],
          total: dice.total,
        }) +
        (dice.event
          ? `. ${t('knights:dice.event', { face: t(`knights:dice.face.${dice.event}`) })}`
          : '')
      }
    >
      <figcaption>{t('game:lastRollLabel')}</figcaption>
      <span className="dice-roll-total" aria-hidden="true">
        {dice.total}
      </span>
      <div className="dice-roll-display" aria-hidden="true">
        <DieFace value={dice.faces[0]} red={dice.event !== undefined} />
        <DieFace value={dice.faces[1]} />
        {dice.event && (
          <img
            className="dice-roll-face dice-roll-event"
            src={getEventDieUrl(dice.event)}
            alt=""
            data-face={dice.event}
          />
        )}
      </div>
    </figure>
  );
}

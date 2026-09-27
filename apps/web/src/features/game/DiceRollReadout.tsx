import type { GameEvent } from '@cp2p/engine';
import { getDieUrl } from '@cp2p/renderer';
import { useTranslation } from 'react-i18next';
import './dice-roll-readout.css';

export interface DiceRoll {
  readonly faces: readonly [number, number];
  readonly total: number;
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
    return { faces: [event.dice[0], event.dice[1]], total };
  }
  return null;
}

function DieFace({ value }: { value: number }) {
  return <img className="dice-roll-face" src={getDieUrl(value)} alt="" />;
}

/** Persistent, public last-roll display; animation controls do not affect it. */
export function DiceRollReadout({ dice }: { dice: DiceRoll | null }) {
  const { t } = useTranslation('game');
  if (!dice) return null;
  return (
    <figure
      className="dice-roll-readout"
      role="img"
      aria-label={t('game:lastRollAria', {
        first: dice.faces[0],
        second: dice.faces[1],
        total: dice.total,
      })}
    >
      <figcaption>{t('game:lastRollLabel')}</figcaption>
      <span className="dice-roll-total" aria-hidden="true">
        {dice.total}
      </span>
      <div className="dice-roll-display" aria-hidden="true">
        <DieFace value={dice.faces[0]} />
        <DieFace value={dice.faces[1]} />
      </div>
    </figure>
  );
}

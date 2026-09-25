import type { GameEvent } from '@cp2p/engine';
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

const pipLayout: Readonly<Record<number, readonly number[]>> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function DieFace({ value }: { value: number }) {
  const activePips = pipLayout[value] ?? [];
  return (
    <span className="dice-roll-face" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <span
          className={activePips.includes(index) ? 'dice-roll-pip is-active' : 'dice-roll-pip'}
          key={index}
        />
      ))}
    </span>
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
      aria-label={t('game:lastRollAria', {
        first: dice.faces[0],
        second: dice.faces[1],
        total: dice.total,
      })}
    >
      <figcaption>{t('game:lastRollLabel')}</figcaption>
      <div className="dice-roll-display" aria-hidden="true">
        <DieFace value={dice.faces[0]} />
        <DieFace value={dice.faces[1]} />
        <span className="dice-roll-total">{dice.total}</span>
      </div>
    </figure>
  );
}

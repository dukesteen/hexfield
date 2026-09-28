import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogFrame } from '../../dialogs/DialogFrame.js';
import { emptyCounts } from '../../dialogs/resources.js';
import type { CommandFormProps } from '../../dialogs/types.js';
import { useCommandValidations } from '../../dialogs/use-command-validation.js';
import { ValidationChecking } from '../../dialogs/ValidationChecking.js';
import { ResourceCardPicker } from '../../trade/ResourceCard.js';
import { cardKinds } from '../state.js';
import '../knights.css';

type GiveKind = 'WEDDING_GIVE' | 'SABOTEUR_DISCARD';

/**
 * A card the seat is made to part with: two cards for the player of a Wedding, half the hand for
 * a Saboteur. The count comes from the engine's template, never from the client.
 */
export function GiveCardsDialog({
  kind,
  ...props
}: CommandFormProps & {
  kind: GiveKind;
}) {
  const { legal, privateState, state, playerLabel, onSubmit } = props;
  const { t } = useTranslation(['knights', 'rules']);
  const kinds = cardKinds(state);
  const [cards, setCards] = useState<Record<string, number>>(() => emptyCounts(kinds));
  const template = legal.templates.find((item) => item.type === kind);
  const count = typeof template?.count === 'number' ? template.count : 0;
  const selected = kinds.reduce((sum, item) => sum + (cards[item] ?? 0), 0);
  const command = { type: kind, cards };
  const [validation] = useCommandValidations(template ? [command] : [], props);
  if (typeof template?.count !== 'number') return null;
  const frame = state.turn.phase.at(-1);
  const data: unknown = frame?.data;
  const actor = typeof data === 'object' && data !== null ? Reflect.get(data, 'actor') : undefined;
  const to = state.config.seats.find((seat) => seat === actor);
  const valid = selected === count && validation === 'valid';
  const change = (item: string, value: number) => {
    if (value < 0 || value > (privateState.hand[item] ?? 0)) return;
    setCards((current) => ({ ...current, [item]: value }));
  };
  const key = kind === 'WEDDING_GIVE' ? 'wedding' : 'saboteur';
  return (
    <DialogFrame
      title={t(`knights:${key}.title`)}
      variant="trade"
      footer={
        <div className="trade-dialog-footer">
          <p aria-live="polite">{t('rules:discard.selected', { selected, count })}</p>
          <ValidationChecking checking={selected === count && validation === 'checking'} />
          <div className="trade-dialog-buttons">
            <button
              className="button button-primary"
              type="button"
              disabled={!valid}
              onClick={() => {
                if (valid) onSubmit(command);
              }}
            >
              {t('rules:action.confirm')}
            </button>
          </div>
        </div>
      }
    >
      <p>
        {kind === 'WEDDING_GIVE' && to !== undefined
          ? t('knights:wedding.instruction', { player: playerLabel(to), count })
          : t(`knights:${key}.instruction`, { count })}
      </p>
      <ResourceCardPicker
        label={t(`knights:${key}.cards`)}
        values={cards}
        kinds={kinds}
        stock={{ source: 'hand', counts: privateState.hand }}
        onChange={change}
        onClear={() => setCards(emptyCounts(kinds))}
      />
    </DialogFrame>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOURCES } from '@cp2p/engine';
import type { Resource } from '@cp2p/engine';
import { DialogFrame } from './DialogFrame.js';
import { resourceLabel } from './resources.js';
import type { CommandFormProps } from './types.js';

interface Props extends CommandFormProps {
  slotId?: string;
}

export function YearOfPlentyDialog({ legal, state, validate, onSubmit, onCancel, slotId }: Props) {
  const { t } = useTranslation('rules');
  const [first, setFirst] = useState<Resource>('brick');
  const [second, setSecond] = useState<Resource>('brick');
  const template = legal.templates.find(
    (item) =>
      item.type === 'PLAY_DEV_CARD' &&
      item.card === 'yearOfPlenty' &&
      typeof item.slotId === 'string' &&
      (slotId === undefined || item.slotId === slotId),
  );
  if (!template || typeof template.slotId !== 'string') return null;
  const amount = (resource: Resource) => Number(resource === first) + Number(resource === second);
  const resources = {
    brick: amount('brick'),
    lumber: amount('lumber'),
    wool: amount('wool'),
    grain: amount('grain'),
    ore: amount('ore'),
  };
  const command = {
    type: 'PLAY_DEV_CARD',
    slotId: template.slotId,
    card: 'yearOfPlenty',
    params: { resources },
  };
  const result = validate(command);
  const base = state.config.options.base;
  const hiddenBank =
    typeof base === 'object' && base !== null && Reflect.get(base, 'hideBankCounts') === true;
  return (
    <DialogFrame title={t('rules:plenty.title')} onCancel={onCancel}>
      <p>{t('rules:plenty.instruction')}</p>
      <label>
        {t('rules:plenty.first')}
        <select
          aria-label={t('rules:plenty.first')}
          value={first}
          onChange={(event) =>
            setFirst(RESOURCES.find((item) => item === event.currentTarget.value) ?? first)
          }
        >
          {RESOURCES.map((resource) => (
            <option key={resource} value={resource}>
              {resourceLabel(t, resource)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('rules:plenty.second')}
        <select
          aria-label={t('rules:plenty.second')}
          value={second}
          onChange={(event) =>
            setSecond(RESOURCES.find((item) => item === event.currentTarget.value) ?? second)
          }
        >
          {RESOURCES.map((resource) => (
            <option key={resource} value={resource}>
              {resourceLabel(t, resource)}
            </option>
          ))}
        </select>
      </label>
      <p>
        {hiddenBank
          ? t('rules:plenty.bankHidden')
          : t('rules:plenty.bankAvailable', {
              first: state.bank[first] ?? 0,
              second: state.bank[second] ?? 0,
            })}
      </p>
      <button
        type="button"
        disabled={!result.ok}
        onClick={() => {
          if (validate(command).ok) onSubmit(command);
        }}
      >
        {t('rules:action.confirm')}
      </button>
      {!result.ok && <p role="alert">{t('rules:validation.plenty')}</p>}
      {onCancel && (
        <button type="button" onClick={onCancel}>
          {t('rules:action.cancel')}
        </button>
      )}
    </DialogFrame>
  );
}

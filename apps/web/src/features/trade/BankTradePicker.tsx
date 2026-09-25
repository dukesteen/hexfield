import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { baseHarborRate, RESOURCES } from '@cp2p/engine';
import type { CommandShape, Resource, ResourceCounts } from '@cp2p/engine';
import { DialogFrame } from '../dialogs/DialogFrame.js';
import { emptyCounts, resourceLabel, ResourceFields } from '../dialogs/resources.js';
import type { CommandFormProps } from '../dialogs/types.js';

function oneResource(resource: Resource, count: number): ResourceCounts {
  return { ...emptyCounts(), [resource]: count };
}

/** Show the rules engine's rate; validation still decides whether a trade is affordable. */
function bestSingleTrades(
  rates: readonly { resource: Resource; rate: number }[],
  privateHand: Record<string, number>,
  validate: CommandFormProps['validate'],
) {
  const choices: { command: CommandShape; given: Resource; received: Resource; rate: number }[] =
    [];
  for (const { resource: given, rate } of rates)
    for (const received of RESOURCES) {
      if (given === received || (privateHand[given] ?? 0) < rate) continue;
      const command = {
        type: 'MARITIME_TRADE',
        give: oneResource(given, rate),
        get: oneResource(received, 1),
      };
      if (validate(command).ok) choices.push({ command, given, received, rate });
    }
  return choices;
}

/** Single-unit shortcuts and a full multi-resource, rate-multiple composer. */
export function BankTradePicker({
  legal,
  state,
  seat,
  privateState,
  validate,
  onSubmit,
  onCancel,
}: CommandFormProps) {
  const { t } = useTranslation('rules');
  const [give, setGive] = useState<ResourceCounts>(emptyCounts);
  const [get, setGet] = useState<ResourceCounts>(emptyCounts);
  if (!legal.templates.some((item) => item.type === 'MARITIME_TRADE')) return null;
  const command = { type: 'MARITIME_TRADE', give, get };
  const result = validate(command);
  const rates = RESOURCES.map((resource) => ({
    resource,
    rate: baseHarborRate(state, seat, resource),
  }));
  const shortcuts = bestSingleTrades(rates, privateState.hand, validate);
  return (
    <DialogFrame title={t('rules:bank.title')} onCancel={onCancel}>
      <p>{t('rules:bank.bestRates')}</p>
      <ul>
        {rates.map(({ resource, rate }) => (
          <li key={resource}>
            {t('rules:bank.rate', { resource: resourceLabel(t, resource), rate })}
          </li>
        ))}
      </ul>
      <div aria-label={t('rules:bank.shortcuts')}>
        {shortcuts.map(({ command: choice, given, received, rate }) => (
          <button
            type="button"
            key={`${given}:${received}`}
            onClick={() => {
              if (validate(choice).ok) onSubmit(choice);
            }}
          >
            {t('rules:bank.shortcut', {
              rate,
              give: resourceLabel(t, given),
              get: resourceLabel(t, received),
            })}
          </button>
        ))}
      </div>
      <ResourceFields
        label={t('rules:trade.give')}
        values={give}
        maximum={privateState.hand}
        onChange={(resource, value) => {
          if (value <= (privateState.hand[resource] ?? 0))
            setGive((current) => ({ ...current, [resource]: value }));
        }}
      />
      <ResourceFields
        label={t('rules:bank.get')}
        values={get}
        onChange={(resource, value) => setGet((current) => ({ ...current, [resource]: value }))}
      />
      <button
        type="button"
        disabled={!result.ok}
        onClick={() => {
          if (validate(command).ok) onSubmit(command);
        }}
      >
        {t('rules:action.confirm')}
      </button>
      {!result.ok && <p role="alert">{t('rules:validation.bank')}</p>}
      {onCancel && (
        <button type="button" onClick={onCancel}>
          {t('rules:action.cancel')}
        </button>
      )}
    </DialogFrame>
  );
}

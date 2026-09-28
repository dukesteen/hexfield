import { RESOURCES } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

export function emptyCounts(): ResourceCounts;
export function emptyCounts(kinds: readonly string[]): Record<string, number>;
export function emptyCounts(kinds?: readonly string[]): Record<string, number> {
  return Object.fromEntries((kinds ?? RESOURCES).map((kind) => [kind, 0]));
}

/** Every card kind any game can hold: the five resources, then the three commodities. */
export const ALL_CARD_KINDS: readonly string[] = [...RESOURCES, 'cloth', 'coin', 'paper'];

export function resourceLabel(t: TFunction, resource: string): string {
  switch (resource) {
    case 'brick':
      return t('rules:resource.brick');
    case 'lumber':
      return t('rules:resource.lumber');
    case 'wool':
      return t('rules:resource.wool');
    case 'grain':
      return t('rules:resource.grain');
    case 'ore':
      return t('rules:resource.ore');
    case 'cloth':
      return t('rules:resource.cloth');
    case 'coin':
      return t('rules:resource.coin');
    case 'paper':
      return t('rules:resource.paper');
  }
  throw new Error('Unknown resource');
}

interface ResourceFieldsProps {
  values: ResourceCounts;
  onChange: (resource: Resource, value: number) => void;
  maximum?: Partial<ResourceCounts>;
  label: string;
}

export function ResourceFields({ values, onChange, maximum, label }: ResourceFieldsProps) {
  const { t } = useTranslation('rules');
  return (
    <fieldset>
      <legend>{label}</legend>
      {RESOURCES.map((resource) => (
        <label key={resource}>
          {resourceLabel(t, resource)}
          <input
            aria-label={`${label}: ${resourceLabel(t, resource)}`}
            type="number"
            min={0}
            max={maximum?.[resource]}
            step={1}
            value={values[resource]}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isSafeInteger(next) && next >= 0) onChange(resource, next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

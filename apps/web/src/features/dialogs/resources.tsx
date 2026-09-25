import { RESOURCES } from '@cp2p/engine';
import type { Resource, ResourceCounts } from '@cp2p/engine';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

export function emptyCounts(): ResourceCounts {
  return { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
}

export function resourceLabel(t: TFunction, resource: Resource): string {
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

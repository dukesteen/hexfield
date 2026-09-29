import { EXPANSION_IDS, MODULE_CATALOGUE, compatibility } from '@cp2p/engine';
import type { ExpansionId } from '@cp2p/engine';
import { scenarioById, scenariosForSeats, type Scenario } from '@cp2p/maps';
import { useTranslation } from 'react-i18next';
import '../modules/modules.css';

export type ExpansionState =
  | { readonly kind: 'selected' }
  | { readonly kind: 'available' }
  | { readonly kind: 'unavailable'; readonly reason: 'later' | 'conflict'; readonly with?: string };

/** Lobby view of the compatibility matrix for the modules a scenario selects. */
export function expansionState(id: ExpansionId, selected: readonly string[]): ExpansionState {
  if (selected.includes(id)) return { kind: 'selected' };
  if (!Object.hasOwn(MODULE_CATALOGUE, id)) return { kind: 'unavailable', reason: 'later' };
  const blocker = selected.find((other) => compatibility(id, other) !== 'yes');
  return blocker === undefined
    ? { kind: 'available' }
    : { kind: 'unavailable', reason: 'conflict', with: blocker };
}

interface ScenarioPickerProps {
  readonly seatCount: number;
  readonly scenarioId: string;
  readonly onScenario: (scenario: Scenario) => void;
  /** Request a seat count that enables or disables an expansion (five-six). */
  readonly onSeatCount: (count: number) => void;
  readonly disabled?: boolean;
  /** Offer only the classic scenarios, for screens that cannot carry a seafaring board yet. */
  readonly classicOnly?: boolean;
  /** Offer the knights and commerce scenarios: online games play them over the verified protocol. */
  readonly allowKnights?: boolean;
}

/** Modules whose play screens are not built yet; their scenarios stay out of the picker. */
const UNPLAYABLE_IN_UI = new Set(['knights']);

/** Seafaring is only ever chosen through its scenarios, never as a bare module. */
export function isSeafaringScenario(scenario: Scenario): boolean {
  return scenario.modules.includes('seafaring');
}

/** A scenario that brings an expansion module of its own (seafaring, or knights and commerce). */
export function isExpansionScenario(scenario: Scenario): boolean {
  return isSeafaringScenario(scenario) || scenario.modules.includes('knights');
}

/** Scenario choice filtered by seat count, with the expansion matrix shown alongside. */
export function ScenarioPicker({
  seatCount,
  scenarioId,
  onScenario,
  onSeatCount,
  disabled = false,
  classicOnly = false,
  allowKnights = false,
}: ScenarioPickerProps) {
  const { t } = useTranslation('lobby');
  const unplayable = allowKnights ? new Set<string>() : UNPLAYABLE_IN_UI;
  const choices = scenariosForSeats(seatCount).filter(
    (scenario) =>
      (!classicOnly || !isSeafaringScenario(scenario)) &&
      !scenario.modules.some((id) => unplayable.has(id)),
  );
  const classic = choices.filter((scenario) => !isSeafaringScenario(scenario));
  const seafaring = choices.filter(isSeafaringScenario);
  const current = choices.find((scenario) => scenario.id === scenarioId) ?? choices[0];
  const selected = current?.modules ?? ['base'];
  return (
    <div className="scenario-picker">
      <label>
        {t('lobby:scenario')}
        <select
          value={current?.id ?? ''}
          disabled={disabled}
          onChange={(event) => {
            const next = scenarioById(event.target.value);
            if (next) onScenario(next);
          }}
        >
          {seafaring.length === 0
            ? classic.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {t(`lobby:${scenario.titleKey}`)}
                </option>
              ))
            : [
                { key: 'classic', label: t('lobby:scenarioGroupClassic'), items: classic },
                { key: 'seafaring', label: t('lobby:scenarioGroupSeafaring'), items: seafaring },
              ]
                .filter((group) => group.items.length > 0)
                .map((group) => (
                  <optgroup key={group.key} label={group.label}>
                    {group.items.map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        {t(`lobby:${scenario.titleKey}`)}
                      </option>
                    ))}
                  </optgroup>
                ))}
        </select>
      </label>
      {current && <p className="muted scenario-about">{t(`lobby:${current.aboutKey}`)}</p>}
      <fieldset className="expansion-list">
        <legend>{t('lobby:expansions')}</legend>
        {EXPANSION_IDS.map((id) => {
          const state = expansionState(id, selected);
          // Only five-six is a switch. Other expansions arrive with their scenarios.
          const viaScenario = id !== 'five-six';
          const reason =
            state.kind === 'unavailable'
              ? state.reason === 'later'
                ? t('lobby:expansionLater')
                : t('lobby:expansionConflict', { module: t(`lobby:expansion_${state.with ?? ''}`) })
              : id === 'five-six'
                ? t('lobby:expansionFiveSixSeats')
                : state.kind === 'available'
                  ? t(
                      classicOnly || unplayable.has(id)
                        ? 'lobby:expansionLater'
                        : 'lobby:expansionViaScenario',
                    )
                  : '';
          return (
            <label className="checkbox-row" key={id} data-expansion={id}>
              <input
                type="checkbox"
                checked={state.kind === 'selected'}
                disabled={disabled || state.kind === 'unavailable' || viaScenario}
                onChange={(event) => {
                  if (id === 'five-six') onSeatCount(event.target.checked ? 5 : 4);
                }}
              />
              <span>
                {t(`lobby:expansion_${id}`)}
                {reason && <small className="muted"> — {reason}</small>}
              </span>
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}

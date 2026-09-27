import { fromBase64Url, toBase64Url, toHex } from '@cp2p/codec';
import { baseModule } from '@cp2p/engine';
import type { GameConfig, OptionSpec, Result, TurnTimer } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import type { GenesisSeedMode } from '@cp2p/protocol';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const rules = baseModule();
const seats = [0, 1, 2, 3] as const;
const defaultTimer: TurnTimer = { preRollSec: 60, mainSec: 180, discardSec: 60, robberSec: 60 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The parent keys this form by the signed configuration, so external edits replace its draft. */
export function OnlineConfiguration({
  config,
  seedMode,
  editable,
  onSave,
}: {
  config: GameConfig;
  seedMode: GenesisSeedMode;
  editable: boolean;
  onSave: (config: GameConfig, seed: GenesisSeedMode) => Result<void>;
}) {
  const { t } = useTranslation('lobby');
  const [seatCount, setSeatCount] = useState(config.seats.length);
  const [options, setOptions] = useState<Record<string, unknown>>(() => ({
    ...Object.fromEntries(rules.optionsSchema.map((spec) => [spec.key, spec.default])),
    ...(isRecord(config.options.base) ? config.options.base : {}),
  }));
  const [fixedSeed, setFixedSeed] = useState(seedMode.kind === 'fixed');
  const [seedHex, setSeedHex] = useState(() =>
    seedMode.kind === 'fixed' ? toHex(fromBase64Url(seedMode.seed)) : '',
  );
  const [error, setError] = useState(false);
  const labels: Record<string, string> = {
    vpTarget: t('lobby:vpTarget'),
    discardLimit: t('lobby:discardLimit'),
    friendlyRobber: t('lobby:friendlyRobber'),
    mapLayout: t('lobby:mapLayout'),
    strictBalance: t('lobby:strictBalance'),
    playerTrades: t('lobby:playerTrades'),
    diceMode: t('lobby:diceMode'),
    turnTimer: t('lobby:turnTimer'),
    hideBankCounts: t('lobby:hideBankCounts'),
  };
  const enumLabels: Record<string, Record<string, string>> = {
    mapLayout: {
      'standard-fixed': t('lobby:mapFixed'),
      random: t('lobby:mapRandom'),
      'balanced-random': t('lobby:mapBalanced'),
    },
    diceMode: { random: t('lobby:diceRandom'), balanced: t('lobby:diceBalanced') },
  };
  const patch = (key: string, value: unknown) => {
    setOptions((current) => ({ ...current, [key]: value }));
    setError(false);
  };

  return (
    <section className="online-section" aria-labelledby="online-config-title">
      <div className="section-heading">
        <h2 id="online-config-title">{t('lobby:onlineGameSettings')}</h2>
        <span className="muted">{t('lobby:onlineBaseGame')}</span>
      </div>
      <p className="muted">
        {editable ? t('lobby:onlineSettingsReadyReset') : t('lobby:onlineSettingsReadOnly')}
      </p>
      <form
        className="online-rules-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!editable) return;
          if (fixedSeed && !/^[0-9a-f]{64}$/i.test(seedHex)) {
            setError(true);
            return;
          }
          const selectedSeed: GenesisSeedMode = fixedSeed
            ? {
                kind: 'fixed',
                seed: toBase64Url(
                  Uint8Array.from(seedHex.match(/.{2}/g) ?? [], (pair) =>
                    Number.parseInt(pair, 16),
                  ),
                ),
              }
            : { kind: 'joint' };
          const { board: previousBoard, ...previous } = config;
          const next: GameConfig = {
            ...previous,
            seats: seats.slice(0, seatCount),
            options: { ...config.options, base: options },
            ...(options.mapLayout === 'standard-fixed'
              ? { board: previousBoard ?? standardFixedBoard() }
              : {}),
          };
          setError(!onSave(next, selectedSeed).ok);
        }}
      >
        <fieldset disabled={!editable} className="online-rule-fields">
          <legend className="sr-only">{t('lobby:boardAndRules')}</legend>
          <label>
            {t('lobby:playerCount')}
            <select
              value={seatCount}
              onChange={(event) => setSeatCount(Number(event.target.value))}
            >
              {[2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          {rules.optionsSchema.map((spec) => (
            <RuleField
              key={spec.key}
              spec={spec}
              label={labels[spec.key] ?? spec.key}
              value={options[spec.key]}
              enumLabels={enumLabels[spec.key] ?? {}}
              disabled={spec.key === 'strictBalance' && options.mapLayout === 'standard-fixed'}
              onChange={(value) => patch(spec.key, value)}
            />
          ))}
          <div className="online-seed-fields">
            <label>
              {t('lobby:onlineBoardSeed')}
              <select
                value={fixedSeed ? 'fixed' : 'joint'}
                onChange={(event) => setFixedSeed(event.target.value === 'fixed')}
              >
                <option value="joint">{t('lobby:onlineSeedJoint')}</option>
                <option value="fixed">{t('lobby:onlineSeedFixed')}</option>
              </select>
            </label>
            {fixedSeed && (
              <div>
                <label>
                  {t('lobby:onlineSeedValue')}
                  <input
                    required
                    value={seedHex}
                    pattern="[0-9a-fA-F]{64}"
                    minLength={64}
                    maxLength={64}
                    spellCheck={false}
                    autoCapitalize="off"
                    aria-describedby="online-seed-hint"
                    onChange={(event) => setSeedHex(event.target.value.trim())}
                  />
                </label>
                <small id="online-seed-hint" className="muted">
                  {t('lobby:onlineSeedHint')}
                </small>
              </div>
            )}
          </div>
        </fieldset>
        {error && <p role="alert">{t('lobby:onlineActionFailed')}</p>}
        {editable && (
          <button className="button button-quiet" type="submit">
            {t('lobby:onlineSaveSettings')}
          </button>
        )}
      </form>
    </section>
  );
}

function RuleField({
  spec,
  label,
  value,
  enumLabels,
  disabled,
  onChange,
}: {
  spec: OptionSpec;
  label: string;
  value: unknown;
  enumLabels: Record<string, string>;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  if (spec.type === 'object' && spec.key === 'turnTimer')
    return <TimerFields label={label} value={value} onChange={onChange} />;
  if (spec.type === 'boolean')
    return (
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
    );
  if (spec.type === 'enum')
    return (
      <label>
        {label}
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        >
          {spec.values?.map((choice) => (
            <option key={choice} value={choice}>
              {enumLabels[choice] ?? choice}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <label>
      {label}
      <input
        required
        type={spec.type === 'integer' ? 'number' : 'text'}
        min={spec.min}
        max={spec.max}
        step={spec.type === 'integer' ? 1 : undefined}
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        onChange={(event) =>
          onChange(
            spec.type === 'integer' && event.target.value !== ''
              ? event.target.valueAsNumber
              : event.target.value,
          )
        }
      />
    </label>
  );
}

function TimerFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation('lobby');
  const timer = isRecord(value) ? value : null;
  const fields = [
    { key: 'preRollSec', label: t('lobby:preRollSeconds') },
    { key: 'mainSec', label: t('lobby:mainSeconds') },
    { key: 'discardSec', label: t('lobby:discardSeconds') },
    { key: 'robberSec', label: t('lobby:robberSeconds') },
  ];
  return (
    <div className="online-timer-fields">
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={timer !== null}
          onChange={(event) => onChange(event.target.checked ? { ...defaultTimer } : null)}
        />
        <span>{label}</span>
      </label>
      {timer && (
        <div className="form-grid">
          {fields.map((field) => {
            const seconds = timer[field.key];
            return (
              <label key={field.key}>
                {field.label}
                <input
                  type="number"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  required
                  value={typeof seconds === 'number' ? seconds : ''}
                  onChange={(event) =>
                    onChange({
                      ...timer,
                      [field.key]: event.target.value === '' ? '' : event.target.valueAsNumber,
                    })
                  }
                />
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

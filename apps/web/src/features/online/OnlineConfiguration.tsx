import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { baseModule } from '@cp2p/engine';
import type { GameConfig, OptionSpec, Result, TurnTimer } from '@cp2p/engine';
import {
  defaultScenario,
  scenarioById,
  scenarioConfig,
  scenarioOfConfig,
  scenariosForSeats,
  standardFixedBoard,
} from '@cp2p/maps';
import type { GenesisSeedMode, TakeoverPolicy } from '@cp2p/protocol';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_PLAYERS, MIN_PLAYERS, modulesForSeatCount } from '../players/identity';
import { ScenarioPicker, isExpansionScenario } from '../setup/ScenarioPicker';

const rules = baseModule();
const seats = [0, 1, 2, 3, 4, 5] as const;
const PLAYER_COUNTS = Array.from(
  { length: MAX_PLAYERS - MIN_PLAYERS + 1 },
  (_, index) => MIN_PLAYERS + index,
);
const defaultTimer: TurnTimer = { preRollSec: 60, mainSec: 180, discardSec: 60, robberSec: 60 };
const SAVE_DELAY_MS = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function initialOptions(config: GameConfig): Record<string, unknown> {
  return {
    ...Object.fromEntries(rules.optionsSchema.map((spec) => [spec.key, spec.default])),
    ...(isRecord(config.options.base) ? config.options.base : {}),
  };
}

/**
 * The expansion scenario (seafaring, or knights and commerce) a signed configuration was built
 * from, or null for a classic game. Such a scenario brings its own modules and options.
 */
function seafaringIdOf(config: GameConfig): string | null {
  const scenario = scenarioOfConfig(config);
  return scenario && isExpansionScenario(scenario) ? scenario.id : null;
}

/** Keep a newer local draft when an earlier signed configuration arrives. */
export function OnlineConfiguration({
  config,
  seedMode,
  takeover,
  humanCount,
  editable,
  onSave,
  onPendingChange,
}: {
  config: GameConfig;
  seedMode: GenesisSeedMode;
  takeover: TakeoverPolicy;
  humanCount: number;
  editable: boolean;
  onSave: (config: GameConfig, seed: GenesisSeedMode, takeover: TakeoverPolicy) => Result<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { t } = useTranslation('lobby');
  const [seatCount, setSeatCount] = useState(config.seats.length);
  const [options, setOptions] = useState<Record<string, unknown>>(() => initialOptions(config));
  const [seafaringId, setSeafaringId] = useState(() => seafaringIdOf(config));
  const [fixedSeed, setFixedSeed] = useState(seedMode.kind === 'fixed');
  const [takeoverDraft, setTakeoverDraft] = useState<TakeoverPolicy>(takeover);
  const [seedHex, setSeedHex] = useState(() =>
    seedMode.kind === 'fixed' ? toHex(fromBase64Url(seedMode.seed)) : '',
  );
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const baseline = useRef(
    JSON.stringify([seatCount, options, seafaringId, fixedSeed, seedHex, takeoverDraft]),
  );
  const externalKey = toHex(hashValue([config, seedMode, takeover]));
  const previousExternal = useRef(externalKey);
  const latestSubmitted = useRef<{ revision: number; key: string } | null>(null);
  const currentConfig = useRef(config);
  const save = useRef(onSave);
  const pendingChange = useRef(onPendingChange);
  currentConfig.current = config;
  save.current = onSave;
  pendingChange.current = onPendingChange;

  useEffect(() => {
    pendingChange.current?.(revision !== 0);
  }, [revision]);
  useEffect(() => () => pendingChange.current?.(false), []);

  useEffect(() => {
    if (previousExternal.current === externalKey) return;
    previousExternal.current = externalKey;
    if (
      revision !== 0 &&
      (latestSubmitted.current?.revision !== revision ||
        latestSubmitted.current.key !== externalKey)
    )
      return;
    setSeatCount(config.seats.length);
    setOptions(initialOptions(config));
    setSeafaringId(seafaringIdOf(config));
    setFixedSeed(seedMode.kind === 'fixed');
    setTakeoverDraft(takeover);
    setSeedHex(seedMode.kind === 'fixed' ? toHex(fromBase64Url(seedMode.seed)) : '');
    baseline.current = JSON.stringify([
      config.seats.length,
      initialOptions(config),
      seafaringIdOf(config),
      seedMode.kind === 'fixed',
      seedMode.kind === 'fixed' ? toHex(fromBase64Url(seedMode.seed)) : '',
      takeover,
    ]);
    setRevision(0);
    setError(false);
    latestSubmitted.current = null;
  }, [externalKey, config, seedMode, takeover, revision]);

  useEffect(() => {
    if (!editable || revision === 0) return undefined;
    if (
      !latestSubmitted.current &&
      JSON.stringify([seatCount, options, seafaringId, fixedSeed, seedHex, takeoverDraft]) ===
        baseline.current
    ) {
      setRevision(0);
      return undefined;
    }
    if (fixedSeed && !/^[0-9a-f]{64}$/i.test(seedHex)) {
      setError(true);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      const selectedSeed: GenesisSeedMode = fixedSeed
        ? {
            kind: 'fixed',
            seed: toBase64Url(
              Uint8Array.from(seedHex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16)),
            ),
          }
        : { kind: 'joint' };
      const { board: previousBoard, ...previous } = currentConfig.current;
      const seafaring = seafaringId === null ? undefined : scenarioById(seafaringId);
      const modules = modulesForSeatCount(seatCount);
      const fixed = options.mapLayout === 'standard-fixed' && seatCount <= 4;
      const moduleOptions = Object.fromEntries(
        modules.map(({ id }) => [
          id,
          id === 'base'
            ? {
                ...options,
                ...(fixed || options.mapLayout !== 'standard-fixed'
                  ? {}
                  : { mapLayout: 'balanced-random' }),
              }
            : (currentConfig.current.options[id] ?? {}),
        ]),
      );
      // An expansion scenario brings its own modules, options and board, beside the base rules.
      const next: GameConfig = seafaring
        ? scenarioConfig(seafaring, seatCount, { base: { ...options } })
        : {
            ...previous,
            modules,
            seats: seats.slice(0, seatCount),
            options: moduleOptions,
            ...(fixed ? { board: previousBoard ?? standardFixedBoard() } : {}),
          };
      const key = toHex(hashValue([next, selectedSeed, takeoverDraft]));
      const draftKey = JSON.stringify([
        seatCount,
        options,
        seafaringId,
        fixedSeed,
        seedHex.toLowerCase(),
        takeoverDraft,
      ]);
      if (key === externalKey || draftKey === baseline.current) {
        baseline.current = draftKey;
        latestSubmitted.current = null;
        setRevision(0);
        setError(false);
        return;
      }
      latestSubmitted.current = { revision, key };
      const result = save.current(next, selectedSeed, takeoverDraft);
      if (!result.ok) latestSubmitted.current = null;
      setError(!result.ok);
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    editable,
    externalKey,
    fixedSeed,
    options,
    revision,
    seafaringId,
    seatCount,
    seedHex,
    takeoverDraft,
  ]);

  const changed = () => {
    setRevision((current) => current + 1);
    setError(false);
    pendingChange.current?.(true);
  };
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
      random: t('lobby:mapRandom'),
      'balanced-random': t('lobby:mapBalanced'),
    },
    diceMode: { random: t('lobby:diceRandom'), balanced: t('lobby:diceBalanced') },
  };
  const patch = (key: string, value: unknown) => {
    setOptions((current) => ({ ...current, [key]: value }));
    changed();
  };
  const fixedScenario = options.mapLayout === 'standard-fixed' && seatCount <= 4;
  // A seafaring board is fixed; a knights scenario keeps the classic generated map and its choice.
  const pickedBoardFixed =
    seafaringId !== null && scenarioById(seafaringId)?.board.kind === 'fixed';
  const scenarioId =
    seafaringId ??
    (fixedScenario
      ? (scenarioById('standard-fixed')?.id ?? 'standard-fixed')
      : defaultScenario(seatCount).id);
  const changeSeats = (count: number) => {
    setSeatCount(count);
    const seafaring = seafaringId === null ? undefined : scenarioById(seafaringId);
    // Knights and commerce follows the seat count into its five-six scenario, and back.
    const sibling = seafaring?.modules.includes('knights')
      ? scenariosForSeats(count).find((scenario) => scenario.modules.includes('knights'))
      : undefined;
    if (seafaring && sibling) {
      setSeafaringId(sibling.id);
      if (count > 4 && options.mapLayout === 'standard-fixed')
        setOptions((current) => ({ ...current, mapLayout: 'balanced-random' }));
    } else if (seafaring && (count < seafaring.seats.min || count > seafaring.seats.max)) {
      // The seafaring board does not fit this seat count: fall back to the classic default.
      setSeafaringId(null);
      setOptions((current) => ({
        ...current,
        vpTarget: defaultScenario(count).vpTarget,
        mapLayout: 'balanced-random',
      }));
    } else if (count > 4 && options.mapLayout === 'standard-fixed')
      setOptions((current) => ({ ...current, mapLayout: 'balanced-random' }));
    changed();
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
      <form className="online-rules-form" onSubmit={(event) => event.preventDefault()}>
        <fieldset disabled={!editable} className="online-rule-fields">
          <legend className="sr-only">{t('lobby:boardAndRules')}</legend>
          <label>
            {t('lobby:playerCount')}
            <select value={seatCount} onChange={(event) => changeSeats(Number(event.target.value))}>
              {PLAYER_COUNTS.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <ScenarioPicker
            seatCount={seatCount}
            scenarioId={scenarioId}
            allowKnights
            disabled={!editable}
            onScenario={(scenario) => {
              const wasSeafaring = seafaringId !== null;
              if (isExpansionScenario(scenario)) {
                // The scenario's own board and victory target replace the classic map choice.
                setSeafaringId(scenario.id);
                setOptions((current) => ({
                  ...current,
                  vpTarget: scenario.vpTarget,
                  mapLayout:
                    scenario.board.kind === 'fixed' || current.mapLayout === 'standard-fixed'
                      ? 'balanced-random'
                      : current.mapLayout,
                }));
                changed();
                return;
              }
              setSeafaringId(null);
              if (wasSeafaring) patch('vpTarget', scenario.vpTarget);
              if (scenario.board.kind === 'fixed') patch('mapLayout', 'standard-fixed');
              else if (options.mapLayout === 'standard-fixed' || wasSeafaring)
                patch('mapLayout', 'balanced-random');
            }}
            onSeatCount={changeSeats}
          />
          {rules.optionsSchema
            .filter((spec) => spec.key !== 'mapLayout' || (!fixedScenario && !pickedBoardFixed))
            .map((spec) => (
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
                onChange={(event) => {
                  setFixedSeed(event.target.value === 'fixed');
                  changed();
                }}
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
                    onChange={(event) => {
                      setSeedHex(event.target.value.trim());
                      changed();
                    }}
                  />
                </label>
                <small id="online-seed-hint" className="muted">
                  {t('lobby:onlineSeedHint')}
                </small>
              </div>
            )}
          </div>
          <div className="online-takeover-fields">
            <label>
              {t('lobby:onlineTakeoverDelay')}
              <select
                value={takeoverDraft.afterSeconds}
                onChange={(event) => {
                  const delay = event.target.value;
                  setTakeoverDraft(
                    delay === 'never'
                      ? { mode: 'vote', afterSeconds: 'never' }
                      : { mode: takeoverDraft.mode, afterSeconds: Number(delay) },
                  );
                  changed();
                }}
              >
                <option value="never">{t('lobby:onlineTakeoverNever')}</option>
                {[30, 60, 120, 300].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {t('lobby:onlineTakeoverSeconds', { count: seconds })}
                  </option>
                ))}
              </select>
            </label>
            {takeoverDraft.afterSeconds !== 'never' && (
              <label>
                {t('lobby:onlineTakeoverMode')}
                <select
                  value={takeoverDraft.mode}
                  onChange={(event) => {
                    setTakeoverDraft({
                      mode: event.target.value === 'auto' ? 'auto' : 'vote',
                      afterSeconds: takeoverDraft.afterSeconds,
                    });
                    changed();
                  }}
                >
                  <option value="vote">{t('lobby:onlineTakeoverVote')}</option>
                  <option value="auto">{t('lobby:onlineTakeoverAuto')}</option>
                </select>
              </label>
            )}
          </div>
        </fieldset>
        <p className="muted">{t('lobby:onlineTakeoverDisclosure')}</p>
        {humanCount < 4 && <p className="muted">{t('lobby:onlineTakeoverFourHumans')}</p>}
        {error && <p role="alert">{t('lobby:onlineActionFailed')}</p>}
        {editable && revision > 0 && !error && (
          <small role="status">{t('lobby:onlineSaving')}</small>
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
          {spec.values
            ?.filter(
              (choice) => Object.hasOwn(enumLabels, choice) || Object.keys(enumLabels).length === 0,
            )
            .map((choice) => (
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

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommandShape, Seat } from '@cp2p/engine';
import { getDieUrl, getRedDieUrl } from '@cp2p/renderer';
import { DialogFrame } from '../../dialogs/DialogFrame.js';
import { emptyCounts, resourceLabel } from '../../dialogs/resources.js';
import type { CommandFormProps } from '../../dialogs/types.js';
import { useCommandValidations } from '../../dialogs/use-command-validation.js';
import { ValidationChecking } from '../../dialogs/ValidationChecking.js';
import { LocalSession } from '../../../session/local-session.js';
import { sessionForActions } from '../../../store/session-store.js';
import { ResourceCardPicker } from '../../trade/ResourceCard.js';
import type { ActionAvailability } from '../../actions/availability.js';
import { cardInfo } from '../catalogue.js';
import { ProgressCardFace } from '../ProgressCardFace.js';
import { KindIcon } from './ChoiceDialogs.js';
import { TRACKS, cardKinds, knightsState } from '../state.js';
import '../knights.css';

function params(command: CommandShape): Record<string, unknown> {
  const value: unknown = command.params;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

interface Props extends CommandFormProps {
  availability: ActionAvailability;
  slotId: string;
  onCancel: () => void;
}

/**
 * Playing a progress card: the card face and what it does, then the choice its play needs (dice,
 * a track, a kind of card, a rival), then a confirmation. Cards that are aimed at the board are
 * started from the hand instead and never open this dialog.
 */
export function PlayCardDialog(props: Props) {
  const { availability, slotId, onSubmit, onCancel } = props;
  const { t } = useTranslation(['knights', 'rules']);
  const group = availability.progressPlays.find((item) => item.slotId === slotId);
  const card = group?.card ?? null;
  const commands = group?.commands ?? [];
  const info = card ? cardInfo(card) : null;
  const [chosen, setChosen] = useState<CommandShape | null>(null);
  const [dice, setDice] = useState<[number, number]>([3, 4]);
  const [target, setTarget] = useState<Seat | null>(null);
  const [look, setLook] = useState(false);
  const only = commands.length === 1 ? commands[0] : undefined;
  const command =
    chosen ??
    (info?.play === 'dice'
      ? commands.find((item) => {
          const shown = params(item).dice;
          return Array.isArray(shown) && shown[0] === dice[0] && shown[1] === dice[1];
        })
      : info?.play === 'confirm'
        ? only
        : undefined);
  const [validation] = useCommandValidations(command ? [command] : [], props);
  if (!group || !card || !info) return null;
  const title = t(`knights:cards.${card}.name`);
  const valid = command !== undefined && validation === 'valid';
  const play = (
    <button
      className="button button-primary"
      type="button"
      disabled={!valid}
      onClick={() => {
        if (valid && command) onSubmit(command);
      }}
    >
      {t('knights:card.play')}
    </button>
  );
  const footer = (
    <div className="trade-dialog-footer">
      <ValidationChecking checking={command !== undefined && validation === 'checking'} />
      <div className="trade-dialog-buttons">
        <button className="button button-quiet" type="button" onClick={onCancel}>
          {t('rules:action.cancel')}
        </button>
        {info.play === 'confirm' || info.play === 'dice' ? play : null}
      </div>
    </div>
  );

  // The look-and-take cards: see the rival's hand or progress cards, then take.
  if (look && target !== null && (card === 'masterMerchant' || card === 'spy'))
    return (
      <LookAndTake
        {...props}
        card={card}
        target={target}
        commands={commands}
        onBack={() => setLook(false)}
      />
    );

  return (
    <DialogFrame title={title} variant="trade" onCancel={onCancel} footer={footer}>
      <div className="play-card-body">
        <ProgressCardFace card={card} size="lg" />
        <div className="play-card-choices">
          {info.play === 'dice' && (
            <>
              <p>{t('knights:alchemist.instruction')}</p>
              <DicePicker
                label={t('knights:alchemist.red')}
                value={dice[0]}
                face={getRedDieUrl}
                onChange={(face) => setDice([face, dice[1]])}
              />
              <DicePicker
                label={t('knights:alchemist.yellow')}
                value={dice[1]}
                face={getDieUrl}
                onChange={(face) => setDice([dice[0], face])}
              />
              <p className="muted" aria-live="polite">
                {t('knights:alchemist.total', { count: dice[0] + dice[1] })}
              </p>
            </>
          )}
          {info.play === 'track' && (
            <div className="kind-choices" role="group" aria-label={t('knights:crane.choose')}>
              {TRACKS.flatMap((track) => {
                const found = commands.find((item) => params(item).track === track);
                return found
                  ? [
                      <button
                        key={track}
                        type="button"
                        className="kind-choice"
                        data-track={track}
                        aria-pressed={chosen === found}
                        onClick={() => setChosen(found)}
                      >
                        <span>{t(`knights:track.${track}`)}</span>
                        <small>
                          {t('knights:crane.next', {
                            level:
                              (knightsState(props.state)?.improvements[props.seat]?.[track] ?? 0) +
                              1,
                          })}
                        </small>
                      </button>,
                    ]
                  : [];
              })}
              {chosen && play}
            </div>
          )}
          {info.play === 'kind' && (
            <div className="kind-choices" role="group" aria-label={t('knights:kind.choose')}>
              {cardKinds(props.state).flatMap((kind) => {
                const found = commands.find((item) => params(item).kind === kind);
                return found
                  ? [
                      <button
                        key={kind}
                        type="button"
                        className="kind-choice kind-choice-small"
                        aria-pressed={chosen === found}
                        onClick={() => setChosen(found)}
                      >
                        <KindIcon kind={kind} />
                        <span>{resourceLabel(t, kind)}</span>
                      </button>,
                    ]
                  : [];
              })}
              {chosen && play}
            </div>
          )}
          {info.play === 'seat' && (
            <SeatChoice
              {...props}
              commands={commands}
              chosen={chosen}
              onChoose={(seat, next) => {
                setTarget(seat);
                setChosen(next);
              }}
              onLook={() => setLook(true)}
              lookable={card === 'masterMerchant' || card === 'spy'}
              play={play}
            />
          )}
        </div>
      </div>
    </DialogFrame>
  );
}

function DicePicker({
  label,
  value,
  face,
  onChange,
}: {
  label: string;
  value: number;
  face: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <fieldset className="dice-picker">
      <legend>{label}</legend>
      <div>
        {[1, 2, 3, 4, 5, 6].map((number) => (
          <button
            key={number}
            type="button"
            className="dice-picker-face"
            aria-pressed={value === number}
            aria-label={`${label} ${number}`}
            onClick={() => onChange(number)}
          >
            <img src={face(number)} alt="" aria-hidden="true" />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function SeatChoice({
  commands,
  chosen,
  onChoose,
  onLook,
  lookable,
  play,
  playerLabel,
  state,
}: Props & {
  commands: readonly CommandShape[];
  chosen: CommandShape | null;
  onChoose: (seat: Seat, command: CommandShape) => void;
  onLook: () => void;
  lookable: boolean;
  play: React.ReactNode;
}) {
  const { t } = useTranslation('knights');
  const seats = commands.flatMap((command) => {
    const seat = state.config.seats.find((candidate) => candidate === params(command).target);
    return seat === undefined ? [] : [{ seat, command }];
  });
  const session = sessionForActions();
  const local = session instanceof LocalSession;
  return (
    <>
      <p>{t('knights:seat.choose')}</p>
      <div className="kind-choices" role="group" aria-label={t('knights:seat.choose')}>
        {seats.map(({ seat, command }) => (
          <button
            key={seat}
            type="button"
            className="kind-choice kind-choice-small"
            aria-pressed={chosen === command}
            onClick={() => onChoose(seat, command)}
          >
            <span>{playerLabel(seat)}</span>
          </button>
        ))}
      </div>
      {chosen &&
        (lookable && local ? (
          <button className="button button-primary" type="button" onClick={onLook}>
            {t('knights:look.start')}
          </button>
        ) : (
          play
        ))}
    </>
  );
}

/** Master Merchant and the Spy: the rival shows its hand, and the player takes cards from it. */
function LookAndTake({
  card,
  target,
  commands,
  state,
  seat,
  playerLabel,
  onSubmit,
  onBack,
}: Props & {
  card: 'masterMerchant' | 'spy';
  target: Seat;
  commands: readonly CommandShape[];
  /** Back to the card's own dialog: nothing has been played yet. */
  onBack: () => void;
}) {
  const { t } = useTranslation(['knights', 'rules']);
  const session = sessionForActions();
  const command = commands.find((item) => params(item).target === target);
  const shown =
    session instanceof LocalSession
      ? session.peekHand(seat, target, card === 'spy' ? 'progress' : 'hand')
      : null;
  const kinds = cardKinds(state);
  const [taken, setTaken] = useState<Record<string, number>>(() => emptyCounts(kinds));
  const [progress, setProgress] = useState<string | null>(null);
  if (!command || !shown || !(session instanceof LocalSession)) return null;
  if ('progress' in shown) {
    const cards = Object.entries(shown.progress);
    return (
      <DialogFrame
        title={t('knights:spy.title', { player: playerLabel(target) })}
        variant="trade"
        onCancel={onBack}
      >
        <p>{cards.length ? t('knights:spy.instruction') : t('knights:spy.empty')}</p>
        <ul className="progress-pick">
          {cards.map(([slotId, id]) => (
            <li key={slotId}>
              <button
                type="button"
                className="progress-pick-card"
                aria-pressed={progress === slotId}
                aria-label={t(`knights:cards.${id}.name`)}
                onClick={() => setProgress(progress === slotId ? null : slotId)}
              >
                <ProgressCardFace card={id} size="md" />
              </button>
            </li>
          ))}
        </ul>
        <div className="trade-dialog-buttons">
          <button className="button button-quiet" type="button" onClick={onBack}>
            {t('rules:action.cancel')}
          </button>
          <button
            className="button button-primary"
            type="button"
            onClick={() => {
              session.preferTake({ progress: { slotId: progress } });
              onSubmit(command);
            }}
          >
            {progress ? t('knights:spy.take') : t('knights:spy.takeNothing')}
          </button>
        </div>
      </DialogFrame>
    );
  }
  const total = Object.values(shown.hand).reduce((sum, count) => sum + count, 0);
  const count = Math.min(2, total);
  const picked = kinds.reduce((sum, kind) => sum + (taken[kind] ?? 0), 0);
  return (
    <DialogFrame
      title={t('knights:masterMerchant.title', { player: playerLabel(target) })}
      variant="trade"
      onCancel={onBack}
      footer={
        <div className="trade-dialog-footer">
          <p aria-live="polite">{t('rules:discard.selected', { selected: picked, count })}</p>
          <div className="trade-dialog-buttons">
            <button className="button button-quiet" type="button" onClick={onBack}>
              {t('rules:action.cancel')}
            </button>
            <button
              className="button button-primary"
              type="button"
              disabled={picked !== count}
              onClick={() => {
                session.preferTake({ cards: taken });
                onSubmit(command);
              }}
            >
              {t('knights:masterMerchant.take')}
            </button>
          </div>
        </div>
      }
    >
      <p>{t('knights:masterMerchant.instruction', { count })}</p>
      <ResourceCardPicker
        label={t('knights:masterMerchant.cards', { player: playerLabel(target) })}
        values={taken}
        kinds={kinds}
        stock={{ source: 'hand', counts: shown.hand }}
        onChange={(kind, value) => {
          if (value < 0 || value > (shown.hand[kind] ?? 0)) return;
          if (picked - (taken[kind] ?? 0) + value > count) return;
          setTaken((current) => ({ ...current, [kind]: value }));
        }}
        onClear={() => setTaken(emptyCounts(kinds))}
      />
    </DialogFrame>
  );
}

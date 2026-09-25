import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardHighlights, BoardHit } from '@cp2p/renderer';
import type { EdgeId, HexId, VertexId } from '@cp2p/engine/geometry';
import type { CommandShape, GameState, Pending, Seat } from '@cp2p/engine';
import { deriveActionAvailability, type PlacementKind } from '../actions/availability';
import { DiscardDialog, MonopolyDialog, StealDialog, YearOfPlentyDialog } from '../dialogs';
import { BankTradePicker, IncomingOffers, TradeComposer } from '../trade';
import { sessionForActions, useSessionStore } from '../../store/session-store';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { recordOrdinaryActionRejection } from './action-diagnostics';

type FormKind = 'discard' | 'steal' | 'trade' | 'bank' | 'plenty' | 'monopoly';

const boardOrder: readonly PlacementKind[] = ['settlement', 'road', 'city', 'freeRoad', 'robber'];
const noChoices = [] as const;

function boardHitKind(kind: PlacementKind): BoardHit['kind'] {
  return kind === 'road' || kind === 'freeRoad' ? 'edge' : kind === 'robber' ? 'hex' : 'vertex';
}

function isEdgeId(id: string): id is EdgeId {
  return /^e:-?\d+,-?\d+,(NE|NW|W)$/.test(id);
}

function isVertexId(id: string): id is VertexId {
  return /^v:-?\d+,-?\d+,(N|S)$/.test(id);
}

function isHexId(id: string): id is HexId {
  return /^h:-?\d+,-?\d+$/.test(id);
}

function currentActor(state: GameState, pending: readonly Pending[]): Seat {
  const player = pending.find(
    (item) => item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );
  return player?.kind === 'player' ? player.seat : state.turn.activeSeat;
}

export interface GameActionController {
  actorSeat: Seat;
  availability: ReturnType<typeof deriveActionAvailability> | null;
  highlights: BoardHighlights;
  onBoardSelect(hit: BoardHit): void;
  targetLabel(hit: BoardHit): string;
  dock: React.ReactNode;
}

/** The controller only offers engine-provided commands and checks the live revision on submission. */
export function useGameActions(
  state: GameState,
  pending: readonly Pending[],
  presentation: GamePresentation,
): GameActionController {
  const { t } = useTranslation('game');
  const seat = useSessionStore((store) => store.revealedSeat);
  const priv = useSessionStore((store) => store.privateState);
  const legal = useSessionStore((store) => store.legal);
  const status = useSessionStore((store) => store.status);
  const revision = useSessionStore((store) => store.revision);
  const [boardKind, setBoardKind] = useState<PlacementKind | null>(null);
  const [boardCancelled, setBoardCancelled] = useState(false);
  const [form, setForm] = useState<FormKind | null>(null);
  const [slotId, setSlotId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const actorSeat = currentActor(state, pending);
  const availability = useMemo(
    () => (seat !== null && legal ? deriveActionAvailability(legal, pending, seat) : null),
    [legal, pending, seat],
  );
  const availableBoardKinds = boardOrder.filter((kind) => availability?.placements[kind].length);
  const selectedKind = boardCancelled
    ? undefined
    : boardKind && availableBoardKinds.includes(boardKind)
      ? boardKind
      : availableBoardKinds[0];
  const choices = selectedKind && availability ? availability.placements[selectedKind] : noChoices;
  const hitKind = selectedKind ? boardHitKind(selectedKind) : null;
  const highlights: BoardHighlights = useMemo(() => {
    if (!hitKind) return {};
    return {
      ...(hitKind === 'edge' ? { edges: choices.map((choice) => choice.id).filter(isEdgeId) } : {}),
      ...(hitKind === 'vertex'
        ? { vertices: choices.map((choice) => choice.id).filter(isVertexId) }
        : {}),
      ...(hitKind === 'hex' ? { hexes: choices.map((choice) => choice.id).filter(isHexId) } : {}),
      mode: hitKind,
      style: { color: 0x61b89a, pulse: true },
    };
  }, [choices, hitKind]);
  const playerLabel = (candidate: Seat) =>
    presentation.players.find((player) => player.seat === candidate)?.name ??
    t('game:playerFallback', { number: candidate + 1 });

  const submit = (command: CommandShape) => {
    if (seat === null || submitting.current) return;
    const session = sessionForActions();
    const latest = useSessionStore.getState();
    if (!session || latest.revision !== revision || latest.revealedSeat !== seat) {
      setError(t('game:staleAction'));
      return;
    }
    const validated = session.validate(seat, command);
    if (!validated.ok) {
      recordOrdinaryActionRejection();
      setError(t('game:invalidAction'));
      return;
    }
    submitting.current = true;
    setError(null);
    void (async () => {
      try {
        const result = await session.submit(seat, command, { expectedRevision: revision });
        if (result.ok) {
          setForm(null);
          setSlotId(undefined);
        } else {
          recordOrdinaryActionRejection();
          setError(
            t(result.error.code === 'stale-revision' ? 'game:staleAction' : 'game:invalidAction'),
          );
        }
      } catch {
        recordOrdinaryActionRejection();
        setError(t('game:invalidAction'));
      } finally {
        submitting.current = false;
      }
    })();
  };
  useEffect(() => setBoardCancelled(false), [revision]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (seat === null || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
      )
        return;
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        setBoardCancelled(true);
        setForm(null);
        return;
      }
      const shortcuts: Record<string, PlacementKind> = {
        '1': 'road',
        '2': 'settlement',
        '3': 'city',
      };
      const kind = shortcuts[event.key];
      if (kind && availableBoardKinds.includes(kind)) {
        setBoardKind(kind);
        setBoardCancelled(false);
        event.preventDefault();
        return;
      }
      const commandType =
        event.key.toLowerCase() === 'r'
          ? 'ROLL_DICE'
          : event.key.toLowerCase() === 'e'
            ? 'END_TURN'
            : null;
      const command = availability?.primary.find((group) => group.type === commandType)
        ?.commands[0];
      if (command) {
        event.preventDefault();
        submit(command);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  const onBoardSelect = (hit: BoardHit) => {
    if (hit.kind !== hitKind) return;
    const choice = choices.find((item) => item.id === hit.id);
    if (choice) submit(choice.command);
  };
  const targetLabel = (hit: BoardHit) => {
    const number = choices.findIndex((item) => item.id === hit.id) + 1;
    return t('game:targetOption', {
      action: t(`game:placement.${selectedKind ?? 'road'}`),
      number,
    });
  };

  const formProps =
    seat !== null && priv && legal
      ? {
          legal,
          privateState: priv,
          state,
          seat,
          playerLabel,
          validate: (command: CommandShape) =>
            sessionForActions()?.validate(seat, command) ?? {
              ok: false as const,
              error: { code: 'session-inactive', message: 'Session unavailable' },
            },
          onSubmit: submit,
          onCancel: () => setForm(null),
        }
      : null;
  const forcedForm = availability?.availableTypes.includes('DISCARD')
    ? 'discard'
    : availability?.availableTypes.includes('STEAL')
      ? 'steal'
      : null;
  const visibleForm = forcedForm ?? form;
  const cardPlays = availability?.cardPlays ?? [];
  const primary = availability?.primary ?? [];

  const dock = (
    <section className="action-dock" aria-label={t('game:actions')}>
      <h2>{t('game:actions')}</h2>
      {status?.kind === 'error' ? (
        <p role="alert">{t('game:sessionStopped')}</p>
      ) : seat === null || !availability ? (
        <p className="muted">{t('game:awaitingAction')}</p>
      ) : (
        <>
          {availableBoardKinds.length > 0 && (
            <>
              <p>
                {selectedKind
                  ? t('game:boardInstruction', { action: t(`game:placement.${selectedKind}`) })
                  : t('game:chooseBoardAction')}
              </p>
              <div className="action-row" role="group" aria-label={t('game:chooseBoardAction')}>
                {availableBoardKinds.map((kind) => (
                  <button
                    className={`button ${selectedKind === kind ? 'button-primary' : 'button-quiet'}`}
                    type="button"
                    key={kind}
                    aria-pressed={selectedKind === kind}
                    onClick={() => {
                      setBoardKind(kind);
                      setBoardCancelled(false);
                    }}
                  >
                    {t(`game:placement.${kind}`)}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="action-row">
            {primary.flatMap((group) => {
              if (
                ['RESPOND_TRADE', 'CANCEL_TRADE', 'CONFIRM_TRADE', 'STEAL', 'DISCARD'].includes(
                  group.type,
                )
              )
                return [];
              if (group.type === 'OFFER_TRADE' || group.type === 'PROPOSE_TRADE')
                return [
                  <button
                    className="button button-quiet"
                    type="button"
                    key={group.type}
                    onClick={() => setForm('trade')}
                  >
                    {t('game:command.trade')}
                  </button>,
                ];
              if (group.type === 'MARITIME_TRADE')
                return [
                  <button
                    className="button button-quiet"
                    type="button"
                    key={group.type}
                    onClick={() => setForm('bank')}
                  >
                    {t('game:command.bank')}
                  </button>,
                ];
              return group.commands.map((command, index) => (
                <button
                  className="button button-quiet"
                  type="button"
                  key={`${group.type}:${index}`}
                  onClick={() => submit(command)}
                >
                  {t(`game:command.${group.type}`)}
                </button>
              ));
            })}
            {cardPlays.map((card) => {
              const cardKind = card.card ?? priv?.slots[card.slotId] ?? 'Hidden';
              return (
                <button
                  className="button button-quiet"
                  type="button"
                  key={card.slotId}
                  onClick={() => {
                    if (cardKind === 'yearOfPlenty') {
                      setSlotId(card.slotId);
                      setForm('plenty');
                    } else if (cardKind === 'monopoly') {
                      setSlotId(card.slotId);
                      setForm('monopoly');
                    } else if (card.commands[0]) submit(card.commands[0]);
                  }}
                >
                  {t('game:playCard', { card: t(`game:dev${cardKind}`) })}
                </button>
              );
            })}
          </div>
          {formProps && <IncomingOffers {...formProps} />}
          {formProps && visibleForm === 'discard' && <DiscardDialog {...formProps} />}
          {formProps && visibleForm === 'steal' && <StealDialog {...formProps} />}
          {formProps && visibleForm === 'trade' && <TradeComposer {...formProps} />}
          {formProps && visibleForm === 'bank' && <BankTradePicker {...formProps} />}
          {formProps && visibleForm === 'plenty' && (
            <YearOfPlentyDialog {...formProps} {...(slotId ? { slotId } : {})} />
          )}
          {formProps && visibleForm === 'monopoly' && (
            <MonopolyDialog {...formProps} {...(slotId ? { slotId } : {})} />
          )}
        </>
      )}
      {error && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );

  return { actorSeat, availability, highlights, onBoardSelect, targetLabel, dock };
}

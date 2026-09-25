import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardHighlights, BoardHit } from '@cp2p/renderer';
import type { EdgeId, HexId, VertexId } from '@cp2p/engine/geometry';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import {
  RESOURCES,
  type CommandShape,
  type GameState,
  type Pending,
  type Seat,
} from '@cp2p/engine';
import { deriveActionAvailability, type PlacementKind } from '../actions/availability';
import { DiscardDialog, MonopolyDialog, StealDialog, YearOfPlentyDialog } from '../dialogs';
import { BankTradePicker, IncomingOffers, TradeComposer } from '../trade';
import {
  sessionForActions,
  useSessionStore,
  type PlacementCandidate,
} from '../../store/session-store';
import { actingSeat } from '../../store/pending-actors';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { recordOrdinaryActionRejection } from './action-diagnostics';

const boardOrder: readonly PlacementKind[] = ['settlement', 'road', 'city', 'freeRoad', 'robber'];
const noChoices = [] as const;
const closeForm = () => useSessionStore.getState().closeActionDialog();

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

function placementHit(candidate: PlacementCandidate): BoardHit {
  switch (candidate.kind) {
    case 'road':
    case 'freeRoad':
      return { kind: 'edge', id: candidate.id };
    case 'settlement':
    case 'city':
      return { kind: 'vertex', id: candidate.id };
    default:
      throw new Error('Unsupported placement candidate');
  }
}

export interface GameActionController {
  actorSeat: Seat;
  availability: ReturnType<typeof deriveActionAvailability> | null;
  highlights: BoardHighlights;
  focusTarget: BoardHit | null;
  placementConfirmation: {
    piece: 'road' | 'settlement' | 'city';
    hit: BoardHit;
    label: string;
    confirm: () => void;
    cancel: () => void;
  } | null;
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
  const conflicted = useSessionStore((store) => store.conflicted);
  const revision = useSessionStore((store) => store.revision);
  const boardKind = useSessionStore((store) => store.placementMode);
  const boardCancelled = useSessionStore((store) => store.placementCancelled);
  const previewPlacement = useSessionStore((store) => store.previewPlacement);
  const form = useSessionStore((store) => store.openDialog);
  const slotId = useSessionStore((store) => store.selectedCardSlot);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const actorSeat = actingSeat(state, pending);
  const availability = useMemo(
    () => (seat !== null && legal ? deriveActionAvailability(legal, pending, seat) : null),
    [legal, pending, seat],
  );
  const graph = useMemo(() => buildBoardGraph(state.board.hexes), [state.board.hexes]);
  const availableBoardKinds = boardOrder.filter((kind) => availability?.placements[kind].length);
  const phase = state.turn.phase.at(-1)?.id;
  const mandatoryPlacement =
    phase === 'setup' || phase === 'roadBuilding' || phase === 'moveRobber';
  const selectedKind = boardCancelled
    ? undefined
    : boardKind && availableBoardKinds.includes(boardKind)
      ? boardKind
      : mandatoryPlacement
        ? availableBoardKinds[0]
        : undefined;
  const choices = selectedKind && availability ? availability.placements[selectedKind] : noChoices;
  const selectedPlacement =
    selectedKind && previewPlacement?.kind === selectedKind
      ? choices.find((choice) => choice.id === previewPlacement.id)
      : undefined;
  const focusTarget: BoardHit | null =
    selectedPlacement && previewPlacement ? placementHit(previewPlacement) : null;
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
      style: {
        color: 0x61b89a,
        pulse: true,
        ...(selectedKind === 'settlement'
          ? { vertexTarget: 'site' as const }
          : selectedKind === 'city'
            ? { vertexTarget: 'upgrade' as const }
            : {}),
      },
    };
  }, [choices, hitKind, selectedKind]);
  const playerLabel = (candidate: Seat) =>
    presentation.players.find((player) => player.seat === candidate)?.name ??
    t('game:playerFallback', { number: candidate + 1 });

  const submit = (command: CommandShape) => {
    if (seat === null || submitting.current) return;
    const session = sessionForActions();
    const latest = useSessionStore.getState();
    if (
      !session ||
      latest.conflicted ||
      latest.revision !== revision ||
      latest.revealedSeat !== seat
    ) {
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
          useSessionStore.getState().closeActionDialog();
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
  useEffect(() => setError(null), [seat, phase]);
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
        if (previewPlacement) {
          useSessionStore.getState().clearPlacementCandidate();
          return;
        }
        useSessionStore.getState().cancelPlacement();
        useSessionStore.getState().closeActionDialog();
        return;
      }
      const shortcuts: Record<string, PlacementKind> = {
        '1': 'road',
        '2': 'settlement',
        '3': 'city',
      };
      const kind = shortcuts[event.key];
      if (previewPlacement) return;
      if (kind && availableBoardKinds.includes(kind)) {
        useSessionStore.getState().choosePlacement(kind);
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
    if (!choice) return;
    if ((selectedKind === 'road' || selectedKind === 'freeRoad') && hit.kind === 'edge') {
      useSessionStore.getState().selectPlacementCandidate({ kind: selectedKind, id: hit.id });
      return;
    }
    if ((selectedKind === 'settlement' || selectedKind === 'city') && hit.kind === 'vertex') {
      useSessionStore.getState().selectPlacementCandidate({ kind: selectedKind, id: hit.id });
      return;
    }
    submit(choice.command);
  };
  const targetLabel = (hit: BoardHit) => {
    const number = choices.findIndex((item) => item.id === hit.id) + 1;
    const edgeIndex = hit.kind === 'edge' ? graph.edgeIndex[hit.id] : undefined;
    const vertexIndex = hit.kind === 'vertex' ? graph.vertexIndex[hit.id] : undefined;
    const hexIds: readonly string[] =
      hit.kind === 'hex'
        ? [hit.id]
        : edgeIndex !== undefined
          ? (graph.edgeHexes[edgeIndex] ?? [])
          : vertexIndex !== undefined
            ? (graph.vertexHexes[vertexIndex] ?? [])
            : [];
    const tiles = hexIds
      .map((id) => state.board.hexes.find((hex) => hex.id === id))
      .filter((hex) => hex !== undefined)
      .map((hex) =>
        hex.token === null
          ? t(`game:terrain.${hex.terrain}`)
          : t('game:tileWithToken', {
              terrain: t(`game:terrain.${hex.terrain}`),
              token: hex.token,
            }),
      )
      .join(', ');
    const harbor = state.board.harbors.find((port) => {
      if (hit.kind === 'edge') return port.edge === hit.id;
      if (vertexIndex === undefined) return false;
      return (graph.vertexEdges[vertexIndex] ?? []).some((edge) => edge === port.edge);
    });
    const harborLabel = harbor
      ? harbor.kind === 'generic'
        ? t('game:genericHarbor')
        : RESOURCES.some((resource) => resource === harbor.kind)
          ? t('game:resourceHarbor', { resource: t(`game:${harbor.kind}`) })
          : t('game:unknownHarbor')
      : null;
    const context = harborLabel ? t('game:tileAndHarbor', { tiles, harbor: harborLabel }) : tiles;
    return t('game:targetOptionDetail', {
      action: t(`game:placement.${selectedKind ?? 'road'}`),
      number,
      context,
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
      {conflicted ? (
        <p role="alert">{t('game:saveConflictStopped')}</p>
      ) : status?.kind === 'error' ? (
        <p role="alert">{t('game:sessionStopped')}</p>
      ) : seat === null || !availability ? (
        <p className="muted">{t('game:awaitingAction')}</p>
      ) : (
        <>
          {availableBoardKinds.length > 0 && (
            <>
              <p>
                {selectedKind
                  ? selectedPlacement
                    ? t('game:placementSelectedInstruction', {
                        piece: t(
                          `game:piece.${selectedKind === 'freeRoad' ? 'road' : selectedKind}`,
                        ),
                      })
                    : selectedKind === 'road' || selectedKind === 'freeRoad'
                      ? t('game:roadInstruction', { count: choices.length })
                      : selectedKind === 'settlement' || selectedKind === 'city'
                        ? t('game:buildingInstruction', { count: choices.length })
                        : t('game:boardInstruction', {
                            action: t(`game:placement.${selectedKind}`),
                          })
                  : t('game:chooseBoardAction')}
              </p>
              <div className="action-row" role="group" aria-label={t('game:chooseBoardAction')}>
                {availableBoardKinds.map((kind) => (
                  <button
                    className={`button ${selectedKind === kind ? 'button-primary' : 'button-quiet'}`}
                    type="button"
                    key={kind}
                    aria-pressed={selectedKind === kind}
                    onClick={() => useSessionStore.getState().choosePlacement(kind)}
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
                    onClick={() => useSessionStore.getState().openActionDialog('trade')}
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
                    onClick={() => useSessionStore.getState().openActionDialog('bank')}
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
                      useSessionStore.getState().openActionDialog('plenty', card.slotId);
                    } else if (cardKind === 'monopoly') {
                      useSessionStore.getState().openActionDialog('monopoly', card.slotId);
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
          {formProps && visibleForm === 'trade' && (
            <TradeComposer {...formProps} onCancel={closeForm} />
          )}
          {formProps && visibleForm === 'bank' && (
            <BankTradePicker {...formProps} onCancel={closeForm} />
          )}
          {formProps && visibleForm === 'plenty' && (
            <YearOfPlentyDialog
              {...formProps}
              onCancel={closeForm}
              {...(slotId ? { slotId } : {})}
            />
          )}
          {formProps && visibleForm === 'monopoly' && (
            <MonopolyDialog {...formProps} onCancel={closeForm} {...(slotId ? { slotId } : {})} />
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

  const placementConfirmation =
    selectedPlacement && focusTarget && selectedKind && selectedKind !== 'robber'
      ? {
          piece: selectedKind === 'freeRoad' ? ('road' as const) : selectedKind,
          hit: focusTarget,
          label: targetLabel(focusTarget),
          confirm: () => submit(selectedPlacement.command),
          cancel: () => useSessionStore.getState().clearPlacementCandidate(),
        }
      : null;

  return {
    actorSeat,
    availability,
    highlights,
    focusTarget,
    placementConfirmation,
    onBoardSelect,
    targetLabel,
    dock,
  };
}

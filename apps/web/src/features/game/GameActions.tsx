import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getPieceIconUrl, type BoardHighlights, type BoardHit } from '@cp2p/renderer';
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
import { BuildCostsDialog } from './BuildCostsDialog.js';

const boardOrder: readonly PlacementKind[] = ['settlement', 'road', 'city', 'freeRoad', 'robber'];
const normalActionOrder: Readonly<Record<string, number>> = {
  ROLL_DICE: 0,
  END_TURN: 0,
  MARITIME_TRADE: 1,
  OFFER_TRADE: 2,
  PROPOSE_TRADE: 2,
};
const actionPaths: Readonly<Record<string, string>> = {
  ROLL_DICE: 'M5 5h6v6H5zM13 13h6v6h-6zM7.5 7.5h1M15.5 15.5h1',
  END_TURN: 'M4 12h15m-6-6 6 6-6 6',
  MARITIME_TRADE: 'M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4',
  OFFER_TRADE:
    'M7 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM3 17v-2a4 4 0 0 1 7-2.6M21 17v-2a4 4 0 0 0-7-2.6M9 16h6m-2-2 2 2-2 2',
  PROPOSE_TRADE:
    'M7 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM3 17v-2a4 4 0 0 1 7-2.6M21 17v-2a4 4 0 0 0-7-2.6M9 16h6m-2-2 2 2-2 2',
  robber: 'M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM8 20v-4a4 4 0 0 1 8 0v4Z',
  BUY_DEV_CARD: 'M5 4h12v15H5zM8 7h12v15H8z',
  PLAY_DEV_CARD: 'M5 4h12v15H5zM8 7h12v15H8z',
};
const noChoices = [] as const;
const closeForm = () => useSessionStore.getState().closeActionDialog();

function ActionIcon({ kind }: { kind: string }) {
  const piece = kind === 'freeRoad' ? 'road' : kind;
  if (piece === 'road' || piece === 'settlement' || piece === 'city')
    return <img className="action-icon" src={getPieceIconUrl(piece)} alt="" aria-hidden="true" />;
  const path = actionPaths[kind] ?? 'M5 12h14m-5-5 5 5-5 5';
  return (
    <svg className="action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
  offerOverlay: React.ReactNode;
  placementActive: boolean;
  knightIntent: { slotId: string; confirm: () => void; cancel: () => void } | null;
  toggleKnightIntent: (slotId: string) => void;
  dock: React.ReactNode;
  forms: React.ReactNode;
  nextStep: NextStep;
  actionCount: number;
}

export type NextStep =
  | { kind: 'command'; label: string; run: () => void }
  | { kind: 'board'; text: string; cancel?: () => void }
  | { kind: 'text'; text: string; tone: 'muted' | 'alert' };

/** The controller only offers engine-provided commands and checks the live revision on submission. */
export function useGameActions(
  state: GameState,
  pending: readonly Pending[],
  presentation: GamePresentation,
  options: { compact?: boolean; onHandOff?: () => void; onFormClosed?: () => void } = {},
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
  const optionalChoices = useSessionStore((store) => store.optionalChoices);
  const optionalViewingSeat = useSessionStore((store) => store.optionalViewingSeat);
  const [error, setError] = useState<string | null>(null);
  const [buildCostsOpen, setBuildCostsOpen] = useState(false);
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
        if (!mandatoryPlacement) useSessionStore.getState().cancelPlacement();
        useSessionStore.getState().closeActionDialog();
        return;
      }
      if (form === 'knight') return;
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
    if (
      previewPlacement &&
      previewPlacement.kind === selectedKind &&
      previewPlacement.id === hit.id
    ) {
      useSessionStore.getState().clearPlacementCandidate();
      return;
    }
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
  const closeFormAndFocus = () => {
    closeForm();
    options.onFormClosed?.();
  };
  const selectedKnight =
    form === 'knight' && slotId
      ? cardPlays.find(
          (card) => card.slotId === slotId && (card.card ?? priv?.slots[card.slotId]) === 'knight',
        )
      : undefined;
  const seenCardKinds = new Set<string>();
  const dockCardPlays = cardPlays.filter((card) => {
    const kind = card.card ?? priv?.slots[card.slotId] ?? 'Hidden';
    if (kind === 'knight' && selectedKnight) return card.slotId === selectedKnight.slotId;
    if (seenCardKinds.has(kind)) return false;
    seenCardKinds.add(kind);
    return true;
  });
  const toggleKnightIntent = (cardSlotId: string) => {
    const card = cardPlays.find(
      (item) => item.slotId === cardSlotId && (item.card ?? priv?.slots[item.slotId]) === 'knight',
    );
    if (!card?.commands[0]) return;
    if (form === 'knight' && slotId === cardSlotId) closeFormAndFocus();
    else useSessionStore.getState().openActionDialog('knight', cardSlotId);
  };
  const primary = availability?.primary ?? [];
  const normalGroups = primary
    .filter((group) => group.type in normalActionOrder)
    .toSorted(
      (left, right) => (normalActionOrder[left.type] ?? 0) - (normalActionOrder[right.type] ?? 0),
    );
  const contextualGroups = primary.filter((group) => !(group.type in normalActionOrder));
  const promoted = options.compact
    ? normalGroups.find((group) => group.type === 'ROLL_DICE' || group.type === 'END_TURN')
    : undefined;
  const sheetNormalGroups = normalGroups.filter((group) => group !== promoted);
  const actionButtons = (groups: typeof primary) =>
    groups.flatMap((group) => {
      if (
        ['RESPOND_TRADE', 'CANCEL_TRADE', 'CONFIRM_TRADE', 'STEAL', 'DISCARD'].includes(group.type)
      )
        return [];
      const buttonClass = `button button-quiet action-control ${group.type in normalActionOrder ? 'action-normal-control' : ''}`;
      if (group.type === 'OFFER_TRADE' || group.type === 'PROPOSE_TRADE')
        return [
          <button
            className={buttonClass}
            type="button"
            key={group.type}
            title={t('game:command.trade')}
            onClick={() => {
              options.onHandOff?.();
              useSessionStore.getState().openActionDialog('trade');
            }}
          >
            <ActionIcon kind={group.type} />
            <span>{t('game:normalTrade')}</span>
          </button>,
        ];
      if (group.type === 'MARITIME_TRADE')
        return [
          <button
            className={buttonClass}
            type="button"
            key={group.type}
            title={t('game:command.bank')}
            onClick={() => {
              options.onHandOff?.();
              useSessionStore.getState().openActionDialog('bank');
            }}
          >
            <ActionIcon kind={group.type} />
            <span>{t('game:normalBank')}</span>
          </button>,
        ];
      return group.commands.map((command, index) => (
        <button
          className={buttonClass}
          type="button"
          key={`${group.type}:${index}`}
          onClick={() => {
            options.onHandOff?.();
            submit(command);
          }}
        >
          <ActionIcon kind={group.type} />
          <span>{t(`game:command.${group.type}`)}</span>
        </button>
      ));
    });
  const optionalTradeChooser =
    optionalChoices.length > 0 && optionalViewingSeat === null ? (
      <details className="optional-trade-chooser">
        <summary>{t('game:optionalTrade')}</summary>
        <div>
          {optionalChoices.map((choiceSeat) => (
            <button
              className="button button-quiet"
              type="button"
              key={choiceSeat}
              onClick={() => {
                options.onHandOff?.();
                useSessionStore.getState().viewOptionalSeat(choiceSeat);
              }}
            >
              {t('game:viewOptionalTrade', { player: playerLabel(choiceSeat) })}
            </button>
          ))}
        </div>
      </details>
    ) : null;

  const dock = (
    <section className="action-dock" aria-label={t('game:actions')}>
      <div className="action-dock-heading">
        <h2>{t('game:actions')}</h2>
        <button
          className="button button-quiet action-costs-trigger"
          type="button"
          onClick={() => {
            options.onHandOff?.();
            setBuildCostsOpen(true);
          }}
        >
          {t('game:buildCostsTitle')}
        </button>
      </div>
      {conflicted ? (
        <p role="alert">{t('game:saveConflictStopped')}</p>
      ) : status?.kind === 'error' ? (
        <p role="alert">{t('game:sessionStopped')}</p>
      ) : seat === null || !availability ? (
        <>
          <p className="muted">{t('game:awaitingAction')}</p>
          {optionalTradeChooser}
        </>
      ) : (
        <>
          <div className={`action-dock-layout ${normalGroups.length ? 'has-normal' : ''}`}>
            <div className="action-context">
              {availableBoardKinds.length > 0 && (
                <div
                  className="action-context-buttons"
                  role="group"
                  aria-label={t('game:chooseBoardAction')}
                >
                  {availableBoardKinds.map((kind) => (
                    <button
                      className={`button action-control ${selectedKind === kind ? 'button-primary' : 'button-quiet'}`}
                      type="button"
                      key={kind}
                      aria-pressed={selectedKind === kind}
                      onClick={() => {
                        options.onHandOff?.();
                        const store = useSessionStore.getState();
                        if (selectedKind !== kind) store.choosePlacement(kind);
                        else if (mandatoryPlacement) store.clearPlacementCandidate();
                        else store.cancelPlacement();
                      }}
                    >
                      <ActionIcon kind={kind} />
                      <span>{t(`game:buildAction.${kind}`)}</span>
                    </button>
                  ))}
                  {selectedKind && !mandatoryPlacement && !selectedPlacement && (
                    <button
                      className="button button-quiet action-control action-cancel"
                      type="button"
                      onClick={() => useSessionStore.getState().cancelPlacement()}
                    >
                      <span>{t('game:cancelAction')}</span>
                    </button>
                  )}
                </div>
              )}
              {(contextualGroups.length > 0 || dockCardPlays.length > 0) && (
                <div
                  className="action-context-buttons"
                  role="group"
                  aria-label={t('game:contextActions')}
                >
                  {actionButtons(contextualGroups)}
                  {dockCardPlays.map((card) => {
                    const cardKind = card.card ?? priv?.slots[card.slotId] ?? 'Hidden';
                    const knightSelected =
                      cardKind === 'knight' && form === 'knight' && slotId === card.slotId;
                    return (
                      <button
                        className={`button action-control ${knightSelected ? 'button-primary' : 'button-quiet'}`}
                        type="button"
                        key={card.slotId}
                        {...(cardKind === 'knight' ? { 'aria-pressed': knightSelected } : {})}
                        onClick={() => {
                          options.onHandOff?.();
                          if (cardKind === 'knight') {
                            toggleKnightIntent(card.slotId);
                          } else if (cardKind === 'yearOfPlenty') {
                            useSessionStore.getState().openActionDialog('plenty', card.slotId);
                          } else if (cardKind === 'monopoly') {
                            useSessionStore.getState().openActionDialog('monopoly', card.slotId);
                          } else if (card.commands[0]) submit(card.commands[0]);
                        }}
                      >
                        <ActionIcon kind="PLAY_DEV_CARD" />
                        <span>{t('game:playCard', { card: t(`game:dev${cardKind}`) })}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {selectedKind && (
                <p className="action-context-hint" role="status">
                  {selectedPlacement
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
                          })}
                </p>
              )}
              {optionalTradeChooser}
            </div>
            {sheetNormalGroups.length > 0 && (
              <div
                className="action-normal-buttons"
                role="group"
                aria-label={t('game:normalActions')}
              >
                {actionButtons(sheetNormalGroups)}
              </div>
            )}
          </div>
        </>
      )}
      {error && !options.compact && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );

  const forms = (
    <div className="action-forms">
      {!conflicted && status?.kind !== 'error' && availability && formProps && (
        <>
          {visibleForm === 'discard' && <DiscardDialog {...formProps} />}
          {visibleForm === 'steal' && <StealDialog {...formProps} />}
          {visibleForm === 'trade' && <TradeComposer {...formProps} onCancel={closeFormAndFocus} />}
          {visibleForm === 'bank' && (
            <BankTradePicker {...formProps} onCancel={closeFormAndFocus} />
          )}
          {visibleForm === 'plenty' && (
            <YearOfPlentyDialog
              {...formProps}
              onCancel={closeFormAndFocus}
              {...(slotId ? { slotId } : {})}
            />
          )}
          {visibleForm === 'monopoly' && (
            <MonopolyDialog
              {...formProps}
              onCancel={closeFormAndFocus}
              {...(slotId ? { slotId } : {})}
            />
          )}
        </>
      )}
      {buildCostsOpen && (
        <BuildCostsDialog
          onClose={() => {
            setBuildCostsOpen(false);
            options.onFormClosed?.();
          }}
        />
      )}
    </div>
  );

  const promotedCommand = promoted?.commands[0];
  let nextStep: NextStep;
  if (conflicted) {
    nextStep = { kind: 'text', tone: 'alert', text: t('game:saveConflictStopped') };
  } else if (status?.kind === 'error') {
    nextStep = { kind: 'text', tone: 'alert', text: t('game:sessionStopped') };
  } else if (error) {
    nextStep = { kind: 'text', tone: 'alert', text: error };
  } else if (seat === null || !availability) {
    nextStep = { kind: 'text', tone: 'muted', text: t('game:awaitingAction') };
  } else if (selectedKind) {
    nextStep = {
      kind: 'board',
      text: selectedPlacement
        ? t('game:cockpit.confirmOnBoard')
        : t('game:cockpit.tapTarget', { target: t(`game:placement.${selectedKind}`) }),
      ...(!mandatoryPlacement && !selectedPlacement
        ? { cancel: () => useSessionStore.getState().cancelPlacement() }
        : {}),
    };
  } else if (promotedCommand) {
    nextStep = {
      kind: 'command',
      label: t(`game:command.${promoted?.type}`),
      run: () => submit(promotedCommand),
    };
  } else {
    nextStep = { kind: 'text', tone: 'muted', text: t('game:cockpit.chooseAction') };
  }
  const actionCount =
    availableBoardKinds.length +
    dockCardPlays.length +
    contextualGroups.length +
    sheetNormalGroups.length;

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
  const offerOverlay =
    formProps &&
    legal?.commands.some(
      (command) =>
        ['RESPOND_TRADE', 'CANCEL_TRADE', 'CONFIRM_TRADE'].includes(command.type) &&
        typeof command.offerId === 'number',
    ) ? (
      <IncomingOffers {...formProps} collapsedWhilePlacing={selectedKind !== undefined} />
    ) : null;

  return {
    actorSeat,
    availability,
    highlights,
    focusTarget,
    placementConfirmation,
    onBoardSelect,
    targetLabel,
    offerOverlay,
    placementActive: selectedKind !== undefined,
    knightIntent:
      selectedKnight && slotId
        ? {
            slotId,
            confirm: () => {
              if (selectedKnight.commands[0]) submit(selectedKnight.commands[0]);
            },
            cancel: closeFormAndFocus,
          }
        : null,
    toggleKnightIntent,
    dock,
    forms,
    nextStep,
    actionCount,
  };
}

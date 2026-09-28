import { useEffect, useRef } from 'react';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import type { ActionAvailability } from '../actions/availability';
import type { CommandFormProps } from '../dialogs/types';
import { useSessionStore } from '../../store/session-store';
import type { SessionStore } from '../../store/session-store';
import {
  AqueductDialog,
  DeckChoiceDialog,
  HarborOfferDialog,
  HarborReplyDialog,
} from './dialogs/ChoiceDialogs';
import { DiscardProgressDialog } from './dialogs/DiscardProgressDialog';
import { GiveCardsDialog } from './dialogs/GiveCardsDialog';
import { ImprovementsDialog } from './dialogs/ImprovementsDialog';
import { PlayCardDialog } from './dialogs/PlayCardDialog';
import { knightsState } from './state';

interface Props extends CommandFormProps {
  availability: ActionAvailability;
  presentation: GamePresentation;
  form: SessionStore['openDialog'];
  slotId: string | null;
  onCancel: () => void;
}

/**
 * The dialogs a knights game adds: the choices the game asks for (the Aqueduct, a deck after a tie,
 * a Wedding gift, a Saboteur discard, a Harbor answer, progress cards over the limit) and the ones a
 * seat opens itself (playing a progress card, the improvements, Commercial Harbor offers).
 */
export function KnightsForms({
  availability,
  presentation,
  form,
  slotId,
  onCancel,
  ...props
}: Props) {
  const types = availability.availableTypes;
  const { state, seat } = props;
  const harbor = knightsState(state)?.harbor;
  const harborCards = harbor?.seat === seat ? harbor.cards : 0;
  const lastHarbor = useRef(harborCards);
  // A Commercial Harbor that has just been played opens its offer dialog by itself.
  useEffect(() => {
    if (harborCards > lastHarbor.current) useSessionStore.getState().openActionDialog('harbor');
    lastHarbor.current = harborCards;
  }, [harborCards]);
  // Off turn, or with the turn blocked by a surplus, discarding progress cards is forced.
  const discardForced = types.includes('DISCARD_PROGRESS') && !types.includes('END_TURN');
  const base = { ...props, onCancel };
  return (
    <>
      {types.includes('CHOOSE_AQUEDUCT') && <AqueductDialog {...base} />}
      {types.includes('CHOOSE_PROGRESS_DECK') && <DeckChoiceDialog {...base} />}
      {types.includes('WEDDING_GIVE') && <GiveCardsDialog kind="WEDDING_GIVE" {...base} />}
      {types.includes('SABOTEUR_DISCARD') && <GiveCardsDialog kind="SABOTEUR_DISCARD" {...base} />}
      {types.includes('HARBOR_REPLY') && <HarborReplyDialog {...base} />}
      {types.includes('DISCARD_PROGRESS') && (discardForced || form === 'discardProgress') && (
        <DiscardProgressDialog forced={discardForced} {...base} />
      )}
      {types.includes('HARBOR_OFFER') && form === 'harbor' && <HarborOfferDialog {...base} />}
      {form === 'progress' && slotId !== null && (
        <PlayCardDialog availability={availability} slotId={slotId} {...base} />
      )}
      {form === 'improve' && <ImprovementsDialog presentation={presentation} {...base} />}
    </>
  );
}

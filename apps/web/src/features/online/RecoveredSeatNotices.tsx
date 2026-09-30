import type { Seat } from '@cp2p/engine';
import { useTranslation } from 'react-i18next';

/**
 * Board notices for a recovered human seat: the returning player's original
 * device (its seat is a bot, or its key was retired), and the device whose
 * certified bot now plays that seat.
 */
export function RecoveredSeatNotices({
  selfSeat,
  retired = false,
  returnable,
  onReturn,
}: {
  /** This device's own seat when a certified bot now plays it, or when its key was retired. */
  selfSeat: Seat | null;
  /** The key was retired before this device saw why (a transfer or a takeover). */
  retired?: boolean;
  /** Recovered seats whose bot this device hosts and may return. */
  returnable: readonly { readonly seat: Seat; readonly name: string }[];
  onReturn: (seat: Seat) => void;
}) {
  const { t } = useTranslation('lobby');
  return (
    <>
      {selfSeat !== null && (
        <div className="online-game-notice" role="status">
          <strong>
            {t(retired ? 'lobby:retiredSelfTitle' : 'lobby:recoveredSelfTitle', {
              seat: selfSeat + 1,
            })}
          </strong>
          <p>
            {t(retired ? 'lobby:retiredSelfBody' : 'lobby:recoveredSelfBody', {
              seat: selfSeat + 1,
            })}
          </p>
        </div>
      )}
      {returnable.map(({ seat, name }) => (
        <div key={seat} className="online-game-notice" role="status">
          <strong>{t('lobby:returnableSeatTitle', { player: name })}</strong>
          <p>{t('lobby:returnableSeatBody')}</p>
          <button className="button button-quiet" type="button" onClick={() => onReturn(seat)}>
            {t('lobby:transferReturnSourceTitle', { seat: seat + 1 })}
          </button>
        </div>
      ))}
    </>
  );
}

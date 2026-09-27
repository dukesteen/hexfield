import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OnlineFullSaveDisplay } from '../../session/online-full-save-client.js';
import {
  encodeTransferInvite,
  parseTransferInviteUrl,
} from '../../session/online-transfer-link.js';
import './full-save.css';

export function ImportedTransferRequest({
  save,
}: {
  save: Pick<OnlineFullSaveDisplay, 'id' | 'gameId' | 'players'>;
}) {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const [invitation, setInvitation] = useState('');
  const [error, setError] = useState<string | null>(null);

  const request = async () => {
    setError(null);
    try {
      const invite = parseTransferInviteUrl(invitation.trim());
      if (invite.body.gameId !== save.gameId) {
        setError('lobby:importTransferWrongGame');
        return;
      }
      if (!save.players.some((player) => player.seat === invite.body.seat)) {
        setError('lobby:importTransferWrongSeat');
        return;
      }
      if (!/^[0-9a-f]{64}$/.test(save.id)) {
        setError('lobby:importTransferInvalidInvite');
        return;
      }
      await navigate({
        to: '/transfer/$code',
        params: { code: encodeTransferInvite(invite) },
        search: { archiveId: save.id },
      });
    } catch {
      setError('lobby:importTransferInvalidInvite');
    }
  };

  return (
    <section className="full-save-transfer-request" aria-labelledby="import-transfer-title">
      <h2 id="import-transfer-title">{t('lobby:importTransferTitle')}</h2>
      <p>{t('lobby:importTransferDescription')}</p>
      <label>
        {t('lobby:importTransferInviteLabel')}
        <textarea
          value={invitation}
          maxLength={4_096}
          rows={3}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setInvitation(event.currentTarget.value)}
        />
      </label>
      {error && <p role="alert">{t(error)}</p>}
      <button
        className="button button-primary"
        type="button"
        disabled={invitation.trim().length === 0}
        onClick={() => void request()}
      >
        {t('lobby:importTransferContinue')}
      </button>
    </section>
  );
}

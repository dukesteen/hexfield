import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import * as v from 'valibot';
import { useUpdateSettings } from '../../queries/hooks';
import { networkSettingsSchema } from '../../queries/network-config';
import type { NetworkSettings } from '../../queries/network-config';

function urls(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function NetworkSettingsForm({ initial }: { initial: NetworkSettings }) {
  const { t } = useTranslation('lobby');
  const [signalingUrl, setSignalingUrl] = useState(initial.signalingUrl);
  const [stunUrls, setStunUrls] = useState(initial.stunUrls.join('\n'));
  const [turnUrls, setTurnUrls] = useState(initial.turn.urls.join('\n'));
  const [username, setUsername] = useState(initial.turn.username);
  const [credential, setCredential] = useState(initial.turn.credential);
  const [endpoint, setEndpoint] = useState(initial.turnCredentialsUrl);
  const [policy, setPolicy] = useState(initial.iceTransportPolicy);
  const [invalid, setInvalid] = useState(false);
  const update = useUpdateSettings();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = v.safeParse(networkSettingsSchema, {
      signalingUrl: signalingUrl.trim(),
      stunUrls: urls(stunUrls),
      turn: { urls: urls(turnUrls), username: username.trim(), credential },
      turnCredentialsUrl: endpoint.trim(),
      iceTransportPolicy: policy,
    });
    setInvalid(!result.success);
    if (result.success) update.mutate({ network: result.output });
  };

  return (
    <form className="settings-form network-settings" onSubmit={submit}>
      <fieldset>
        <legend>{t('lobby:networkSettingsTitle')}</legend>
        <p className="muted">{t('lobby:networkSettingsDescription')}</p>
        <label htmlFor="network-server">{t('lobby:onlineServerOrigin')}</label>
        <input
          id="network-server"
          type="url"
          autoComplete="off"
          maxLength={2048}
          value={signalingUrl}
          onChange={(event) => setSignalingUrl(event.target.value)}
          placeholder="wss://signal.example.org"
        />
        <p className="muted">{t('lobby:networkServerHint')}</p>
        <label htmlFor="network-policy">{t('lobby:networkConnectionPolicy')}</label>
        <select
          id="network-policy"
          value={policy}
          onChange={(event) => setPolicy(event.target.value === 'relay' ? 'relay' : 'all')}
        >
          <option value="all">{t('lobby:networkDirectOrRelay')}</option>
          <option value="relay">{t('lobby:networkRelayOnly')}</option>
        </select>
        <p className="muted">{t('lobby:networkRelayHint')}</p>
        <details>
          <summary>{t('lobby:networkAdvanced')}</summary>
          <div className="network-settings-fields">
            <label htmlFor="network-stun">{t('lobby:networkStunUrls')}</label>
            <textarea
              id="network-stun"
              rows={3}
              maxLength={4100}
              autoComplete="off"
              spellCheck={false}
              value={stunUrls}
              onChange={(event) => setStunUrls(event.target.value)}
            />
            <label htmlFor="network-turn">{t('lobby:networkTurnUrls')}</label>
            <textarea
              id="network-turn"
              rows={2}
              maxLength={4100}
              autoComplete="off"
              spellCheck={false}
              value={turnUrls}
              onChange={(event) => setTurnUrls(event.target.value)}
              placeholder="turns:turn.example.org:5349?transport=tcp"
            />
            <label htmlFor="network-turn-user">{t('lobby:networkTurnUsername')}</label>
            <input
              id="network-turn-user"
              autoComplete="off"
              maxLength={512}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <label htmlFor="network-turn-password">{t('lobby:networkTurnCredential')}</label>
            <input
              id="network-turn-password"
              type="password"
              autoComplete="new-password"
              maxLength={2048}
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
            <label htmlFor="network-turn-endpoint">{t('lobby:networkTurnEndpoint')}</label>
            <input
              id="network-turn-endpoint"
              type="url"
              autoComplete="off"
              maxLength={2048}
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://example.org/turn-credentials"
            />
            <p className="muted">{t('lobby:networkTurnEndpointHint')}</p>
          </div>
        </details>
      </fieldset>
      {invalid && <p role="alert">{t('lobby:networkSettingsInvalid')}</p>}
      <button className="button button-primary" type="submit" disabled={update.isPending}>
        {t('lobby:networkSaveSettings')}
      </button>
      {update.isSuccess && <p role="status">{t('lobby:settingsSaved')}</p>}
      {update.isError && <p role="alert">{t('lobby:settingsSaveError')}</p>}
    </form>
  );
}

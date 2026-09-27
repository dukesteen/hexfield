Read-only security and lifecycle review. No tools are available. Review only the supplied source diff and new files. Focus on: signed takeover policy actually reaching lobby/genesis, 2/3-human restriction, certified eligibility vs UI polling, stale candidate approval, auto mode, private material disclosure copy, worker RPC validation/authorization, cleanup and cancellation. Report concrete high/medium issues with file and line; do not invent missing context. Do not suggest weakening quorum or certified gates.

diff --git a/apps/web/src/features/online/OnlineConfiguration.test.tsx b/apps/web/src/features/online/OnlineConfiguration.test.tsx
index 1ddccda..10931ce 100644
--- a/apps/web/src/features/online/OnlineConfiguration.test.tsx
+++ b/apps/web/src/features/online/OnlineConfiguration.test.tsx
@@ -3,7 +3,7 @@ import { act, cleanup, fireEvent, render } from '@testing-library/react';
 import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
 import { baseModule, success } from '@cp2p/engine';
 import type { GameConfig, Result } from '@cp2p/engine';
-import type { GenesisSeedMode } from '@cp2p/protocol';
+import type { GenesisSeedMode, TakeoverPolicy } from '@cp2p/protocol';
 import { standardFixedBoard } from '@cp2p/maps';
 import { genesisSchema } from '@cp2p/protocol';
 import { afterEach, expect, test, vi } from 'vitest';
@@ -21,6 +21,7 @@ const config: GameConfig = {
   seats: [0, 1, 2, 3],
   options: { base: { vpTarget: 10, mapLayout: 'balanced-random' } },
 };
+const takeover: TakeoverPolicy = { mode: 'vote', afterSeconds: 120 };
 
 test('the host can save every schema rule, timer and a fixed seed without losing other settings', () => {
   vi.useFakeTimers();
@@ -28,7 +29,14 @@ test('the host can save every schema rule, timer and a fixed seed without losing
     success(undefined),
   );
   const page = render(
-    <OnlineConfiguration config={config} seedMode={{ kind: 'joint' }} editable onSave={save} />,
+    <OnlineConfiguration
+      takeover={takeover}
+      humanCount={4}
+      config={config}
+      seedMode={{ kind: 'joint' }}
+      editable
+      onSave={save}
+    />,
   );
   expect(save).not.toHaveBeenCalled();
   fireEvent.change(page.getByLabelText('lobby:vpTarget'), { target: { value: '12' } });
@@ -66,6 +74,7 @@ test('the host can save every schema rule, timer and a fixed seed without losing
       },
     },
     { kind: 'fixed', seed: toBase64Url(new Uint8Array(32).fill(171)) },
+    takeover,
   );
 });
 
@@ -75,6 +84,8 @@ test('guests can read the signed rules and timers but cannot change or submit th
   );
   const page = render(
     <OnlineConfiguration
+      takeover={takeover}
+      humanCount={4}
       config={{
         ...config,
         options: {
@@ -104,6 +115,8 @@ test('fixed islands retain their board, random maps remove it, and malformed see
   );
   const page = render(
     <OnlineConfiguration
+      takeover={takeover}
+      humanCount={4}
       config={{ ...config, board, options: { base: { mapLayout: 'standard-fixed' } } }}
       seedMode={{ kind: 'joint' }}
       editable
@@ -113,7 +126,11 @@ test('fixed islands retain their board, random maps remove it, and malformed see
   expect(save).not.toHaveBeenCalled();
   fireEvent.change(page.getByLabelText('lobby:vpTarget'), { target: { value: '11' } });
   void act(() => vi.advanceTimersByTime(400));
-  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ board }), { kind: 'joint' });
+  expect(save).toHaveBeenLastCalledWith(
+    expect.objectContaining({ board }),
+    { kind: 'joint' },
+    takeover,
+  );
   fireEvent.change(page.getByLabelText('lobby:mapLayout'), {
     target: { value: 'balanced-random' },
   });
@@ -132,11 +149,20 @@ test('a pending edit is cancelled when the lobby freezes or the editor unmounts'
     success(undefined),
   );
   const page = render(
-    <OnlineConfiguration config={config} seedMode={{ kind: 'joint' }} editable onSave={save} />,
+    <OnlineConfiguration
+      takeover={takeover}
+      humanCount={4}
+      config={config}
+      seedMode={{ kind: 'joint' }}
+      editable
+      onSave={save}
+    />,
   );
   fireEvent.change(page.getByLabelText('lobby:vpTarget'), { target: { value: '12' } });
   page.rerender(
     <OnlineConfiguration
+      takeover={takeover}
+      humanCount={4}
       config={config}
       seedMode={{ kind: 'joint' }}
       editable={false}
@@ -156,6 +182,8 @@ test('reverting a configuration edit before the debounce does not save or reset
   const pending = vi.fn<(value: boolean) => void>();
   const page = render(
     <OnlineConfiguration
+      takeover={takeover}
+      humanCount={4}
       config={config}
       seedMode={{ kind: 'joint' }}
       editable
@@ -179,6 +207,8 @@ test('a parsed lobby acknowledgement clears saving despite reordered configurati
   const pending = vi.fn<(value: boolean) => void>();
   const page = render(
     <OnlineConfiguration
+      takeover={takeover}
+      humanCount={4}
       config={config}
       seedMode={{ kind: 'joint' }}
       editable
@@ -196,6 +226,8 @@ test('a parsed lobby acknowledgement clears saving despite reordered configurati
   expect(JSON.stringify(parsed)).not.toBe(JSON.stringify(sent));
   page.rerender(
     <OnlineConfiguration
+      takeover={takeover}
+      humanCount={4}
       config={parsed}
       seedMode={{ kind: 'joint' }}
       editable
@@ -217,6 +249,8 @@ test('changing only fixed-seed hex casing clears pending without a no-op save',
   const pending = vi.fn<(value: boolean) => void>();
   const page = render(
     <OnlineConfiguration
+      takeover={takeover}
+      humanCount={4}
       config={config}
       seedMode={{ kind: 'fixed', seed: toBase64Url(new Uint8Array(32).fill(171)) }}
       editable
@@ -232,3 +266,57 @@ test('changing only fixed-seed hex casing clears pending without a no-op save',
   expect(pending).toHaveBeenLastCalledWith(false);
   expect(page.queryByRole('status')).toBeNull();
 });
+
+test('host policy changes are saved with the same signed lobby configuration', () => {
+  vi.useFakeTimers();
+  const save = vi.fn<
+    (config: GameConfig, seed: GenesisSeedMode, policy: TakeoverPolicy) => Result<void>
+  >(() => success(undefined));
+  const page = render(
+    <OnlineConfiguration
+      config={config}
+      seedMode={{ kind: 'joint' }}
+      takeover={takeover}
+      humanCount={4}
+      editable
+      onSave={save}
+    />,
+  );
+  fireEvent.change(page.getByLabelText('lobby:onlineTakeoverMode'), {
+    target: { value: 'auto' },
+  });
+  fireEvent.change(page.getByLabelText('lobby:onlineTakeoverDelay'), {
+    target: { value: '30' },
+  });
+  void act(() => vi.advanceTimersByTime(400));
+  expect(save).toHaveBeenLastCalledWith(
+    expect.objectContaining({ seats: config.seats }),
+    { kind: 'joint' },
+    {
+      mode: 'auto',
+      afterSeconds: 30,
+    },
+  );
+  page.rerender(
+    <OnlineConfiguration
+      config={config}
+      seedMode={{ kind: 'joint' }}
+      takeover={{ mode: 'auto', afterSeconds: 30 }}
+      humanCount={4}
+      editable
+      onSave={save}
+    />,
+  );
+  fireEvent.change(page.getByLabelText('lobby:onlineTakeoverDelay'), {
+    target: { value: 'never' },
+  });
+  void act(() => vi.advanceTimersByTime(400));
+  expect(save).toHaveBeenLastCalledWith(
+    expect.objectContaining({ seats: config.seats }),
+    { kind: 'joint' },
+    {
+      mode: 'vote',
+      afterSeconds: 'never',
+    },
+  );
+});
diff --git a/apps/web/src/features/online/OnlineConfiguration.tsx b/apps/web/src/features/online/OnlineConfiguration.tsx
index a6f0219..c111d90 100644
--- a/apps/web/src/features/online/OnlineConfiguration.tsx
+++ b/apps/web/src/features/online/OnlineConfiguration.tsx
@@ -2,7 +2,7 @@ import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
 import { baseModule } from '@cp2p/engine';
 import type { GameConfig, OptionSpec, Result, TurnTimer } from '@cp2p/engine';
 import { standardFixedBoard } from '@cp2p/maps';
-import type { GenesisSeedMode } from '@cp2p/protocol';
+import type { GenesisSeedMode, TakeoverPolicy } from '@cp2p/protocol';
 import { useEffect, useRef, useState } from 'react';
 import { useTranslation } from 'react-i18next';
 
@@ -26,27 +26,32 @@ function initialOptions(config: GameConfig): Record<string, unknown> {
 export function OnlineConfiguration({
   config,
   seedMode,
+  takeover,
+  humanCount,
   editable,
   onSave,
   onPendingChange,
 }: {
   config: GameConfig;
   seedMode: GenesisSeedMode;
+  takeover: TakeoverPolicy;
+  humanCount: number;
   editable: boolean;
-  onSave: (config: GameConfig, seed: GenesisSeedMode) => Result<void>;
+  onSave: (config: GameConfig, seed: GenesisSeedMode, takeover: TakeoverPolicy) => Result<void>;
   onPendingChange?: (pending: boolean) => void;
 }) {
   const { t } = useTranslation('lobby');
   const [seatCount, setSeatCount] = useState(config.seats.length);
   const [options, setOptions] = useState<Record<string, unknown>>(() => initialOptions(config));
   const [fixedSeed, setFixedSeed] = useState(seedMode.kind === 'fixed');
+  const [takeoverDraft, setTakeoverDraft] = useState<TakeoverPolicy>(takeover);
   const [seedHex, setSeedHex] = useState(() =>
     seedMode.kind === 'fixed' ? toHex(fromBase64Url(seedMode.seed)) : '',
   );
   const [error, setError] = useState(false);
   const [revision, setRevision] = useState(0);
-  const baseline = useRef(JSON.stringify([seatCount, options, fixedSeed, seedHex]));
-  const externalKey = toHex(hashValue([config, seedMode]));
+  const baseline = useRef(JSON.stringify([seatCount, options, fixedSeed, seedHex, takeoverDraft]));
+  const externalKey = toHex(hashValue([config, seedMode, takeover]));
   const previousExternal = useRef(externalKey);
   const latestSubmitted = useRef<{ revision: number; key: string } | null>(null);
   const currentConfig = useRef(config);
@@ -73,23 +78,25 @@ export function OnlineConfiguration({
     setSeatCount(config.seats.length);
     setOptions(initialOptions(config));
     setFixedSeed(seedMode.kind === 'fixed');
+    setTakeoverDraft(takeover);
     setSeedHex(seedMode.kind === 'fixed' ? toHex(fromBase64Url(seedMode.seed)) : '');
     baseline.current = JSON.stringify([
       config.seats.length,
       initialOptions(config),
       seedMode.kind === 'fixed',
       seedMode.kind === 'fixed' ? toHex(fromBase64Url(seedMode.seed)) : '',
+      takeover,
     ]);
     setRevision(0);
     setError(false);
     latestSubmitted.current = null;
-  }, [externalKey, config, seedMode, revision]);
+  }, [externalKey, config, seedMode, takeover, revision]);
 
   useEffect(() => {
     if (!editable || revision === 0) return undefined;
     if (
       !latestSubmitted.current &&
-      JSON.stringify([seatCount, options, fixedSeed, seedHex]) === baseline.current
+      JSON.stringify([seatCount, options, fixedSeed, seedHex, takeoverDraft]) === baseline.current
     ) {
       setRevision(0);
       return undefined;
@@ -116,8 +123,14 @@ export function OnlineConfiguration({
           ? { board: previousBoard ?? standardFixedBoard() }
           : {}),
       };
-      const key = toHex(hashValue([next, selectedSeed]));
-      const draftKey = JSON.stringify([seatCount, options, fixedSeed, seedHex.toLowerCase()]);
+      const key = toHex(hashValue([next, selectedSeed, takeoverDraft]));
+      const draftKey = JSON.stringify([
+        seatCount,
+        options,
+        fixedSeed,
+        seedHex.toLowerCase(),
+        takeoverDraft,
+      ]);
       if (key === externalKey || draftKey === baseline.current) {
         baseline.current = draftKey;
         latestSubmitted.current = null;
@@ -126,12 +139,12 @@ export function OnlineConfiguration({
         return;
       }
       latestSubmitted.current = { revision, key };
-      const result = save.current(next, selectedSeed);
+      const result = save.current(next, selectedSeed, takeoverDraft);
       if (!result.ok) latestSubmitted.current = null;
       setError(!result.ok);
     }, SAVE_DELAY_MS);
     return () => window.clearTimeout(timer);
-  }, [editable, externalKey, fixedSeed, options, revision, seatCount, seedHex]);
+  }, [editable, externalKey, fixedSeed, options, revision, seatCount, seedHex, takeoverDraft]);
 
   const changed = () => {
     setRevision((current) => current + 1);
@@ -240,7 +253,51 @@ export function OnlineConfiguration({
               </div>
             )}
           </div>
+          <div className="online-takeover-fields">
+            <label>
+              {t('lobby:onlineTakeoverDelay')}
+              <select
+                value={takeoverDraft.afterSeconds}
+                onChange={(event) => {
+                  const delay = event.target.value;
+                  setTakeoverDraft(
+                    delay === 'never'
+                      ? { mode: 'vote', afterSeconds: 'never' }
+                      : { mode: takeoverDraft.mode, afterSeconds: Number(delay) },
+                  );
+                  changed();
+                }}
+              >
+                <option value="never">{t('lobby:onlineTakeoverNever')}</option>
+                {[30, 60, 120, 300].map((seconds) => (
+                  <option key={seconds} value={seconds}>
+                    {t('lobby:onlineTakeoverSeconds', { count: seconds })}
+                  </option>
+                ))}
+              </select>
+            </label>
+            {takeoverDraft.afterSeconds !== 'never' && (
+              <label>
+                {t('lobby:onlineTakeoverMode')}
+                <select
+                  value={takeoverDraft.mode}
+                  onChange={(event) => {
+                    setTakeoverDraft({
+                      mode: event.target.value === 'auto' ? 'auto' : 'vote',
+                      afterSeconds: takeoverDraft.afterSeconds,
+                    });
+                    changed();
+                  }}
+                >
+                  <option value="vote">{t('lobby:onlineTakeoverVote')}</option>
+                  <option value="auto">{t('lobby:onlineTakeoverAuto')}</option>
+                </select>
+              </label>
+            )}
+          </div>
         </fieldset>
+        <p className="muted">{t('lobby:onlineTakeoverDisclosure')}</p>
+        {humanCount < 4 && <p className="muted">{t('lobby:onlineTakeoverFourHumans')}</p>}
         {error && <p role="alert">{t('lobby:onlineActionFailed')}</p>}
         {editable && revision > 0 && !error && (
           <small role="status">{t('lobby:onlineSaving')}</small>
diff --git a/apps/web/src/features/online/OnlineGameScreen.tsx b/apps/web/src/features/online/OnlineGameScreen.tsx
index e26db2a..d16396c 100644
--- a/apps/web/src/features/online/OnlineGameScreen.tsx
+++ b/apps/web/src/features/online/OnlineGameScreen.tsx
@@ -1,4 +1,5 @@
 import type { Seat } from '@cp2p/engine';
+import { failure } from '@cp2p/engine';
 import type { GameSession, LobbyFreezeAgreement } from '@cp2p/protocol';
 import { getGameArtUrl } from '@cp2p/renderer';
 import { useBlocker, useNavigate } from '@tanstack/react-router';
@@ -16,6 +17,8 @@ import { ManualConnectionPanel } from './ManualConnectionPanel';
 import { ConnectionDiagnostics } from './ConnectionDiagnostics';
 import { ChatPanel } from './ChatPanel';
 import { TransferPanel } from './TransferPanel';
+import { RecoveryPanel } from './RecoveryPanel';
+import { useReconnectFallback } from './use-reconnect-fallback';
 import { useSourceTransfer } from '../../queries/online-transfers';
 import type { OnlineTransferBrowser } from '../../session/online-transfer-browser';
 import { createTransferInviteUrl } from '../../session/online-transfer-link';
@@ -149,6 +152,8 @@ function OnlineGameInstance({
   const snapshot = useSyncExternalStore(room.subscribe, room.getSnapshot, room.getSnapshot);
   const audit = useSessionStore((store) => store.audit);
   const status = useSessionStore((store) => store.status);
+  const recoveryCandidate = useSessionStore((store) => store.recoveryCandidate);
+  const reconnectFallback = useReconnectFallback(snapshot);
   const { mutate: requestPersistentStorage } = useRequestPersistentStorage();
   const [attached, setAttached] = useState(false);
   const [leaving, setLeaving] = useState(false);
@@ -267,6 +272,18 @@ function OnlineGameInstance({
       devicePeer !== null && devicePeer !== snapshot.self && !snapshot.peers.includes(devicePeer)
     );
   });
+  const missingHumans = missing.flatMap((seat) =>
+    seat.kind === 'human' ? [{ seat: seat.seat, name: seat.name }] : [],
+  );
+  const currentHumans = snapshot.deviceRoutes
+    ? snapshot.deviceRoutes.seats
+        .filter((seat) => seat.devicePeer !== null)
+        .map((seat) => seat.seat)
+    : agreement.state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.seat] : []));
+  const canInitiateTakeover =
+    currentHumans.length === 4 &&
+    missingHumans.length === 1 &&
+    game.seat === Math.min(...currentHumans.filter((seat) => seat !== missingHumans[0]?.seat));
   for (const seat of agreement.state.seats) {
     const devicePeer = currentDeviceForSeat(seat.seat);
     if (devicePeer !== null)
@@ -405,27 +422,53 @@ function OnlineGameInstance({
             </>
           }
           sessionNotice={
-            missing.length > 0 ? (
-              <div className="online-game-notice">
-                <div className="online-game-notice-heading">
-                  <span className="online-connection-spinner" aria-hidden="true" />
-                  <strong>{t('lobby:onlineReconnecting')}</strong>
-                </div>
-                <p>
-                  {t('lobby:onlineGameWaitingPeers', {
-                    players: missing
-                      .map((seat) => (seat.kind === 'human' ? seat.name : ''))
-                      .join(', '),
-                  })}
-                </p>
-                <button
-                  className="button button-quiet"
-                  type="button"
-                  onClick={() => setConnectionOpen(true)}
-                >
-                  {t('lobby:manualReconnectTitle')}
-                </button>
-              </div>
+            missing.length > 0 || recoveryCandidate ? (
+              <>
+                {missing.length > 0 && (
+                  <div className="online-game-notice">
+                    <div className="online-game-notice-heading">
+                      <span className="online-connection-spinner" aria-hidden="true" />
+                      <strong>{t('lobby:onlineReconnecting')}</strong>
+                    </div>
+                    <p>
+                      {t('lobby:onlineGameWaitingPeers', {
+                        players: missing
+                          .map((seat) => (seat.kind === 'human' ? seat.name : ''))
+                          .join(', '),
+                      })}
+                    </p>
+                    <button
+                      className="button button-quiet"
+                      type="button"
+                      onClick={() => setConnectionOpen(true)}
+                    >
+                      {t('lobby:manualReconnectTitle')}
+                    </button>
+                  </div>
+                )}
+                <RecoveryPanel
+                  policy={game.genesis.takeover}
+                  candidate={recoveryCandidate}
+                  missing={missingHumans}
+                  takeoverAvailable={currentHumans.length === 4}
+                  canInitiate={canInitiateTakeover}
+                  onEligibility={(seat) =>
+                    game.session.canRequestTakeover?.(seat) ??
+                    Promise.resolve(failure('session-unavailable', 'Takeover is unavailable'))
+                  }
+                  onApprove={(change) =>
+                    game.session.approveRecoveryAuthorization?.(change) ??
+                    Promise.resolve(
+                      failure('session-unavailable', 'Takeover voting is unavailable'),
+                    )
+                  }
+                  onDecline={() => game.session.clearRecoveryApproval?.()}
+                  onRequest={(seat, level) =>
+                    game.session.requestTakeover?.(seat, level) ??
+                    Promise.resolve(failure('session-unavailable', 'Takeover is unavailable'))
+                  }
+                />
+              </>
             ) : undefined
           }
         />
@@ -459,7 +502,12 @@ function OnlineGameInstance({
               {...(room.getPeerStats ? { loadPeerStats: room.getPeerStats } : {})}
               peerLabels={peerLabels}
             />
-            <ManualConnectionPanel room={room} snapshot={snapshot} reconnect />
+            <ManualConnectionPanel
+              room={room}
+              snapshot={snapshot}
+              reconnect
+              reconnectFallback={reconnectFallback}
+            />
           </>
         )}
       </dialog>
diff --git a/apps/web/src/features/online/OnlineLobby.tsx b/apps/web/src/features/online/OnlineLobby.tsx
index 2610f62..a4430d8 100644
--- a/apps/web/src/features/online/OnlineLobby.tsx
+++ b/apps/web/src/features/online/OnlineLobby.tsx
@@ -330,9 +330,11 @@ export function OnlineLobby({
                 <OnlineConfiguration
                   config={state.config}
                   seedMode={state.seedMode}
+                  takeover={state.takeover}
+                  humanCount={humanSeats.length}
                   editable={isHost && state.status === 'open' && !snapshot.startup && !startBusy}
-                  onSave={(config, seed) =>
-                    room.lobby?.configure(config, seed) ??
+                  onSave={(config, seed, takeover) =>
+                    room.lobby?.configure(config, seed, takeover) ??
                     failure('lobby-closed', 'The room is closed')
                   }
                   onPendingChange={setSettingsPending}
@@ -342,9 +344,16 @@ export function OnlineLobby({
                   <div>
                     <h2>{t('lobby:onlineStartTitle')}</h2>
                     <p className="muted">{t('lobby:onlineStartPreparation')}</p>
-                    {state.takeover.afterSeconds === 'never' && (
-                      <p className="muted">{t('lobby:onlineDisconnectPolicy')}</p>
-                    )}
+                    <p className="muted">
+                      {state.takeover.afterSeconds === 'never'
+                        ? t('lobby:onlineDisconnectPolicy')
+                        : t(
+                            state.takeover.mode === 'auto'
+                              ? 'lobby:onlineTakeoverSummaryAuto'
+                              : 'lobby:onlineTakeoverSummaryVote',
+                            { count: state.takeover.afterSeconds },
+                          )}
+                    </p>
                   </div>
                   <button
                     className="button button-primary"
diff --git a/apps/web/src/features/online/online.css b/apps/web/src/features/online/online.css
index d44c628..fa4acb6 100644
--- a/apps/web/src/features/online/online.css
+++ b/apps/web/src/features/online/online.css
@@ -244,7 +244,8 @@
 }
 
 .online-timer-fields,
-.online-seed-fields {
+.online-seed-fields,
+.online-takeover-fields {
   grid-column: 1 / -1;
   display: grid;
   gap: 12px;
@@ -434,6 +435,32 @@
   font-size: 11px;
 }
 
+.online-recovery-panel {
+  display: grid;
+  gap: 10px;
+  margin: 12px 12px 0;
+  padding: 14px;
+  border: 1px solid var(--border);
+  border-radius: 12px;
+  background: var(--raised);
+  font-size: 0.875rem;
+}
+
+.online-recovery-panel :is(p, .dialog-actions) {
+  margin: 0;
+}
+
+.online-recovery-request {
+  display: grid;
+  gap: 10px;
+}
+
+.online-recovery-panel .dialog-actions {
+  display: flex;
+  flex-wrap: wrap;
+  gap: 8px;
+}
+
 @keyframes online-connection-spin {
   to {
     transform: rotate(360deg);
diff --git a/apps/web/src/session/online-protocol-worker.ts b/apps/web/src/session/online-protocol-worker.ts
index 682c888..5af0baa 100644
--- a/apps/web/src/session/online-protocol-worker.ts
+++ b/apps/web/src/session/online-protocol-worker.ts
@@ -26,6 +26,7 @@ const kinds = new Set<string>([
   'ackSession',
   'approveRecoveryAuthorization',
   'clearRecoveryApproval',
+  'canRequestTakeover',
   'requestTakeover',
   'cancelPending',
   'shutdown',
@@ -108,6 +109,8 @@ function validBody(body: Record<string, unknown>): boolean {
       );
     case 'approveRecoveryAuthorization':
       return 'change' in body && onlyKeys(body, ['kind', 'change']);
+    case 'canRequestTakeover':
+      return seat(body.departedSeat) && onlyKeys(body, ['kind', 'departedSeat']);
     case 'requestTakeover':
       return (
         seat(body.departedSeat) &&
diff --git a/apps/web/src/session/online-room-manual.test.ts b/apps/web/src/session/online-room-manual.test.ts
index d7c0106..3077756 100644
--- a/apps/web/src/session/online-room-manual.test.ts
+++ b/apps/web/src/session/online-room-manual.test.ts
@@ -127,7 +127,7 @@ test('manual host publishes one signed room-bound offer and cancels its owned RT
   );
   try {
     expect(room.invite.serverUrl).toBe('');
-    expect(room.getSnapshot().lobby?.takeover).toEqual({ mode: 'vote', afterSeconds: 'never' });
+    expect(room.getSnapshot().lobby?.takeover).toEqual({ mode: 'vote', afterSeconds: 120 });
     const offered = await room.startManualInvitation();
     if (!offered.ok) throw new Error(offered.error.message);
     const hint = await readManualLobbyOffer(offered.value.code);
diff --git a/apps/web/src/session/online-room.ts b/apps/web/src/session/online-room.ts
index d459945..e71e713 100644
--- a/apps/web/src/session/online-room.ts
+++ b/apps/web/src/session/online-room.ts
@@ -378,7 +378,7 @@ export class OnlineRoom {
                 name: request.name,
                 hostName: request.hostName,
                 config: request.config,
-                takeover: { mode: 'vote', afterSeconds: 'never' },
+                takeover: { mode: 'vote', afterSeconds: 120 },
               })
             : LobbyController.join({ ...common, hostPeer: invite.hostPeer });
         if (!created.ok) throw new Error(created.error.message);
diff --git a/apps/web/src/session/online-worker-messages.ts b/apps/web/src/session/online-worker-messages.ts
index 60955bf..53c5ce6 100644
--- a/apps/web/src/session/online-worker-messages.ts
+++ b/apps/web/src/session/online-worker-messages.ts
@@ -100,6 +100,7 @@ export type OnlineWorkerRequestBody =
   | { readonly kind: 'ackSession'; readonly snapshotId: number }
   | { readonly kind: 'approveRecoveryAuthorization'; readonly change: unknown }
   | { readonly kind: 'clearRecoveryApproval' }
+  | { readonly kind: 'canRequestTakeover'; readonly departedSeat: Seat }
   | {
       readonly kind: 'requestTakeover';
       readonly departedSeat: Seat;
@@ -160,6 +161,7 @@ export interface OnlineWorkerReplyByKind {
   ackSession: void;
   approveRecoveryAuthorization: RecoveryApprovalPreview;
   clearRecoveryApproval: void;
+  canRequestTakeover: void;
   requestTakeover: void;
   cancelPending: boolean;
   shutdown: void;
diff --git a/apps/web/src/session/online-worker-runtime.ts b/apps/web/src/session/online-worker-runtime.ts
index 007162a..2ede3f5 100644
--- a/apps/web/src/session/online-worker-runtime.ts
+++ b/apps/web/src/session/online-worker-runtime.ts
@@ -389,6 +389,12 @@ export class OnlineWorkerRuntime {
       case 'clearRecoveryApproval':
         this.requireSession().clearRecoveryApproval();
         return undefined;
+      case 'canRequestTakeover': {
+        const result = await this.requireSession().canRequestTakeover(body.departedSeat);
+        if (!result.ok)
+          throw Object.assign(new Error(result.error.message), { code: result.error.code });
+        return undefined;
+      }
       case 'requestTakeover': {
         const result = await this.requireSession().requestTakeover(
           body.departedSeat,
diff --git a/apps/web/src/session/online-worker-session.ts b/apps/web/src/session/online-worker-session.ts
index 4e703d5..ce32af8 100644
--- a/apps/web/src/session/online-worker-session.ts
+++ b/apps/web/src/session/online-worker-session.ts
@@ -152,6 +152,10 @@ export class OnlineWorkerSession implements GameSession {
     void this.client.request({ kind: 'clearRecoveryApproval' });
   }
 
+  canRequestTakeover(departedSeat: Seat) {
+    return this.client.request({ kind: 'canRequestTakeover', departedSeat });
+  }
+
   requestTakeover(departedSeat: Seat, botLevel: 'easy' | 'medium' | 'hard') {
     return this.client.request({ kind: 'requestTakeover', departedSeat, botLevel });
   }
diff --git a/apps/web/src/store/session-store.ts b/apps/web/src/store/session-store.ts
index e094355..491fafe 100644
--- a/apps/web/src/store/session-store.ts
+++ b/apps/web/src/store/session-store.ts
@@ -8,7 +8,7 @@ import type {
   Seat,
 } from '@cp2p/engine';
 import type { GameSession, SessionStatus, SessionTimer } from '../session';
-import type { SessionAuditState, SessionFairness } from '@cp2p/protocol';
+import type { RecoveryApprovalCandidate, SessionAuditState, SessionFairness } from '@cp2p/protocol';
 import type { EdgeId, VertexId } from '@cp2p/engine/geometry';
 import { requiredHumanSeat } from './pending-actors';
 
@@ -25,6 +25,7 @@ interface SessionView {
   status: SessionStatus | null;
   audit: SessionAuditState | null;
   fairness: SessionFairness | null;
+  recoveryCandidate: RecoveryApprovalCandidate | null;
   revision: number;
   waitingSeat: Seat | null;
   revealedSeat: Seat | null;
@@ -66,6 +67,7 @@ const emptyView: SessionView = {
   status: null,
   audit: null,
   fairness: null,
+  recoveryCandidate: null,
   revision: 0,
   waitingSeat: null,
   revealedSeat: null,
@@ -300,6 +302,7 @@ export function attachSession(gameId: string, session: GameSession): () => void
       status: update.status,
       audit: update.audit ?? null,
       fairness: update.fairness ?? null,
+      recoveryCandidate: update.recoveryCandidate ?? null,
       revision: update.revision,
       waitingSeat: coverSeat,
       revealedSeat: visibleSeat,
diff --git a/packages/protocol/src/p2p-session.ts b/packages/protocol/src/p2p-session.ts
index 2e7d5ac..9e3d31e 100644
--- a/packages/protocol/src/p2p-session.ts
+++ b/packages/protocol/src/p2p-session.ts
@@ -1120,6 +1120,12 @@ export class P2PSession implements GameSession<CertifiedHistory> {
     this.replica?.clearRecoveryApproval();
   }
 
+  canRequestTakeover(departedSeat: Seat): Promise<Result<void>> {
+    return this.replica && this.status.kind === 'running' && !this.recoveryInstalling
+      ? this.replica.canRequestTakeover(departedSeat)
+      : Promise.resolve(failure('session-recovery-unavailable', 'The game session is unavailable'));
+  }
+
   /** Explicit vote-mode takeover request; fresh bot keys are reserved before gossip. */
   async requestTakeover(
     departedSeat: Seat,
diff --git a/packages/protocol/src/session-types.ts b/packages/protocol/src/session-types.ts
index f56c82a..bb72dbd 100644
--- a/packages/protocol/src/session-types.ts
+++ b/packages/protocol/src/session-types.ts
@@ -63,6 +63,8 @@ export interface GameSession<Save = unknown> {
   getRecoveryCandidate?(): RecoveryApprovalCandidate | null;
   approveRecoveryAuthorization?(change: unknown): Promise<Result<RecoveryApprovalPreview>>;
   clearRecoveryApproval?(): void;
+  /** Reads this device's quorum-qualified takeover eligibility; certification still rechecks. */
+  canRequestTakeover?(departedSeat: Seat): Promise<Result<void>>;
   requestTakeover?(departedSeat: Seat, botLevel: 'easy' | 'medium' | 'hard'): Promise<Result<void>>;
   controllableSeats(): Seat[];
   submit(seat: Seat, command: CommandShape, options?: SubmitOptions): Promise<Result<void>>;

=== NEW apps/web/src/features/online/RecoveryPanel.tsx ===
import type { Result, Seat } from '@cp2p/engine';
import type {
  RecoveryApprovalCandidate,
  RecoveryApprovalPreview,
  TakeoverPolicy,
} from '@cp2p/protocol';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type BotLevel = 'easy' | 'medium' | 'hard';

export function RecoveryPanel({
  policy,
  candidate,
  missing,
  takeoverAvailable,
  canInitiate,
  onEligibility,
  onApprove,
  onDecline,
  onRequest,
}: {
  policy: TakeoverPolicy;
  candidate: RecoveryApprovalCandidate | null;
  missing: readonly { seat: Seat; name: string }[];
  takeoverAvailable: boolean;
  canInitiate: boolean;
  onEligibility: (seat: Seat) => Promise<Result<void>>;
  onApprove: (
    change: RecoveryApprovalCandidate['change'],
  ) => Promise<Result<RecoveryApprovalPreview>>;
  onDecline: () => void;
  onRequest: (seat: Seat, level: BotLevel) => Promise<Result<void>>;
}) {
  const { t } = useTranslation('lobby');
  const [level, setLevel] = useState<BotLevel>('easy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<string | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const [eligibility, setEligibility] = useState<{ seat: Seat; code: string | null } | null>(null);
  const eligibilityCheck = useRef(onEligibility);
  eligibilityCheck.current = onEligibility;
  const targetSeat = missing.length === 1 ? (missing[0]?.seat ?? null) : null;
  useEffect(() => {
    if (
      !canInitiate ||
      policy.mode !== 'vote' ||
      policy.afterSeconds === 'never' ||
      targetSeat === null
    )
      return undefined;
    let active = true;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await eligibilityCheck.current(targetSeat);
        if (active)
          setEligibility({ seat: targetSeat, code: result.ok ? null : result.error.code });
      } catch {
        if (active) setEligibility({ seat: targetSeat, code: 'recovery-unavailable' });
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [canInitiate, policy.mode, policy.afterSeconds, targetSeat]);
  if (
    policy.afterSeconds === 'never' ||
    (!takeoverAvailable && !candidate) ||
    (missing.length === 0 && !candidate)
  )
    return null;

  const choice = policy.mode === 'vote' && candidate?.preview.canApprove ? candidate : null;
  const statement = choice?.preview.statementHash ?? null;
  const candidateName = choice
    ? (missing.find((item) => item.seat === choice.preview.departedSeat)?.name ??
      t('lobby:onlineSeatNumber', { number: choice.preview.departedSeat + 1 }))
    : null;
  const act = async (operation: () => Promise<Result<unknown>>) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setError(result.error.code);
        return false;
      }
      return true;
    } catch {
      setError('recovery-unavailable');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="online-recovery-panel" aria-label={t('lobby:onlineTakeoverTitle')}>
      <strong>{t('lobby:onlineTakeoverTitle')}</strong>
      <p>
        {policy.mode === 'auto'
          ? t('lobby:onlineTakeoverAutoWaiting', { count: policy.afterSeconds })
          : t('lobby:onlineTakeoverVoteWaiting', { count: policy.afterSeconds })}
      </p>
      {choice && statement !== declined && (
        <div className="online-recovery-request">
          <p>
            {t('lobby:onlineTakeoverApproval', {
              player: candidateName,
              level: t(`lobby:onlineBotLevel_${choice.preview.botLevel}`),
            })}
          </p>
          <p className="muted">{t('lobby:onlineTakeoverDisclosure')}</p>
          {approved === statement ? (
            <p role="status">{t('lobby:onlineTakeoverApproved')}</p>
          ) : (
            <div className="dialog-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={busy}
                onClick={() => {
                  void act(() => onApprove(choice.change)).then((ok) => {
                    if (ok) setApproved(statement);
                    return undefined;
                  });
                }}
              >
                {t('lobby:onlineTakeoverApprove')}
              </button>
              <button
                className="button button-quiet"
                type="button"
                disabled={busy}
                onClick={() => {
                  onDecline();
                  setDeclined(statement);
                  setApproved(null);
                }}
              >
                {t('lobby:onlineTakeoverDecline')}
              </button>
            </div>
          )}
        </div>
      )}
      {choice && statement === declined && (
        <button className="button button-quiet" type="button" onClick={() => setDeclined(null)}>
          {t('lobby:onlineTakeoverReviewAgain')}
        </button>
      )}
      {policy.mode === 'vote' && canInitiate && targetSeat !== null && !choice && (
        <div className="online-recovery-request">
          {eligibility?.seat !== targetSeat || eligibility.code !== null ? (
            <p className="muted" role="status">
              {eligibility?.code === 'recovery-quorum'
                ? t('lobby:onlineTakeoverQuorum')
                : eligibility?.code === 'recovery-offline-required'
                  ? t('lobby:onlineTakeoverWaitingMarker')
                  : eligibility?.code === 'recovery-too-early'
                    ? t('lobby:onlineTakeoverWaitingDelay')
                    : t('lobby:onlineTakeoverChecking')}
            </p>
          ) : (
            <>
              <label>
                {t('lobby:onlineTakeoverBotLevel')}
                <select
                  value={level}
                  onChange={(event) => {
                    const selected = event.target.value;
                    if (selected === 'easy' || selected === 'medium' || selected === 'hard')
                      setLevel(selected);
                  }}
                >
                  {(['easy', 'medium', 'hard'] as const).map((botLevel) => (
                    <option key={botLevel} value={botLevel}>
                      {t(`lobby:onlineBotLevel_${botLevel}`)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button button-quiet"
                type="button"
                disabled={busy}
                onClick={() => void act(() => onRequest(targetSeat, level))}
              >
                {t('lobby:onlineTakeoverRequest', {
                  player: missing.find((item) => item.seat === targetSeat)?.name,
                })}
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert">
          {error === 'recovery-too-early' || error === 'recovery-offline-required'
            ? t('lobby:onlineTakeoverTooEarly')
            : error === 'recovery-quorum'
              ? t('lobby:onlineTakeoverQuorum')
              : t('lobby:onlineTakeoverFailed')}
        </p>
      )}
    </section>
  );
}

=== NEW apps/web/src/features/online/RecoveryPanel.test.tsx ===
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type { RecoveryApprovalCandidate } from '@cp2p/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { RecoveryPanel } from './RecoveryPanel.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const candidate: RecoveryApprovalCandidate = {
  change: {
    kind: 'recovery-authorize',
    statement: {
      genesisDigest: 'a'.repeat(64),
      parent: { seq: 7, hash: 'b'.repeat(64) },
      nextEpoch: 1,
      departedSeat: 2,
      hostSeat: 0,
      botLevel: 'medium',
      replacements: [{ seat: 2, publicKey: 'replacement' }],
      recoverers: ([0, 1, 3] as const).map((seat) => ({ seat, publicKey: `player-${seat}` })),
      previous: null,
    },
    hostSig: 'signed-host',
    keySigs: [{ seat: 2, sig: 'signed-replacement' }],
  },
  preview: {
    parent: { seq: 7, hash: 'b'.repeat(64) },
    statementHash: 'c'.repeat(64),
    departedSeat: 2,
    hostSeat: 0,
    botLevel: 'medium',
    amendment: false,
    affectedSeats: [2],
    recoverers: [0, 1, 3],
    canApprove: true,
  },
};

const baseProps = {
  policy: { mode: 'vote' as const, afterSeconds: 120 },
  candidate: null,
  missing: [{ seat: 2 as const, name: 'Mara' }],
  takeoverAvailable: true,
  canInitiate: true,
  onEligibility: vi.fn<() => Promise<Result<void>>>(async () => success(undefined)),
  onApprove: vi.fn<() => Promise<Result<typeof candidate.preview>>>(async () =>
    success(candidate.preview),
  ),
  onDecline: vi.fn<() => void>(),
  onRequest: vi.fn<() => Promise<Result<void>>>(async () => success(undefined)),
};

test('host requests the selected bot level but protocol eligibility errors remain visible', async () => {
  const request = vi.fn<() => Promise<Result<void>>>(async () =>
    failure('recovery-too-early', 'The certified absence threshold has not elapsed'),
  );
  const page = render(<RecoveryPanel {...baseProps} onRequest={request} />);
  await waitFor(() =>
    expect(page.getByRole('button', { name: 'lobby:onlineTakeoverRequest' })).toBeTruthy(),
  );
  fireEvent.change(page.getByLabelText('lobby:onlineTakeoverBotLevel'), {
    target: { value: 'medium' },
  });
  fireEvent.click(page.getByRole('button', { name: 'lobby:onlineTakeoverRequest' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(2, 'medium'));
  expect(page.getByRole('alert').textContent).toBe('lobby:onlineTakeoverTooEarly');
});

test('voter approves the exact signed candidate or declines locally without submitting it', async () => {
  const approve = vi.fn<() => Promise<Result<typeof candidate.preview>>>(async () =>
    success(candidate.preview),
  );
  const decline = vi.fn<() => void>();
  const page = render(
    <RecoveryPanel
      {...baseProps}
      candidate={candidate}
      canInitiate={false}
      onApprove={approve}
      onDecline={decline}
    />,
  );
  fireEvent.click(page.getByRole('button', { name: 'lobby:onlineTakeoverApprove' }));
  await waitFor(() => expect(approve).toHaveBeenCalledExactlyOnceWith(candidate.change));
  expect(page.getByRole('status').textContent).toBe('lobby:onlineTakeoverApproved');
  page.rerender(
    <RecoveryPanel
      {...baseProps}
      candidate={{ ...candidate, preview: { ...candidate.preview, statementHash: 'd'.repeat(64) } }}
      canInitiate={false}
      onApprove={approve}
      onDecline={decline}
    />,
  );
  fireEvent.click(page.getByRole('button', { name: 'lobby:onlineTakeoverDecline' }));
  expect(decline).toHaveBeenCalledOnce();
  expect(page.queryByRole('button', { name: 'lobby:onlineTakeoverApprove' })).toBeNull();
});

test('automatic and never policies expose no manual takeover action', () => {
  const page = render(<RecoveryPanel {...baseProps} policy={{ mode: 'auto', afterSeconds: 30 }} />);
  expect(page.getByText('lobby:onlineTakeoverAutoWaiting')).toBeTruthy();
  expect(page.queryByRole('button', { name: 'lobby:onlineTakeoverRequest' })).toBeNull();
  page.rerender(<RecoveryPanel {...baseProps} policy={{ mode: 'vote', afterSeconds: 'never' }} />);
  expect(page.container.textContent).toBe('');
});

test('local eligibility and a four-human roster gate the request button', async () => {
  const eligibility = vi.fn<() => Promise<Result<void>>>(async () =>
    failure('recovery-too-early', 'Wait for the full signed policy delay'),
  );
  const page = render(<RecoveryPanel {...baseProps} onEligibility={eligibility} />);
  await waitFor(() =>
    expect(page.getByRole('status').textContent).toBe('lobby:onlineTakeoverWaitingDelay'),
  );
  expect(page.queryByRole('button', { name: 'lobby:onlineTakeoverRequest' })).toBeNull();
  page.rerender(
    <RecoveryPanel {...baseProps} takeoverAvailable={false} onEligibility={eligibility} />,
  );
  expect(page.container.textContent).toBe('');
});

test('eligibility refresh stops when the panel closes', async () => {
  vi.useFakeTimers();
  const eligibility = vi.fn<() => Promise<Result<void>>>(async () => success(undefined));
  const page = render(<RecoveryPanel {...baseProps} onEligibility={eligibility} />);
  await act(async () => Promise.resolve());
  expect(eligibility).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(2_000));
  expect(eligibility).toHaveBeenCalledTimes(2);
  page.unmount();
  await act(async () => vi.advanceTimersByTime(4_000));
  expect(eligibility).toHaveBeenCalledTimes(2);
});

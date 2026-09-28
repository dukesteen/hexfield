/* eslint-disable no-await-in-loop -- Membership and game commands depend on prior certified state. */
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page, PlaywrightWorkerArgs } from '@playwright/test';
import { RandomBot, createBotRng } from '@cp2p/bots';
import { chooseBotPending } from '@cp2p/protocol';
import type { CommandShape, Seat } from '@cp2p/engine';
import { stableBotConfig } from './helpers/stable-bot-config.js';

test.skip(
  process.env.CP2P_MIXED_ENGINE_ACCEPTANCE !== '1',
  'Manual mixed-engine acceptance runs only from its opt-in workflow',
);

const signalingUrl = 'ws://127.0.0.1:8909';
const appBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_TEST_PORT ?? '5187'}`;
const engineNames = ['chromium-a', 'chromium-b', 'firefox', 'webkit'] as const;
type EngineName = (typeof engineNames)[number];
type Playwright = PlaywrightWorkerArgs['playwright'];
const registryPaths = new WeakMap<Page, string>();
const diagnosticKey = '__cp2pMixedEngineDiagnostics';

interface OpenedBrowserSet {
  readonly browsers: readonly Browser[];
  readonly contexts: readonly BrowserContext[];
  readonly pages: readonly Page[];
}

async function launchFourEngines(playwright: Playwright): Promise<OpenedBrowserSet> {
  const browsers: Browser[] = [];
  const contexts: BrowserContext[] = [];
  try {
    const chromium = await playwright.chromium.launch({ headless: true });
    browsers.push(chromium);
    const firefox = await playwright.firefox.launch({ headless: true });
    browsers.push(firefox);
    const webkit = await playwright.webkit.launch({ headless: true });
    browsers.push(webkit);
    const contextOptions = {
      baseURL: appBaseUrl,
      viewport: { width: 1280, height: 900 },
    } as const;
    const first = await chromium.newContext(contextOptions);
    contexts.push(first);
    const second = await chromium.newContext(contextOptions);
    contexts.push(second);
    const third = await firefox.newContext(contextOptions);
    contexts.push(third);
    const fourth = await webkit.newContext(contextOptions);
    contexts.push(fourth);
    await Promise.all(
      contexts.map(async (context) => {
        context.setDefaultTimeout(15_000);
        context.setDefaultNavigationTimeout(30_000);
        await context.addInitScript(() => performance.setResourceTimingBufferSize(5_000));
      }),
    );
    return {
      browsers,
      contexts,
      pages: await Promise.all(contexts.map((context) => context.newPage())),
    };
  } catch (error) {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    throw error;
  }
}

async function roomModulePath(page: Page): Promise<string> {
  const cached = registryPaths.get(page);
  if (cached) return cached;
  const path = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname.endsWith('/room-registry.ts')),
  );
  if (!path) throw new Error('The loaded app room registry is unavailable');
  const url = new URL(path);
  const loadedPath = url.pathname + url.search;
  registryPaths.set(page, loadedPath);
  return loadedPath;
}

async function installFailureDiagnostics(page: Page): Promise<void> {
  const modules = () =>
    page.evaluate(() => {
      const resources = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .map((name) => ({ name, path: new URL(name).pathname }));
      return {
        room: resources.find(({ path }) => /\/online-room\.(?:ts|js)$/.test(path))?.name ?? null,
        peerLink: resources.find(({ path }) => /\/peer-link\.(?:ts|js)$/.test(path))?.name ?? null,
        codec: resources.find(({ path }) => /\/canonical\.(?:ts|js)$/.test(path))?.name ?? null,
        envelope:
          resources.find(({ path }) => /\/signaling-envelope\.(?:ts|js)$/.test(path))?.name ?? null,
      };
    });
  try {
    await expect
      .poll(
        async () => {
          const paths = await modules();
          return Boolean(paths.room && paths.peerLink);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } catch {
    const filenames = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => new URL(entry.name).pathname.split('/').at(-1) ?? '')
        .filter(Boolean)
        .toSorted()
        .slice(-50),
    );
    throw new Error(
      `Mixed-engine diagnostics could not find the loaded room and peer modules after UI readiness; loaded module filenames: ${filenames.join(', ') || 'none'}`,
    );
  }
  const paths = await modules();
  if (!paths.room || !paths.peerLink)
    throw new Error('Mixed-engine diagnostic modules disappeared after they were loaded');
  await page.evaluate(
    async ({ roomPath, peerLinkPath, codecPath, envelopePath, key }) => {
      const record = (event: Record<string, unknown>) => {
        const current = Reflect.get(window, key);
        const events: Record<string, unknown>[] = Array.isArray(current) ? current : [];
        if (events.length >= 64) events.shift();
        events.push({ atMs: Math.round(performance.now()), ...event });
        Reflect.set(window, key, events);
      };
      let manualOpenStage: string | null = null;
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- This helper is serialized into the browser realm.
      const errorName = (error: unknown): string => {
        const name = error instanceof Error ? error.name : '';
        return [
          'Error',
          'TypeError',
          'RangeError',
          'ReferenceError',
          'SyntaxError',
          'AbortError',
          'DataError',
          'EncodingError',
          'InvalidAccessError',
          'InvalidStateError',
          'NetworkError',
          'NotReadableError',
          'NotSupportedError',
          'OperationError',
          'SecurityError',
          'TimeoutError',
        ].includes(name)
          ? name
          : 'OtherError';
      };
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- This helper is serialized into the browser realm.
      const errorCode = (error: unknown) => {
        const code =
          typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
        return typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
      };
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- The browser-evaluated callback must be self-contained.
      const safeError = async (error: unknown) => {
        const name = errorName(error);
        const domCode = errorCode(error);
        const message = error instanceof Error ? error.message : '';
        const knownReasons: readonly [RegExp, string][] = [
          [/Invalid signaling envelope body/i, 'invalid-signaling-envelope'],
          [/Peer is outside the active mesh roster/i, 'peer-outside-active-roster'],
          [/No signaling route to peer/i, 'no-signaling-route'],
          [/Signaling adapter is closed/i, 'signaling-adapter-closed'],
          [/Signaling send timed out/i, 'signaling-send-timeout'],
          [/Signaling send waiters are full/i, 'signaling-waiters-full'],
          [/Signaling send buffer is full/i, 'signaling-send-buffer-full'],
          [/Manual offer is outside the room roster/i, 'manual-offer-outside-roster'],
          [/Manual answer does not bind this invitation/i, 'manual-answer-binding'],
          [/Manual invitation was already used/i, 'manual-invitation-already-used'],
          [/Failed to set remote (?:offer|answer) sdp/i, 'remote-description-rejected'],
          [/setRemoteDescription/i, 'remote-description-rejected'],
          [/Canonical encoding accepts integers only/i, 'canonical-non-integer'],
          [/Canonical objects must contain enumerable data properties/i, 'canonical-accessor'],
          [/Canonical objects must be plain records/i, 'canonical-non-record'],
          [/Canonical arrays cannot have holes/i, 'canonical-sparse-array'],
          [/Canonical objects cannot contain symbol keys/i, 'canonical-symbol-key'],
          [/Canonical encoding does not accept cyclic values/i, 'canonical-cycle'],
          [/Unsupported canonical value/i, 'canonical-unsupported-value'],
          [/Canonical arrays must contain plain data elements/i, 'canonical-array-accessor'],
        ];
        const known = knownReasons.find(([pattern]) => pattern.test(message));
        if (known)
          return {
            name,
            ...(domCode === null ? {} : { domCode }),
            message: known[1],
          };
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
        return {
          name,
          ...(domCode === null ? {} : { domCode }),
          message: 'unclassified',
          fingerprint: [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, 16),
        };
      };
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep module URL resolution in the browser-evaluated callback.
      const moduleSpecifier = (path: string) => {
        const url = new URL(path);
        return url.pathname + url.search;
      };
      // oxlint-disable typescript/no-unsafe-type-assertion -- These imports resolve the app modules already loaded by this page.
      const { OnlineRoom } = (await import(
        /* @vite-ignore */ moduleSpecifier(roomPath)
      )) as typeof import('../src/session/online-room.js');
      const { PeerLink } = (await import(
        /* @vite-ignore */ moduleSpecifier(peerLinkPath)
      )) as typeof import('@cp2p/p2p');
      const codec = codecPath
        ? ((await import(
            /* @vite-ignore */ moduleSpecifier(codecPath)
          )) as typeof import('@cp2p/codec'))
        : null;
      const envelope = envelopePath
        ? ((await import(
            /* @vite-ignore */ moduleSpecifier(envelopePath)
          )) as typeof import('../../../packages/p2p/src/signaling-envelope.js'))
        : null;
      const canonicalEncode = codec?.canonicalEncode ?? null;
      const validSignalEnvelopeBody = envelope?.validSignalEnvelopeBody ?? null;

      const originalOpen = Reflect.get(OnlineRoom, 'open');
      if (typeof originalOpen !== 'function')
        throw new Error('OnlineRoom open method is unavailable to the test observer');
      OnlineRoom.open = async function (...args) {
        const request = args[0];
        const manualJoin =
          typeof request === 'object' &&
          request !== null &&
          Reflect.get(request, 'kind') === 'manual-join';
        if (manualJoin) manualOpenStage = 'decode-offer';
        try {
          const result = await Reflect.apply(originalOpen, this, args);
          if (manualJoin) record({ source: 'manual-open', stage: 'complete' });
          return result;
        } catch (error) {
          record({
            source: manualJoin ? 'manual-open' : 'room-open',
            ...(manualJoin ? { stage: manualOpenStage } : {}),
            error: await safeError(error),
          });
          throw error;
        } finally {
          if (manualJoin) manualOpenStage = null;
        }
      };

      const rtcPrototype = Reflect.get(RTCPeerConnection, 'prototype');
      for (const method of ['setRemoteDescription', 'setLocalDescription'] as const) {
        const original = Reflect.get(rtcPrototype, method);
        if (typeof original !== 'function') continue;
        Reflect.set(rtcPrototype, method, function (this: unknown, ...args: unknown[]) {
          if (manualOpenStage === null) return Reflect.apply(original, this, args);
          manualOpenStage =
            method === 'setRemoteDescription' ? 'set-remote-description' : 'set-local-description';
          try {
            return Promise.resolve(Reflect.apply(original, this, args)).then(
              (value: unknown) => {
                manualOpenStage =
                  method === 'setRemoteDescription'
                    ? 'remote-description-set'
                    : 'local-description-set';
                record({ source: 'manual-rtc', stage: method, outcome: 'fulfilled' });
                return value;
              },
              async (error: unknown) => {
                record({
                  source: 'manual-rtc',
                  stage: method,
                  outcome: 'rejected',
                  error: await safeError(error),
                });
                throw error;
              },
            );
          } catch (error) {
            void safeError(error)
              .then((safe) =>
                record({ source: 'manual-rtc', stage: method, outcome: 'threw', error: safe }),
              )
              .catch(() =>
                record({
                  source: 'manual-rtc',
                  stage: method,
                  outcome: 'threw',
                  error: { name: 'OtherError', message: 'diagnostic-capture-failed' },
                }),
              );
            throw error;
          }
        });
      }

      const prototype = Reflect.get(PeerLink, 'prototype');
      const originalSendSignal = Reflect.get(prototype, 'sendSignal');
      if (typeof originalSendSignal !== 'function')
        throw new Error('PeerLink signal method is unavailable to the test observer');
      Reflect.set(prototype, 'sendSignal', function (this: unknown, blob: unknown) {
        const options =
          typeof this === 'object' && this !== null ? Reflect.get(this, 'options') : null;
        if (typeof options !== 'object' || options === null)
          return Reflect.apply(originalSendSignal, this, [blob]);
        const originalSignal = Reflect.get(options, 'signal');
        if (typeof originalSignal !== 'function')
          return Reflect.apply(originalSendSignal, this, [blob]);
        const wrappedSignal = function (this: unknown, ...signalArgs: unknown[]) {
          // oxlint-disable-next-line unicorn/consistent-function-scoping -- The nested callback is serialized into the browser realm.
          const get = (value: unknown, property: string): unknown =>
            typeof value === 'object' && value !== null ? Reflect.get(value, property) : undefined;
          const description = get(blob, 'description');
          const candidate = get(blob, 'candidate');
          const sdp = get(description, 'sdp');
          const candidateText = get(candidate, 'candidate');
          // oxlint-disable-next-line unicorn/consistent-function-scoping -- This helper runs in the browser callback.
          const safeKeys = (value: unknown, allowed: readonly string[]) =>
            typeof value === 'object' && value !== null
              ? Object.keys(value)
                  .map((property) => (allowed.includes(property) ? property : 'other'))
                  .toSorted()
              : [];
          // oxlint-disable-next-line unicorn/consistent-function-scoping -- This helper runs in the browser callback.
          const safeInteger = (value: unknown) =>
            typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
          let canonicalFailure: string | null = null;
          if (typeof canonicalEncode === 'function') {
            try {
              canonicalEncode(blob);
            } catch (error) {
              const message = error instanceof Error ? error.message : '';
              const reasons: readonly [RegExp, string][] = [
                [/integers only/i, 'canonical-non-integer'],
                [/plain records/i, 'canonical-non-record'],
                [/symbol keys/i, 'canonical-symbol-key'],
                [/cyclic values/i, 'canonical-cycle'],
                [/unsupported canonical value/i, 'canonical-unsupported-value'],
                [/enumerable data properties/i, 'canonical-accessor'],
                [/plain data elements/i, 'canonical-array-accessor'],
                [/holes/i, 'canonical-sparse-array'],
              ];
              canonicalFailure =
                reasons.find(([pattern]) => pattern.test(message))?.[1] ?? 'canonical-other';
            }
          }
          const scope = get(options, 'scope');
          const from = get(options, 'self');
          const to = get(options, 'peer');
          let blobValidWithSyntheticEnvelope: boolean | null = null;
          if (typeof validSignalEnvelopeBody === 'function') {
            try {
              blobValidWithSyntheticEnvelope = validSignalEnvelopeBody({
                version: 2,
                scope,
                from,
                to,
                attemptId: 'AQEBAQEBAQEBAQEBAQEBAQ',
                sessionId: 'AwMDAwMDAwMDAwMDAwMDAw',
                attemptSeq: 1,
                blob,
              });
            } catch {
              blobValidWithSyntheticEnvelope = false;
            }
          }
          const metadata = {
            kind: get(blob, 'kind') ?? null,
            blobKeys: safeKeys(blob, [
              'kind',
              'generation',
              'revision',
              'description',
              'candidate',
              'inReplyTo',
            ]),
            generation: safeInteger(get(blob, 'generation')),
            revision: safeInteger(get(blob, 'revision')),
            inReplyTo: safeInteger(get(blob, 'inReplyTo')),
            descriptionType: get(description, 'type') ?? null,
            descriptionKeys: safeKeys(description, ['type', 'sdp']),
            sdpLength: typeof sdp === 'string' ? sdp.length : null,
            candidateLength: typeof candidateText === 'string' ? candidateText.length : null,
            candidateKeys: safeKeys(candidate, [
              'candidate',
              'sdpMid',
              'sdpMLineIndex',
              'usernameFragment',
            ]),
            canonicalFailure,
            blobValidWithSyntheticEnvelope,
          };
          try {
            if (get(blob, 'kind') === 'description')
              record({
                source: 'signal-description',
                from: typeof from === 'string' ? from.slice(0, 12) : null,
                to: typeof to === 'string' ? to.slice(0, 12) : null,
                ...metadata,
              });
            const sent = Reflect.apply(originalSignal, this, signalArgs);
            return Promise.resolve(sent).catch(async (error: unknown) => {
              record({
                source: 'signal-callback',
                stage: 'rejected',
                ...metadata,
                error: await safeError(error),
              });
              throw error;
            });
          } catch (error) {
            void safeError(error)
              .then((safe) => {
                record({ source: 'signal-callback', stage: 'threw', ...metadata, error: safe });
                return undefined;
              })
              .catch(() => {
                record({
                  source: 'signal-callback',
                  stage: 'threw',
                  ...metadata,
                  error: { name: 'OtherError', message: 'diagnostic-capture-failed' },
                });
                return undefined;
              });
            throw error;
          }
        };
        Reflect.set(options, 'signal', wrappedSignal);
        try {
          return Reflect.apply(originalSendSignal, this, [blob]);
        } finally {
          if (Reflect.get(options, 'signal') === wrappedSignal)
            Reflect.set(options, 'signal', originalSignal);
        }
      });
    },
    {
      roomPath: paths.room,
      peerLinkPath: paths.peerLink,
      codecPath: paths.codec,
      envelopePath: paths.envelope,
      key: diagnosticKey,
    },
  );
}

async function readRoom(page: Page, includePeerStats = false) {
  const path = await roomModulePath(page);
  return page.evaluate(
    async ({ modulePath, includePeerStats: readPeerStats }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Import the registry module actually loaded by this browser context.
      const { getOnlineRoom, getOnlineGameRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const diagnosticEvents = Reflect.get(window, '__cp2pMixedEngineDiagnostics');
      const route = location.hash.split('?')[0] ?? '';
      const pageEvidence = {
        route: `${location.origin}${location.pathname}${route}`,
        alerts: [...document.querySelectorAll('[role="alert"]')]
          .map((element) => element.textContent?.trim() ?? '')
          .filter(Boolean)
          .slice(0, 4),
        diagnosticEvents: Array.isArray(diagnosticEvents) ? diagnosticEvents : [],
      };
      const lobbyId = route.match(/\/lobby\/([^/]+)/)?.[1];
      const gameId = route.match(/\/game\/([^/]+)/)?.[1];
      const room = gameId ? getOnlineGameRoom(gameId) : getOnlineRoom(lobbyId ?? '');
      if (!room) return { ...pageEvidence, roomOpen: false, humanCount: 0, peerCount: 0 };
      const snapshot = room.getSnapshot();
      const session = room.getGame()?.session;
      const peerStats = readPeerStats ? await room.getPeerStats?.().catch(() => []) : [];
      // Address-free state for unfinished links is absent from authenticated
      // peer stats. Read it only in diagnostics; never change transport state.
      const transport = readPeerStats ? Reflect.get(room, 'transport') : null;
      const unfinishedLinks = ['links', 'pendingLinks'].flatMap((slot) => {
        const links = transport ? Reflect.get(transport, slot) : null;
        if (!(links instanceof Map)) return [];
        return [...links].map(([peer, item]) => {
          const link = Reflect.get(item, 'link');
          const pc = Reflect.get(link, 'pc');
          return {
            peer: typeof peer === 'string' ? peer.slice(0, 12) : null,
            slot,
            authenticated: Reflect.get(link, 'isAuthenticated'),
            connection: Reflect.get(pc, 'connectionState'),
            ice: Reflect.get(pc, 'iceConnectionState'),
            signaling: Reflect.get(pc, 'signalingState'),
            localRevision: Reflect.get(link, 'localRevision'),
            remoteRevision: Reflect.get(link, 'remoteRevision'),
            queuedDescriptions: Reflect.get(link, 'pendingDescriptions'),
          };
        });
      });
      return {
        ...pageEvidence,
        roomOpen: true,
        peerCount: snapshot.peers.length,
        connectionError: snapshot.connectionError,
        diagnostic: snapshot.diagnostic,
        signalingState: snapshot.signaling.state,
        peerStates:
          peerStats?.map(({ state, route: peerRoute }) => ({ state, route: peerRoute })) ?? [],
        unfinishedLinks,
        startup: snapshot.startup?.phase ?? null,
        lobbyStatus: snapshot.lobby?.status ?? null,
        humanCount: snapshot.lobby?.seats.filter((seat) => seat.kind === 'human').length ?? 0,
        manual: {
          phase: snapshot.manual.phase,
          gatheringComplete: snapshot.manual.gatheringComplete,
          hasCode: snapshot.manual.code !== null,
        },
        closed: snapshot.closed,
        game: session
          ? {
              head: session.getFairness?.()?.head ?? null,
              phase: session.getState().turn.phase.at(-1)?.id ?? null,
              turn: session.getState().turn.number,
              activeSeat: session.getState().turn.activeSeat,
              controlledSeats: session.controllableSeats(),
              pending: session
                .getPending()
                .map((item) =>
                  item.kind === 'player'
                    ? { kind: item.kind, seat: item.seat, allowed: item.allowed }
                    : { kind: item.kind },
                ),
              audit: session.getAudit?.().kind ?? null,
            }
          : null,
      };
    },
    { modulePath: path, includePeerStats },
  );
}

async function navigateToInviteWithinDocument(page: Page, invitation: string): Promise<void> {
  const target = new URL(invitation);
  const current = await page.evaluate(() => ({
    origin: location.origin,
    pathname: location.pathname,
  }));
  if (target.origin !== current.origin || target.pathname !== current.pathname)
    throw new Error('Invitation URL would leave the current app document');
  await page.evaluate((hash) => {
    location.hash = hash;
  }, target.hash);
}

async function getManualInvitation(page: Page, peer?: string): Promise<string> {
  const path = await roomModulePath(page);
  const result = await page.evaluate(
    async ({ modulePath, target }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- This is the running room registry, used only to drive the genuine public room method.
      const { getOnlineRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const roomId = new URL(location.href).hash.match(/\/lobby\/([^/?]+)/)?.[1];
      const room = roomId ? getOnlineRoom(roomId) : null;
      if (!room) throw new Error('The host lobby is not open');
      if (!room.startManualInvitation) throw new Error('Manual invitation is unavailable');
      const created = await room.startManualInvitation(target ?? undefined);
      if (!created.ok) throw new Error(`Manual offer failed: ${created.error.code}`);
      return created.value;
    },
    { modulePath: path, target: peer ?? null },
  );
  const final = await manualOfferState(page);
  if (
    !final ||
    !final.code ||
    final.code !== result.code ||
    typeof final.gatheringComplete !== 'boolean'
  )
    throw new Error('Manual room snapshot did not retain the gathered offer');
  return final.code;
}

async function manualOfferState(page: Page) {
  const path = await roomModulePath(page);
  return page.evaluate(async (modulePath) => {
    // oxlint-disable typescript/no-unsafe-type-assertion -- Read public bootstrap progress from the current room only.
    const { getOnlineRoom } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('../src/features/online/room-registry.js');
    // oxlint-enable typescript/no-unsafe-type-assertion
    const roomId = new URL(location.href).hash.match(/\/lobby\/([^/?]+)/)?.[1];
    const room = roomId ? getOnlineRoom(roomId) : null;
    return room?.getSnapshot().manual ?? null;
  }, path);
}

async function acceptManualAnswer(inviter: Page, code: string): Promise<void> {
  const path = await roomModulePath(inviter);
  const result = await inviter.evaluate(
    async ({ modulePath, answer }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Call the app's public manual-answer API on its active room.
      const { getOnlineRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const roomId = new URL(location.href).hash.match(/\/lobby\/([^/?]+)/)?.[1];
      const room = roomId ? getOnlineRoom(roomId) : null;
      if (!room) throw new Error('The inviter lobby is not open');
      if (!room.acceptManualAnswer) throw new Error('Manual answer is unavailable');
      const accepted = await room.acceptManualAnswer(answer);
      return accepted.ok ? null : accepted.error.code;
    },
    { modulePath: path, answer: code },
  );
  if (result) throw new Error(`Manual answer rejected: ${result}`);
}

async function startFourPlayerRoom(pages: readonly Page[], mode: 'signaling' | 'manual') {
  const [host, ...guests] = pages;
  if (!host || guests.length !== 3) throw new Error('Expected four isolated browser pages');
  const gameName = mode === 'signaling' ? 'Mixed signaling acceptance' : 'Mixed manual acceptance';
  await host.goto('/#/online/create');
  await expect(host.getByLabel('Room name', { exact: true })).toBeVisible();
  await installFailureDiagnostics(host);
  await host.getByLabel('Room name', { exact: true }).fill(gameName);
  await host.getByLabel('Your player name', { exact: true }).fill('Player 1');
  await host.getByText('Advanced connection options', { exact: true }).click();
  await host.getByLabel('Player count').selectOption('4');
  await host.getByLabel('Victory points to win', { exact: true }).fill('3');
  await host
    .getByLabel('Invite friends with')
    .selectOption(mode === 'signaling' ? 'server' : 'manual');
  if (mode === 'signaling')
    await host.getByLabel('Custom room server', { exact: true }).fill(signalingUrl);
  await host.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(host.getByRole('heading', { name: gameName })).toBeVisible();

  if (mode === 'signaling') {
    const invite = await host.getByRole('textbox', { name: /^Invitation link/ }).inputValue();
    for (const guest of guests) {
      await guest.goto('/#/join');
      await expect(guest.getByLabel('Invitation link or code', { exact: true })).toBeVisible();
      await installFailureDiagnostics(guest);
      await navigateToInviteWithinDocument(guest, invite);
      await expect(guest.getByRole('heading', { name: gameName })).toBeVisible({ timeout: 45_000 });
      await guest.getByRole('button', { name: 'Take seat', exact: true }).first().click();
    }
  } else {
    for (const guest of guests) {
      await guest.goto('/#/join');
      await expect(guest.getByLabel('Invitation link or code', { exact: true })).toBeVisible();
      await installFailureDiagnostics(guest);
      const invite = await getManualInvitation(host);
      await guest.getByLabel('Invitation link or code', { exact: true }).fill(invite);
      await guest.getByRole('button', { name: 'Join room', exact: true }).click();
      await expect(guest).toHaveURL(/\/lobby\/[^/]+$/, { timeout: 45_000 });
      await expect
        .poll(async () => {
          const state = await manualOfferState(guest);
          return typeof state?.code === 'string' && typeof state.gatheringComplete === 'boolean';
        })
        .toBe(true);
      const answer = (await manualOfferState(guest))?.code;
      if (!answer) throw new Error('A joined guest did not produce its manual answer');
      await acceptManualAnswer(host, answer);
      await expect(guest.getByRole('heading', { name: gameName })).toBeVisible({ timeout: 45_000 });
      await guest.getByRole('button', { name: 'Take seat', exact: true }).first().click();
      await expect
        .poll(async () => {
          const state = await readRoom(host);
          return state.roomOpen ? state.humanCount : 0;
        })
        .toBeGreaterThan(1);
    }
  }

  await expect
    .poll(
      async () =>
        Promise.all(
          pages.map(async (page) => {
            const state = await readRoom(page);
            return state.roomOpen ? state.peerCount : 0;
          }),
        ),
      // Allow the production 30s attempt, 250ms retry and 10s HELLO window.
      // The overall test and subsequent play/audit limits stay unchanged.
      { timeout: 45_000, intervals: [100] },
    )
    .toEqual([3, 3, 3, 3]);
  await Promise.all(pages.map((page) => page.getByRole('button', { name: 'Ready up' }).click()));
  await expect(host.getByRole('button', { name: 'Start game', exact: true })).toBeEnabled({
    timeout: 45_000,
  });
  await host.getByRole('button', { name: 'Start game', exact: true }).click();
  await Promise.all(
    pages.map((page) => expect(page).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 })),
  );
  const gameId = new URL(host.url()).hash.match(/\/game\/([^/?]+)/)?.[1];
  if (!gameId) throw new Error('Game URL did not include an id');
  return { gameId, gameName };
}

async function inspectGame(page: Page, gameId: string) {
  const modulePath = await roomModulePath(page);
  const view = await page.evaluate(
    async ({ path, id }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Read the session from the app-loaded production registry.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ path
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const room = getOnlineGameRoom(id);
      const session = room?.getGame()?.session;
      if (!room || !session) return null;
      const seat = session.controllableSeats()[0];
      const legal = seat === undefined ? undefined : session.getLegalCommands(seat);
      return {
        head: session.getFairness?.()?.head ?? null,
        phase: session.getState().turn.phase.at(-1)?.id ?? null,
        result: session.getState().result ?? null,
        seat,
        pending: session.getPending(),
        state: session.getState(),
        privateState: seat === undefined ? null : session.getPrivate(seat),
        legal,
        audit: session.getAudit?.() ?? null,
        peerCount: room.getSnapshot().peers.length,
      };
    },
    { path: modulePath, id: gameId },
  );
  return view
    ? {
        ...view,
        pending: chooseBotPending(
          view.state,
          view.pending,
          new Set(view.seat === undefined ? [] : [view.seat]),
        ),
      }
    : null;
}

async function submit(page: Page, gameId: string, seat: Seat, command: CommandShape, seq: number) {
  const modulePath = await roomModulePath(page);
  return page.evaluate(
    async ({ path, id, actingSeat, action, revision }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Submit a legal action through the actual online session.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ path
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const session = getOnlineGameRoom(id)?.getGame()?.session;
      if (!session) throw new Error('The online session is unavailable');
      const result = await session.submit(actingSeat, action, { expectedRevision: revision });
      return result.ok ? null : result.error.code;
    },
    { path: modulePath, id: gameId, actingSeat: seat, action: command, revision: seq },
  );
}

async function certifyPostSetupMove(pages: readonly Page[], gameId: string): Promise<void> {
  const ready = async () => Promise.all(pages.map((page) => inspectGame(page, gameId)));
  const setupBots = pages.map((_, index) => ({
    bot: new RandomBot(),
    state: stableBotConfig(),
    rng: createBotRng(new Uint8Array(32).fill(index + 101)),
  }));
  await expect
    .poll(
      async () => {
        const views = await ready();
        // Setup ends in preRoll. This driver submits the first roll below;
        // waiting for main here would wait for a command it never sends.
        if (views.every((item) => item?.phase === 'preRoll')) return true;
        const index = views.findIndex(
          (item) => item?.phase === 'setup' && item.pending?.kind === 'player' && item.legal,
        );
        if (index < 0) return false;
        const view = views[index];
        const actor = setupBots[index];
        const page = pages[index];
        if (
          view?.seat === undefined ||
          !view.pending ||
          !view.privateState ||
          !view.legal ||
          !view.head ||
          !actor ||
          !page
        )
          return false;
        const command = actor.bot.decide(
          { state: actor.state(view.state), priv: view.privateState, seat: view.seat },
          view.pending,
          actor.rng,
        );
        const refused = await submit(page, gameId, view.seat, command, view.head.seq);
        if (refused && refused !== 'stale-head' && refused !== 'stale-revision')
          throw new Error(`A legal setup placement was rejected: ${refused}`);
        return false;
      },
      {
        timeout: 120_000,
        intervals: [100],
      },
    )
    .toBe(true);
  const views = await ready();
  const before = views[0]?.head;
  if (!before) throw new Error('No certified head after setup');
  let accepted = false;
  for (const [index, view] of views.entries()) {
    if (!view?.pending || view.seat === undefined || !view.legal) continue;
    const command = view.legal.commands.find((item) => item.type !== 'END_TURN');
    if (!command) continue;
    const page = pages[index];
    if (!page) throw new Error('Post-setup actor page disappeared');
    const refused = await submit(page, gameId, view.seat, command, before.seq);
    if (refused) throw new Error(`Post-setup move rejected: ${refused}`);
    accepted = true;
    break;
  }
  if (!accepted) throw new Error('No non-END_TURN main-phase move was available');
  await expect
    .poll(
      async () => {
        const heads = (await ready()).map((item) => item?.head);
        const seq = heads[0]?.seq;
        return seq !== undefined && seq > before.seq && heads.every((head) => head?.seq === seq);
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  const after = await ready();
  const afterHead = after[0]?.head;
  if (!afterHead || afterHead.seq <= before.seq)
    throw new Error('Post-setup action did not advance the head');
  expect(after.map((item) => item?.head)).toEqual([afterHead, afterHead, afterHead, afterHead]);
}

async function finishAndAudit(pages: readonly Page[], gameId: string) {
  const bots = pages.map((_, index) => ({
    bot: new RandomBot(),
    state: stableBotConfig(),
    rng: createBotRng(new Uint8Array(32).fill(index + 31)),
  }));
  let commands = 0;
  const started = Date.now();
  let terminalAt: number | undefined;
  const accepted: Record<string, number> = {};
  const refusedCommands: Record<string, number> = {};
  const diagnostic = () => ({
    commands,
    accepted,
    refusedCommands,
    playElapsedMs: (terminalAt ?? Date.now()) - started,
    auditElapsedMs: terminalAt === undefined ? 0 : Date.now() - terminalAt,
  });
  try {
    await expect
      .poll(
        async () => {
          for (const [index, page] of pages.entries()) {
            const view = await inspectGame(page, gameId);
            if (
              !view ||
              view.result ||
              view.seat === undefined ||
              view.pending?.kind !== 'player' ||
              !view.privateState ||
              !view.legal ||
              !view.head
            )
              continue;
            const actor = bots[index];
            if (!actor) throw new Error('Missing deterministic browser bot');
            const command = actor.bot.decide(
              { state: actor.state(view.state), priv: view.privateState, seat: view.seat },
              view.pending,
              actor.rng,
            );
            const refused = await submit(page, gameId, view.seat, command, view.head.seq);
            if (refused) refusedCommands[refused] = (refusedCommands[refused] ?? 0) + 1;
            if (refused && refused !== 'stale-head' && refused !== 'stale-revision')
              throw new Error(`A legal browser move was rejected: ${refused}`);
            if (!refused) {
              commands += 1;
              accepted[command.type] = (accepted[command.type] ?? 0) + 1;
            }
            if (commands > 300) throw new Error('The bounded mixed-engine game exceeded 300 moves');
          }
          const views = await Promise.all(pages.map((page) => inspectGame(page, gameId)));
          if (views.every((view) => view?.result)) terminalAt ??= Date.now();
          return views.every((view) => view?.result && view.audit?.kind === 'complete');
        },
        { timeout: 150_000, intervals: [100] },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(`Mixed-engine play/audit driver: ${JSON.stringify(diagnostic())}`, {
      cause: error,
    });
  }
  const final = await Promise.all(pages.map((page) => inspectGame(page, gameId)));
  const head = final[0]?.head;
  const result = final[0]?.result;
  if (!head || !result) throw new Error('Missing audited terminal state');
  for (const view of final) {
    expect(view?.head).toEqual(head);
    expect(view?.result).toEqual(result);
    expect(view?.audit).toMatchObject({ kind: 'complete', report: { ok: true, complete: true } });
    expect(view?.peerCount).toBe(3);
  }
  return { ...diagnostic(), terminalSeq: head.seq, modeAuditCount: final.length };
}

async function runMode(playwright: Playwright, mode: 'signaling' | 'manual') {
  const opened = await launchFourEngines(playwright);
  const [host, second, third, fourth] = opened.pages;
  if (!host || !second || !third || !fourth) throw new Error('Missing mixed-engine page');
  const errors: EngineName[] = [];
  for (const [index, page] of opened.pages.entries()) {
    const engine = engineNames[index];
    if (!engine) throw new Error('Missing browser engine label');
    page.on('pageerror', () => errors.push(engine));
  }
  const started = Date.now();
  let phase = 'lobby';
  let readingProgress = false;
  // A runner-level timeout can interrupt the catch block itself. Retain public
  // progress during the run, without private hands, SDP, candidates or keys.
  const progress = setInterval(() => {
    if (readingProgress) return;
    readingProgress = true;
    void Promise.all(
      opened.pages.map(async (page, index) => ({
        engine: engineNames[index],
        ...(await readRoom(page, true).catch(() => ({ unavailable: true }))),
      })),
    )
      .then((peers) => {
        process.stdout.write(
          `${JSON.stringify({ mode, phase, elapsedMs: Date.now() - started, peers })}\n`,
        );
        return undefined;
      })
      .finally(() => {
        readingProgress = false;
      });
  }, 10_000);
  try {
    const fixture = await startFourPlayerRoom(opened.pages, mode);
    const lobbyElapsedMs = Date.now() - started;
    phase = 'setup';
    const setupStarted = Date.now();
    await certifyPostSetupMove(opened.pages, fixture.gameId);
    const setupElapsedMs = Date.now() - setupStarted;
    phase = 'play-and-audit';
    const completion = await finishAndAudit(opened.pages, fixture.gameId);
    expect(errors).toEqual([]);
    return { mode, browserSet: engineNames, lobbyElapsedMs, setupElapsedMs, ...completion };
  } catch (error) {
    const diagnostics = await Promise.all(
      opened.pages.map(async (page, index) => ({
        engine: engineNames[index],
        ...(await readRoom(page, true).catch(() => null)),
      })),
    );
    throw new Error(
      `Mixed-engine ${mode} acceptance failed. Sanitized peer/lobby diagnostics: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  } finally {
    clearInterval(progress);
    await Promise.allSettled(opened.contexts.map((context) => context.close()));
    await Promise.allSettled(opened.browsers.map((browser) => browser.close()));
  }
}

test('four mixed-engine contexts finish a signaling full-mesh game with matching audits', async ({
  playwright,
}, testInfo) => {
  test.skip(
    process.env.CP2P_MIXED_ENGINE_MODE !== 'signaling',
    'The workflow runs one connection mode per job',
  );
  test.setTimeout(240_000);
  const result = await runMode(playwright, 'signaling');
  await testInfo.attach('mixed-engine-summary', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
});

test('four mixed-engine contexts finish a manual-relay full-mesh game with matching audits', async ({
  playwright,
}, testInfo) => {
  test.skip(
    process.env.CP2P_MIXED_ENGINE_MODE !== 'manual-relay',
    'The workflow runs one connection mode per job',
  );
  test.setTimeout(300_000);
  const result = await runMode(playwright, 'manual');
  await testInfo.attach('mixed-engine-summary', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
});

Read-only security/code review of the attached source-only delta. Do not use tools or infer from unavailable runtime secrets. A returning human device can hold a valid certified journal prefix with different valid quorum certificate bytes than the source activation bootstrap. The change compares signed entry hashes after independently replaying both histories, retains local certificate wrappers, appends only a verified suffix, and permits a pre-removal old active safety under a game-wide promotion lease. A post-removal old record must have a certified retired marker. Also review the PeerLink guard for duplicate/delayed answers after stable. Focus on concrete authority, fork, CAS, transaction, old-key revival, rollback, proof, and signaling-generation bypasses. Distinguish exploitable defects from test gaps. Cite file/function/line and the smallest corrective action. Do not recommend weakening certified replay, signer binding, or fresh safety. Ignore unrelated product scope.

DIFF
diff --git a/apps/web/src/session/online-transfer-destination.test.ts b/apps/web/src/session/online-transfer-destination.test.ts
index d999034..b631d35 100644
--- a/apps/web/src/session/online-transfer-destination.test.ts
+++ b/apps/web/src/session/online-transfer-destination.test.ts
@@ -551,221 +551,259 @@ test('certified cancellation crosses ordinary children after the local refresh b
   identity.dispose();
 }, 120_000);
 
-test('returned human promotes over the same device only after its old journal retired', async () => {
-  installFactory();
-  const fixture = createRecoveryFixture({ masterBackedBeacon: true, lobbyId: 'returnroom' });
-  const record = publicRecord(fixture);
-  const oldGameKey = recoveryFixtureKey(fixture, 0);
-  const oldDevice = identityFromSecret(
-    hashValue({
-      domain: 'cp2p/test/online-device/v1',
-      gamePeer: fixture.genesis.seats[0]?.publicKey,
-    }),
-  );
-  const identity = {
-    ...oldDevice,
-    dispose() {
-      this.secretKey.fill(0);
-    },
-  };
-  const bot = identityFromSecret(new Uint8Array(32).fill(81));
-  const recoveryStatement = recoveryFixtureReadiness(fixture, fixture.ready, bot.peerId);
-  const recoveryAuthorization = signRecoveryFixtureAuthorization(
-    fixture,
-    recoveryStatement,
-    bot.secretKey,
-  );
-  const recoveryAuthEntry = signRecoveryFixtureEntry(
-    fixture,
-    fixture.ready,
-    { kind: 'membership', change: recoveryAuthorization },
-    fixture.ready.log.head.stateHash,
-  );
-  const recoveryAuth = certifyRecoveryFixtureEntry(
-    fixture,
-    fixture.ready,
-    recoveryAuthEntry,
-    [1, 2, 3],
-  );
-  const recoveryPending = advanceRecoveryFixture(fixture.ready, recoveryAuth);
-  const recoveryActivation = signRecoveryFixtureActivation(
-    fixture,
-    recoveryPending,
-    recoveryAuthEntry,
-  );
-  const botStatus = value(
-    fixture.source.engine.apply(recoveryPending.log.state, {
-      kind: 'system',
-      type: 'SEAT_STATUS',
-      seat: 0,
-      status: 'bot',
-    }),
-  );
-  const recoveryActivationEntry = signRecoveryFixtureEntry(
-    fixture,
-    recoveryPending,
-    { kind: 'membership', change: recoveryActivation },
-    toHex(hashValue(botStatus.state)),
-  );
-  const recoveryActivated = certifyRecoveryFixtureEntry(
-    fixture,
-    recoveryPending,
-    recoveryActivationEntry,
-    [1, 2, 3],
-  );
-  const recovered = advanceRecoveryFixture(recoveryPending, recoveryActivated);
-  expect(recovered.log.authority?.controllers[0]).toMatchObject({
-    kind: 'bot',
-    publicKey: bot.peerId,
-  });
-
-  // Preserve the real former-human binding and certified removal history. We
-  // deliberately delay its retired marker to prove promotion refuses that gap.
-  const oldBinding = canonicalEncode({
-    protocol: 'online-game-keys-v1',
-    genesisDigest: record.genesisDigest,
-    devicePeer: oldDevice.peerId,
-    humanSeat: 0,
-    seats: [
-      {
+test.each(['pre-removal', 'retired'] as const)(
+  'returned human promotes over a valid %s journal on the same device',
+  async (oldJournalPhase) => {
+    installFactory();
+    const fixture = createRecoveryFixture({ masterBackedBeacon: true, lobbyId: 'returnroom' });
+    const record = publicRecord(fixture);
+    const oldGameKey = recoveryFixtureKey(fixture, 0);
+    const oldDevice = identityFromSecret(
+      hashValue({
+        domain: 'cp2p/test/online-device/v1',
+        gamePeer: fixture.genesis.seats[0]?.publicKey,
+      }),
+    );
+    const identity = {
+      ...oldDevice,
+      dispose() {
+        this.secretKey.fill(0);
+      },
+    };
+    const bot = identityFromSecret(new Uint8Array(32).fill(81));
+    const recoveryStatement = recoveryFixtureReadiness(fixture, fixture.ready, bot.peerId);
+    const recoveryAuthorization = signRecoveryFixtureAuthorization(
+      fixture,
+      recoveryStatement,
+      bot.secretKey,
+    );
+    const recoveryAuthEntry = signRecoveryFixtureEntry(
+      fixture,
+      fixture.ready,
+      { kind: 'membership', change: recoveryAuthorization },
+      fixture.ready.log.head.stateHash,
+    );
+    const recoveryAuth = certifyRecoveryFixtureEntry(
+      fixture,
+      fixture.ready,
+      recoveryAuthEntry,
+      [1, 2, 3],
+    );
+    const recoveryPending = advanceRecoveryFixture(fixture.ready, recoveryAuth);
+    const recoveryActivation = signRecoveryFixtureActivation(
+      fixture,
+      recoveryPending,
+      recoveryAuthEntry,
+    );
+    const botStatus = value(
+      fixture.source.engine.apply(recoveryPending.log.state, {
+        kind: 'system',
+        type: 'SEAT_STATUS',
         seat: 0,
-        kind: 'human',
-        peerId: fixture.genesis.seats[0]?.publicKey,
-        signingKey: oldGameKey,
-        master: scalarToBytes(17n),
+        status: 'bot',
+      }),
+    );
+    const recoveryActivationEntry = signRecoveryFixtureEntry(
+      fixture,
+      recoveryPending,
+      { kind: 'membership', change: recoveryActivation },
+      toHex(hashValue(botStatus.state)),
+    );
+    const recoveryActivated = certifyRecoveryFixtureEntry(
+      fixture,
+      recoveryPending,
+      recoveryActivationEntry,
+      [1, 2, 3],
+    );
+    const recovered = advanceRecoveryFixture(recoveryPending, recoveryActivated);
+    expect(recovered.log.authority?.controllers[0]).toMatchObject({
+      kind: 'bot',
+      publicKey: bot.peerId,
+    });
+
+    // Preserve the real former-human binding and certified removal history. We
+    // deliberately delay its retired marker to prove promotion refuses that gap.
+    const oldBinding = canonicalEncode({
+      protocol: 'online-game-keys-v1',
+      genesisDigest: record.genesisDigest,
+      devicePeer: oldDevice.peerId,
+      humanSeat: 0,
+      seats: [
+        {
+          seat: 0,
+          kind: 'human',
+          peerId: fixture.genesis.seats[0]?.publicKey,
+          signingKey: oldGameKey,
+          master: scalarToBytes(17n),
+        },
+      ],
+    });
+    const priorSafety = value(createConsensusState(fixture.ready, 0));
+    const retired = value(createRetiredSafety(fixture.ready, recoveryAuth, 0, priorSafety));
+    const oldEntries =
+      oldJournalPhase === 'pre-removal'
+        ? [...fixture.deckEntries]
+        : [...fixture.deckEntries, recoveryAuth];
+    const first = oldEntries[0];
+    if (!first || first.certificate.length < 4) throw new Error('Four-voter certificate missing');
+    const alternateFirst = { ...first, certificate: first.certificate.slice(0, 3) };
+    expect(entryHash(alternateFirst.entry)).toBe(entryHash(first.entry));
+    expect(canonicalEncode(alternateFirst)).not.toEqual(canonicalEncode(first));
+    const oldJournal = new IndexedDbProtocolJournal(record.gameId, {
+      keyBinding: {
+        recordKey: `online-game/${record.genesisDigest}/keys`,
+        bytes: oldBinding,
       },
-    ],
-  });
-  const priorSafety = value(createConsensusState(fixture.ready, 0));
-  const retired = value(createRetiredSafety(fixture.ready, recoveryAuth, 0, priorSafety));
-  const oldEntries = [...fixture.deckEntries, recoveryAuth];
-  const oldJournal = new IndexedDbProtocolJournal(record.gameId, {
-    keyBinding: {
-      recordKey: `online-game/${record.genesisDigest}/keys`,
-      bytes: oldBinding,
-    },
-  });
-  expect(await oldJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
-  for (const certified of oldEntries)
-    // oxlint-disable-next-line no-await-in-loop -- Build one exact certified retired source journal.
-    expect(await oldJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(true);
-  await oldJournal.close();
+    });
+    expect(await oldJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
+    for (const certified of [alternateFirst, ...oldEntries.slice(1)])
+      // oxlint-disable-next-line no-await-in-loop -- Build one exact certified retired source journal.
+      expect(await oldJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(
+        true,
+      );
+    await oldJournal.close();
 
-  const store = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
-  const imports = new TransferImportStore(store);
-  const expected = { gameId: record.gameId, genesisDigest: record.genesisDigest };
-  const entries = [...oldEntries, recoveryActivated];
-  const participant = await OnlineTransferDestination.create({
-    attemptId: toBase64Url(new Uint8Array(32).fill(7)),
-    mode: 'new',
-    expected,
-    identity,
-    store,
-    importStore: imports,
-    bootstrapBytes: value(encodeOnlineTransferBootstrap({ start: record, entries })),
-  });
-  const offer = await participant.prepareOffer({ seat: 0, mode: 'return' });
-  const returnAuthorization = {
-    ...offer,
-    returnIntent: {
-      signer: 'last-human-game-key' as const,
-      sig: signObject('seat-transfer-return-intent-v1', offer.statement, oldGameKey),
-    },
-  };
-  const transferAuthEntry = signRecoveryFixtureEntry(
-    fixture,
-    recovered,
-    { kind: 'membership', change: returnAuthorization },
-    recovered.log.head.stateHash,
-  );
-  const transferAuth = certifyRecoveryFixtureEntry(
-    fixture,
-    recovered,
-    transferAuthEntry,
-    [1, 2, 3],
-  );
-  const transferPending = advanceRecoveryFixture(recovered, transferAuth);
-  entries.push(transferAuth);
-  await participant.refreshBootstrap(
-    value(encodeOnlineTransferBootstrap({ start: record, entries })),
-  );
-  const sourceJournal = new MemoryProtocolJournal();
-  expect(await sourceJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
-  for (const certified of entries)
-    // oxlint-disable-next-line no-await-in-loop -- Preserve the real certified source ancestry.
-    expect(await sourceJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(
-      true,
+    if (oldJournalPhase === 'pre-removal') {
+      const saved = new IndexedDbProtocolJournal(record.gameId, {
+        keyBinding: {
+          recordKey: `online-game/${record.genesisDigest}/keys`,
+          bytes: oldBinding,
+        },
+      });
+      const current = await saved.load();
+      if (!current) throw new Error('Former voter journal is missing');
+      if (
+        !(await saved.saveSafety(
+          current.height,
+          current.safety.revision,
+          canonicalEncode(priorSafety),
+        ))
+      )
+        throw new Error('Could not persist the former active voter safety');
+      await saved.close();
+    }
+
+    const store = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
+    expect(await store.load(`online-game/${record.genesisDigest}/keys`)).toEqual(oldBinding);
+    const imports = new TransferImportStore(store);
+    const expected = { gameId: record.gameId, genesisDigest: record.genesisDigest };
+    const entries = [...fixture.deckEntries, recoveryAuth, recoveryActivated];
+    const participant = await OnlineTransferDestination.create({
+      attemptId: toBase64Url(new Uint8Array(32).fill(7)),
+      mode: 'new',
+      expected,
+      identity,
+      store,
+      importStore: imports,
+      bootstrapBytes: value(encodeOnlineTransferBootstrap({ start: record, entries })),
+    });
+    const offer = await participant.prepareOffer({ seat: 0, mode: 'return' });
+    expect(offer.returnIntent?.signer).toBe('last-human-game-key');
+    const transferAuthEntry = signRecoveryFixtureEntry(
+      fixture,
+      recovered,
+      { kind: 'membership', change: offer },
+      recovered.log.head.stateHash,
     );
-  const recoveryStore = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
-  value(
-    await persistRecoveryPrivate(
-      recovered.log,
-      transferEntryRef(recoveryAuthEntry),
-      1,
-      [{ seat: 0, master: scalarToBytes(17n) }],
-      recoveryStore,
-    ),
-  );
-  const packet = value(
-    await prepareTransferPrivate({
-      journal: sourceJournal,
-      engine: createBaseEngine(),
-      policy: fixture.policy,
-      authorization: transferEntryRef(transferAuthEntry),
-      sourceSeat: 1,
-      sourceKind: 'current-controller',
-      signingKey: recoveryFixtureKey(fixture, 1),
-      entropy: new Uint8Array(32).fill(33),
-      nonce: new Uint8Array(32).fill(34),
-      outbox: store,
-      recoveryPrivateStore: recoveryStore,
-    }),
-  );
-  await participant.importPacket(packet);
-  const readiness = await participant.prepareReadiness();
-  const humanStatus = value(
-    fixture.source.engine.apply(transferPending.log.state, {
-      kind: 'system',
-      type: 'SEAT_STATUS',
-      seat: 0,
-      status: 'active',
-    }),
-  );
-  const activationEntry = signRecoveryFixtureEntry(
-    fixture,
-    transferPending,
-    { kind: 'membership', change: readiness },
-    toHex(hashValue(humanStatus.state)),
-  );
-  const activation = certifyRecoveryFixtureEntry(
-    fixture,
-    transferPending,
-    activationEntry,
-    [1, 2, 3],
-  );
-  advanceRecoveryFixture(transferPending, activation);
-  entries.push(activation);
-  const activatedBootstrap = value(encodeOnlineTransferBootstrap({ start: record, entries }));
-  await expect(participant.observeActivation(activatedBootstrap)).rejects.toThrow(/not retired/);
-  const retiringJournal = new IndexedDbProtocolJournal(record.gameId, {
-    keyBinding: {
-      recordKey: `online-game/${record.genesisDigest}/keys`,
-      bytes: oldBinding,
-    },
-  });
-  const incomplete = await retiringJournal.load();
-  if (!incomplete) throw new Error('Former voter journal is missing');
-  expect(
-    await retiringJournal.saveSafety(
-      incomplete.height,
-      incomplete.safety.revision,
-      canonicalEncode(retired),
-    ),
-  ).toBe(true);
-  await retiringJournal.close();
-  expect(await participant.observeActivation(activatedBootstrap)).toBe(record.gameId);
-  expect(participant.snapshot().phase).toBe('promoted');
-  await participant.close();
-  identity.dispose();
-  oldBinding.fill(0);
-}, 120_000);
+    const transferAuth = certifyRecoveryFixtureEntry(
+      fixture,
+      recovered,
+      transferAuthEntry,
+      [1, 2, 3],
+    );
+    const transferPending = advanceRecoveryFixture(recovered, transferAuth);
+    entries.push(transferAuth);
+    await participant.refreshBootstrap(
+      value(encodeOnlineTransferBootstrap({ start: record, entries })),
+    );
+    const sourceJournal = new MemoryProtocolJournal();
+    expect(await sourceJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
+    for (const certified of entries)
+      // oxlint-disable-next-line no-await-in-loop -- Preserve the real certified source ancestry.
+      expect(await sourceJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(
+        true,
+      );
+    const recoveryStore = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
+    value(
+      await persistRecoveryPrivate(
+        recovered.log,
+        transferEntryRef(recoveryAuthEntry),
+        1,
+        [{ seat: 0, master: scalarToBytes(17n) }],
+        recoveryStore,
+      ),
+    );
+    const packet = value(
+      await prepareTransferPrivate({
+        journal: sourceJournal,
+        engine: createBaseEngine(),
+        policy: fixture.policy,
+        authorization: transferEntryRef(transferAuthEntry),
+        sourceSeat: 1,
+        sourceKind: 'current-controller',
+        signingKey: recoveryFixtureKey(fixture, 1),
+        entropy: new Uint8Array(32).fill(33),
+        nonce: new Uint8Array(32).fill(34),
+        outbox: store,
+        recoveryPrivateStore: recoveryStore,
+      }),
+    );
+    await participant.importPacket(packet);
+    const readiness = await participant.prepareReadiness();
+    const humanStatus = value(
+      fixture.source.engine.apply(transferPending.log.state, {
+        kind: 'system',
+        type: 'SEAT_STATUS',
+        seat: 0,
+        status: 'active',
+      }),
+    );
+    const activationEntry = signRecoveryFixtureEntry(
+      fixture,
+      transferPending,
+      { kind: 'membership', change: readiness },
+      toHex(hashValue(humanStatus.state)),
+    );
+    const activation = certifyRecoveryFixtureEntry(
+      fixture,
+      transferPending,
+      activationEntry,
+      [1, 2, 3],
+    );
+    advanceRecoveryFixture(transferPending, activation);
+    entries.push(activation);
+    const activatedBootstrap = value(encodeOnlineTransferBootstrap({ start: record, entries }));
+    if (oldJournalPhase === 'retired') {
+      let rejected = false;
+      try {
+        await participant.observeActivation(activatedBootstrap);
+      } catch (error) {
+        rejected = /not retired/.test(String(error));
+      }
+      if (!rejected) throw new Error('Unretired post-removal journal was accepted');
+      const retiringJournal = new IndexedDbProtocolJournal(record.gameId, {
+        keyBinding: {
+          recordKey: `online-game/${record.genesisDigest}/keys`,
+          bytes: oldBinding,
+        },
+      });
+      const incomplete = await retiringJournal.load();
+      if (!incomplete) throw new Error('Former voter journal is missing');
+      if (
+        !(await retiringJournal.saveSafety(
+          incomplete.height,
+          incomplete.safety.revision,
+          canonicalEncode(retired),
+        ))
+      )
+        throw new Error('Could not persist the certified retirement marker');
+      await retiringJournal.close();
+    }
+    expect(await participant.observeActivation(activatedBootstrap)).toBe(record.gameId);
+    expect(participant.snapshot().phase).toBe('promoted');
+    await participant.close();
+    identity.dispose();
+    oldBinding.fill(0);
+  },
+  120_000,
+);
diff --git a/apps/web/src/session/online-transfer-destination.ts b/apps/web/src/session/online-transfer-destination.ts
index 29b52eb..ca4c853 100644
--- a/apps/web/src/session/online-transfer-destination.ts
+++ b/apps/web/src/session/online-transfer-destination.ts
@@ -1,22 +1,27 @@
 import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
 import { identityFromSecret, signObject } from '@cp2p/crypto';
-import { createBaseEngine } from '@cp2p/engine';
+import { createBaseEngine, success } from '@cp2p/engine';
 import type { Seat } from '@cp2p/engine';
 import {
   genesisDigest,
   importTransferPrivate,
+  initialProposalContext,
   replayCertifiedPrefix,
+  restoreConsensusState,
   restoreRetiredSafety,
   transferCheckDigest,
   transferEntryRef,
   TRANSFER_BOT_CHECK_DOMAIN,
   TRANSFER_DESTINATION_CHECK_DOMAIN,
+  TRANSFER_RETURN_INTENT_DOMAIN,
   transferAuthorizationStatementSchema,
   transferChangeSchema,
   transferPrivateEnvelopeSchema,
   validateDeckCeremony,
+  validateRetiredTransferBinding,
 } from '@cp2p/protocol';
 import type {
+  LogContext,
   ReplayPolicy,
   SeatTransferAuthorization,
   SeatTransferAuthorizationStatement,
@@ -41,6 +46,7 @@ import {
 
 const PROTOCOL = 'online-transfer-destination-v1';
 const MAX_REFRESHES = 8;
+const MAX_RETIRED_BINDING_BYTES = 16 * 1024;
 const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
 const ref = v.strictObject({
   seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
@@ -131,6 +137,12 @@ function equal(left: Uint8Array, right: Uint8Array): boolean {
   return left.length === right.length && left.every((byte, index) => byte === right[index]);
 }
 
+function wipePrivate(value: unknown): void {
+  if (value instanceof Uint8Array) value.fill(0);
+  else if (Array.isArray(value)) value.forEach(wipePrivate);
+  else if (value && typeof value === 'object') Object.values(value).forEach(wipePrivate);
+}
+
 function wipeStage(stage: import('@cp2p/storage').TransferImportRecord | null): void {
   stage?.bindingBytes.fill(0);
   stage?.sealedPackage.fill(0);
@@ -782,10 +794,20 @@ export class OnlineTransferDestination {
           if (!approved || !sameCanonical(approved.statement, credentials.authorization.statement))
             throw new TypeError('Certified authorization differs from reserved credentials');
         }
+        const returnIntent =
+          scope.mode === 'return'
+            ? await this.#returnIntent(credentials.authorization.statement)
+            : null;
+        this.#ensureActive();
         if (this.#locator.scope === null) {
           await this.#replace((current) => ({ ...current, scope: v.parse(scopeSchema, scope) }));
           this.#phase = 'offered';
         }
+        if (returnIntent)
+          return {
+            ...credentials.authorization,
+            returnIntent,
+          };
         return credentials.authorization;
       } finally {
         credentials.dispose();
@@ -793,6 +815,77 @@ export class OnlineTransferDestination {
     });
   }
 
+  async #returnIntent(statement: SeatTransferAuthorizationStatement): Promise<{
+    signer: 'last-human-game-key';
+    sig: string;
+  }> {
+    const current = this.#bootstrap.replay.context.log;
+    const root = current.transfer?.returnRoots
+      .toReversed()
+      .find((item) => item.departedSeat === statement.seat);
+    if (
+      !root?.activation ||
+      root.lastHumanDevice !== this.#options.identity.peerId ||
+      statement.mode !== 'return'
+    )
+      throw new TypeError('Return requires the certified former human device');
+    const bytes = await this.#options.store.load(
+      `online-game/${this.#options.expected.genesisDigest}/keys`,
+    );
+    if (!bytes) throw new TypeError('Former human game binding is unavailable');
+    let decoded: unknown;
+    let owned: import('@cp2p/protocol').TransferOwnedMaterial | null = null;
+    try {
+      if (bytes.length > MAX_RETIRED_BINDING_BYTES)
+        throw new TypeError('Former human game binding is oversized');
+      decoded = canonicalDecode(bytes);
+      const initial = initialProposalContext(
+        this.#bootstrap.record.result.entry,
+        createBaseEngine(),
+        policyFor(this.#bootstrap),
+      );
+      if (!initial.ok) throw new TypeError(initial.error.message);
+      const humanSeat = statement.seat;
+      const controllerKey = (context: LogContext) =>
+        context.authority?.controllers.find((item) => item.seat === humanSeat)?.publicKey;
+      let installed: LogContext | null =
+        controllerKey(initial.value.log) === root.lastHumanGameKey ? initial.value.log : null;
+      let previous = controllerKey(initial.value.log);
+      const replayed = replayCertifiedPrefix(
+        this.#bootstrap.record.result.entry,
+        this.#bootstrap.entries,
+        createBaseEngine(),
+        policyFor(this.#bootstrap),
+        (_entry, next) => {
+          const key = controllerKey(next.log);
+          if (key !== previous && key === root.lastHumanGameKey) installed = next.log;
+          previous = key;
+          return success(undefined);
+        },
+      );
+      if (!replayed.ok || !installed)
+        throw new TypeError('Former human key lacks a certified installed generation');
+      this.#ensureActive();
+      const checked = validateRetiredTransferBinding(decoded, installed, current);
+      if (!checked.ok) throw new TypeError(checked.error.message);
+      owned = checked.value;
+      const human = owned.seats.find((seat) => seat.seat === humanSeat && seat.kind === 'human');
+      if (owned.devicePeer !== root.lastHumanDevice || human?.peerId !== root.lastHumanGameKey)
+        throw new TypeError('Former human binding differs from certified return lineage');
+      return {
+        signer: 'last-human-game-key',
+        sig: signObject(TRANSFER_RETURN_INTENT_DOMAIN, statement, human.signingKey),
+      };
+    } finally {
+      for (const seat of owned?.seats ?? []) {
+        seat.signingKey.fill(0);
+        seat.master.fill(0);
+      }
+      wipePrivate(decoded);
+      bytes.fill(0);
+    }
+  }
+
   refreshBootstrap(bytes: Uint8Array): Promise<void> {
     return this.#run(async () => {
       if (this.#phase === 'promoted' || this.#phase === 'cancelled')
@@ -1203,7 +1296,14 @@ export class OnlineTransferDestination {
                 !saved ||
                 !sameCanonical(saved.genesis, stage.genesis) ||
                 saved.entries.length > next.entries.length ||
-                saved.entries.some((entry, index) => !sameCanonical(entry, next.entries[index]))
+                saved.entries.some(
+                  (entry, index) =>
+                    !next.entries[index] ||
+                    !sameRef(
+                      transferEntryRef(entry.entry),
+                      transferEntryRef(next.entries[index].entry),
+                    ),
+                )
               )
                 throw new TypeError('Existing journal is not a certified prefix of activation');
               const replayed = replayCertifiedPrefix(
@@ -1234,14 +1334,25 @@ export class OnlineTransferDestination {
               } finally {
                 saved.safety.bytes.fill(0);
               }
-              const retired = restoreRetiredSafety(
-                marker,
-                replayed.value.context,
-                approved.statement.seat,
-                oldKey,
-              );
-              if (!retired.ok)
-                throw new TypeError(`Existing journal is not retired: ${retired.error.code}`);
+              const storedContext = replayed.value.context;
+              if (storedContext.membership.voters.some((voter) => voter.publicKey === oldKey)) {
+                const active = restoreConsensusState(
+                  marker,
+                  storedContext,
+                  approved.statement.seat,
+                );
+                if (!active.ok || active.value.localPublicKey !== oldKey)
+                  throw new TypeError('Existing journal has invalid active controller safety');
+              } else {
+                const retired = restoreRetiredSafety(
+                  marker,
+                  storedContext,
+                  approved.statement.seat,
+                  oldKey,
+                );
+                if (!retired.ok)
+                  throw new TypeError(`Existing journal is not retired: ${retired.error.code}`);
+              }
               const prior = saved.entries.at(-1)?.entry ?? saved.genesis;
               expectedActive = { head: transferEntryRef(prior), bindingBytes: oldBinding };
             } finally {
diff --git a/packages/p2p/src/peer-link.test.ts b/packages/p2p/src/peer-link.test.ts
index 2396a26..495e264 100644
--- a/packages/p2p/src/peer-link.test.ts
+++ b/packages/p2p/src/peer-link.test.ts
@@ -148,6 +148,13 @@ class FakePc {
     const gate = this.remoteGate;
     this.remoteGate = null;
     if (gate) await gate;
+    if (description.type === 'answer' && this.signalingState !== 'have-local-offer')
+      throw new DOMException(
+        'Failed to set remote answer sdp: Called in wrong state: stable',
+        'InvalidStateError',
+      );
+    if (description.type === 'answer' && description.sdp?.includes('a=malformed'))
+      throw new DOMException('Invalid remote answer SDP', 'OperationError');
     this.currentRemoteDescription = this.remoteDescription = description;
     this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
     this.emit('signalingstatechange');
@@ -802,6 +809,85 @@ describe('authenticated peer link', () => {
     }
   });
 
+  test('an answer without a local offer and a delayed repeat do not close a link', async () => {
+    const f = pair();
+    try {
+      const answer = { type: 'answer' as const, sdp: sdp('BB') };
+      await f.left.receiveSignal({
+        kind: 'description',
+        generation: 1,
+        revision: 1,
+        description: answer,
+      });
+      expect(f.leftPc.currentRemoteDescription).toEqual({ type: 'offer', sdp: sdp('BB') });
+      f.leftPc.emit('negotiationneeded');
+      await Promise.resolve();
+      expect(f.leftPc.signalingState).toBe('have-local-offer');
+      await f.left.receiveSignal({
+        kind: 'description',
+        generation: 1,
+        revision: 2,
+        description: answer,
+      });
+      expect(f.leftPc.signalingState).toBe('stable');
+      await f.left.receiveSignal({
+        kind: 'description',
+        generation: 1,
+        revision: 3,
+        description: answer,
+      });
+      expect(f.leftPc.currentRemoteDescription).toEqual(answer);
+      expect(f.leftDown).toEqual([]);
+    } finally {
+      f.close();
+    }
+  });
+
+  test('a second answer during asynchronous answer application is ignored', async () => {
+    const f = pair();
+    try {
+      f.leftPc.emit('negotiationneeded');
+      await Promise.resolve();
+      const release = f.leftPc.holdNextRemoteDescription();
+      const first = f.left.receiveSignal({
+        kind: 'description',
+        generation: 1,
+        revision: 1,
+        description: { type: 'answer', sdp: sdp('BB') },
+      });
+      await f.left.receiveSignal({
+        kind: 'description',
+        generation: 1,
+        revision: 2,
+        description: { type: 'answer', sdp: sdp('BB') },
+      });
+      release();
+      await first;
+      expect(f.leftPc.signalingState).toBe('stable');
+      expect(f.leftDown).toEqual([]);
+    } finally {
+      f.close();
+    }
+  });
+
+  test('a malformed answer to the current local offer still fails negotiation', async () => {
+    const f = pair();
+    try {
+      f.leftPc.emit('negotiationneeded');
+      await Promise.resolve();
+      expect(f.leftPc.signalingState).toBe('have-local-offer');
+      await f.left.receiveSignal({
+        kind: 'description',
+        generation: 1,
+        revision: 1,
+        description: { type: 'answer', sdp: `${sdp('BB')}a=malformed\r\n` },
+      });
+      expect(f.leftDown).toContain('negotiation-error');
+    } finally {
+      f.close();
+    }
+  });
+
   test('future ICE waits for its exact description; stale and foreign generations are ignored', async () => {
     const f = pair();
     try {
diff --git a/packages/p2p/src/peer-link.ts b/packages/p2p/src/peer-link.ts
index 35405c2..6e5a63e 100644
--- a/packages/p2p/src/peer-link.ts
+++ b/packages/p2p/src/peer-link.ts
@@ -203,6 +203,13 @@ export class PeerLink {
           description.sdp.length > 65_536
         )
           return;
+        // A repeated or delayed answer can arrive after the first answer made SDP stable.
+        // Applying it would throw and tear down an otherwise healthy authenticated link.
+        if (
+          description.type === 'answer' &&
+          (this.pc.signalingState !== 'have-local-offer' || this.isSettingRemoteAnswerPending)
+        )
+          return;
         if (this.authenticated) {
           try {
             const current = this.pc.currentRemoteDescription?.sdp;
diff --git a/packages/storage/src/indexed-db-protocol-journal.ts b/packages/storage/src/indexed-db-protocol-journal.ts
index 62be7b6..1e1f934 100644
--- a/packages/storage/src/indexed-db-protocol-journal.ts
+++ b/packages/storage/src/indexed-db-protocol-journal.ts
@@ -6,6 +6,7 @@ import {
   genesisDigest,
   logEntrySchema,
   replayCertifiedPrefix,
+  restoreConsensusState,
   restoreRetiredSafety,
   validateRetiredTransferBinding,
   validateTransferOwnedMaterial,
@@ -755,22 +756,6 @@ export class IndexedDbProtocolJournal implements ProtocolJournal {
           );
           if (oldSafety.height !== existingKeys.length + 1)
             throw new TypeError('Existing active journal safety is incomplete');
-          if (existingKeys.length === options.activation.entry.seq) {
-            const retiredKey = oldMaterialKey(approved, before.value.context.log.transfer);
-            const markerBytes = canonicalDecode(oldSafety.safety);
-            try {
-              const marker = restoreRetiredSafety(
-                markerBytes,
-                after.value.context,
-                destinationSeat,
-                retiredKey,
-              );
-              if (!marker.ok)
-                throw new TypeError(`Existing controller was not retired: ${marker.error.code}`);
-            } finally {
-              wipeDecodedBytes(markerBytes);
-            }
-          }
           const oldHead =
             existingKeys.length === 0
               ? staged.genesis
@@ -778,13 +763,49 @@ export class IndexedDbProtocolJournal implements ProtocolJournal {
                   .entry;
           if (entryHash(oldHead) !== expected.head.hash)
             throw new TypeError('Existing active journal head is stale');
-          for (const [index, stored] of existingEntries.entries()) {
+          const persistedPrefix = existingEntries.map((stored) =>
+            decodeRecord(stored, certifiedEntrySchema, this.#maxRecordBytes),
+          );
+          const persistedReplay = replayCertifiedPrefix(
+            staged.genesis,
+            persistedPrefix,
+            options.engine,
+            options.policy,
+          );
+          if (!persistedReplay.ok)
+            throw new TypeError('Existing active journal has invalid certified history');
+          const retiredKey = oldMaterialKey(approved, before.value.context.log.transfer);
+          const storedContext = persistedReplay.value.context;
+          const safetyValue = canonicalDecode(oldSafety.safety);
+          try {
+            if (storedContext.membership.voters.some((voter) => voter.publicKey === retiredKey)) {
+              const active = restoreConsensusState(safetyValue, storedContext, destinationSeat);
+              if (!active.ok || active.value.localPublicKey !== retiredKey)
+                throw new TypeError('Existing controller safety is invalid');
+            } else {
+              const retired = restoreRetiredSafety(
+                safetyValue,
+                storedContext,
+                destinationSeat,
+                retiredKey,
+              );
+              if (!retired.ok)
+                throw new TypeError(`Existing controller was not retired: ${retired.error.code}`);
+            }
+          } finally {
+            wipeDecodedBytes(safetyValue);
+          }
+          // Different valid voter quorums can certify the same signed entry.
+          // Keep the verified local certificates and append only the imported suffix.
+          for (const [index, persisted] of persistedPrefix.entries()) {
             const key = existingKeys[index];
+            const imported = fullEntries[index];
             if (
               !Array.isArray(key) ||
               key[0] !== this.#gameId ||
               key[1] !== index + 1 ||
-              !equalBytes(stored, canonicalEncode(fullEntries[index]))
+              !imported ||
+              entryHash(persisted.entry) !== entryHash(imported.entry)
             )
               throw new TypeError('Existing active journal conflicts with certified import');
           }
diff --git a/packages/storage/src/transfer-import-store.test.ts b/packages/storage/src/transfer-import-store.test.ts
index 2bfb317..65343fb 100644
--- a/packages/storage/src/transfer-import-store.test.ts
+++ b/packages/storage/src/transfer-import-store.test.ts
@@ -856,6 +856,13 @@ test('promotes after the old journal has certified activation and persisted its
   });
   await database.put('games', canonicalEncode(data.fixture.genesisEntry), gameId);
   const full = [...data.entries, data.activationCertificate];
+  const first = full[0];
+  if (!first || first.certificate.length < 4) throw new Error('Four-voter certificate missing');
+  full[0] = { ...first, certificate: first.certificate.slice(0, 3) };
+  const importedFirst = data.entries[0];
+  if (!importedFirst) throw new Error('Imported certificate missing');
+  expect(entryHash(full[0].entry)).toBe(entryHash(importedFirst.entry));
+  expect(canonicalEncode(full[0])).not.toEqual(canonicalEncode(importedFirst));
   await Promise.all(
     full.map((entry, index) =>
       database.put('entries', canonicalEncode(entry), [gameId, index + 1]),
@@ -923,8 +930,137 @@ test('promotes after the old journal has certified activation and persisted its
   );
   corrected.close();
   expect(await journal.promoteTransfer(options)).toBe(true);
+  expect((await journal.load())?.entries[0]).toEqual(full[0]);
   expect((await journal.load())?.safety).toMatchObject({ revision: 0 });
   expect(await stage.load(stageKey)).toBeNull();
   await journal.close();
   await stage.close();
 }, 30_000);
+
+test('refuses a different valid certified entry at the same stored height', async () => {
+  installFactory();
+  const data = verifiedTransfer(true);
+  const alternateEntry = signRecoveryFixtureEntry(
+    data.fixture,
+    data.fixture.ready,
+    { kind: 'membership', change: { kind: 'seat-offline', seat: 1 } },
+    data.fixture.ready.log.head.stateHash,
+  );
+  const alternate = certifyRecoveryFixtureEntry(
+    data.fixture,
+    data.fixture.ready,
+    alternateEntry,
+    [0, 1, 2, 3],
+  );
+  const existing = [...data.fixture.deckEntries, alternate];
+  const replayed = replayCertifiedPrefix(
+    data.fixture.genesisEntry,
+    existing,
+    data.fixture.source.engine,
+    data.fixture.policy,
+  );
+  if (!replayed.ok) throw new Error(`Alternate certified entry: ${replayed.error.code}`);
+  const priorSafety = createConsensusState(replayed.value.context, 0);
+  if (!priorSafety.ok) throw new Error(`Old controller safety: ${priorSafety.error.code}`);
+  expect(alternate.entry.seq).toBe(data.entries.at(-1)?.entry.seq);
+  const importedLast = data.entries.at(-1);
+  if (!importedLast) throw new Error('Imported head missing');
+  expect(entryHash(alternate.entry)).not.toBe(entryHash(importedLast.entry));
+
+  const gameId = data.fixture.genesis.gameId;
+  const recordKey = `online-game/${genesisDigest(data.fixture.genesis)}/keys`;
+  const database = await openDB('cp2p', 3, {
+    upgrade(db) {
+      db.createObjectStore('bytes');
+      db.createObjectStore('games');
+      db.createObjectStore('entries');
+      db.createObjectStore('consensus');
+      db.createObjectStore('deletedGames');
+    },
+  });
+  await database.put('games', canonicalEncode(data.fixture.genesisEntry), gameId);
+  await Promise.all(
+    existing.map((entry, index) =>
+      database.put('entries', canonicalEncode(entry), [gameId, index + 1]),
+    ),
+  );
+  await database.put(
+    'consensus',
+    canonicalEncode({
+      height: existing.length + 1,
+      revision: 0,
+      safety: canonicalEncode(priorSafety.value),
+    }),
+    gameId,
+  );
+  await database.put('bytes', data.oldBindingBytes, recordKey);
+  database.close();
+
+  const stage = new TransferImportStore();
+  const stageKey = await stage.stage(
+    {
+      gameId,
+      authorization: data.authorizationRef,
+      destinationGameKey: data.game.peerId,
+      bindingBytes: data.bindingBytes,
+      sealedPackage: Uint8Array.of(1),
+      privateReplayBytes: Uint8Array.of(2),
+      genesis: data.fixture.genesisEntry,
+      entries: data.entries,
+    },
+    data.fixture.source.engine,
+    data.fixture.policy,
+  );
+  await stage.saveReadiness(stageKey, {
+    protocol: 'seat-transfer-readiness-v1',
+    statement: data.activationStatement,
+    destinationCheck: data.destinationCheck,
+    replacementChecks: [],
+  });
+  const journal = new IndexedDbProtocolJournal(gameId, {
+    keyBinding: { recordKey, bytes: data.bindingBytes },
+  });
+  const options = {
+    stageKey,
+    activation: data.activationCertificate,
+    engine: data.fixture.source.engine,
+    policy: data.fixture.policy,
+    expectedActive: {
+      head: transferEntryRef(alternate.entry),
+      bindingBytes: data.oldBindingBytes,
+    },
+    leaseOptions: { lockManager: new TestLocks() },
+  };
+  const corrupted = await openDB('cp2p');
+  await corrupted.put(
+    'consensus',
+    canonicalEncode({
+      height: existing.length + 1,
+      revision: 0,
+      safety: canonicalEncode({ ...priorSafety.value, localPublicKey: data.game.peerId }),
+    }),
+    gameId,
+  );
+  corrupted.close();
+  await expect(journal.promoteTransfer(options)).rejects.toThrow('controller safety is invalid');
+  const repaired = await openDB('cp2p');
+  await repaired.put(
+    'consensus',
+    canonicalEncode({
+      height: existing.length + 1,
+      revision: 0,
+      safety: canonicalEncode(priorSafety.value),
+    }),
+    gameId,
+  );
+  repaired.close();
+  await expect(journal.promoteTransfer(options)).rejects.toThrow('conflicts with certified import');
+  const unchanged = await openDB('cp2p');
+  expect(await unchanged.get('entries', [gameId, alternate.entry.seq])).toEqual(
+    canonicalEncode(alternate),
+  );
+  unchanged.close();
+  expect(await stage.load(stageKey)).not.toBeNull();
+  await journal.close();
+  await stage.close();
+}, 30_000);


SURROUNDING SOURCE
FILE apps/web/src/session/online-transfer-destination.ts LINES 1180-1380
1180:         }
1181:       } finally {
1182:         wipeStage(stage);
1183:       }
1184:     });
1185:   }
1186: 
1187:   observeActivation(bytes: Uint8Array): Promise<string> {
1188:     return this.#run(async () => {
1189:       if (this.#phase === 'promoted' && this.#locator.outcome?.outcome === 'activated') {
1190:         const repeated = verified(bytes, this.#options.expected);
1191:         await this.#checkImportedCheckpoint(repeated);
1192:         if (
1193:           repeated.entries.length !== this.#bootstrap.entries.length ||
1194:           repeated.entries.some(
1195:             (item, index) => !sameCanonical(item, this.#bootstrap.entries[index]),
1196:           )
1197:         )
1198:           throw new TypeError('Repeated activation differs from certified final bootstrap');
1199:         return this.#options.expected.gameId;
1200:       }
1201:       const stageKey = this.#locator.stageKey;
1202:       const authorization = this.#locator.authorization;
1203:       if (!stageKey || !authorization) throw new TypeError('Transfer import is not staged');
1204:       const next = verified(bytes, this.#options.expected);
1205:       await this.#checkImportedCheckpoint(next);
1206:       const outcome = await this.#imports.readOutcome(this.#options.expected.gameId, authorization);
1207:       if (outcome.kind === 'cancelled') {
1208:         this.#phase = 'cancelled';
1209:         throw new TypeError('Transfer authorization was cancelled');
1210:       }
1211:       const stage = await this.#imports.load(stageKey);
1212:       try {
1213:         const stagedEntries = stage?.entries ?? this.#bootstrap.entries;
1214:         if (
1215:           next.entries.length !== stagedEntries.length + 1 ||
1216:           stagedEntries.some(
1217:             (entry, index) =>
1218:               !next.entries[index] ||
1219:               !equal(canonicalEncode(entry), canonicalEncode(next.entries[index])),
1220:           )
1221:         )
1222:           throw new TypeError('Activation must be the exact certified child of staged import');
1223:         const activation = next.entries.at(-1);
1224:         if (!activation) throw new TypeError('Certified activation entry is missing');
1225:         const change =
1226:           activation.entry.payload.kind === 'membership'
1227:             ? v.safeParse(transferChangeSchema, activation.entry.payload.change)
1228:             : null;
1229:         if (
1230:           !change?.success ||
1231:           change.output.kind !== 'transfer-activate' ||
1232:           !sameRef(change.output.statement.authorization, authorization)
1233:         )
1234:           throw new TypeError('Certified child is not this transfer activation');
1235:         const activationRef = this.#finalEntry(next, authorization, 'activated');
1236:         await this.#pinFinalBootstrap(bytes);
1237:         if (outcome.kind === 'promoted') {
1238:           if (!sameRef(outcome.activation, activationRef))
1239:             throw new TypeError('Transfer was promoted with another activation');
1240:           const active = await loadActiveOnlineResume({
1241:             store: this.#options.store,
1242:             record: next.record,
1243:             engine: createBaseEngine(),
1244:             devicePeer: this.#options.identity.peerId,
1245:             ...(this.#options.vault
1246:               ? {
1247:                   createJournal: (
1248:                     gameId: string,
1249:                     keyBinding: { recordKey: string; bytes: Uint8Array },
1250:                   ) => this.#journal(gameId, keyBinding),
1251:                 }
1252:               : {}),
1253:           });
1254:           if (active.gamePeer !== change.output.statement.destinationGame)
1255:             throw new TypeError('Promoted journal binding differs from certified destination');
1256:           const journal = this.#journal(this.#options.expected.gameId);
1257:           try {
1258:             const saved = await journal.load();
1259:             if (
1260:               !saved?.entries.some((entry) =>
1261:                 sameRef(transferEntryRef(entry.entry), outcome.activation),
1262:               )
1263:             )
1264:               throw new TypeError('Promoted activation is absent from the bound certified journal');
1265:           } finally {
1266:             await journal.close();
1267:           }
1268:           await this.#finish(next, authorization, activationRef, 'activated');
1269:           return this.#options.expected.gameId;
1270:         }
1271:         if (!stage) throw new TypeError('Staged transfer import is missing');
1272:         // The public start is independently validated and indexed before any voter journal appears.
1273:         await saveOnlineGameRecord(this.#options.store, {
1274:           invite: next.record.invite,
1275:           agreement: next.record.agreement,
1276:           result: next.record.result,
1277:         });
1278:         this.#ensureActive();
1279:         const bindingKey = `online-game/${this.#options.expected.genesisDigest}/keys`;
1280:         const oldBinding = await this.#options.store.load(bindingKey);
1281:         let expectedActive: {
1282:           head: { seq: number; hash: string };
1283:           bindingBytes: Uint8Array;
1284:         } | null = null;
1285:         try {
1286:           if (oldBinding) {
1287:             if (oldBinding.length > 16 * 1024)
1288:               throw new TypeError('Existing game binding is oversized');
1289:             const oldJournal = this.#journal(this.#options.expected.gameId, {
1290:               recordKey: bindingKey,
1291:               bytes: oldBinding,
1292:             });
1293:             try {
1294:               const saved = await oldJournal.load();
1295:               if (
1296:                 !saved ||
1297:                 !sameCanonical(saved.genesis, stage.genesis) ||
1298:                 saved.entries.length > next.entries.length ||
1299:                 saved.entries.some(
1300:                   (entry, index) =>
1301:                     !next.entries[index] ||
1302:                     !sameRef(
1303:                       transferEntryRef(entry.entry),
1304:                       transferEntryRef(next.entries[index].entry),
1305:                     ),
1306:                 )
1307:               )
1308:                 throw new TypeError('Existing journal is not a certified prefix of activation');
1309:               const replayed = replayCertifiedPrefix(
1310:                 saved.genesis,
1311:                 saved.entries,
1312:                 createBaseEngine(),
1313:                 policyFor(next),
1314:               );
1315:               if (!replayed.ok)
1316:                 throw new TypeError(`Existing journal did not replay: ${replayed.error.code}`);
1317:               const approved = next.replay.context.log.transfer?.authorizations.find((item) =>
1318:                 sameRef(item.entry, authorization),
1319:               );
1320:               const oldKey =
1321:                 approved?.statement.mode === 'live'
1322:                   ? approved.statement.currentController.publicKey
1323:                   : next.replay.context.log.transfer?.returnRoots
1324:                       .toReversed()
1325:                       .find((item) => item.departedSeat === approved?.statement.seat)
1326:                       ?.lastHumanGameKey;
1327:               if (!oldKey || !approved)
1328:                 throw new TypeError('Certified retired controller identity is unavailable');
1329:               let marker: unknown;
1330:               try {
1331:                 marker = canonicalDecode(saved.safety.bytes);
1332:               } catch {
1333:                 throw new TypeError('Existing journal is not retired');
1334:               } finally {
1335:                 saved.safety.bytes.fill(0);
1336:               }
1337:               const storedContext = replayed.value.context;
1338:               if (storedContext.membership.voters.some((voter) => voter.publicKey === oldKey)) {
1339:                 const active = restoreConsensusState(
1340:                   marker,
1341:                   storedContext,
1342:                   approved.statement.seat,
1343:                 );
1344:                 if (!active.ok || active.value.localPublicKey !== oldKey)
1345:                   throw new TypeError('Existing journal has invalid active controller safety');
1346:               } else {
1347:                 const retired = restoreRetiredSafety(
1348:                   marker,
1349:                   storedContext,
1350:                   approved.statement.seat,
1351:                   oldKey,
1352:                 );
1353:                 if (!retired.ok)
1354:                   throw new TypeError(`Existing journal is not retired: ${retired.error.code}`);
1355:               }
1356:               const prior = saved.entries.at(-1)?.entry ?? saved.genesis;
1357:               expectedActive = { head: transferEntryRef(prior), bindingBytes: oldBinding };
1358:             } finally {
1359:               await oldJournal.close();
1360:             }
1361:           }
1362:           const journal = this.#journal(this.#options.expected.gameId, {
1363:             recordKey: bindingKey,
1364:             bytes: stage.bindingBytes,
1365:           });
1366:           try {
1367:             if (
1368:               !(await journal.promoteTransfer({
1369:                 stageKey,
1370:                 activation,
1371:                 engine: createBaseEngine(),
1372:                 policy: policyFor(next),
1373:                 expectedActive,
1374:               }))
1375:             )
1376:               throw new TypeError('Transfer promotion lost its durable race');
1377:           } finally {
1378:             await journal.close();
1379:           }
1380:         } finally {

FILE packages/storage/src/indexed-db-protocol-journal.ts LINES 530-845
530:   }
531: 
532:   async #promoteTransfer(options: TransferPromotionOptions): Promise<boolean> {
533:     const keyBinding = this.#keyBinding;
534:     if (!keyBinding) throw new TypeError('Transfer promotion requires a destination key binding');
535:     const stagedStore = new TransferImportStore(this.#newByteStore());
536:     let staged: Awaited<ReturnType<TransferImportStore['load']>> = null;
537:     let readiness: Awaited<ReturnType<TransferImportStore['loadReadiness']>> = null;
538:     let storedStage: Uint8Array | undefined;
539:     let storedReadiness: Uint8Array | undefined;
540:     let storedOldBinding: Uint8Array | undefined;
541:     let storedNewBinding: Uint8Array | undefined;
542:     try {
543:       const stagePinned = await stagedStore.loadPinned(options.stageKey);
544:       const readinessPinned = await stagedStore.loadReadinessPinned(options.stageKey);
545:       staged = stagePinned?.record ?? null;
546:       readiness = readinessPinned?.record ?? null;
547:       storedStage = stagePinned?.stored;
548:       storedReadiness = readinessPinned?.stored;
549:       if (!staged || !readiness || staged.gameId !== this.#gameId)
550:         throw new TypeError('Transfer import or durable readiness is missing');
551:       const authorization = staged.authorization;
552:       if (
553:         !equalBytes(staged.bindingBytes, keyBinding.bytes) ||
554:         options.activation.entry.seq !== staged.head.seq + 1 ||
555:         options.activation.entry.prevHash !== staged.head.hash ||
556:         staged.authorization.seq >= options.activation.entry.seq
557:       )
558:         throw new TypeError('Activation is not the exact next entry after staged import');
559:       const fullEntries = [...staged.entries, options.activation];
560:       const before = replayCertifiedPrefix(
561:         staged.genesis,
562:         staged.entries,
563:         options.engine,
564:         options.policy,
565:       );
566:       const after = replayCertifiedPrefix(
567:         staged.genesis,
568:         fullEntries,
569:         options.engine,
570:         options.policy,
571:       );
572:       if (!before.ok || !after.ok)
573:         throw new TypeError('Transfer promotion requires a fully certified valid prefix');
574:       const change = options.activation.entry.payload;
575:       if (
576:         change.kind !== 'membership' ||
577:         !isTransferActivation(change.change) ||
578:         change.change.statement.authorization.seq !== staged.authorization.seq ||
579:         change.change.statement.authorization.hash !== staged.authorization.hash ||
580:         change.change.statement.parent.seq !== staged.head.seq ||
581:         change.change.statement.parent.hash !== staged.head.hash ||
582:         !equalBytes(
583:           canonicalEncode(readiness.statement),
584:           canonicalEncode(change.change.statement),
585:         ) ||
586:         readiness.destinationCheck !== change.change.destinationCheck ||
587:         !equalBytes(
588:           canonicalEncode(readiness.replacementChecks),
589:           canonicalEncode(change.change.replacementChecks),
590:         ) ||
591:         !after.value.context.log.transfer?.completed.some(
592:           (item) =>
593:             item.outcome === 'activated' &&
594:             item.authorization.seq === authorization.seq &&
595:             item.authorization.hash === authorization.hash &&
596:             item.entry.seq === options.activation.entry.seq &&
597:             item.entry.hash === entryHash(options.activation.entry),
598:         )
599:       )
600:         throw new TypeError('Certified activation differs from durable import readiness');
601:       const digest = genesisDigest(after.value.context.log.genesis);
602:       if (keyBinding.recordKey !== `online-game/${digest}/keys`)
603:         throw new TypeError('Destination binding is outside its game namespace');
604:       const destinationBinding = canonicalDecode(keyBinding.bytes);
605:       let owned: ReturnType<typeof validateTransferOwnedMaterial>;
606:       try {
607:         owned = validateTransferOwnedMaterial(destinationBinding, after.value.context.log);
608:       } finally {
609:         wipeDecodedBytes(destinationBinding);
610:       }
611:       if (!owned.ok) throw new TypeError(`Destination material: ${owned.error.code}`);
612:       for (const seat of owned.value.seats) {
613:         seat.signingKey.fill(0);
614:         seat.master.fill(0);
615:       }
616:       const approved = after.value.context.log.transfer?.authorizations.find(
617:         (item) => item.entry.seq === authorization.seq && item.entry.hash === authorization.hash,
618:       );
619:       const destinationSeat = approved?.statement.seat;
620:       if (destinationSeat === undefined)
621:         throw new TypeError('Certified destination seat is missing');
622:       const fresh = createConsensusState(after.value.context, destinationSeat);
623:       if (!fresh.ok) throw new TypeError(`Fresh transfer safety: ${fresh.error.code}`);
624:       const nextConsensus = encodeRecord(
625:         {
626:           height: options.activation.entry.seq + 1,
627:           revision: 0,
628:           safety: canonicalEncode(fresh.value),
629:         },
630:         consensusRecordSchema,
631:         this.#maxRecordBytes,
632:       );
633:       const oldBinding = options.expectedActive?.bindingBytes;
634:       if (oldBinding) {
635:         const historical = historicalOldMaterialContext(
636:           staged.genesis,
637:           staged.entries,
638:           before.value.context.log.transfer,
639:           staged.authorization,
640:           options.engine,
641:           options.policy,
642:         );
643:         const retiredBinding = canonicalDecode(oldBinding);
644:         let old: ReturnType<typeof validateRetiredTransferBinding>;
645:         try {
646:           old = validateRetiredTransferBinding(
647:             retiredBinding,
648:             historical,
649:             before.value.context.log,
650:           );
651:         } finally {
652:           wipeDecodedBytes(retiredBinding);
653:         }
654:         if (!old.ok) throw new TypeError(`Retired material: ${old.error.code}`);
655:         for (const seat of old.value.seats) {
656:           seat.signingKey.fill(0);
657:           seat.master.fill(0);
658:         }
659:         if (
660:           old.value.devicePeer !== owned.value.devicePeer ||
661:           old.value.humanSeat !== owned.value.humanSeat ||
662:           !approved ||
663:           old.value.seats.find((seat) => seat.seat === approved.statement.seat)?.peerId !==
664:             oldMaterialKey(approved, before.value.context.log.transfer)
665:         )
666:           throw new TypeError('Existing binding belongs to a different device or seat');
667:       }
668:       storedNewBinding = await this.#vault.encode(keyBinding.recordKey, keyBinding.bytes);
669:       if (oldBinding) {
670:         const oldStore = this.#newByteStore();
671:         try {
672:           const pinned = await oldStore.loadPinned(keyBinding.recordKey);
673:           if (!pinned) throw new TypeError('Existing active binding is missing');
674:           try {
675:             if (!equalBytes(pinned.plain, oldBinding))
676:               throw new TypeError('Existing active binding differs from the expected controller');
677:             storedOldBinding = pinned.stored.slice();
678:           } finally {
679:             pinned.plain.fill(0);
680:             pinned.stored.fill(0);
681:           }
682:         } finally {
683:           await oldStore.close();
684:         }
685:       }
686:       const database = await this.#database();
687:       const transaction = strictWriteTransaction(database, [
688:         GAME_STORE,
689:         ENTRY_STORE,
690:         CONSENSUS_STORE,
691:         DELETED_GAME_STORE,
692:         BYTE_STORE,
693:         VAULT_STORE,
694:       ]);
695:       let transactionStage: Uint8Array | undefined;
696:       let transactionCheck: Uint8Array | undefined;
697:       try {
698:         await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
699:         await assertOnlineGameNotDeleted(transaction, this.#gameId);
700:         const bytes = transaction.objectStore(BYTE_STORE);
701:         const finalKey = transferImportFinalKey(staged);
702:         const priorFinal = await bytes.get(finalKey);
703:         if (priorFinal !== undefined) {
704:           if (priorFinal instanceof Uint8Array) priorFinal.fill(0);
705:           throw new TypeError('Transfer authorization was already finalized locally');
706:         }
707:         transactionStage = await bytes.get(options.stageKey);
708:         transactionCheck = await bytes.get(readinessKey(options.stageKey));
709:         const stageMatches = Boolean(
710:           transactionStage && storedStage && equalBytes(transactionStage, storedStage),
711:         );
712:         const checkMatches = Boolean(
713:           transactionCheck && storedReadiness && equalBytes(transactionCheck, storedReadiness),
714:         );
715:         if (!stageMatches || !checkMatches)
716:           throw new TypeError('Transfer import changed during promotion');
717:         const games = transaction.objectStore(GAME_STORE);
718:         const entries = transaction.objectStore(ENTRY_STORE);
719:         const consensus = transaction.objectStore(CONSENSUS_STORE);
720:         const existingGenesis = await games.get(this.#gameId);
721:         const existingSafety = await consensus.get(this.#gameId);
722:         const existingBinding = await bytes.get(keyBinding.recordKey);
723:         const bindingMatches = Boolean(
724:           existingBinding &&
725:           options.expectedActive &&
726:           storedOldBinding &&
727:           equalBytes(existingBinding, storedOldBinding),
728:         );
729:         existingBinding?.fill(0);
730:         const range = IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]);
731:         const existingKeys = await entries.getAllKeys(range);
732:         const existingEntries = await entries.getAll(range);
733:         if (options.expectedActive === null) {
734:           if (
735:             existingGenesis !== undefined ||
736:             existingSafety !== undefined ||
737:             existingBinding !== undefined ||
738:             existingKeys.length !== 0
739:           )
740:             throw new TypeError('Fresh destination already has active or partial journal state');
741:         } else {
742:           const expected = options.expectedActive;
743:           if (
744:             existingGenesis === undefined ||
745:             existingSafety === undefined ||
746:             !bindingMatches ||
747:             !equalBytes(existingGenesis, canonicalEncode(staged.genesis)) ||
748:             expected.head.seq !== existingKeys.length ||
749:             expected.head.seq > options.activation.entry.seq
750:           )
751:             throw new TypeError('Existing active journal binding or head changed');
752:           const oldSafety = decodeRecord(
753:             existingSafety,
754:             consensusRecordSchema,
755:             this.#maxRecordBytes,
756:           );
757:           if (oldSafety.height !== existingKeys.length + 1)
758:             throw new TypeError('Existing active journal safety is incomplete');
759:           const oldHead =
760:             existingKeys.length === 0
761:               ? staged.genesis
762:               : decodeRecord(existingEntries.at(-1), certifiedEntrySchema, this.#maxRecordBytes)
763:                   .entry;
764:           if (entryHash(oldHead) !== expected.head.hash)
765:             throw new TypeError('Existing active journal head is stale');
766:           const persistedPrefix = existingEntries.map((stored) =>
767:             decodeRecord(stored, certifiedEntrySchema, this.#maxRecordBytes),
768:           );
769:           const persistedReplay = replayCertifiedPrefix(
770:             staged.genesis,
771:             persistedPrefix,
772:             options.engine,
773:             options.policy,
774:           );
775:           if (!persistedReplay.ok)
776:             throw new TypeError('Existing active journal has invalid certified history');
777:           const retiredKey = oldMaterialKey(approved, before.value.context.log.transfer);
778:           const storedContext = persistedReplay.value.context;
779:           const safetyValue = canonicalDecode(oldSafety.safety);
780:           try {
781:             if (storedContext.membership.voters.some((voter) => voter.publicKey === retiredKey)) {
782:               const active = restoreConsensusState(safetyValue, storedContext, destinationSeat);
783:               if (!active.ok || active.value.localPublicKey !== retiredKey)
784:                 throw new TypeError('Existing controller safety is invalid');
785:             } else {
786:               const retired = restoreRetiredSafety(
787:                 safetyValue,
788:                 storedContext,
789:                 destinationSeat,
790:                 retiredKey,
791:               );
792:               if (!retired.ok)
793:                 throw new TypeError(`Existing controller was not retired: ${retired.error.code}`);
794:             }
795:           } finally {
796:             wipeDecodedBytes(safetyValue);
797:           }
798:           // Different valid voter quorums can certify the same signed entry.
799:           // Keep the verified local certificates and append only the imported suffix.
800:           for (const [index, persisted] of persistedPrefix.entries()) {
801:             const key = existingKeys[index];
802:             const imported = fullEntries[index];
803:             if (
804:               !Array.isArray(key) ||
805:               key[0] !== this.#gameId ||
806:               key[1] !== index + 1 ||
807:               !imported ||
808:               entryHash(persisted.entry) !== entryHash(imported.entry)
809:             )
810:               throw new TypeError('Existing active journal conflicts with certified import');
811:           }
812:         }
813:         if (existingGenesis === undefined) {
814:           const genesisBytes = encodeRecord(staged.genesis, logEntrySchema, this.#maxRecordBytes);
815:           try {
816:             await games.add(genesisBytes, this.#gameId);
817:           } finally {
818:             genesisBytes.fill(0);
819:           }
820:         }
821:         for (const [offset, entry] of fullEntries.slice(existingKeys.length).entries()) {
822:           const encoded = encodeRecord(entry, certifiedEntrySchema, this.#maxRecordBytes);
823:           try {
824:             // Retain canonical entry order and wipe each staged record after its IDB request.
825:             // eslint-disable-next-line no-await-in-loop
826:             await entries.add(encoded, [this.#gameId, existingKeys.length + offset + 1]);
827:           } finally {
828:             encoded.fill(0);
829:           }
830:         }
831:         await consensus.put(nextConsensus, this.#gameId);
832:         const bindingCopy = storedNewBinding.slice();
833:         try {
834:           await bytes.put(bindingCopy, keyBinding.recordKey);
835:         } finally {
836:           bindingCopy.fill(0);
837:         }
838:         const marker = canonicalEncode({
839:           outcome: 'promoted',
840:           authorization: staged.authorization,
841:           activation: {
842:             seq: options.activation.entry.seq,
843:             hash: entryHash(options.activation.entry),
844:           },
845:         });

FILE packages/p2p/src/peer-link.ts LINES 175-290
175: 
176:   get isAuthenticated(): boolean {
177:     return this.authenticated && !this.closed;
178:   }
179: 
180:   get hasOpenedChannels(): boolean {
181:     return !this.closed && this.game.readyState === 'open' && this.bulk.readyState === 'open';
182:   }
183: 
184:   async receiveSignal(blob: SignalBlob): Promise<void> {
185:     if (
186:       this.closed ||
187:       !blob ||
188:       !Number.isSafeInteger(blob.generation) ||
189:       blob.generation < 0 ||
190:       !Number.isSafeInteger(blob.revision) ||
191:       blob.revision < 1
192:     )
193:       return;
194:     if (this.remoteGeneration !== null && blob.generation !== this.remoteGeneration) return;
195:     try {
196:       if (blob.kind === 'description') {
197:         if (blob.revision <= this.remoteRevision) return;
198:         const description = blob.description;
199:         if (
200:           !description ||
201:           !['offer', 'answer'].includes(description.type) ||
202:           typeof description.sdp !== 'string' ||
203:           description.sdp.length > 65_536
204:         )
205:           return;
206:         // A repeated or delayed answer can arrive after the first answer made SDP stable.
207:         // Applying it would throw and tear down an otherwise healthy authenticated link.
208:         if (
209:           description.type === 'answer' &&
210:           (this.pc.signalingState !== 'have-local-offer' || this.isSettingRemoteAnswerPending)
211:         )
212:           return;
213:         if (this.authenticated) {
214:           try {
215:             const current = this.pc.currentRemoteDescription?.sdp;
216:             if (
217:               !current ||
218:               applicationFingerprint(description.sdp) !== applicationFingerprint(current)
219:             )
220:               return;
221:           } catch {
222:             return;
223:           }
224:         }
225:         if (this.remoteGeneration === null) this.remoteGeneration = blob.generation;
226:         const readyForOffer =
227:           !this.makingOffer &&
228:           (this.pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
229:         const collision = description.type === 'offer' && !readyForOffer;
230:         this.ignoreOffer = collision && !this.polite;
231:         const candidateKey = `${blob.generation}/${blob.revision}`;
232:         if (this.ignoreOffer) {
233:           this.ignoredRevision = Math.max(this.ignoredRevision, blob.revision);
234:           this.earlyCandidates.delete(candidateKey);
235:           return;
236:         }
237:         this.isSettingRemoteAnswerPending = description.type === 'answer';
238:         await this.pc.setRemoteDescription(description);
239:         this.isSettingRemoteAnswerPending = false;
240:         this.remoteRevision = blob.revision;
241:         this.acceptedRemoteRevision = blob.revision;
242:         const early = this.earlyCandidates.get(candidateKey) ?? [];
243:         this.earlyCandidates.clear();
244:         if (description.type === 'offer') {
245:           this.localRevision++;
246:           await this.pc.setLocalDescription();
247:           const answer = this.pc.localDescription;
248:           if (!answer) throw new Error('Missing local answer');
249:           this.sendSignal({
250:             kind: 'description',
251:             generation: this.options.generation,
252:             revision: this.localRevision,
253:             description: { type: answer.type, sdp: answer.sdp ?? '' },
254:           });
255:         }
256:         for (const candidate of early) {
257:           try {
258:             // oxlint-disable-next-line no-await-in-loop -- ICE candidates retain signaling order.
259:             await this.pc.addIceCandidate(candidate);
260:           } catch {
261:             /* A rejected candidate must not suppress an answer. */
262:           }
263:         }
264:         this.trySendHello();
265:       } else if (blob.kind === 'candidate') {
266:         if (
267:           blob.candidate !== null &&
268:           (typeof blob.candidate.candidate !== 'string' || blob.candidate.candidate.length > 4_096)
269:         )
270:           return;
271:         if (blob.revision <= this.ignoredRevision || blob.revision < this.acceptedRemoteRevision)
272:           return;
273:         if (blob.revision === this.acceptedRemoteRevision) {
274:           try {
275:             await this.pc.addIceCandidate(blob.candidate);
276:           } catch {
277:             /* Other candidates can still establish ICE. */
278:           }
279:           return;
280:         }
281:         const candidateKey = `${blob.generation}/${blob.revision}`;
282:         const pending = this.earlyCandidates.get(candidateKey) ?? [];
283:         const count = [...this.earlyCandidates.values()].reduce(
284:           (total, values) => total + values.length,
285:           0,
286:         );
287:         if (count >= MAX_EARLY_CANDIDATES) return;
288:         pending.push(blob.candidate);
289:         this.earlyCandidates.set(candidateKey, pending);
290:       }

FILE packages/protocol/src/retired-safety.ts LINES 1-105
1: import { hashValue, toHex } from '@cp2p/codec';
2: import { failure, success } from '@cp2p/engine';
3: import type { Result, Seat } from '@cp2p/engine';
4: import * as v from 'valibot';
5: import { restoreConsensusState } from './consensus.js';
6: import { entryHash } from './genesis.js';
7: import { advanceContext, validateCertifiedEntry } from './proposal.js';
8: import type { CertifiedEntry, ProposalContext } from './proposal.js';
9: import {
10:   hashSchema,
11:   key32Schema,
12:   nonnegativeIntegerSchema,
13:   positiveIntegerSchema,
14:   seatSchema,
15: } from './schema-values.js';
16: import { parseCanonical } from './validation.js';
17: 
18: const retiredSafetySchema = v.strictObject({
19:   kind: v.literal('retired-controller'),
20:   version: v.literal(1),
21:   genesisDigest: key32Schema,
22:   epoch: nonnegativeIntegerSchema,
23:   height: positiveIntegerSchema,
24:   parentHash: hashSchema,
25:   localSeat: seatSchema,
26:   localPublicKey: key32Schema,
27:   lastVotingStateHash: hashSchema,
28: });
29: 
30: /** A terminal local signing record, never accepted by ConsensusController. */
31: export type RetiredSafety = v.InferOutput<typeof retiredSafetySchema>;
32: 
33: /** Persist this marker and the removal certificate in the same journal transaction. */
34: export function createRetiredSafety(
35:   previous: ProposalContext,
36:   certified: CertifiedEntry,
37:   localSeat: Seat,
38:   priorSafety: unknown,
39: ): Result<RetiredSafety> {
40:   const prior = restoreConsensusState(priorSafety, previous, localSeat);
41:   if (!prior.ok) return prior;
42:   const checked = validateCertifiedEntry(certified, previous);
43:   if (!checked.ok) return checked;
44:   const advanced = advanceContext(previous, checked.value);
45:   if (!advanced.ok) return advanced;
46:   const next = advanced.value;
47:   const marker: RetiredSafety = {
48:     kind: 'retired-controller',
49:     version: 1,
50:     genesisDigest: next.membership.genesisDigest,
51:     epoch: next.membership.epoch,
52:     height: next.log.head.seq + 1,
53:     parentHash: entryHash(next.log.head),
54:     localSeat,
55:     localPublicKey: prior.value.localPublicKey,
56:     lastVotingStateHash: toHex(hashValue(prior.value)),
57:   };
58:   return restoreRetiredSafety(marker, next, localSeat, prior.value.localPublicKey);
59: }
60: 
61: /** Replay supplies authority; a marker alone can neither remove nor activate a voter. */
62: export function restoreRetiredSafety(
63:   value: unknown,
64:   context: ProposalContext,
65:   localSeat: Seat,
66:   publicKey: string,
67: ): Result<RetiredSafety> {
68:   const parsed = parseCanonical(value, retiredSafetySchema);
69:   if (!parsed.ok) return parsed;
70:   const marker = parsed.value;
71:   const controller = context.log.authority?.controllers.find((item) => item.seat === localSeat);
72:   if (
73:     marker.genesisDigest !== context.membership.genesisDigest ||
74:     marker.epoch !== context.membership.epoch ||
75:     marker.height !== context.log.head.seq + 1 ||
76:     marker.parentHash !== entryHash(context.log.head) ||
77:     marker.localSeat !== localSeat ||
78:     marker.localPublicKey !== publicKey ||
79:     context.membership.voters.some((member) => member.publicKey === publicKey) ||
80:     !controller ||
81:     (controller.kind !== 'bot' && controller.publicKey === publicKey) ||
82:     !context.log.authority?.usedPublicKeys.includes(publicKey)
83:   )
84:     return failure('replica-retirement', 'Retired signing record differs from certified removal');
85:   return success(marker);
86: }

FILE packages/protocol/src/consensus.ts LINES 120-230
120:   proposal: signedProposalSchema,
121:   prevotes: v.array(signedVoteSchema),
122: });
123: const hintSchema = v.variant('kind', [
124:   v.strictObject({
125:     kind: v.literal('proposal'),
126:     seat: seatSchema,
127:     round: positiveIntegerSchema,
128:     proposal: signedProposalSchema,
129:   }),
130:   v.strictObject({
131:     kind: v.literal('vote'),
132:     seat: seatSchema,
133:     round: positiveIntegerSchema,
134:     vote: signedVoteSchema,
135:   }),
136: ]);
137: const equivocationSchema = v.variant('kind', [
138:   v.strictObject({
139:     kind: v.literal('proposal'),
140:     seat: seatSchema,
141:     round: positiveIntegerSchema,
142:     first: signedProposalSchema,
143:     second: signedProposalSchema,
144:   }),
145:   v.strictObject({
146:     kind: v.literal('vote'),
147:     seat: seatSchema,
148:     round: positiveIntegerSchema,
149:     phase: v.picklist(['prevote', 'precommit']),
150:     first: signedVoteSchema,
151:     second: signedVoteSchema,
152:   }),
153: ]);
154: const certifiedSchema = v.strictObject({
155:   entry: logEntrySchema,
156:   certificate: v.array(signedVoteSchema),
157: });
158: const stateSchema = v.strictObject({
159:   version: v.literal(1),
160:   genesisDigest: key32Schema,
161:   epoch: nonnegativeIntegerSchema,
162:   height: positiveIntegerSchema,
163:   parentHash: hashSchema,
164:   contextHash: hashSchema,
165:   localSeat: seatSchema,
166:   localPublicKey: key32Schema,
167:   round: positiveIntegerSchema,
168:   step: v.picklist(['propose', 'prevote', 'precommit']),
169:   inputKnown: v.boolean(),
170:   timers: v.strictObject({ propose: v.boolean(), prevote: v.boolean(), precommit: v.boolean() }),
171:   proposals: v.array(signedProposalSchema),
172:   votes: v.array(signedVoteSchema),
173:   hints: v.pipe(v.array(hintSchema), v.maxLength(6)),
174:   equivocations: v.array(equivocationSchema),
175:   pendingAccusation: v.nullable(excludeProposerControlSchema),
176:   provenOffender: v.nullable(
177:     v.strictObject({
178:       control: excludeProposerControlSchema,
179:       atSeq: positiveIntegerSchema,
180:       parentHash: hashSchema,
181:     }),
182:   ),
183:   locked: v.nullable(quorumValueSchema),
184:   valid: v.nullable(quorumValueSchema),
185:   decision: v.nullable(certifiedSchema),
186:   halted: v.nullable(v.string()),
187:   haltKind: v.nullable(v.picklist(['certified-validation', 'terminal'])),
188:   unappliedCertificate: v.nullable(certifiedSchema),
189: });
190: 
191: interface ContextStamp {
192:   contextBytes: Uint8Array;
193:   functions: readonly (readonly [string, unknown])[];
194: }
195: 
196: // Only an OwnedConsensusState's private state enters this set. Public transition
197: // functions continue to verify every caller-supplied state in full.
198: const ownedStates = new WeakSet<ConsensusState>();
199: 
200: function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
201:   return left.length === right.length && left.every((byte, index) => byte === right[index]);
202: }
203: 
204: function nonfunctions(value: object): Record<string, unknown> {
205:   return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function'));
206: }
207: 
208: function runtimeReferences(value: object, name: string): (readonly [string, unknown])[] {
209:   const references: (readonly [string, unknown])[] = [[name, value]];
210:   let current: object | null = value;
211:   for (let depth = 0; current && current !== Object.prototype && depth < 8; depth++) {
212:     references.push([`${name}/prototype/${depth}`, current]);
213:     for (const key of Object.getOwnPropertyNames(current).toSorted()) {
214:       const property = Object.getOwnPropertyDescriptor(current, key);
215:       if (typeof property?.value === 'function')
216:         references.push([`${name}/${key}`, property.value]);
217:       if (property?.get) references.push([`${name}/${key}/get`, Reflect.get(property, 'get')]);
218:       if (property?.set) references.push([`${name}/${key}/set`, Reflect.get(property, 'set')]);
219:     }
220:     current = Object.getPrototypeOf(current);
221:   }
222:   return references;
223: }
224: 
225: function contextStamp(context: ProposalContext): ContextStamp {
226:   const functions: (readonly [string, unknown])[] = [
227:     ...runtimeReferences(context, 'context'),
228:     ...runtimeReferences(context.log, 'log'),
229:     ...runtimeReferences(context.log.engine, 'engine'),
230:     ...runtimeReferences(context.policy, 'policy'),

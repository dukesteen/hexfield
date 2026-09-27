Read-only focused follow-up security review. Tools and MCP are disabled. The prior pinned review (return-prefix-review-raw.md) identified: (1) active safety could retain a conflicting certified next-height decision; (2) a repeated old RTC answer with a fresh revision could arrive during a newer offer; (3) confirm game-wide promotion lease. The attached final source excerpts and focused tests address (1) and (2). Check only whether the fixes are sufficient or introduce a concrete regression: validate decision/unapplied certificate handling, same signed entry vs divergent fork, active/retired safety after certified removal, transaction-held replay and old-key fencing, offer-generation/revision/candidate behavior. Do not infer runtime secrets. Cite exact line and minimal fix for remaining issue; distinguish proof gaps from vulnerabilities.
FILE apps/web/src/session/online-transfer-destination.ts LINES 1280-1385
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
1346:                 const importedNext = next.entries[saved.entries.length];
1347:                 if (
1348:                   [active.value.decision, active.value.unappliedCertificate].some(
1349:                     (certified) =>
1350:                       certified &&
1351:                       (!importedNext ||
1352:                         !sameRef(
1353:                           transferEntryRef(certified.entry),
1354:                           transferEntryRef(importedNext.entry),
1355:                         )),
1356:                   )
1357:                 )
1358:                   throw new TypeError('Existing controller retains conflicting certified decision');
1359:               } else {
1360:                 const retired = restoreRetiredSafety(
1361:                   marker,
1362:                   storedContext,
1363:                   approved.statement.seat,
1364:                   oldKey,
1365:                 );
1366:                 if (!retired.ok)
1367:                   throw new TypeError(`Existing journal is not retired: ${retired.error.code}`);
1368:               }
1369:               const prior = saved.entries.at(-1)?.entry ?? saved.genesis;
1370:               expectedActive = { head: transferEntryRef(prior), bindingBytes: oldBinding };
1371:             } finally {
1372:               await oldJournal.close();
1373:             }
1374:           }
1375:           const journal = this.#journal(this.#options.expected.gameId, {
1376:             recordKey: bindingKey,
1377:             bytes: stage.bindingBytes,
1378:           });
1379:           try {
1380:             if (
1381:               !(await journal.promoteTransfer({
1382:                 stageKey,
1383:                 activation,
1384:                 engine: createBaseEngine(),
1385:                 policy: policyFor(next),
FILE packages/storage/src/indexed-db-protocol-journal.ts LINES 716-830
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
785:               const importedNext = fullEntries[existingKeys.length];
786:               if (
787:                 [active.value.decision, active.value.unappliedCertificate].some(
788:                   (certified) =>
789:                     certified &&
790:                     (!importedNext || entryHash(certified.entry) !== entryHash(importedNext.entry)),
791:                 )
792:               )
793:                 throw new TypeError('Existing controller retains conflicting certified decision');
794:             } else {
795:               const retired = restoreRetiredSafety(
796:                 safetyValue,
797:                 storedContext,
798:                 destinationSeat,
799:                 retiredKey,
800:               );
801:               if (!retired.ok)
802:                 throw new TypeError(`Existing controller was not retired: ${retired.error.code}`);
803:             }
804:           } finally {
805:             wipeDecodedBytes(safetyValue);
806:           }
807:           // Different valid voter quorums can certify the same signed entry.
808:           // Keep the verified local certificates and append only the imported suffix.
809:           for (const [index, persisted] of persistedPrefix.entries()) {
810:             const key = existingKeys[index];
811:             const imported = fullEntries[index];
812:             if (
813:               !Array.isArray(key) ||
814:               key[0] !== this.#gameId ||
815:               key[1] !== index + 1 ||
816:               !imported ||
817:               entryHash(persisted.entry) !== entryHash(imported.entry)
818:             )
819:               throw new TypeError('Existing active journal conflicts with certified import');
820:           }
821:         }
822:         if (existingGenesis === undefined) {
823:           const genesisBytes = encodeRecord(staged.genesis, logEntrySchema, this.#maxRecordBytes);
824:           try {
825:             await games.add(genesisBytes, this.#gameId);
826:           } finally {
827:             genesisBytes.fill(0);
828:           }
829:         }
830:         for (const [offset, entry] of fullEntries.slice(existingKeys.length).entries()) {
FILE packages/p2p/src/peer-link.ts LINES 187-258
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
206:         const candidateKey = `${blob.generation}/${blob.revision}`;
207:         // A repeated or delayed answer can arrive after the first answer made SDP stable.
208:         // Applying it would throw and tear down an otherwise healthy authenticated link.
209:         if (
210:           description.type === 'answer' &&
211:           (this.pc.signalingState !== 'have-local-offer' ||
212:             this.isSettingRemoteAnswerPending ||
213:             (this.pc.currentRemoteDescription?.type === 'answer' &&
214:               this.pc.currentRemoteDescription.sdp === description.sdp))
215:         ) {
216:           this.earlyCandidates.delete(candidateKey);
217:           return;
218:         }
219:         if (this.authenticated) {
220:           try {
221:             const current = this.pc.currentRemoteDescription?.sdp;
222:             if (
223:               !current ||
224:               applicationFingerprint(description.sdp) !== applicationFingerprint(current)
225:             )
226:               return;
227:           } catch {
228:             return;
229:           }
230:         }
231:         if (this.remoteGeneration === null) this.remoteGeneration = blob.generation;
232:         const readyForOffer =
233:           !this.makingOffer &&
234:           (this.pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
235:         const collision = description.type === 'offer' && !readyForOffer;
236:         this.ignoreOffer = collision && !this.polite;
237:         if (this.ignoreOffer) {
238:           this.ignoredRevision = Math.max(this.ignoredRevision, blob.revision);
239:           this.earlyCandidates.delete(candidateKey);
240:           return;
241:         }
242:         this.isSettingRemoteAnswerPending = description.type === 'answer';
243:         await this.pc.setRemoteDescription(description);
244:         this.isSettingRemoteAnswerPending = false;
245:         this.remoteRevision = blob.revision;
246:         this.acceptedRemoteRevision = blob.revision;
247:         const early = this.earlyCandidates.get(candidateKey) ?? [];
248:         this.earlyCandidates.clear();
249:         if (description.type === 'offer') {
250:           this.localRevision++;
251:           await this.pc.setLocalDescription();
252:           const answer = this.pc.localDescription;
253:           if (!answer) throw new Error('Missing local answer');
254:           this.sendSignal({
255:             kind: 'description',
256:             generation: this.options.generation,
257:             revision: this.localRevision,
258:             description: { type: answer.type, sdp: answer.sdp ?? '' },
FILE packages/p2p/src/peer-link.test.ts LINES 807-920
807:     } finally {
808:       f.close();
809:     }
810:   });
811: 
812:   test('an answer without a local offer and a delayed repeat do not close a link', async () => {
813:     const f = pair();
814:     try {
815:       const answer = { type: 'answer' as const, sdp: sdp('BB') };
816:       await f.left.receiveSignal({
817:         kind: 'description',
818:         generation: 1,
819:         revision: 1,
820:         description: answer,
821:       });
822:       expect(f.leftPc.currentRemoteDescription).toEqual({ type: 'offer', sdp: sdp('BB') });
823:       f.leftPc.emit('negotiationneeded');
824:       await Promise.resolve();
825:       expect(f.leftPc.signalingState).toBe('have-local-offer');
826:       await f.left.receiveSignal({
827:         kind: 'description',
828:         generation: 1,
829:         revision: 2,
830:         description: answer,
831:       });
832:       expect(f.leftPc.signalingState).toBe('stable');
833:       await f.left.receiveSignal({
834:         kind: 'description',
835:         generation: 1,
836:         revision: 3,
837:         description: answer,
838:       });
839:       expect(f.leftPc.currentRemoteDescription).toEqual(answer);
840:       expect(f.leftDown).toEqual([]);
841:     } finally {
842:       f.close();
843:     }
844:   });
845: 
846:   test('a second answer during asynchronous answer application is ignored', async () => {
847:     const f = pair();
848:     try {
849:       f.leftPc.emit('negotiationneeded');
850:       await Promise.resolve();
851:       const release = f.leftPc.holdNextRemoteDescription();
852:       const first = f.left.receiveSignal({
853:         kind: 'description',
854:         generation: 1,
855:         revision: 1,
856:         description: { type: 'answer', sdp: sdp('BB') },
857:       });
858:       await f.left.receiveSignal({
859:         kind: 'description',
860:         generation: 1,
861:         revision: 2,
862:         description: { type: 'answer', sdp: sdp('BB') },
863:       });
864:       release();
865:       await first;
866:       expect(f.leftPc.signalingState).toBe('stable');
867:       expect(f.leftDown).toEqual([]);
868:     } finally {
869:       f.close();
870:     }
871:   });
872: 
873:   test('a repeated answer with a fresh revision cannot satisfy a newer local offer', async () => {
874:     const f = pair();
875:     try {
876:       f.leftPc.emit('negotiationneeded');
877:       await Promise.resolve();
878:       const oldAnswer = { type: 'answer' as const, sdp: sdp('BB') };
879:       await f.left.receiveSignal({
880:         kind: 'description',
881:         generation: 1,
882:         revision: 1,
883:         description: oldAnswer,
884:       });
885:       expect(f.leftPc.signalingState).toBe('stable');
886:       f.leftPc.emit('negotiationneeded');
887:       await Promise.resolve();
888:       expect(f.leftPc.signalingState).toBe('have-local-offer');
889:       await f.left.receiveSignal({
890:         kind: 'description',
891:         generation: 1,
892:         revision: 2,
893:         description: oldAnswer,
894:       });
895:       expect(f.leftPc.signalingState).toBe('have-local-offer');
896:       await f.left.receiveSignal({
897:         kind: 'description',
898:         generation: 1,
899:         revision: 3,
900:         description: { type: 'answer', sdp: `${sdp('BB')}a=ice-ufrag:new\r\n` },
901:       });
902:       expect(f.leftPc.signalingState).toBe('stable');
903:       expect(f.leftDown).toEqual([]);
904:     } finally {
905:       f.close();
906:     }
907:   });
908: 
909:   test('a malformed answer to the current local offer still fails negotiation', async () => {
910:     const f = pair();
911:     try {
912:       f.leftPc.emit('negotiationneeded');
913:       await Promise.resolve();
914:       expect(f.leftPc.signalingState).toBe('have-local-offer');
915:       await f.left.receiveSignal({
916:         kind: 'description',
917:         generation: 1,
918:         revision: 1,
919:         description: { type: 'answer', sdp: `${sdp('BB')}a=malformed\r\n` },
920:       });
FILE apps/web/src/session/online-transfer-destination.test.ts LINES 630-855
630:       devicePeer: oldDevice.peerId,
631:       humanSeat: 0,
632:       seats: [
633:         {
634:           seat: 0,
635:           kind: 'human',
636:           peerId: fixture.genesis.seats[0]?.publicKey,
637:           signingKey: oldGameKey,
638:           master: scalarToBytes(17n),
639:         },
640:       ],
641:     });
642:     const priorSafety = value(createConsensusState(fixture.ready, 0));
643:     const retired = value(createRetiredSafety(fixture.ready, recoveryAuth, 0, priorSafety));
644:     const oldEntries =
645:       oldJournalPhase === 'pre-removal'
646:         ? [...fixture.deckEntries]
647:         : [...fixture.deckEntries, recoveryAuth];
648:     const first = oldEntries[0];
649:     if (!first || first.certificate.length < 4) throw new Error('Four-voter certificate missing');
650:     const alternateFirst = { ...first, certificate: first.certificate.slice(0, 3) };
651:     expect(entryHash(alternateFirst.entry)).toBe(entryHash(first.entry));
652:     expect(canonicalEncode(alternateFirst)).not.toEqual(canonicalEncode(first));
653:     const oldJournal = new IndexedDbProtocolJournal(record.gameId, {
654:       keyBinding: {
655:         recordKey: `online-game/${record.genesisDigest}/keys`,
656:         bytes: oldBinding,
657:       },
658:     });
659:     expect(await oldJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
660:     for (const certified of [alternateFirst, ...oldEntries.slice(1)])
661:       // oxlint-disable-next-line no-await-in-loop -- Build one exact certified retired source journal.
662:       expect(await oldJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(
663:         true,
664:       );
665:     await oldJournal.close();
666: 
667:     if (oldJournalPhase === 'pre-removal') {
668:       const saved = new IndexedDbProtocolJournal(record.gameId, {
669:         keyBinding: {
670:           recordKey: `online-game/${record.genesisDigest}/keys`,
671:           bytes: oldBinding,
672:         },
673:       });
674:       const current = await saved.load();
675:       if (!current) throw new Error('Former voter journal is missing');
676:       if (
677:         !(await saved.saveSafety(
678:           current.height,
679:           current.safety.revision,
680:           canonicalEncode(priorSafety),
681:         ))
682:       )
683:         throw new Error('Could not persist the former active voter safety');
684:       await saved.close();
685:     }
686: 
687:     const store = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
688:     expect(await store.load(`online-game/${record.genesisDigest}/keys`)).toEqual(oldBinding);
689:     const imports = new TransferImportStore(store);
690:     const expected = { gameId: record.gameId, genesisDigest: record.genesisDigest };
691:     const entries = [...fixture.deckEntries, recoveryAuth, recoveryActivated];
692:     const participant = await OnlineTransferDestination.create({
693:       attemptId: toBase64Url(new Uint8Array(32).fill(7)),
694:       mode: 'new',
695:       expected,
696:       identity,
697:       store,
698:       importStore: imports,
699:       bootstrapBytes: value(encodeOnlineTransferBootstrap({ start: record, entries })),
700:     });
701:     const offer = await participant.prepareOffer({ seat: 0, mode: 'return' });
702:     expect(offer.returnIntent?.signer).toBe('last-human-game-key');
703:     const transferAuthEntry = signRecoveryFixtureEntry(
704:       fixture,
705:       recovered,
706:       { kind: 'membership', change: offer },
707:       recovered.log.head.stateHash,
708:     );
709:     const transferAuth = certifyRecoveryFixtureEntry(
710:       fixture,
711:       recovered,
712:       transferAuthEntry,
713:       [1, 2, 3],
714:     );
715:     const transferPending = advanceRecoveryFixture(recovered, transferAuth);
716:     entries.push(transferAuth);
717:     await participant.refreshBootstrap(
718:       value(encodeOnlineTransferBootstrap({ start: record, entries })),
719:     );
720:     const sourceJournal = new MemoryProtocolJournal();
721:     expect(await sourceJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
722:     for (const certified of entries)
723:       // oxlint-disable-next-line no-await-in-loop -- Preserve the real certified source ancestry.
724:       expect(await sourceJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(
725:         true,
726:       );
727:     const recoveryStore = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
728:     value(
729:       await persistRecoveryPrivate(
730:         recovered.log,
731:         transferEntryRef(recoveryAuthEntry),
732:         1,
733:         [{ seat: 0, master: scalarToBytes(17n) }],
734:         recoveryStore,
735:       ),
736:     );
737:     const packet = value(
738:       await prepareTransferPrivate({
739:         journal: sourceJournal,
740:         engine: createBaseEngine(),
741:         policy: fixture.policy,
742:         authorization: transferEntryRef(transferAuthEntry),
743:         sourceSeat: 1,
744:         sourceKind: 'current-controller',
745:         signingKey: recoveryFixtureKey(fixture, 1),
746:         entropy: new Uint8Array(32).fill(33),
747:         nonce: new Uint8Array(32).fill(34),
748:         outbox: store,
749:         recoveryPrivateStore: recoveryStore,
750:       }),
751:     );
752:     await participant.importPacket(packet);
753:     const readiness = await participant.prepareReadiness();
754:     const humanStatus = value(
755:       fixture.source.engine.apply(transferPending.log.state, {
756:         kind: 'system',
757:         type: 'SEAT_STATUS',
758:         seat: 0,
759:         status: 'active',
760:       }),
761:     );
762:     const activationEntry = signRecoveryFixtureEntry(
763:       fixture,
764:       transferPending,
765:       { kind: 'membership', change: readiness },
766:       toHex(hashValue(humanStatus.state)),
767:     );
768:     const activation = certifyRecoveryFixtureEntry(
769:       fixture,
770:       transferPending,
771:       activationEntry,
772:       [1, 2, 3],
773:     );
774:     advanceRecoveryFixture(transferPending, activation);
775:     entries.push(activation);
776:     const activatedBootstrap = value(encodeOnlineTransferBootstrap({ start: record, entries }));
777:     if (oldJournalPhase === 'pre-removal') {
778:       const conflictingEntry = signRecoveryFixtureEntry(
779:         fixture,
780:         fixture.ready,
781:         { kind: 'membership', change: { kind: 'seat-offline', seat: 1 } },
782:         fixture.ready.log.head.stateHash,
783:       );
784:       const conflicting = certifyRecoveryFixtureEntry(
785:         fixture,
786:         fixture.ready,
787:         conflictingEntry,
788:         [1, 2, 3],
789:       );
790:       const checkedDecision = restoreConsensusState(
791:         { ...priorSafety, decision: conflicting },
792:         fixture.ready,
793:         0,
794:       );
795:       if (!checkedDecision.ok)
796:         throw new Error(`Conflicting decision fixture: ${checkedDecision.error.message}`);
797:       const safetyJournal = new IndexedDbProtocolJournal(record.gameId, {
798:         keyBinding: {
799:           recordKey: `online-game/${record.genesisDigest}/keys`,
800:           bytes: oldBinding,
801:         },
802:       });
803:       const current = await safetyJournal.load();
804:       if (!current) throw new Error('Former voter journal is missing');
805:       if (
806:         !(await safetyJournal.saveSafety(
807:           current.height,
808:           current.safety.revision,
809:           canonicalEncode({ ...priorSafety, decision: conflicting }),
810:         ))
811:       )
812:         throw new Error('Could not persist conflicting decision');
813:       let rejected = false;
814:       let rejection = '';
815:       try {
816:         await participant.observeActivation(activatedBootstrap);
817:       } catch (error) {
818:         rejection = String(error);
819:         rejected = /conflicting certified decision/.test(rejection);
820:       }
821:       if (!rejected) throw new Error(`Conflicting certified decision was discarded: ${rejection}`);
822:       const persisted = await safetyJournal.load();
823:       if (!persisted) throw new Error('Former voter journal disappeared');
824:       if (
825:         !(await safetyJournal.saveSafety(
826:           persisted.height,
827:           persisted.safety.revision,
828:           canonicalEncode(priorSafety),
829:         ))
830:       )
831:         throw new Error('Could not restore original voter safety');
832:       await safetyJournal.close();
833:     }
834:     if (oldJournalPhase === 'retired') {
835:       let rejected = false;
836:       try {
837:         await participant.observeActivation(activatedBootstrap);
838:       } catch (error) {
839:         rejected = /not retired/.test(String(error));
840:       }
841:       if (!rejected) throw new Error('Unretired post-removal journal was accepted');
842:       const retiringJournal = new IndexedDbProtocolJournal(record.gameId, {
843:         keyBinding: {
844:           recordKey: `online-game/${record.genesisDigest}/keys`,
845:           bytes: oldBinding,
846:         },
847:       });
848:       const incomplete = await retiringJournal.load();
849:       if (!incomplete) throw new Error('Former voter journal is missing');
850:       if (
851:         !(await retiringJournal.saveSafety(
852:           incomplete.height,
853:           incomplete.safety.revision,
854:           canonicalEncode(retired),
855:         ))
FILE packages/storage/src/transfer-import-store.test.ts LINES 945-1110
945:     data.fixture,
946:     data.fixture.ready,
947:     { kind: 'membership', change: { kind: 'seat-offline', seat: 1 } },
948:     data.fixture.ready.log.head.stateHash,
949:   );
950:   const alternate = certifyRecoveryFixtureEntry(
951:     data.fixture,
952:     data.fixture.ready,
953:     alternateEntry,
954:     [0, 1, 2, 3],
955:   );
956:   const existing = [...data.fixture.deckEntries, alternate];
957:   const replayed = replayCertifiedPrefix(
958:     data.fixture.genesisEntry,
959:     existing,
960:     data.fixture.source.engine,
961:     data.fixture.policy,
962:   );
963:   if (!replayed.ok) throw new Error(`Alternate certified entry: ${replayed.error.code}`);
964:   const priorSafety = createConsensusState(replayed.value.context, 0);
965:   if (!priorSafety.ok) throw new Error(`Old controller safety: ${priorSafety.error.code}`);
966:   const pendingEntry = signRecoveryFixtureEntry(
967:     data.fixture,
968:     replayed.value.context,
969:     { kind: 'membership', change: { kind: 'seat-offline', seat: 2 } },
970:     replayed.value.context.log.head.stateHash,
971:   );
972:   const conflictingDecision = certifyRecoveryFixtureEntry(
973:     data.fixture,
974:     replayed.value.context,
975:     pendingEntry,
976:     [1, 2, 3],
977:   );
978:   const pendingSafety = {
979:     ...priorSafety.value,
980:     decision: conflictingDecision,
981:   };
982:   const checkedSafety = restoreConsensusState(pendingSafety, replayed.value.context, 0);
983:   if (!checkedSafety.ok) throw new Error(`Pending decision: ${checkedSafety.error.message}`);
984:   expect(alternate.entry.seq).toBe(data.entries.at(-1)?.entry.seq);
985:   const importedLast = data.entries.at(-1);
986:   if (!importedLast) throw new Error('Imported head missing');
987:   expect(entryHash(alternate.entry)).not.toBe(entryHash(importedLast.entry));
988: 
989:   const gameId = data.fixture.genesis.gameId;
990:   const recordKey = `online-game/${genesisDigest(data.fixture.genesis)}/keys`;
991:   const database = await openDB('cp2p', 3, {
992:     upgrade(db) {
993:       db.createObjectStore('bytes');
994:       db.createObjectStore('games');
995:       db.createObjectStore('entries');
996:       db.createObjectStore('consensus');
997:       db.createObjectStore('deletedGames');
998:     },
999:   });
1000:   await database.put('games', canonicalEncode(data.fixture.genesisEntry), gameId);
1001:   await Promise.all(
1002:     existing.map((entry, index) =>
1003:       database.put('entries', canonicalEncode(entry), [gameId, index + 1]),
1004:     ),
1005:   );
1006:   await database.put(
1007:     'consensus',
1008:     canonicalEncode({
1009:       height: existing.length + 1,
1010:       revision: 0,
1011:       safety: canonicalEncode(pendingSafety),
1012:     }),
1013:     gameId,
1014:   );
1015:   await database.put('bytes', data.oldBindingBytes, recordKey);
1016:   database.close();
1017: 
1018:   const stage = new TransferImportStore();
1019:   const stageKey = await stage.stage(
1020:     {
1021:       gameId,
1022:       authorization: data.authorizationRef,
1023:       destinationGameKey: data.game.peerId,
1024:       bindingBytes: data.bindingBytes,
1025:       sealedPackage: Uint8Array.of(1),
1026:       privateReplayBytes: Uint8Array.of(2),
1027:       genesis: data.fixture.genesisEntry,
1028:       entries: data.entries,
1029:     },
1030:     data.fixture.source.engine,
1031:     data.fixture.policy,
1032:   );
1033:   await stage.saveReadiness(stageKey, {
1034:     protocol: 'seat-transfer-readiness-v1',
1035:     statement: data.activationStatement,
1036:     destinationCheck: data.destinationCheck,
1037:     replacementChecks: [],
1038:   });
1039:   const journal = new IndexedDbProtocolJournal(gameId, {
1040:     keyBinding: { recordKey, bytes: data.bindingBytes },
1041:   });
1042:   const options = {
1043:     stageKey,
1044:     activation: data.activationCertificate,
1045:     engine: data.fixture.source.engine,
1046:     policy: data.fixture.policy,
1047:     expectedActive: {
1048:       head: transferEntryRef(alternate.entry),
1049:       bindingBytes: data.oldBindingBytes,
1050:     },
1051:     leaseOptions: { lockManager: new TestLocks() },
1052:   };
1053:   await expect(journal.promoteTransfer(options)).rejects.toThrow('conflicting certified decision');
1054:   const cleared = await openDB('cp2p');
1055:   await cleared.put(
1056:     'consensus',
1057:     canonicalEncode({
1058:       height: existing.length + 1,
1059:       revision: 0,
1060:       safety: canonicalEncode(priorSafety.value),
1061:     }),
1062:     gameId,
1063:   );
1064:   cleared.close();
1065:   const corrupted = await openDB('cp2p');
1066:   await corrupted.put(
1067:     'consensus',
1068:     canonicalEncode({
1069:       height: existing.length + 1,
1070:       revision: 0,
1071:       safety: canonicalEncode({ ...priorSafety.value, localPublicKey: data.game.peerId }),
1072:     }),
1073:     gameId,
1074:   );
1075:   corrupted.close();
1076:   await expect(journal.promoteTransfer(options)).rejects.toThrow('controller safety is invalid');
1077:   const repaired = await openDB('cp2p');
1078:   await repaired.put(
1079:     'consensus',
1080:     canonicalEncode({
1081:       height: existing.length + 1,
1082:       revision: 0,
1083:       safety: canonicalEncode(priorSafety.value),
1084:     }),
1085:     gameId,
1086:   );
1087:   repaired.close();
1088:   await expect(journal.promoteTransfer(options)).rejects.toThrow('conflicts with certified import');
1089:   const unchanged = await openDB('cp2p');
1090:   expect(await unchanged.get('entries', [gameId, alternate.entry.seq])).toEqual(
1091:     canonicalEncode(alternate),
1092:   );
1093:   unchanged.close();
1094:   expect(await stage.load(stageKey)).not.toBeNull();
1095:   await journal.close();
1096:   await stage.close();
1097: }, 30_000);
FILE packages/storage/src/game-writer.ts LINES 1-135
1: export type GameWriterLockManager = Pick<LockManager, 'request'>;
2: 
3: export interface GameWriterLeaseOptions {
4:   /** Test seam; production uses the same-origin browser Web Locks manager. */
5:   readonly lockManager?: GameWriterLockManager;
6:   /** Called synchronously once if the held lock ends before normal release. */
7:   readonly onLost?: (error: GameWriterLeaseError) => void;
8: }
9: 
10: export interface GameWriterLease {
11:   readonly lockName: string;
12:   /** Run session work in order while retaining the exclusive lock. */
13:   run<T>(task: () => T | PromiseLike<T>): Promise<T>;
14:   /** Stop accepting work, drain accepted work, then release the lock. */
15:   close(): Promise<void>;
16: }
17: 
18: export class GameWriterLeaseError extends Error {
19:   constructor(
20:     readonly code: 'unavailable' | 'closed' | 'lost',
21:     message: string,
22:   ) {
23:     super(message);
24:     this.name = 'GameWriterLeaseError';
25:   }
26: }
27: 
28: /** Acquire one per-game, per-voter browser writer lease without waiting or stealing. */
29: export async function acquireGameWriterLease(
30:   gameId: string,
31:   voterIdentity: string,
32:   options: GameWriterLeaseOptions = {},
33: ): Promise<GameWriterLease | null> {
34:   return acquireLease(writerLockName(gameId, voterIdentity), options);
35: }
36: 
37: /** All active controller generations of one local game must share this lease. */
38: export function acquireActiveGameWriterLease(
39:   gameId: string,
40:   options: GameWriterLeaseOptions = {},
41: ): Promise<GameWriterLease | null> {
42:   validateId(gameId, 'gameId');
43:   return acquireLease(`cp2p/game-active/${gameId.length}:${gameId}`, options);
44: }
45: 
46: /** Private import work cannot acquire the active journal lease before activation. */
47: export function acquireTransferStagingLease(
48:   gameId: string,
49:   authorizationId: string,
50:   options: GameWriterLeaseOptions = {},
51: ): Promise<GameWriterLease | null> {
52:   validateId(gameId, 'gameId');
53:   validateId(authorizationId, 'authorizationId');
54:   return acquireLease(
55:     `cp2p/transfer-stage/${gameId.length}:${gameId}/${authorizationId.length}:${authorizationId}`,
56:     options,
57:   );
58: }
59: 
60: async function acquireLease(
61:   name: string,
62:   options: GameWriterLeaseOptions,
63: ): Promise<GameWriterLease | null> {
64:   const manager = options.lockManager ?? browserLockManager();
65:   let releaseLock!: () => void;
66:   const releaseSignal = new Promise<void>((resolve) => {
67:     releaseLock = resolve;
68:   });
69:   let resolveAcquired!: (lock: Lock | null) => void;
70:   const acquired = new Promise<Lock | null>((resolve) => {
71:     resolveAcquired = resolve;
72:   });
73:   let lockRequestError: unknown;
74:   let leaseActive = false;
75:   let accepting = true;
76:   let expectedRelease = false;
77:   let lostError: GameWriterLeaseError | null = null;
78:   const notifyLost = () => {
79:     if (!leaseActive || expectedRelease || lostError) return;
80:     lostError = new GameWriterLeaseError('lost', 'Game writer lock ended unexpectedly');
81:     try {
82:       options.onLost?.(lostError);
83:     } catch {
84:       // A notification is advisory cleanup; it must not create an unhandled lock rejection.
85:     }
86:   };
87:   const lockRequest = manager
88:     .request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
89:       if (lock) leaseActive = true;
90:       resolveAcquired(lock);
91:       if (lock) await releaseSignal;
92:     })
93:     .then(
94:       () => {
95:         notifyLost();
96:         return undefined;
97:       },
98:       (error: unknown) => {
99:         lockRequestError = error;
100:         if (leaseActive) notifyLost();
101:         else resolveAcquired(null);
102:       },
103:     );
104: 
105:   const lock = await acquired;
106:   if (!lock) {
107:     await lockRequest;
108:     if (lockRequestError !== undefined) throw lockRequestError;
109:     return null;
110:   }
111: 
112:   let queue: Promise<void> = Promise.resolve();
113:   let closePromise: Promise<void> | null = null;
114: 
115:   return {
116:     lockName: name,
117:     run<T>(task: () => T | PromiseLike<T>): Promise<T> {
118:       if (!accepting)
119:         return Promise.reject(new GameWriterLeaseError('closed', 'Game writer lease is closed'));
120:       if (lostError) return Promise.reject(lostError);
121:       const result = queue.then(async () => {
122:         if (lostError) throw lostError;
123:         return task();
124:       });
125:       queue = result.then(
126:         () => undefined,
127:         () => undefined,
128:       );
129:       return result;
130:     },
131:     close(): Promise<void> {
132:       if (closePromise) return closePromise;
133:       accepting = false;
134:       closePromise = (async () => {
135:         await queue;
FILE apps/web/src/session/online-game.ts LINES 165-200
165:           const decks = validateDeckCeremony(genesis, input.transcripts);
166:           return decks.ok ? success(undefined) : decks;
167:         },
168:       },
169:       entry: {},
170:     };
171:     const checked = initialProposalContext(input.entry, input.engine, policy);
172:     if (!checked.ok) throw new Error(checked.error.message);
173:     const { genesis, state, crypto } = checked.value.log;
174:     const startup = validateGenesisOnlineStart(genesis);
175:     if (!startup.ok) throw new Error(startup.error.message);
176:     if (!crypto) throw new Error('Verified game commitments are missing');
177:     const humans = material.filter((seat) => seat.kind === 'human');
178:     const local = humans[0];
179:     if (humans.length !== 1 || !local) throw new Error('Stored material needs one human seat');
180:     lease = await (runtime.acquireLease ?? acquireActiveGameWriterLease)(genesis.gameId, {
181:       onLost(error) {
182:         leaseLost = true;
183:         transport?.dispose();
184:         session?.dispose();
185:         try {
186:           input.onFatal?.(error);
187:         } catch {
188:           // Reporting failure cannot restore authority or resume output.
189:         }
190:       },
191:     });
192:     checkCancelled();
193:     if (!lease) throw new Error('This game is already active in another tab');
194:     const digest = genesisDigest(genesis);
195:     const keyBinding = {
196:       recordKey: `online-game/${digest}/keys`,
197:       bytes: canonicalEncode({
198:         protocol: 'online-game-keys-v1',
199:         genesisDigest: digest,
200:         devicePeer: input.deviceTransport.self,

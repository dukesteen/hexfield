import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import type { Seat } from '@cp2p/engine';
import type { AuditReport, CertifiedEntry, LogEntry, SessionAuditInput } from '@cp2p/protocol';
import { certifiedEntrySchema, logEntrySchema } from '@cp2p/protocol';
import { safeParse } from 'valibot';
import { createSessionAuditRunner } from '../session/audit-worker-client.js';

const FIXTURE_URL = '/dev/recovered-audit-fixture.json';
const FIXTURE_LIMIT_BYTES = 64 * 1024 * 1024;
const AUDIT_DEADLINE_MS = 60_000;

interface AuditFixture {
  readonly genesisEntry: LogEntry;
  readonly entries: readonly CertifiedEntry[];
  readonly masters: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
  readonly report: AuditReport;
  readonly submittedCommands: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeat(value: unknown): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function isAuditReference(value: unknown): boolean {
  return (
    value === null ||
    (record(value) && Number.isSafeInteger(value.seq) && typeof value.hash === 'string')
  );
}

function isAuditReport(value: unknown): value is AuditReport {
  return (
    record(value) &&
    typeof value.ok === 'boolean' &&
    typeof value.complete === 'boolean' &&
    Array.isArray(value.missingSeats) &&
    Array.isArray(value.violations) &&
    Array.isArray(value.inputErrors) &&
    Array.isArray(value.cheatFindings) &&
    isAuditReference(value.terminal) &&
    isAuditReference(value.finalHead) &&
    (value.historyError === null ||
      (record(value.historyError) && typeof value.historyError.code === 'string')) &&
    (value.auditError === null ||
      (record(value.auditError) &&
        Number.isSafeInteger(value.auditError.seq) &&
        typeof value.auditError.code === 'string'))
  );
}

function parseMaster(value: unknown): Uint8Array {
  const master =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : Array.isArray(value) &&
          value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        ? Uint8Array.from(value, (byte) => Number(byte))
        : null;
  if (!master || master.byteLength !== 32) {
    master?.fill(0);
    throw new Error('Fixture has an invalid master byte array');
  }
  return master;
}

function parseFixture(value: unknown): AuditFixture {
  if (!record(value)) throw new Error('Fixture must be an object');
  const genesis = safeParse(logEntrySchema, value.genesisEntry);
  if (!genesis.success || !Array.isArray(value.entries) || !isAuditReport(value.report))
    throw new Error('Fixture has invalid genesis, entries, or expected report');
  const entries: CertifiedEntry[] = [];
  for (const entry of value.entries) {
    const parsed = safeParse(certifiedEntrySchema, entry);
    if (!parsed.success) throw new Error('Fixture contains an invalid certified entry');
    entries.push(parsed.output);
  }
  if (!Array.isArray(value.masters) || value.masters.length === 0)
    throw new Error('Fixture has no master reveals');
  const seenSeats = new Set<number>();
  const masters: { seat: Seat; master: Uint8Array }[] = [];
  try {
    for (const item of value.masters) {
      if (!record(item) || !isSeat(item.seat))
        throw new Error('Fixture contains an invalid master seat');
      const seat = item.seat;
      if (seenSeats.has(seat)) throw new Error('Fixture contains duplicate master seats');
      seenSeats.add(seat);
      masters.push({ seat, master: parseMaster(item.master) });
    }
    if (!Number.isSafeInteger(value.submittedCommands) || Number(value.submittedCommands) < 1)
      throw new Error('Fixture has an invalid submitted command count');
    return {
      genesisEntry: genesis.output,
      entries,
      masters,
      report: value.report,
      submittedCommands: Number(value.submittedCommands),
    };
  } catch (error) {
    masters.forEach(({ master }) => master.fill(0));
    throw error;
  }
}

function wipeFixtureMasters(value: unknown): void {
  if (!record(value) || !Array.isArray(value.masters)) return;
  for (const item of value.masters) {
    if (!record(item)) continue;
    const master = item.master;
    if (master instanceof Uint8Array) master.fill(0);
    else if (Array.isArray(master)) master.fill(0);
  }
}

function reportMatches(actual: AuditReport, expected: AuditReport): boolean {
  const actualBytes = canonicalEncode(actual);
  const expectedBytes = canonicalEncode(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    actualBytes.every((byte, index) => byte === expectedBytes[index])
  );
}

function metadata(report: AuditReport): string[] {
  return [
    `ok: ${report.ok}`,
    `complete: ${report.complete}`,
    `terminal: ${report.terminal ? `${report.terminal.seq} ${report.terminal.hash}` : 'none'}`,
    `finalHead: ${report.finalHead ? `${report.finalHead.seq} ${report.finalHead.hash}` : 'none'}`,
    `violations: ${JSON.stringify(report.violations)}`,
    `auditError: ${JSON.stringify(report.auditError)}`,
    `historyError: ${JSON.stringify(report.historyError)}`,
  ];
}

const button = document.querySelector<HTMLButtonElement>('#run');
const output = document.querySelector<HTMLPreElement>('#output');
const audit = createSessionAuditRunner(undefined, { deadlineMs: AUDIT_DEADLINE_MS });

if (button && output) {
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    output.textContent = '';
    let decodedFixture: unknown;
    let ownedMasters: Uint8Array[] = [];
    let elapsedTimer: ReturnType<typeof setInterval> | undefined;
    let elapsedReported = false;
    const startedAt = performance.now();
    const write = (line: string) => {
      output.textContent += `${line}\n`;
    };
    try {
      write('Loading and validating the local audit fixture…');
      const response = await fetch(FIXTURE_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Fixture load failed (${response.status})`);
      const declaredBytes = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredBytes) && declaredBytes > FIXTURE_LIMIT_BYTES)
        throw new Error('Fixture is larger than the 64 MiB limit');
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > FIXTURE_LIMIT_BYTES)
        throw new Error('Fixture is larger than the 64 MiB limit');
      decodedFixture = canonicalDecode(new TextEncoder().encode(text));
      const fixture = parseFixture(decodedFixture);
      ownedMasters = fixture.masters.map(({ master }) => master);
      wipeFixtureMasters(decodedFixture);
      const input: SessionAuditInput = {
        genesisEntry: fixture.genesisEntry,
        entries: fixture.entries,
        masters: fixture.masters,
      };
      write(
        `Fixture ready: ${fixture.entries.length} certified entries, ${fixture.submittedCommands} submitted commands.`,
      );
      write('Audit running in a worker (60-second deadline)…');
      elapsedTimer = setInterval(() => {
        output.textContent = `Audit running: ${Math.floor((performance.now() - startedAt) / 1000)} s elapsed.\n`;
      }, 250);
      const report = audit(input);
      const actual = await report.result;
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
      const matches = reportMatches(actual, fixture.report);
      write(`Elapsed: ${((performance.now() - startedAt) / 1000).toFixed(2)} s`);
      elapsedReported = true;
      write(`Expected report match: ${matches ? 'PASS' : 'FAIL'}`);
      for (const line of metadata(actual)) write(line);
      if (!matches) throw new Error('Computed audit report differs from fixture expectation');
      write('PASS native browser audit worker check complete');
    } catch (error) {
      if (!elapsedReported)
        write(`Elapsed: ${((performance.now() - startedAt) / 1000).toFixed(2)} s`);
      write(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (elapsedTimer !== undefined) clearInterval(elapsedTimer);
      wipeFixtureMasters(decodedFixture);
      ownedMasters.forEach((master) => master.fill(0));
      button.disabled = false;
    }
  });
}

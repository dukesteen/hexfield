import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import type { Seat } from '@cp2p/engine';
import { certifiedEntrySchema, logEntrySchema } from '@cp2p/protocol';
import { safeParse } from 'valibot';

const FIXTURE_URL = '/dev/recovered-audit-fixture.json';
const MAX_FIXTURE_BYTES = 64 * 1024 * 1024;
const DEADLINE_MS = 70_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMaster(value: unknown): Uint8Array {
  const bytes =
    value instanceof Uint8Array
      ? value.slice()
      : Array.isArray(value) &&
          value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        ? Uint8Array.from(value)
        : null;
  if (bytes?.byteLength !== 32) throw new Error('Invalid test master');
  return bytes;
}

function parseFixture(value: unknown) {
  if (
    !record(value) ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.masters) ||
    !record(value.report)
  )
    throw new Error('Invalid terminal fixture');
  const genesis = safeParse(logEntrySchema, value.genesisEntry);
  const entries = value.entries.map((item) => safeParse(certifiedEntrySchema, item));
  if (!genesis.success || entries.some((entry) => !entry.success))
    throw new Error('Invalid certified fixture history');
  const masters = value.masters.map((item) => {
    if (
      !record(item) ||
      !Number.isInteger(item.seat) ||
      Number(item.seat) < 0 ||
      Number(item.seat) > 5
    )
      throw new Error('Invalid fixture seat');
    return { seat: Number(item.seat) as Seat, master: parseMaster(item.master) };
  });
  return {
    input: { genesisEntry: genesis.output, entries: entries.map((entry) => entry.output), masters },
    expected: value.report,
  };
}

async function run(): Promise<string> {
  const response = await fetch(FIXTURE_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Fixture load failed (${response.status})`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FIXTURE_BYTES)
    throw new Error('Fixture exceeds 64 MiB');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FIXTURE_BYTES) throw new Error('Fixture exceeds 64 MiB');
  const fixture = parseFixture(canonicalDecode(bytes));
  const worker = new Worker(new URL('./online-worker-nested-audit.ts', import.meta.url), {
    type: 'module',
  });
  try {
    const actual = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Nested worker audit timed out')),
        DEADLINE_MS,
      );
      worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (!record(event.data) || event.data.id !== 1) return;
        clearTimeout(timer);
        if (typeof event.data.error === 'string') reject(new Error(event.data.error));
        else resolve(event.data.report);
      });
      worker.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Parent audit worker failed'));
      });
      worker.postMessage(
        { id: 1, input: fixture.input },
        fixture.input.masters.map(({ master }) => master.buffer),
      );
    });
    const expected = canonicalEncode(fixture.expected);
    const received = canonicalEncode(actual);
    if (
      expected.byteLength !== received.byteLength ||
      !expected.every((byte, index) => byte === received[index])
    )
      throw new Error('Nested audit report differs from certified fixture expectation');
    if (!record(actual) || actual.ok !== true || actual.complete !== true)
      throw new Error('Nested audit did not complete');
    return `PASS nested dedicated-worker audit; ${fixture.input.entries.length} certified entries`;
  } finally {
    worker.terminate();
    for (const item of fixture.input.masters) if (item.master.byteLength > 0) item.master.fill(0);
  }
}

const button = document.querySelector<HTMLButtonElement>('#run');
const output = document.querySelector<HTMLPreElement>('#output');
button?.addEventListener('click', async () => {
  if (!button || !output || button.disabled) return;
  button.disabled = true;
  output.textContent = 'Running native nested worker audit…';
  try {
    output.textContent = await run();
  } catch (error) {
    output.textContent = `FAIL ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    button.disabled = false;
  }
});

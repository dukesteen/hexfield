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
  expect(page.getByText('lobby:onlineTakeoverDisclosure')).toBeTruthy();
  expect(page.queryByRole('button', { name: 'lobby:onlineTakeoverRequest' })).toBeNull();
  page.rerender(<RecoveryPanel {...baseProps} policy={{ mode: 'vote', afterSeconds: 'never' }} />);
  expect(page.container.textContent).toBe('');
});

test('a candidate is not approvable after its seat reconnects or a different seat is missing', () => {
  const approve = vi.fn<() => Promise<Result<typeof candidate.preview>>>(async () =>
    success(candidate.preview),
  );
  const page = render(
    <RecoveryPanel {...baseProps} candidate={candidate} missing={[]} onApprove={approve} />,
  );
  expect(page.container.textContent).toBe('');
  page.rerender(
    <RecoveryPanel
      {...baseProps}
      candidate={candidate}
      missing={[{ seat: 1, name: 'Ari' }]}
      onApprove={approve}
    />,
  );
  expect(page.queryByRole('button', { name: 'lobby:onlineTakeoverApprove' })).toBeNull();
  expect(approve).not.toHaveBeenCalled();
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

test('eligibility refresh pauses while a signed candidate awaits a vote', async () => {
  vi.useFakeTimers();
  const eligibility = vi.fn<() => Promise<Result<void>>>(async () => success(undefined));
  const page = render(<RecoveryPanel {...baseProps} onEligibility={eligibility} />);
  await act(async () => Promise.resolve());
  expect(eligibility).toHaveBeenCalledOnce();
  page.rerender(<RecoveryPanel {...baseProps} candidate={candidate} onEligibility={eligibility} />);
  await act(async () => vi.advanceTimersByTime(4_000));
  expect(eligibility).toHaveBeenCalledOnce();
});

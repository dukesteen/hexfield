// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TransferPanel } from './TransferPanel.js';
import type { TransferPanelProps } from './TransferPanel.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./InvitationCode.js', () => ({
  InvitationCode: ({ label, value }: { label: string; value: string }) => (
    <div data-testid="transfer-invitation">
      {label}:{value}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const baseProps: TransferPanelProps = {
  role: 'source',
  selfDevice: 'ABCDEFGHIJKLMNOPQRSTUV',
  candidates: ['1234567890ABCDEFxyz', 'FEDCBA0987654321xyz'],
  selectedDevice: null,
  phase: 'awaiting-confirmation',
  busy: false,
  error: null,
  onSelectDevice: vi.fn<(peer: string) => void>(),
  onConfirm: vi.fn<() => void>(),
  onCancel: vi.fn<() => void>(),
  onRetry: vi.fn<() => void>(),
  onDismiss: vi.fn<() => void>(),
};

test('requires an explicit destination choice before confirming and disables actions while busy', () => {
  const onSelectDevice = vi.fn<(peer: string) => void>();
  const onConfirm = vi.fn<() => void>();
  const onCancel = vi.fn<() => void>();
  const page = render(
    <TransferPanel
      {...baseProps}
      onSelectDevice={onSelectDevice}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  expect(page.getByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
  const confirm = page.getByRole('button', { name: 'lobby:transferConfirm' });
  expect(confirm.getAttribute('disabled')).not.toBeNull();
  const radio = page.getAllByRole('radio')[0];
  if (!radio) throw new Error('Expected at least one device choice');
  fireEvent.click(radio);
  expect(onSelectDevice).toHaveBeenCalledWith(baseProps.candidates[0]);
  page.rerender(
    <TransferPanel
      {...baseProps}
      selectedDevice={baseProps.candidates[0] ?? null}
      busy
      onSelectDevice={onSelectDevice}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  expect(
    page.getByRole('button', { name: 'lobby:transferConfirm' }).getAttribute('disabled'),
  ).not.toBeNull();
  expect(
    page.getByRole('button', { name: 'lobby:transferCancel' }).getAttribute('disabled'),
  ).not.toBeNull();
  fireEvent.click(page.getByRole('button', { name: 'lobby:transferConfirm' }));
  expect(onConfirm).not.toHaveBeenCalled();
});

test('source shows its invitation and hides cancellation after activation', () => {
  const onCancel = vi.fn<() => void>();
  const page = render(
    <TransferPanel
      {...baseProps}
      role="source"
      invitationUrl="https://hexfield.example/transfer/invite"
      phase="activated"
      onCancel={onCancel}
    />,
  );
  expect(page.getByTestId('transfer-invitation').textContent).toContain(
    'https://hexfield.example/transfer/invite',
  );
  expect(page.getByText('lobby:transferOldDeviceWarning')).toBeTruthy();
  expect(page.queryByRole('button', { name: 'lobby:transferCancel' })).toBeNull();
  expect(page.getByRole('status').textContent).toContain('lobby:transferPhase_activated');
  expect(onCancel).not.toHaveBeenCalled();
});

test('selection stays fixed and source cannot cancel while awaiting destination receipt', () => {
  const onSelectDevice = vi.fn<() => void>();
  const page = render(
    <TransferPanel
      {...baseProps}
      selectedDevice={baseProps.candidates[0] ?? null}
      phase="awaiting-receipt"
      onSelectDevice={onSelectDevice}
    />,
  );
  expect(page.getAllByRole('radio')).toHaveLength(1);
  expect(page.getByRole('radio').closest('fieldset')?.disabled).toBe(true);
  expect(
    page.getByRole('button', { name: 'lobby:transferCancel' }).getAttribute('disabled'),
  ).not.toBeNull();
  expect(page.getByRole('button', { name: 'lobby:manualClose' })).toBeTruthy();
  expect(onSelectDevice).not.toHaveBeenCalled();
  page.rerender(
    <TransferPanel
      {...baseProps}
      selectedDevice={baseProps.candidates[0] ?? null}
      phase="cancelled-awaiting-receipt"
    />,
  );
  expect(page.getByRole('status').textContent).toContain(
    'lobby:transferPhase_cancelled-awaiting-receipt',
  );
  expect(page.queryByRole('button', { name: 'lobby:transferCancel' })).toBeNull();
});

test('destination can close its importer without claiming certified cancellation', () => {
  const onCancel = vi.fn<() => void>();
  const onDismiss = vi.fn<() => void>();
  const page = render(
    <TransferPanel
      {...baseProps}
      role="destination"
      selectedDevice={baseProps.candidates[0] ?? null}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />,
  );
  expect(page.queryByRole('button', { name: 'lobby:transferCancel' })).toBeNull();
  expect(page.queryByRole('radio')).toBeNull();
  expect(page.getByText('lobby:transferSourceDevice')).toBeTruthy();
  fireEvent.click(page.getByRole('button', { name: 'lobby:manualClose' }));
  expect(onDismiss).toHaveBeenCalledOnce();
  expect(onCancel).not.toHaveBeenCalled();
  page.rerender(<TransferPanel {...baseProps} role="destination" phase="activated" />);
  expect(page.getByRole('status').textContent).toContain('lobby:transferDestinationActivated');
});

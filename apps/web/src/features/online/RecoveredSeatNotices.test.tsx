// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Seat } from '@cp2p/engine';
import { afterEach, expect, test, vi } from 'vitest';
import { RecoveredSeatNotices } from './RecoveredSeatNotices';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
afterEach(cleanup);

test('the bot host sees each returnable seat with its return action', () => {
  const onReturn = vi.fn<(seat: Seat) => void>();
  const page = render(
    <RecoveredSeatNotices
      selfSeat={null}
      returnable={[{ seat: 0, name: 'Ada' }]}
      onReturn={onReturn}
    />,
  );
  expect(page.getByText('lobby:returnableSeatTitle:{"player":"Ada"}')).toBeTruthy();
  fireEvent.click(page.getByRole('button', { name: 'lobby:transferReturnSourceTitle:{"seat":1}' }));
  expect(onReturn).toHaveBeenCalledWith(0);
  expect(page.queryByText(/recoveredSelfTitle/)).toBeNull();
});

test('the replaced player is told how to take the seat back', () => {
  const page = render(<RecoveredSeatNotices selfSeat={2} returnable={[]} onReturn={() => {}} />);
  expect(page.getByText('lobby:recoveredSelfTitle')).toBeTruthy();
  expect(page.getByText('lobby:recoveredSelfBody:{"seat":3}')).toBeTruthy();
  expect(page.queryAllByRole('button')).toHaveLength(0);
});

test('a retired original device learns why it stopped and how to return', () => {
  const page = render(
    <RecoveredSeatNotices selfSeat={0} retired returnable={[]} onReturn={() => {}} />,
  );
  expect(page.getByText('lobby:retiredSelfTitle:{"seat":1}')).toBeTruthy();
  expect(page.getByText('lobby:retiredSelfBody')).toBeTruthy();
});

test('nothing renders without a recovered seat', () => {
  const page = render(<RecoveredSeatNotices selfSeat={null} returnable={[]} onReturn={() => {}} />);
  expect(page.container.childElementCount).toBe(0);
});

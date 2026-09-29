// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { testI18n, withI18n } from '../knights/test-support';
import { BuildCostsDialog } from './BuildCostsDialog';

let i18n: Awaited<ReturnType<typeof testI18n>>;
beforeAll(async () => {
  i18n = await testI18n();
});
afterEach(cleanup);

/** The accessible price of one kind in a knights cost row. */
const label = (row: string, kind: string) =>
  within(screen.getByTestId('knight-costs'))
    .getByText(row)
    .parentElement?.querySelector(`[aria-label$="${kind}"]`)
    ?.getAttribute('aria-label');

test('a base game lists road, settlement, city and the development card only', () => {
  withI18n(i18n, <BuildCostsDialog onClose={() => {}} />);
  const rows = screen.getAllByText(/^(Road|Settlement|City|Development card)$/);
  expect(rows).toHaveLength(4);
  expect(screen.queryByTestId('knight-costs')).toBeNull();
  expect(screen.queryByTestId('improvement-costs')).toBeNull();
});

test('a knights game swaps the development card for knights, walls and improvements', () => {
  withI18n(i18n, <BuildCostsDialog knights onClose={() => {}} />);
  expect(screen.queryByText('Development card')).toBeNull();
  const knights = within(screen.getByTestId('knight-costs'));
  expect(knights.getByText('Recruit knight').parentElement?.textContent).toContain('1');
  expect(label('Recruit knight', 'Wool')).toBe('1 Wool');
  expect(label('Recruit knight', 'Ore')).toBe('1 Ore');
  expect(label('Promote knight', 'Ore')).toBe('1 Ore');
  expect(label('Activate knight', 'Grain')).toBe('1 Grain');
  expect(label('Build city wall', 'Brick')).toBe('2 Brick');
});

test('each track lists its five levels at the price of its commodity', () => {
  withI18n(i18n, <BuildCostsDialog knights onClose={() => {}} />);
  const tracks = screen.getByTestId('improvement-costs');
  const paper = tracks.querySelector('[data-cost="science"]');
  expect(paper?.textContent).toContain('Science');
  const levels = [...(paper?.querySelectorAll('[role="img"]') ?? [])].map((item) =>
    item.getAttribute('aria-label'),
  );
  expect(levels).toEqual([
    'Level 1: 1 Paper',
    'Level 2: 2 Paper',
    'Level 3: 3 Paper',
    'Level 4: 4 Paper',
    'Level 5: 5 Paper',
  ]);
  expect(tracks.querySelector('[data-cost="trade"] [role="img"]')?.getAttribute('aria-label')).toBe(
    'Level 1: 1 Cloth',
  );
  expect(
    tracks.querySelector('[data-cost="politics"] [role="img"]')?.getAttribute('aria-label'),
  ).toBe('Level 1: 1 Coin');
});

test('Close closes it', () => {
  const onClose = vi.fn<() => void>();
  withI18n(i18n, <BuildCostsDialog knights onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
});

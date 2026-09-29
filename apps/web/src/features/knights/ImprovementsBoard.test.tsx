// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { knightsExt } from '@cp2p/engine';
import type { GameState } from '@cp2p/engine';
import { ImprovementsBoard, MiniTracks } from './ImprovementsBoard';
import { genesis, presentation, testI18n, withI18n } from './test-support';

let i18n: Awaited<ReturnType<typeof testI18n>>;
beforeAll(async () => {
  i18n = await testI18n();
});
afterEach(cleanup);

/** The game with a seat's levels set, and metropolises given to seats. */
function leveled(
  levels: Record<string, number>,
  metropolises: Record<string, { seat: number; vertex: string }> = {},
): GameState {
  const ext = knightsExt(genesis);
  return {
    ...genesis,
    ext: {
      ...genesis.ext,
      knights: {
        ...ext,
        improvements: ext.improvements.map((item, seat) =>
          seat === 0 ? { ...item, ...levels } : item,
        ),
        metropolises: { ...ext.metropolises, ...metropolises },
      },
    },
  };
}

test('a read-only board shows the tracks and levels but offers nothing to buy', () => {
  withI18n(
    i18n,
    <ImprovementsBoard state={leveled({ trade: 2 })} seat={0} presentation={presentation} />,
  );
  expect(screen.getAllByRole('region')).toHaveLength(3);
  expect(screen.getByRole('region', { name: 'Trade: level 2 of 5' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Science: level 0 of 5' })).toBeTruthy();
  expect(screen.queryByTestId('improve-trade')).toBeNull();
});

test('the next level of a buyable track is a button that names its cost and buys', () => {
  const onBuy = vi.fn<(track: string) => void>();
  withI18n(
    i18n,
    <ImprovementsBoard
      state={leveled({ science: 1 })}
      seat={0}
      presentation={presentation}
      buyable={['science']}
      onBuy={onBuy}
    />,
  );
  const buy = screen.getByRole('button', { name: 'Buy Science level 2 for 2 Paper' });
  fireEvent.click(buy);
  expect(onBuy).toHaveBeenCalledWith('science');
  expect(screen.getByText('Next: level 2 costs 2 Paper')).toBeTruthy();
});

test('a track the seat cannot buy now is a disabled button that says so, and never buys', () => {
  const onBuy = vi.fn<(track: string) => void>();
  withI18n(
    i18n,
    <ImprovementsBoard
      state={leveled({})}
      seat={0}
      presentation={presentation}
      buyable={['science']}
      onBuy={onBuy}
    />,
  );
  const trade = screen.getByRole('button', { name: 'Trade level 1 is not available now' });
  expect(trade.hasAttribute('disabled')).toBe(true);
  fireEvent.click(trade);
  expect(onBuy).not.toHaveBeenCalled();
});

test('buying is blocked while a move is being sent', () => {
  withI18n(
    i18n,
    <ImprovementsBoard
      state={leveled({})}
      seat={0}
      presentation={presentation}
      buyable={['science']}
      disabled
    />,
  );
  expect(screen.getByTestId('improve-science').hasAttribute('disabled')).toBe(true);
});

test('a finished track has no next level, and the metropolis holder is named', () => {
  const state = leveled({ politics: 5 }, { politics: { seat: 0, vertex: 'v:0,0,N' } });
  withI18n(
    i18n,
    <ImprovementsBoard state={state} seat={0} presentation={presentation} buyable={[]} />,
  );
  const politics = screen.getByRole('region', {
    name: "Politics: complete. Holds this track's metropolis",
  });
  expect(politics).toBeTruthy();
  expect(screen.queryByTestId('improve-politics')).toBeNull();
  expect(screen.queryByText(/Next: level 6/)).toBeNull();
  // Only the holder's own board shows the piece.
  expect(politics.querySelector('.improve-metropolis')).not.toBeNull();
});

test('another seat with no metropolis shows none, and captions can be trimmed', () => {
  const state = leveled({}, { trade: { seat: 1, vertex: 'v:1,0,N' } });
  const { container } = withI18n(
    i18n,
    <ImprovementsBoard state={state} seat={0} presentation={presentation} captions="none" />,
  );
  expect(container.querySelector('.improve-metropolis')).toBeNull();
  expect(container.querySelector('.improve-caption')).toBeNull();
  expect(container.querySelector('.improve-next')).toBeNull();
});

test('the level three cell carries the ability as its tooltip', () => {
  const { container } = withI18n(
    i18n,
    <ImprovementsBoard state={leveled({ trade: 3 })} seat={0} presentation={presentation} />,
  );
  const cell = container.querySelector('[data-track="trade"] .improve-cell[data-level="3"]');
  expect(cell?.getAttribute('data-ability')).toBe('true');
  expect(cell?.getAttribute('title')).toBeTruthy();
});

test('the mini tracks show one row per track with the metropolis marked for its holder', () => {
  const state = leveled({ science: 4 }, { science: { seat: 0, vertex: 'v:0,0,N' } });
  const { container } = withI18n(i18n, <MiniTracks state={state} seat={0} />);
  expect(container.querySelectorAll('li')).toHaveLength(3);
  expect(container.querySelector('[data-track="science"] .mini-metropolis')).not.toBeNull();
  expect(container.querySelector('[data-track="trade"] .mini-metropolis')).toBeNull();
  expect(container.querySelectorAll('[data-track="science"] i[data-filled="true"]')).toHaveLength(
    4,
  );
});

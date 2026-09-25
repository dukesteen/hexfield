import { useEffect, useState } from 'react';
import type { BoardAppearance } from '@cp2p/renderer';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { useSettings } from '../../queries/hooks';

const COLORS = {
  blue: 0x0072b2,
  orange: 0xd55e00,
  green: 0x009e73,
  magenta: 0xb35b93,
} as const;

export function useBoardAppearance(presentation: GamePresentation): {
  appearance: BoardAppearance;
  reducedMotion: boolean;
} {
  const settings = useSettings();
  const [systemDark, setSystemDark] = useState(false);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const theme = settings.data?.theme ?? 'system';
  return {
    appearance: {
      theme: theme === 'system' ? (systemDark ? 'dark' : 'light') : theme,
      players: presentation.players.map((player) => ({
        seat: player.seat,
        color: COLORS[player.color],
        marker: player.shape,
      })),
    },
    reducedMotion: settings.data?.reducedMotion === 'reduce' || systemReducedMotion,
  };
}

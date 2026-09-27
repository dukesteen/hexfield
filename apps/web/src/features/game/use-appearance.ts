import { useEffect, useState } from 'react';
import type { BoardAppearance } from '@cp2p/renderer';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { useSettings } from '../../queries/hooks';

export const BOARD_PLAYER_COLORS = {
  blue: 0x4f7fbf,
  orange: 0xe59a3c,
  green: 0x6fa35a,
  magenta: 0x292528,
  yellow: 0xf2ebd8,
  red: 0xc2493a,
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
        color: BOARD_PLAYER_COLORS[player.color],
        marker: player.shape,
      })),
    },
    reducedMotion: settings.data?.reducedMotion === 'reduce' || systemReducedMotion,
  };
}

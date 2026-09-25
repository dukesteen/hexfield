import type { GamePresentation } from '../../queries/repositories/saved-games';

type PlayerIdentity = GamePresentation['players'][number];

const triangle = {
  standard: {
    size: 18,
    stroke: 1.5,
    outline: '9,1.75 16.75,16.25 1.25,16.25',
  },
  hero: {
    size: 28,
    stroke: 2,
    outline: '14,2 26.5,26 1.5,26',
    fill: '14,5.79 23.62,24.25 4.38,24.25',
  },
} as const;

export function PlayerMarker({
  shape,
  color,
  hero = false,
}: {
  shape: PlayerIdentity['shape'];
  color: PlayerIdentity['color'];
  hero?: boolean;
}) {
  const geometry = hero ? triangle.hero : triangle.standard;
  return (
    <span className={`player-marker marker-${shape} color-${color}`} aria-hidden="true">
      {shape === 'triangle' && (
        <svg viewBox={`0 0 ${geometry.size} ${geometry.size}`} focusable="false">
          <polygon
            className={hero ? 'triangle-outline' : 'triangle-solid'}
            points={geometry.outline}
            strokeWidth={geometry.stroke}
            strokeLinejoin="round"
          />
          {hero && <polygon className="triangle-fill" points={triangle.hero.fill} />}
        </svg>
      )}
    </span>
  );
}

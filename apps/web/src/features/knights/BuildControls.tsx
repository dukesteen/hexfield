import { useTranslation } from 'react-i18next';
import { RESOURCES, isBaseResource } from '@cp2p/engine';
import type { CardCounts } from '@cp2p/engine';
import {
  getCommodityIconUrl,
  getKnightIconUrl,
  getPieceIconUrl,
  getResourceIconUrl,
  getWallIconUrl,
} from '@cp2p/renderer';
import type { ActionAvailability, PlacementKind } from '../actions/availability';
import { costOfKind } from './costs';
import { isCommodity } from './state';
import './knights.css';

/** The board actions a seat takes with its knights and walls, in the order they are offered. */
const BUILD_ORDER = [
  'knight',
  'wall',
  'sideways',
  'activate',
  'promote',
  'moveKnight',
  'displaceKnight',
  'chase',
] as const satisfies readonly PlacementKind[];
type BuildKind = (typeof BUILD_ORDER)[number];

/** Small marks that say what a knight button does. */
function Glyph({ kind }: { kind: BuildKind }) {
  const paths: Partial<Record<BuildKind, string>> = {
    promote: 'M5 15 12 6l7 9M12 6v13',
    moveKnight: 'M4 12h14m-5-5 5 5-5 5',
    displaceKnight: 'M5 5l14 14M19 5 5 19',
    chase: 'M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM8 20v-4a4 4 0 0 1 8 0v4Z',
    activate: 'M13 3 6 14h5l-1 7 8-12h-5z',
  };
  const path = paths[kind];
  if (!path) return null;
  return (
    <svg className="knights-glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ART: Readonly<Record<BuildKind, (color: string) => string>> = {
  knight: (color) => getKnightIconUrl(color, 1, false),
  wall: (color) => getWallIconUrl(color),
  sideways: (color) => getPieceIconUrl('city', color),
  activate: (color) => getKnightIconUrl(color, 2, true),
  promote: (color) => getKnightIconUrl(color, 2, true),
  moveKnight: (color) => getKnightIconUrl(color, 2, false),
  displaceKnight: (color) => getKnightIconUrl(color, 3, true),
  chase: (color) => getKnightIconUrl(color, 1, true),
};

function art(kind: BuildKind, color: string | undefined): string {
  return ART[kind](color ?? 'blue');
}

/** A cost as small resource and commodity icons with counts. */
export function CostChips({ cost }: { cost: CardCounts }) {
  const { t } = useTranslation('knights');
  const kinds = [...RESOURCES, 'cloth', 'coin', 'paper'].filter((kind) => (cost[kind] ?? 0) > 0);
  if (kinds.length === 0) return <span className="knights-cost-free">{t('knights:free')}</span>;
  return (
    <span className="knights-cost" role="img" aria-label={costText(cost, (kind) => kind)}>
      {kinds.map((kind) => (
        <span key={kind} className="knights-cost-item" aria-hidden="true">
          <img
            src={
              isBaseResource(kind)
                ? getResourceIconUrl(kind)
                : getCommodityIconUrl(isCommodity(kind) ? kind : 'coin')
            }
            alt=""
          />
          <b>{cost[kind]}</b>
        </span>
      ))}
    </span>
  );
}

/** "2 brick, 1 ore" for titles and screen readers. */
export function costText(cost: CardCounts, name: (kind: string) => string): string {
  return [...RESOURCES, 'cloth', 'coin', 'paper']
    .filter((kind) => (cost[kind] ?? 0) > 0)
    .map((kind) => `${cost[kind]} ${name(kind)}`)
    .join(', ');
}

interface ControlProps {
  availability: ActionAvailability | null;
  selectedKind: PlacementKind | undefined;
  disabled: boolean;
  color: string | undefined;
  onChoose: (kind: PlacementKind) => void;
}

function useKindLabel() {
  const { t } = useTranslation(['knights', 'game']);
  const resource = (kind: string): string =>
    isCommodity(kind) ? t(`knights:commodity.${kind}`) : t(`game:${kind}`);
  const costTitle = (kind: string): string => {
    const cost = costOfKind(kind);
    return cost ? costText(cost, resource) : t('knights:free');
  };
  return { t, costTitle };
}

/** Knight and wall buttons for the desktop build grid, beside road, settlement and city. */
export function KnightsBuildButtons({
  availability,
  selectedKind,
  disabled,
  color,
  onChoose,
}: ControlProps) {
  const { t, costTitle } = useKindLabel();
  return (
    <>
      {BUILD_ORDER.map((kind) => {
        const count = availability?.placements[kind].length ?? 0;
        // A sideways city piece only matters to a seat that has one.
        if (kind === 'sideways' && count === 0) return null;
        return (
          <button
            className={`desktop-build-button knights-build-button ${selectedKind === kind ? 'is-selected' : ''}`}
            type="button"
            key={kind}
            data-kind={kind}
            disabled={disabled || count === 0}
            aria-label={t(`knights:build.${kind}`)}
            title={`${t(`knights:build.${kind}`)} · ${costTitle(kind)}`}
            aria-pressed={selectedKind === kind}
            onClick={() => onChoose(kind)}
          >
            <img src={art(kind, color)} alt="" aria-hidden="true" />
            <Glyph kind={kind} />
          </button>
        );
      })}
    </>
  );
}

/** The same actions as rows of the phone's build sheet, each with its cost. */
export function KnightsBuildRows({
  availability,
  selectedKind,
  disabled,
  color,
  onChoose,
}: ControlProps) {
  const { t } = useKindLabel();
  return (
    <>
      {BUILD_ORDER.map((kind) => {
        const count = availability?.placements[kind].length ?? 0;
        if (kind === 'sideways' && count === 0) return null;
        const cost = costOfKind(kind);
        return (
          <button
            className={`mobile-build-row knights-build-row ${selectedKind === kind ? 'is-selected' : ''}`}
            type="button"
            key={kind}
            data-kind={kind}
            disabled={disabled || count === 0}
            aria-label={t(`knights:build.${kind}`)}
            aria-pressed={selectedKind === kind}
            onClick={() => onChoose(kind)}
          >
            <span className="mobile-build-art knights-row-art">
              <img src={art(kind, color)} alt="" aria-hidden="true" />
              <Glyph kind={kind} />
            </span>
            <span className="mobile-build-copy">
              <strong>{t(`knights:build.${kind}`)}</strong>
              <small className="build-supply-text">{t(`knights:buildHint.${kind}`)}</small>
              {cost ? <CostChips cost={cost} /> : null}
            </span>
          </button>
        );
      })}
    </>
  );
}

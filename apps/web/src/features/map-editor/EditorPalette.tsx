import { HARBOR_KINDS } from '@cp2p/maps';
import type { HarborKind, MapModule, MapTerrain } from '@cp2p/maps';
import {
  getHarborArtUrl,
  getRobberArtUrl,
  getSeafaringIconUrl,
  getTileArtUrl,
  getTokenArtUrl,
} from '@cp2p/renderer';
import { useTranslation } from 'react-i18next';
import { harborLabel, terrainLabel } from './labels';
import { TOOLS, paletteTerrains, toolAvailable } from './tools';
import type { Tool } from './tools';

interface EditorPaletteProps {
  readonly modules: readonly MapModule[];
  readonly tool: Tool;
  readonly terrain: MapTerrain;
  readonly harborKind: HarborKind;
  readonly onTool: (tool: Tool) => void;
  readonly onTerrain: (terrain: MapTerrain) => void;
  readonly onHarborKind: (kind: HarborKind) => void;
  readonly onAutoTokens: () => void;
  readonly onRandomise: () => void;
}

function ToolIcon({ tool }: { tool: Tool }) {
  const src =
    tool === 'terrain'
      ? getTileArtUrl('forest', 2)
      : tool === 'token'
        ? getTokenArtUrl(8)
        : tool === 'harbor'
          ? getHarborArtUrl('generic')
          : tool === 'robber'
            ? getRobberArtUrl()
            : tool === 'pirate'
              ? getSeafaringIconUrl('pirate')
              : tool === 'setup'
                ? getTileArtUrl('pasture', 1)
                : getTileArtUrl('sea', 1);
  return <img className={`map-tool-icon is-${tool}`} src={src} alt="" aria-hidden="true" />;
}

/** The tool strip: a column on desktop, a scrolling row under the board on phones. */
export function EditorPalette({
  modules,
  tool,
  terrain,
  harborKind,
  onTool,
  onTerrain,
  onHarborKind,
  onAutoTokens,
  onRandomise,
}: EditorPaletteProps) {
  const { t } = useTranslation(['editor', 'game', 'common', 'lobby']);
  const toolNames: Record<Tool, string> = {
    terrain: t('editor:mapToolTerrain'),
    token: t('editor:mapToolToken'),
    harbor: t('editor:mapToolHarbor'),
    erase: t('editor:mapToolErase'),
    robber: t('editor:mapToolRobber'),
    pirate: t('editor:mapToolPirate'),
    setup: t('editor:mapToolSetup'),
  };
  return (
    <div className="map-palette">
      <div className="map-tool-row" role="toolbar" aria-label={t('editor:mapTools')}>
        {TOOLS.filter((item) => toolAvailable(item.tool, modules)).map((item) => (
          <button
            key={item.tool}
            type="button"
            className="map-tool"
            aria-pressed={tool === item.tool}
            data-tool={item.tool}
            title={`${toolNames[item.tool]} (${item.key.toUpperCase()})`}
            onClick={() => onTool(item.tool)}
          >
            <ToolIcon tool={item.tool} />
            <span>{toolNames[item.tool]}</span>
            <kbd aria-hidden="true">{item.key.toUpperCase()}</kbd>
          </button>
        ))}
      </div>
      {tool === 'terrain' && (
        <div className="map-swatches" role="radiogroup" aria-label={t('editor:mapTerrains')}>
          {paletteTerrains(modules).map((item, index) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={terrain === item}
              className="map-swatch"
              data-terrain={item}
              title={`${terrainLabel(t, item)} (${index + 1})`}
              onClick={() => onTerrain(item)}
            >
              <img src={getTileArtUrl(item, 1)} alt="" aria-hidden="true" />
              <span>{terrainLabel(t, item)}</span>
            </button>
          ))}
        </div>
      )}
      {tool === 'harbor' && (
        <div className="map-swatches" role="radiogroup" aria-label={t('editor:mapHarborKinds')}>
          {HARBOR_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={harborKind === kind}
              className="map-swatch is-harbor"
              data-harbor={kind}
              onClick={() => onHarborKind(kind)}
            >
              <img src={getHarborArtUrl(kind)} alt="" aria-hidden="true" />
              <span>{harborLabel(t, kind)}</span>
            </button>
          ))}
        </div>
      )}
      <p className="map-tool-hint muted" role="status">
        {tool === 'terrain'
          ? t('editor:mapHintTerrain')
          : tool === 'token'
            ? t('editor:mapHintToken')
            : tool === 'harbor'
              ? t('editor:mapHintHarbor')
              : tool === 'erase'
                ? t('editor:mapHintErase')
                : tool === 'robber'
                  ? t('editor:mapHintRobber')
                  : tool === 'pirate'
                    ? t('editor:mapHintPirate')
                    : t('editor:mapHintSetup')}
      </p>
      <div className="map-palette-actions">
        <button type="button" className="button button-quiet" onClick={onAutoTokens}>
          {t('editor:mapAutoTokens')}
        </button>
        <button type="button" className="button button-quiet" onClick={onRandomise}>
          {t('editor:mapRandomise')}
        </button>
      </div>
    </div>
  );
}

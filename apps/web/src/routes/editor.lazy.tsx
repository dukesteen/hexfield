import { createLazyFileRoute } from '@tanstack/react-router';
import { decodeMap, mapFromScenario, scenarioById } from '@cp2p/maps';
import type { MapDef } from '@cp2p/maps';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapEditor } from '../features/map-editor/MapEditor';

export const Route = createLazyFileRoute('/editor')({ component: EditorPage });

type Opening = { readonly map: MapDef; readonly error?: string } | null;

function classicMap(name: string): MapDef {
  const scenario = scenarioById('standard-fixed');
  const map = scenario && mapFromScenario(scenario, name);
  if (!map) throw new Error('The classic island is missing');
  return map;
}

function EditorPage() {
  const { t } = useTranslation(['editor', 'lobby']);
  const { map: shared } = Route.useSearch();
  const [opening, setOpening] = useState<Opening>(null);
  useEffect(() => {
    let live = true;
    const classic = classicMap(t('editor:mapClassicName'));
    if (!shared) {
      setOpening({ map: classic });
      return undefined;
    }
    void decodeMap(shared).then((result) => {
      if (live)
        setOpening(
          result.ok ? { map: result.value } : { map: classic, error: t('editor:mapLinkInvalid') },
        );
      return undefined;
    });
    return () => {
      live = false;
    };
  }, [shared, t]);
  if (!opening)
    return (
      <main className="app-page map-editor-page">
        <p role="status">{t('editor:mapLoading')}</p>
      </main>
    );
  return (
    <MapEditor
      key={shared ?? 'new'}
      initial={opening.map}
      {...(opening.error ? { loadError: opening.error } : {})}
    />
  );
}

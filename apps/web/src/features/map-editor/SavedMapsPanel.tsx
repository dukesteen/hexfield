import { useTranslation } from 'react-i18next';
import { useDeleteMap, useSavedMaps } from '../../queries/maps';
import type { SavedMap } from '../../queries/maps';

/** The maps saved on this device. */
export function SavedMapsPanel({
  currentId,
  onOpen,
}: {
  currentId: string | null;
  onOpen: (saved: SavedMap) => void;
}) {
  const { t } = useTranslation(['editor', 'game', 'common', 'lobby']);
  const maps = useSavedMaps();
  const remove = useDeleteMap();
  return (
    <section className="map-saved" aria-labelledby="map-saved-title">
      <h2 id="map-saved-title">{t('editor:mapSavedTitle')}</h2>
      {maps.isError && <p role="alert">{t('editor:mapSavedError')}</p>}
      {maps.data?.length === 0 && <p className="muted">{t('editor:mapSavedEmpty')}</p>}
      <ul className="map-saved-list">
        {maps.data?.map((saved) => (
          <li key={saved.id} aria-current={saved.id === currentId ? 'true' : undefined}>
            <button type="button" className="map-saved-open" onClick={() => onOpen(saved)}>
              <strong>{saved.name}</strong>
              <small className="muted">
                {t('editor:mapSavedMeta', {
                  hexes: saved.map.hexes.filter((hex) => hex.terrain !== 'sea').length,
                  min: saved.map.seats.min,
                  max: saved.map.seats.max,
                  date: new Date(saved.updatedAt).toLocaleDateString(),
                })}
              </small>
            </button>
            <button
              type="button"
              className="text-link map-saved-delete"
              aria-label={t('editor:mapDeleteNamed', { name: saved.name })}
              onClick={() => {
                if (window.confirm(t('editor:mapDeleteConfirm', { name: saved.name })))
                  remove.mutate(saved.id);
              }}
            >
              {t('editor:mapDelete')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mapJson, parseMapDef } from '@cp2p/maps';
import type { MapDef } from '@cp2p/maps';
import { IndexedDbMapStore } from '@cp2p/storage';
import type { SavedMapRecord } from '@cp2p/storage';
import { queryKeys } from './keys';

/** A saved map as the app uses it: the record's JSON parsed and checked against the schema. */
export interface SavedMap {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly map: MapDef;
}

/** Where saved maps live. Tests pass an in-memory one. */
export interface MapRepository {
  list(): Promise<SavedMapRecord[]>;
  put(record: SavedMapRecord): Promise<SavedMapRecord>;
  delete(id: string): Promise<void>;
}

let browserMaps: MapRepository | undefined;

export function getMapRepository(): MapRepository {
  browserMaps ??= new IndexedDbMapStore();
  return browserMaps;
}

function toSavedMap(record: SavedMapRecord): SavedMap | null {
  let value: unknown;
  try {
    value = JSON.parse(record.json);
  } catch {
    return null;
  }
  const parsed = parseMapDef(value);
  return parsed.ok
    ? { id: record.id, name: record.name, updatedAt: record.updatedAt, map: parsed.value }
    : null;
}

/** Saved maps, newest first. Records that no longer parse as a map are left out. */
export function useSavedMaps(repository: MapRepository = getMapRepository()) {
  return useQuery({
    queryKey: queryKeys.maps(),
    queryFn: async () =>
      (await repository.list()).flatMap((record) => {
        const map = toSavedMap(record);
        return map ? [map] : [];
      }),
  });
}

/** A fresh id for a new saved map. */
export function newMapId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** Save (or overwrite by id) a map under its own name. */
export function useSaveMap(repository: MapRepository = getMapRepository()) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, map }: { id: string; map: MapDef }): Promise<SavedMap> => {
      const record = await repository.put({
        v: 1,
        id,
        name: map.name,
        updatedAt: Date.now(),
        json: mapJson(map),
      });
      return { id: record.id, name: record.name, updatedAt: record.updatedAt, map };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.maps() }),
  });
}

export function useDeleteMap(repository: MapRepository = getMapRepository()) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => repository.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.maps() }),
  });
}

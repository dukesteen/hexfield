import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';

/** `#/editor?map=HXMAP1.…` opens a shared map. The string itself is checked by the map codec. */
export const editorSearchSchema = v.object({
  map: v.optional(v.pipe(v.string(), v.maxLength(32 * 1024))),
});

export const Route = createFileRoute('/editor')({ validateSearch: editorSearchSchema });

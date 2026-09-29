import { afterEach, expect, it, vi } from 'vitest';

// oxlint-disable-next-line typescript/no-extraneous-class -- Node only needs a base for the imported, uninstantiated Durable Object.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import worker from './worker.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['GET', 'POST', 'OPTIONS'])(
  'never issues billable TURN credentials for %s',
  async (method) => {
    const outbound = vi.fn<typeof fetch>(() => {
      throw new Error('Free-only deployment must not contact the TURN provider');
    });
    vi.stubGlobal('fetch', outbound);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately absent bindings prove this route cannot use a secret or service.
    const absentBindings = undefined as unknown as Cloudflare.Env;
    const response = await worker.fetch(
      new Request('https://playhexfield.com/api/turn', { method }),
      absentBindings,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Relay disabled: free-only hosting' });
    expect(outbound).not.toHaveBeenCalled();
  },
);

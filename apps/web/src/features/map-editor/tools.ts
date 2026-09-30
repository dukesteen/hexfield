import type { MapModule, MapTerrain } from '@cp2p/maps';

export type Tool = 'terrain' | 'token' | 'harbor' | 'erase' | 'robber' | 'pirate' | 'setup';

/** Tools and their keyboard shortcut; pirate and setup areas need seafaring. */
export const TOOLS: readonly {
  readonly tool: Tool;
  readonly key: string;
  readonly seafaring?: true;
}[] = [
  { tool: 'terrain', key: 'b' },
  { tool: 'token', key: 'n' },
  { tool: 'harbor', key: 'h' },
  { tool: 'erase', key: 'e' },
  { tool: 'robber', key: 'r' },
  { tool: 'pirate', key: 'p', seafaring: true },
  { tool: 'setup', key: 's', seafaring: true },
];

/** The terrains the enabled modules allow, in palette order (keys 1–9 pick them). */
export function paletteTerrains(modules: readonly MapModule[]): MapTerrain[] {
  return [
    'forest',
    'hills',
    'pasture',
    'fields',
    'mountains',
    'desert',
    'sea',
    ...(modules.includes('seafaring') ? (['gold', 'fog'] as const) : []),
  ];
}

export function toolAvailable(tool: Tool, modules: readonly MapModule[]): boolean {
  return !TOOLS.find((item) => item.tool === tool)?.seafaring || modules.includes('seafaring');
}

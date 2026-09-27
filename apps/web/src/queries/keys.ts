/** Stable keys for persisted or asynchronous data. Live game state never enters this cache. */
export const queryKeys = {
  settings: () => ['settings'] as const,
  savedGames: () => ['savedGames'] as const,
  savedGame: (id: string) => ['savedGames', id] as const,
  onlineGames: () => ['onlineGames'] as const,
  turnCredentials: (endpoint: string) => ['turnCredentials', endpoint] as const,
  replay: (id: string) => ['replays', id] as const,
  map: (id: string) => ['maps', id] as const,
};

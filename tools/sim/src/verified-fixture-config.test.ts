import { genesisDeckDefinitions } from '@cp2p/protocol';
import { createVerifiedNetworkFixture } from '@cp2p/protocol/testing';
import { SCENARIOS, scenarioConfig } from '@cp2p/maps';
import { expect, test } from 'vitest';

test('the verified network fixture takes a scenario config and commits its fog decks', () => {
  const scenario = SCENARIOS.find((item) => item.id === 'fogbound');
  if (!scenario) throw new Error('Missing fogbound');
  const config = scenarioConfig(scenario, 4);
  const fixture = createVerifiedNetworkFixture({ seed: 7, config });
  try {
    expect(fixture.genesis.security).toBe('verified');
    expect(fixture.genesis.config.modules.map((module) => module.id)).toEqual([
      'base',
      'seafaring',
    ]);
    expect(fixture.genesis.config.board?.hexes.some((hex) => hex.terrain === 'fog')).toBe(true);
    const decks = genesisDeckDefinitions(fixture.genesis);
    if (!decks.ok) throw new Error(decks.error.message);
    expect(decks.value.map((deck) => deck.deckId)).toEqual(
      expect.arrayContaining(['fog-terrain', 'fog-token']),
    );
    expect(fixture.mastersForAudit()).toHaveLength(4);
  } finally {
    fixture.dispose();
  }
}, 120_000);

test('a seafaring with knights scenario starts a verified game with the progress decks', () => {
  const scenario = SCENARIOS.find((item) => item.id === 'new-horizons-knights');
  if (!scenario) throw new Error('Missing new-horizons-knights');
  const fixture = createVerifiedNetworkFixture({ seed: 7, config: scenarioConfig(scenario, 4) });
  try {
    expect(fixture.genesis.security).toBe('verified');
    expect(fixture.genesis.config.modules.map((module) => module.id)).toEqual([
      'base',
      'seafaring',
      'knights',
      'scenario:seafarers-knights',
    ]);
    const decks = genesisDeckDefinitions(fixture.genesis);
    if (!decks.ok) throw new Error(decks.error.message);
    const ids = decks.value.map((deck) => deck.deckId);
    expect(ids.filter((id) => id.startsWith('progress')).length).toBe(3);
    // No combined scenario has fog (C&K rule 12), so no fog stack is committed.
    expect(ids.some((id) => id.startsWith('fog-'))).toBe(false);
    expect(fixture.mastersForAudit()).toHaveLength(4);
  } finally {
    fixture.dispose();
  }
}, 120_000);

import { SCENARIOS, scenarioIsPlayable, type Scenario } from '@cp2p/maps';
import {
  getIslandChitUrl,
  getKnightIconUrl,
  getMetropolisIconUrl,
  getPieceIconUrl,
  getSeafaringIconUrl,
  getShipIconUrl,
} from '@cp2p/renderer';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

type ModeId = 'classic' | 'five-six' | 'seafaring' | 'knights';

/** Each home card groups the playable scenarios that share its modules. */
const MODE_SCENARIOS: Record<ModeId, (scenario: Scenario) => boolean> = {
  classic: (s) => s.modules.length === 1,
  'five-six': (s) => s.modules.length === 2 && s.modules.includes('five-six'),
  seafaring: (s) => s.modules.includes('seafaring'),
  knights: (s) => s.modules.includes('knights'),
};

const SEATS_COLORS = ['red', 'blue', 'orange', 'green', 'white', 'black'] as const;

function scenariosFor(mode: ModeId): Scenario[] {
  return SCENARIOS.filter(
    (scenario) => scenarioIsPlayable(scenario) && MODE_SCENARIOS[mode](scenario),
  );
}

function seatRange(scenarios: readonly Scenario[]) {
  return {
    min: Math.min(...scenarios.map((s) => s.seats.min)),
    max: Math.max(...scenarios.map((s) => s.seats.max)),
  };
}

/** Pieces standing on each card, drawn from the game art. */
const MODE_ART: Record<ModeId, () => ReactNode> = {
  classic: () => (
    <>
      <img className="home-mode-piece is-road" src={getPieceIconUrl('road', 'orange')} alt="" />
      <img className="home-mode-piece" src={getPieceIconUrl('settlement', 'red')} alt="" />
      <img className="home-mode-piece is-large" src={getPieceIconUrl('city', 'blue')} alt="" />
    </>
  ),
  'five-six': () => (
    <span className="home-mode-crowd">
      {SEATS_COLORS.map((color) => (
        <img
          key={color}
          className="home-mode-piece"
          src={getPieceIconUrl('settlement', color)}
          alt=""
        />
      ))}
    </span>
  ),
  seafaring: () => (
    <>
      <img className="home-mode-piece" src={getSeafaringIconUrl('gold')} alt="" />
      <img className="home-mode-piece is-large" src={getShipIconUrl('blue', 3)} alt="" />
      <img className="home-mode-piece" src={getIslandChitUrl(2)} alt="" />
    </>
  ),
  knights: () => (
    <>
      <img className="home-mode-piece is-knight" src={getKnightIconUrl('orange', 2)} alt="" />
      <img
        className="home-mode-piece is-large"
        src={getMetropolisIconUrl('science', 'green')}
        alt=""
      />
      <img className="home-mode-piece is-knight" src={getKnightIconUrl('red', 3)} alt="" />
    </>
  ),
};

/** A short tour of what the lobby offers: the scenario groups and their expansion modules. */
export function HomeModes() {
  const { t } = useTranslation('lobby');
  const classic = scenariosFor('classic');
  const fiveSix = scenariosFor('five-six');
  const seafaring = scenariosFor('seafaring');
  const knights = scenariosFor('knights');
  const cards: {
    id: ModeId;
    title: string;
    about: string;
    scenarios: readonly Scenario[];
    names?: readonly string[];
  }[] = [
    {
      id: 'classic',
      title: t('lobby:scenarioGroupClassic'),
      about: t('lobby:scenarioStandardAbout'),
      scenarios: classic,
    },
    {
      id: 'five-six',
      title: t('lobby:expansion_five-six'),
      about: t('lobby:scenarioFiveSixAbout'),
      scenarios: fiveSix,
    },
    {
      id: 'seafaring',
      title: t('lobby:scenarioGroupSeafaring'),
      about: t('lobby:homeModeSeafaringAbout'),
      scenarios: seafaring,
      // The 5–6 player versions share a name with their base scenario; list each map once.
      names: seafaring
        .filter((scenario) => !scenario.modules.includes('five-six'))
        .map((scenario) => t(`lobby:${scenario.titleKey}`)),
    },
    {
      id: 'knights',
      title: t('lobby:scenarioKnights'),
      about: t('lobby:scenarioKnightsAbout'),
      scenarios: knights,
    },
  ];
  return (
    <section className="home-modes" aria-labelledby="home-modes-title">
      <div className="home-section-heading">
        <h2 id="home-modes-title">{t('lobby:homeModesTitle')}</h2>
        <p className="muted">{t('lobby:homeModesIntro')}</p>
      </div>
      <ul className="home-mode-list">
        {cards
          .filter((card) => card.scenarios.length > 0)
          .map((card) => {
            const seats = seatRange(card.scenarios);
            return (
              <li key={card.id} className="home-mode" data-mode={card.id}>
                <div className="home-mode-art" aria-hidden="true">
                  {MODE_ART[card.id]()}
                </div>
                <div className="home-mode-body">
                  <p className="home-eyebrow">
                    {t('lobby:homeModeSeats', { min: seats.min, max: seats.max })}
                  </p>
                  <h3>{card.title}</h3>
                  <p className="home-mode-about">{card.about}</p>
                  {card.names && (
                    <ul className="home-mode-scenarios" aria-label={t('lobby:homeModeScenarios')}>
                      {card.names.map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
      </ul>
      <p className="home-modes-coming">{t('lobby:homeModesComing')}</p>
    </section>
  );
}

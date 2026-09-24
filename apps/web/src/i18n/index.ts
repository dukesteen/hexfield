import { createInstance, type i18n as I18n } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';

const i18n: I18n = createInstance();

void i18n
  .use(
    resourcesToBackend(
      (language: string, namespace: string) => import(`./locales/${language}/${namespace}.json`),
    ),
  )
  .use(initReactI18next)
  .init({
    lng: 'en',
    fallbackLng: 'en',
    supportedLngs: ['en'],
    ns: ['common', 'game', 'lobby', 'rules', 'log', 'editor'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
  });

export { i18n };

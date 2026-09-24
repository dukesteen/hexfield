import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import commonEn from './locales/en/common.json';

const i18n: I18n = createInstance();

void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  resources: { en: { common: commonEn } },
  interpolation: { escapeValue: false },
});

export { i18n };

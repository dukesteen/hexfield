import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { i18n } from './i18n';
import { queryClient } from './queryClient';
import { router } from './router';
import { canonicalUrl } from './canonical-host';
import './style.css';
import './app.css';
import './features/game/game-theme.css';
import './redesign.css';
import './features/game/mobile-theme.css';

// www.<domain> serves the same files; move to the bare domain so there is one app origin.
const canonical = canonicalUrl(window.location);
if (canonical) window.location.replace(canonical);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
);

import { defineConfig } from '@playwright/test';

/**
 * Captures d'écran de revue (direction visuelle) sur l'API simulée, viewport mobile 390 px.
 * CAPTURE_DIR : dossier de sortie (ex. ../docs/design-kit/captures/apres) ; CAPTURE_PORT : port du serveur.
 */
const PORT = Number(process.env.CAPTURE_PORT ?? 5174);
export default defineConfig({
  testDir: './e2e/captures',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  webServer: { command: `npm run dev:mock -- --port ${PORT}`, url: `http://localhost:${PORT}`, reuseExistingServer: false, timeout: 60_000 },
});

import { defineConfig, devices } from '@playwright/test';

/** Smoke tests contre l'API simulée (MSW) — aucun back requis. E2E_PORT : port du serveur (5173 par défaut). */
const PORT = Number(process.env.E2E_PORT ?? 5173);
export default defineConfig({
  testDir: './e2e/mock',
  testMatch: '**/*.mock.spec.ts',
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, locale: 'fr-FR', timezoneId: 'Europe/Paris', trace: 'retain-on-failure' },
  projects: [{ name: 'mobile', use: { ...devices['Pixel 7'] } }],
  webServer: { command: `npm run dev:mock -- --port ${PORT}`, url: `http://localhost:${PORT}`, reuseExistingServer: false, timeout: 60_000 },
});

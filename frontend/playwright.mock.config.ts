import { defineConfig, devices } from '@playwright/test';

/** Smoke tests contre l'API simulée (MSW) — aucun back requis. */
export default defineConfig({
  testDir: './e2e/mock',
  testMatch: '**/*.mock.spec.ts',
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', locale: 'fr-FR', timezoneId: 'Europe/Paris', trace: 'retain-on-failure' },
  projects: [{ name: 'mobile', use: { ...devices['Pixel 7'] } }],
  webServer: { command: 'npm run dev:mock', url: 'http://localhost:5173', reuseExistingServer: false, timeout: 60_000 },
});

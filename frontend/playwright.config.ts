import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Secrets de test (mot de passe des comptes du seed) : fichier ../.env.e2e, gitignoré, jamais recopié.
const E2E_ENV = new URL('../.env.e2e', import.meta.url);
if (existsSync(E2E_ENV)) process.loadEnvFile(E2E_ENV);

/** E2E mobile contre le back réel (jalon F5). Le back doit tourner sur :4000 (voir README). */
export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/mock/**',
  // Les specs « real » ne passent pas les tests en parallèle sur les mêmes comptes.
  workers: 1,
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  },
  projects: [{ name: 'mobile', use: { ...devices['Pixel 7'] } }],
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
});

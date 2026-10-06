import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const E2E_ENV = new URL('../.env.e2e', import.meta.url);
if (existsSync(E2E_ENV)) process.loadEnvFile(E2E_ENV);

/**
 * PWA sur le BUILD DE PRODUCTION (service worker réel, CSP stricte) servi par `vite preview` sur le
 * port 5173 (origine autorisée par le back). Le back réel doit tourner (voir README).
 * VITE_PSP_ORIGIN factice en https : ce test ne passe pas par le paiement.
 */
export default defineConfig({
  testDir: './e2e/pwa',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', locale: 'fr-FR', timezoneId: 'Europe/Paris', serviceWorkers: 'allow', trace: 'retain-on-failure' },
  projects: [{ name: 'mobile', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'VITE_PSP_ORIGIN=https://psp.invalid npm run build && npx vite preview --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});

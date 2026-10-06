/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { securityHeaders } from './security-headers';

/**
 * Sert le service worker de MSW UNIQUEMENT en serveur de dev (`apply: 'serve'`) : il n'est jamais
 * copié dans `dist/`, donc aucune infrastructure de mock n'existe en production.
 */
function mswWorkerDevOnly(): Plugin {
  const workerPath = fileURLToPath(import.meta.resolve('msw/mockServiceWorker.js'));
  return {
    name: 'msw-worker-dev-only',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/mockServiceWorker.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(readFileSync(workerPath));
      });
    },
  };
}

export default defineConfig(({ mode, command }) => {
  // Le mode mock (API simulée par MSW) n'a aucun sens en production : on refuse de le construire.
  if (mode === 'mock' && command === 'build') {
    throw new Error('Build refusé : le mode « mock » est réservé au serveur de développement.');
  }
  return {
  plugins: [
    react(),
    mode === 'mock' ? mswWorkerDevOnly() : null,
    VitePWA({
      registerType: 'prompt',
      // Enregistrement fait par <PwaUpdatePrompt /> (virtual:pwa-register/react), en production uniquement.
      injectRegister: false,
      // Le service worker n'est utile qu'en build : en mode mock, MSW occupe déjà le scope.
      devOptions: { enabled: false },
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Les Nuits de la Garonne',
        short_name: 'Nuits',
        description: 'Billetterie et contrôle d’accès des Nuits de la Garonne',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#14121f',
        theme_color: '#14121f',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Coquille applicative en cache uniquement : AUCUNE réponse d'API n'est mise en cache
        // par le service worker (données personnelles, tokens). Le hors-ligne métier passe par IndexedDB.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    headers: securityHeaders(true),
    port: 5173,
    strictPort: true,
    proxy: mode === 'mock' ? undefined : { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
  preview: { port: 4173, strictPort: true, headers: securityHeaders(false) },
  build: { sourcemap: false, target: 'es2022' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'vite.config.test.ts', 'eslint.security.test.ts'],
    restoreMocks: true,
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
  };
});

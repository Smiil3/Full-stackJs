import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/globalSetup.ts'],
    setupFiles: ['tests/setup/env.ts', 'tests/setup/db.ts'],
    // Une seule base de test partagée : les fichiers s'exécutent l'un après l'autre.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Absente lors d'un simple `prisma generate` (CI, postinstall) : seules les commandes de migration en ont besoin.
    url: process.env['DATABASE_URL'] ?? '',
  },
});

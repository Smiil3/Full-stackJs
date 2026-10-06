import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';

/** Applique les migrations sur la base de test (TEST_DATABASE_URL, jamais la base de dev). */
export default function setup(): void {
  config({ quiet: true });
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL manquant (voir .env.example)');
  if (url === process.env['DATABASE_URL']) throw new Error('TEST_DATABASE_URL doit différer de DATABASE_URL');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

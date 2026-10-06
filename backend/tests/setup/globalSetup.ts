import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';
import { assertTestDatabaseUrl } from './guard.js';

/** Applique les migrations sur la base de test (TEST_DATABASE_URL, jamais la base de dev). */
export default function setup(): void {
  config({ quiet: true });
  const url = assertTestDatabaseUrl(process.env['TEST_DATABASE_URL'], process.env['DATABASE_URL']);
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/** CLI du seed (`npm run db:seed`) : la logique est dans seedData.ts (testée). */
import 'dotenv/config';
import { disconnectDb } from '../src/lib/db.js';
import { runSeed } from './seedData.js';

runSeed()
  .catch((err: unknown) => {
    process.stderr.write(`Échec du seed : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());

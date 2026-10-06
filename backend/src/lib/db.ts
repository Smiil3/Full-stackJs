import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { getEnv } from '../config/env.js';
import { DB_POOL_MAX, TX_MAX_WAIT_MS, TX_TIMEOUT_MS } from '../config/database.js';

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

let client: PrismaClient | null = null;

export function getDb(): PrismaClient {
  if (!client) {
    const adapter = new PrismaPg({ connectionString: getEnv().databaseUrl, max: DB_POOL_MAX });
    client = new PrismaClient({ adapter });
  }
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

/** Transaction interactive avec des délais adaptés aux pics de concurrence (ouverture de billetterie). */
export function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().$transaction(fn, { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS });
}

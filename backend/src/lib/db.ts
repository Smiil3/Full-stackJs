import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { getEnv } from '../config/env.js';

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

let client: PrismaClient | null = null;

export function getDb(): PrismaClient {
  if (!client) {
    const adapter = new PrismaPg({ connectionString: getEnv().databaseUrl, max: 20 });
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
  return getDb().$transaction(fn, { maxWait: 10_000, timeout: 20_000 });
}

import { describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { hashPassword, verifyPasswordHash } from '../../src/lib/password.js';
import { Semaphore } from '../../src/lib/semaphore.js';
import { AppError } from '../../src/lib/errors.js';

describe('argon2 (B2.1 M9)', () => {
  it('paramètres épinglés OWASP : argon2id, m=19456, t=2, p=1', async () => {
    const hash = await hashPassword('un-mot-de-passe-solide');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await verifyPasswordHash(hash, 'un-mot-de-passe-solide')).toBe(true);
    expect(await verifyPasswordHash(hash, 'autre')).toBe(false);
    expect(await verifyPasswordHash('pas-un-hash', 'x')).toBe(false);
  });
});

describe('sémaphore', () => {
  it('au plus N tâches simultanées', async () => {
    const sem = new Semaphore(4, 100);
    let running = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 20 }, () => sem.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(5);
      running -= 1;
    })));
    expect(peak).toBe(4);
    expect(sem.stats).toEqual({ active: 0, queued: 0 });
  });

  it('file pleine ⇒ 429 immédiat', async () => {
    const sem = new Semaphore(1, 2);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => sem.run(() => sleep(10))));
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(2);
    expect(rejected[0]!.reason).toBeInstanceOf(AppError);
    expect((rejected[0]!.reason as AppError).status).toBe(429);
  });

  it('une tâche en erreur libère sa place', async () => {
    const sem = new Semaphore(1, 0);
    await expect(sem.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(sem.run(() => Promise.resolve(42))).resolves.toBe(42);
  });
});

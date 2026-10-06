import { describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { decryptOutboxPayload, OUTBOX_MAX_ATTEMPTS, processOutboxBatch, type MailMessage } from '../../src/lib/outbox.js';
import { api, PASSWORD, tokenFromMail } from '../helpers.js';

function fakeTransport(fail = false) {
  const sent: MailMessage[] = [];
  return {
    sent,
    sendMail(message: MailMessage) {
      if (fail) return Promise.reject(new Error('SMTP indisponible'));
      sent.push(message);
      return Promise.resolve({});
    },
  };
}

describe('outbox mail (B2.1 M7)', () => {
  it('aucun jeton ni lien utilisable en clair dans la table', async () => {
    await api().post('/api/v1/auth/register').send({ email: 'clair@test.fr', password: PASSWORD, displayName: 'C' }).expect(202);
    const token = await tokenFromMail('clair@test.fr', 'verifyEmail');
    const rows = await getDb().$queryRaw<{ payload: unknown }[]>`SELECT "payload" FROM "email_outbox"`;
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('verify-email');
    expect(raw).not.toContain('token=');
  });

  it('un payload recopié sur une autre ligne ne se déchiffre pas', async () => {
    await api().post('/api/v1/auth/register').send({ email: 'a1@test.fr', password: PASSWORD, displayName: 'A' }).expect(202);
    await api().post('/api/v1/auth/register').send({ email: 'a2@test.fr', password: PASSWORD, displayName: 'B' }).expect(202);
    const [m1, m2] = await getDb().emailOutbox.findMany({ orderBy: { createdAt: 'asc' } });
    expect(() => decryptOutboxPayload({ id: m2!.id, payload: m1!.payload })).toThrow();
  });

  it('envoi : contenu rendu, puis payload purgé (état SENT)', async () => {
    await api().post('/api/v1/auth/register').send({ email: 'send@test.fr', password: PASSWORD, displayName: '<b>Zoé</b>' }).expect(202);
    const transport = fakeTransport();
    expect(await processOutboxBatch(transport)).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent[0]!.to).toBe('send@test.fr');
    expect(transport.sent[0]!.html).toContain('/verify-email?token=');
    // Données utilisateur échappées dans le HTML.
    expect(transport.sent[0]!.html).toContain('&lt;b&gt;Zoé&lt;/b&gt;');
    const row = await getDb().emailOutbox.findFirstOrThrow();
    expect(row.status).toBe('SENT');
    expect(row.payload).toEqual({});
    expect(await processOutboxBatch(transport)).toEqual({ sent: 0, failed: 0 });
  });

  it('échec : retry exponentiel puis FAILED avec payload purgé', async () => {
    await api().post('/api/v1/auth/register').send({ email: 'fail@test.fr', password: PASSWORD, displayName: 'F' }).expect(202);
    const transport = fakeTransport(true);
    await processOutboxBatch(transport);
    let row = await getDb().emailOutbox.findFirstOrThrow();
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await getDb().emailOutbox.update({ where: { id: row.id }, data: { attempts: OUTBOX_MAX_ATTEMPTS - 1, nextAttemptAt: new Date() } });
    await processOutboxBatch(transport);
    row = await getDb().emailOutbox.findFirstOrThrow();
    expect(row.status).toBe('FAILED');
    expect(row.payload).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/db.js';
import { decryptOutboxPayload, messageIdFor, OUTBOX_MAX_ATTEMPTS, processOutboxBatch, type MailMessage } from '../../src/lib/outbox.js';
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
    await getDb().emailOutbox.update({ where: { id: row.id }, data: { attempts: OUTBOX_MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 60_000) } });
    await processOutboxBatch(transport);
    row = await getDb().emailOutbox.findFirstOrThrow();
    expect(row.status).toBe('FAILED');
    expect(row.payload).toEqual({});
  });
});

describe('outbox : envoi hors transaction (B9 H3)', () => {
  it('SMTP lent et deux workers en parallèle : chaque mail envoyé une seule fois, Message-ID stable', async () => {
    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/v1/auth/register').send({ email: `lent${i}@test.fr`, password: PASSWORD, displayName: 'L' }).expect(202);
    }
    const sent: MailMessage[] = [];
    const slow = { sendMail: async (m: MailMessage) => { await new Promise((r) => setTimeout(r, 150)); sent.push(m); } };
    const [a, b] = await Promise.all([processOutboxBatch(slow), processOutboxBatch(slow)]);
    expect(a.sent + b.sent).toBe(5);
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((m) => m.to)).size).toBe(5);
    const rows = await getDb().emailOutbox.findMany();
    for (const m of sent) expect(rows.map((r) => messageIdFor(r.id))).toContain(m.messageId);
  });

  it('timeout SMTP : pas de renvoi pendant le bail ; renvoi ultérieur avec le MÊME Message-ID', async () => {
    await api().post('/api/v1/auth/register').send({ email: 'timeout@test.fr', password: PASSWORD, displayName: 'T' }).expect(202);
    const ids: string[] = [];
    const failing = { sendMail: (m: MailMessage) => { ids.push(m.messageId ?? ''); return Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); } };
    await processOutboxBatch(failing);
    await processOutboxBatch(failing); // backoff : rien n'est repris immédiatement
    expect(ids).toHaveLength(1);
    await getDb().emailOutbox.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const ok: MailMessage[] = [];
    await processOutboxBatch({ sendMail: (m: MailMessage) => { ok.push(m); return Promise.resolve(); } });
    expect(ok[0]!.messageId).toBe(ids[0]);
  });
});

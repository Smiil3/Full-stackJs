import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSmtpTransport } from '../../src/lib/mailer.js';
import { processOutboxBatch } from '../../src/lib/outbox.js';
import { api, PASSWORD } from '../helpers.js';

const MAILPIT_API = 'http://127.0.0.1:8025/api/v1';

async function mailpitAvailable(): Promise<boolean> {
  try {
    return (await fetch(`${MAILPIT_API}/info`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

describe('intégration Mailpit (optionnelle)', () => {
  it('le mail de vérification part réellement en SMTP, HTML échappé', async (ctx) => {
    if (!(await mailpitAvailable())) ctx.skip();
    const email = `mailpit-${randomUUID()}@test.fr`;
    await api().post('/api/v1/auth/register').send({ email, password: PASSWORD, displayName: '<i>Zoé</i>' }).expect(202);
    const result = await processOutboxBatch(createSmtpTransport());
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const search = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(`to:${email}`)}`);
    const found = (await search.json()) as { messages: { ID: string; Subject: string }[] };
    expect(found.messages).toHaveLength(1);
    expect(found.messages[0]!.Subject).toBe('Confirmez votre adresse email');
    const message = (await (await fetch(`${MAILPIT_API}/message/${found.messages[0]!.ID}`)).json()) as { HTML: string };
    expect(message.HTML).toContain('/verify-email?token=');
    expect(message.HTML).toContain('&lt;i&gt;Zoé&lt;/i&gt;');
    expect(message.HTML).not.toContain('<i>Zoé</i>');
  });
});

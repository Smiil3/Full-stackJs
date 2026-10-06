import type { Tx } from './db.js';
import type { MailTemplate, TemplatePayloads } from './mail/templates.js';

/**
 * Ajoute un mail à l'outbox DANS la transaction de l'événement métier : si la transaction échoue,
 * aucun mail ne part ; si elle réussit, le worker l'enverra (retry exponentiel).
 */
export async function enqueueEmail<T extends MailTemplate>(tx: Tx, to: string, template: T, payload: TemplatePayloads[T]): Promise<void> {
  await tx.emailOutbox.create({ data: { to, template, payload: payload } });
}

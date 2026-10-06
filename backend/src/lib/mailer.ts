import nodemailer from 'nodemailer';
import { getEnv } from '../config/env.js';
import type { MailTransport } from './outbox.js';

/** Transport SMTP (Mailpit en développement). */
export function createSmtpTransport(): MailTransport {
  const { smtp } = getEnv();
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: smtp.requireTls,
    ...(smtp.user && smtp.password ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

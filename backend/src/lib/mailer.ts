import nodemailer from 'nodemailer';
import { getEnv } from '../config/env.js';
import type { MailTransport } from './outbox.js';
import { SMTP_CONNECTION_TIMEOUT_MS, SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS } from '../config/mail.js';

/** Transport SMTP (Mailpit en développement). */
export function createSmtpTransport(): MailTransport {
  const { smtp } = getEnv();
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: smtp.requireTls,
    ...(smtp.user && smtp.password ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  });
}

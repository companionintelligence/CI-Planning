import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Outbound email adapter (V — password reset). One entry point, `sendMail`.
 *
 * Two transports, chosen by config:
 *   - SMTP (nodemailer) when `SMTP_HOST` is set — the real path.
 *   - console/JSON otherwise — LOGS the message instead of sending. Keeps dev, CI, and
 *     an offline appliance fully functional without an SMTP server (mirrors
 *     GOOGLE_MODE=fixture / AUTH_MODE=test). nodemailer is imported LAZILY so this path
 *     never loads it — the module is only pulled in when SMTP is actually configured.
 */

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendMailResult {
  transport: 'smtp' | 'console';
  messageId?: string;
}

// Test seam: the last message handed to the console transport. Lets a test assert on
// (or extract a reset link from) an email without a live SMTP server. Only populated on
// the console path; SMTP sends leave it untouched.
let lastConsoleMail: MailMessage | null = null;
export function __getLastConsoleMail(): MailMessage | null {
  return lastConsoleMail;
}
export function __resetLastConsoleMail(): void {
  lastConsoleMail = null;
}

export async function sendMail(msg: MailMessage): Promise<SendMailResult> {
  if (!config.mail.host) {
    lastConsoleMail = msg;
    // Log the full text body so a local operator can copy a reset link from the console.
    logger.info('[mail:console] SMTP not configured — logging email instead of sending', {
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    });
    return { transport: 'console' };
  }

  // Lazy: only require nodemailer when we actually have SMTP to talk to.
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
  const info = await transporter.sendMail({
    from: config.mail.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  logger.info('[mail:smtp] sent', { to: msg.to, subject: msg.subject, messageId: info.messageId });
  return { transport: 'smtp', messageId: info.messageId };
}

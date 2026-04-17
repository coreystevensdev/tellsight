import { Resend } from 'resend';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(env.RESEND_API_KEY);
  }
  return _resend;
}

interface DigestEmail {
  to: string;
  subject: string;
  html: string;
}

export async function sendDigestEmail({ to, subject, html }: DigestEmail): Promise<boolean> {
  try {
    const { error } = await getResend().emails.send({
      from: env.DIGEST_FROM_EMAIL,
      to,
      subject,
      html,
    });

    if (error) {
      logger.error({ to, error }, 'Resend API returned error');
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ to, err }, 'Failed to send digest email');
    return false;
  }
}

export async function sendBatch(emails: DigestEmail[]): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  // Resend supports batch API, but at launch scale sequential is fine
  // and gives us per-email error handling
  for (const email of emails) {
    const ok = await sendDigestEmail(email);
    if (ok) sent++;
    else failed++;
  }

  return { sent, failed };
}

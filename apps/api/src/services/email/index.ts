import { getEmailProvider } from './provider.js';
import type { SendEmailOpts, SendResult } from './provider.js';

// Only public path for sending. Never import provider implementations or
// `resend` / `@react-email/components` SDKs directly from a route handler,
// service, or job. Provider swaps touch one file: init.ts.
export async function sendEmail(opts: SendEmailOpts): Promise<SendResult> {
  return getEmailProvider().send(opts);
}

export type { SendEmailOpts, SendResult, EmailProvider, ProviderHealth } from './provider.js';
export { EmailSendError, registerEmailProvider, getEmailProvider, resetEmailProvider } from './provider.js';
export { initEmailProvider } from './init.js';

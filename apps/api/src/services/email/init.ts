import type { Env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { createConsoleProvider } from './providers/console.js';
import { createResendProvider } from './providers/resend.js';
import { createPostmarkProvider, registerEmailProvider } from './provider.js';

// Boot-time seam. Pick the provider per env and register the single instance
// that every call to `sendEmail` will route through for the life of the process.
export function initEmailProvider(env: Env): void {
  const provider = (() => {
    switch (env.EMAIL_PROVIDER) {
      case 'resend':
        return createResendProvider(env);
      case 'postmark':
        return createPostmarkProvider(env);
      case 'console':
      default:
        return createConsoleProvider(env);
    }
  })();

  registerEmailProvider(provider);
  logger.info({ provider: provider.name }, 'email provider registered');
}

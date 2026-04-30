import { randomUUID } from 'node:crypto';

import { render } from '@react-email/components';
import { Resend } from 'resend';

import type { Env } from '../../../config.js';
import { logger as defaultLogger } from '../../../lib/logger.js';
import { Sentry } from '../../../lib/sentry.js';
import type { EmailProvider, SendEmailOpts, SendResult } from '../provider.js';
import { EmailSendError } from '../provider.js';
import { redactRecipient } from './console.js';

type Logger = typeof defaultLogger;

interface ResendDeps {
  logger?: Logger;
  resend?: Resend;
  clock?: () => number;
  // Sentry seam, tests pass a stub so we can assert call shape without
  // wiring the Sentry transport through the full init path.
  sentry?: Pick<typeof Sentry, 'captureException'>;
}

// Production provider. Lazy-initialises the Resend client on first send so
// cold-start is fast and tests that never send never touch the SDK.
export function createResendProvider(env: Env, deps: ResendDeps = {}): EmailProvider {
  const log = deps.logger ?? defaultLogger;
  const clock = deps.clock ?? (() => Date.now());
  const sentry = deps.sentry ?? Sentry;

  let client: Resend | null = null;
  function getClient(): Resend {
    if (!client) {
      if (deps.resend) {
        client = deps.resend;
      } else {
        if (!env.RESEND_API_KEY) {
          // config.ts refine already guards this; defensive check keeps the
          // error message close to the code that would break.
          throw new Error('RESEND_API_KEY is required to construct Resend provider');
        }
        client = new Resend(env.RESEND_API_KEY);
      }
    }
    return client;
  }

  return {
    name: 'resend',

    async send(opts: SendEmailOpts): Promise<SendResult> {
      const started = clock();
      const correlationId = opts.correlationId ?? randomUUID();
      const template = opts.tags?.template ?? 'unknown';
      const redactedTo = redactRecipient(opts.to);
      const html = await render(opts.react);

      let response;
      try {
        response = await getClient().emails.send({
          from: formatFromAddress(env.EMAIL_FROM_NAME, env.EMAIL_FROM_ADDRESS),
          to: opts.to,
          subject: opts.subject,
          html,
          replyTo: opts.replyTo ?? env.EMAIL_REPLY_TO,
          tags: tagsToResendFormat(opts.tags),
        });
      } catch (err) {
        // Network / SDK-internal throw. Treat as transient by default.
        const durationMs = clock() - started;
        log.error(
          {
            err,
            correlationId,
            provider: 'resend',
            template,
            to: redactedTo,
            outcome: 'failed',
            durationMs,
          },
          'email send threw',
        );
        throw new EmailSendError('Resend send threw, network or SDK error', {
          retryable: true,
          cause: err,
        });
      }

      const durationMs = clock() - started;

      if (response.error) {
        const { statusCode, message, name } = response.error;
        const retryable = isRetryableStatus(statusCode);

        log.error(
          {
            correlationId,
            provider: 'resend',
            template,
            to: redactedTo,
            outcome: 'failed',
            errorCode: name,
            errorMessage: message,
            providerStatusCode: statusCode ?? undefined,
            retryable,
            durationMs,
          },
          'email send failed',
        );

        // Only capture non-retryable (4xx) to Sentry. 5xx storms would spam.
        if (!retryable) {
          sentry.captureException(new Error(`Resend send failed: ${message}`), {
            tags: {
              provider: 'email',
              template,
              retryable: 'false',
            },
          });
        }

        throw new EmailSendError(message ?? 'Resend returned an error', {
          retryable,
          providerStatusCode: statusCode ?? undefined,
          cause: response.error,
        });
      }

      // Resend's discriminated response says one of `data` or `error` is always set.
      // If we reach this branch with no error, a missing id means something is wrong
      // treat it as a retryable failure rather than reporting a fake success.
      const providerMessageId = response.data?.id;
      if (!providerMessageId) {
        log.error(
          {
            correlationId,
            provider: 'resend',
            template,
            to: redactedTo,
            outcome: 'failed',
            durationMs,
          },
          'email send returned neither id nor error',
        );
        throw new EmailSendError('Resend returned success with no message id', {
          retryable: true,
        });
      }

      log.info(
        {
          correlationId,
          provider: 'resend',
          template,
          to: redactedTo,
          subject: opts.subject,
          providerMessageId,
          outcome: 'sent',
          durationMs,
        },
        'email sent',
      );

      return { status: 'sent', providerMessageId, durationMs };
    },

    async checkHealth() {
      // Intentionally static. resend.domains.list() would cost a real API
      // call every 30s per instance and couple liveness to an external SLA.
      // Actual Resend availability surfaces through send-failure logs + Sentry.
      return { status: 'ok', latencyMs: 0 };
    },
  };
}

function isRetryableStatus(statusCode: number | null): boolean {
  if (statusCode === null) return true; // unknown = assume transient
  if (statusCode === 429) return true;
  return statusCode >= 500;
}

// RFC 5322 display-name rules: any of "(),.:;<>@[]\\ or a double-quote in the name
// forces it to be wrapped in "..." with embedded " and \ escaped. Typical product
// names (e.g. "Kiln Insights") don't trip this, but a name like Smith, Jones
// would silently break the header without quoting.
function formatFromAddress(name: string, address: string): string {
  const needsQuoting = /[(),.:;<>@[\]\\"]/.test(name);
  if (!needsQuoting) return `${name} <${address}>`;
  const escaped = name.replace(/(["\\])/g, '\\$1');
  return `"${escaped}" <${address}>`;
}

function tagsToResendFormat(
  tags: Record<string, string> | undefined,
): { name: string; value: string }[] | undefined {
  if (!tags) return undefined;
  return Object.entries(tags).map(([name, value]) => ({ name, value }));
}

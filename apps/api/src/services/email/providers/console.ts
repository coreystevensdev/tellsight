import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import { render } from '@react-email/components';

import type { Env } from '../../../config.js';
import { logger as defaultLogger } from '../../../lib/logger.js';
import type { EmailProvider, SendEmailOpts, SendResult } from '../provider.js';

type Logger = typeof defaultLogger;
type FsAdapter = Pick<typeof fsPromises, 'writeFile' | 'mkdir'>;

interface ConsoleDeps {
  logger?: Logger;
  clock?: () => number;
  fs?: FsAdapter;
}

// Default dev / test / CI provider. Renders the template (so template bugs
// still surface), logs one structured line per send, optionally writes the
// rendered HTML to disk for browser preview during template iteration.
export function createConsoleProvider(env: Env, deps: ConsoleDeps = {}): EmailProvider {
  const log = deps.logger ?? defaultLogger;
  const clock = deps.clock ?? (() => Date.now());
  const fs = deps.fs ?? fsPromises;

  return {
    name: 'console',

    async send(opts: SendEmailOpts): Promise<SendResult> {
      const started = clock();
      const correlationId = opts.correlationId ?? randomUUID();
      const template = opts.tags?.template ?? 'unknown';
      const html = await render(opts.react);
      const durationMs = clock() - started;
      const providerMessageId = `console-${randomUUID()}`;

      log.info(
        {
          provider: 'console',
          template,
          to: redactRecipient(opts.to),
          subject: opts.subject,
          renderedHtmlPreview: html.slice(0, 200),
          correlationId,
          providerMessageId,
          outcome: 'captured',
          durationMs,
        },
        'email send captured',
      );

      if (env.EMAIL_CAPTURE_DIR) {
        await captureHtml(env.EMAIL_CAPTURE_DIR, template, html, fs, log);
      }

      return { status: 'captured', providerMessageId, durationMs };
    },

    async checkHealth() {
      // Console provider is always healthy, no network, no SDK, no upstream.
      return { status: 'ok', latencyMs: 0 };
    },
  };
}

// Local PII redactor. Grepped the codebase on 2026-04-23, no existing recipient
// redactor found. If a shared helper lands later, prefer that and delete this.
export function redactRecipient(to: string | string[]): string | string[] {
  if (Array.isArray(to)) return to.map(redactOne);
  return redactOne(to);
}

function redactOne(email: string): string {
  // Keep first 2 chars of local part + domain; mask the rest.
  const at = email.indexOf('@');
  if (at < 0) return email; // malformed, don't try to be clever
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const keep = local.slice(0, 2);
  return `${keep}***${domain}`;
}

async function captureHtml(
  dir: string,
  template: string,
  html: string,
  fs: FsAdapter,
  log: Logger,
) {
  try {
    await fs.mkdir(dir, { recursive: true });
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${template}.html`;
    const fullPath = path.join(dir, filename);
    await fs.writeFile(fullPath, html, 'utf8');
    log.debug({ template, path: fullPath }, 'email capture written');
  } catch (err) {
    // capture is a dev ergonomic, a broken FS path must never fail the send
    log.warn({ err, dir, template }, 'email capture failed, continuing');
  }
}

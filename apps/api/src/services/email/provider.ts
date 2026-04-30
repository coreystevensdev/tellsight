import type { ReactElement } from 'react';

import type { Env } from '../../config.js';

// One active provider at a time, selected via config at boot.
// Each provider owns its own SDK, retry classification, and PII redaction.
// Callers work with this interface, never with Resend (or any vendor) SDK directly.
export interface EmailProvider {
  name: string;
  send(opts: SendEmailOpts): Promise<SendResult>;
  checkHealth(): Promise<ProviderHealth>;
}

export interface SendEmailOpts {
  to: string | string[];
  subject: string;
  react: ReactElement;
  tags?: Record<string, string>;
  replyTo?: string;
  correlationId?: string;
}

export interface SendResult {
  status: 'sent' | 'captured';
  providerMessageId: string;
  durationMs: number;
}

export interface ProviderHealth {
  status: 'ok' | 'degraded' | 'error';
  latencyMs: number;
  detail?: string;
}

// Thrown when a provider's upstream send fails. retryable=true means 5xx,
// network, or rate-limit, safe for BullMQ to requeue. retryable=false means
// 4xx (bad recipient, quota exceeded, unverified domain), retrying won't help.
export class EmailSendError extends Error {
  readonly retryable: boolean;
  readonly providerStatusCode?: number;

  constructor(
    message: string,
    opts: { retryable: boolean; providerStatusCode?: number; cause?: unknown },
  ) {
    super(message);
    this.name = 'EmailSendError';
    this.retryable = opts.retryable;
    this.providerStatusCode = opts.providerStatusCode;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

let activeProvider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (!activeProvider) {
    throw new Error('Email provider not registered, call registerEmailProvider() at boot');
  }
  return activeProvider;
}

export function registerEmailProvider(provider: EmailProvider): void {
  activeProvider = provider;
}

// Test-only, lets a test reset module state between runs.
export function resetEmailProvider(): void {
  activeProvider = null;
}

// Factory stub. Proves the provider-switch pattern compiles without pulling
// the `postmark` SDK into the tree. Swap the body in a future story.
export function createPostmarkProvider(_env: Env): EmailProvider {
  return {
    name: 'postmark',
    send: async () => {
      throw new Error('Postmark provider not implemented, future story');
    },
    checkHealth: async () => ({ status: 'ok', latencyMs: 0 }),
  };
}

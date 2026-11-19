export class XeroApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'XeroApiError';
  }
}

export class XeroRetryableError extends XeroApiError {
  readonly retryable = true;

  constructor(
    message: string,
    statusCode: number,
    body?: string,
    // Seconds, from Xero's Retry-After. The worker's backoff does not read it
    // yet; it is carried so a 429 is diagnosable from the job record, since
    // Xero's minute and daily limits need very different responses.
    public readonly retryAfterSeconds?: number,
  ) {
    super(message, statusCode, body);
    this.name = 'XeroRetryableError';
  }
}

export class XeroTokenRevokedError extends XeroApiError {
  constructor(message = 'Xero access was revoked, please reconnect') {
    super(message, 401);
    this.name = 'XeroTokenRevokedError';
  }
}

// Terminal for the same reason QuickBooks' is: retrying cannot resurrect a
// deleted connection row, so the worker must not burn its attempts on a 404.
export class XeroConnectionNotFoundError extends XeroApiError {
  constructor(connectionId: number) {
    super(`Connection ${connectionId} not found`, 404);
    this.name = 'XeroConnectionNotFoundError';
  }
}

// The org authorized the app but no ORGANISATION tenant came back, so there is
// no ledger to sync. Terminal: only re-consenting against a real organisation
// fixes it, which the owner has to do.
export class XeroNoTenantError extends XeroApiError {
  constructor(message = 'No Xero organisation was authorized for this connection') {
    super(message, 400);
    this.name = 'XeroNoTenantError';
  }
}

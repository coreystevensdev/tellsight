export class QbApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'QbApiError';
  }
}

export class RetryableError extends QbApiError {
  readonly retryable = true;

  constructor(message: string, statusCode: number, body?: string) {
    super(message, statusCode, body);
    this.name = 'RetryableError';
  }
}

export class TokenRevokedError extends QbApiError {
  constructor(message = 'QuickBooks access was revoked, please reconnect') {
    super(message, 401);
    this.name = 'TokenRevokedError';
  }
}

// Terminal: the connection row is gone (deleted or never existed). Retrying the
// sync job cannot resurrect it, so the worker must treat this as unrecoverable
// rather than burning MAX_ATTEMPTS on a 404.
export class ConnectionNotFoundError extends QbApiError {
  constructor(connectionId: number) {
    super(`Connection ${connectionId} not found`, 404);
    this.name = 'ConnectionNotFoundError';
  }
}

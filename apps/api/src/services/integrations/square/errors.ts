export class SquareApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'SquareApiError';
  }
}

// 429 plus 5xx. Square's limit is a per-application request rate, so a
// multi-location seller fanning out across locations is the likeliest way to
// meet it, and backing off is the right response rather than failing the sync.
export class RetryableError extends SquareApiError {
  readonly retryable = true;

  constructor(message: string, statusCode: number, body?: string) {
    super(message, statusCode, body);
    this.name = 'RetryableError';
  }
}

// Square refresh tokens do not expire, so tokens are refreshed before they
// lapse rather than in response to a 401. A 401 that survives that means the
// seller revoked access, which no retry recovers from.
export class TokenRevokedError extends SquareApiError {
  constructor(message = 'Square access was revoked, please reconnect') {
    super(message, 401);
    this.name = 'TokenRevokedError';
  }
}

export class ConnectionNotFoundError extends SquareApiError {
  constructor(connectionId: number) {
    super(`Connection ${connectionId} not found`, 404);
    this.name = 'ConnectionNotFoundError';
  }
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

// THROTTLED and MAX_COST_EXCEEDED both come back as HTTP 200 with a GraphQL
// errors[] array, not an HTTP-level 429, the Admin GraphQL API's rate limit
// is a cost-based leaky bucket, not a simple request counter.
export class RetryableError extends ShopifyApiError {
  readonly retryable = true;

  constructor(message: string, statusCode: number, body?: string) {
    super(message, statusCode, body);
    this.name = 'RetryableError';
  }
}

// A scope the app never asked for is not a dead credential, and saying
// "reconnect" for one sends the reader through a flow that cannot fix it.
// Shopify answers ACCESS_DENIED with HTTP 200 and names the scope it wants, so
// that name is worth keeping rather than flattening into a 401.
export class ScopeDeniedError extends ShopifyApiError {
  constructor(detail: string) {
    super(`Shopify refused a field this app has no scope for: ${detail}`, 403);
    this.name = 'ScopeDeniedError';
  }
}

export class TokenRevokedError extends ShopifyApiError {
  constructor(message = 'Shopify access was revoked, please reconnect') {
    super(message, 401);
    this.name = 'TokenRevokedError';
  }
}

// Terminal: the connection row is gone (deleted or never existed). Retrying the
// sync job cannot resurrect it, so the worker must treat this as unrecoverable
// rather than burning MAX_ATTEMPTS on a 404.
export class ConnectionNotFoundError extends ShopifyApiError {
  constructor(connectionId: number) {
    super(`Connection ${connectionId} not found`, 404);
    this.name = 'ConnectionNotFoundError';
  }
}

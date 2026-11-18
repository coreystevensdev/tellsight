export class PlaidApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode?: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'PlaidApiError';
  }
}

export class PlaidRetryableError extends PlaidApiError {
  readonly retryable = true;

  constructor(message: string, statusCode: number, errorCode?: string, body?: string) {
    super(message, statusCode, errorCode, body);
    this.name = 'PlaidRetryableError';
  }
}

// The owner has to re-run Link; no refresh exists to try first. Plaid reports
// this as ITEM_LOGIN_REQUIRED, which is a 400 rather than the 401 the other
// connectors key revocation off.
export class PlaidItemLoginRequiredError extends PlaidApiError {
  constructor(message = 'This bank connection needs to be re-authorized') {
    super(message, 400, 'ITEM_LOGIN_REQUIRED');
    this.name = 'PlaidItemLoginRequiredError';
  }
}

export class PlaidConnectionNotFoundError extends PlaidApiError {
  constructor(connectionId: number) {
    super(`Connection ${connectionId} not found`, 404);
    this.name = 'PlaidConnectionNotFoundError';
  }
}

// Plaid invalidates a cursor when an Item is reset, and the documented recovery
// is to start over from no cursor rather than to retry the same one. Separate
// from PlaidRetryableError because the fix is to discard state, not to wait.
export class PlaidCursorInvalidError extends PlaidApiError {
  constructor(message = 'Stored sync cursor is no longer valid, resyncing from the start') {
    super(message, 400, 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    this.name = 'PlaidCursorInvalidError';
  }
}
